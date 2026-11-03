'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {openVault,hash}=require('../server/vault/database');
const {createResearchStore}=require('../server/research/database');
const {createPilots}=require('../server/research/pilots');
test('pilot view is read-only, excludes controls and restricts evidence to real samples',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ame-pilot-view-')),folder=path.join(dir,'research-pilots','first-round');
  fs.mkdirSync(folder,{recursive:true});const v=openVault(folder),store=createResearchStore(v);
  try{
    const samples=[];
    for(const synthetic of [false,true]){
      const key=hash(String(synthetic)),raw=Buffer.from(JSON.stringify({type:'user',message:{content:synthetic?'control secret':'真实研究的证据🌈'}}));
      const b=v.begin('test',{key,path:'/cem/test.jsonl',provider:'claude',session:String(synthetic),parent:'',kind:'native',cwd:'/cem',size:raw.length,mtime:1});
      v.append('test',{key,generation:b.generation,start:0,data:raw.toString('base64'),sha256:hash(raw)});v.finish('test',{key,generation:b.generation,sha256:hash(raw)});
      const d=store.importSource('pilot',{machine:'test',key}),e=[...store.events(d.id)][0];
      samples.push({synthetic,document:d.id,name:String(synthetic),state:'succeeded',work:[{title:synthetic?'hidden control':'真实候选',evidence:[{event_id:e.id,quote:e.text,start:0}]}]});
    }
    fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify({at:new Date().toISOString(),provider:{model:'test'},samples}));
    const reader=createPilots(dir),before=JSON.stringify(v.db.prepare('SELECT * FROM research_events').all());
    assert.equal(reader.list().items[0].count,1);assert.equal(reader.read('first-round').samples.length,1);
    assert.ok(!JSON.stringify(reader.read('first-round')).includes('hidden control'));
    assert.equal(reader.evidence('first-round',samples[0].work[0].evidence[0].event_id).text,'真实研究的证据🌈');
    assert.throws(()=>reader.evidence('first-round',samples[1].work[0].evidence[0].event_id),/找不到真实样本/);
    assert.throws(()=>reader.read('../first-round'),/标识无效/);
    assert.equal(JSON.stringify(v.db.prepare('SELECT * FROM research_events').all()),before);
    assert.equal(v.db.prepare('SELECT count(*) n FROM research_jobs').get().n,0);
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
