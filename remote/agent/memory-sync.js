// Managed blocks only. Outside text is preserved; a locally edited block causes a visible conflict.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {walk}=require('./native-archive');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const START='<!-- ametyping-memory:start -->',END='<!-- ametyping-memory:end -->';
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function atomic(file,body){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.ame-'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,body,{mode:0o600});fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}}}
function cleanManaged(body){const a=body.indexOf(START),b=body.indexOf(END);return a>=0&&b>a?body.slice(0,a)+body.slice(b+END.length):body;}
function createMemorySync({home=os.homedir(),name,send,folder,canWrite=()=>false,confirmedDir='',enabled=true,autoApply=true}){
  const root=path.join(home,'.ametyping','memory'),stateFile=path.join(root,'state.json');
  let state={files:{}},bundle=null,at=0,working=false,queue=Promise.resolve();
  const seen=new Map();
  try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(!state.files)state.files={};}catch{}
  if(!state.adopted)state.adopted={};
  if(!state.targets)state.targets={};
  function sources(){
    const out=[['claude',path.join(home,'.claude','CLAUDE.md')],['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'AGENTS.md')],
      ['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'AGENTS.override.md')],['opencode',path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode','AGENTS.md')]]
      .map(([provider,file])=>({provider,file,scope:'machine',owner:name}));
    for(const provider of ['claude','codex']){
      const base=provider==='claude'?path.join(home,'.claude','projects'):path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'memories');
      for(const file of walk(base,p=>p.endsWith('.md')&&(provider==='codex'||/[\\/]memory[\\/]/.test(p))))out.push({provider,file,scope:'machine',owner:name});
    }
    for(const file of walk(path.join(home,'.claude','rules'),p=>p.endsWith('.md')))out.push({provider:'claude',file,scope:'machine',owner:name});
    if(confirmedDir)for(const file of walk(confirmedDir,p=>p.endsWith('.md')))out.push({provider:'confirmed',file,scope:'global',owner:''});
    return out;
  }
  async function collect(force=false){
    if(!enabled)return;
    const list=sources();
    for(const p of bundle&&bundle.projects||[]){
      let dir;try{dir=await folder(p.path);}catch{continue;}
      for(const [provider,rel]of [['claude','CLAUDE.md'],['claude','CLAUDE.local.md'],['codex','AGENTS.md'],['codex','AGENTS.override.md']])list.push({provider,file:path.join(dir,rel),scope:'project',owner:p.id});
      for(const file of walk(path.join(dir,'.claude','rules'),p=>p.endsWith('.md')))list.push({provider:'claude',file,scope:'project',owner:p.id});
    }
    for(const p of bundle&&bundle.projects||[]){
      const encoded=p.path.replace(/[^A-Za-z0-9]/g,'-');
      for(const s of list)if(s.file.startsWith(path.join(home,'.claude','projects',encoded,'memory')+path.sep)){s.scope='project';s.owner=p.id;}
    }
    const items=[];
    for(const s of list){
      try{
        const st=fs.lstatSync(s.file);if(!st.isFile()||st.isSymbolicLink())continue;
        if(st.size>1024*1024){send({t:'memory-applied',target:'capture:'+s.file,revision:'',ok:false,msg:'记忆来源超过 1 MB，请拆分后采集，原文件未改动'});continue;}
        const raw=fs.readFileSync(s.file,'utf8').replace(/^\uFEFF/,'');
        const a=raw.indexOf(START),b=raw.indexOf(END),block=a>=0&&b>a?raw.slice(a,b+END.length):'';
        if(state.files[s.file]&&sha(block)!==state.files[s.file]){
          const conflict={path:s.file+'#managed-conflict',provider:s.provider,scope:s.scope,owner:s.owner,
            body:'本机托管区块有修改，需与 NAS 记忆合并：\n\n'+(block?raw.slice(a+START.length,b):'（本机托管区块被删除）')};
          send({t:'memory-observe',items:[conflict]});
        }
        const body=cleanManaged(raw);
        if(!body.trim())continue;
        const sig=sha(body);if(!force&&seen.get(s.file)===sig)continue;
        const item={path:s.file,provider:s.provider,scope:s.scope,owner:s.owner,body};
        if(items.length&&Buffer.byteLength(JSON.stringify([...items,item]))>2*1024*1024)send({t:'memory-observe',items:items.splice(0)});
        items.push(item);seen.set(s.file,sig);
        if(items.length===10){send({t:'memory-observe',items:items.splice(0)});}
      }catch{}
    }
    if(items.length)send({t:'memory-observe',items});
  }
  function render(items){
    return items.map(x=>`## ${{global:'共享全局',machine:'本机',project:'项目'}[x.scope]||'记忆'} · ${x.name}\n\n${x.body.trim()}\n`).join('\n');
  }
  function update(file,content){
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('记忆入口是链接，需保留并手动接入：'+file);
    let old='';try{old=fs.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    const a=old.indexOf(START),b=old.indexOf(END),previous=state.files[file];
    if((a<0)!==(b<0)||(a>=0&&(b<a||old.indexOf(START,a+START.length)>=0||old.indexOf(END,b+END.length)>=0)))throw Error('托管块标记不完整：'+file);
    const block=a>=0?old.slice(a,b+END.length):'';
    if(previous&&(sha(block)!==previous))throw Error('托管内容被本地修改，请先在看板合并：'+file);
    if(!previous&&block)throw Error('发现未登记的托管块，请先核对：'+file);
    const next=content?START+'\n'+content.trim()+'\n'+END:'';
    const body=a>=0?old.slice(0,a)+next+old.slice(b+END.length):old+next;
    if(body!==old){
      if(old){const dest=path.join(root,'backups',sha(file),Date.now()+'-'+crypto.randomUUID()+'.md');atomic(dest,old);}
      atomic(file,body);
    }
    state.files[file]=sha(next);atomic(stateFile,JSON.stringify(state));
    return file;
  }
  async function apply(target){
    if(!enabled||!canWrite())throw Error('本机未开放记忆写入');
    if(!bundle)throw Error('尚未收到 NAS 记忆版本');
    const results=[];
    const retire=async(file,target)=>{
      try{
        if(target!=='global')await folder(path.dirname(file));
        else if(!sources().some(s=>s.file===file))throw Error('不在已知全局记忆入口内');
        if(fs.existsSync(file))update(file,'');return true;
      }catch(e){send({t:'memory-applied',target:'retired:'+file,revision:'',ok:false,msg:e.message});return false;}
    };
    // Explicitly adopted sources are retired only when their last observed content still matches.
    // Immutable confirmed releases are reference material and never rewritten.
    const allowed=new Set(sources().filter(s=>s.provider!=='confirmed').map(s=>s.file));
    for(const p of bundle.projects||[]){try{const dir=await folder(p.path);for(const rel of ['CLAUDE.md','CLAUDE.local.md','AGENTS.md','AGENTS.override.md'])allowed.add(path.join(dir,rel));
      for(const file of walk(path.join(dir,'.claude','rules'),p=>p.endsWith('.md')))allowed.add(file);}catch{}}
    const adoptSources=()=>{for(const a of bundle.adoptions||[]){
      const owner=a.scope==='project'?a.owner:'global';
      if(!results.some(r=>r.target===owner&&r.ok))continue;
      if(state.adopted[a.path]===a.sha256||!allowed.has(a.path))continue;
      try{
        if(fs.lstatSync(a.path).isSymbolicLink())throw Error('来源是链接，保留本地文件');
        const original=fs.readFileSync(a.path,'utf8'),outside=cleanManaged(original.replace(/^\uFEFF/,''));
        if(sha(outside)!==a.sha256)throw Error('来源已在本地修改，未接管：'+a.path);
        const start=original.indexOf(START),end=original.indexOf(END);
        const retained=start>=0&&end>start?original.slice(start,end+END.length):'';
        atomic(path.join(root,'backups',sha(a.path),Date.now()+'-'+crypto.randomUUID()+'.md'),original);
        atomic(a.path,retained);state.adopted[a.path]=a.sha256;atomic(stateFile,JSON.stringify(state));
      }catch(e){send({t:'memory-applied',target:'source:'+a.path,revision:a.sha256,ok:false,msg:e.message});}
    }};
    for(const t of bundle.targets){
      if(target&&target!==t.target)continue;
      try{
        if(!/^[a-f0-9]{64}$/.test(t.revision)||!Array.isArray(t.items)||t.items.length>2000)throw Error('记忆版本无效');
        const body=render(t.items);
        const exportDir=path.join(root,'exports',t.target==='global'?'global':ID.test(t.target)?t.target:(()=>{throw Error('项目 ID 无效');})());
        const files=t.items.map(x=>{
          if(!/^[A-Za-z0-9-]{1,80}$/.test(x.id)||typeof x.body!=='string')throw Error('记忆条目无效');
          const file=path.join(exportDir,x.id+'.md');atomic(file,'# '+x.name+'\n\n'+x.body+'\n');return {file,item:x};
        });
        const indexFile=path.join(exportDir,'INDEX.md');
        atomic(indexFile,'# NAS 统一记忆\n\n'+files.map(x=>'- '+x.item.name+': '+x.file.replace(/\\/g,'/')).join('\n')+'\n');
        let content=body;
        // Keep startup instructions small; full, untruncated documents remain in generated Markdown files.
        if(Buffer.byteLength(body)>16000)content='# NAS 统一记忆索引\n\n按当前任务读取以下文件：\n'+files.map(x=>'- '+x.item.name+': '+x.file.replace(/\\/g,'/')).join('\n');
        if(Buffer.byteLength(content)>24000)throw Error('记忆索引过大，请拆分范围后重新发布');
        let targets;
        if(t.target==='global'){
          const codexDir=process.env.CODEX_HOME||path.join(home,'.codex');
          targets=[path.join(home,'.claude','CLAUDE.md'),path.join(codexDir,fs.existsSync(path.join(codexDir,'AGENTS.override.md'))?'AGENTS.override.md':'AGENTS.md'),path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode','AGENTS.md')];
        }else{
          const dir=await folder(t.path);targets=[path.join(dir,'CLAUDE.md'),path.join(dir,'AGENTS.md')];
          if(fs.existsSync(path.join(dir,'AGENTS.override.md')))targets.push(path.join(dir,'AGENTS.override.md'));
        }
        for(const file of targets)if(content||state.files[file]){
          let selected=content;
          if(content&&/^AGENTS(?:\.override)?\.md$/.test(path.basename(file))){
            let original='';try{original=cleanManaged(fs.readFileSync(file,'utf8'));}catch{}
            if(Buffer.byteLength(original+selected)>28000)selected='# NAS 统一记忆\n\n开始任务时按需读取记忆索引：'+indexFile.replace(/\\/g,'/');
            if(Buffer.byteLength(original+selected)+START.length+END.length+2>32000)throw Error('原有 AGENTS 说明接近工具长度上限，请整理后同步：'+file);
          }
          update(file,selected);
        }
        const failed=[];
        for(const old of state.targets[t.target]||[])if(!targets.includes(old)&&!await retire(old,t.target))failed.push(old);
        state.targets[t.target]=[...targets,...failed];atomic(stateFile,JSON.stringify(state));
        results.push({target:t.target,revision:t.revision,ok:true});
      }catch(e){results.push({target:t.target,revision:t.revision,ok:false,msg:e.message});}
    }
    for(const target of Object.keys(state.targets))if(!bundle.targets.some(t=>t.target===target)){
      const failed=[];for(const file of state.targets[target])if(!await retire(file,target))failed.push(file);
      if(failed.length)state.targets[target]=failed;else delete state.targets[target];atomic(stateFile,JSON.stringify(state));
    }
    adoptSources();
    for(const r of results)send({t:'memory-applied',...r});
    return results;
  }
  async function receive(d){
    if(d.t!=='memory-bundle')return false;
    if(d.machine!==name||!Array.isArray(d.targets)||!Array.isArray(d.projects))return true;
    bundle=d;await collect(true);
    if(autoApply)await apply().catch(e=>send({t:'memory-applied',target:'global',revision:'',ok:false,msg:e.message}));
    else for(const t of d.targets)send({t:'memory-applied',target:t.target,revision:t.revision,ok:false,msg:'本机设置为只采集（autoApply=false），尚未应用'});
    return true;
  }
  async function tick(){if(working||Date.now()-at<60000)return;working=true;at=Date.now();try{await collect();}finally{working=false;}}
  const handle=d=>{queue=queue.catch(()=>{}).then(()=>receive(d));return queue;};
  return {handle,collect,apply,tick,reset(){seen.clear();at=0;}};
}
module.exports={createMemorySync,cleanManaged,START,END,atomic};
