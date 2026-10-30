import {h} from '../util.js';
import * as net from '../net.js';
import { createReviewPanel } from './knowledge-review.js';
export function panel(){
  const root=h('div',{class:'aim knowledge'}),note=h('p',{class:'gnote'}),stats=h('p',{class:'ghint'});
  const tabs=h('div',{class:'capi-btns'}),content=h('div'),refresh=h('button',{class:'btn',text:'刷新',onclick:()=>load()});
  let data=null,dead=false,mode='memory',page=0,seq=0,reviewPanel=null;
  const selected=new Map();
  const selection=h('span',{class:'ghint',text:'已选 0 条'});
  const selectionChanged=()=>{selection.textContent='已选 '+selected.size+' 条';};
  const check=(key,ref)=>{const box=h('input',{type:'checkbox',checked:selected.has(key)});box.addEventListener('change',()=>{if(box.checked)selected.set(key,ref);else selected.delete(key);selectionChanged();});return box;};
  const say=(s,bad=false)=>{note.textContent=s;note.className='gnote'+(bad?' bad':'');};
  const get=async p=>{const r=await fetch('/api/knowledge'+p,{cache:'no-store'});if(!r.ok)throw Error('读取失败');const d=await r.json();if(d.ok===false)throw Error(d.msg||'读取失败');return d;};
  async function post(p,d){const r=await net.post('/api/knowledge/'+p,d);if(!r.ok){say(r.msg||'保存失败',true);return false;}await load();say('已保存到 NAS；在线电脑会同步，离线电脑重连后同步');return true;}
  const button=(text,onclick)=>h('button',{class:'btn',type:'button',text,onclick});
  async function showHistory(m){
    try{
      const d=await get('/history?id='+encodeURIComponent(m.id));
      const versions=d.items.map(x=>h('details',{},h('summary',{text:'v'+x.revision+' · '+new Date(x.updated).toLocaleString()}),
        h('pre',{text:x.body}),button('以此版本编辑',()=>editor({...m,body:x.body}))));
      content.replaceChildren(button('返回',draw),...versions);
    }catch(e){say(e.message,true);}
  }
  function editor(item={scope:'global',owner:'',name:'',body:'',enabled:1},source=null){
    const scope=h('select',{class:'field'},...['global','machine','project'].map((v,i)=>h('option',{value:v,text:['共享全局','指定机器','指定项目'][i]})));
    scope.value=item.scope;
    const owner=h('input',{class:'field',value:item.owner||'',placeholder:'机器名或项目 ID（共享全局留空）'});
    const name=h('input',{class:'field',value:item.name||'',placeholder:'记忆名称'}),body=h('textarea',{class:'field knowledge-body'});
    body.value=item.body||'';
    const enabled=h('input',{type:'checkbox',checked:!!item.enabled});
    const adopt=h('input',{type:'checkbox',checked:false});
    const form=h('form',{class:'knowledge-editor'},h('label',{},'范围',scope),h('label',{},'归属',owner),h('label',{},'名称',name),
      h('label',{},'正文',body),h('label',{},enabled,'启用并同步'),...(source?[h('label',{},adopt,'接管来源：备份原文后移入托管区块，后续以 NAS 为准（确认记忆发布快照不会改写）')]:[]),h('div',{class:'capi-btns'},h('button',{class:'btn',type:'submit',text:source?'导入并发布':'保存并发布'}),button('取消',draw)));
    form.addEventListener('submit',async e=>{e.preventDefault();const d={...item,scope:scope.value,owner:scope.value==='global'?'':owner.value.trim(),name:name.value.trim(),body:body.value,enabled:enabled.checked};
      if(source){delete d.id;delete d.revision;Object.assign(d,{machine:source.machine,path:source.path,sha256:source.sha256,adopt:adopt.checked});}
      await post(source?'promote':'save',d);});
    content.replaceChildren(form);
  }
  async function draw(){
    if(!data||dead)return;reviewPanel?.destroy();reviewPanel=null;content.replaceChildren();
    if(mode==='memory'){
      content.append(h('p',{class:'ghint',text:'共享全局 → 机器 → 项目按范围组合。来源先入库，选择范围后发布；本地文件已有的非托管内容会保留。'}),button('新增记忆',()=>editor()));
      const search=h('input',{class:'field',placeholder:'搜索名称、正文或归属'}),scope=h('select',{class:'field'},...['all','global','machine','project','disabled'].map((v,i)=>h('option',{value:v,text:['全部范围','共享全局','机器记忆','项目记忆','已停用'][i]})));
      const rows=h('div');content.append(h('div',{class:'knowledge-toolbar'},search,scope),rows);
      const filter=()=>{
        const q=search.value.trim().toLocaleLowerCase();
        const list=data.memories.filter(m=>(scope.value==='all'||(scope.value==='disabled'?!m.enabled:m.scope===scope.value))&&(!q||[m.name,m.body,m.owner,m.source].join(' ').toLocaleLowerCase().includes(q)));
        const cards=list.map(m=>{
          const actions=h('div',{class:'capi-btns'},button('编辑',()=>editor(m)),button(m.enabled?'停用':'启用',()=>post('save',{...m,enabled:!m.enabled})),button('修订历史',()=>showHistory(m)));
          if(m.source.startsWith('memory-review:'))actions.append(button('整理来源',()=>{mode='review';draw();reviewPanel?.show(m.source.slice(14));}));
          return h('div',{class:'knowledge-row knowledge-fact'},h('label',{},check('m:'+m.id,{kind:'memory',id:m.id}),h('b',{text:m.name})),
            h('small',{text:(m.scope==='global'?'共享全局':m.scope==='machine'?'机器：':'项目：')+(m.owner||'')+' · v'+m.revision+(m.enabled?'':' · 已停用')}),
            h('p',{class:'knowledge-preview',text:m.body.slice(0,180)+(m.body.length>180?'…':'')}),h('small',{text:'来源：'+m.source}),
            h('details',{},h('summary',{text:'展开全文'}),h('pre',{text:m.body})),actions);
        });
        rows.replaceChildren(h('small',{class:'ghint',text:list.length+' 条记忆'}),button('勾选当前列表',()=>{for(const m of list)selected.set('m:'+m.id,{kind:'memory',id:m.id});selectionChanged();filter();}),...cards);
      };search.addEventListener('input',filter);scope.addEventListener('change',filter);filter();
    }else if(mode==='sources'){
      content.append(h('p',{class:'ghint',text:'各电脑采集到的原始记忆。查看后选择发布范围，机器专属内容不会自动升级为共享全局。'}));
      for(const s of data.observed)content.append(h('div',{class:'knowledge-row'},h('label',{},check('s:'+JSON.stringify([s.machine,s.path]),{kind:'observed',machine:s.machine,path:s.path}),h('b',{text:s.machine+' · '+s.provider})),h('small',{text:s.path}),button('查看并导入',async()=>{
        try{const d=await get('/observed?'+new URLSearchParams({machine:s.machine,path:s.path}));if(d.item)editor({scope:s.scope,owner:s.owner,name:s.path.split(/[\\/]/).pop(),body:d.item.body,enabled:1},s);}catch(e){say(e.message,true);}
      })));
    }else if(mode==='review'){
      reviewPanel=createReviewPanel({refs:()=>[...selected.values()],get,notify:say,applied:()=>load()});content.append(reviewPanel.root);
    }else if(mode==='projects'){
      content.append(h('p',{class:'ghint',text:'同一项目 ID 关联不同电脑的本地目录。项目记忆保存在 NAS，只下发到对应电脑已允许访问的项目。'}));
      const id=h('input',{class:'field',placeholder:'项目 ID，例如 ametyping'}),name=h('input',{class:'field',placeholder:'项目名称'}),machine=h('input',{class:'field',placeholder:'机器名'}),path=h('input',{class:'field',placeholder:'该电脑上的绝对路径'});
      const form=h('form',{class:'knowledge-editor'},id,name,machine,path,h('button',{class:'btn',type:'submit',text:'保存路径映射'}));
      form.addEventListener('submit',e=>{e.preventDefault();post('project',{id:id.value.trim(),name:name.value.trim(),paths:[{machine:machine.value.trim(),path:path.value.trim()}]});});content.append(form);
      for(const p of data.projects)content.append(h('div',{class:'knowledge-row'},h('b',{text:p.name+' · '+p.id}),h('small',{text:(p.machine||'')+' '+(p.path||'')}),...(p.machine?[button('移除此机器映射',()=>post('project',{id:p.id,name:p.name,paths:[{machine:p.machine,remove:true}]}))]:[])));
    }else if(mode==='sync'){
      for(const m of data.machines)content.append(h('div',{class:'knowledge-row'},h('b',{text:m.name+(m.online?' · 在线':' · 离线')}),h('small',{text:'完整采集：'+(m.archive?'已接入':'待更新 agent')+'；记忆下发：'+(m.memory?'已接入':'未开放')}),button('同步记忆',()=>post('sync',{machine:m.name})),button('预览组合',async()=>{
        try{const d=await get('/preview?machine='+encodeURIComponent(m.name));content.replaceChildren(button('返回',draw),...d.targets.map(t=>h('div',{},h('h3',{text:t.target}),h('pre',{text:t.items.map(x=>'## '+x.name+'\n'+x.body).join('\n\n')}))));}catch(e){say(e.message,true);}
      })));
      for(const x of data.deployments)content.append(h('p',{class:'ghint'+(x.status==='conflict'?' bad':''),text:x.machine+' / '+x.target+'：'+(x.status==='applied'?'已同步':'冲突或未写入')+(x.detail?' · '+x.detail:'')}));
    }else{
      const version=++seq;
      try{const d=await get('/sources?limit=100&offset='+page*100);if(dead||version!==seq||mode!=='archive')return;
        content.append(h('p',{class:'ghint',text:'原生会话按字节保存，包含源记录中的工具输出、压缩内容和子会话。已校验表示该版本完整接收；外部附件和项目文件不由会话记录自动携带。'}));
        for(const s of d.items){
          const links=h('div',{class:'capi-btns'},h('a',{class:'btn',text:'下载原始记录',href:'/api/knowledge/raw?'+new URLSearchParams({machine:s.machine,key:s.key,generation:s.generation})}));
          links.append(button('文件版本',async()=>{try{const versions=await get('/versions?'+new URLSearchParams({machine:s.machine,key:s.key}));content.replaceChildren(button('返回',draw),...versions.items.map(v=>h('div',{class:'knowledge-row'},h('small',{text:new Date(v.created).toLocaleString()+' · '+v.bytes+' 字节 · '+(v.complete?'已校验':'未完成')}),h('a',{class:'btn',text:'下载此版本',href:'/api/knowledge/raw?'+new URLSearchParams({machine:v.machine,key:v.key,generation:v.generation})}))));}catch(e){say(e.message,true);}}));
          if(s.complete&&s.kind==='native'&&s.provider!=='opencode'&&s.cwd)links.append(h('a',{class:'btn',text:'导出 OpenCode 接力会话',href:'/api/knowledge/opencode?'+new URLSearchParams({machine:s.machine,key:s.key,generation:s.generation})}));
          content.append(h('div',{class:'knowledge-row'},h('b',{text:s.machine+' · '+s.provider+' · '+s.session}),h('small',{text:s.path}),h('small',{text:s.kind+' · '+s.bytes+' / '+s.size+' 字节 · '+(s.complete?'整文件 SHA-256 已校验':'同步中')+(s.parent?' · 父会话 '+s.parent:'')}),links));
        }
        content.append(h('div',{class:'capi-btns'},button('上一页',()=>{page=Math.max(0,page-1);draw();}),h('span',{text:'第 '+(page+1)+' 页'}),button('下一页',()=>{if(d.items.length===100){page++;draw();}})));
      }catch(e){say(e.message,true);}
    }
  }
  async function load(){try{const d=await get('');if(dead)return;data=d;stats.textContent='NAS SQLite：'+d.stats.versions+' 个会话文件版本，'+(d.stats.bytes/1048576).toFixed(1)+' MB；'+d.memories.length+' 条统一记忆。';await draw();}catch(e){say(e.message,true);}}
  for(const [id,title]of [['memory','统一记忆'],['sources','记忆来源'],['review','对齐与智能整理'],['projects','项目目录'],['sync','同步状态'],['archive','完整会话']])tabs.append(button(title,()=>{mode=id;seq++;draw();}));
  root.append(tabs,h('div',{class:'knowledge-toolbar'},refresh,selection,button('对齐所选',()=>{mode='review';draw();}),button('清空选择',()=>{selected.clear();selectionChanged();draw();})),note,stats,content);load();return{root,destroy(){dead=true;seq++;reviewPanel?.destroy();}};
}
