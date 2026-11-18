import {h} from '../util.js';
import {post} from '../net.js';
import {open as openExplorer} from './explorer.js';

const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/+$/,'');
const canon=p=>/^[A-Za-z]:/.test(norm(p))?norm(p).toLowerCase():norm(p);
const isStrictChild=(child,parent)=>{const c=canon(child),p=canon(parent);return c!==p&&c.startsWith(p+'/');};
const shortName=(p,parentPath='')=>{
  const np=norm(p);
  if(parentPath&&isStrictChild(np,parentPath))return np.slice(norm(parentPath).length+1);
  return np;
};

export function directoryPanel(onChanged=()=>{}){
  const root=h('div',{class:'rd-root'});
  let project=null,closed=false,requestId=0,viewMode='graph',lastItems=[];
  const say=h('p',{class:'pm-status'});

  async function load(id){
    project=id;const request=++requestId;
    try{
      const r=await(await fetch('/api/research/directories?project='+encodeURIComponent(id))).json();
      if(closed||request!==requestId)return;
      if(!r.ok){root.replaceChildren(h('p',{text:r.msg}));return;}
      lastItems=r.items||[];
      render();
      return lastItems;
    }catch{if(!closed&&request===requestId)say.textContent='读取目录总结失败';return [];}
  }

  async function change(item,action,extra={}){
    const r=await post('/api/research/directory',{project:item.project,id:item.id,revision:item.revision,action,...extra});
    say.textContent=r.ok?'目录总结已保存':r.msg;
    if(r.ok){await load(project);onChanged();}
    return r.ok;
  }

  function openAddDialog(){
    if(!project)return;
    const knownMachines=[...new Set(['huatanshaonian','dell97','nas',...lastItems.map(x=>x.machine).filter(Boolean)])];
    const machInput=h('input',{class:'field',placeholder:'例如 huatanshaonian 或 dell97',value:knownMachines[0]||'huatanshaonian'});
    const pathInput=h('input',{class:'field',placeholder:'例如 G:/CEM/new_branch 或 /home/dell/CEM_1/new_worktree'});
    const branchInput=h('input',{class:'field',placeholder:'例如 master、mom_dev（可选，留空即可）'});
    const feedback=h('p',{class:'pm-status'});
    const machPills=h('div',{style:'display:flex;gap:6px;flex-wrap:wrap;margin-top:4px'},
      ...knownMachines.map(m=>h('button',{
        class:'btn',
        type:'button',
        style:'font-size:11px;padding:1px 6px',
        text:'🖥️ '+m,
        onclick:()=>{machInput.value=m;},
      }))
    );
    const submit=async()=>{
      const machine=machInput.value.trim(),dirPath=pathInput.value.trim(),branch=branchInput.value.trim();
      if(!machine||!dirPath){feedback.textContent='请填写电脑名称和文件夹路径';return;}
      const r=await post('/api/research/directory',{project,action:'add',machine,path:dirPath,branch});
      if(!r.ok){feedback.textContent=r.msg||'添加目录失败';return;}
      dlg.close();
      say.textContent=`已添加目录 ${machine}:${dirPath}`;
      await load(project);
      onChanged();
    };
    const form=h('div',{class:'pr-form'},
      h('label',{},'所在电脑（点击下方快捷标签或直接输入）',machInput,machPills),
      h('label',{},'文件夹路径',pathInput),
      h('label',{},'Git 分支（可选）',branchInput),
      feedback,
      h('div',{class:'pr-toolbar',style:'justify-content:flex-end;margin-top:8px'},
        h('button',{class:'btn go',type:'button',text:'＋ 确认添加',onclick:submit}),
        h('button',{class:'btn',type:'button',text:'取消',onclick:()=>dlg.close()})
      )
    );
    const dlg=h('dialog',{class:'pr-evidence rr-editor rd-add-dlg'},h('h3',{text:'＋ 手动添加项目文件夹目录'}),form);
    dlg.addEventListener('close',()=>dlg.remove());
    root.append(dlg);
    dlg.showModal();
  }

  function openDeleteDialog(item){
    const dlg=h('dialog',{class:'pr-evidence rd-del-dlg'},
      h('h3',{text:'删除项目目录'}),
      h('p',{text:`确定要从当前项目中移除目录「${item.machine} : ${norm(item.path)}」吗？`}),
      h('p',{class:'ghint',text:'说明：仅将该目录从本项目的归类与工作区列表中移除，不会删除电脑硬盘上的任何实际文件。'}),
      h('div',{class:'pr-toolbar',style:'justify-content:flex-end;margin-top:10px'},
        h('button',{class:'btn go',type:'button',text:'🗑️ 确认删除',onclick:async()=>{
          const r=await post('/api/research/directory',{project:item.project,id:item.id,machine:item.machine,path:item.path,action:'delete'});
          dlg.close();
          if(r.ok){
            say.textContent=`已从项目中移除目录 ${item.machine}:${norm(item.path)}`;
            await load(project);
            onChanged();
          }else{
            say.textContent=r.msg||'删除目录失败';
          }
        }}),
        h('button',{class:'btn',type:'button',text:'取消',onclick:()=>dlg.close()})
      )
    );
    dlg.addEventListener('close',()=>dlg.remove());
    root.append(dlg);
    dlg.showModal();
  }

  async function aiSummarize(item,btn){
    const origText=btn?btn.textContent:'🤖 AI 总结';
    let timer=null,pct=6;
    if(btn){
      btn.disabled=true;
      btn.classList.add('is-progress');
      btn.style.setProperty('--pct',pct+'%');
      btn.textContent=`🤖 总结中 (${pct}%)`;
      timer=setInterval(()=>{
        if(pct<92){
          pct=Math.min(92,Math.round(pct+Math.max(1,(92-pct)*0.08)));
          btn.style.setProperty('--pct',pct+'%');
          btn.textContent=`🤖 总结中 (${pct}%)`;
        }
      },350);
    }
    say.textContent=`正在调用 AI 总结 ${item.machine}:${item.path} 的会话工作…`;
    try{
      const r=await post('/api/research/directory/summarize',{project:item.project,id:item.id});
      clearInterval(timer);
      if(r.ok&&btn){
        btn.style.setProperty('--pct','100%');
        btn.textContent='✓ 总结完成 (100%)';
        await new Promise(res=>setTimeout(res,500));
      }
      say.textContent=r.ok?`已生成 ${item.machine}:${item.path} 的目录工作总结`:(r.msg||'AI 生成失败');
      if(r.ok){await load(project);onChanged();}
    }finally{
      clearInterval(timer);
      if(btn){
        btn.disabled=false;
        btn.classList.remove('is-progress');
        btn.style.removeProperty('--pct');
        btn.textContent=origText;
      }
    }
  }

  async function evidence(ref,item){
    const r=await(await fetch('/api/research/evidence?project='+encodeURIComponent(item.project)+'&id='+encodeURIComponent(ref.event_id))).json();
    if(closed)return;if(!r.ok){say.textContent=r.msg;return;}
    const e=r.item,d=h('dialog',{class:'pr-evidence'},
      h('b',{text:e.machine+' · '+e.cwd}),
      h('p',{text:'会话 '+e.session+' · 记录 '+e.line}),
      h('blockquote',{text:ref.quote}),
      h('pre',{text:e.text}),
      h('button',{class:'btn',text:'关闭',onclick:()=>d.close()})
    );
    d.addEventListener('close',()=>d.remove());root.append(d);d.showModal();
  }

  const lines=(title,values)=>values?.length?h('section',{},h('b',{text:title}),h('ul',{},...values.map(text=>h('li',{text})))):null;

  // Compute cross-directory & cross-machine relationships for an item
  function computeRelations(item,allItems,parentItem,childItems){
    const rels=[];
    if(parentItem){
      rels.push({kind:'parent',text:`⬆️ 隶属母工作区: ${norm(parentItem.path)}`,target:parentItem});
    }
    if(childItems&&childItems.length){
      rels.push({kind:'children',text:`🌿 下辖 ${childItems.length} 个子分支/目录: ${childItems.map(c=>shortName(c.path,item.path)+(c.branch?`[${c.branch}]`:'')).join('、')}`});
    }
    if(item.branch){
      const peers=allItems.filter(x=>x.id!==item.id&&x.branch&&x.branch.toLowerCase()===item.branch.toLowerCase());
      if(peers.length){
        rels.push({kind:'branch',text:`⇄ 同分支 (${item.branch}): ${peers.map(p=>`${p.machine}:${norm(p.path).split('/').pop()}`).join('、')}`,target:peers[0]});
      }
    }
    // Check cross-references in outputs / overview
    const myBase=norm(item.path).split('/').pop();
    if(myBase&&myBase.length>=4&&!/^(?:CEM_PO|CEM_1|CEM)$/i.test(myBase)){
      const refsMe=allItems.filter(x=>x.id!==item.id&&(!parentItem||x.id!==parentItem.id)&&x.body&&JSON.stringify(x.body).includes(myBase));
      if(refsMe.length){
        rels.push({kind:'ref',text:`🔗 被关联引用: ${refsMe.map(r=>`${r.machine}:${norm(r.path).split('/').pop()}`).slice(0,3).join('、')}`,target:refsMe[0]});
      }
    }
    return rels;
  }

  // Open full detail dialog when clicking a graph node
  function openDetail(item,allItems,parentItem,childItems){
    const b=item.body;
    const rels=computeRelations(item,allItems,parentItem,childItems);
    const totalChildSessions=(childItems||[]).reduce((s,c)=>s+(c.sessions||0),0);
    const dlg=h('dialog',{class:'pr-evidence rd-detail-dlg'},
      h('div',{class:'rd-detail-head'},
        h('div',{class:'rr-item-head'},
          h('b',{style:'font-size:14px',text:`🖥️ ${item.machine} : ${norm(item.path)}`}),
          item.branch?h('span',{class:'xtag',text:'🌿 分支: '+item.branch}):null,
          item.source?h('small',{class:'ghint',text:item.source}):null,
          h('span',{class:'rr-badge '+(item.status==='confirmed'?'confirmed':''),text:b?(item.status==='confirmed'?'已确认':'待核对'):'待整理'})
        ),
        h('div',{class:'rd-node-meta'},
          h('span',{text:`💬 本目录直接会话 ${item.sessions} 份 · 已归集资料 ${item.documents} 份`}),
          childItems&&childItems.length?h('span',{class:'rd-agg-pill',text:`📊 含下属 ${childItems.length} 个子目录共 ${item.sessions+totalChildSessions} 份会话`}):null
        ),
        rels.length?h('div',{class:'rd-rels'},...rels.map(r=>h('span',{class:'rd-rel-pill '+r.kind,text:r.text}))):null
      ),
      b?h('div',{class:'rd-summary'},
        h('section',{class:'rd-sec-box'},h('b',{text:'📌 目录定位与总览'}),h('p',{class:'rd-overview',text:b.overview})),
        h('b',{text:`🛠️ 工作主线（共 ${b.work.length} 条）`}),
        ...b.work.map(w=>h('section',{class:'rd-work'},
          h('h4',{text:'▸ '+w.title}),
          h('p',{text:w.description}),
          lines('✅ 结果与验证指标',w.results),
          lines('📦 产物与代码路径',w.outputs),
          lines('❓ 未决问题',w.questions),
          h('details',{},
            h('summary',{text:'查看原文证据引用 · '+w.evidence.length}),
            ...w.evidence.map(ref=>h('div',{},
              h('blockquote',{text:ref.quote}),
              h('button',{class:'btn',text:'查看原文上下文',onclick:()=>evidence(ref,item)})
            ))
          )
        )),
        lines('🚀 下一步计划',b.next_steps)
      ):h('p',{text:'该目录尚无工作总结。'}),
      h('div',{class:'pr-toolbar',style:'margin-top:10px;justify-content:flex-end'},
        h('button',{class:'btn',text:'在我的电脑打开目录',onclick:()=>openExplorer(item.machine,item.path)}),
        b&&item.status!=='confirmed'?h('button',{class:'btn go',text:'确认目录总结',onclick:async()=>{await change(item,'confirm');dlg.close();}}):null,
        b?h('button',{class:'btn',text:'修改目录总结',onclick:()=>{dlg.close();edit(item);}}):null,
        h('button',{class:'btn',text:b?'🤖 AI 重新总结':'🤖 AI 生成总结',onclick:async(e)=>{await aiSummarize(item,e.currentTarget);dlg.close();}}),
        h('button',{class:'btn',text:'🗑️ 删除目录',onclick:()=>{dlg.close();openDeleteDialog(item);}}),
        h('button',{class:'btn',text:'关闭',onclick:()=>dlg.close()})
      )
    );
    dlg.addEventListener('close',()=>dlg.remove());
    root.append(dlg);
    dlg.showModal();
  }

  // Render a compact graph node card (used in Graph Mode for both Hub roots and Child worktree nodes)
  function renderGraphNode(item,allItems,{parentItem=null,childItems=[]}={}){
    const b=item.body;
    const isHub=childItems.length>0;
    const totalChildSessions=childItems.reduce((s,c)=>s+(c.sessions||0),0);
    const rels=computeRelations(item,allItems,parentItem,childItems);
    const aiBtn=h('button',{class:'btn',text:b?'🤖 重总结':'🤖 AI 总结',onclick:(e)=>{e.stopPropagation();aiSummarize(item,aiBtn);}});
    const displayPath=parentItem?`↳ ${shortName(item.path,parentItem.path)}`:norm(item.path);

    return h('article',{
      class:`pr-card rd-card rd-node ${isHub?'rd-is-hub':''} ${parentItem?'rd-is-child':''}`,
      dataset:{id:item.id},
    },
      h('div',{class:'rr-item-head rd-node-head'},
        h('span',{class:'rd-role-icon',text:isHub?'🏛️ 母工作区':parentItem?'🌿 子工作树':'📁 独立工作区'}),
        h('code',{class:'rd-node-path',title:norm(item.path),text:displayPath}),
        item.branch?h('span',{class:'pm-ws-git rd-branch-pill',text:'Git: '+item.branch}):null,
        h('span',{class:'rd-sess-pill',text:isHub?`本目录 ${item.sessions} 份会话（全工作区共 ${item.sessions+totalChildSessions} 份）`:`${item.sessions} 份会话`}),
        h('span',{class:'rr-badge '+(item.status==='confirmed'?'confirmed':''),text:b?(item.status==='confirmed'?'已确认':'待核对'):'待整理'})
      ),
      b?h('p',{class:'rd-overview rd-overview-clamp',title:b.overview,onclick:()=>openDetail(item,allItems,parentItem,childItems),text:b.overview})
       :h('p',{class:'rd-overview rd-empty-hint',text:'目录工作总结待整理（点击下方 AI 总结生成）。'}),
      b&&b.work?.length?h('div',{class:'rd-work-pills'},
        ...b.work.map(w=>h('span',{
          class:'rd-work-pill',
          title:w.description,
          onclick:()=>openDetail(item,allItems,parentItem,childItems),
          text:`📌 ${w.title}`,
        }))
      ):null,
      rels.length?h('div',{class:'rd-rels'},
        ...rels.map(r=>h('span',{
          class:'rd-rel-pill '+r.kind,
          text:r.text,
          onclick:r.target?()=>{
            const el=root.querySelector(`.rd-card[data-id="${r.target.id}"]`);
            if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('rd-flash');setTimeout(()=>el.classList.remove('rd-flash'),1400);}
          }:undefined,
        }))
      ):null,
      h('div',{class:'pr-toolbar rd-node-actions'},
        b?h('button',{class:'btn go',text:`📖 查看详情 (${b.work.length}条主线)`,onclick:()=>openDetail(item,allItems,parentItem,childItems)}):null,
        b&&item.status!=='confirmed'?h('button',{class:'btn',text:'确认目录总结',onclick:()=>change(item,'confirm')}):null,
        b?h('button',{class:'btn',text:'修改目录总结',onclick:()=>edit(item)}):null,
        b&&item.status==='confirmed'?h('button',{class:'btn',text:'恢复待核对',onclick:()=>change(item,'restore')}):null,
        h('button',{class:'btn',text:'查看目录',onclick:()=>openExplorer(item.machine,item.path)}),
        aiBtn,
        h('button',{class:'btn',title:'从当前项目中移除此目录',text:'🗑️ 删除目录',onclick:(e)=>{e.stopPropagation();openDeleteDialog(item);}})
      )
    );
  }

  // Build hierarchical Graph View grouped by Machine -> Parent Workspace Hubs -> Child Worktrees
  function renderGraphView(items){
    const byMachine=new Map();
    for(const it of items){
      if(!byMachine.has(it.machine))byMachine.set(it.machine,[]);
      byMachine.get(it.machine).push(it);
    }

    const machineBoxes=[];
    for(const [mach,mItems] of byMachine.entries()){
      // Sort shortest path first so parent workspaces come before children
      const sorted=[...mItems].sort((a,b)=>norm(a.path).length-norm(b.path).length||norm(a.path).localeCompare(norm(b.path)));
      const parentOf=new Map(); // childId -> parentItem
      const childrenOf=new Map(); // parentId -> [childItem]
      for(const it of sorted)childrenOf.set(it.id,[]);

      for(let i=0;i<sorted.length;i++){
        const child=sorted[i];
        // Find deepest ancestor in sorted[0..i-1]
        let bestParent=null;
        for(let j=0;j<i;j++){
          const cand=sorted[j];
          if(isStrictChild(child.path,cand.path)){
            if(!bestParent||norm(cand.path).length>norm(bestParent.path).length)bestParent=cand;
          }
        }
        if(bestParent){
          parentOf.set(child.id,bestParent);
          childrenOf.get(bestParent.id).push(child);
        }
      }

      const topRoots=sorted.filter(it=>!parentOf.has(it.id));
      const totalMachSessions=mItems.reduce((s,x)=>s+(x.sessions||0),0);
      const branches=[...new Set(mItems.map(x=>x.branch).filter(Boolean))];

      const treeGroups=topRoots.map(rootItem=>{
        const kids=childrenOf.get(rootItem.id)||[];
        return h('div',{class:'rd-hub-group '+(kids.length?'has-children':'')},
          renderGraphNode(rootItem,items,{parentItem:null,childItems:kids}),
          kids.length?h('div',{class:'rd-children-tree'},
            ...kids.map(k=>h('div',{class:'rd-child-branch'},
              renderGraphNode(k,items,{parentItem:rootItem,childItems:childrenOf.get(k.id)||[]})
            ))
          ):null
        );
      });

      machineBoxes.push(h('section',{class:'rd-machine-cluster'},
        h('div',{class:'rd-machine-hd'},
          h('b',{text:`🖥️ 设备节点：${mach}`}),
          h('span',{class:'rd-mach-stat',text:`${mItems.length} 个目录/工作树 · 合计 ${totalMachSessions} 份会话`}),
          branches.length?h('span',{class:'rd-mach-branches',text:`涵盖分支: ${branches.join(' / ')}`}):null
        ),
        h('div',{class:'rd-machine-body'},...treeGroups)
      ));
    }

    return h('div',{class:'rd-graph-canvas'},...machineBoxes);
  }

  // Full list card for List Mode
  function renderListCard(item){
    const b=item.body;
    const aiBtn=h('button',{class:'btn',text:b?'🤖 AI 重新总结':'🤖 AI 生成总结',onclick:()=>aiSummarize(item,aiBtn)});
    return h('article',{class:'pr-card rd-card',dataset:{id:item.id}},
      h('div',{class:'rr-item-head'},
        h('b',{text:'🖥️ '+item.machine}),
        item.branch?h('span',{class:'xtag',text:'🌿 分支: '+item.branch}):null,
        item.source?h('small',{class:'ghint',text:item.source}):null,
        h('span',{class:'rr-badge '+(item.status==='confirmed'?'confirmed':''),text:b?(item.status==='confirmed'?'已确认':'待核对'):'待整理'})
      ),
      h('div',{class:'rr-directory'},
        h('code',{text:item.path}),
        h('button',{class:'btn',text:'查看目录',onclick:()=>openExplorer(item.machine,item.path)}),
        aiBtn,
        h('button',{class:'btn',text:'🗑️ 删除目录',onclick:()=>openDeleteDialog(item)})
      ),
      h('small',{text:item.sessions+' 份会话 · '+item.documents+' 份已归集资料'+(item.changed?' · 有新资料待更新':'')}),
      b?h('div',{class:'rd-summary'},h('p',{class:'rd-overview',text:b.overview}),
        ...b.work.map(w=>h('section',{class:'rd-work'},h('h4',{text:w.title}),h('p',{text:w.description}),lines('结果',w.results),lines('产物',w.outputs),lines('未决问题',w.questions),
          h('details',{},h('summary',{text:'查看依据 · '+w.evidence.length}),...w.evidence.map(ref=>h('div',{},h('blockquote',{text:ref.quote}),h('button',{class:'btn',text:'查看原文',onclick:()=>evidence(ref,item)})))))),
        lines('接下来',b.next_steps),
        h('div',{class:'pr-toolbar'},item.status!=='confirmed'?h('button',{class:'btn',text:'确认目录总结',onclick:()=>change(item,'confirm')}):null,
          h('button',{class:'btn',text:'修改目录总结',onclick:()=>edit(item)}),item.status==='confirmed'?h('button',{class:'btn',text:'恢复待核对',onclick:()=>change(item,'restore')}):null)):
        h('p',{text:'目录工作总结待整理（可点击上方「🤖 AI 生成总结」自动抽取）。'}));
  }

  function render(){
    const items=lastItems;
    const machCount=new Set(items.map(x=>x.machine)).size;
    const totalSess=items.reduce((s,x)=>s+(x.sessions||0),0);
    const bar=h('div',{class:'rd-view-bar'},
      h('span',{class:'rd-view-summary',text:`📊 跨机拓扑总览：${machCount} 台电脑 · ${items.length} 个目录/分支 · 累计 ${totalSess} 份对话（点击节点「查看详情」或摘要文字可展开完整结果与原文依据）`}),
      h('div',{class:'rd-view-btns'},
        h('button',{class:'btn go',type:'button',text:'＋ 添加目录',onclick:openAddDialog}),
        h('button',{class:'btn '+(viewMode==='graph'?'go':''),type:'button',text:'🕸️ 结构拓扑图',onclick:()=>{viewMode='graph';render();}}),
        h('button',{class:'btn '+(viewMode==='list'?'go':''),type:'button',text:'📋 展开详细列表',onclick:()=>{viewMode='list';render();}})
      )
    );
    root.replaceChildren(
      say,
      project?bar:null,
      viewMode==='graph'?renderGraphView(items):h('div',{},...items.map(renderListCard))
    );
  }

  function edit(item){
    const b=item.body,overview=h('textarea',{class:'field',rows:6}),next=h('textarea',{class:'field',rows:4}),feedback=h('p');
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

  return{root,load,openAddDialog,destroy(){closed=true;root.querySelectorAll('dialog').forEach(d=>d.close());}};
}
