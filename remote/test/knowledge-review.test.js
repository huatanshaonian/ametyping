'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {openVault}=require('../server/vault/database'),{createMemory}=require('../server/vault/memory'),{createReview}=require('../server/vault/review'),{createAsk}=require('../server/ai/ask');
function fixture(ask){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ame-memory-review-')),vault=openVault(dir),memory=createMemory(vault);
  const review=createReview({vault,memory,ask,machines:()=>['box'],model:()=>({model:'fixture',provider:'claude'})});
  return {dir,vault,memory,review,close(){review.close();vault.close();fs.rmSync(dir,{recursive:true,force:true});}};}
const row=body=>({scope:'global',owner:'',name:'original',body});
const op=(action,target,name,body)=>({action,target,scope:'global',owner:'',name,body});
const group=operations=>({title:'拆分原文',reason:'一事一条',category:'split',operations});
async function ready(review,id){for(let i=0;i<100;i++){const r=review.read(id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,5));}throw Error('timeout');}
test('alignment detects exact cross-scope duplicates, retains full evidence and does not change memory',()=>{
  const f=fixture();try{
    const a=f.memory.save(row('中文规则 🌈')),b=f.memory.save({scope:'machine',owner:'box',name:'机器',body:'中文规则  🌈'});
    const r=f.review.alignment([{kind:'memory',id:a.id},{kind:'memory',id:b.id}]);
    assert.equal(r.pairs.length,1);assert.equal(r.pairs[0].kind,'identical');assert.equal(r.pairs[0].sameScope,false);assert.equal(f.memory.history(a.id).length,1);
    assert.throws(()=>f.review.alignment([{kind:'memory',id:a.id,revision:0}]),/版本已更新/);
  }finally{f.close();}
});
test('AI produces a proposal only; selected split group applies atomically with edits and provenance',async()=>{
  let sent;
  const f=fixture(async(...args)=>{sent=args;return {summary:'拆分建议',groups:[group([op('create','','条目一','第一条'),op('create','','条目二','第二条'),op('disable','item1','original','原文')]),group([op('create','','未选择','不应用')])]};});
  try{
    const a=f.memory.save(row('原文')),secret=f.memory.save({scope:'machine',owner:'box',name:'private',body:'UNSELECTED-MEMORY'});
    const started=f.review.start({refs:[{kind:'memory',id:a.id}],instruction:'逐条拆分',apiOnly:true});
    assert.equal((await ready(f.review,started.id)).status,'ready');assert.equal(f.memory.list().length,2);
    assert.equal(sent[2],'memory');assert.equal(sent[3].apiOnly,true);assert.ok(!sent[0].includes(secret.body));
    const applied=f.review.apply({id:started.id,groups:[0],edits:[{group:0,operation:0,body:'审阅后的第一条'}]});
    assert.equal(applied.changed.length,3);assert.equal(f.memory.list().find(x=>x.id===a.id).enabled,0);
    assert.equal(f.memory.list().find(x=>x.name==='条目一').body,'审阅后的第一条');assert.ok(!f.memory.list().some(x=>x.name==='未选择'));
    const r=f.review.read(started.id);assert.deepEqual(r.appliedGroups,[0]);assert.equal(r.result.groups[0].operations[0].body,'审阅后的第一条');
    assert.equal(f.memory.history(a.id).length,2);assert.throws(()=>f.review.apply({id:started.id,groups:[0]}),/已处理/);
  }finally{f.close();}
});
test('stale memory and observed source both block application; no silent rebase',()=>{
  const f=fixture();try{
    const a=f.memory.save(row('old')),ref={kind:'memory',id:a.id};
    const draft=f.review.manual({refs:[ref],groups:[group([op('update','item1','original','merged')])]});
    f.memory.save({...a,body:'newer'});assert.throws(()=>f.review.apply({id:draft.id,groups:[0]}),/已有更新/);
    const s={path:'/memory.md',scope:'machine',owner:'box',provider:'claude',body:'source old'};f.memory.observe('box',{items:[s]});
    const draft2=f.review.manual({refs:[{kind:'observed',machine:'box',path:s.path}],groups:[group([op('create','','new','new')])]});
    f.memory.observe('box',{items:[{...s,body:'source changed'}]});assert.throws(()=>f.review.apply({id:draft2.id,groups:[0]}),/来源文件已有更新/);
  }finally{f.close();}
});
test('one invalid change rolls back creates, revisions, publication version and apply status',()=>{
  const f=fixture();try{
    const a=f.memory.save(row('original'));
    const draft=f.review.manual({refs:[{kind:'memory',id:a.id}],groups:[group([op('create','','created-first','new'),op('create','','original','duplicate')])]});
    const version=f.vault.db.prepare("SELECT value FROM vault_meta WHERE key='memory_version'").get().value;
    assert.throws(()=>f.review.apply({id:draft.id,groups:[0]}),/同名记忆/);
    assert.equal(f.memory.list().length,1);assert.equal(f.memory.history(a.id).length,1);assert.equal(f.review.read(draft.id).status,'ready');
    assert.equal(f.vault.db.prepare("SELECT value FROM vault_meta WHERE key='memory_version'").get().value,version);
  }finally{f.close();}
});
test('unselected targets, invented owners and managed markers never become applicable proposals',async()=>{
  const f=fixture(async()=>({summary:'bad',groups:[group([op('disable','unselected','bad','bad')])]}));try{
    const a=f.memory.save(row('original')),refs=[{kind:'memory',id:a.id}];
    const r=await ready(f.review,f.review.start({refs}).id);assert.equal(r.status,'failed');assert.match(r.error,/所选/);
    assert.throws(()=>f.review.manual({refs,groups:[group([{...op('create','','new','body'),scope:'machine',owner:'invented'}])]}),/未知/);
    assert.throws(()=>f.review.manual({refs,groups:[group([op('create','','new','<!-- ametyping-memory:start -->')])]}),/正文/);
    assert.equal(f.memory.list().length,1);
  }finally{f.close();}
});
test('API-only calls use HTTP with base-path preservation and never invoke a CLI on failure',async()=>{
  const requests=[];let fail=false,compat=false;
  const server=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{
    requests.push({path:req.url,key:req.headers['x-api-key'],body:JSON.parse(b)});
    if(fail){res.writeHead(503);return res.end('{"error":{"message":"fixture API unavailable"}}');}
    if(compat&&JSON.parse(b).output_config){res.writeHead(400);return res.end('{"error":{"message":"output_config unsupported parameter"}}');}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('event: content_block_delta\ndata: '+JSON.stringify({delta:{type:'text_delta',text:'{"summary":"ok","groups":[]}'}})+'\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n');
  });});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const schema={type:'object',properties:{summary:{type:'string'},groups:{type:'array',items:{type:'string'}}},required:['summary','groups']};
  const cli={bin:'CLI-MUST-NOT-RUN',timeoutMs:2000};
  try{
    const a=createAsk({codex:cli,claude:cli,api:{key:()=> 'fixture-key',base:base+'/prefix',timeoutMs:2000},pick:()=>({provider:'claude',model:'fixture'})});
    assert.equal((await a.ask('fixture',schema,'memory',{apiOnly:true})).summary,'ok');assert.equal(requests[0].path,'/prefix/v1/messages');
    fail=true;await assert.rejects(a.ask('fixture',schema,'memory',{apiOnly:true}),/fixture API unavailable/);assert.equal(a.state().length,0);
    const noKey=createAsk({codex:cli,claude:cli,api:{key:()=>''},pick:()=>({provider:'claude',model:'fixture'})});
    await assert.rejects(noKey.ask('fixture',schema,'memory',{apiOnly:true}),/没有配置/);
    fail=false;
    const alias=createAsk({codex:cli,claude:cli,egress:{pick:()=>{throw Error('direct entry must not use inherited proxy');}},
      claudeApis:{resolve:()=>({proxy:'direct',settings:{env:{ANTHROPIC_BASE_URL:base+'/anthropic',ANTHROPIC_AUTH_TOKEN:'alias-key'}}})},
      pick:()=>({provider:'claude',api:'deepseek',model:'deepseek-flash[1m]'})});
    await alias.ask('fixture',schema,'memory',{apiOnly:true});assert.equal(requests.at(-1).path,'/anthropic/v1/messages');assert.equal(requests.at(-1).key,'alias-key');
    assert.equal(requests.at(-1).body.model,'deepseek-flash[1m]');
    compat=true;await alias.ask('fixture',schema,'memory',{apiOnly:true});assert.equal(requests.at(-1).body.output_config,undefined);assert.match(requests.at(-1).body.system,/JSON Schema/);
  }finally{await new Promise(r=>server.close(r));}
});
