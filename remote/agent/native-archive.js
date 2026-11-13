// Byte-exact archival, independent of the dashboard's lossy transcript display parser.
// One outstanding request: a server ACK always means its SQLite transaction has committed.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {agyRoots,metaOf:agyMetaOf}=require('../../app/agy-records');
const {metadataOf:kiroMetadataOf}=require('../../app/kiro-records');
const CHUNK=512*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(root,accept,out=[],depth=0) {
  if(depth>12)return out;
  let ents;try{ents=fs.readdirSync(root,{withFileTypes:true});}catch{return out;}
  for(const e of ents){const p=path.join(root,e.name);if(e.isSymbolicLink())continue;
    if(e.isDirectory())walk(p,accept,out,depth+1);else if(e.isFile()&&accept(p))out.push(p);}
  return out;
}
function tryRmdir(dir) {
  try{if(fs.existsSync(dir)&&!fs.readdirSync(dir).length)fs.rmdirSync(dir);}catch{}
}
function compactAgyToolOutputs(brainRoot,{activeMs=10*60*1000,now=Date.now()}={}) {
  let sessions;try{sessions=fs.readdirSync(brainRoot,{withFileTypes:true});}catch{return;}
  for(const ent of sessions){
    if(!ent.isDirectory()||ent.isSymbolicLink())continue;
    const sysDir=path.join(brainRoot,ent.name,'.system_generated');
    const stepsDir=path.join(sysDir,'steps'),tasksDir=path.join(sysDir,'tasks'),logsDir=path.join(sysDir,'logs');
    const items=[];
    try{
      for(const s of fs.readdirSync(stepsDir,{withFileTypes:true})){
        if(!s.isDirectory()||s.isSymbolicLink()||!/^\d+$/.test(s.name))continue;
        const stepDir=path.join(stepsDir,s.name),file=path.join(stepDir,'output.txt');
        try{const st=fs.lstatSync(file);if(st.isFile()&&!st.isSymbolicLink())items.push({type:'step',id:s.name,num:+s.name,file,dir:stepDir,st});}catch{tryRmdir(stepDir);}
      }
    }catch{}
    try{
      for(const t of fs.readdirSync(tasksDir,{withFileTypes:true})){
        if(!t.isFile()||t.isSymbolicLink()||!t.name.endsWith('.log'))continue;
        const file=path.join(tasksDir,t.name);
        try{const st=fs.lstatSync(file);if(st.isFile()&&!st.isSymbolicLink())items.push({type:'task',id:t.name.slice(0,-4),num:Infinity,file,dir:null,st});}catch{}
      }
    }catch{}
    if(!items.length){tryRmdir(stepsDir);tryRmdir(tasksDir);continue;}
    items.sort((a,b)=>a.num-b.num||a.id.localeCompare(b.id));
    const outFile=path.join(logsDir,'tool_outputs.jsonl');
    const seen=new Set();
    try{
      for(const line of fs.readFileSync(outFile,'utf8').split('\n')){
        if(!line.trim())continue;
        try{const o=JSON.parse(line);if(o&&o.type&&o.id&&o.sha256)seen.add(o.type+':'+o.id+':'+o.sha256);}catch{}
      }
    }catch{}
    let tfRaw='';
    for(const tfName of ['transcript_full.jsonl','transcript.jsonl']){
      try{tfRaw=fs.readFileSync(path.join(logsDir,tfName),'utf8');break;}catch{}
    }
    let appended='';
    const toDelete=[];
    for(const it of items){
      try{
        const raw=fs.readFileSync(it.file);
        const digest=hash(raw),sig=it.type+':'+it.id+':'+digest;
        if(!seen.has(sig)){
          appended+=JSON.stringify({type:it.type,id:it.id,size:raw.length,mtime:Math.round(it.st.mtimeMs),sha256:digest,content:raw.toString('utf8')})+'\n';
          seen.add(sig);
        }
        const escId=it.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const referenced=it.type==='step'
          ?new RegExp('steps[\\\\/]+'+escId+'[\\\\/]+output\\.txt').test(tfRaw)
          :new RegExp('tasks[\\\\/]+'+escId+'\\.log').test(tfRaw);
        if(!referenced||now-it.st.mtimeMs>=activeMs)toDelete.push(it);
      }catch{}
    }
    try{
      if(appended){fs.mkdirSync(logsDir,{recursive:true});fs.appendFileSync(outFile,appended,'utf8');}
      for(const it of toDelete){try{fs.unlinkSync(it.file);}catch{}if(it.dir)tryRmdir(it.dir);}
      tryRmdir(stepsDir);tryRmdir(tasksDir);
    }catch{}
  }
}
function catalog(home=os.homedir(),{agyActiveMs}={}) {
  const agyBrains=agyRoots(home).map(r=>path.join(r,'brain'));
  for(const b of agyBrains)compactAgyToolOutputs(b,agyActiveMs!==undefined?{activeMs:agyActiveMs}:undefined);
  const roots=[['claude',path.join(home,'.claude','projects')],['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'sessions')],
    ['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'archived_sessions')],
    ['opencode',path.join(process.env.OPENCODE_AME_HOME||path.join(home,'.ametyping','opencode'),'archive')],
    ['opencode',path.join(process.env.OPENCODE_AME_HOME||path.join(home,'.ametyping','opencode'),'events')],
    ['opencode',path.join(process.env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode','tool-output')],
    ['kiro',path.join(process.env.KIRO_HOME||path.join(home,'.kiro'),'sessions','cli')],
    ...agyBrains.map(b=>['agy',b])];
  const out=[],agyMetaCache=new Map();
  for(const [provider,root]of roots)for(const file of walk(root,p=>root.endsWith('tool-output')||
      (provider==='claude'&&/[\\/](tool-results|attachments)[\\/]/.test(p))||
      (provider==='agy'&&(/[\\/]logs[\\/](?:transcript(?:_full)?|tool_outputs)\.jsonl$/.test(p)||/[\\/]subagents[\\/][^\\/]+\.json$/.test(p)))||
      (provider==='kiro'?/\.(jsonl|json)$/.test(p):
      provider==='opencode'?/\.(json|jsonl)$/.test(p):provider!=='agy'&&p.endsWith('.jsonl')))){
    const rel=path.relative(root,file).split(path.sep).join('/');
    const id=path.basename(file).replace(/\.(jsonl|json|txt|log)$/,'');
    let session=id,parent='',cwd='';
    let kind=root.endsWith('events')?'events':'native';
    if(provider==='claude'&&/[\\/](tool-results|attachments)[\\/]/.test(file)){
      session=rel.split('/')[1]||id;kind=rel.includes('/tool-results/')?'tool-output':'attachment';
    }else if(root.endsWith('tool-output')){session='tool-output';kind='tool-output';}
    else if(provider==='agy'){
      session=rel.split('/')[0]||id;
      if(file.endsWith('tool_outputs.jsonl'))kind='tool-output';
    }
    try{
      if(provider==='agy'){
        const cacheKey=root+'\0'+session;
        let meta=agyMetaCache.get(cacheKey);
        if(meta===undefined){
          const tf=path.join(root,session,'.system_generated','logs','transcript.jsonl');
          meta=agyMetaOf(fs.existsSync(tf)?tf:file,home)||null;
          agyMetaCache.set(cacheKey,meta);
        }
        if(meta){if(meta.cwd)cwd=meta.cwd;if(meta.parent||meta.parentId)parent=meta.parent||meta.parentId;}
      }else if(provider==='kiro'){
        // cwd and the sub-session marker live in the sibling {id}.json; parse it once per file
        const jf=file.replace(/\.jsonl$/i,'.json');
        const meta=kiroMetadataOf(fs.existsSync(jf)?jf:file);
        if(meta){if(typeof meta.cwd==='string')cwd=meta.cwd;if(meta.session_created_reason==='subagent')parent=session;}
      }else{
        const fd=fs.openSync(file,'r');let b;try{b=Buffer.alloc(65536);const n=fs.readSync(fd,b,0,b.length,0);b=b.subarray(0,n);}finally{fs.closeSync(fd);}
        if(provider==='codex'){
          const raw=b.toString('utf8');let p;try{p=JSON.parse(raw.split('\n')[0]).payload;}catch{}
          const capture=k=>{const m=new RegExp('"'+k+'"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(raw);try{return m?JSON.parse(m[1]):'';}catch{return '';}};
          session=p&&p.id||capture('id')||id;parent=p&&p.parent_thread_id||capture('parent_thread_id');cwd=p&&p.cwd||capture('cwd');
        }else if(provider==='claude'){
          const m=/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(b.toString('utf8'));if(m)cwd=JSON.parse(m[1]);const pm=/[\\/]([^\\/]+)[\\/]subagents[\\/]/.exec(file);if(pm)parent=pm[1];
        }else{
          const s=b.toString('utf8');const p=/"parentID"\s*:\s*"([^"]+)"/.exec(s),c=/"directory"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(s);parent=p?p[1]:'';cwd=c?JSON.parse(c[1]):'';
        }
      }
    }catch{}
    out.push({file,provider,session:provider==='claude'?session:provider+':'+session,parent,kind,cwd,
      path:file,key:hash(Buffer.from(provider+'\0'+root+'\0'+rel))});
  }
  return out;
}
async function fileHash(file,size) {
  const h=crypto.createHash('sha256');
  if(size)for await(const b of fs.createReadStream(file,{start:0,end:size-1}))h.update(b);
  return h.digest('hex');
}
function createNativeArchive({send,home=os.homedir(),enabled=true,scanMs=300000,log=()=>{}}) {
  let sources=[],scanAt=0,index=0,pending=null,current=null,connected=false,busy=false,pauseUntil=0;
  const sent=new Map();
  const request=(action,d)=>{const rid=crypto.randomUUID();pending={rid,at:Date.now(),action};send({t:'vault-request',rid,action,...d});};
  function reset(){pending=null;current=null;connected=false;sent.clear();scanAt=0;}
  function ready(){reset();connected=enabled;}
  async function tick(){
    if(!connected||busy||Date.now()<pauseUntil)return;busy=true;
    try{
      if(pending){if(Date.now()-pending.at>30000){pending=null;current=null;}return;}
      if(!current){
        if(Date.now()-scanAt>scanMs){sources=catalog(home);scanAt=Date.now();index=0;}
        for(let n=0;n<sources.length;n++){
          const c=sources[index++%sources.length];let st;try{st=fs.statSync(c.file);}catch{continue;}
          const signature=st.size+':'+st.mtimeMs,prevSig=sent.get(c.key);
          if(prevSig===signature)continue;
          const prevSize=prevSig?+prevSig.split(':')[0]:-1;
          const sha256=(prevSize===st.size&&st.size>0)?await fileHash(c.file,st.size):undefined;
          current={...c,size:st.size,mtime:st.mtimeMs,signature,...(sha256?{sha256}:{probe:true})};request('begin',current);return;
        }return;
      }
      const c=current;
      if(!c.generation){
        if(c.needHash){delete c.needHash;delete c.probe;c.sha256=await fileHash(c.file,c.size);}
        request('begin',c);return;
      }
      if(c.offset<c.size){
        const fd=fs.openSync(c.file,'r');let b;try{b=Buffer.alloc(Math.min(CHUNK,c.size-c.offset));const n=fs.readSync(fd,b,0,b.length,c.offset);b=b.subarray(0,n);}finally{fs.closeSync(fd);}
        if(!b.length){current=null;return;}
        request('chunk',{key:c.key,generation:c.generation,start:c.offset,data:b.toString('base64'),sha256:hash(b)});
      }else{
        const sha256=await fileHash(c.file,c.size),st=fs.statSync(c.file);
        if(st.size<c.size){current=null;return;}
        request('finish',{key:c.key,generation:c.generation,sha256});
      }
    }catch(e){log('完整存档读取失败：'+e.message);current=null;pending=null;}finally{busy=false;}
  }
  function handle(d){
    if(d.t!=='vault-result'||!pending||pending.rid!==d.rid)return false;
    const action=pending.action;pending=null;
    const c=current;if(!c)return true;
    if(!d.ok){log('完整存档未完成：'+(d.msg||'请重新连接'));if(action==='finish'&&d.retryReset===true){delete c.generation;delete c.probe;request('begin',{...c,reset:true});}else{current=null;pauseUntil=Date.now()+15000;}return true;}
    if(action==='begin'){
      if(d.needHash&&!c.sha256){c.needHash=true;setImmediate(tick);return true;}
      if(d.complete&&d.offset===c.size){sent.set(c.key,c.signature);current=null;setImmediate(tick);return true;}
      let good=Number.isSafeInteger(d.offset)&&d.offset<=c.size;
      try{
        if(good&&d.tailSize){const fd=fs.openSync(c.file,'r'),b=Buffer.alloc(d.tailSize);let n;try{n=fs.readSync(fd,b,0,b.length,d.tailStart);}finally{fs.closeSync(fd);}good=n===b.length&&hash(b)===d.tailHash;}
      }catch{good=false;}
      if(!good){delete c.probe;request('begin',{...c,reset:true});return true;}
      c.generation=d.generation;c.offset=d.offset;
    }else if(action==='chunk')c.offset=d.offset;
    else if(action==='finish'){sent.set(c.key,c.signature);current=null;}
    setImmediate(tick);
    return true;
  }
  return {tick,handle,ready,reset};
}
module.exports={createNativeArchive,catalog,compactAgyToolOutputs,walk,fileHash};
