'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {openVault,hash,CHUNK}=require('../server/vault/database');
const {createMemory}=require('../server/vault/memory');
const {createMemorySync,START}=require('../agent/memory-sync');
const {createNativeArchive,catalog}=require('../agent/native-archive');
const {convert,lines}=require('../server/vault/opencode');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ame-knowledge-test-'));
const write=(file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
test('byte-exact SQLite archive survives reopen, duplicate ACK, generation rewrite and backup',async()=>{
  const dir=temp();let v=openVault(dir);
  try{
    const b=Buffer.concat([Buffer.from('你好\n'),crypto.randomBytes(CHUNK*2+30)]),key=hash('file');
    const d={key,provider:'claude',session:'session',parent:'',kind:'native',path:'/home/x/session.jsonl',cwd:'/work',size:b.length,mtime:1};
    const begin=v.begin('box',d);let offset=0;
    for(;offset<b.length;){const bytes=b.subarray(offset,offset+CHUNK),c={key,generation:begin.generation,start:offset,data:bytes.toString('base64'),sha256:hash(bytes)};
      assert.equal(v.append('box',c).offset,offset+bytes.length);assert.equal(v.append('box',c).offset,offset+bytes.length);offset+=bytes.length;}
    assert.throws(()=>v.finish('box',{key,generation:begin.generation,sha256:hash('wrong')}),/校验/);
    assert.equal(v.finish('box',{key,generation:begin.generation,sha256:hash(b)}).complete,true);
    assert.deepEqual(Buffer.concat([...v.data('box',key,begin.generation)]),b);
    assert.equal(v.list()[0].bytes,b.length);
    v.close();v=openVault(dir);assert.equal(v.begin('box',d).offset,b.length);
    const rewritten=v.begin('box',{...d,mtime:2});assert.notEqual(rewritten.generation,begin.generation);
    assert.equal(v.source('box',key,begin.generation).complete,1);
    await v.snapshot(path.join(dir,'copy.sqlite'));assert.ok(fs.statSync(path.join(dir,'copy.sqlite')).size>0);
    await v.snapshot(path.join(dir,'copy.sqlite'));
    assert.throws(()=>v.begin('box',{...d,key:'../bad'}),/无效/);
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('three scopes, observed source history, optimistic edits, deactivation and stable bundle revisions',()=>{
  const dir=temp(),v=openVault(dir),m=createMemory(v);
  try{
    const a=m.save({scope:'global',owner:'',name:'共同偏好',body:'使用中文'});
    const local=m.save({scope:'machine',owner:'win',name:'Windows',body:'用 PowerShell'});
    m.save({scope:'machine',owner:'linux',name:'Linux',body:'用 bash'});
    const project=m.save({scope:'project',owner:'ame',name:'代码规则',body:'运行测试'});
    m.project({id:'ame',name:'AmeTyping',paths:[{machine:'win',path:'D:\\ame'},{machine:'linux',path:'/home/u/ame'}]});
    assert.deepEqual(m.effective('win','ame').map(x=>x.id),[a.id,local.id,project.id]);
    const b=m.bundle('win');assert.equal(b.targets[0].items.length,2);assert.equal(b.targets[1].items.length,1);
    assert.equal(m.bundle('win').targets[0].revision,b.targets[0].revision);
    assert.throws(()=>m.save({...a,body:'stale',revision:0}),/已被修改/);
    const edited=m.save({...a,body:'简洁中文'});assert.equal(m.history(a.id).length,2);
    m.save({...edited,enabled:false});assert.equal(m.effective('win').length,1);
    const source={path:'/home/u/.claude/CLAUDE.md',scope:'machine',owner:'linux',provider:'claude',body:'local original'};
    m.observe('linux',{items:[source]});m.observe('linux',{items:[{...source,body:'new original'}]});
    assert.equal(v.db.prepare('SELECT count(*) AS n FROM memory_observed_history').get().n,2);
    assert.throws(()=>m.promoted({machine:'linux',path:source.path,sha256:hash(source.body),scope:'global',owner:'',name:'old'}),/已改变/);
    assert.equal(m.list().length,4); // observations never silently become published instructions
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('memory export preserves Unicode and local content, follows Codex override, detects edits and supports deactivation',async()=>{
  const home=temp(),project=path.join(home,'project'),sent=[];
  const globals=path.join(home,'.claude/CLAUDE.md'),codex=path.join(home,'.codex/AGENTS.override.md');
  write(globals,'本机原有规则 😀\n');write(codex,'现有覆盖规则\n');fs.mkdirSync(project);
  const m=createMemorySync({home,name:'win',send:d=>sent.push(d),folder:async p=>{assert.equal(p,project);return p;},canWrite:()=>true});
  const item={id:crypto.randomUUID(),scope:'global',name:'共同记忆',body:'新规则：你好 🌈',revision:1};
  const bundle={t:'memory-bundle',machine:'win',projects:[{id:'ame',path:project}],targets:[{target:'global',revision:'a'.repeat(64),items:[item]},
    {target:'ame',path:project,revision:'b'.repeat(64),items:[{...item,scope:'project'}]}]};
  try{
    await m.handle(bundle);assert.match(fs.readFileSync(globals,'utf8'),/本机原有规则 😀/);assert.match(fs.readFileSync(globals,'utf8'),/你好 🌈/);
    assert.match(fs.readFileSync(codex,'utf8'),/现有覆盖规则/);assert.ok(!fs.existsSync(path.join(home,'.codex/AGENTS.md')));
    assert.match(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),/共同记忆/);
    const unchanged=fs.readFileSync(globals,'utf8');await m.handle(bundle);assert.equal(fs.readFileSync(globals,'utf8'),unchanged);
    write(globals,unchanged.replace('你好 🌈','本机改动'));await m.handle(bundle);assert.equal(sent.at(-2).ok,false);assert.match(fs.readFileSync(globals,'utf8'),/本机改动/);
    write(globals,unchanged);await m.handle({...bundle,targets:[{target:'global',revision:'c'.repeat(64),items:[]}]});
    assert.ok(!fs.readFileSync(globals,'utf8').includes(START));assert.match(fs.readFileSync(globals,'utf8'),/本机原有规则/);
    assert.ok(sent.some(d=>d.t==='memory-observe'&&d.items.some(x=>x.body==='本机原有规则 😀\n')));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('catalog includes all historical providers and children, excludes credentials and symlinks; sender reconnect resumes committed bytes',async()=>{
  const home=temp(),dir=temp(),v=openVault(dir),queue=[];
  const file=path.join(home,'.claude/projects/p/session.jsonl'),b=Buffer.from(JSON.stringify({type:'user',cwd:home,message:{content:'原始输出'.repeat(100000)}})+'\n');
  write(file,b);write(path.join(home,'.claude/projects/p/session/subagents/agent-child.jsonl'),'child\n');
  write(path.join(home,'.claude/projects/p/session/tool-results/result.txt'),Buffer.from([0,1,255,128]));
  write(path.join(home,'.codex/sessions/2020/rollout.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'thread',cwd:home,parent_thread_id:'parent'}})+'\n');
  write(path.join(home,'.codex/auth.json'),'never archive this');
  const files=catalog(home);assert.equal(files.length,4);assert.equal(files.find(x=>x.provider==='codex').parent,'parent');assert.equal(files.find(x=>x.kind==='tool-output').session,'session');
  const collector=createNativeArchive({home,send:d=>queue.push(d)});collector.ready();
  try{
    for(let i=0;i<80;i++){
      await collector.tick();await new Promise(r=>setImmediate(r));
      const d=queue.shift();if(!d)continue;
      const r=(d.action==='begin'?v.begin:d.action==='chunk'?v.append:v.finish)('box',d);
      collector.handle({t:'vault-result',rid:d.rid,ok:true,...r});
      if(v.list().length===4&&v.list().every(s=>s.complete))break;
    }
    assert.equal(v.list().length,4);assert.ok(v.list().every(s=>s.complete));
    const s=v.list().find(x=>x.path===file);assert.deepEqual(Buffer.concat([...v.data('box',s.key,s.generation)]),b);
    collector.reset();collector.ready();await collector.tick();assert.equal(queue.shift().action,'begin');
  }finally{collector.reset();v.close();fs.rmSync(home,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
test('explicit adoption retires exact source after publication, keeps a backup, and refuses changed sources',async()=>{
  const home=temp(),dir=temp(),v=openVault(dir),m=createMemory(v),sent=[];
  const source=path.join(home,'.claude/CLAUDE.md'),body='原始机器规则 😀\n';write(source,body);
  const sync=createMemorySync({home,name:'box',send:d=>sent.push(d),canWrite:()=>true,folder:async()=>{throw Error('no projects');}});
  try{
    m.observe('box',{items:[{path:source,scope:'machine',owner:'box',provider:'claude',body}]});
    const entry=m.promoted({machine:'box',path:source,sha256:hash(body),scope:'machine',owner:'box',name:'托管机器规则',adopt:true,body:'NAS 新规则'});
    await sync.handle({t:'memory-bundle',...m.bundle('box')});
    const actual=fs.readFileSync(source,'utf8');assert.ok(!actual.includes('原始机器规则'));assert.match(actual,/NAS 新规则/);
    assert.ok(fs.readdirSync(path.join(home,'.ametyping/memory/backups')).length);
    await sync.handle({t:'memory-bundle',...m.bundle('box')});assert.equal(fs.readFileSync(source,'utf8'),actual);
    assert.equal(m.history(entry.id).length,1);
    assert.throws(()=>m.save({...entry,body:START}),/托管标记/);
  }finally{v.close();fs.rmSync(home,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
test('portable OpenCode conversion preserves huge Unicode records across byte boundaries without creating executable tools',()=>{
  const text='🌈工具输出'.repeat(200000),native=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:text}})+'\n';
  const b=Buffer.from(native),chunks=[b.subarray(0,9),b.subarray(9,110),b.subarray(110)];
  assert.equal([...lines(chunks)][0],native.trim());
  const s={provider:'codex',machine:'box',session:'codex:s',key:'a',generation:'g',digest:'d',created:1};
  const result=JSON.parse(Buffer.concat([...convert(s,chunks,'/project')]).toString());
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].type,'synthetic');assert.ok(result.messages[0].text.includes(text));
  assert.equal(result.info.metadata.ametyping.session,s.session);
});
test('read-only memory mode reports pending state and does not alter the user home',async()=>{
  const home=temp(),sent=[];
  try{
    const sync=createMemorySync({home,name:'box',send:d=>sent.push(d),canWrite:()=>true,autoApply:false});
    await sync.handle({t:'memory-bundle',machine:'box',projects:[],targets:[{target:'global',revision:'a'.repeat(64),items:[{id:'fixture',name:'test',body:'test'}]}]});
    assert.ok(!fs.existsSync(path.join(home,'.claude/CLAUDE.md')));assert.equal(sent.at(-1).ok,false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('moving or removing a project mapping retires only the previously managed blocks',async()=>{
  const home=temp(),a=path.join(home,'a'),b=path.join(home,'b');fs.mkdirSync(a);fs.mkdirSync(b);
  write(path.join(a,'AGENTS.md'),'local a\n');write(path.join(b,'AGENTS.md'),'local b\n');
  const sync=createMemorySync({home,name:'box',send:()=>{},canWrite:()=>true,folder:async p=>{assert.ok([a,b].includes(p));return p;}});
  const bundle=dir=>({t:'memory-bundle',machine:'box',projects:[{id:'project',path:dir}],targets:[{target:'project',path:dir,revision:'a'.repeat(64),items:[{id:'fixture',name:'project',body:'PROJECT-MANAGED'}]}]});
  try{
    await sync.handle(bundle(a));await sync.handle(bundle(b));
    assert.equal(fs.readFileSync(path.join(a,'AGENTS.md'),'utf8'),'local a\n');assert.match(fs.readFileSync(path.join(b,'AGENTS.md'),'utf8'),/PROJECT-MANAGED/);
    await sync.handle({t:'memory-bundle',machine:'box',projects:[],targets:[]});assert.equal(fs.readFileSync(path.join(b,'AGENTS.md'),'utf8'),'local b\n');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('NAS local participant uses the same durable archive and memory acknowledgement protocol',async()=>{
  const home=temp(),dir=temp(),machines=new Map(),machine={name:'nas',sockets:new Set()};machines.set('nas',machine);
  const {createVaultService}=require('../server/vault/service'),{attachLocal}=require('../server/vault/local');
  const s=createVaultService({dir,machines,control:true,fresh:()=>true,audit:()=>{}});
  write(path.join(home,'.claude/projects/p/session.jsonl'),'native NAS record\n');
  s.memory.save({scope:'global',owner:'',name:'共用',body:'NAS shared memory'});
  const local=attachLocal({service:s,machine,home});
  try{
    for(let n=0;n<50;n++){if(s.vault.list().some(x=>x.complete)&&s.memory.deployments().some(x=>x.status==='applied'))break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(s.vault.list().some(x=>x.complete));assert.match(fs.readFileSync(path.join(home,'.claude/CLAUDE.md'),'utf8'),/NAS shared memory/);
  }finally{local.stop();s.close();fs.rmSync(home,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
