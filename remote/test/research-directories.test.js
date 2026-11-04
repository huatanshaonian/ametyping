'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {openVault,hash}=require('../server/vault/database'),{createResearchStore}=require('../server/research/database'),{createDirectories}=require('../server/research/directories');
test('directory summaries combine sessions, preserve separate machines, validate evidence and persist revisions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ame-dir-')),v=openVault(dir),store=createResearchStore(v);
  try{
    const add=(machine,cwd,session)=>{const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:'计算完成，误差收敛；'+session}})),key=hash(session);
      const b=v.begin(machine,{key,path:cwd+'/'+session+'.jsonl',provider:'claude',session,kind:'native',cwd,size:bytes.length,mtime:1});
      v.append(machine,{key,generation:b.generation,start:0,data:bytes.toString('base64'),sha256:hash(bytes)});v.finish(machine,{key,generation:b.generation,sha256:hash(bytes)});
      return store.importSource('p',{machine,key});};
    const a=add('win','G:\\CEM_PO','s1'),b=add('win','G:/CEM_PO','s2'),c=add('dell','G:/CEM_PO','s3');
    const review={catalog:()=>[{id:'p',directories:[{machine:'win',path:'G:/CEM_PO'},{machine:'dell',path:'G:/CEM_PO'}]}]},d=createDirectories({vault:v,review});
    const initial=d.list('p');assert.equal(initial.length,2);assert.equal(initial[0].sessions,2);assert.equal(initial[0].documents,2);
    const ev=[...store.events(a.id)][0],foreign=[...store.events(c.id)][0];
    const body={overview:'此目录跨会话完成计算与误差检查。',work:[{title:'计算验证',description:'综合两次计算',results:['误差收敛'],outputs:[],questions:[],evidence:[{event_id:ev.id,quote:'计算完成，误差收敛'}]}],next_steps:['继续扩大算例']};
    const saved=d.change({project:'p',id:initial[0].id,revision:0,action:'save',body});assert.equal(saved.body.work.length,1);assert.equal(saved.evidenceDocuments,2);
    assert.throws(()=>d.change({project:'p',id:saved.id,revision:0,action:'confirm'}),/已有更新/);
    assert.throws(()=>d.change({project:'p',id:saved.id,revision:1,action:'save',body:{...body,work:[{...body.work[0],evidence:[{event_id:foreign.id,quote:'计算完成'}]}]}}),/来源不匹配/);
    const confirmed=d.change({project:'p',id:saved.id,revision:1,action:'confirm'});assert.equal(confirmed.status,'confirmed');
    const reopened=createDirectories({vault:v,review});assert.equal(reopened.list('p')[0].body.overview,body.overview);assert.equal(reopened.list('p')[1].body,null);
    add('win','G:/CEM_PO','s4');assert.equal(d.list('p')[0].changed,true);assert.equal(d.list('p')[0].sessions,3);
    assert.equal(v.db.prepare('select count(*) n from research_directory_history').get().n,2);
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
