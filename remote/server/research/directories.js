'use strict';
const path=require('path');
const crypto=require('crypto');
const {normalize}=require('./normalize');
const {createGoogleAiKey,runGoogleAi}=require('../ai/google-ai-api');
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/$/,'');
const canonical=p=>/^[A-Za-z]:/.test(p)?norm(p).toLowerCase():norm(p);
const isSubOrParent=(a,b)=>{const ca=canonical(a),cb=canonical(b);return !!ca&&!!cb&&(ca===cb||ca.startsWith(cb+'/')||cb.startsWith(ca+'/'));};
const key=(project,machine,path)=>crypto.createHash('sha256').update([project,machine,canonical(path)].join('\0')).digest('hex');

const DEFAULT_MODEL='antigravity/gemini-4-hydrogen';
const FALLBACK_MAGPIE_MODELS=['antigravity/gemini-4-hydrogen','group/gemini-argon','deepseek/deepseek-v4-pro','auto/claude-sonnet-5-5'];

const SUMMARY_SCHEMA={
  type:'object',
  properties:{
    overview:{type:'string'},
    work:{
      type:'array',
      items:{
        type:'object',
        properties:{
          title:{type:'string'},
          description:{type:'string'},
          results:{type:'array',items:{type:'string'}},
          outputs:{type:'array',items:{type:'string'}},
          questions:{type:'array',items:{type:'string'}},
          evidence_refs:{type:'array',items:{type:'string'}},
        },
        required:['title','description','results','outputs','questions','evidence_refs'],
      },
    },
    next_steps:{type:'array',items:{type:'string'}},
  },
  required:['overview','work','next_steps'],
};

const DISCOVER_SCHEMA={
  type:'object',
  properties:{
    classified_dirs:{
      type:'array',
      items:{
        type:'object',
        properties:{
          machine:{type:'string'},
          path:{type:'string'},
          project_id:{type:'string'},
          branch:{type:'string'},
        },
        required:['machine','path','project_id','branch'],
      },
    },
  },
  required:['classified_dirs'],
};

const OVERVIEW_SCHEMA={
  type:'object',
  properties:{
    ecosystem:{
      type:'object',
      properties:{
        role:{type:'string'},
        edges:{
          type:'array',
          items:{
            type:'object',
            properties:{
              from:{type:'string'},
              to:{type:'string'},
              relation:{type:'string'},
            },
            required:['from','to','relation'],
          },
        },
      },
      required:['role','edges'],
    },
    research_tracks:{
      type:'array',
      items:{
        type:'object',
        properties:{
          title:{type:'string'},
          status:{type:'string'},
          summary:{type:'string'},
          stages:{
            type:'array',
            items:{
              type:'object',
              properties:{
                machine:{type:'string'},
                path:{type:'string'},
                branch:{type:'string'},
                milestone:{type:'string'},
              },
              required:['machine','path','branch','milestone'],
            },
          },
          key_metrics:{type:'array',items:{type:'string'}},
          next_action:{type:'string'},
        },
        required:['title','status','summary','stages','key_metrics','next_action'],
      },
    },
    memory_candidates:{
      type:'array',
      items:{
        type:'object',
        properties:{
          name:{type:'string'},
          category:{type:'string'},
          body:{type:'string'},
          source_dirs:{type:'array',items:{type:'string'}},
        },
        required:['name','category','body','source_dirs'],
      },
    },
  },
  required:['ecosystem','research_tracks','memory_candidates'],
};

function createDirectories({vault,review,store=null,getMagpie=()=>null,egress=null,listProjects=()=>[],saveProject=null}){
  const db=vault.db;
  const dataDir=path.dirname(vault.file);
  db.exec(`CREATE TABLE IF NOT EXISTS research_directory_summaries(id TEXT PRIMARY KEY,project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,
    body TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,inputs TEXT NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS research_directory_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,item TEXT NOT NULL,before_json TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS research_project_overviews(project TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL);`);
  const parse=r=>r?{...r,body:JSON.parse(r.body),inputs:JSON.parse(r.inputs)}:null;

  // Unified AI caller supporting Google AI Studio API (if key configured) and Magpie with automatic fallback on 403/429
  async function callModel({model=DEFAULT_MODEL,prompt,schema,timeoutMs=180000}){
    const gKey=createGoogleAiKey({dataDir});
    if(String(model||'').startsWith('google:')){
      if(!gKey.has())throw Error('尚未配置 Google AI Studio API key（请打开控制面板 → AI 模型 → Google AI Studio API）');
      return runGoogleAi({key:gKey.get(),model:String(model).slice(7)||'gemini-2.5-pro',prompt,schema,egress,timeoutMs});
    }
    const mp=typeof getMagpie==='function'?getMagpie():null;
    const candidates=[];
    if(model)candidates.push(model);
    for(const fm of FALLBACK_MAGPIE_MODELS)if(!candidates.includes(fm))candidates.push(fm);

    let lastErr=null;
    if(mp){
      try{if(!mp.models().length)await mp.poll();}catch{}
      for(const cand of candidates){
        try{
          return await mp.run({model:cand,prompt,schema,timeoutMs});
        }catch(e){
          lastErr=e;
          // Only fallback on 403 / 429 / model unavailable
          if(!/HTTP (?:403|429|502|503)|没有提供所选模型|暂不可读/.test(e.message))throw e;
        }
      }
    }
    // If Magpie failed or is unavailable and user configured Google AI Studio API key, use it as fallback!
    if(gKey.has()){
      const gModels=gKey.models();
      const gm=(gModels[0]&&gModels[0].model)||'gemini-2.5-pro';
      return runGoogleAi({key:gKey.get(),model:gm,prompt,schema,egress,timeoutMs});
    }
    throw lastErr||Error('Magpie 与 Google AI Studio 均未就绪');
  }

  function list(project){
    const catalog=review.catalog().find(p=>p.id===project);if(!catalog)throw Error('找不到项目');
    const docs=db.prepare('SELECT d.* FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=?').all(project);
    const sources=db.prepare(`SELECT s.* FROM sources s WHERE kind='native' AND rowid=(SELECT rowid FROM sources t
      WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)`).all();
    return catalog.directories.map(d=>{
      const id=key(project,d.machine,d.path),saved=parse(db.prepare('SELECT * FROM research_directory_summaries WHERE id=?').get(id));
      const own=x=>x.machine===d.machine&&canonical(x.cwd)===canonical(d.path);
      const archived=sources.filter(own),documents=docs.filter(own);
      const inputs=documents.map(x=>x.id).sort();
      return {id,project,machine:d.machine,path:d.path,source:d.source||'',branch:d.branch||'',...(saved||{}),status:saved?.status||'pending',revision:saved?.revision||0,
        body:saved?.body||null,documents:documents.length,sessions:new Set(archived.map(x=>x.session)).size,
        updated:saved?.updated||null,changed:!!saved&&JSON.stringify(saved.inputs)!==JSON.stringify(inputs),
        evidenceDocuments:saved?.inputs.length||0};
    });
  }

  function change(input){return vault.transaction(()=>{
    const current=list(input.project).find(d=>d.id===input.id);if(!current)throw Error('找不到项目目录');
    if(input.revision!==current.revision)throw Error('目录总结已有更新，请刷新后保存');
    const before=db.prepare('SELECT * FROM research_directory_summaries WHERE id=?').get(current.id);
    let body=current.body,status=current.status;
    if(input.action==='save'){
      body=input.body;
      if(!body||typeof body.overview!=='string'||!body.overview.trim()||body.overview.length>15000||!Array.isArray(body.work)||body.work.length>30||!Array.isArray(body.next_steps))throw Error('目录总结格式无效');
      for(const w of body.work){
        if(typeof w.title!=='string'||!w.title.trim()||typeof w.description!=='string'||!['results','outputs','questions','evidence'].every(k=>Array.isArray(w[k])))throw Error('工作主线格式无效');
        for(const ref of w.evidence){
          const e=db.prepare(`SELECT e.text,d.machine,d.cwd FROM research_events e JOIN research_documents d ON d.id=e.document
            JOIN research_project_sources p ON p.document=d.id WHERE p.project=? AND e.id=?`).get(input.project,ref.event_id);
          if(!e||e.machine!==current.machine||!isSubOrParent(e.cwd,current.path)||typeof ref.quote!=='string'||!ref.quote.trim()||!e.text.includes(ref.quote))throw Error('目录总结引用与来源不匹配');
        }
      }
      if(JSON.stringify(body).length>256*1024)throw Error('目录总结过长');
      status=input.confirm?'confirmed':'pending';
    }else if(input.action==='confirm'){if(!body)throw Error('请先生成目录总结');status='confirmed';}
    else if(input.action==='restore')status='pending';
    else throw Error('目录操作无效');
    const inputs=db.prepare(`SELECT d.id,d.machine,d.cwd FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=?`).all(input.project)
      .filter(d=>d.machine===current.machine&&canonical(d.cwd)===canonical(current.path)).map(d=>d.id).sort();
    db.prepare('INSERT INTO research_directory_history(item,before_json,created) VALUES(?,?,?)').run(current.id,JSON.stringify(before||null),Date.now());
    db.prepare(`INSERT INTO research_directory_summaries VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,
      revision=excluded.revision,inputs=excluded.inputs,updated=excluded.updated`).run(current.id,current.project,current.machine,current.path,
      JSON.stringify(body),status,current.revision+1,JSON.stringify(input.action==='save'?inputs:(before?JSON.parse(before.inputs):inputs)),Date.now());
    return list(input.project).find(d=>d.id===current.id);
  });}

  function ensureImportedForDir(project,machine,dirPath){
    if(!store)return {docs:[],fromParent:false};
    const allNative=db.prepare(`SELECT s.* FROM sources s WHERE complete=1 AND kind='native' AND machine=? AND cwd<>''
      AND rowid=(SELECT rowid FROM sources t WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)
      ORDER BY updated DESC`).all(machine);
    let matched=allNative.filter(s=>canonical(s.cwd)===canonical(dirPath));
    let fromParent=false;
    if(!matched.length){
      matched=allNative.filter(s=>isSubOrParent(dirPath,s.cwd));
      fromParent=true;
    }
    const importedDocs=[];
    for(const s of matched){
      if(s.size>64*1024*1024)continue;
      if(s.provider!=='opencode'&&!/\.jsonl$/i.test(s.path))continue;
      try{
        const doc=store.importSource(project,{machine:s.machine,key:s.key,generation:s.generation});
        if(doc)importedDocs.push(doc);
      }catch{}
    }
    return {docs:importedDocs,fromParent};
  }

  function buildEvidenceUnits(project,machine,dirPath,branch='',maxUnits=110){
    const {docs,fromParent}=ensureImportedForDir(project,machine,dirPath);
    if(!docs.length)return [];
    const baseName=norm(dirPath).split('/').pop()||'';
    const kwRe=fromParent&&baseName?new RegExp(baseName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+(branch?'|'+branch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):''),'i'):null;
    const allUnits=[];
    for(const doc of docs){
      const rows=db.prepare('SELECT id,role,kind,text FROM research_events WHERE document=? AND suppressed=0 ORDER BY line,part').all(doc.id);
      const filtered=[];
      for(const e of rows){
        if(e.role!=='user'&&e.role!=='assistant'&&!(e.kind==='tool_result'&&/error|fail|pass|dB|RCS|npz|耗时|秒|通过|完成|commit/i.test(e.text)))continue;
        const clean=String(e.text||'').trim();
        if(clean.length<15||/^(Caveat:|The command below|The following is the Codex|Base directory for this skill)/.test(clean))continue;
        filtered.push({id:e.id,role:e.role,kind:e.kind,text:clean,match:kwRe?kwRe.test(clean):false});
      }
      let picked=filtered;
      if(kwRe&&filtered.some(x=>x.match)){
        const matchedEvts=filtered.filter(x=>x.match);
        const contextEvts=filtered.filter(x=>!x.match).slice(0,15);
        picked=[...matchedEvts,...contextEvts];
      }
      const cap=Math.max(14,Math.floor(maxUnits/Math.max(1,docs.length)));
      if(picked.length>cap){
        picked=[
          ...picked.slice(0,Math.floor(cap*0.35)),
          ...picked.slice(Math.floor(picked.length/2)-3,Math.floor(picked.length/2)+3),
          ...picked.slice(-Math.ceil(cap*0.55)),
        ];
      }
      for(const e of picked){
        const quote=e.text.slice(0,260).trim();
        if(!quote)continue;
        allUnits.push({
          ref:'U'+(allUnits.length+1),
          session:doc.session.slice(0,8),
          role:e.role,
          kind:e.kind,
          event_id:e.id,
          quote,
        });
        if(allUnits.length>=maxUnits)break;
      }
      if(allUnits.length>=maxUnits)break;
    }
    return allUnits;
  }

  async function summarize({project,id,model=DEFAULT_MODEL,confirm=false}){
    const current=list(project).find(d=>d.id===id);
    if(!current)throw Error('找不到该项目目录');
    const units=buildEvidenceUnits(project,current.machine,current.path,current.branch,110);
    if(!units.length)throw Error(`目录 ${current.machine}:${current.path} 尚无可用于总结的会话记录`);
    const prompt=[
      `请根据以下采集自设备「${current.machine}」目录「${current.path}」${current.branch?`（Git 分支：${current.branch}）`:''}的真实 AI 会话证据片段，生成该目录的科研与工程工作总结。`,
      '要求：',
      '1. overview：用 2～3 句话紧凑概括该目录在项目中的定位、所在分支/工作树角色、承担的核心任务及当前进展。',
      '2. work：按研究或工程目标归并为 1～4 条工作主线。每条主线包含 title、description、results（具体量化结果、提交号或验证结论；对于负面或受限实验结果，客观说明在何种算例/参数下存在什么限制，不要使用“证伪”等绝对化表述）、outputs（涉及的代码文件、脚本、数据或文档路径）、questions（未决问题或待办）、evidence_refs（只能从输入证据中选择真实存在的编号如 ["U1", "U5"]，至少 1 个）。',
      '3. next_steps：后续推进建议（1～3 条）。',
      '4. 严禁编造输入证据中没有的数值或路径；只输出符合 Schema 的 JSON。',
      '',
      '输入证据片段：',
      JSON.stringify(units.map(({event_id,...u})=>u)),
    ].join('\n');
    const res=await callModel({model:model||DEFAULT_MODEL,prompt,schema:SUMMARY_SCHEMA,timeoutMs:180000});
    const unitMap=new Map(units.map(u=>[u.ref,u]));
    const work=(res.work||[]).map(w=>{
      const ev=(w.evidence_refs||[]).map(r=>unitMap.get(r)).filter(Boolean).map(u=>({event_id:u.event_id,quote:u.quote}));
      return {
        title:String(w.title||'工作主线').trim(),
        description:String(w.description||'').trim(),
        results:Array.isArray(w.results)?w.results.map(x=>String(x).trim()).filter(Boolean):[],
        outputs:Array.isArray(w.outputs)?w.outputs.map(x=>String(x).trim()).filter(Boolean):[],
        questions:Array.isArray(w.questions)?w.questions.map(x=>String(x).trim()).filter(Boolean):[],
        evidence:ev.length?ev:[{event_id:units[0].event_id,quote:units[0].quote}],
      };
    }).filter(w=>w.title);
    const fresh=list(project).find(d=>d.id===id);
    return change({
      project,
      id,
      revision:fresh.revision,
      action:'save',
      confirm:!!confirm,
      body:{
        overview:String(res.overview||'').trim(),
        work,
        next_steps:Array.isArray(res.next_steps)?res.next_steps.map(x=>String(x).trim()).filter(Boolean):[],
      },
    });
  }

  async function summarizeAll({project,model=DEFAULT_MODEL,force=false}){
    const items=list(project);
    const targets=items.filter(d=>force||!d.body||d.changed);
    const completed=[],skipped=[];
    for(const d of targets){
      try{
        const item=await summarize({project,id:d.id,model,confirm:false});
        completed.push({id:d.id,machine:d.machine,path:d.path,title:item.body?.overview?.slice(0,80)||''});
      }catch(e){
        skipped.push({id:d.id,machine:d.machine,path:d.path,reason:e.message});
      }
    }
    return {completed,skipped,items:list(project)};
  }

  async function discover({model=DEFAULT_MODEL}={}){
    review.seed();
    const projects=listProjects();
    if(!projects.length)return {added:[],projects:review.catalog()};

    const knownSet=new Set();
    for(const p of review.catalog()){
      for(const d of p.directories||[])knownSet.add(`${d.machine}|${canonical(d.path)}`);
    }
    const latestSources=db.prepare(`SELECT s.* FROM sources s WHERE complete=1 AND kind='native' AND cwd<>''
      AND rowid=(SELECT rowid FROM sources t WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)
      ORDER BY updated DESC`).all();
    const byDir=new Map();
    for(const s of latestSources){
      const k=`${s.machine}|${canonical(s.cwd)}`;
      if(knownSet.has(k))continue;
      if(/^(?:\/tmp(?:\/|$)|\/var\/tmp|[a-z]:\/windows\/system32|[a-z]:\/users\/[^/]+(?:\/desktop|\/downloads|\/appdata\/local\/temp|\/\.claude\/projects)(?:\/|$)|.*\/\.claude\/worktrees\/|.*\/ame-(?:launch|mode|key|perm)test)/i.test(norm(s.cwd)))continue;
      if(/^[a-z]:\/?$/i.test(norm(s.cwd))||/^\/home\/[^/]+$/i.test(norm(s.cwd))||/^[a-z]:\/users\/[^/]+$/i.test(norm(s.cwd)))continue;
      if(!byDir.has(k))byDir.set(k,{machine:s.machine,cwd:norm(s.cwd),sessions:[]});
      byDir.get(k).sessions.push(s);
    }
    const candidates=[];
    for(const d of byDir.values()){
      const snippets=[];
      for(const s of d.sessions.slice(0,2)){
        const chs=db.prepare('SELECT data FROM chunks WHERE machine=? AND key=? AND generation=? ORDER BY start LIMIT 4').all(s.machine,s.key,s.generation);
        const buf=Buffer.concat(chs.map(c=>Buffer.isBuffer(c.data)?c.data:Buffer.from(c.data)));
        try{
          for(const ev of normalize(s,[buf])){
            if(ev.suppressed||(ev.role!=='user'&&ev.role!=='assistant'))continue;
            const t=ev.text.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
            if(t.length>10&&!/^(Caveat:|The command below|The following is the Codex)/.test(t)){
              snippets.push(`${ev.role}: ${t.slice(0,180)}`);
              if(snippets.length>=5)break;
            }
          }
        }catch{}
      }
      if(snippets.length)candidates.push({machine:d.machine,path:d.cwd,sessions:d.sessions.length,samples:snippets});
    }
    const added=[];
    if(candidates.length){
      const prompt=[
        '你是跨设备科研与工程项目目录归集引擎。',
        '现有项目列表（请使用项目的 id 字段作为 project_id）：',
        JSON.stringify(projects.map(p=>({id:p.id,name:p.name}))),
        '',
        '以下是尚未归入项目的候选目录及其真实 AI 会话摘要样本：',
        JSON.stringify(candidates),
        '',
        '请判断每个候选目录属于哪个现有项目（填该项目的 id；若属于与上述项目均无关的杂项/测试/其他独立小工具，则 project_id 填 "ignore"）。如果摘要中能识别出 Git 分支或明确子模块角色，填入 branch，否则留空字符串。',
      ].join('\n');
      const res=await callModel({model:model||DEFAULT_MODEL,prompt,schema:DISCOVER_SCHEMA,timeoutMs:180000});
      for(const item of res.classified_dirs||[]){
        if(!item||item.project_id==='ignore')continue;
        const proj=projects.find(p=>p.id===item.project_id||p.name===item.project_id);
        if(!proj)continue;
        review.directory(proj.id,item.machine,item.path,'AI 发现目录',item.branch||'');
        added.push({project:proj.id,projectName:proj.name,machine:item.machine,path:item.path,branch:item.branch||''});
      }
      review.seed();
    }
    return {added,projects:review.catalog()};
  }

  function getOverview(project){
    const row=db.prepare('SELECT * FROM research_project_overviews WHERE project=?').get(project);
    if(!row)return null;
    try{return {project:row.project,body:JSON.parse(row.body),updated:row.updated};}catch{return null;}
  }

  function saveOverview(project,body){
    const now=Date.now();
    db.prepare('INSERT INTO research_project_overviews(project,body,updated) VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET body=excluded.body,updated=excluded.updated')
      .run(project,JSON.stringify(body),now);
    return {project,body,updated:now};
  }

  async function generateOverview({project,model=DEFAULT_MODEL}){
    const cat=review.catalog();
    const curProj=cat.find(p=>p.id===project);
    if(!curProj)throw Error('找不到该项目');
    const dirList=list(project);
    const dirWithBody=dirList.filter(d=>d.body);
    if(!dirWithBody.length)throw Error('该项目下尚无已生成的目录总结，请先生成目录总结');

    let memories=[];
    try{
      const kp=db.prepare('SELECT id FROM projects WHERE mesh=?').get(project);
      const owner=kp?kp.id:curProj.name.toLowerCase();
      memories=db.prepare("SELECT scope,owner,name,body FROM memory WHERE enabled=1 AND (scope='global' OR (scope='project' AND owner=?))").all(owner);
    }catch{}

    const prompt=[
      `你是科研与工程项目的宏观总览、规划与回顾引擎。请基于项目「${curProj.name}」下已核实的 ${dirWithBody.length} 个跨设备目录工作总结与现有记忆，生成该项目的宏观总览报告。`,
      '重要科学严谨性原则（必须严格遵守）：',
      '- 严禁对单一算例、特定频率、特定网格或局部参数下的负面实验结果使用“已证伪”、“彻底否定”、“不可行”等绝对化表述！',
      '- 对于受限或负面实验观察，必须严谨表述为“在某算例/参数下存在 xxx 限制”或“已明确某方案在 xxx 条件下的适用边界”（例如 status 用“已明确适用边界与限制”，不要写“已证伪”）。只有存在严格数学反例或全工况普适证明时才可称证伪。',
      '',
      '请输出以下三部分 JSON：',
      '1. ecosystem（本项目在跨项目生态中的角色与上下游关系）：',
      '   - role：1～2 句话概括本项目在全局科研/工程链条中的角色定位与核心资产；',
      '   - edges：本项目与其他项目（或本项目内部核心主干与分支）之间的上下游供给/消费关系 [{ from, to, relation }]。',
      '2. research_tracks（项目内的跨目录课题主线，3～5 条）：将散落在不同电脑、不同目录/分支上的工作按研究目标归并为宏观课题主线。每条包含：',
      '   - title：课题主线名称；',
      '   - status：只能从 ["已合入主线并验证", "机理与算例验证完成", "持续攻关中", "已明确适用边界与限制"] 中选择最准确的一项；',
      '   - summary：2～3 句话概括该主线的演进脉络；',
      '   - stages：跨机器/目录的演进节点 [{ machine, path, branch, milestone }]；',
      '   - key_metrics：最关键的 2～3 条量化精度/速度指标；',
      '   - next_action：下一步规划。',
      '3. memory_candidates（可一键沉淀为项目长期记忆的经验/适用边界/工程基线，3～4 条）：提炼出后续新开 AI 会话应知晓的关键结论（category 填“适用边界与特定限制”、“网格与算法选型”或“统一工程基线”）。',
      '',
      '输入 1：全部项目列表：',
      JSON.stringify(cat.map(p=>({id:p.id,name:p.name,dirCount:(p.directories||[]).length}))),
      '',
      `输入 2：项目「${curProj.name}」的目录总结：`,
      JSON.stringify(dirWithBody.map(d=>({machine:d.machine,path:d.path,branch:d.branch,overview:d.body.overview,work:(d.body.work||[]).map(w=>({title:w.title,results:w.results,outputs:w.outputs,questions:w.questions}))}))),
      '',
      '输入 3：现有相关记忆：',
      JSON.stringify(memories.map(m=>({scope:m.scope,name:m.name,body:String(m.body||'').slice(0,280)}))),
    ].join('\n');

    const res=await callModel({model:model||DEFAULT_MODEL,prompt,schema:OVERVIEW_SCHEMA,timeoutMs:180000});
    return saveOverview(project,res);
  }

  function promoteMemory({project,name,category='',body}){
    const cleanName=String(name||'').trim().slice(0,180);
    const cleanBody=String(body||'').trim();
    if(!cleanName||!cleanBody)throw Error('记忆名称与正文不能为空');
    const curProj=review.catalog().find(p=>p.id===project);
    if(!curProj)throw Error('找不到该项目');

    let ownerId='';
    try{
      const kp=db.prepare('SELECT id FROM projects WHERE mesh=?').get(project);
      if(kp&&kp.id)ownerId=kp.id;
    }catch{}
    if(!ownerId){
      ownerId=String(curProj.name||'project').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'project';
      try{
        db.prepare('INSERT OR IGNORE INTO projects(id,name,mesh) VALUES(?,?,?)').run(ownerId,curProj.name,project);
      }catch{}
    }

    const fullTitle=category?`${cleanName}（${category}）`:cleanName;
    const now=Date.now();
    return vault.transaction(()=>{
      const old=db.prepare("SELECT * FROM memory WHERE scope='project' AND owner=? AND name=?").get(ownerId,fullTitle);
      const id=old?old.id:crypto.randomUUID();
      const rev=old?old.revision+1:1;
      const src='project-overview:'+project;
      db.prepare('INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,enabled=1,source=excluded.source,updated=excluded.updated')
        .run(id,'project',ownerId,fullTitle,cleanBody,rev,1,src,now);
      db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?)').run(id,rev,cleanBody,1,src,now);
      db.prepare("INSERT OR REPLACE INTO vault_meta VALUES('memory_version',?)").run(crypto.randomUUID());
      return {id,scope:'project',owner:ownerId,name:fullTitle,revision:rev};
    });
  }

  return {list,change,summarize,summarizeAll,discover,getOverview,saveOverview,generateOverview,promoteMemory,DEFAULT_MODEL};
}
module.exports={createDirectories,DEFAULT_MODEL};
