import { h } from '../util.js';
import { post } from '../net.js';
import {reviewPanel} from './research-review.js';

const STATES={queued:'排队中',running:'抽取中',succeeded:'已完成',failed:'失败',interrupted:'已中断',
  planned:'计划',started:'已启动',reported_complete:'报告完成',reported_failed:'报告失败',unknown:'待确认'};
const KINDS={calculation:'计算',validation:'验证',exploration:'探索',analysis:'分析',implementation:'实现',other:'其他'};

export function researchTab(project) {
  const root=h('div',{class:'pr-root'}),status=h('div',{class:'pm-status',text:'读取 NAS 研究档案…'});
  const review=reviewPanel(project.id);
  const settings=h('details',{class:'pr-card'},h('summary',{text:'DeepSeek API 设置（保存在 NAS）'}));
  const model=h('input',{class:'field',placeholder:'模型名称'}),base=h('input',{class:'field',placeholder:'API 地址'});
  const key=h('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'密钥：留空保留现有值'});
  const form=h('div',{class:'pr-form'},h('label',{},'模型',model),h('label',{},'API 地址',base),h('label',{},'密钥',key),
    h('button',{class:'btn',text:'保存 API 设置',onclick:async()=>{
      const r=await post('/api/research/config',{project:project.id,model:model.value,base:base.value,key:key.value});
      if(r.ok){key.value='';status.textContent='已保存 NAS 的 API 设置';await refresh();}else status.textContent=r.msg;
    }}));settings.append(form);
  const sourceSelect=h('select',{class:'field'}),docs=h('div'),jobs=h('div'),work=h('div');
  const query=h('input',{class:'field',placeholder:'搜索本项目已导入的原文、命令和计算输出'}),hits=h('div');
  const toolbar=h('div',{class:'pr-toolbar'},sourceSelect,h('button',{class:'btn',text:'导入选中会话',onclick:async()=>{
    const s=sources.find(s=>JSON.stringify([s.machine,s.key])===sourceSelect.value);if(!s){status.textContent='请先登记项目工作区，或选择已有会话';return;}
    const r=await post('/api/research/import',{project:project.id,refs:[{machine:s.machine,key:s.key,generation:s.generation}]});
    status.textContent=r.ok?'已建立清洁事件；原始存档仍完整保留':r.msg;await refresh();
  }}),h('button',{class:'btn',text:'刷新',onclick:()=>refresh(true)}));
  const processing=h('details',{},h('summary',{text:'导入与抽取'}),status,
    h('h3',{text:'历史资料'}),toolbar,docs,h('h3',{text:'抽取任务'}),jobs,h('h3',{text:'研究与计算成果'}),work,
    h('h3',{text:'查阅原文'}),h('div',{class:'pr-toolbar'},query,h('button',{class:'btn',text:'搜索',onclick:async()=>{
      const r=await get('/search&q='+encodeURIComponent(query.value));
      hits.replaceChildren(...(r.items||[]).map(e=>h('div',{class:'pr-card'},h('b',{text:e.machine+' · '+e.kind}),h('pre',{text:e.text}),evidenceButton(e.id))));
      if(!r.ok)status.textContent=r.msg;
    }})),hits);
  root.append(review.root,settings,processing);
  let sources=[],closed=false,initialized=false;
  async function get(suffix=''){const i=suffix.indexOf('&'),route=i<0?suffix:suffix.slice(0,i),extra=i<0?'':suffix.slice(i);
    try{return await(await fetch('/api/research'+route+'?project='+encodeURIComponent(project.id)+extra)).json();}catch{return{ok:false,msg:'无法读取 NAS 研究档案'};}}
  function evidenceButton(id){return h('button',{class:'btn',text:'原文与前后文',onclick:async()=>{
    const r=await get('/evidence&id='+encodeURIComponent(id));if(!r.ok){status.textContent=r.msg;return;}
    const e=r.item,dialog=h('dialog',{class:'pr-evidence'}),raw='/api/research/raw?project='+encodeURIComponent(project.id)+'&id='+encodeURIComponent(e.document);
    dialog.append(h('b',{text:e.machine+' · '+e.session+' · 原始记录位置 '+e.line}),
      ...e.around.map(x=>h('div',{},h('small',{text:x.line+' · '+x.role+' · '+x.kind}),h('pre',{text:x.text}))),
      h('a',{href:raw,text:'下载对应版本原始存档'}),h('button',{class:'btn',text:'关闭',onclick:()=>dialog.close()}));
    dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();
  }});}
  function refs(evidence){return h('div',{class:'pr-refs'},...(evidence||[]).map(e=>h('details',{},h('summary',{text:'证据引用'}),h('blockquote',{text:e.quote}),evidenceButton(e.event_id))));}
  async function refresh(reloadSources=false){
    const r=await get();if(closed)return;if(!r.ok){status.textContent=r.msg;return;}
    if(!initialized){model.value=r.provider.model||'';base.value=r.provider.base||'';initialized=true;}
    status.textContent=`${r.provider.model||'DeepSeek 未配置'} · ${r.documents.length} 份已导入资料 · ${r.totals.work} 个抽取结果`;
    if(!sources.length||reloadSources){const sr=await get('/sources');if(closed)return;sources=sr.items||[];
      sourceSelect.replaceChildren(...sources.map(s=>h('option',{value:JSON.stringify([s.machine,s.key]),text:s.machine+' · '+s.provider+' · '+s.session+' · '+s.path.split(/[\\/]/).pop()})));}
    docs.replaceChildren(...r.documents.map(d=>h('div',{class:'pr-card'},h('b',{text:d.machine+' · '+d.provider+' · '+d.session}),
      h('p',{text:d.cwd+' · '+d.events+' 个结构化事件'}),h('button',{class:'btn',text:'抽取下一批（最多 3 段）',onclick:async()=>{
        const x=await post('/api/research/enqueue',{project:project.id,document:d.id,maxJobs:3});
        status.textContent=x.ok?`新增 ${x.item.ids.length} 个任务，尚余 ${x.item.remaining} 段未排队`:x.msg;await refresh();
      }}))));
    jobs.replaceChildren(...r.jobs.slice(0,25).map(j=>h('div',{class:'pr-card'},h('b',{text:(STATES[j.state]||j.state)+' · '+j.model}),
      h('span',{text:' · 尝试 '+j.attempts+' 次'}),j.error?h('p',{text:j.error}):null,
      ['failed','interrupted'].includes(j.state)?h('button',{class:'btn',text:'重试',onclick:async()=>{const x=await post('/api/research/retry',{project:project.id,id:j.id});if(!x.ok)status.textContent=x.msg;await refresh();}}):null)));
    work.replaceChildren(...r.work.map(w=>{const b=w.body;return h('article',{class:'pr-card'},
      h('b',{text:b.title}),h('small',{text:' · '+KINDS[b.kind]+' · '+STATES[b.state]+' · '+w.machine}),h('p',{text:b.objective}),refs(b.evidence),
      ...b.runs.map(run=>h('section',{},h('b',{text:'运行：'+run.description+' · '+STATES[run.state]}),
        run.command?h('pre',{text:run.command}):null,(run.code_ref?.branch||run.code_ref?.commit)?h('p',{text:'历史代码条件：'+[run.code_ref.branch,run.code_ref.commit].filter(Boolean).join(' · ')}):null,
        run.inputs.length?h('p',{text:'输入：'+run.inputs.join('，')}):null,run.outputs.length?h('p',{text:'产物位置（待核对）：'+run.outputs.join('，')}):null,
        ...run.metrics.map(m=>h('p',{text:m.name+'：'+m.value_text+' '+m.unit})),refs(run.evidence))),
      ...b.findings.map(f=>h('section',{},h('p',{text:({'reported':'报告','measurement':'工具测量','hypothesis':'假设'}[f.basis]||f.basis)+'：'+f.text}),refs(f.evidence))),
      b.support_activities?.length?h('details',{},h('summary',{text:'资料查阅 · '+b.support_activities.length}),...b.support_activities.map(a=>h('div',{},h('p',{text:a.description}),refs(a.evidence)))):null,
      b.open_questions.length?h('p',{text:'未决问题：'+b.open_questions.join('；')}):null); }));
    if(!r.work.length)work.append(h('p',{text:'尚无抽取成果。先导入历史会话，再运行小批抽取。'}));
  }
  refresh();const timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return;}refresh();},5000);
  return {root,projectId:project.id,destroy(){closed=true;review.destroy();clearInterval(timer);root.querySelectorAll('dialog').forEach(d=>d.close());}};
}
