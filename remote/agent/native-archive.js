// Byte-exact archival, independent of the dashboard's lossy transcript display parser.
// One outstanding request: a server ACK always means its SQLite transaction has committed.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {agyRoots,metaOf:agyMetaOf}=require('../../app/agy-records');
const {SESSIONS:kiroSessionsDir,metadataOf:kiroMetadataOf}=require('../../app/kiro-records');
const CHUNK=512*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(root,accept,out=[],depth=0) {
  if(depth>12)return out;
  let ents;try{ents=fs.readdirSync(root,{withFileTypes:true});}catch{return out;}
  for(const e of ents){const p=path.join(root,e.name);if(e.isSymbolicLink())continue;
    if(e.isDirectory())walk(p,accept,out,depth+1);else if(e.isFile()&&accept(p))out.push(p);}
  return out;
}
function catalog(home=os.homedir()) {
  const roots=[['claude',path.join(home,'.claude','projects')],['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'sessions')],
    ['codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'archived_sessions')],
    ['opencode',path.join(process.env.OPENCODE_AME_HOME||path.join(home,'.ametyping','opencode'),'archive')],
    ['opencode',path.join(process.env.OPENCODE_AME_HOME||path.join(home,'.ametyping','opencode'),'events')],
    ['opencode',path.join(process.env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode','tool-output')],
    ['kiro',kiroSessionsDir],
    ...agyRoots(home).map(r=>['agy',path.join(r,'brain')])];
  const out=[];
  for(const [provider,root]of roots)for(const file of walk(root,p=>root.endsWith('tool-output')||
      (provider==='claude'&&/[\\/](tool-results|attachments)[\\/]/.test(p))||
      (provider==='agy'&&(/[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/.test(p)||/[\\/]steps[\\/]\d+[\\/]output\.txt$/.test(p)||/[\\/]subagents[\\/][^\\/]+\.json$/.test(p)||/[\\/]tasks[\\/][^\\/]+\.log$/.test(p)))||
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
      if(rel.includes('/steps/')||rel.includes('/tasks/'))kind='tool-output';
    }
    try{
      const fd=fs.openSync(file,'r');let b;try{b=Buffer.alloc(65536);const n=fs.readSync(fd,b,0,b.length,0);b=b.subarray(0,n);}finally{fs.closeSync(fd);}
      if(provider==='codex'){
        const raw=b.toString('utf8');let p;try{p=JSON.parse(raw.split('\n')[0]).payload;}catch{}
        const capture=k=>{const m=new RegExp('"'+k+'"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(raw);try{return m?JSON.parse(m[1]):'';}catch{return '';}};
        session=p&&p.id||capture('id')||id;parent=p&&p.parent_thread_id||capture('parent_thread_id');cwd=p&&p.cwd||capture('cwd');
      }
      else if(provider==='claude'){const m=/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(b.toString('utf8'));if(m)cwd=JSON.parse(m[1]);const pm=/[\\/]([^\\/]+)[\\/]subagents[\\/]/.exec(file);if(pm)parent=pm[1];}
      else if(provider==='agy'){
        const tf=path.join(root,session,'.system_generated','logs','transcript.jsonl');
        const meta=agyMetaOf(fs.existsSync(tf)?tf:file);
        if(meta){if(meta.cwd)cwd=meta.cwd;if(meta.parentId)parent=meta.parentId;}
      }
      else if(provider==='kiro'){
        // cwd and the sub-session marker live in the sibling {id}.json; parse it once per file
        const jf=file.replace(/\.jsonl$/i,'.json');
        const meta=kiroMetadataOf(fs.existsSync(jf)?jf:file);
        if(meta){if(typeof meta.cwd==='string')cwd=meta.cwd;if(meta.session_created_reason==='subagent')parent=session;}
      }
      else{const s=b.toString('utf8');const p=/"parentID"\s*:\s*"([^"]+)"/.exec(s),c=/"directory"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(s);parent=p?p[1]:'';cwd=c?JSON.parse(c[1]):'';}
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
function createNativeArchive({send,home=os.homedir(),enabled=true,scanMs=60000,log=()=>{}}) {
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
          const signature=st.size+':'+st.mtimeMs;
          if(sent.get(c.key)===signature)continue;
          current={...c,size:st.size,mtime:st.mtimeMs,signature};request('begin',current);return;
        }return;
      }
      const c=current;
      if(!c.generation){request('begin',c);return;}
      if(c.offset<c.size){
        const fd=fs.openSync(c.file,'r');let b;try{b=Buffer.alloc(Math.min(CHUNK,c.size-c.offset));const n=fs.readSync(fd,b,0,b.length,c.offset);b=b.subarray(0,n);}finally{fs.closeSync(fd);}
        if(!b.length){current=null;return;}
        request('chunk',{key:c.key,generation:c.generation,start:c.offset,data:b.toString('base64'),sha256:hash(b)});
      }else{
        const sha256=await fileHash(c.file,c.size),st=fs.statSync(c.file);
        if(st.size<c.size||st.mtimeMs!==c.mtime){current=null;return;}
        request('finish',{key:c.key,generation:c.generation,sha256});
      }
    }catch(e){log('完整存档读取失败：'+e.message);current=null;pending=null;}finally{busy=false;}
  }
  function handle(d){
    if(d.t!=='vault-result'||!pending||pending.rid!==d.rid)return false;
    const action=pending.action;pending=null;
    const c=current;if(!c)return true;
    if(!d.ok){log('完整存档未完成：'+(d.msg||'请重新连接'));if(action==='finish'&&d.retryReset===true){delete c.generation;request('begin',{...c,reset:true});}else{current=null;pauseUntil=Date.now()+15000;}return true;}
    if(action==='begin'){
      let good=Number.isSafeInteger(d.offset)&&d.offset<=c.size;
      try{
        if(good&&d.tailSize){const fd=fs.openSync(c.file,'r'),b=Buffer.alloc(d.tailSize);let n;try{n=fs.readSync(fd,b,0,b.length,d.tailStart);}finally{fs.closeSync(fd);}good=n===b.length&&hash(b)===d.tailHash;}
      }catch{good=false;}
      if(!good){request('begin',{...c,reset:true});return true;}
      c.generation=d.generation;c.offset=d.offset;
    }else if(action==='chunk')c.offset=d.offset;
    else if(action==='finish'){sent.set(c.key,c.signature);current=null;}
    setImmediate(tick);
    return true;
  }
  return {tick,handle,ready,reset};
}
module.exports={createNativeArchive,catalog,walk,fileHash};
