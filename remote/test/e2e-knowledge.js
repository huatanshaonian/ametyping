// Real agent/server/WebSocket and authenticated HTTP, using disposable homes and invented records only.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),cp=require('child_process'),assert=require('assert/strict');
const R=path.resolve(__dirname,'..'),auth=require(R+'/server/auth');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'ame-knowledge-e2e-')),HOME=path.join(T,'home'),PROJECT=path.join(HOME,'project');
const CFG=path.join(T,'server','config.json'),ACFG=path.join(T,'agent.json'),PORT=18844,kids=[];
const write=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);};
const sid='abcdef01-1111-2222-3333-444444444444';
const source=path.join(HOME,'.claude/projects/-fixture',sid+'.jsonl');
const original=JSON.stringify({type:'user',cwd:PROJECT,timestamp:new Date().toISOString(),message:{role:'user',content:'完整归档'}})+'\n'+
  JSON.stringify({type:'user',cwd:PROJECT,message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'工具完整输出🌈'.repeat(90000)}]}})+'\n';
write(source,original);write(path.join(HOME,'.claude/projects/-fixture',sid,'subagents/agent-child.jsonl'),'child原始输出\n');
write(path.join(HOME,'.codex/sessions/2020/01/01/rollout.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'codex-thread',cwd:PROJECT}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'完整 Codex 输出'}})+'\n');
const globalFile=path.join(HOME,'.claude/CLAUDE.md');write(globalFile,'这台机器的原规则\n');write(path.join(PROJECT,'AGENTS.md'),'项目原有规则\n');
write(path.join(HOME,'.codex/auth.json'),'SECRET-NOT-ARCHIVED');
fs.mkdirSync(path.dirname(CFG),{recursive:true});
const env={...process.env,HOME,USERPROFILE:HOME,CODEX_HOME:path.join(HOME,'.codex'),AME_REMOTE_CONFIG:CFG,AME_SUMMARY_TICK_MS:'600000'};
delete env.OPENCODE_AME_HOME;
const node=(args,extra={})=>cp.execFileSync(process.execPath,args,{env:{...env,...extra},windowsHide:true}).toString();
node([R+'/server/setup.js','init'],{AME_USER:'u',AME_PASSWORD:'fixture-password-long'});
const cfg=JSON.parse(fs.readFileSync(CFG));cfg.web.port=PORT;cfg.summary={enabled:false};write(CFG,JSON.stringify(cfg));
const token=node([R+'/server/setup.js','add-agent','box']).split('\n').map(x=>x.trim()).find(s=>/^[A-Za-z0-9_-]{30,}$/.test(s));
write(ACFG,JSON.stringify({server:'ws://127.0.0.1:'+PORT+'/agent',token,name:'box',control:true,scanMs:100,petPort:18845,files:{roots:[HOME]}}));
let cookie='',stderr='',count=0;
const request=(method,p,body,withCookie=true,origin=true)=>new Promise((resolve,reject)=>{
  const b=body?JSON.stringify(body):'';const r=http.request({hostname:'127.0.0.1',port:PORT,path:p,method,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b),...(withCookie?{Cookie:cookie}:{}),...(origin?{Origin:'http://127.0.0.1:'+PORT}:{})}},res=>{
    const a=[];res.on('data',b=>a.push(b));res.on('end',()=>{const raw=Buffer.concat(a);let value;try{value=JSON.parse(raw.toString());}catch{}resolve({status:res.statusCode,value,raw,headers:res.headers});});
  });r.setTimeout(10000,()=>r.destroy(Error('request timeout')));r.on('error',reject);r.end(b);
});
const get=p=>request('GET','/api/knowledge'+p),post=(p,d)=>request('POST','/api/knowledge/'+p,d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<150;n++){if(await fn())return;await sleep(100);}throw Error('fixture timeout '+stderr.slice(-1000));}
const check=(name,fn)=>{assert.ok(fn,name);count++;console.log('PASS '+name);};
function start(file,extra={}){const p=cp.spawn(process.execPath,[file],{env:{...env,...extra},stdio:['ignore','ignore','pipe'],windowsHide:true});p.stderr.on('data',b=>stderr+=b);kids.push(p);return p;}
(async()=>{
  try{
    const server=start(R+'/server/server.js');await until(async()=>{try{return(await request('GET','/login')).status===200;}catch{return false;}});
    check('archive API refuses anonymous access',(await request('GET','/api/knowledge',null,false)).status===401);
    const login=await request('POST','/api/login',{user:'u',password:'fixture-password-long',code:auth.totpAt(cfg.totpSecret,Math.floor(Date.now()/30000))});cookie=String(login.headers['set-cookie']).split(';')[0];
    let agent=start(R+'/agent/agent.js',{AME_AGENT_CONFIG:ACFG});
    await until(async()=>{const d=(await get('/sources')).value;return d&&d.items.length===3&&d.items.every(x=>x.complete);});
    const sources=(await get('/sources')).value.items,s=sources.find(x=>x.path===source);
    const raw=await get('/raw?'+new URLSearchParams({machine:'box',key:s.key,generation:s.generation}));
    check('large native tool output is byte-exact through the actual WebSocket and SQLite',raw.raw.equals(Buffer.from(original)));
    check('native archive includes old Codex and Claude child records, excludes credentials',sources.some(x=>x.parent===sid)&&sources.some(x=>x.provider==='codex')&&!sources.some(x=>/auth/.test(x.path)));
    await until(async()=>(await get('')).value.observed.length>0);
    check('machine memory is collected separately without publishing it',(await get('')).value.memories.length===0);
    check('cross-origin mutation is refused',(await request('POST','/api/knowledge/save',{},true,false)).status===403);
    const shared=(await post('save',{scope:'global',owner:'',name:'共享偏好',body:'统一记忆：中文🌈'})).value.item;
    await post('save',{scope:'machine',owner:'other',name:'别的电脑',body:'MUST-NOT-APPLY'});
    await post('project',{id:'fixture',name:'Fixture',paths:[{machine:'box',path:PROJECT}]});
    await post('save',{scope:'project',owner:'fixture',name:'项目规则',body:'项目统一记忆'});
    await until(()=>fs.readFileSync(globalFile,'utf8').includes('统一记忆：中文🌈')&&fs.readFileSync(path.join(PROJECT,'AGENTS.md'),'utf8').includes('项目统一记忆'));
    check('global and mapped project memory are applied while preserving original instructions',fs.readFileSync(globalFile,'utf8').includes('这台机器的原规则')&&fs.readFileSync(path.join(PROJECT,'AGENTS.md'),'utf8').includes('项目原有规则'));
    check('Codex and OpenCode receive usable AGENTS.md files; other-machine memory stays isolated',fs.readFileSync(path.join(HOME,'.codex/AGENTS.md'),'utf8').includes('统一记忆')&&!fs.readFileSync(globalFile,'utf8').includes('MUST-NOT-APPLY')&&fs.readFileSync(path.join(HOME,'.config/opencode/AGENTS.md'),'utf8').includes('统一记忆'));
    const stale=await post('save',{...shared,revision:0,body:'stale'});check('stale edits fail without overwriting the published revision',!stale.value.ok);
    write(globalFile,fs.readFileSync(globalFile,'utf8').replace('统一记忆：中文🌈','本地冲突'));
    await post('save',{...shared,body:'更新后的共享记忆'});
    await until(async()=>(await get('')).value.deployments.some(x=>x.machine==='box'&&x.target==='global'&&x.status==='conflict'));
    check('a changed managed block reports a conflict instead of losing local edits',fs.readFileSync(globalFile,'utf8').includes('本地冲突'));
    agent.kill();await new Promise(r=>agent.once('exit',r));fs.appendFileSync(source,'after reconnect\n');
    agent=start(R+'/agent/agent.js',{AME_AGENT_CONFIG:ACFG});
    await until(async()=>{const d=(await get('/sources')).value.items.find(x=>x.path===source);return d.complete&&d.bytes===Buffer.byteLength(original+'after reconnect\n');});
    check('reconnected agent continues from committed bytes without duplication',true);
    check('revision history remains queryable',(await get('/history?id='+shared.id)).value.items.length===2);
    const d=(await get('')).value;check('deployment acknowledgements are persisted',d.deployments.some(x=>x.target==='fixture'&&x.status==='applied'));
    server.kill();console.log('\n'+count+' passed, 0 failed');
  }catch(e){console.error(e.stack);console.error(stderr.slice(-2000));process.exitCode=1;}
  finally{for(const p of kids)p.kill();await sleep(600);try{fs.rmSync(T,{recursive:true,force:true});}catch{}}
})();
