import {h,icon} from '../util.js';
import * as wm from '../wm.js';
let instance=null;
const states={planned:'计划',started:'已启动',reported_complete:'报告完成',reported_failed:'报告失败',unknown:'待确认'};
async function get(url){const res=await fetch(url);if(res.status===401){location.href='/login';return{ok:false,msg:'需要登录'};}return res.json();}
export function open(){
  if(instance){wm.open({id:'research-pilots'});return;}
  let closed=false,selected='';
  const status=h('p',{class:'pm-status',text:'读取 NAS 首轮整理结果…'}),select=h('select',{class:'field'}),body=h('div');
  const root=h('div',{class:'pr-root pr-pilots',style:'padding:12px;overflow:auto;height:100%;box-sizing:border-box'},
    h('b',{text:'首轮整理结果 · 待核对'}),
    h('p',{text:'这里展示真实历史片段的候选工作和原文证据。人工对照样例已排除；这些候选尚未归并或确认为正式项目结论。'}),
    h('div',{class:'pr-toolbar'},select,h('button',{class:'btn',text:'刷新',onclick:()=>load()})),status,body);
  instance={root};
  wm.open({id:'research-pilots',title:'首轮整理结果 · 待核对',icon:icon('projects',true),width:900,height:680,content:root,
    onClose:()=>{closed=true;root.querySelectorAll('dialog').forEach(d=>d.close());instance=null;}});
  function refs(items){const pilot=selected;return h('div',{class:'pr-refs'},...(items||[]).map(ref=>h('details',{},h('summary',{text:'证据引用'}),h('blockquote',{text:ref.quote}),
    h('button',{class:'btn',text:'查看原文与前后文',onclick:()=>showEvidence(ref,pilot)}))));}
  async function showEvidence(ref,pilot){
    try{
      const r=await get('/api/research/pilot/evidence?id='+encodeURIComponent(pilot)+'&event='+encodeURIComponent(ref.event_id)+'&offset='+(ref.start||0));
      if(closed)return;if(!r.ok){status.textContent=r.msg;return;}
      const e=r.item,dialog=h('dialog',{class:'pr-evidence'});
      dialog.append(h('b',{text:e.machine+' · '+e.session}),h('p',{text:'原始记录位置 '+e.line+' · '+e.role+' · '+e.kind}),
        h('blockquote',{text:ref.quote}),h('pre',{text:e.text}),...(e.truncated?[h('p',{text:'当前显示引用附近的原文片段。'})]:[]),
        ...e.around.map(a=>h('details',{},h('summary',{text:'附近记录 '+a.line+' · '+a.role}),h('pre',{text:a.text}))),
        h('button',{class:'btn',text:'关闭',onclick:()=>dialog.close()}));
      dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();
    }catch{status.textContent='读取原文失败';}
  }
  function card(w){return h('article',{class:'pr-card'},h('b',{text:w.title}),h('small',{text:' · '+(states[w.state]||w.state)+' · 待核对'}),
    h('p',{text:w.objective}),refs(w.evidence),
    ...(w.runs||[]).map(r=>h('section',{},h('b',{text:'计算活动：'+r.description+' · '+(states[r.state]||r.state)}),
      r.command?h('pre',{text:r.command}):null,
      (r.code_ref?.branch||r.code_ref?.commit)?h('p',{text:'历史代码条件：'+[r.code_ref.branch,r.code_ref.commit].filter(Boolean).join(' · ')}):null,
      ...(r.metrics||[]).map(m=>h('p',{text:m.name+'：'+m.value_text+' '+m.unit})),refs(r.evidence))),
    ...(w.findings||[]).map(f=>h('section',{},h('p',{text:({reported:'资料报告',measurement:'工具输出',hypothesis:'假设'}[f.basis]||f.basis)+'：'+f.text}),refs(f.evidence))),
    w.support_activities?.length?h('details',{},h('summary',{text:'资料查阅 · '+w.support_activities.length}),...w.support_activities.map(a=>h('div',{},h('p',{text:a.description}),refs(a.evidence)))):null,
    w.open_questions?.length?h('p',{text:'未决问题：'+w.open_questions.join('；')}):null);}
  async function render(){
    if(!selected)return;
    const requested=selected;
    try{const r=await get('/api/research/pilot?id='+encodeURIComponent(requested));if(closed||selected!==requested)return;if(!r.ok){status.textContent=r.msg;return;}
      const p=r.item;status.textContent=`${p.model} · ${p.samples.length} 份真实片段 · ${p.count} 项候选工作 · ${new Date(p.at).toLocaleString()}`;
      body.replaceChildren(h('p',{text:'本轮范围：'+p.scope}),...(p.samples||[]).flatMap(s=>[
        h('h3',{text:'历史片段 · '+s.work.length+' 项候选'}),h('small',{text:s.name}),
        ...(s.work.length?s.work.map(card):[h('p',{text:'这个选定片段未提取到研究工作；不代表整份会话没有研究内容。'})])
      ]));
    }catch{if(!closed)status.textContent='读取整理结果失败';}
  }
  async function load(){try{const r=await get('/api/research/pilots');if(closed)return;if(!r.ok){status.textContent=r.msg;return;}
    select.replaceChildren(...r.items.map(p=>h('option',{value:p.id,text:new Date(p.at).toLocaleString()+' · '+p.count+' 项候选'})));
    selected=r.items.some(p=>p.id===selected)?selected:(r.items[0]?.id||'');select.value=selected;
    if(!selected){status.textContent=r.warnings?.join('；')||'NAS 还没有保存的试点结果';body.replaceChildren();return;}await render();
  }catch{if(!closed)status.textContent='无法读取 NAS 试点列表';}}
  select.addEventListener('change',()=>{selected=select.value;render();});load();
}
