// Managed blocks only. Outside text is preserved; a locally edited block causes a visible conflict.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {walk}=require('./native-archive');
const {execFile}=require('child_process');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const git=(dir,args)=>new Promise(res=>execFile('git',['-C',dir,...args],{timeout:10000,windowsHide:true,maxBuffer:1024*1024},(e,out)=>res(e?null:String(out))));
// Worktrees of the repository containing dir: [{path,branch}]; null when dir is not in a repository or git is missing.
async function listWorktrees(dir){
  const out=await git(dir,['worktree','list','--porcelain']);if(out===null)return null;
  const list=[];let cur=null;
  for(const l of out.split(/\r?\n/)){
    if(l.startsWith('worktree ')){cur={path:path.resolve(l.slice(9)),branch:''};list.push(cur);}
    else if(!cur)continue;
    else if(l.startsWith('branch '))cur.branch=l.slice(7).replace(/^refs\/heads\//,'');
    else if(l==='detached')cur.branch='(detached)';
    else if(l==='bare'||l.startsWith('prunable'))cur.skip=true;
  }
  return list.filter(x=>!x.skip&&fs.existsSync(x.path));
}
// Keeps generated instruction files out of `git status` through the shared info/exclude; tracked files are left as they are.
async function excludeFromGit(dir,names){
  const common=await git(dir,['rev-parse','--path-format=absolute','--git-common-dir']);if(common===null)return;
  const tracked=new Set(String(await git(dir,['ls-files','--',...names])||'').split(/\r?\n/).filter(Boolean));
  const add=[];
  for(const n of names)if(!tracked.has(n)&&await git(dir,['check-ignore','-q','--',n])===null)add.push('/'+n);
  if(!add.length)return;
  const file=path.join(common.trim(),'info','exclude');
  let old='';try{old=fs.readFileSync(file,'utf8');}catch{}
  const missing=add.filter(p=>!old.split(/\r?\n/).includes(p));
  if(missing.length){fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,(old&&!old.endsWith('\n')?'\n':'')+'# AmeTyping 托管记忆\n'+missing.join('\n')+'\n');}
}
const START='<!-- ametyping-memory:start -->',END='<!-- ametyping-memory:end -->';
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function atomic(file,body){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.ame-'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,body,{mode:0o600});fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}}}
function cleanManaged(body){const a=body.indexOf(START),b=body.indexOf(END);return a>=0&&b>a?body.slice(0,a)+body.slice(b+END.length):body;}
function createMemorySync({home=os.homedir(),name,send,folder,canWrite=()=>false,confirmedDir='',enabled=true,autoApply=true,scanMs=300000,
  worktrees=listWorktrees,gitExclude=excludeFromGit}){
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  // Registered directories plus every worktree of the repositories they contain:
  // a repository directory expands to its worktrees, a plain folder to the worktrees of its direct child repositories.
  async function projectDirs(t){
    const raw=Array.isArray(t.dirs)&&t.dirs.length?t.dirs:t.path?[{path:t.path,source:'manual'}]:[];
    const out=[];
    const add=async(p,source,branch='')=>{
      let dir;try{dir=await folder(p);}catch(e){out.push({path:p,source,branch,ok:false,msg:e.message});return null;}
      const old=out.find(x=>x.ok&&same(x.path,dir));
      if(old){if(!old.branch)old.branch=branch;return old;}
      const x={path:dir,source,branch,ok:true};out.push(x);return x;
    };
    for(const d of raw){
      if(!d||typeof d.path!=='string')continue;
      const base=await add(d.path,d.source==='linked'?'linked':'manual');if(!base)continue;
      let repos=[base.path];
      if(!fs.existsSync(path.join(base.path,'.git'))){
        try{repos=fs.readdirSync(base.path,{withFileTypes:true}).slice(0,200).filter(e=>e.isDirectory()&&fs.existsSync(path.join(base.path,e.name,'.git'))).map(e=>path.join(base.path,e.name));}catch{repos=[];}
      }
      for(const r of repos)for(const w of await worktrees(r)||[])await add(w.path,'worktree',w.branch);
    }
    return out;
  }
  const root=path.join(home,'.ametyping','memory'),stateFile=path.join(root,'state.json');
  let state={files:{}},bundle=null,at=0,working=false,queue=Promise.resolve(),lastDirs='';
  const dirSignature=m=>JSON.stringify([...m].map(([id,l])=>[id,l.filter(d=>d.ok).map(d=>d.path).sort()]));
  const seen=new Map();
  try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(!state.files)state.files={};}catch{}
  if(!state.adopted)state.adopted={};
  if(!state.targets)state.targets={};
  function sources(){
    const agyCfg=process.env.AGY_CONFIG_DIR||path.join(home,'.gemini','config');
    const out=[['claude',path.join(home,'.claude','CLAUDE.md')],['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'AGENTS.md')],
      ['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'AGENTS.override.md')],['opencode',path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode','AGENTS.md')],
      ['agy',path.join(home,'.gemini','GEMINI.md')]]
      .map(([provider,file])=>({provider,file,scope:'machine',owner:name}));
    for(const provider of ['claude','codex']){
      const base=provider==='claude'?path.join(home,'.claude','projects'):path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'memories');
      for(const file of walk(base,p=>p.endsWith('.md')&&(provider==='codex'||/[\\/]memory[\\/]/.test(p))))out.push({provider,file,scope:'machine',owner:name});
    }
    for(const file of walk(path.join(home,'.claude','rules'),p=>p.endsWith('.md')))out.push({provider:'claude',file,scope:'machine',owner:name});
    for(const file of walk(path.join(agyCfg,'rules'),p=>p.endsWith('.md')))out.push({provider:'agy',file,scope:'machine',owner:name});
    for(const file of walk(path.join(home,'.agents','rules'),p=>p.endsWith('.md')))out.push({provider:'agy',file,scope:'machine',owner:name});
    if(confirmedDir)for(const file of walk(confirmedDir,p=>p.endsWith('.md')))out.push({provider:'confirmed',file,scope:'global',owner:''});
    return out;
  }
  async function collect(force=false){
    if(!enabled)return;
    const list=sources();
    for(const p of bundle&&bundle.projects||[]){
      for(const d of await projectDirs(p)){
        if(!d.ok)continue;const dir=d.path;
        for(const [provider,rel]of [['claude','CLAUDE.md'],['claude','CLAUDE.local.md'],['codex','AGENTS.md'],['codex','AGENTS.override.md'],['agy','GEMINI.md']])list.push({provider,file:path.join(dir,rel),scope:'project',owner:p.id});
        for(const file of walk(path.join(dir,'.claude','rules'),p=>p.endsWith('.md')))list.push({provider:'claude',file,scope:'project',owner:p.id});
        for(const file of walk(path.join(dir,'.agents','rules'),p=>p.endsWith('.md')))list.push({provider:'agy',file,scope:'project',owner:p.id});
        const encoded=dir.replace(/[^A-Za-z0-9]/g,'-');
        for(const s of list)if(s.file.startsWith(path.join(home,'.claude','projects',encoded,'memory')+path.sep)){s.scope='project';s.owner=p.id;}
      }
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
    const dirsOf=new Map();
    for(const p of bundle.projects||[]){
      const list=await projectDirs(p);dirsOf.set(p.id,list);
      for(const d of list){if(!d.ok)continue;const dir=d.path;
        for(const rel of ['CLAUDE.md','CLAUDE.local.md','AGENTS.md','AGENTS.override.md','GEMINI.md'])allowed.add(path.join(dir,rel));
        for(const file of walk(path.join(dir,'.claude','rules'),p=>p.endsWith('.md')))allowed.add(file);
        for(const file of walk(path.join(dir,'.agents','rules'),p=>p.endsWith('.md')))allowed.add(file);}
    }
    lastDirs=dirSignature(dirsOf);
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
    // A file can move between targets (project renamed, directory shared); never retire what this run wrote.
    const written=new Set();
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
        let targets,dirs=null;
        if(t.target==='global'){
          const codexDir=process.env.CODEX_HOME||path.join(home,'.codex');
          targets=[path.join(home,'.claude','CLAUDE.md'),path.join(codexDir,fs.existsSync(path.join(codexDir,'AGENTS.override.md'))?'AGENTS.override.md':'AGENTS.md'),path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode','AGENTS.md'),path.join(home,'.gemini','GEMINI.md')];
        }else{
          dirs=dirsOf.get(t.target)||await projectDirs(t);
          const usable=dirs.filter(d=>d.ok);
          if(!usable.length)throw Error(dirs.map(d=>d.path+'：'+d.msg).join('；')||'没有可写的项目目录');
          targets=[];
          for(const d of usable){
            const dir=d.path;targets.push(path.join(dir,'CLAUDE.md'),path.join(dir,'AGENTS.md'));
            if(fs.existsSync(path.join(dir,'AGENTS.override.md')))targets.push(path.join(dir,'AGENTS.override.md'));
            if(fs.existsSync(path.join(dir,'GEMINI.md')))targets.push(path.join(dir,'GEMINI.md'));
            if(content)try{await gitExclude(dir,['CLAUDE.md','AGENTS.md']);}catch{}
          }
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
        for(const file of targets)written.add(file);
        const failed=[];
        for(const old of state.targets[t.target]||[])if(!targets.includes(old)&&!written.has(old)&&!await retire(old,t.target))failed.push(old);
        state.targets[t.target]=[...targets,...failed];atomic(stateFile,JSON.stringify(state));
        const bad=dirs?dirs.filter(d=>!d.ok):[];
        results.push({target:t.target,revision:t.revision,ok:true,...(dirs?{dirs}:{}),...(bad.length?{msg:'部分目录未写入：'+bad.map(d=>d.path+'：'+d.msg).join('；')}:{})});
      }catch(e){results.push({target:t.target,revision:t.revision,ok:false,msg:e.message,...(dirsOf.has(t.target)?{dirs:dirsOf.get(t.target)}:{})});}
    }
    for(const target of Object.keys(state.targets))if(!bundle.targets.some(t=>t.target===target)){
      const failed=[];for(const file of state.targets[target])if(!written.has(file)&&!await retire(file,target))failed.push(file);
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
  // A worktree added or removed between bundles is picked up by the periodic scan.
  async function tick(){if(working||Date.now()-at<scanMs)return;working=true;at=Date.now();try{
    await collect();
    if(bundle&&autoApply&&enabled&&canWrite()&&(bundle.projects||[]).length){
      const m=new Map();for(const p of bundle.projects)m.set(p.id,await projectDirs(p));
      if(dirSignature(m)!==lastDirs)await queue.catch(()=>{}).then(()=>apply()).catch(()=>{});
    }
  }finally{working=false;}}
  const handle=d=>{queue=queue.catch(()=>{}).then(()=>receive(d));return queue;};
  return {handle,collect,apply,tick,reset(){seen.clear();at=0;}};
}
module.exports={createMemorySync,cleanManaged,START,END,atomic};
