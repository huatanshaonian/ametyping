// Authenticated, read-only access to saved pilot snapshots. Synthetic controls stay out of the project view.
'use strict';
const fs=require('fs'),path=require('path');
const {DatabaseSync}=require('node:sqlite');
function createPilots(dataDir){
  const root=path.join(dataDir,'research-pilots');
  function folder(id){
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id||''))throw Error('试点标识无效');
    let base,dir;try{base=fs.realpathSync(root);dir=fs.realpathSync(path.join(base,id));}catch{throw Error('找不到试点');}
    if(path.dirname(dir)!==base)throw Error('试点目录无效');return dir;
  }
  function read(id){
    const dir=folder(id),file=path.join(dir,'report.json');
    if(fs.realpathSync(file)!==file||fs.statSync(file).size>5*1024*1024)throw Error('试点报告无效或过大');
    const report=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Array.isArray(report.samples))throw Error('试点报告缺少样本');
    const samples=report.samples.filter(s=>s.synthetic===false).map(s=>({name:s.name,state:s.state,document:s.document,
      work:Array.isArray(s.work)?s.work:[],issues:s.issues||[]}));
    return {id,at:report.at,model:report.provider?.model||'',scope:report.scope||'',review:report.programReview||null,
      samples,count:samples.reduce((n,s)=>n+s.work.length,0)};
  }
  function list(){
    let entries;try{entries=fs.readdirSync(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return{items:[],warnings:[]};throw e;}
    const items=[],warnings=[];
    for(const ent of entries.slice(0,100)){
      if(!ent.isDirectory())continue;
      try{const r=read(ent.name);items.push({id:r.id,at:r.at,model:r.model,count:r.count,samples:r.samples.length});}
      catch{warnings.push('试点 '+ent.name+' 的报告无法读取');}
    }
    items.sort((a,b)=>String(b.at).localeCompare(String(a.at)));return{items,warnings};
  }
  function evidence(id,event,offset=0){
    if(!/^[a-f0-9]{64}$/.test(event||''))throw Error('原文标识无效');
    offset=Number(offset);if(!Number.isSafeInteger(offset)||offset<0)throw Error('原文位置无效');
    const report=read(id),allowed=new Set(report.samples.map(s=>s.document));
    const file=path.join(folder(id),'knowledge.sqlite');
    if(fs.realpathSync(file)!==file)throw Error('试点快照路径无效');
    const db=new DatabaseSync(file,{readOnly:true});
    try{
      const e=db.prepare(`SELECT e.*,d.machine,d.session,d.cwd,d.key,d.generation,d.digest FROM research_events e
        JOIN research_documents d ON d.id=e.document WHERE e.id=?`).get(event);
      if(!e||!allowed.has(e.document))throw Error('找不到真实样本中的原文');
      const total=e.text.length,start=Math.max(0,Math.min(offset,total)-400),text=e.text.slice(start,start+6000);
      const around=db.prepare(`SELECT id,line,part,role,kind,substr(text,1,2000) text FROM research_events
        WHERE document=? AND line BETWEEN ? AND ? AND id<>? ORDER BY line,part LIMIT 6`).all(e.document,Math.max(1,e.line-1),e.line+1,e.id);
      return {...e,text,offset:start,total,truncated:start>0||text.length<total,details:JSON.parse(e.details),around};
    }finally{db.close();}
  }
  function documents(id){
    const report=read(id),ids=[...new Set(report.samples.map(s=>s.document))];if(!ids.length)return[];
    const file=path.join(folder(id),'knowledge.sqlite');if(fs.realpathSync(file)!==file)throw Error('整理快照路径无效');
    const db=new DatabaseSync(file,{readOnly:true});
    try{return db.prepare('SELECT id,machine,session,cwd,provider FROM research_documents WHERE id IN ('+ids.map(()=>'?').join(',')+')').all(...ids);}
    finally{db.close();}
  }
  return{list,read,evidence,documents};
}
module.exports={createPilots};
