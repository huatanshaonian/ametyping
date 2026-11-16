import {h,icon} from '../util.js';
import {post} from '../net.js';
import * as wm from '../wm.js';
import * as mesh from '../mesh.js';
import {directoryPanel} from './directory-summary.js';
const states={planned:'计划',started:'进行中',reported_complete:'已完成',reported_failed:'失败',unknown:'待整理'};
const kinds={calculation:'计算',validation:'验证',exploration:'analysis',analysis:'分析',implementation:'实现',other:'其他'};
const reviews={pending:'待核对',confirmed:'已确认',ignored:'已忽略',merged:'已合并'};
async function get(url){const res=await fetch(url);if(res.status===401){location.href='/login';return{ok:false,msg:'需要登录'};}return res.json();}
let instance=null;
export function reviewPanel(initialProject=null){
  let project=initialProject,projects=[],items=[],overview=null,selected=new Set(),closed=false,busy=false;
  const side=h('aside',{class:'rr-side'}),title=h('b',{text:'工作事项'}),status=h('div',{class:'pm-status',text:'读取项目工作…'}),list=h('div');
  const overviewBox=h('div',{class:'ro-wrap'});
  const filter=h('select',{class:'field'},...Object.entries({pending:'待核对',confirmed:'已确认',all:'全部',ignored:'已忽略',merged:'已合并'}).map(([value,text])=>h('option',{value,text})));
  const search=h('input',{class:'field',placeholder:'搜索工作标题和内容'});
  const merge=h('button',{class:'btn rr-action',text:'合并选中',disabled:true,onclick:mergeDialog});
  const directoryView=directoryPanel(async()=>{
    try{
      await mesh.load();
      const r=await get('/api/research/review/projects');
      if(!closed&&r.ok){projects=r.items;drawCatalog();}
    }catch{}
  }),directories=directoryView.root;
  const overviewBtn=h('button',{class:'btn go',text:'🧭 AI 生成项目总览',onclick:runGenerateOverview});
  const addDirBtn=h('button',{class:'btn',text:'＋ 添加目录',onclick:()=>directoryView.openAddDialog()});
  const discoverBtn=h('button',{class:'btn',text:'🔍 AI 发现跨机目录',onclick:runDiscover});
  const sumAllBtn=h('button',{class:'btn',text:'🤖 AI 批量生成目录总结',onclick:runSummarizeAll});
  const apiCfgBtn=h('button',{class:'btn',text:'⚙️ AI 模型与 API 设置',onclick:async()=>{const c=await import('./control.js');c.open('ai');}});
  const root=h('div',{class:'rr-root pr-pilots'+(initialProject?' rr-embedded':'')},side,
    h('section',{class:'rr-main'},
      h('div',{class:'pr-toolbar'},title,overviewBtn,addDirBtn,discoverBtn,sumAllBtn,apiCfgBtn,h('button',{class:'btn',text:'刷新',onclick:reload})),
      overviewBox,
      directories,
      h('details',{class:'rr-raw'},h('summary',{text:'抽取依据与核对'}),h('div',{class:'pr-toolbar'},filter,search,merge),status,list)));

  function say(text){status.textContent=text;}

  function jumpToDirNode(mach,dirPath){
    const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
    const target=norm(dirPath);
    const cards=[...directories.querySelectorAll('.rd-card')];
    const match=cards.find(c=>{
      const code=c.querySelector('.rd-node-path, code');
      const full=norm(code?.getAttribute('title')||code?.textContent||'');
      return full===target||full.endsWith('/'+target.split('/').pop());
    });
    if(match){
      match.scrollIntoView({behavior:'smooth',block:'center'});
      match.classList.add('rd-flash');
      setTimeout(()=>match.classList.remove('rd-flash'),1500);
    }
  }

  function renderOverview(){
    if(!overview||!overview.body){
      overviewBox.replaceChildren();
      return;
    }
    const b=overview.body;
    const eco=b.ecosystem||{};
    const tracks=Array.isArray(b.research_tracks)?b.research_tracks:[];
    const mems=Array.isArray(b.memory_candidates)?b.memory_candidates:[];

    const ecoBlock=h('div',{class:'ro-eco'},
      h('div',{class:'ro-eco-role'},h('b',{text:'🌐 跨项目生态定位：'}),h('span',{text:eco.role||''})),
      Array.isArray(eco.edges)&&eco.edges.length?h('div',{class:'ro-eco-edges'},
        ...eco.edges.map(e=>h('span',{class:'ro-edge-pill'},
          h('b',{text:e.from}),
          h('span',{class:'pm-edge-arrow',text:' ──► '}),
          h('b',{text:e.to}),
          h('small',{text:`（${e.relation}）`})
        ))
      ):null
    );

    const trackCards=tracks.map(t=>{
      const stCls=/已合入|完成/.test(t.status)?'done':/限制|边界/.test(t.status)?'warn':'run';
      return h('div',{class:'ro-track-card'},
        h('div',{class:'ro-track-head'},
          h('b',{text:'📌 '+t.title}),
          h('span',{class:'pm-rev-badge '+stCls,text:t.status||'进行中'})
        ),
        h('p',{class:'ro-track-sum',text:t.summary||''}),
        Array.isArray(t.stages)&&t.stages.length?h('div',{class:'ro-stages'},
          ...t.stages.map((s,idx)=>h('span',{
            class:'ro-stage-pill',
            title:`点击定位到下方目录节点：${s.machine}:${s.path}`,
            onclick:()=>jumpToDirNode(s.machine,s.path),
          },
            h('b',{text:`${idx+1}. ${s.machine}:${String(s.path||'').replace(/\\/g,'/').split('/').pop()}`}),
            s.branch?h('code',{text:`[${s.branch}]`}):null,
            h('span',{text:` — ${s.milestone}`})
          ))
        ):null,
        Array.isArray(t.key_metrics)&&t.key_metrics.length?h('div',{class:'ro-metrics'},
          h('b',{text:'📊 关键指标：'}),
          ...t.key_metrics.map(m=>h('span',{class:'ro-metric-pill',text:m}))
        ):null,
        t.next_action?h('div',{class:'ro-next'},h('b',{text:'🚀 下一步规划：'}),h('span',{text:t.next_action})):null
      );
    });

    const memCards=mems.map(m=>{
      const promoteBtn=h('button',{class:'btn go',type:'button',text:'📥 一键写入项目记忆',onclick:async()=>{
        promoteBtn.disabled=true;
        const r=await post('/api/research/overview/promote-memory',{
          project,
          name:m.name,
          category:m.category||'',
          body:m.body+(Array.isArray(m.source_dirs)&&m.source_dirs.length?`\n\n来源目录：${m.source_dirs.join('、')}`:''),
        });
        if(r.ok){
          promoteBtn.textContent='✓ 已写入项目记忆';
          promoteBtn.classList.remove('go');
          say(`已将「${m.name}」写入项目专属记忆并同步下发`);
        }else{
          promoteBtn.disabled=false;
          say(r.msg||'写入记忆失败');
        }
      }});
      return h('div',{class:'ro-mem-card'},
        h('div',{class:'ro-track-head'},
          h('span',{class:'xtag',text:m.category||'项目经验'}),
          h('b',{text:m.name}),
          promoteBtn
        ),
        h('p',{class:'ro-track-sum',text:m.body}),
        Array.isArray(m.source_dirs)&&m.source_dirs.length?h('small',{class:'ghint',text:'依据目录：'+m.source_dirs.join('、')}):null
      );
    });

    overviewBox.replaceChildren(
      h('details',{class:'ro-panel',open:true},
        h('summary',{class:'ro-summary-bar'},
          h('b',{text:`🧭 项目宏观总览与课题演进脉络（${tracks.length} 条跨目录课题主线 · ${mems.length} 条可沉淀项目经验）`}),
          overview.updated?h('small',{class:'ghint',style:'margin-left:auto',text:'更新于 '+new Date(overview.updated).toLocaleString()}):null
        ),
        h('div',{class:'ro-body'},
          ecoBlock,
          tracks.length?h('div',{class:'ro-sec-title',text:'🛠️ 跨电脑/跨目录课题演进主线（点击阶段节点可定位下方目录卡片）：'}):null,
          tracks.length?h('div',{class:'ro-tracks-grid'},...trackCards):null,
          mems.length?h('div',{class:'ro-sec-title',text:'💡 提炼出的适用边界、选型结论与工程基线（可一键沉淀为项目专属记忆）：'}):null,
          mems.length?h('div',{class:'ro-mems-grid'},...memCards):null
        )
      )
    );
  }

  async function runGenerateOverview(){
    if(busy||!project)return;busy=true;overviewBtn.disabled=true;
    say('正在聚合当前项目所有目录总结与记忆，生成跨目录课题演进总览…');
    try{
      const r=await post('/api/research/overview/generate',{project});
      if(!r.ok){say(r.msg||'生成项目总览失败');return;}
      overview=r.item;
      renderOverview();
      say('已生成项目宏观总览与课题演进脉络');
    }finally{busy=false;overviewBtn.disabled=false;}
  }

  async function runDiscover(){
    if(busy)return;busy=true;discoverBtn.disabled=true;
    say('正在扫描全网电脑会话与 Git Worktree，自动发现并归类项目目录…');
    try{
      const r=await post('/api/research/discover',{});
      if(!r.ok){say(r.msg||'目录发现失败');return;}
      await mesh.load();
      await reload();
      say(`已完成跨机目录发现：新归入 ${(r.item?.added||[]).length} 个目录`);
    }finally{busy=false;discoverBtn.disabled=false;}
  }

  async function runSummarizeAll(){
    if(busy||!project)return;busy=true;sumAllBtn.disabled=true;
    say('正在批量生成当前项目下所有待整理目录的工作总结…');
    try{
      const r=await post('/api/research/directories/summarize-all',{project});
      if(!r.ok){say(r.msg||'批量生成失败');return;}
      await reload();
      say(`批量总结完成：已生成 ${(r.item?.completed||[]).length} 个目录总结`+((r.item?.skipped||[]).length?`（跳过 ${r.item.skipped.length} 个无独立会话目录）`:''));
    }finally{busy=false;sumAllBtn.disabled=false;}
  }

  function drawCatalog(){
    side.replaceChildren(h('b',{text:'项目目录'}),...projects.map(p=>h('button',{class:'rr-project'+(project===p.id?' sel':''),type:'button',text:p.name+' · '+p.directories.length+' 个目录',onclick:()=>{project=p.id;selected.clear();reload();}})));
    const p=projects.find(p=>p.id===project);title.textContent=p?p.name+' · 目录工作总结（共 '+p.directories.length+' 个跨机目录/分支）':'目录工作总结';
  }

  async function reload(){
    try{const r=await get('/api/research/review/projects');if(closed)return;if(!r.ok){say(r.msg);return;}projects=r.items;
      if(!projects.some(p=>p.id===project))project=projects[0]?.id||null;
      drawCatalog();if(!project){items=[];overview=null;renderOverview();list.replaceChildren();say('先创建一个项目，即可整理工作事项。');return;}
      const requested=project;
      const [data,ovRes]=await Promise.all([
        get('/api/research/review/items?project='+encodeURIComponent(project)),
        get('/api/research/overview?project='+encodeURIComponent(project)),
      ]);
      if(closed||requested!==project)return;
      if(!data.ok){say(data.msg);return;}
      items=data.items;
      overview=ovRes&&ovRes.ok?ovRes.item:null;
      selected.clear();
      renderOverview();
      render();
      await directoryView.load(project);
    }catch{if(!closed)say('读取项目工作失败');}
  }
  async function change(body,feedback=null){
    if(busy)return false;busy=true;root.querySelectorAll('.rr-action').forEach(b=>b.disabled=true);
    try{const r=await post('/api/research/review',body);if(!r.ok){say(r.msg);if(feedback)feedback.textContent=r.msg;return false;}
      await reload();say({confirm:'已确认',ignore:'已忽略',restore:'已恢复',edit:'修改已保存',merge:'已合并，可在事项上撤销',undo:'已撤销'}[body.action]||'已保存');return true;
    }finally{busy=false;root.querySelectorAll('.rr-action').forEach(b=>b.disabled=false);merge.disabled=selected.size<2;}
  }
  const request=(action,item,extra={})=>change({action,id:item.id,revisions:{[item.id]:item.revision},...extra});
  function refs(values){return h('details',{class:'rr-evidence'},h('summary',{text:'来源原文 · '+(values||[]).length}),...(values||[]).map(ref=>h('div',{},h('blockquote',{text:ref.quote}),h('button',{class:'btn',text:'查看原文',onclick:()=>evidenceDialog(ref)}))));}
  async function evidenceDialog(ref){
    try{const url=ref.pilot?'/api/research/pilot/evidence?id='+encodeURIComponent(ref.pilot)+'&event='+encodeURIComponent(ref.event_id)+'&offset='+(ref.start||0):'/api/research/evidence?project='+encodeURIComponent(ref.project||project)+'&id='+encodeURIComponent(ref.event_id);
      const r=await get(url);if(closed)return;if(!r.ok){say(r.msg);return;}
      const e=r.item,dialog=h('dialog',{class:'pr-evidence'});
      dialog.append(h('b',{text:e.machine+' · '+e.cwd}),h('p',{text:'会话 '+e.session+' · 记录 '+e.line}),h('blockquote',{text:ref.quote}),h('pre',{text:e.text}),...(e.around||[]).map(a=>h('details',{},h('summary',{text:'附近记录 '+a.line+' · '+a.role}),h('pre',{text:a.text}))),h('button',{class:'btn',text:'关闭',onclick:()=>dialog.close()}));
      dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();
    }catch{say('读取原文失败');}
  }
  function card(item){const w=item.body;
    const check=h('input',{type:'checkbox',checked:selected.has(item.id),disabled:['ignored','merged'].includes(item.status),onchange:e=>{e.target.checked?selected.add(item.id):selected.delete(item.id);merge.textContent='合并选中'+(selected.size?'（'+selected.size+'）':'');merge.disabled=selected.size<2;}});
    return h('article',{class:'pr-card rr-item',dataset:{id:item.id,revision:String(item.revision)}},
      h('div',{class:'rr-item-head'},check,h('b',{text:w.title}),h('span',{class:'rr-badge '+item.status,text:reviews[item.status]})),
      h('p',{class:'rr-item-meta',text:(kinds[w.kind]||w.kind)+' · '+(states[w.state]||w.state)}),h('p',{text:w.objective}),
      h('div',{class:'pr-toolbar rr-actions'},item.status==='pending'?h('button',{class:'btn rr-action',text:'确认',onclick:()=>request('confirm',item)}):null,
        !['ignored','merged'].includes(item.status)?h('button',{class:'btn rr-action',text:'修改',onclick:()=>editDialog(item)}):null,
        !['ignored','merged'].includes(item.status)?h('button',{class:'btn rr-action',text:'忽略',onclick:()=>request('ignore',item)}):null,
        ['ignored','confirmed'].includes(item.status)?h('button',{class:'btn rr-action',text:'恢复待核对',onclick:()=>request('restore',item)}):null,
        item.canUndo?h('button',{class:'btn rr-action',text:item.status==='merged'?'撤销合并':'撤销上次操作',onclick:()=>request('undo',item)}):null),
      h('details',{},h('summary',{text:'关联目录 · '+item.origins.length}),...item.origins.map(o=>h('p',{},h('b',{text:o.machine+' '}),h('code',{text:o.path})))),refs(w.evidence),
      w.findings?.length?h('details',{},h('summary',{text:'结论 · '+w.findings.length}),...w.findings.map(f=>h('section',{},h('p',{text:f.text}),f.evidence?.length?refs(f.evidence):null))):null,
      w.runs?.length?h('details',{},h('summary',{text:'计算活动 · '+w.runs.length}),...w.runs.map(r=>h('section',{},h('b',{text:r.description}),h('p',{text:states[r.state]||r.state}),r.command?h('pre',{text:r.command}):null,...(r.metrics||[]).map(m=>h('p',{text:m.name+'：'+m.value_text+' '+m.unit})),refs(r.evidence)))):null,
      w.open_questions?.length?h('details',{},h('summary',{text:'未决问题 · '+w.open_questions.length}),...w.open_questions.map(t=>h('p',{text:t}))):null);
  }
  function render(){
    const q=search.value.trim().toLowerCase(),visible=items.filter(i=>(filter.value==='all'||i.status===filter.value)&&(!q||JSON.stringify(i.body).toLowerCase().includes(q)));
    const counts=projects.find(p=>p.id===project)?.counts||{};say('待核对 '+(counts.pending||0)+' · 已确认 '+(counts.confirmed||0)+' · 已忽略 '+(counts.ignored||0));
    list.replaceChildren(...visible.map(card));if(!visible.length)list.append(h('p',{text:'此列表没有工作事项。'}));merge.disabled=selected.size<2;merge.textContent='合并选中';
  }
  function modal(title,content){const dialog=h('dialog',{class:'pr-evidence rr-editor'},h('h3',{text:title}),content);dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();return dialog;}
  function editDialog(item){
    const w=item.body,title=h('input',{class:'field',value:w.title,maxLength:240}),objective=h('textarea',{class:'field',rows:4,value:w.objective}),state=h('select',{class:'field'},...Object.entries(states).map(([value,text])=>h('option',{value,text}))),kind=h('select',{class:'field'},...Object.entries(kinds).map(([value,text])=>h('option',{value,text}))),target=h('select',{class:'field'},...projects.map(p=>h('option',{value:p.id,text:p.name}))),findings=h('textarea',{class:'field',rows:7,value:(w.findings||[]).map(f=>f.text).join('\n')}),feedback=h('p');
    objective.value=w.objective||'';findings.value=(w.findings||[]).map(f=>f.text).join('\n');
    state.value=w.state||'unknown';kind.value=w.kind||'other';target.value=item.project;
    const form=h('div',{class:'pr-form'},h('label',{},'标题',title),h('label',{},'项目',target),h('label',{},'工作说明',objective),h('label',{},'类型',kind),h('label',{},'状态',state),h('label',{},'结论',findings),h('small',{text:'结论每行一条。'}),feedback),dialog=modal('修改工作事项',form);
    const save=async confirm=>{const ok=await change({action:'edit',id:item.id,revisions:{[item.id]:item.revision},confirm,patch:{title:title.value,objective:objective.value,state:state.value,kind:kind.value,project:target.value,findings:findings.value}},feedback);if(ok)dialog.close();};
    form.append(h('div',{class:'pr-toolbar'},h('button',{class:'btn rr-action',text:'保存修改',onclick:()=>save(false)}),h('button',{class:'btn rr-action',text:'保存并确认',onclick:()=>save(true)}),h('button',{class:'btn',text:'取消',onclick:()=>dialog.close()})));
  }
  function mergeDialog(){
    const rows=items.filter(i=>selected.has(i.id));if(rows.length<2)return;
    const title=h('input',{class:'field',value:rows[0].body.title,maxLength:240}),feedback=h('p'),form=h('div',{class:'pr-form'},h('label',{},'合并后标题',title),...rows.map(r=>h('p',{text:r.body.title})),feedback),dialog=modal('合并工作事项',form);
    form.append(h('div',{class:'pr-toolbar'},h('button',{class:'btn rr-action',text:'合并',onclick:async()=>{const ok=await change({action:'merge',ids:rows.map(r=>r.id),revisions:Object.fromEntries(rows.map(r=>[r.id,r.revision])),title:title.value},feedback);if(ok)dialog.close();}}),h('button',{class:'btn',text:'取消',onclick:()=>dialog.close()})));
  }
  filter.addEventListener('change',()=>{selected.clear();render();});search.addEventListener('input',()=>{selected.clear();render();});reload();
  return{root,projectId:initialProject,destroy(){closed=true;directoryView.destroy();root.querySelectorAll('dialog').forEach(d=>d.close());}};
}
export function open(){
  if(instance){wm.open({id:'research-pilots'});return;}
  instance=reviewPanel();wm.open({id:'research-pilots',title:'目录工作总结',icon:icon('projects',true),width:1000,height:700,content:instance.root,onClose:()=>{instance.destroy();instance=null;}});
}
