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

test('AI discover and summarize workflow with Magpie gemini-4-hydrogen imports sessions and verifies verbatim evidence',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ame-dir-ai-')),v=openVault(dir),store=createResearchStore(v);
  try{
    const {createReview}=require('../server/research/review');
    const projects=[{id:'proj_cem',name:'CEM_PO',workspaces:[]}];
    const addSession=(machine,cwd,session,text)=>{
      const bytes=Buffer.from(JSON.stringify({type:'assistant',message:{content:text}})+'\n'),key=hash(machine+':'+session);
      const b=v.begin(machine,{key,path:cwd+'/'+session+'.jsonl',provider:'claude',session,kind:'native',cwd,size:bytes.length,mtime:1});
      v.append(machine,{key,generation:b.generation,start:0,data:bytes.toString('base64'),sha256:hash(bytes)});
      v.finish(machine,{key,generation:b.generation,sha256:hash(bytes)});
    };
    addSession('dell97','/home/dell/CEM_1/CEM_FDTD','fdtd-s1','FDTD 空域泄漏门控实测为 -62.7 dB，CW001 三档网格收敛验证完成。');
    addSession('huatanshaonian','G:/feko_data/CW_geometry','cw-s1','乘波体 100 个算例 My_Merged_Surface.igs 对称面拼接与 OCC 闭合实体核验通过。');

    const review=createReview({
      vault:v,
      pilots:{list:()=>({items:[]})},
      listProjects:()=>projects,
      saveProject:d=>{const p={id:'proj_'+projects.length,...d,workspaces:[]};projects.push(p);return{ok:true,project:p};},
    });
    review.directory('proj_cem','dell97','/home/dell/CEM_1/CEM_FDTD','Git Worktree','fdtd_dev');

    const mockMagpie={
      models:()=>[{id:'antigravity/gemini-4-hydrogen',name:'Gemini 4 Hydrogen'}],
      poll:async()=>{},
      run:async({prompt})=>{
        if(prompt.includes('候选目录')){
          return {classified_dirs:[{machine:'huatanshaonian',path:'G:/feko_data/CW_geometry',project_id:'proj_cem',branch:'geometry_prep'}]};
        }
        return {
          overview:'该目录承载 GPU FDTD 求解器开发与 CW001 乘波体全波验证。',
          work:[{
            title:'FDTD 边界门控与 CW001 收敛对标',
            description:'完成空域泄漏门控与三档网格验证',
            results:['空域泄漏 -62.7 dB'],
            outputs:['solvers/fdtd/grid.py'],
            questions:[],
            evidence_refs:['U1'],
          }],
          next_steps:['推进共形网格改造'],
        };
      },
    };

    const d=createDirectories({vault:v,review,store,getMagpie:()=>mockMagpie,listProjects:()=>projects});
    const disc=await d.discover({model:'antigravity/gemini-4-hydrogen'});
    assert.equal(disc.added.length,1);
    assert.equal(disc.added[0].path,'G:/feko_data/CW_geometry');

    const sumAll=await d.summarizeAll({project:'proj_cem',model:'antigravity/gemini-4-hydrogen'});
    assert.equal(sumAll.completed.length,2);
    const list=d.list('proj_cem');
    assert.equal(list.length,2);
    const fdtdDir=list.find(x=>x.path==='/home/dell/CEM_1/CEM_FDTD');
    assert.equal(fdtdDir.branch,'fdtd_dev');
    assert.ok(fdtdDir.body.overview.includes('GPU FDTD'));
    assert.ok(fdtdDir.body.work[0].evidence[0].quote.includes('-62.7 dB'));

    // Manual add and delete directory actions
    const manual=d.change({project:'proj_cem',action:'add',machine:'dell97',path:'/home/dell/CEM_1/manual_worktree',branch:'manual_branch'});
    assert.equal(manual.path,'/home/dell/CEM_1/manual_worktree');
    assert.equal(manual.branch,'manual_branch');
    assert.equal(d.list('proj_cem').length,3);
    const del=d.change({project:'proj_cem',action:'delete',id:manual.id,machine:'dell97',path:'/home/dell/CEM_1/manual_worktree'});
    assert.equal(del.removed,true);
    assert.equal(d.list('proj_cem').length,2);
    review.seed();
    assert.equal(d.list('proj_cem').length,2);
  }finally{v.close();fs.rmSync(dir,{recursive:true,force:true});}
});
