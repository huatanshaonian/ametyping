'use strict';
const crypto=require('crypto');
const {hash}=require('./normalize');
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/\/$/,'');
const canonical=p=>/^[A-Za-z]:/.test(p)?norm(p).toLowerCase():norm(p);
const isInside=(child,parent)=>{const c=canonical(child),p=canonical(parent);return !!c&&!!p&&(c===p||c.startsWith(p+'/'));};
const isTempOrNoiseCwd=p=>/^(?:\/tmp(?:\/|$)|\/var\/tmp|[a-z]:\/windows\/system32|[a-z]:\/users\/[^/]+(?:\/desktop|\/downloads|\/documents\/codex|\/appdata\/local\/temp|\/appdata\/roaming\/claude\/scratch-workspaces|\/\.claude\/projects)(?:\/|$)|.*\/\.claude\/worktrees\/|.*\/\.ame-worktrees\/|.*\/ame-(?:launch|mode|key|perm)test)/i.test(norm(p));
const projectName=p=>norm(p).split('/').pop()||'待归类';
const nameKey=s=>String(s).replace(/[-_\s]/g,'').toLowerCase();
const unique=a=>[...new Map(a.map(x=>[JSON.stringify(x),x])).values()];
function tagEvidence(value,pilot){
  if(Array.isArray(value))return value.map(v=>tagEvidence(v,pilot));
  if(!value||typeof value!=='object')return value;
  const result=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,tagEvidence(v,pilot)]));
  if(typeof value.event_id==='string'&&typeof value.quote==='string')result.pilot=pilot;
  return result;
}
function createReview({vault,pilots,listProjects=()=>[],saveProject=null}){
  const db=vault.db;
  db.exec(`CREATE TABLE IF NOT EXISTS research_review_items(id TEXT PRIMARY KEY,project TEXT NOT NULL,body TEXT NOT NULL,
    origins TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,merged_into TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS research_review_project ON research_review_items(project,status);
    CREATE TABLE IF NOT EXISTS research_review_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,item TEXT NOT NULL,batch TEXT NOT NULL,
      action TEXT NOT NULL,before_json TEXT NOT NULL,after_revision INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS research_review_history_item ON research_review_history(item,seq);
    CREATE TABLE IF NOT EXISTS research_project_directories(id TEXT PRIMARY KEY,project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,source TEXT NOT NULL,branch TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS research_dismissed_directories(id TEXT PRIMARY KEY,project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,created INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(research_project_directories)').all().some(c=>c.name==='branch'))
    db.exec("ALTER TABLE research_project_directories ADD COLUMN branch TEXT NOT NULL DEFAULT ''");
  const hasTable=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const raw=id=>db.prepare('SELECT * FROM research_review_items WHERE id=?').get(id);
  const decode=r=>({...r,body:JSON.parse(r.body),origins:JSON.parse(r.origins),canUndo:!!db.prepare('SELECT 1 FROM research_review_history WHERE item=? AND undone=0 LIMIT 1').get(r.id)});
  const get=id=>{const r=raw(id);if(!r)throw Error('找不到工作事项');return decode(r);};
  const isDismissed=(project,machine,p)=>!!db.prepare('SELECT 1 FROM research_dismissed_directories WHERE id=?').get(hash(project+'\0'+machine+'\0'+canonical(p)));
  const directory=(project,machine,p,source,branch='')=>{
    if(!machine||!p)return;
    const id=hash(project+'\0'+machine+'\0'+canonical(p));
    if(source!=='手动添加'&&isDismissed(project,machine,p))return;
    db.prepare('INSERT OR IGNORE INTO research_project_directories(id,project,machine,path,source,branch) VALUES(?,?,?,?,?,?)')
      .run(id,project,machine,norm(p),source,String(branch||''));
    if(branch)db.prepare("UPDATE research_project_directories SET branch=? WHERE id=? AND (branch='' OR branch IS NULL)").run(String(branch),id);
  };
  function addDirectory({project,machine,path:dirPath,branch='',source='手动添加'}){
    const cleanMach=String(machine||'').trim(),cleanPath=norm(String(dirPath||'').trim()),cleanBranch=String(branch||'').trim();
    if(!cleanMach||cleanMach.length>80)throw Error('请填写有效的设备名称');
    if(!cleanPath||cleanPath.length>500)throw Error('请填写有效的文件夹路径');
    const id=hash(project+'\0'+cleanMach+'\0'+canonical(cleanPath));
    db.prepare('DELETE FROM research_dismissed_directories WHERE id=?').run(id);
    db.prepare(`INSERT INTO research_project_directories(id,project,machine,path,source,branch) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path,source=excluded.source,
      branch=CASE WHEN excluded.branch<>'' THEN excluded.branch ELSE research_project_directories.branch END`)
      .run(id,project,cleanMach,cleanPath,source||'手动添加',cleanBranch);
    if(saveProject){
      const p=listProjects().find(x=>x.id===project);
      if(p){
        const ws=Array.isArray(p.workspaces)?[...p.workspaces]:[];
        const ex=ws.find(w=>w.machine===cleanMach&&canonical(w.path)===canonical(cleanPath));
        if(!ex){
          ws.push({machine:cleanMach,path:cleanPath,mode:'rw',tag:'',branch:cleanBranch});
          try{saveProject({id:p.id,name:p.name,workspaces:ws});}catch{}
        }else if(cleanBranch&&ex.branch!==cleanBranch){
          ex.branch=cleanBranch;
          try{saveProject({id:p.id,name:p.name,workspaces:ws});}catch{}
        }
      }
    }
    return {id,project,machine:cleanMach,path:cleanPath,source:source||'手动添加',branch:cleanBranch};
  }
  function removeDirectory({project,id,machine,path:dirPath}){
    const cat=catalog().find(p=>p.id===project);
    if(!cat)throw Error('找不到项目');
    const target=(cat.directories||[]).find(d=>{
      const dId=hash(project+'\0'+d.machine+'\0'+canonical(d.path));
      return (id&&dId===id)||(machine&&dirPath&&d.machine===machine&&canonical(d.path)===canonical(dirPath));
    });
    if(!target)throw Error('找不到要移除的项目目录');
    const targetId=hash(project+'\0'+target.machine+'\0'+canonical(target.path));
    db.prepare('INSERT OR REPLACE INTO research_dismissed_directories(id,project,machine,path,created) VALUES(?,?,?,?,?)')
      .run(targetId,project,target.machine,norm(target.path),Date.now());
    db.prepare('DELETE FROM research_project_directories WHERE id=?').run(targetId);
    try{db.prepare('DELETE FROM research_directory_summaries WHERE id=?').run(targetId);}catch{}
    if(saveProject){
      const p=listProjects().find(x=>x.id===project);
      if(p&&Array.isArray(p.workspaces)){
        const nextWs=p.workspaces.filter(w=>!(w.machine===target.machine&&canonical(w.path)===canonical(target.path)));
        if(nextWs.length!==p.workspaces.length){
          try{saveProject({id:p.id,name:p.name,workspaces:nextWs});}catch{}
        }
      }
    }
    return {id:targetId,project,machine:target.machine,path:target.path,removed:true};
  }
  function seed(){
    if(!saveProject)return;
    for(const entry of pilots.list().items){
      const report=pilots.read(entry.id),docs=new Map(pilots.documents(entry.id).map(d=>[d.id,d]));
      for(const sample of report.samples){
        const d=docs.get(sample.document);if(!d)continue;
        let projects=listProjects(),project=projects.find(p=>(p.workspaces||[]).some(w=>w.machine===d.machine&&
          (canonical(d.cwd)===canonical(w.path)||canonical(d.cwd).startsWith(canonical(w.path)+'/'))));
        const name=projectName(d.cwd);
        project=project||projects.find(p=>nameKey(p.name)===nameKey(name));
        if(!project){const result=saveProject({name});if(!result?.ok)throw Error(result?.msg||'无法建立研究项目');project=result.project;}
        directory(project.id,d.machine,d.cwd,'会话工作目录');
        for(const w of sample.work){
          const id=hash(entry.id+'\0'+(w.id||hash(JSON.stringify(w)))),body=tagEvidence(w,entry.id);
          delete body.id;
          db.prepare('INSERT OR IGNORE INTO research_review_items(id,project,body,origins,status,updated) VALUES(?,?,?,?,?,?)')
            .run(id,project.id,JSON.stringify(body),JSON.stringify([{pilot:entry.id,document:d.id,machine:d.machine,path:d.cwd,session:d.session}]),'pending',Date.now());
        }
      }
    }
    // Bridge registered projects, project_dirs, and agent-expanded git worktrees from knowledge tables
    const kProjMap=new Map(); // knowledge project id -> mesh project
    if(hasTable('projects')&&hasTable('project_dirs')){
      for(const kp of db.prepare('SELECT * FROM projects ORDER BY id').all()){
        let projects=listProjects();
        let mp=(kp.mesh&&projects.find(p=>p.id===kp.mesh))||
          projects.find(p=>nameKey(p.name)===nameKey(kp.id)||nameKey(p.name)===nameKey(kp.name)||(kp.id==='cem'&&nameKey(p.name)==='cempo'));
        if(!mp){
          const res=saveProject({name:kp.name||kp.id});
          if(res?.ok)mp=res.project;
        }
        if(!mp)continue;
        if(kp.mesh!==mp.id){try{db.prepare('UPDATE projects SET mesh=? WHERE id=?').run(mp.id,kp.id);}catch{}}
        kProjMap.set(kp.id,mp);
        for(const pd of db.prepare('SELECT machine,path FROM project_dirs WHERE project=?').all(kp.id)){
          directory(mp.id,pd.machine,pd.path,'项目登记目录');
        }
        if(hasTable('memory_deployments')){
          for(const dep of db.prepare('SELECT machine,dirs FROM memory_deployments WHERE target=?').all(kp.id)){
            let dlist=[];try{dlist=dep.dirs?JSON.parse(dep.dirs):[];}catch{}
            for(const w of dlist){
              if(!w||!w.ok||!w.path||isTempOrNoiseCwd(w.path))continue;
              directory(mp.id,dep.machine,w.path,w.source==='worktree'?'Git Worktree':'项目登记目录',w.branch||'');
            }
          }
        }
      }
    }
    for(const w of db.prepare(`SELECT w.*,d.machine,d.cwd,d.session,d.id document FROM research_work w
      JOIN research_jobs j ON j.id=w.job JOIN research_documents d ON d.id=j.document`).all()){
      if(!listProjects().some(p=>p.id===w.project))continue;
      const annotate=value=>{if(Array.isArray(value))return value.map(annotate);if(!value||typeof value!=='object')return value;
        const out=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,annotate(v)]));if(value.event_id&&typeof value.quote==='string')out.project=w.project;return out;};
      db.prepare('INSERT OR IGNORE INTO research_review_items(id,project,body,origins,status,updated) VALUES(?,?,?,?,?,?)')
        .run(hash('primary\0'+w.id),w.project,JSON.stringify(annotate(JSON.parse(w.body))),JSON.stringify([{project:w.project,document:w.document,machine:w.machine,path:w.cwd,session:w.session}]),'pending',Date.now());
      directory(w.project,w.machine,w.cwd,'会话工作目录');
    }
    const projects=listProjects();
    const knownDirs=db.prepare('SELECT project,machine,path FROM research_project_directories').all();
    for(const d of db.prepare("SELECT DISTINCT machine,cwd FROM sources WHERE cwd<>''").all()){
      if(isTempOrNoiseCwd(d.cwd))continue;
      const base=projectName(d.cwd),bKey=nameKey(base);
      let project=projects.find(p=>nameKey(p.name)===bKey);
      if(!project){
        const parentMatch=knownDirs.find(kd=>kd.machine===d.machine&&isInside(d.cwd,kd.path));
        if(parentMatch)project=projects.find(p=>p.id===parentMatch.project);
      }
      if(!project){
        for(const [kid,mp] of kProjMap.entries()){
          const kKey=nameKey(kid);
          if(bKey===kKey||base.toLowerCase().startsWith(kid.toLowerCase()+'-')||base.toLowerCase().startsWith(kid.toLowerCase()+'_')){
            project=mp;break;
          }
        }
      }
      if(project)directory(project.id,d.machine,d.cwd,'历史工作目录');
    }
    for(const p of [...listProjects()]){
      if(!String(p.id||'').startsWith('proj_'))continue;
      if(p.workspacesLocked===true)continue;
      const dirs=db.prepare('SELECT machine,path,source,branch FROM research_project_directories WHERE project=? ORDER BY machine,path').all(p.id);
      if(!dirs.length)continue;
      const curWs=Array.isArray(p.workspaces)?[...p.workspaces]:[];
      let changed=false;
      for(const d of dirs){
        const ex=curWs.find(w=>w.machine===d.machine&&canonical(w.path)===canonical(d.path));
        if(!ex){
          curWs.push({machine:d.machine,path:d.path,mode:'rw',tag:d.source==='Git Worktree'?'code':'',branch:d.branch||''});
          changed=true;
        }else if(d.branch&&!ex.branch){
          ex.branch=d.branch;changed=true;
        }
      }
      if(changed){try{saveProject({id:p.id,name:p.name,workspaces:curWs});}catch{}}
    }
  }
  function catalog(){return listProjects().map(p=>{
    const dirs=db.prepare('SELECT machine,path,source,branch FROM research_project_directories WHERE project=? ORDER BY machine,path').all(p.id)
      .filter(d=>!isDismissed(p.id,d.machine,d.path));
    for(const w of p.workspaces||[])if(!isDismissed(p.id,w.machine,w.path)&&!dirs.some(d=>d.machine===w.machine&&canonical(d.path)===canonical(w.path)))dirs.push({machine:w.machine,path:w.path,source:'项目工作区',branch:w.branch||''});
    for(const row of db.prepare('SELECT origins FROM research_review_items WHERE project=?').all(p.id))for(const o of JSON.parse(row.origins))
      if(o.machine&&o.path&&!isDismissed(p.id,o.machine,o.path)&&!dirs.some(d=>d.machine===o.machine&&canonical(d.path)===canonical(o.path)))dirs.push({machine:o.machine,path:o.path,source:'工作事项目录',branch:''});
    const counts={pending:0,confirmed:0,ignored:0,merged:0};
    for(const r of db.prepare('SELECT status,count(*) n FROM research_review_items WHERE project=? GROUP BY status').all(p.id))counts[r.status]=r.n;
    return{id:p.id,name:p.name,directories:dirs,counts};
  });}
  function items(project){return db.prepare('SELECT * FROM research_review_items WHERE project=? ORDER BY updated DESC,id').all(project).map(decode);}
  function change(input){
    const action=input.action,ids=action==='merge'?input.ids:[input.id];
    if(!['confirm','ignore','restore','edit','merge','undo'].includes(action)||!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw Error('核对操作无效');
    return vault.transaction(()=>{
      const rows=ids.map(id=>{const r=raw(id);if(!r)throw Error('找不到工作事项');
        if(input.revisions?.[id]!==r.revision)throw Error('此事项已有更新，请刷新后再保存');return r;});
      const batch=crypto.randomUUID(),now=Date.now();
      function write(before,after,historyAction=action,undone=0){
        const revision=before.revision+1;
        db.prepare('INSERT INTO research_review_history(item,batch,action,before_json,after_revision,undone,created) VALUES(?,?,?,?,?,?,?)')
          .run(before.id,batch,historyAction,JSON.stringify(before),revision,undone,now);
        db.prepare('UPDATE research_review_items SET project=?,body=?,origins=?,status=?,revision=?,merged_into=?,updated=? WHERE id=?')
          .run(after.project,after.body,after.origins,after.status,revision,after.merged_into,now,before.id);
      }
      if(action==='undo'){
        const h=db.prepare('SELECT * FROM research_review_history WHERE item=? AND undone=0 ORDER BY seq DESC LIMIT 1').get(rows[0].id);
        if(!h)throw Error('没有可以撤销的操作');
        const group=db.prepare('SELECT * FROM research_review_history WHERE batch=? AND undone=0').all(h.batch);
        for(const entry of group)if(db.prepare('SELECT 1 FROM research_review_history WHERE item=? AND seq>? AND undone=0 LIMIT 1').get(entry.item,entry.seq))throw Error('关联事项已有后续修改，请先撤销后续操作');
        for(const entry of group){const current=raw(entry.item),previous=JSON.parse(entry.before_json);write(current,previous,'undo',1);}
        db.prepare('UPDATE research_review_history SET undone=1 WHERE batch=?').run(h.batch);
        return group.map(h=>get(h.item));
      }
      if(action==='merge'){
        if(rows.length<2)throw Error('请至少选择两项工作');
        if(rows.some(r=>r.project!==rows[0].project||['ignored','merged'].includes(r.status)))throw Error('请选择同一项目中的有效事项合并');
        const bodies=rows.map(r=>JSON.parse(r.body)),body={...bodies[0]};
        body.title=typeof input.title==='string'&&input.title.trim()?input.title.trim():body.title;
        if(body.title.length>240)throw Error('标题过长');
        body.objective=unique(bodies.map(b=>b.objective).filter(Boolean)).join('\n');
        for(const key of ['evidence','runs','findings','open_questions','support_activities'])body[key]=unique(bodies.flatMap(b=>b[key]||[]));
        const target={...rows[0],body:JSON.stringify(body),origins:JSON.stringify(unique(rows.flatMap(r=>JSON.parse(r.origins)))),status:'pending'};
        if(target.body.length>2*1024*1024)throw Error('合并内容过大，请分批合并');
        write(rows[0],target);for(const r of rows.slice(1))write(r,{...r,status:'merged',merged_into:target.id});
        return rows.map(r=>get(r.id));
      }
      const r=rows[0],next={...r};
      if(r.status==='merged')throw Error('此事项已合并，可以撤销合并');
      if(action==='edit'){
        const patch=input.patch||{},body=JSON.parse(r.body);
        if(typeof patch.title!=='string'||!patch.title.trim()||patch.title.length>240)throw Error('请填写工作标题');
        if(typeof patch.objective!=='string'||patch.objective.length>30000)throw Error('工作说明过长');
        if(!['planned','started','reported_complete','reported_failed','unknown'].includes(patch.state))throw Error('工作状态无效');
        if(!['calculation','validation','exploration','analysis','implementation','other'].includes(patch.kind))throw Error('工作类型无效');
        if(typeof patch.findings!=='string'||patch.findings.length>50000)throw Error('结论内容过长');
        body.title=patch.title.trim();body.objective=patch.objective;body.state=patch.state;body.kind=patch.kind;
        body.findings=patch.findings.split('\n').map(t=>t.trim()).filter(Boolean).map(text=>(body.findings||[]).find(f=>f.text===text)||{text,basis:'user',evidence:[]});
        if(patch.project&&!listProjects().some(p=>p.id===patch.project))throw Error('目标项目不存在');
        next.project=patch.project||r.project;next.body=JSON.stringify(body);if(input.confirm)next.status='confirmed';
      }else next.status={confirm:'confirmed',ignore:'ignored',restore:'pending'}[action];
      write(r,next);return[get(r.id)];
    });
  }
  return{seed,catalog,items,get,change,directory,addDirectory,removeDirectory,isDismissed};
}
module.exports={createReview};
