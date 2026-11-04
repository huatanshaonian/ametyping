'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {openVault}=require('../server/vault/database');
const {createReview}=require('../server/research/review');
const {createResearchStore}=require('../server/research/database');
function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ame-review-')),v=openVault(dir);createResearchStore(v);
  const projects=[],samples=[{document:'doc-win',work:[work('a'),work('b')]},{document:'doc-linux',work:[work('c')]}];
  function work(id){return{id,title:id,objective:'研究 '+id,kind:'calculation',state:'reported_complete',evidence:[{event_id:id.repeat(64),quote:'原文 '+id}],runs:[],findings:[{text:'旧结论 '+id,basis:'reported',evidence:[]}],open_questions:[]};}
  const pilots={list:()=>({items:[{id:'round'}]}),read:()=>({samples}),documents:()=>[
    {id:'doc-win',machine:'win',cwd:'G:/feko_data/CEM_PO',session:'s1'},
    {id:'doc-linux',machine:'dell97',cwd:'/home/dell/CEM_PO',session:'s2'}]};
  const options={vault:v,pilots,listProjects:()=>projects,saveProject:d=>{const project={id:'p'+projects.length,...d,workspaces:[]};projects.push(project);return{ok:true,project};}};
  const review=createReview(options);review.seed();
  const act=(action,item,extra={})=>review.change({action,id:item.id,revisions:{[item.id]:item.revision},...extra});
  return{dir,v,projects,samples,review,options,act,close(){v.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
const patch=i=>({title:i.body.title,objective:i.body.objective,state:i.body.state,kind:i.body.kind,project:i.project,findings:i.body.findings.map(f=>f.text).join('\n')});
test('projects, work directories and review edits persist without overwriting source data',()=>{
  const t=setup();try{
    assert.equal(t.projects.length,1);assert.equal(t.projects[0].name,'CEM_PO');
    const catalog=t.review.catalog();assert.equal(catalog[0].counts.pending,3);assert.equal(catalog[0].directories.length,2);
    const original=JSON.stringify(t.samples),item=t.review.items('p0')[0];
    const [confirmed]=t.act('confirm',item);assert.equal(confirmed.status,'confirmed');
    assert.throws(()=>t.act('ignore',item),/已有更新/);
    const [edited]=t.act('edit',confirmed,{patch:{...patch(confirmed),title:'修正的研究目标',findings:'人工修正的结论'}});
    assert.equal(edited.body.findings[0].basis,'user');assert.equal(edited.body.evidence[0].pilot,'round');
    t.review.seed();assert.equal(t.review.get(edited.id).body.title,'修正的研究目标');assert.equal(JSON.stringify(t.samples),original);
    const reopened=createReview(t.options);assert.equal(reopened.get(edited.id).body.title,'修正的研究目标');
    const [undo]=t.act('undo',edited);assert.equal(undo.body.title,item.body.title);assert.equal(undo.status,'confirmed');
    const [pending]=t.act('undo',undo);assert.equal(pending.status,'pending');assert.equal(pending.canUndo,false);
  }finally{t.close();}
});
test('merge retains all sources and can be undone atomically after later operations are undone',()=>{
  const t=setup();try{
    const items=t.review.items('p0'),rows=[items.find(i=>i.body.title==='a'),items.find(i=>i.body.title==='c')];
    const merged=t.review.change({action:'merge',ids:rows.map(r=>r.id),revisions:Object.fromEntries(rows.map(r=>[r.id,r.revision])),title:'合并后的同一研究'});
    const target=merged.find(r=>r.status==='pending'),source=merged.find(r=>r.status==='merged');
    assert.equal(target.body.evidence.length,2);assert.equal(target.origins.length,2);assert.equal(source.merged_into,target.id);
    assert.equal(t.review.catalog()[0].counts.merged,1);
    const [confirmed]=t.act('confirm',target);
    assert.throws(()=>t.act('undo',source),/后续修改/);
    const [unconfirmed]=t.act('undo',confirmed);const restored=t.act('undo',unconfirmed);
    assert.equal(restored.length,2);assert.ok(restored.every(r=>r.status==='pending'));assert.equal(t.review.catalog()[0].counts.pending,3);
    const [ignored]=t.act('ignore',t.review.get(source.id));assert.equal(ignored.status,'ignored');
    const [active]=t.act('restore',ignored);assert.equal(active.status,'pending');
  }finally{t.close();}
});
test('moving an edited item associates its source directories with the destination project',()=>{
  const t=setup();try{
    t.projects.push({id:'other',name:'其他研究',workspaces:[]});const item=t.review.items('p0')[0];
    const [moved]=t.act('edit',item,{patch:{...patch(item),project:'other'},confirm:true});
    assert.equal(moved.project,'other');assert.equal(moved.status,'confirmed');assert.equal(t.review.catalog().find(p=>p.id==='other').directories.length,1);
    assert.throws(()=>t.act('edit',moved,{patch:{...patch(moved),state:'bad'}}),/状态无效/);
  }finally{t.close();}
});
