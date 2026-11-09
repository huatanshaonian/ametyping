import {h, icon} from '../util.js';
import * as net from '../net.js';
import * as wm from '../wm.js';
import { createReviewPanel } from './knowledge-review.js';

const ICON = icon('memory', true);
let app = null;

export function open(tab) {
  if (app) { wm.open({ id: 'knowledge' }); if (tab) app.show(tab); return; }
  app = panel(tab);
  wm.open({ id: 'knowledge', title: '记忆与存档', icon: ICON, content: app.root, width: 960, height: 680, onClose: () => { app.destroy(); app = null; } });
}

const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : (b || 0) + ' B';

export function panel(initialMode='memory'){
  const root=h('div',{class:'aim knowledge'}),note=h('p',{class:'gnote'}),stats=h('p',{class:'ghint knowledge-stats-line'});
  const kpiBar=h('div',{class:'knowledge-kpis'});
  const tabs=h('div',{class:'capi-btns knowledge-tabs'}),content=h('div',{class:'knowledge-body-wrap'}),refresh=h('button',{class:'btn',text:'刷新',onclick:()=>load()});
  let data=null,dead=false,mode=initialMode||'memory',page=0,seq=0,reviewPanel=null,scopeFilter='all';
  const selected=new Map();
  const selection=h('span',{class:'knowledge-sel-pill',text:'已选 0 条'});
  const selectionChanged=()=>{
    selection.textContent='已选 '+selected.size+' 条';
    selection.classList.toggle('has-sel',selected.size>0);
  };
  const check=(key,ref)=>{
    const box=h('input',{type:'checkbox',checked:selected.has(key)});
    box.addEventListener('change',()=>{if(box.checked)selected.set(key,ref);else selected.delete(key);selectionChanged();});
    return box;
  };
  const say=(s,bad=false)=>{note.textContent=s;note.className='gnote'+(bad?' bad':'');};
  const get=async p=>{const r=await fetch('/api/knowledge'+p,{cache:'no-store'});if(!r.ok)throw Error('读取失败');const d=await r.json();if(d.ok===false)throw Error(d.msg||'读取失败');return d;};
  async function post(p,d){const r=await net.post('/api/knowledge/'+p,d);if(!r.ok){say(r.msg||'保存失败',true);return false;}await load();say('已保存到 NAS；在线电脑会同步，离线电脑重连后同步');return true;}
  const button=(text,onclick,cls='')=>h('button',{class:'btn'+(cls?' '+cls:''),type:'button',text,onclick});

  function renderKpis(){
    if(!data)return;
    const enabled=data.memories.filter(m=>m.enabled);
    const globals=enabled.filter(m=>m.scope==='global');
    const machines=enabled.filter(m=>m.scope==='machine');
    const projects=enabled.filter(m=>m.scope==='project');
    const machineOwners=new Set(machines.map(m=>m.owner).filter(Boolean));
    const projectOwners=new Set(projects.map(m=>m.owner).filter(Boolean));
    const jumpScope=s=>{scopeFilter=s;show('memory');};
    kpiBar.replaceChildren(
      h('div',{class:'knowledge-kpi scope-global',onclick:()=>jumpScope('global')},
        h('span',{class:'knowledge-kpi-label',text:'🌐 共享全局记忆'}),
        h('strong',{text:globals.length+' 条'}),
        h('small',{text:'全网在线机器自动同步下发'})),
      h('div',{class:'knowledge-kpi scope-machine',onclick:()=>jumpScope('machine')},
        h('span',{class:'knowledge-kpi-label',text:'💻 机器专属记忆'}),
        h('strong',{text:machines.length+' 条'}),
        h('small',{text:'覆盖 '+machineOwners.size+' 台指定机器环境'})),
      h('div',{class:'knowledge-kpi scope-project',onclick:()=>jumpScope('project')},
        h('span',{class:'knowledge-kpi-label',text:'📁 项目专属记忆'}),
        h('strong',{text:projects.length+' 条'}),
        h('small',{text:'关联 '+ Math.max(projectOwners.size,new Set(data.projects.map(p=>p.id)).size) +' 个映射项目'})),
      h('div',{class:'knowledge-kpi scope-sources',onclick:()=>{if(data.pendingReviews&&data.latestReadyReviewId){show('review');reviewPanel?.show(data.latestReadyReviewId);}else show(data.pendingReviews?'review':'sources');}},
        h('span',{class:'knowledge-kpi-label',text:data.pendingReviews?'⚠️ 待人工裁决方案':'📥 待审阅采集来源'}),
        h('strong',{text:data.pendingReviews?(data.pendingReviews+' 份待裁决'):((data.pendingSources??data.observed.length)+' 份新增')}),
        h('small',{text:data.pendingReviews?'点击直接修改、确认或丢弃':'共 '+data.observed.length+' 份来源 · 每 5 分钟采集'})),
      h('div',{class:'knowledge-kpi scope-archive',onclick:()=>show('archive')},
        h('span',{class:'knowledge-kpi-label',text:'🗄️ 原生会话存档'}),
        h('strong',{text:data.stats.versions+' 个版本'}),
        h('small',{text:'NAS SQLite · '+(data.stats.bytes/1048576).toFixed(1)+' MB'}))
    );
  }

  async function showHistory(m){
    try{
      const d=await get('/history?id='+encodeURIComponent(m.id));
      const versions=d.items.map(x=>h('details',{class:'knowledge-version-item'},h('summary',{text:'v'+x.revision+' · '+new Date(x.updated).toLocaleString()}),
        h('pre',{text:x.body}),button('以此版本编辑',()=>editor({...m,body:x.body}))));
      content.replaceChildren(h('div',{class:'knowledge-toolbar'},button('返回',draw),h('b',{text:'修订历史：'+m.name})),...versions);
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
    const form=h('form',{class:'knowledge-editor knowledge-card'},
      h('h3',{class:'knowledge-section-title',text:source?'导入来源并发布记忆':(item.id?'编辑记忆：'+item.name:'新增统一记忆')}),
      h('div',{class:'knowledge-editor-grid'},
        h('label',{},h('span',{class:'knowledge-field-lbl',text:'作用域范围'}),scope),
        h('label',{},h('span',{class:'knowledge-field-lbl',text:'归属机器/项目'}),owner),
        h('label',{class:'knowledge-span-2'},h('span',{class:'knowledge-field-lbl',text:'记忆名称'}),name)
      ),
      h('label',{class:'knowledge-editor-body-lbl'},h('span',{class:'knowledge-field-lbl',text:'记忆正文 (Markdown)'}),body),
      h('label',{class:'knowledge-check-lbl'},enabled,'启用并自动下发同步'),
      ...(source?[h('label',{class:'knowledge-check-lbl'},adopt,'接管来源：备份原文后移入托管区块，后续以 NAS 为准（确认记忆发布快照不会改写）')]:[]),
      h('div',{class:'capi-btns'},h('button',{class:'btn go',type:'submit',text:source?'导入并发布':'保存并发布'}),button('取消',draw)));
    form.addEventListener('submit',async e=>{e.preventDefault();const d={...item,scope:scope.value,owner:scope.value==='global'?'':owner.value.trim(),name:name.value.trim(),body:body.value,enabled:enabled.checked};
      if(source){delete d.id;delete d.revision;Object.assign(d,{machine:source.machine,path:source.path,sha256:source.sha256,adopt:adopt.checked});}
      await post(source?'promote':'save',d);});
    content.replaceChildren(form);
  }

  function renderMemoryCard(m){
    const actions=h('div',{class:'capi-btns knowledge-card-actions'},
      button('编辑',()=>editor(m)),
      button(m.enabled?'停用':'启用',()=>post('save',{...m,enabled:!m.enabled})),
      button('修订历史',()=>showHistory(m)));
    if(m.source.startsWith('memory-review:'))actions.append(button('整理来源',()=>{show('review');reviewPanel?.show(m.source.slice(14));}));
    const scopeText=(m.scope==='global'?'共享全局':m.scope==='machine'?'机器：':'项目：')+(m.owner||'')+' · v'+m.revision+(m.enabled?'':' · 已停用');
    const scopeCls=m.enabled?'scope-'+m.scope:'scope-disabled';
    return h('div',{class:'knowledge-row knowledge-fact '+scopeCls},
      h('div',{class:'knowledge-card-head'},
        h('label',{class:'knowledge-card-title'},check('m:'+m.id,{kind:'memory',id:m.id}),h('b',{text:m.name})),
        h('div',{class:'knowledge-badges'},
          h('small',{class:'knowledge-badge '+scopeCls,text:scopeText}),
          h('small',{class:'knowledge-badge source-badge',text:'来源：'+m.source})
        )
      ),
      h('p',{class:'knowledge-preview',text:m.body.slice(0,200)+(m.body.length>200?'…':'')}),
      h('details',{class:'knowledge-details'},h('summary',{text:'展开全文 ('+m.body.length+' 字)'}),h('pre',{text:m.body})),
      actions);
  }

  async function draw(){
    if(!data||dead)return;reviewPanel?.destroy();reviewPanel=null;content.replaceChildren();
    if(mode==='memory'){
      const search=h('input',{class:'field',placeholder:'搜索名称、正文或归属'});
      const scope=h('select',{class:'field', style:'max-width:150px'},...['all','global','machine','project','disabled'].map((v,i)=>h('option',{value:v,text:['全部范围','共享全局','机器记忆','项目记忆','已停用'][i]})));
      scope.value=scopeFilter;
      const countBadge=h('small',{class:'ghint'});
      const selectAllBtn=button('勾选当前列表',()=>{});
      const topBar=h('div',{class:'knowledge-toolbar knowledge-filter-bar'},
        search,scope,countBadge,selectAllBtn,button('新增记忆',()=>editor(),'go'));
      const groupsWrap=h('div',{class:'knowledge-groups'});
      content.append(
        ...(data.pendingReviews?[h('div',{class:'knowledge-banner',style:'border-left-color:#c97a10;background:#fff8eb'},
          h('span',{text:`⚠️ 当前有 ${data.pendingReviews} 份待人工确认方案（含冲突裁决或月度体检建议），点击可直接添加手动修改、勾选确认或丢弃。`}),
          button('前往裁决与修改',()=>{show('review');if(data.latestReadyReviewId)reviewPanel?.show(data.latestReadyReviewId);},'go'))]:[]),
        h('div',{class:'knowledge-banner'},
          h('span',{text:'💡 记忆按「共享全局 → 机器专属 → 项目专属」三级作用域分层下发。随每日日报自动增量审阅（无争议入库、冲突待裁决），随每月月报自动运行全量记忆体检（100% 人工确认）。'})),
        topBar,groupsWrap);

      const filter=()=>{
        scopeFilter=scope.value;
        const q=search.value.trim().toLocaleLowerCase();
        const list=data.memories.filter(m=>(scope.value==='all'?true:(scope.value==='disabled'?!m.enabled:(m.enabled&&m.scope===scope.value)))&&(!q||[m.name,m.body,m.owner,m.source].join(' ').toLocaleLowerCase().includes(q)));
        countBadge.textContent=list.length+' 条记忆';
        selectAllBtn.onclick=()=>{for(const m of list)selected.set('m:'+m.id,{kind:'memory',id:m.id});selectionChanged();filter();};

        const sections=[];
        const buildGroup=(cls,iconStr,title,desc,items,subGroupFn=null)=>{
          if(!items.length)return;
          const groupBody=h('div',{class:'knowledge-group-body'});
          if(subGroupFn){
            const map=new Map();
            for(const item of items){
              const k=subGroupFn(item)||'未指定';
              if(!map.has(k))map.set(k,[]);
              map.get(k).push(item);
            }
            for(const [subKey,subItems] of map){
              const subHeader=h('div',{class:'knowledge-subgroup-head'},
                h('b',{text:subKey}),
                h('small',{class:'ghint',text:subItems.length+' 条'}),
                button('勾选 '+subKey,()=>{for(const m of subItems)selected.set('m:'+m.id,{kind:'memory',id:m.id});selectionChanged();filter();}));
              const subGrid=h('div',{class:'knowledge-card-grid'},...subItems.map(renderMemoryCard));
              groupBody.append(h('div',{class:'knowledge-subgroup'},subHeader,subGrid));
            }
          }else{
            groupBody.append(h('div',{class:'knowledge-card-grid'},...items.map(renderMemoryCard)));
          }
          sections.push(h('section',{class:'knowledge-group '+cls},
            h('div',{class:'knowledge-group-head'},
              h('div',{class:'knowledge-group-title'},
                h('span',{class:'knowledge-group-icon',text:iconStr}),
                h('h3',{text:title}),
                h('span',{class:'knowledge-count-pill',text:items.length+' 条'}),
                h('small',{class:'ghint',text:desc})
              ),
              h('div',{class:'capi-btns'},
                button('勾选本组',()=>{for(const m of items)selected.set('m:'+m.id,{kind:'memory',id:m.id});selectionChanged();filter();}),
                button('整理本组',()=>{for(const m of items)selected.set('m:'+m.id,{kind:'memory',id:m.id});selectionChanged();show('review');})
              )
            ),
            groupBody));
        };

        const enabledList=list.filter(m=>m.enabled);
        const disabledList=list.filter(m=>!m.enabled);
        buildGroup('scope-global','🌐','共享全局记忆','跨机器通用研发规范与协作偏好，自动下发至所有在线电脑',enabledList.filter(m=>m.scope==='global'));
        buildGroup('scope-machine','💻','机器专属记忆','绑定特定电脑的本地路径、硬件与环境说明，仅下发至对应机器',enabledList.filter(m=>m.scope==='machine'),m=>'机器：'+(m.owner||'未指定'));
        buildGroup('scope-project','📁','项目专属记忆','随项目目录映射下发至对应工作区',enabledList.filter(m=>m.scope==='project'),m=>'项目：'+(m.owner||'未指定'));
        if(disabledList.length)buildGroup('scope-disabled','⏸','已停用记忆','保留历史但不参与下发同步',disabledList);
        if(!sections.length)sections.push(h('p',{class:'ghint',text:'当前筛选条件下没有匹配的记忆条目。'}));
        groupsWrap.replaceChildren(...sections);
      };
      search.addEventListener('input',filter);scope.addEventListener('change',filter);filter();
    }else if(mode==='sources'){
      const byMachine=new Map();
      for(const s of data.observed){
        if(!byMachine.has(s.machine))byMachine.set(s.machine,[]);
        byMachine.get(s.machine).push(s);
      }
      content.append(h('div',{class:'knowledge-banner'},
        h('span',{text:'📥 各电脑 Agent 每 5 分钟自动扫描并增量上报本地记忆文件。每日随日报自动审阅新增来源（无争议直接入库，矛盾项留待裁决）。'}),
        h('div',{class:'capi-btns'},
          button('增量自动审阅新来源',async()=>{
            say('正在增量审阅新采集的记忆来源…');
            const r=await net.post('/api/knowledge/review/auto',{});
            if(!r.ok){say(r.msg||'自动审阅失败',true);return;}
            await load();
            if(r.item?.skipped)say('没有新增或变更的待审阅来源（0 Token 消耗）');
            else say(`自动审阅完成：已直接入库 ${r.item.autoApplied||0} 条无争议记忆，${r.item.pendingManual||0} 组矛盾/争议待人工裁决`);
            if(r.item?.pendingManual>0)show('review');
          },'go'),
          button('勾选全部来源并智能整理',()=>{
            for(const s of data.observed)selected.set('s:'+JSON.stringify([s.machine,s.path]),{kind:'observed',machine:s.machine,path:s.path});
            selectionChanged();show('review');
          }))));
      const groupsWrap=h('div',{class:'knowledge-groups'});
      for(const [mach,items] of byMachine){
        const mInfo=data.machines.find(x=>x.name===mach);
        const cards=items.map(s=>h('div',{class:'knowledge-row knowledge-source-card'},
          h('div',{class:'knowledge-card-head'},
            h('label',{class:'knowledge-card-title'},
              check('s:'+JSON.stringify([s.machine,s.path]),{kind:'observed',machine:s.machine,path:s.path}),
              h('b',{text:s.machine+' · '+s.provider})
            ),
            h('div',{class:'knowledge-badges'},
              h('small',{class:'knowledge-badge scope-'+(s.scope||'machine'),text:s.scope==='global'?'全局候选':s.scope==='project'?'项目候选':'机器候选'}),
              s.updated?h('small',{class:'knowledge-badge source-badge',text:new Date(s.updated).toLocaleDateString()}):null
            )
          ),
          h('small',{class:'knowledge-path',text:s.path}),
          h('div',{class:'capi-btns'},button('查看并导入',async()=>{
            try{const d=await get('/observed?'+new URLSearchParams({machine:s.machine,path:s.path}));if(d.item)editor({scope:s.scope,owner:s.owner,name:s.path.split(/[\\/]/).pop(),body:d.item.body,enabled:1},s);}catch(e){say(e.message,true);}
          }))));
        groupsWrap.append(h('section',{class:'knowledge-group scope-machine'},
          h('div',{class:'knowledge-group-head'},
            h('div',{class:'knowledge-group-title'},
              h('span',{class:'knowledge-group-icon',text:'🖥️'}),
              h('h3',{text:mach}),
              h('span',{class:'knowledge-count-pill'+(mInfo?.online?' online':''),text:mInfo?.online?'在线':'离线'}),
              h('small',{class:'ghint',text:items.length+' 份采集文件'})
            ),
            h('div',{class:'capi-btns'},
              button('勾选该机器来源',()=>{for(const s of items)selected.set('s:'+JSON.stringify([s.machine,s.path]),{kind:'observed',machine:s.machine,path:s.path});selectionChanged();draw();}),
              button('整理该机器来源',()=>{for(const s of items)selected.set('s:'+JSON.stringify([s.machine,s.path]),{kind:'observed',machine:s.machine,path:s.path});selectionChanged();show('review');})
            )
          ),
          h('div',{class:'knowledge-group-body'},h('div',{class:'knowledge-card-grid'},...cards))));
      }
      content.append(groupsWrap);
    }else if(mode==='review'){
      reviewPanel=createReviewPanel({refs:()=>[...selected.values()],get,notify:say,applied:()=>load(),initialReviewId:data.latestReadyReviewId||null});content.append(reviewPanel.root);
    }else if(mode==='projects'){
      content.append(h('div',{class:'knowledge-banner'},h('span',{text:'📁 同一项目 ID 关联不同电脑上的本地工作区目录。项目专属记忆保存在 NAS，仅下发到映射过的电脑与路径。'})));
      const id=h('input',{class:'field',placeholder:'项目 ID，例如 ametyping'}),name=h('input',{class:'field',placeholder:'项目名称'}),machine=h('input',{class:'field',placeholder:'机器名'}),path=h('input',{class:'field',placeholder:'该电脑上的绝对路径'});
      const form=h('form',{class:'knowledge-editor knowledge-card'},
        h('h3',{class:'knowledge-section-title',text:'新增或更新项目目录映射'}),
        h('div',{class:'knowledge-editor-grid'},id,name,machine,path),
        h('div',{class:'capi-btns'},h('button',{class:'btn go',type:'submit',text:'保存路径映射'})));
      form.addEventListener('submit',e=>{e.preventDefault();post('project',{id:id.value.trim(),name:name.value.trim(),paths:[{machine:machine.value.trim(),path:path.value.trim()}]});});
      const listWrap=h('div',{class:'knowledge-card-grid'});
      for(const p of data.projects){
        listWrap.append(h('div',{class:'knowledge-row knowledge-fact scope-project'},
          h('div',{class:'knowledge-card-head'},
            h('b',{text:p.name+' · '+p.id}),
            p.machine?h('small',{class:'knowledge-badge scope-machine',text:p.machine}):null
          ),
          h('small',{class:'knowledge-path',text:(p.machine||'')+' '+(p.path||'')}),
          ...(p.machine?[h('div',{class:'capi-btns'},button('移除此机器映射',()=>post('project',{id:p.id,name:p.name,paths:[{machine:p.machine,remove:true}]})))]:[])));
      }
      content.append(form,listWrap);
    }else if(mode==='sync'){
      content.append(h('div',{class:'knowledge-banner'},h('span',{text:'🔄 记忆库发生变更时，NAS 实时推送到所有在线电脑并写入工具受管区块；离线电脑重连后自动补齐，本地每 5 分钟巡检一次。'})));
      const grid=h('div',{class:'knowledge-card-grid'});
      for(const m of data.machines){
        const deps=data.deployments.filter(x=>x.machine===m.name);
        const depRows=deps.map(x=>h('p',{class:'ghint knowledge-dep-row'+(x.status==='conflict'?' bad':''),
          text:x.machine+' / '+x.target+'：'+(x.status==='applied'?'已同步':'冲突或未写入')+(x.detail?' · '+x.detail:'')}));
        grid.append(h('div',{class:'knowledge-row knowledge-machine-card '+(m.online?'is-online':'is-offline')},
          h('div',{class:'knowledge-card-head'},
            h('b',{text:m.name+(m.online?' · 在线':' · 离线')}),
            h('div',{class:'knowledge-badges'},
              h('small',{class:'knowledge-badge '+(m.archive?'scope-global':'scope-disabled'),text:'完整采集：'+(m.archive?'已接入':'待更新 agent')}),
              h('small',{class:'knowledge-badge '+(m.memory?'scope-machine':'scope-disabled'),text:'记忆下发：'+(m.memory?'已接入':'未开放')})
            )
          ),
          h('div',{class:'capi-btns'},
            button('同步记忆',()=>post('sync',{machine:m.name}),'go'),
            button('预览组合',async()=>{
              try{const d=await get('/preview?machine='+encodeURIComponent(m.name));content.replaceChildren(button('返回',draw),...d.targets.map(t=>h('div',{class:'knowledge-card'},h('h3',{text:t.target}),h('pre',{text:t.items.map(x=>'## '+x.name+'\n'+x.body).join('\n\n')}))));}catch(e){say(e.message,true);}
            })),
          ...(depRows.length?[h('div',{class:'knowledge-dep-list'},...depRows)]:[h('small',{class:'ghint',text:'暂无下发记录'})])
        ));
      }
      content.append(grid);
    }else{
      const version=++seq;
      try{const d=await get('/sources?limit=100&offset='+page*100);if(dead||version!==seq||mode!=='archive')return;
        content.append(h('div',{class:'knowledge-banner'},
          h('span',{text:'原生会话按字节保存，包含源记录中的工具输出、压缩内容和子会话。已校验表示该版本完整接收；外部附件和项目文件不由会话记录自动携带。'})));
        const grid=h('div',{class:'knowledge-card-grid'});
        for(const s of d.items){
          const links=h('div',{class:'capi-btns'},h('a',{class:'btn',text:'下载原始记录',href:'/api/knowledge/raw?'+new URLSearchParams({machine:s.machine,key:s.key,generation:s.generation})}));
          links.append(button('文件版本',async()=>{try{const versions=await get('/versions?'+new URLSearchParams({machine:s.machine,key:s.key}));content.replaceChildren(button('返回',draw),...versions.items.map(v=>h('div',{class:'knowledge-row knowledge-card'},h('small',{text:new Date(v.created).toLocaleString()+' · '+v.bytes+' 字节 · '+(v.complete?'已校验':'未完成')}),h('a',{class:'btn',text:'下载此版本',href:'/api/knowledge/raw?'+new URLSearchParams({machine:v.machine,key:v.key,generation:v.generation})}))));}catch(e){say(e.message,true);}}));
          if(s.complete&&s.kind==='native'&&s.provider!=='opencode'&&s.cwd)links.append(h('a',{class:'btn',text:'导出 OpenCode 接力会话',href:'/api/knowledge/opencode?'+new URLSearchParams({machine:s.machine,key:s.key,generation:s.generation})}));
          grid.append(h('div',{class:'knowledge-row knowledge-archive-card'},
            h('div',{class:'knowledge-card-head'},
              h('b',{text:s.machine+' · '+s.provider+' · '+s.session}),
              h('div',{class:'knowledge-badges'},
                h('small',{class:'knowledge-badge '+(s.kind==='native'?'scope-global':'scope-project'),text:s.kind}),
                h('small',{class:'knowledge-badge '+(s.complete?'scope-machine':'scope-disabled'),text:s.complete?'SHA-256 已校验':'同步中'})
              )
            ),
            h('small',{class:'knowledge-path',text:s.path}),
            h('small',{text:s.kind+' · '+fmtBytes(s.bytes)+' ('+s.bytes+' / '+s.size+' 字节) · '+(s.complete?'整文件 SHA-256 已校验':'同步中')+(s.parent?' · 父会话 '+s.parent:'')}),
            links));
        }
        content.append(grid,h('div',{class:'capi-btns knowledge-pager'},button('上一页',()=>{page=Math.max(0,page-1);draw();}),h('span',{text:'第 '+(page+1)+' 页'}),button('下一页',()=>{if(d.items.length===100){page++;draw();}})));
      }catch(e){say(e.message,true);}
    }
  }
  async function load(){try{const d=await get('');if(dead)return;data=d;stats.textContent='NAS SQLite：'+d.stats.versions+' 个会话文件版本，'+(d.stats.bytes/1048576).toFixed(1)+' MB；'+d.memories.length+' 条统一记忆。';renderKpis();await draw();}catch(e){say(e.message,true);}}
  const tabBtns=[];
  const syncTabBtns=()=>{for(const b of tabBtns)b.classList.toggle('go',b.dataset.tab===mode);};
  const show=id=>{mode=id;seq++;syncTabBtns();draw();};
  for(const [id,title]of [['memory','统一记忆'],['sources','记忆来源'],['review','对齐与智能整理'],['projects','项目目录'],['sync','同步状态'],['archive','完整会话']]){
    const b=button(title,()=>{if(id==='memory'&&mode!=='memory')scopeFilter='all';show(id);});b.dataset.tab=id;tabBtns.push(b);tabs.append(b);
  }
  syncTabBtns();
  const headerBar=h('div',{class:'knowledge-top-bar'},
    tabs,
    h('div',{class:'knowledge-toolbar knowledge-sel-bar'},
      selection,
      button('对齐所选',()=>show('review')),
      button('清空选择',()=>{selected.clear();selectionChanged();draw();}),
      refresh));
  root.append(kpiBar,headerBar,note,stats,content);load();return{root,show,destroy(){dead=true;seq++;reviewPanel?.destroy();}};
}
