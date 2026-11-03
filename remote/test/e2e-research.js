// Isolated HTTP integration; optional headless browser uses a disposable profile, never the user's desktop.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),cp=require('child_process'),assert=require('node:assert/strict');
const {openVault,hash}=require('../server/vault/database');
const {createResearchStore}=require('../server/research/database');
const auth=require('../server/auth'),{cases}=require('./fixtures/research');
const R=path.resolve(__dirname,'..'),T=fs.mkdtempSync(path.join(os.tmpdir(),'ame-research-e2e-')),CFG=path.join(T,'config.json');
const PORT=18864,CDP=9364,env={...process.env,AME_REMOTE_CONFIG:CFG,HOME:path.join(T,'home'),USERPROFILE:path.join(T,'home')};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let cookie='',server,chrome,calls=0;
const api=(method,p,body,anonymous=false,origin=null)=>new Promise((resolve,reject)=>{
  const text=body?JSON.stringify(body):'',req=http.request({host:'127.0.0.1',port:PORT,path:p,method,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text),Cookie:anonymous?'':cookie,Origin:origin||'http://127.0.0.1:'+PORT}},res=>{
    let data='';res.on('data',b=>data+=b);res.on('end',()=>{let value;try{value=JSON.parse(data);}catch{}resolve({status:res.statusCode,value,raw:data,headers:res.headers});});});req.on('error',reject);req.end(text);
});
async function until(fn){for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await sleep(100);}throw Error('integration timeout');}
async function browser(project){
  const get=(url,method='GET')=>new Promise((resolve,reject)=>{const q=http.request(url,{method},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});});q.on('error',reject);q.end();});
  const exe=process.env.CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
  chrome=cp.spawn(exe,['--headless=new','--disable-gpu','--no-first-run','--no-proxy-server','--remote-debugging-port='+CDP,'--user-data-dir='+path.join(T,'chrome'),'about:blank'],{stdio:'ignore',windowsHide:true});
  await until(async()=>!!(await get('http://127.0.0.1:'+CDP+'/json/version')));
  const tab=await get('http://127.0.0.1:'+CDP+'/json/new?about:blank','PUT');
  const WebSocket=require('../node_modules/ws'),socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>socket.once('open',r));
  let id=0;const pending=new Map(),errors=[];
  socket.on('message',raw=>{const m=JSON.parse(raw);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
  const call=(method,params={})=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);socket.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value;};
  try{
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
    const [name,value]=cookie.split('=');await call('Network.setCookie',{name,value,url:'http://127.0.0.1:'+PORT+'/'});
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:'http://127.0.0.1:'+PORT+'/'});
    await until(()=>evaluate("!!document.getElementById('desktop')"));
    await evaluate(`(async()=>{await (await import('/js/mesh.js')).load();(await import('/js/apps/projects.js')).open(${JSON.stringify(project)});})()`);
    await until(()=>evaluate("!![...document.querySelectorAll('.pm-tab')].find(x=>x.textContent.includes('研究与计算'))"));
    await evaluate("[...document.querySelectorAll('.pm-tab')].find(x=>x.textContent.includes('研究与计算')).click()");
    await until(()=>evaluate("document.querySelector('.pr-root')?.textContent.includes('Windows 扫频')"));
    await evaluate("document.querySelector('.pr-root details').open=true;document.querySelector('.pr-form input[type=password]').value='draft-secret-not-saved'");
    await api('POST','/api/mesh/project',{id:project,name:'CEM_PO',desc:'trigger project refresh'});
    await sleep(400);
    assert.equal(await evaluate("document.querySelector('.pr-form input[type=password]').value"),'draft-secret-not-saved');
    await evaluate("[...document.querySelectorAll('.pr-root button')].find(x=>x.textContent==='原文与前后文').click()");
    await until(()=>evaluate("!!document.querySelector('dialog[open]')"));
    assert.ok(await evaluate("document.querySelector('dialog').textContent.includes('扫频')"));
    assert.ok(await evaluate("document.querySelector('dialog a').href.includes('/api/research/raw?project=')"));
    await evaluate("document.querySelector('.pr-form input[type=password]').value='';document.querySelector('dialog button').click()");
    await evaluate("(async()=>{(await import('/js/wm.js')).focus('projects');document.querySelector('.pr-root details').open=false;})()");
    const out=path.join(__dirname,'out','shots');fs.mkdirSync(out,{recursive:true});
    const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'research-pilot.png'),Buffer.from(shot.result.data,'base64'));
    await evaluate("[...document.querySelectorAll('.pm-side button')].find(x=>x.textContent==='查看首轮整理结果').click()");
    await until(()=>evaluate("document.querySelector('.pr-pilots')?.textContent.includes('历史计算候选')"));
    assert.ok(!(await evaluate("document.querySelector('.pr-pilots').textContent")).includes('SYNTHETIC-CONTROL-DO-NOT-SHOW'));
    await evaluate("document.querySelector('.pr-pilots details').open=true;[...document.querySelectorAll('.pr-pilots button')].find(x=>x.textContent==='查看原文与前后文').click()");
    await until(()=>evaluate("!!document.querySelector('.pr-pilots dialog[open]')"));
    assert.ok(await evaluate("document.querySelector('.pr-pilots dialog').textContent.includes('扫频')"));
    await evaluate("document.querySelector('.pr-pilots dialog button').click()");
    const pilotShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'research-pilot-results.png'),Buffer.from(pilotShot.result.data,'base64'));
    assert.deepEqual(errors,[]);console.log('PASS headless project page, evidence dialog and settings survive live project updates');
  }finally{socket.close();}
}

(async()=>{
  const fake=http.createServer((req,res)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{
    calls++;const b=JSON.parse(text),events=JSON.parse(b.messages[1].content.split('事件（start 为原事件字符偏移）：\n')[1]);
    const e=events.find(e=>e.role==='user'),evidence=[{ref:e.id}];
    const item=(title,state)=>({title,objective:title,kind:'calculation',state,evidence,runs:[],findings:[],open_questions:[]});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fake',usage:{prompt_tokens:40,completion_tokens:20},choices:[{finish_reason:'stop',message:{content:JSON.stringify({work_items:[item('Windows 扫频','reported_complete'),item('dell97 网格验证','started')]})}}]}));
  });});await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  try{
    cp.execFileSync(process.execPath,[R+'/server/setup.js','init'],{env:{...env,AME_USER:'u',AME_PASSWORD:'fixture-password-long'},stdio:'ignore',windowsHide:true});
    const cfg=JSON.parse(fs.readFileSync(CFG));cfg.web.port=PORT;cfg.agent={host:'127.0.0.1',port:PORT+1};cfg.summary={enabled:false};cfg.research={key:'fake-private-key',base:'http://127.0.0.1:'+fake.address().port,model:'deepseek-flash'};fs.writeFileSync(CFG,JSON.stringify(cfg));
    const v=openVault(path.join(T,'data')),raw=Buffer.from(cases[0].rows.map(x=>JSON.stringify(x)).join('\n')),key=hash('fixture');
    const b=v.begin('win',{key,path:'G:/feko_data/CEM_PO/session.jsonl',provider:'claude',session:'fixture',parent:'',kind:'native',cwd:'G:/feko_data/CEM_PO',size:raw.length,mtime:1});
    v.append('win',{key,generation:b.generation,start:0,data:raw.toString('base64'),sha256:hash(raw)});v.finish('win',{key,generation:b.generation,sha256:hash(raw)});
    const store=createResearchStore(v),d=store.importSource('pilot-cem-po',{machine:'win',key}),event=[...store.events(d.id)][0];
    const fakeKey=hash('synthetic-control');const fb=v.begin('test',{key:fakeKey,path:'/controls/source.jsonl',provider:'claude',session:'synthetic',parent:'',kind:'native',cwd:'/controls',size:raw.length,mtime:1});
    v.append('test',{key:fakeKey,generation:fb.generation,start:0,data:raw.toString('base64'),sha256:hash(raw)});v.finish('test',{key:fakeKey,generation:fb.generation,sha256:hash(raw)});
    const control=store.importSource('pilot-cem-po',{machine:'test',key:fakeKey}),controlEvent=[...store.events(control.id)][0];
    const pilotFolder=path.join(T,'data','research-pilots','first-round');fs.mkdirSync(pilotFolder,{recursive:true});
    await v.snapshot(path.join(pilotFolder,'knowledge.sqlite'));
    const visible={id:'candidate',title:'历史计算候选',objective:'核对已有研究工作',state:'reported_complete',runs:[],findings:[],open_questions:[],evidence:[{event_id:event.id,quote:event.text,start:0}]};
    fs.writeFileSync(path.join(pilotFolder,'report.json'),JSON.stringify({at:new Date().toISOString(),provider:{model:'test'},scope:'isolated test',samples:[
      {synthetic:false,name:'historical',state:'succeeded',document:d.id,work:[visible]},
      {synthetic:true,name:'control',state:'succeeded',document:control.id,work:[{...visible,title:'SYNTHETIC-CONTROL-DO-NOT-SHOW',evidence:[{event_id:controlEvent.id,quote:controlEvent.text,start:0}]}]}
    ]}));v.close();
    server=cp.spawn(process.execPath,[R+'/server/server.js'],{env,stdio:'ignore',windowsHide:true});
    await until(async()=>!!(await api('GET','/login')).status);
    assert.equal((await api('GET','/api/research?project=x',null,true)).status,401);console.log('PASS research endpoints refuse anonymous access');
    assert.equal((await api('GET','/api/research/pilots',null,true)).status,401);
    const login=await api('POST','/api/login',{user:'u',password:'fixture-password-long',code:auth.totpAt(cfg.totpSecret,Math.floor(Date.now()/30000))});cookie=String(login.headers['set-cookie']||'').split(';')[0];assert.ok(cookie);
    assert.equal((await api('GET','/api/mesh/projects')).value.projects.length,0);
    const pilots=(await api('GET','/api/research/pilots')).value;assert.equal(pilots.items[0].count,1);
    const pilot=(await api('GET','/api/research/pilot?id=first-round')).value.item;assert.equal(pilot.samples.length,1);assert.ok(!JSON.stringify(pilot).includes('SYNTHETIC-CONTROL-DO-NOT-SHOW'));
    assert.ok((await api('GET','/api/research/pilot/evidence?id=first-round&event='+event.id)).value.item.text.includes('扫频'));
    assert.equal((await api('GET','/api/research/pilot/evidence?id=first-round&event='+controlEvent.id)).value.ok,false);
    console.log('PASS saved pilots are visible without project binding; synthetic controls and their evidence stay excluded');
    const p=(await api('POST','/api/mesh/project',{name:'CEM_PO',workspaces:[{machine:'win',path:'G:/feko_data/CEM_PO',mode:'ro'}]})).value.project.id;
    const sources=(await api('GET','/api/research/sources?project='+p)).value;assert.equal(sources.items.length,1);
    assert.equal((await api('POST','/api/research/import',{project:p,refs:[{machine:'win',key}]},false,'https://wrong.invalid')).status,403);
    const imported=(await api('POST','/api/research/import',{project:p,refs:[{machine:'win',key}]})).value;assert.ok(imported.ok);const document=imported.item[0].id;
    assert.ok((await api('POST','/api/research/enqueue',{project:p,document})).value.ok);
    await until(async()=>{const s=(await api('GET','/api/research?project='+p)).value;return s.jobs[0]?.state==='succeeded';});
    const data=(await api('GET','/api/research?project='+p)).value;assert.equal(data.work.length,2);assert.equal(calls,1);
    assert.equal((await api('POST','/api/research/enqueue',{project:p,document})).value.item.ids.length,0);
    const hit=(await api('GET','/api/research/search?project='+p+'&q='+encodeURIComponent('扫频'))).value.items[0];assert.ok(hit);
    const evidence=(await api('GET','/api/research/evidence?project='+p+'&id='+hit.id)).value.item;assert.ok(evidence.text.includes('扫频'));assert.equal(evidence.digest,hash(raw));
    // A generation can grow by appending. The research snapshot must still download its original exact prefix.
    const growing=openVault(path.join(T,'data')),tail=Buffer.from('\n'+JSON.stringify({type:'user',message:{content:'后续新增内容'}})),all=Buffer.concat([raw,tail]);
    const next=growing.begin('win',{key,path:'G:/feko_data/CEM_PO/session.jsonl',provider:'claude',session:'fixture',parent:'',kind:'native',cwd:'G:/feko_data/CEM_PO',size:all.length,mtime:2});
    growing.append('win',{key,generation:next.generation,start:raw.length,data:tail.toString('base64'),sha256:hash(tail)});growing.finish('win',{key,generation:next.generation,sha256:hash(all)});growing.close();
    const snapshot=await api('GET','/api/research/raw?project='+p+'&id='+document);assert.equal(snapshot.raw,raw.toString());assert.equal(snapshot.headers['x-archive-sha256'],hash(raw));
    console.log('PASS authenticated import, extraction, idempotence, complete-source search and fixed-version evidence');
    const saved=(await api('POST','/api/research/config',{project:p,key:'updated-private-key',model:'deepseek-flash'})).value;assert.ok(saved.ok);assert.ok(!JSON.stringify(saved).includes('updated-private-key'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(T,'data','research-api.json'))).key,'updated-private-key');
    assert.ok(!JSON.stringify((await api('GET','/api/research?project='+p)).value).includes('updated-private-key'));console.log('PASS NAS API settings persist without exposing keys');
    if(process.argv.includes('--browser'))await browser(p);
    assert.equal(calls,1); // Viewing saved pilot results never asks the model again.
  }catch(e){console.error(e);process.exitCode=1;}
  finally{if(chrome)chrome.kill();if(server){server.kill();await new Promise(r=>server.once('exit',r));}await new Promise(r=>fake.close(r));}
})();
