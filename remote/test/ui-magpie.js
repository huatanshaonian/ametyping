// Isolated Windose + gateway + browser. No real accounts or model requests.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),cp=require('child_process'),assert=require('assert/strict');
const WebSocket=require('ws'),R=path.resolve(__dirname,'..'),auth=require('../server/auth');
const T=fs.mkdtempSync(path.join(os.tmpdir(),'windose-magpie-ui-')),CFG=path.join(T,'config.json'),PORT=18971,CDP=18972;
const OUT=process.env.AME_MAGPIE_UI_OUT||path.join(__dirname,'out','shots','magpie');fs.mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env,HOME:T,USERPROFILE:T,AME_REMOTE_CONFIG:CFG,AME_SUMMARY_TICK_MS:'600000'};
cp.execFileSync(process.execPath,[R+'/server/setup.js','init'],{env:{...env,AME_USER:'fixture',AME_PASSWORD:'fixture-long-password'},stdio:'ignore',windowsHide:true});
const at=new Date().toISOString(); let gatewayReads=0;
const gateway=http.createServer((req,res)=>{
  gatewayReads++;res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'group/opus-main',magpie_label:'Opus · 日常',reasoning_levels:['low','medium','high']},{id:'devin/claude-opus-5-5',magpie_label:'Opus 5.5 · Devin',reasoning_levels:['low','medium','high','max']},{id:'deepseek/deepseek-flash',magpie_label:'DeepSeek Flash'}]}));
  if(req.url==='/v1/magpie/quotas')return res.end(JSON.stringify({data:[
    {provider:'kiro',name:'Kiro',plan:'Kiro Student',user:'student@example.test',readAt:at,windows:[{name:'Credits',remaining:98.2,used:1.8,amount:18,limit:1000,unit:'credits',resetsAt:'2026-12-01T00:00:00Z'}]},
    {provider:'kiro',name:'Kiro',plan:'Kiro Pro',user:'pro@example.test',readAt:at,windows:[{name:'Credits',remaining:71.6,used:28.4,amount:284,limit:1000,unit:'credits',resetsAt:'2026-12-01T00:00:00Z'}]},
    {provider:'devin',name:'Devin',user:'devin@example.test',readAt:at,windows:[{name:'1 day',remaining:98,used:2,resetsAt:new Date(Date.now()+8*3600000).toISOString()},{name:'7 days',remaining:99,used:1,resetsAt:new Date(Date.now()+3*86400000).toISOString()}]},
    {provider:'antigravity',name:'AGY',plan:'Google AI Pro',user:'agy@example.test',readAt:at,windows:[{name:'Claude & GPT · 7 days',remaining:100,used:0,resetsAt:new Date(Date.now()+4*86400000).toISOString()},{name:'Claude & GPT · 5 hours',remaining:100,used:0,resetsAt:new Date(Date.now()+3*3600000).toISOString()}]},
    {provider:'deepseek',name:'DeepSeek',kind:'balance',balance:'¥55.06',readAt:at,windows:[]},
    {provider:'gcp',name:'Remote magpie',kind:'subscription',from:'Remote magpie',error:'nothing read on that magpie yet; refresh to have it read',windows:[]},
    {provider:'gcp/~keys',name:'Remote magpie',kind:'plan',from:'Remote magpie',user:'fixture-gcp-key',readAt:at,windows:[{name:'Limit',unlimited:true,remaining:100}]},
  ]}));
  if(req.url.startsWith('/v1/magpie/usage'))return res.end(JSON.stringify({period:new URL(req.url,'http://test').searchParams.get('period'),since:at,calls:42,input:158240,output:18300,cache_read:12500,cost:0.7182,accounts:[{provider:'kiro',account:'student@example.test',calls:15,input:80000,output:7000,cost:0.2}]}));
  res.writeHead(404);res.end('{}');
});
function request(p,opts={}){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:PORT,path:p,...opts},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:b}));});r.on('error',reject);r.end(opts.body);});}
function debug(p,method='GET'){return new Promise((resolve,reject)=>{const r=http.request('http://127.0.0.1:'+CDP+p,{method},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});});r.setTimeout(2000,()=>r.destroy(Error('CDP HTTP timeout')));r.on('error',reject);r.end();});}
let srv,chrome,ws;const checks=[];
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
(async()=>{
 try{
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const cfg=JSON.parse(fs.readFileSync(CFG));cfg.web.port=PORT;cfg.summary={codexHome:T,claudeHome:T};cfg.assetsDir='D:/ametyping/app/assets';cfg.magpie={baseURL:'http://127.0.0.1:'+gateway.address().port+'/v1'};fs.writeFileSync(CFG,JSON.stringify(cfg));
  srv=cp.spawn(process.execPath,[R+'/server/server.js'],{env,stdio:'ignore',windowsHide:true});
  for(let i=0;i<100;i++){try{if((await request('/login')).status===200)break;}catch{}await sleep(100);}
  check('monitor API rejects anonymous clients',(await request('/api/magpie/status')).status===401);
  const body=JSON.stringify({user:'fixture',password:'fixture-long-password',code:auth.totpAt(cfg.totpSecret,Math.floor(Date.now()/30000))});
  const login=await request('/api/login',{method:'POST',headers:{Origin:'http://127.0.0.1:'+PORT,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},body});const cookie=String(login.headers['set-cookie']).split(';')[0];
  const headers={Cookie:cookie};
  const publicData=JSON.parse((await request('/api/magpie/status',{headers})).body);
  check('gateway snapshot has distinct accounts, balance and sanitized errors',publicData.accounts.length===6&&publicData.accounts.some(a=>a.balance?.amount===55.06)&&!JSON.stringify(publicData).includes('SECRET')&&!JSON.stringify(publicData).includes('student@example.test'));
  const ai=JSON.parse((await request('/api/ai',{headers})).body);check('native AI choices and defaults retained alongside Magpie',ai.models.some(m=>m.provider==='magpie')&&ai.models.some(m=>m.provider==='claude')&&ai.models.some(m=>m.provider==='codex')&&ai.default.model==='');
  check('monitor has no mutation route',(await request('/api/magpie/set',{method:'POST',headers:{...headers,Origin:'http://127.0.0.1:'+PORT,'Content-Type':'application/json'},body:'{}'})).status===404);
  chrome=cp.spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--remote-debugging-port='+CDP,'--user-data-dir='+path.join(T,'chrome'),'--no-first-run','--no-proxy-server','about:blank'],{stdio:'ignore',windowsHide:true});
  let ready=false;for(let i=0;i<30;i++){try{await debug('/json/version');ready=true;break;}catch{}await sleep(100);}assert.ok(ready,'isolated Chrome starts');console.log('Chrome ready');
  const tab=await debug('/json/new?about:blank','PUT');ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.on('open',r));
  let id=0;const pending=new Map(),errors=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
  const call=(method,params={})=>new Promise((r,reject)=>{const n=++id;const t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timed out: '+method));},10000);pending.set(n,m=>{clearTimeout(t);r(m);});ws.send(JSON.stringify({id:n,method,params}));});
  const js=async expression=>{if(expression.includes('await '))expression='(async()=>{'+expression+'})()';const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value;};
  const shot=async name=>fs.writeFileSync(path.join(OUT,name),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).result.data,'base64'));
  await call('Runtime.enable');await call('Network.enable');await call('Page.enable');
  await call('Network.setCookie',{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:'http://127.0.0.1:'+PORT+'/'});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://127.0.0.1:'+PORT+'/#magpie'});await sleep(1800);
  await shot('initial.png');
  const loaded=await js("document.querySelectorAll('.mp-account').length===6 && [...document.querySelectorAll('.dicon')].some(e=>e.textContent.includes('Magpie'))");
  if(!loaded)console.log(JSON.stringify({errors,page:await js("document.body.innerText.slice(0,1000)"),accounts:await js("document.querySelectorAll('.mp-account').length")}));
  check('desktop/start-menu entry and monitor load',loaded);
  await js("window.realOpen=window.open;window.controlOpened=[];window.open=(...args)=>{window.controlOpened.push(args);return null};[...document.querySelectorAll('.mp-tools button')].find(b=>b.textContent==='Magpie 网页').click()");
  check('control-page button opens the dedicated domain in a safe new tab',await js("window.controlOpened.length===1 && window.controlOpened[0][0]==='https://magpie.huatan.org/' && window.controlOpened[0][1]==='_blank' && window.controlOpened[0][2].includes('noopener')"));
  await js("window.open=window.realOpen");
  check('remote source has one card and separates upstream from gateway-key limit',await js("[...document.querySelectorAll('.mp-account')].filter(e=>e.textContent.includes('GCP · Remote Magpie')).length===1 && document.querySelectorAll('.mp-connection').length===1 && document.querySelector('.mp-connection').textContent.includes('不代表上游订阅额度无限')"));
  check('desktop usage widget lists accounts and uses new native-size icon',await js("document.querySelectorAll('#magpiewidget .mpw-row').length===6 && document.querySelector('#magpiewidget img').getAttribute('src')==='/icons/chart1-16.png' && document.querySelector('#magpiewidget img').naturalWidth===16"));
  check('widgets stack without overlap',await js("document.querySelector('#magpiewidget').getBoundingClientRect().top > document.querySelector('#todowidget').getBoundingClientRect().bottom && document.querySelector('#magpiewidget').getBoundingClientRect().bottom <= document.querySelector('#desktop').getBoundingClientRect().bottom"));
  check('panel inherits the desktop font and has square account borders',await js("getComputedStyle(document.querySelector('.magpie-monitor')).fontFamily===getComputedStyle(document.body).fontFamily && getComputedStyle(document.querySelector('.mp-account')).borderRadius==='0px'"));
  check('quota bars have widths and no horizontal overflow',await js("document.querySelector('.mp-meter span').style.width==='98.2%' && [...document.querySelectorAll('.mp-account')].every(e=>e.scrollWidth<=e.clientWidth+1)"));
  await shot('desktop.png');
  await js("document.documentElement.dataset.theme='win98'");await sleep(100);await shot('desktop-win98.png');
  check('Win98 theme applies sunken panels and navy segmented progress',await js("getComputedStyle(document.querySelector('.mp-account')).boxShadow!=='none' && getComputedStyle(document.querySelector('.mp-meter span')).backgroundImage.includes('0, 0, 128')"));
  await js("(await import('/js/wm.js')).minimize('dashboard');(await import('/js/wm.js')).minimize('magpie')");await shot('widgets-win98.png');
  await js("document.querySelector('#magpiewidget .mpw-fold').click()");
  check('usage widget collapses and remembers its setting',await js("document.querySelector('#magpiewidget').classList.contains('collapsed') && localStorage.getItem('ame.magpie.collapsed')==='true'"));
  await js("document.querySelector('#magpiewidget .mpw-fold').click();document.querySelector('#magpiewidget .mpw-row').click()");
  check('usage widget opens full panel',await js("return !(await import('/js/wm.js')).list().find(w=>w.id==='magpie').minimized"));
  await js("delete document.documentElement.dataset.theme");
  await js("document.documentElement.dataset.shade='night'");await shot('desktop-night.png');
  check('dark theme recolours the monitor through shared tokens',await js("getComputedStyle(document.querySelector('.magpie-monitor')).backgroundColor==='rgb(38, 26, 71)' && getComputedStyle(document.querySelector('.mp-account')).backgroundColor==='rgb(47, 33, 86)'"));
  await js("delete document.documentElement.dataset.shade");
  await js("document.querySelector('.mp-tools input').value='AGY';document.querySelector('.mp-tools input').dispatchEvent(new Event('input'))");
  check('account filter isolates AGY two windows',await js("document.querySelectorAll('.mp-account').length===1 && document.querySelectorAll('.mp-window').length===2"));
  await js("document.querySelector('.mp-tools input').value='';document.querySelector('.mp-tools input').dispatchEvent(new Event('input'));document.querySelector('.mp-tools select').value='7d';document.querySelector('.mp-tools select').dispatchEvent(new Event('change'))");await sleep(200);
  check('seven-day period selection is supported',await js("document.querySelector('.mp-tools select').value==='7d'"));
  await js("const p=await import('/js/apps/ai-models.js');const w=await import('/js/wm.js');window.testAi=p.panel();w.open({id:'test-ai',title:'AI 模型',width:1060,height:720,content:window.testAi.root})");await sleep(400);
  check('existing AI entry offers Magpie grouped models',await js("[...document.querySelectorAll('.aim select optgroup')].some(e=>e.label==='Magpie')"));
  await shot('ai-models.png');
  await js("const s=document.querySelector('.aim-table .aim-row:nth-child(6) select');s.value=[...s.options].find(o=>o.value.startsWith('magpie:')).value;s.dispatchEvent(new Event('change'))");await sleep(700);
  const changed=JSON.parse((await request('/api/ai',{headers})).body);check('Magpie selection saves using existing AI settings without changing default',changed.tasks.some(t=>t.set.model.startsWith('magpie:'))&&changed.default.model==='');
  await js("window.testAi.destroy();(await import('/js/wm.js')).close('test-ai')");
  await call('Emulation.setDeviceMetricsOverride',{width:430,height:860,deviceScaleFactor:1,mobile:true});await sleep(300);await shot('mobile.png');
  check('mobile monitor fits its window',await js("[...document.querySelectorAll('.mp-account')].every(e=>e.scrollWidth<=e.clientWidth+1)"));
  check('desktop widgets are hidden on narrow screens like Important Plans',await js("getComputedStyle(document.querySelector('#desktopwidgets')).display==='none'"));
  check('browser has no uncaught exceptions',errors.length===0);
  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({completed:true,checks,gatewayReads,modelRequests:0},null,2));
 }finally{ws?.close();chrome?.kill();srv?.kill();gateway.closeAllConnections();gateway.close();await sleep(500);try{fs.rmSync(T,{recursive:true,force:true});}catch{}}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
