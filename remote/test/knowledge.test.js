'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {openVault,hash,CHUNK}=require('../server/vault/database');
const {createMemory}=require('../server/vault/memory');
const {createMemorySync,START}=require('../agent/memory-sync');
const {createNativeArchive,catalog,compactAgyToolOutputs}=require('../agent/native-archive');
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
    assert.match(fs.readFileSync(path.join(home,'.gemini/GEMINI.md'),'utf8'),/你好 🌈/);
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
    // Reconnect with unchanged files: begin returns complete=true, zero chunk/finish round-trips.
    collector.reset();collector.ready();
    const actions=[];
    for(let i=0;i<20;i++){
      await collector.tick();await new Promise(r=>setImmediate(r));
      const d=queue.shift();if(!d)break;actions.push(d.action);
      const r=(d.action==='begin'?v.begin:d.action==='chunk'?v.append:v.finish)('box',d);
      collector.handle({t:'vault-result',rid:d.rid,ok:true,...r});
    }
    assert.deepEqual(actions,['begin','begin','begin','begin']);
    // Touch mtime on a cold reconnect (sent cleared): probe asks for sha256 and keeps the same generation without re-uploading chunks.
    const nextMtime=new Date(fs.statSync(file).mtimeMs+5000);fs.utimesSync(file,nextMtime,nextMtime);
    collector.reset();collector.ready();
    const touchActions=[];
    for(let i=0;i<20;i++){
      await collector.tick();await new Promise(r=>setImmediate(r));
      const d=queue.shift();if(!d)break;touchActions.push(d.action);
      const r=(d.action==='begin'?v.begin:d.action==='chunk'?v.append:v.finish)('box',d);
      collector.handle({t:'vault-result',rid:d.rid,ok:true,...r});
    }
    assert.ok(!touchActions.includes('chunk')&&!touchActions.includes('finish'));
    assert.equal(v.list().find(x=>x.path===file).generation,s.generation);
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
  const agyLines=Buffer.from(
    JSON.stringify({type:'USER_INPUT',created_at:'2026-10-30T00:00:00Z',content:'<USER_REQUEST>\n帮我检查代码\n</USER_REQUEST>'})+'\n'+
    JSON.stringify({type:'PLANNER_RESPONSE',created_at:'2026-10-30T00:00:02Z',content:'好的，已经检查完毕。'})+'\n'+
    JSON.stringify({type:'PLANNER_RESPONSE',created_at:'2026-10-30T00:00:03Z',tool_calls:[{id:'1',name:'default_api:read_file',arguments:{Path:'/project/a.js'}}]})+'\n'
  );
  const agyRes=JSON.parse(Buffer.concat([...convert({provider:'agy',machine:'box',session:'agy:c1',key:'k',generation:'g',digest:'d',created:1},[agyLines],'/project')]).toString());
  assert.equal(agyRes.messages.length,3);
  assert.equal(agyRes.messages[0].type,'user');assert.equal(agyRes.messages[0].text,'帮我检查代码');
  assert.equal(agyRes.messages[1].type,'assistant');assert.equal(agyRes.messages[1].content[0].text,'好的，已经检查完毕。');
  assert.equal(agyRes.messages[2].type,'synthetic');
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
test('Antigravity tool outputs compact incrementally into tool_outputs.jsonl, shield raw step files, and clean up settled files',()=>{
  const home=temp();
  const sys=path.join(home,'.gemini/antigravity-cli/brain/s1/.system_generated');
  const tf=path.join(sys,'logs/transcript_full.jsonl');
  const step1=path.join(sys,'steps/1/output.txt'),step2=path.join(sys,'steps/2/output.txt'),task1=path.join(sys,'tasks/task-1.log');
  try{
    write(path.join(home,'.gemini/antigravity-cli/history.jsonl'),JSON.stringify({conversationId:'s1',workspace:'/proj',display:'t'})+'\n');
    write(path.join(sys,'logs/transcript.jsonl'),JSON.stringify({step_index:0,type:'USER_INPUT',content:'Active Workspaces:\n- /proj\n<USER_REQUEST>hi</USER_REQUEST>'})+'\n');
    write(tf,JSON.stringify({step_index:2,type:'GENERIC',content:'truncated: file:///brain/s1/.system_generated/steps/2/output.txt and tasks/task-1.log'})+'\n');
    write(step1,'short inline output\n');
    write(step2,'long truncated output\n');
    write(task1,'background task log\n');
    const list1=catalog(home,{agyActiveMs:60000});
    const agyFiles=list1.filter(x=>x.provider==='agy');
    assert.ok(agyFiles.some(x=>x.file.endsWith('tool_outputs.jsonl')&&x.kind==='tool-output'&&x.cwd==='/proj'));
    assert.ok(!agyFiles.some(x=>x.file.includes('output.txt')||x.file.endsWith('.log')));
    assert.ok(!fs.existsSync(step1));
    assert.ok(fs.existsSync(step2)&&fs.existsSync(task1));
    const lines1=fs.readFileSync(path.join(sys,'logs/tool_outputs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines1.length,3);
    assert.deepEqual(lines1.map(x=>x.type+':'+x.id),['step:1','step:2','task:task-1']);
    // Re-running does not duplicate existing entries, and activeMs=0 cleans up aged referenced files and empty dirs
    compactAgyToolOutputs(path.join(home,'.gemini/antigravity-cli/brain'),{activeMs:0});
    const lines2=fs.readFileSync(path.join(sys,'logs/tool_outputs.jsonl'),'utf8').trim().split('\n');
    assert.equal(lines2.length,3);
    assert.ok(!fs.existsSync(step2)&&!fs.existsSync(task1));
    assert.ok(!fs.existsSync(path.join(sys,'steps'))&&!fs.existsSync(path.join(sys,'tasks')));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('projects map several directories per machine, merge linked 项目管理 workspaces, rename and delete safely',()=>{
  const dir=temp(),v=openVault(dir);let ws=[{machine:'win',path:'D:/linked',tag:'code'},{machine:'win',path:'D:/data',tag:'data'}];
  const m=createMemory(v,{linked:id=>id==='proj_x'?ws:[]});
  try{
    // Old single-path mappings migrate into project_dirs on open.
    v.db.prepare("INSERT INTO projects(id,name) VALUES('old','Old')").run();v.db.prepare("INSERT INTO project_paths VALUES('old','win','D:/old')").run();
    v.db.prepare("DELETE FROM vault_meta WHERE key='project_dirs_migrated'").run();
    const m2=createMemory(v);assert.deepEqual(m2.projects().filter(p=>p.id==='old').map(p=>p.path),['D:/old']);
    m.project({id:'cem',name:'CEM',mesh:'proj_x',paths:[{machine:'win',path:'D:/a'},{machine:'win',path:'D:/b'},{machine:'linux',path:'/home/u/cem'}]});
    const mem=m.save({scope:'project',owner:'cem',name:'规则',body:'先验证'});
    const b=m.bundle('win'),t=b.targets.find(x=>x.target==='cem');
    assert.deepEqual(t.dirs.map(d=>d.path+':'+d.source),['D:/a:manual','D:/b:manual','D:/linked:linked']);
    assert.equal(t.path,'D:/a');assert.equal(b.projects.find(p=>p.id==='cem').dirs.length,3);
    // A workspace change in 项目管理 changes the published signature without touching SQLite.
    const sig=m.linkSignature();ws=[...ws,{machine:'win',path:'D:/more',tag:'solver'}];assert.notEqual(m.linkSignature(),sig);
    m.project({id:'cem',name:'CEM',paths:[{machine:'win',path:'D:/b',remove:true}]});
    assert.deepEqual(m.bundle('win').targets.find(x=>x.target==='cem').dirs.map(d=>d.path),['D:/a','D:/linked','D:/more']);
    m.deployed('win',{target:'cem',revision:'r',ok:true,dirs:[{path:'D:/a',source:'manual',branch:'main',ok:true}]});
    assert.equal(m.deployments().find(x=>x.target==='cem').dirs[0].branch,'main');
    m.project({op:'rename',id:'cem',to:'cem2',name:'CEM 电磁求解器'});
    const moved=v.db.prepare('SELECT * FROM memory WHERE id=?').get(mem.id);
    assert.equal(moved.owner,'cem2');assert.equal(m.history(mem.id).length,2);
    assert.ok(!m.projects().some(p=>p.id==='cem'));assert.equal(m.projects().find(p=>p.id==='cem2').mesh,'proj_x');
    assert.ok(!m.deployments().some(x=>x.target==='cem'));
    assert.throws(()=>m.project({op:'delete',id:'cem2'}),/启用的记忆/);
    m.project({op:'delete',id:'old'});assert.ok(!m.projects().some(p=>p.id==='old'));
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('agent writes every directory and expanded worktree, excludes generated files from git, and retires a renamed target',async()=>{
  const home=temp(),repo=path.join(home,'CEM_1','main'),wt=path.join(home,'CEM_1','fdtd'),plain=path.join(home,'notes');
  for(const d of [repo,wt,plain])fs.mkdirSync(d,{recursive:true});
  fs.mkdirSync(path.join(repo,'.git'));write(path.join(wt,'.git'),'gitdir: x\n');
  const excluded=[];const sent=[];
  const sync=createMemorySync({home,name:'box',send:d=>sent.push(d),canWrite:()=>true,folder:async p=>fs.realpathSync(p),
    worktrees:async r=>fs.realpathSync(r)===fs.realpathSync(repo)||fs.realpathSync(r)===fs.realpathSync(wt)?[{path:fs.realpathSync(repo),branch:'mom_dev'},{path:fs.realpathSync(wt),branch:'fdtd_dev'}]:null,
    gitExclude:async(dir,names)=>excluded.push(dir)});
  const bundle=id=>({t:'memory-bundle',machine:'box',projects:[{id,path:path.join(home,'CEM_1'),dirs:[{path:path.join(home,'CEM_1'),source:'manual'},{path:plain,source:'linked'}]}],
    targets:[{target:id,path:path.join(home,'CEM_1'),dirs:[{path:path.join(home,'CEM_1'),source:'manual'},{path:plain,source:'linked'}],revision:'b'.repeat(64),items:[{id:'fixture',name:'规则',body:'CEM-MANAGED'}]}]});
  try{
    await sync.handle(bundle('cem-po'));
    for(const d of [path.join(home,'CEM_1'),repo,wt,plain])assert.match(fs.readFileSync(path.join(d,'CLAUDE.md'),'utf8'),/CEM-MANAGED/,d);
    const ack=sent.find(x=>x.t==='memory-applied'&&x.target==='cem-po');
    // CEM_1 is a plain folder, so both child repositories arrive as worktrees with their branches.
    assert.ok(ack.ok);assert.deepEqual(ack.dirs.filter(d=>d.source==='worktree').map(d=>d.branch).sort(),['fdtd_dev','mom_dev']);
    assert.equal(ack.dirs.find(d=>fs.realpathSync(d.path)===fs.realpathSync(repo)).branch,'mom_dev');
    assert.equal(excluded.length,4);
    // Rename: the same files now belong to the new ID and must stay written.
    await sync.handle(bundle('cem'));
    for(const d of [repo,wt,plain])assert.match(fs.readFileSync(path.join(d,'AGENTS.md'),'utf8'),/CEM-MANAGED/,d);
    await sync.handle({t:'memory-bundle',machine:'box',projects:[],targets:[]});
    for(const d of [repo,wt,plain])assert.equal(fs.readFileSync(path.join(d,'AGENTS.md'),'utf8'),'');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
