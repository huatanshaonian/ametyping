import {h,icon} from '../util.js';
import {post} from '../net.js';
import * as wm from '../wm.js';
import {directoryPanel} from './directory-summary.js';
const states={planned:'计划',started:'进行中',reported_complete:'已完成',reported_failed:'失败',unknown:'待整理'};
const kinds={calculation:'计算',validation:'验证',exploration:'探索',analysis:'分析',implementation:'实现',other:'其他'};
const reviews={pending:'待核对',confirmed:'已确认',ignored:'已忽略',merged:'已合并'};
async function get(url){const res=await fetch(url);if(res.status===401){location.href='/login';return{ok:false,msg:'需要登录'};}return res.json();}
let instance=null;
export function reviewPanel(initialProject=null){
  let project=initialProject,projects=[],items=[],selected=new Set(),closed=false,busy=false;
  const side=h('aside',{class:'rr-side'}),title=h('b',{text:'工作事项'}),status=h('div',{class:'pm-status',text:'读取项目工作…'}),list=h('div');
  const filter=h('select',{class:'field'},...Object.entries({pending:'待核对',confirmed:'已确认',all:'全部',ignored:'已忽略',merged:'已合并'}).map(([value,text])=>h('option',{value,text})));
  const search=h('input',{class:'field',placeholder:'搜索工作标题和内容'});
  const merge=h('button',{class:'btn rr-action',text:'合并选中',disabled:true,onclick:mergeDialog});
  const directoryView=directoryPanel(),directories=directoryView.root;
  const root=h('div',{class:'rr-root pr-pilots'+(initialProject?' rr-embedded':'')},side,
    h('section',{class:'rr-main'},h('div',{class:'pr-toolbar'},title,h('button',{class:'btn',text:'刷新',onclick:reload})),directories,
      h('details',{class:'rr-raw'},h('summary',{text:'抽取依据与核对'}),h('div',{class:'pr-toolbar'},filter,search,merge),status,list)));
  function say(text){status.textContent=text;}
  function drawCatalog(){
    side.replaceChildren(h('b',{text:'项目目录'}),...projects.map(p=>h('button',{class:'rr-project'+(project===p.id?' sel':''),type:'button',text:p.name+' · '+p.directories.length+' 个目录',onclick:()=>{project=p.id;selected.clear();reload();}})));
    const p=projects.find(p=>p.id===project);title.textContent=p?p.name+' · 目录工作总结':'目录工作总结';
  }
  async function reload(){
    try{const r=await get('/api/research/review/projects');if(closed)return;if(!r.ok){say(r.msg);return;}projects=r.items;
      if(!projects.some(p=>p.id===project))project=projects[0]?.id||null;
      drawCatalog();if(!project){items=[];list.replaceChildren();say('先创建一个项目，即可整理工作事项。');return;}
      const requested=project,data=await get('/api/research/review/items?project='+encodeURIComponent(project));if(closed||requested!==project)return;
      if(!data.ok){say(data.msg);return;}items=data.items;selected.clear();render();await directoryView.load(project);
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
