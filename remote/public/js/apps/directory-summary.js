import {h} from '../util.js';
import {post} from '../net.js';
import {open as openExplorer} from './explorer.js';
export function directoryPanel(){
  const root=h('div',{class:'rd-root'});let project=null,closed=false,requestId=0;
  const say=h('p',{class:'pm-status'});
  async function load(id){project=id;const request=++requestId;
    try{const r=await(await fetch('/api/research/directories?project='+encodeURIComponent(id))).json();if(closed||request!==requestId)return;
      if(!r.ok){root.replaceChildren(h('p',{text:r.msg}));return;}
      root.replaceChildren(say,...r.items.map(card));
    }catch{if(!closed&&request===requestId)say.textContent='读取目录总结失败';}
  }
  async function change(item,action,extra={}){
    const r=await post('/api/research/directory',{project: item.project,id:item.id,revision:item.revision,action,...extra});
    say.textContent=r.ok?'目录总结已保存':r.msg;if(r.ok)await load(project);return r.ok;
  }
  async function evidence(ref,item){
    const r=await(await fetch('/api/research/evidence?project='+encodeURIComponent(item.project)+'&id='+encodeURIComponent(ref.event_id))).json();
    if(closed)return;if(!r.ok){say.textContent=r.msg;return;}
    const e=r.item,d=h('dialog',{class:'pr-evidence'},h('b',{text:e.machine+' · '+e.cwd}),h('p',{text:'会话 '+e.session+' · 记录 '+e.line}),h('blockquote',{text:ref.quote}),h('pre',{text:e.text}),h('button',{class:'btn',text:'关闭',onclick:()=>d.close()}));
    d.addEventListener('close',()=>d.remove());root.append(d);d.showModal();
  }
  const lines=(title,values)=>values?.length?h('section',{},h('b',{text:title}),h('ul',{},...values.map(text=>h('li',{text})))):null;
  function card(item){const b=item.body;
    return h('article',{class:'pr-card rd-card',dataset:{id:item.id}},
      h('div',{class:'rr-item-head'},h('b',{text:item.machine}),h('span',{class:'rr-badge',text:b?(item.status==='confirmed'?'已确认':'待核对'):'待整理'})),
      h('div',{class:'rr-directory'},h('code',{text:item.path}),h('button',{class:'btn',text:'查看目录',onclick:()=>openExplorer(item.machine,item.path)})),
      h('small',{text:item.sessions+' 份会话 · '+item.documents+' 份已归集资料'+(item.changed?' · 有新资料待更新':'')}),
      b?h('div',{class:'rd-summary'},h('p',{class:'rd-overview',text:b.overview}),
        ...b.work.map(w=>h('section',{class:'rd-work'},h('h4',{text:w.title}),h('p',{text:w.description}),lines('结果',w.results),lines('产物',w.outputs),lines('未决问题',w.questions),
          h('details',{},h('summary',{text:'查看依据 · '+w.evidence.length}),...w.evidence.map(ref=>h('div',{},h('blockquote',{text:ref.quote}),h('button',{class:'btn',text:'查看原文',onclick:()=>evidence(ref,item)})))))),
        lines('接下来',b.next_steps),
        h('div',{class:'pr-toolbar'},item.status!=='confirmed'?h('button',{class:'btn',text:'确认目录总结',onclick:()=>change(item,'confirm')}):null,
          h('button',{class:'btn',text:'修改目录总结',onclick:()=>edit(item)}),item.status==='confirmed'?h('button',{class:'btn',text:'恢复待核对',onclick:()=>change(item,'restore')}):null)):
        h('p',{text:'目录工作总结待整理。'}));
  }
  function edit(item){const b=item.body,overview=h('textarea',{class:'field',rows:6}),next=h('textarea',{class:'field',rows:4}),feedback=h('p');
    overview.value=b.overview;next.value=b.next_steps.join('\n');
    const sections=b.work.map(w=>{const description=h('textarea',{class:'field',rows:3}),results=h('textarea',{class:'field',rows:4}),outputs=h('textarea',{class:'field',rows:3}),questions=h('textarea',{class:'field',rows:3});
      description.value=w.description;results.value=w.results.join('\n');outputs.value=w.outputs.join('\n');questions.value=w.questions.join('\n');
      return{w,description,results,outputs,questions,root:h('fieldset',{},h('legend',{text:w.title}),h('label',{},'工作说明',description),h('label',{},'结果',results),h('label',{},'产物',outputs),h('label',{},'未决问题',questions))};});
    const form=h('div',{class:'pr-form'},h('label',{},'目录总览',overview),...sections.map(s=>s.root),h('label',{},'下一步',next),feedback),dialog=h('dialog',{class:'pr-evidence rr-editor rd-editor'},h('h3',{text:'修改目录工作总结'}),form);
    const split=t=>t.split('\n').map(s=>s.trim()).filter(Boolean);
    const save=async confirm=>{const ok=await change(item,'save',{confirm,body:{...b,overview:overview.value,next_steps:split(next.value),work:sections.map(s=>({...s.w,description:s.description.value,results:split(s.results.value),outputs:split(s.outputs.value),questions:split(s.questions.value)}))}});if(ok)dialog.close();else feedback.textContent=say.textContent;};
    form.append(h('div',{class:'pr-toolbar'},h('button',{class:'btn',text:'保存总结',onclick:()=>save(false)}),h('button',{class:'btn',text:'保存并确认',onclick:()=>save(true)}),h('button',{class:'btn',text:'取消',onclick:()=>dialog.close()})));
    dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();
  }
  return{root,load,destroy(){closed=true;root.querySelectorAll('dialog').forEach(d=>d.close());}};
}
