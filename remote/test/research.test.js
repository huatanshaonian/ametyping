'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {openVault,hash,CHUNK}=require('../server/vault/database');
const {normalize,documentId,segments}=require('../server/research/normalize');
const {validateResult}=require('../server/research/extract');
const {createResearch}=require('../server/research/service');
const {runDeepseek,resolveDeepseek}=require('../server/ai/deepseek-api');
const {createTools}=require('../server/research/mcp');
const {cases}=require('./fixtures/research');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ame-research-'));
function ingest(v,rows,{machine='win',session='sample',cwd='G:/feko_data/CEM_PO',provider='claude',raw=null}={}) {
  const bytes=Buffer.from(raw===null?rows.map(x=>JSON.stringify(x)).join('\n')+'\n':raw);
  const ref={key:hash(machine+session),path:cwd+'/'+session+'.jsonl',provider,session,parent:'',kind:'native',cwd,size:bytes.length,mtime:1};
  const begin=v.begin(machine,ref);
  for(let start=0;start<bytes.length;start+=CHUNK){const b=bytes.subarray(start,start+CHUNK);v.append(machine,{key:ref.key,generation:begin.generation,start,data:b.toString('base64'),sha256:hash(b)});}
  v.finish(machine,{key:ref.key,generation:begin.generation,sha256:hash(bytes)});
  return {machine,key:ref.key,generation:begin.generation};
}
function resultFor(segment) {
  const i=segment.findIndex(x=>x.role==='user'),e=segment[i],evidence=[{ref:/^E\d+U\d+$/.test(e.id)?e.id:'E'+(i+1)+'U1'}];
  return {work_items:[{title:'现有代码上的独立计算',objective:'核对计算记录',kind:'calculation',state:'planned',evidence,runs:[],findings:[],open_questions:[]}]};
}
const creds=()=>({key:'test-key-not-real',base:'http://127.0.0.1',model:'deepseek-flash'});

test('normalization preserves UTF-8, numerical tool evidence and call identity while dropping reasoning',()=>{
  const rows=[...cases[2].rows,{type:'assistant',message:{content:[{type:'thinking',thinking:'private reasoning'}]}},
    {type:'user',message:{content:[{type:'tool_result',content:'\u001b[32m50%\u001b[0m'}]}}];
  const b=Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')),s={machine:'win',key:'k',generation:'g',digest:'d',provider:'claude'};
  const chunks=[];for(let i=0;i<b.length;i+=7)chunks.push(b.subarray(i,i+7));
  const events=[...normalize(s,chunks)];
  assert.ok(events.some(e=>e.text.includes('0.0031')));assert.ok(!events.some(e=>e.text.includes('private reasoning')));
  assert.ok(events.find(e=>e.text==='50%').suppressed);
  const batch=[...segments(events)][0];assert.equal(batch.find(e=>e.details.call_id==='call1'&&e.kind==='tool_result').details.error,true);
  const long={...events[0],text:'计算🌈'.repeat(1500)};const pieces=[...segments([long],2000)].flat();assert.equal(pieces.map(x=>x.text).join(''),long.text);
});

test('Kiro time and Codex tool output survive normalization',()=>{
  const s={machine:'x',key:'k',generation:'g',digest:'d',provider:'kiro'};
  const [k]=normalize(s,[Buffer.from(JSON.stringify({kind:'Prompt',data:{meta:{timestamp:1700000000},content:[{kind:'text',data:'计算'}]}}))]);
  assert.equal(k.t,1700000000000);
  const [e]=normalize({...s,provider:'codex'},[Buffer.from(JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'c',output:'residual=1e-6'}}))]);
  assert.equal(e.kind,'tool_result');assert.equal(e.details.call_id,'c');
});

test('evidence validator rejects invented citations, unsupported measurements and changed numerical values',()=>{
  const segment=[{id:'e',role:'assistant',kind:'message',start:20,text:'残差为 1e-6，但尚未验证。'}];
  const result=resultFor([{...segment[0],role:'user'}]);validateResult(structuredClone(result),segment);
  const bad=structuredClone(result);bad.work_items[0].evidence[0].ref='E99U1';assert.throws(()=>validateResult(bad,segment),/编号/);
  const measurement=structuredClone(result);measurement.work_items[0].findings=[{text:'残差已验证',basis:'measurement',evidence:result.work_items[0].evidence}];assert.throws(()=>validateResult(measurement,segment),/工具输出/);
  const metric=structuredClone(result);metric.work_items[0].runs=[{description:'x',state:'started',command:'',code_ref:{branch:'',commit:''},inputs:[],outputs:[],evidence:result.work_items[0].evidence,metrics:[{name:'残差',value_text:'1e-8',unit:'',evidence:result.work_items[0].evidence}]}];
  assert.throws(()=>validateResult(metric,segment),/数值/);
  const good=validateResult(structuredClone(result),segment);assert.equal(good.work_items[0].evidence[0].start,20);
  const short=structuredClone(result);short.work_items[0].evidence[0].ref='E1U1';
  assert.equal(validateResult(short,segment).work_items[0].evidence[0].event_id,'e');
  const command='python verify.py --name "球面"';
  const callEvent={id:'c',role:'tool',kind:'tool_call',start:0,text:JSON.stringify({command}),details:{command}};
  const escaped=resultFor([{...callEvent,role:'user'}]);escaped.work_items[0].runs=[{description:'运行',state:'started',command,inputs:[],outputs:[],code_ref:{branch:'',commit:''},metrics:[],evidence:structuredClone(escaped.work_items[0].evidence)}];
  assert.ok(validateResult(escaped,[callEvent]));
  const fileRead={...segment[0],role:'tool',kind:'tool_result',details:{origin:'file_read'}};
  const fileMeasure=resultFor([{...fileRead,role:'user'}]);fileMeasure.work_items[0].findings=[{text:'残差',basis:'measurement',evidence:structuredClone(fileMeasure.work_items[0].evidence)}];
  assert.throws(()=>validateResult(fileMeasure,[fileRead]),/只能作为报告/);
  const reading=resultFor([{...callEvent,role:'user'}]);reading.work_items[0].runs=[{description:'读取README',state:'reported_complete',command,inputs:[],outputs:[],code_ref:{branch:'',commit:''},metrics:[],evidence:[{ref:'E1U1'}]}];
  const cleaned=validateResult(reading,[{...callEvent,details:{command,origin:'file_read'}}]);
  assert.equal(cleaned.work_items[0].runs.length,0);assert.equal(cleaned.work_items[0].support_activities.length,1);
});

test('vault import is transactional, projects are isolated, complete snapshots and different goals remain distinct',async()=>{
  const dir=tmp(),v=openVault(dir);const r=createResearch({vault:v,getProject:id=>({id}),resolve:creds});
  try{
    const ref=ingest(v,cases[0].rows),a=r.store.importSource('cem',ref),again=r.store.importSource('cem',ref);assert.equal(a.id,again.id);
    assert.throws(()=>r.store.importSource('cem',ref,{maxBytes:1}),/上限/);
    assert.ok(r.store.search('cem','扫频').length);assert.equal(r.store.search('other','扫频').length,0);
    const event=[...r.store.events(a.id)][0];assert.throws(()=>r.store.evidenceFor('other',event.id),/找不到/);
    const tools=createTools(v.db);assert.ok(tools.call('search_records',{project:'cem',query:'扫频'}).length);assert.equal(tools.call('read_evidence',{project:'cem',id:event.id}).digest,v.source(ref.machine,ref.key,ref.generation).digest);
    const bad=ingest(v,[],{session:'bad',raw:'{not-json}\n'});const before=v.db.prepare('SELECT count(*) n FROM research_documents').get().n;
    assert.throws(()=>r.store.importSource('cem',bad),/有效 JSON/);assert.equal(v.db.prepare('SELECT count(*) n FROM research_documents').get().n,before);
    const kiro=ingest(v,[],{session:'kiro',provider:'kiro',raw:JSON.stringify({kind:'Prompt',data:{content:[{kind:'text',data:'验证'}]}})});assert.ok(r.store.importSource('cem',kiro));
  }finally{r.close();v.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('persistent queue validates before publishing, caches completed input and preserves retry usage',async()=>{
  const dir=tmp(),v=openVault(dir);let calls=0;
  const r=createResearch({vault:v,getProject:id=>({id}),resolve:creds,call:async o=>{
    calls++;o.onUsage({input:10,output:5});const input=JSON.parse(o.prompt.split('事件（start 为原事件字符偏移）：\n')[1].split('\n上次输出')[0]);
    const data=resultFor(input);if(calls===1)data.work_items[0].evidence[0].ref='E999U1';return{data};}});
  try{
    const d=r.store.importSource('cem',ingest(v,cases[0].rows));const q=r.enqueue('cem',d.id);assert.equal(q.ids.length,1);
    await r.tick();assert.equal(calls,2);const list=r.store.list('cem');assert.equal(list.work.length,1);assert.equal(list.jobs[0].state,'succeeded');assert.equal(list.jobs[0].usage.length,2);
    const attempts=v.db.prepare('SELECT validation_error FROM research_attempts ORDER BY attempt').all();assert.equal(attempts.length,2);assert.ok(attempts[0].validation_error);assert.equal(attempts[1].validation_error,'');
    assert.equal(r.enqueue('cem',d.id).ids.length,0);assert.throws(()=>r.retry('cem',q.ids[0]),/仅失败/);
    assert.ok(createTools(v.db).call('get_work_item',{project:'cem',id:list.work[0].id}).body.evidence.length);
    r.saveSettings({model:'deepseek-flash',base:'https://api.deepseek.com',key:'private-test-key'});
    assert.ok(!JSON.stringify(r.publicConfig()).includes('private-test-key'));
  }finally{r.close();v.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('restart exposes interrupted calls without silently charging for them again',()=>{
  const dir=tmp(),v=openVault(dir);let r=createResearch({vault:v,getProject:id=>({id}),resolve:creds});
  try{const d=r.store.importSource('cem',ingest(v,cases[1].rows));const q=r.enqueue('cem',d.id);v.db.prepare("UPDATE research_jobs SET state='running' WHERE id=?").run(q.ids[0]);
    r.close();r=createResearch({vault:v,getProject:id=>({id}),resolve:creds});assert.equal(r.store.list('cem').jobs[0].state,'interrupted');
    r.retry('cem',q.ids[0]);assert.equal(r.store.list('cem').jobs[0].state,'queued');
  }finally{r.close();v.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('DeepSeek adapter sends tool-free JSON requests and handles empty, truncated, auth and HTTP failure safely',async()=>{
  let mode='ok',body;const server=http.createServer((req,res)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{
    body=JSON.parse(text);if(mode==='auth'){res.writeHead(401);res.end('secret-that-must-not-be-logged');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'r',model:'deepseek-flash',usage:{prompt_tokens:12,completion_tokens:3},choices:[{finish_reason:mode==='length'?'length':'stop',message:{content:mode==='empty'?'   ':'{"work_items":[]}'}}]}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const options={key:'fake',base:'http://127.0.0.1:'+server.address().port,prompt:'JSON test',schema:{type:'object'}};
  try{assert.equal((await runDeepseek(options)).usage.input,12);assert.equal(body.response_format.type,'json_object');assert.equal(body.tools,undefined);assert.equal(body.thinking.type,'disabled');
    mode='empty';await assert.rejects(runDeepseek(options),/空 JSON/);mode='length';await assert.rejects(runDeepseek(options),/未完成/);
    mode='auth';await assert.rejects(runDeepseek(options),e=>e.status===401&&!e.message.includes('secret'));
    assert.equal(resolveDeepseek({env:{},key:'x',model:'deepseek-flash[1m]'}).model,'deepseek-flash');
    assert.throws(()=>resolveDeepseek({env:{},key:'x',base:'http://example.com'}),/HTTPS/);
  }finally{await new Promise(r=>server.close(r));}
});

test('MCP uses a read-only database and valid stdio messages without starting extraction',async()=>{
  const dir=tmp(),v=openVault(dir),r=createResearch({vault:v,getProject:id=>({id}),resolve:creds});
  try{
    const d=r.store.importSource('cem',ingest(v,cases[1].rows));const event=[...r.store.events(d.id)][0];
    const child=require('child_process').spawn(process.execPath,[path.resolve(__dirname,'../server/research/mcp.js'),v.file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
    const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_evidence',arguments:{project:'cem',id:event.id}}}];
    child.stdin.end(requests.map(x=>JSON.stringify(x)).join('\n')+'\n');
    assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),0);
    const messages=output.trim().split('\n').map(x=>JSON.parse(x));assert.equal(messages.length,3);
    assert.equal(messages[0].result.protocolVersion,'2025-06-18');assert.ok(messages[1].result.tools.every(t=>t.annotations.readOnlyHint));
    assert.equal(JSON.parse(messages[2].result.content[0].text).id,event.id);assert.equal(r.store.list('cem').jobs.length,0);
  }finally{r.close();v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
