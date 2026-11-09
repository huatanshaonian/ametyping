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
test('incremental autoReview auto-publishes safe factual creates, holds conflicts for manual review, and skips unchanged sources with zero LLM calls',async()=>{
  let llmCalls=0;
  const f=fixture(async()=>{
    llmCalls++;
    return {
      summary:'增量自动审阅结果',
      groups:[
        {title:'新增个人偏好',reason:'明确无争议的事实与偏好',category:'rewrite',operations:[{action:'create',target:'',scope:'global',owner:'',name:'画图字体偏好',body:'使用 Microsoft YaHei'}]},
        {title:'路径矛盾待核对',reason:'与现有规则存在冲突',category:'conflict',operations:[{action:'update',target:'item2',scope:'global',owner:'',name:'original',body:'冲突合并草案'}]}
      ]
    };
  });
  try{
    f.memory.save(row('existing rule'));
    // 1. No observed sources -> 0 LLM calls
    const r0=await f.review.autoReview();
    assert.equal(r0.skipped,true);assert.equal(llmCalls,0);
    // 2. Observed source identical to existing memory -> covered without LLM call
    f.memory.observe('box',{items:[{path:'/same.md',scope:'machine',owner:'box',provider:'claude',body:'existing rule'}]});
    const r1=await f.review.autoReview();
    assert.equal(r1.skipped,true);assert.equal(llmCalls,0);
    // 3. New observed source -> 1 LLM call, safe group auto-published, conflict group held as 'ready'
    f.memory.observe('box',{items:[{path:'/new.md',scope:'machine',owner:'box',provider:'claude',body:'新增画图字体偏好与路径说明'}]});
    const r2=await f.review.autoReview();
    assert.equal(r2.skipped,false);assert.equal(llmCalls,1);
    assert.equal(r2.autoApplied,1);assert.equal(r2.pendingManual,1);
    assert.ok(f.memory.list().some(m=>m.name==='画图字体偏好'&&m.enabled===1));
    assert.equal(f.review.read(r2.id).status,'ready');
    assert.equal(f.review.read(r2.id).result.groups.length,1);
    assert.equal(f.review.read(r2.id).result.groups[0].category,'conflict');
    // 4. Subsequent autoReview with no new source changes -> skipped with 0 additional LLM calls
    const r3=await f.review.autoReview();
    assert.equal(r3.skipped,true);assert.equal(llmCalls,1);
  }finally{f.close();}
});
test('monthlyReview flags defensive/expression/outdated issues without auto-modifying memory, and supports manual edits, appended ops, partial apply and ignoreGroup',async()=>{
  let calls=0;
  const f=fixture(async()=>{
    calls++;
    return {
      summary:'2026-11 月度记忆体检报告',
      groups:[
        {title:'收敛过度防御规则',reason:'原表述过于绝对死板',category:'defensive',operations:[{action:'update',target:'item1',scope:'global',owner:'',name:'original',body:'适度边界规则'}]},
        {title:'清理已完成的旧重构记录',reason:'重构已在10月完成，无需继续作为活跃指令',category:'outdated',operations:[{action:'disable',target:'item2',scope:'global',owner:'',name:'z-old-task',body:'正在重构某模块'}]}
      ]
    };
  });
  try{
    const m1=f.memory.save(row('严禁任何情况下触碰此模块'));
    const m2=f.memory.save({scope:'global',owner:'',name:'z-old-task',body:'正在重构某模块'});
    const res=await f.review.monthlyReview({month:'2026-11'});
    assert.equal(res.skipped,false);assert.equal(res.autoApplied,0);assert.equal(res.pendingManual,2);
    // Memory is untouched before manual confirmation
    assert.equal(f.memory.list().find(x=>x.id===m1.id).body,'严禁任何情况下触碰此模块');
    assert.equal(f.memory.list().find(x=>x.id===m2.id).enabled,1);
    // Same month does not re-run unless forced
    assert.equal((await f.review.monthlyReview({month:'2026-11'})).skipped,true);
    assert.equal(calls,1);
    // User edits group 0 AND appends a manual create operation inside group 0, applying only group 0 with keepUnselected=true
    const applied=f.review.apply({
      id:res.id,
      groups:[0],
      keepUnselected:true,
      groupOperations:{
        0:[
          {action:'update',target:'item1',scope:'global',owner:'',name:'original',body:'人工修改后的适度规则'},
          {action:'create',target:'',scope:'global',owner:'',name:'人工补充说明',body:'手动追加的补充条目'}
        ]
      }
    });
    assert.equal(applied.changed.length,2);
    assert.ok(applied.remainingId);
    assert.equal(f.memory.list().find(x=>x.id===m1.id).body,'人工修改后的适度规则');
    assert.ok(f.memory.list().some(x=>x.name==='人工补充说明'&&x.body==='手动追加的补充条目'));
    // Remaining group (group 1 -> now index 0 in remainingId) is still ready for review or ignoreGroup
    const rem=f.review.read(applied.remainingId);
    assert.equal(rem.status,'ready');assert.equal(rem.result.groups.length,1);assert.equal(rem.result.groups[0].category,'outdated');
    const ignored=f.review.ignoreGroup({id:applied.remainingId,group:0});
    assert.equal(ignored.status,'discarded');
  }finally{f.close();}
});
test('reviews may propose new project IDs, but registering them requires explicit approval; autoReview never auto-registers projects',async()=>{
  let sent;
  const proj=(owner,name,body)=>({action:'create',target:'',scope:'project',owner,name,body});
  const f=fixture(async(prompt)=>{sent=prompt;return {summary:'项目归属',groups:[
    {title:'已登记项目规则',reason:'项目规范',category:'scope',operations:[proj('cem-po','求解器约定','CEM 约定')]},
    {title:'新项目规则',reason:'项目规范',category:'scope',operations:[proj('mom-dev','MoM 约定','MoM 约定')]}]};});
  try{
    f.memory.project({id:'cem-po',name:'CEM_PO',paths:[{machine:'box',path:'/w/CEM_PO'}]});
    f.memory.observe('box',{items:[{path:'/home/u/.claude/projects/-home-u-mom_dev/memory/a.md',scope:'machine',owner:'box',provider:'claude',body:'MoM 新规则'}]});
    const auto=await f.review.autoReview();
    assert.match(sent,/cem-po/);assert.match(sent,/-home-u-mom_dev/);
    assert.equal(auto.autoApplied,1);assert.equal(auto.pendingManual,1);
    assert.ok(!f.memory.projects().some(p=>p.id==='mom-dev'));
    const r=f.review.read(auto.id);assert.deepEqual(r.newProjects,['mom-dev']);
    assert.throws(()=>f.review.apply({id:auto.id,groups:[0]}),/需要确认新项目：mom-dev/);
    assert.ok(!f.memory.list().some(m=>m.name==='MoM 约定'));
    f.review.apply({id:auto.id,groups:[0],approveProjects:['mom-dev']});
    assert.ok(f.memory.projects().some(p=>p.id==='mom-dev'));
    assert.ok(f.memory.list().some(m=>m.scope==='project'&&m.owner==='mom-dev'&&m.name==='MoM 约定'));
    const bad=f.memory.save(row('x'));
    assert.throws(()=>f.review.manual({refs:[{kind:'memory',id:bad.id}],groups:[group([proj('global','n','b')])]}),/未知/);
  }finally{f.close();}
});
