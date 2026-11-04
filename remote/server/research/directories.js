'use strict';
const crypto=require('crypto');
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/$/,'');
const canonical=p=>/^[A-Za-z]:/.test(p)?norm(p).toLowerCase():norm(p);
const key=(project,machine,path)=>crypto.createHash('sha256').update([project,machine,canonical(path)].join('\0')).digest('hex');
function createDirectories({vault,review}){
  const db=vault.db;
  db.exec(`CREATE TABLE IF NOT EXISTS research_directory_summaries(id TEXT PRIMARY KEY,project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,
    body TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,inputs TEXT NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS research_directory_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,item TEXT NOT NULL,before_json TEXT NOT NULL,created INTEGER NOT NULL);`);
  const parse=r=>r?{...r,body:JSON.parse(r.body),inputs:JSON.parse(r.inputs)}:null;
  function list(project){
    const catalog=review.catalog().find(p=>p.id===project);if(!catalog)throw Error('找不到项目');
    const docs=db.prepare('SELECT d.* FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=?').all(project);
    const sources=db.prepare(`SELECT s.* FROM sources s WHERE kind='native' AND rowid=(SELECT rowid FROM sources t
      WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)`).all();
    return catalog.directories.map(d=>{
      const id=key(project,d.machine,d.path),saved=parse(db.prepare('SELECT * FROM research_directory_summaries WHERE id=?').get(id));
      const own=x=>x.machine===d.machine&&canonical(x.cwd)===canonical(d.path);
      const archived=sources.filter(own),documents=docs.filter(own);
      const inputs=documents.map(x=>x.id).sort();
      return {id,project,machine:d.machine,path:d.path,...(saved||{}),status:saved?.status||'pending',revision:saved?.revision||0,
        body:saved?.body||null,documents:documents.length,sessions:new Set(archived.map(x=>x.session)).size,
        updated:saved?.updated||null,changed:!!saved&&JSON.stringify(saved.inputs)!==JSON.stringify(inputs),
        evidenceDocuments:saved?.inputs.length||0};
    });
  }
  function change(input){return vault.transaction(()=>{
    const current=list(input.project).find(d=>d.id===input.id);if(!current)throw Error('找不到项目目录');
    if(input.revision!==current.revision)throw Error('目录总结已有更新，请刷新后保存');
    const before=db.prepare('SELECT * FROM research_directory_summaries WHERE id=?').get(current.id);
    let body=current.body,status=current.status;
    if(input.action==='save'){
      body=input.body;
      if(!body||typeof body.overview!=='string'||!body.overview.trim()||body.overview.length>15000||!Array.isArray(body.work)||body.work.length>30||!Array.isArray(body.next_steps))throw Error('目录总结格式无效');
      for(const w of body.work){
        if(typeof w.title!=='string'||!w.title.trim()||typeof w.description!=='string'||!['results','outputs','questions','evidence'].every(k=>Array.isArray(w[k])))throw Error('工作主线格式无效');
        for(const ref of w.evidence){
          const e=db.prepare(`SELECT e.text,d.machine,d.cwd FROM research_events e JOIN research_documents d ON d.id=e.document
            JOIN research_project_sources p ON p.document=d.id WHERE p.project=? AND e.id=?`).get(input.project,ref.event_id);
          if(!e||e.machine!==current.machine||canonical(e.cwd)!==canonical(current.path)||typeof ref.quote!=='string'||!ref.quote.trim()||!e.text.includes(ref.quote))throw Error('目录总结引用与来源不匹配');
        }
      }
      if(JSON.stringify(body).length>256*1024)throw Error('目录总结过长');
      status=input.confirm?'confirmed':'pending';
    }else if(input.action==='confirm'){if(!body)throw Error('请先生成目录总结');status='confirmed';}
    else if(input.action==='restore')status='pending';
    else throw Error('目录操作无效');
    const inputs=db.prepare(`SELECT d.id,d.machine,d.cwd FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=?`).all(input.project)
      .filter(d=>d.machine===current.machine&&canonical(d.cwd)===canonical(current.path)).map(d=>d.id).sort();
    db.prepare('INSERT INTO research_directory_history(item,before_json,created) VALUES(?,?,?)').run(current.id,JSON.stringify(before||null),Date.now());
    db.prepare(`INSERT INTO research_directory_summaries VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,status=excluded.status,
      revision=excluded.revision,inputs=excluded.inputs,updated=excluded.updated`).run(current.id,current.project,current.machine,current.path,
      JSON.stringify(body),status,current.revision+1,JSON.stringify(input.action==='save'?inputs:(before?JSON.parse(before.inputs):inputs)),Date.now());
    return list(input.project).find(d=>d.id===current.id);
  });}
  return {list,change};
}
module.exports={createDirectories};
