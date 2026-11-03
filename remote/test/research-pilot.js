// Explicit live pilot only. Reads the NAS vault without modifying it; all derived work goes to a separate DB.
'use strict';
const fs=require('fs'),path=require('path');
const {DatabaseSync}=require('node:sqlite');
const {openVault,hash,CHUNK}=require('../server/vault/database');
const {createResearch}=require('../server/research/service');
const {resolveDeepseek}=require('../server/ai/deepseek-api');
const {segments}=require('../server/research/normalize');
const {cases,assess}=require('./fixtures/research');

async function main(){
  const args=process.argv.slice(2),option=k=>{const i=args.indexOf(k);return i<0?'':args[i+1];};
  if(!args.includes('--live'))throw Error('真实调用必须显式传入 --live；离线测试用 node --test research.test.js');
  const output=path.resolve(option('--out')||path.join(__dirname,'out','research-pilot'));
  const sourceFile=option('--source-db');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const cfg=resolveDeepseek();if(!cfg.key)throw Error('NAS 缺少 DeepSeek API 配置');
  const v=openVault(output),project='pilot-cem-po';
  const service=createResearch({vault:v,getProject:id=>id===project?{id}:null,resolve:()=>cfg,log:console.log});
  const samples=[];
  function addRaw(bytes,meta){
    const key=hash('pilot:'+meta.machine+':'+meta.session),b=v.begin(meta.machine,{...meta,key,path:meta.path||'pilot/'+meta.session+'.jsonl',parent:'',kind:'native',size:bytes.length,mtime:meta.mtime||1});
    for(let start=0;start<bytes.length;start+=CHUNK){const part=bytes.subarray(start,start+CHUNK);v.append(meta.machine,{key,generation:b.generation,start,data:part.toString('base64'),sha256:hash(part)});}
    v.finish(meta.machine,{key,generation:b.generation,sha256:hash(bytes)});
    return service.store.importSource(project,{machine:meta.machine,key,generation:b.generation});
  }
  try{
    for(const c of args.includes('--historical-only')?[]:cases){
      const d=addRaw(Buffer.from(c.rows.map(x=>JSON.stringify(x)).join('\n')+'\n'),{machine:'fixture',session:c.name,provider:'claude',cwd:'G:/feko_data/CEM_PO'});
      const q=service.enqueue(project,d.id,{maxJobs:1});samples.push({name:c.name,document:d.id,job:q.ids[0]||v.db.prepare('SELECT id FROM research_jobs WHERE document=?').get(d.id)?.id,synthetic:true});
    }
    if(sourceFile){
      const source=new DatabaseSync(path.resolve(sourceFile),{readOnly:true});
      try{
        const rows=source.prepare(`SELECT s.* FROM sources s WHERE complete=1 AND kind='native' AND provider IN ('claude','codex')
          AND lower(cwd) LIKE '%cem%' AND size BETWEEN 2000 AND 15000000
          AND rowid=(SELECT rowid FROM sources t WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)
          ORDER BY updated DESC LIMIT 20`).all();
        let added=0;
        for(const s of rows){
          if(option('--session')&&s.session!==option('--session'))continue;
          if(added>=2)break;
          const bytes=Buffer.concat(source.prepare('SELECT data FROM chunks WHERE machine=? AND key=? AND generation=? ORDER BY start').all(s.machine,s.key,s.generation).map(x=>Buffer.from(x.data)));
          if(hash(bytes)!==s.digest)throw Error('试点来源校验失败');
          const d=addRaw(bytes,s),batches=[...segments(service.store.events(d.id),12000)];
          const candidates=batches.map((batch,i)=>({i,score:batch.filter(x=>x.role==='assistant'||x.kind==='tool_result').reduce((n,e)=>n+(e.text.match(/残差|误差|验证|计算|RCS|收敛|results|residual|error=/gi)||[]).length,0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
          if(!candidates.length)continue;
          const q=service.enqueue(project,d.id,{maxJobs:1,maxChars:12000,segmentIndices:[candidates[0].i]});
          samples.push({name:'historical-'+s.machine+'-'+s.session,document:d.id,job:q.ids[0]||v.db.prepare('SELECT id FROM research_jobs WHERE document=?').get(d.id)?.id,synthetic:false,
            original:{machine:s.machine,key:s.key,generation:s.generation,digest:s.digest},selectedSegment:candidates[0].i,totalSegments:batches.length});added++;
        }
      }finally{source.close();}
    }
    while(v.db.prepare("SELECT count(*) n FROM research_jobs WHERE state IN ('queued','running')").get().n){await service.tick();await new Promise(r=>setTimeout(r,25));}
    const list=service.store.list(project),report={at:new Date().toISOString(),provider:{model:cfg.model,base:cfg.base},project,
      scope:(args.includes('--historical-only')?'历史样本复测':'四个人工对照样例与最多两份历史会话的选定片段')+'；不代表全量历史质量',samples:[],totals:{jobs:list.jobs.length,work:list.work.length,input:0,output:0},issues:[]};
    for(const sample of samples){const job=list.jobs.find(j=>j.id===sample.job),work=list.work.filter(w=>w.job===sample.job);
      const issues=job?.state==='succeeded'?(sample.synthetic?assess(sample.name,{work_items:work.map(w=>w.body)}):['历史样本语义质量仍需人工核对']):[job?.error||'任务缺失'];
      report.samples.push({...sample,state:job?.state,attempts:job?.attempts,usage:job?.usage,work:work.map(w=>({id:w.id,...w.body})),issues});
      if(sample.synthetic)report.issues.push(...issues.map(i=>sample.name+': '+i));
    }
    for(const j of list.jobs)for(const u of j.usage){report.totals.input+=u.input||0;report.totals.output+=u.output||0;}
    const probes=['网格','残差','RCS'];report.search=probes.map(q=>({query:q,hits:service.store.search(project,q).length}));
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
    const md=['# CEM_PO 研究档案首轮试点','',`时间：${report.at}`,`模型：${cfg.model}`,report.scope,'',
      `任务 ${report.totals.jobs}，工作 ${report.totals.work}；输入 ${report.totals.input} token，输出 ${report.totals.output} token。`,'',
      ...report.samples.flatMap(s=>[`## ${s.name}`,`状态：${s.state}；调用 ${s.attempts} 次。`,...s.work.map(w=>`- ${w.title}（${w.kind}，${w.state}）：${w.objective}`),
        ...s.issues.map(i=>`- 待核对：${i}`),'']),
      '本轮只核对引用是否逐字存在、结构是否有效及人工对照样例；不把模型抽取当作物理结论验证。'];
    fs.writeFileSync(path.join(output,'report.md'),md.join('\n'),{mode:0o600});
    console.log(JSON.stringify({directory:output,...report.totals,states:report.samples.map(s=>({name:s.name,state:s.state,work:s.work.length,issues:s.issues})),issues:report.issues}));
    if(report.samples.some(s=>s.state!=='succeeded')||report.issues.length)process.exitCode=1;
  }finally{service.close();v.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
