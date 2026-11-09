'use strict';
const crypto=require('crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX=1024*1024;
// linked(meshId) returns workspaces of a 项目管理 project: [{machine,path,tag}]. Data and result folders get no instructions.
function createMemory(vault,{linked=()=>[]}={}){
  const {db,transaction}=vault;
  // A project may map several directories per machine; project_paths (one per machine) is kept only as the migration source.
  db.exec('CREATE TABLE IF NOT EXISTS project_dirs(project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project,machine,path),FOREIGN KEY(project) REFERENCES projects(id))');
  if(!db.prepare("SELECT 1 FROM vault_meta WHERE key='project_dirs_migrated'").get())transaction(()=>{
    db.exec("INSERT OR IGNORE INTO project_dirs SELECT project,machine,path FROM project_paths;INSERT INTO vault_meta VALUES('project_dirs_migrated','1')");
  });
  const columns=t=>db.prepare('PRAGMA table_info('+t+')').all().map(c=>c.name);
  if(!columns('projects').includes('mesh'))db.exec("ALTER TABLE projects ADD COLUMN mesh TEXT NOT NULL DEFAULT ''");
  if(!columns('memory_deployments').includes('dirs'))db.exec("ALTER TABLE memory_deployments ADD COLUMN dirs TEXT NOT NULL DEFAULT ''");
  const bump=()=>db.prepare("INSERT OR REPLACE INTO vault_meta VALUES('memory_version',?)").run(crypto.randomUUID());
  function linkedDirs(meshId){
    if(!meshId)return [];
    let list=[];try{list=linked(meshId)||[];}catch{}
    return list.filter(w=>w&&typeof w.machine==='string'&&typeof w.path==='string'&&w.path&&!['data','results'].includes(w.tag));
  }
  // Every directory of a project, manual entries first: [{machine,path,source:'manual'|'linked'}].
  function dirs(id,mesh){
    const out=db.prepare('SELECT machine,path FROM project_dirs WHERE project=? ORDER BY machine,path').all(id).map(x=>({...x,source:'manual'}));
    for(const w of linkedDirs(mesh))if(!out.some(x=>x.machine===w.machine&&x.path===w.path))out.push({machine:w.machine,path:w.path,source:'linked'});
    return out;
  }
  function save(d){
    if(!['global','machine','project'].includes(d.scope)||typeof d.owner!=='string'||d.owner.length>200||
      (d.scope==='global'&&d.owner!=='')||(d.scope!=='global'&&!d.owner)||(d.scope==='project'&&(!ID.test(d.owner)||d.owner==='global'))||typeof d.name!=='string'||!d.name.trim()||d.name.length>200||
      typeof d.body!=='string'||Buffer.byteLength(d.body)>MAX||/<!-- ametyping-memory:(start|end) -->/.test(d.body))throw Error('记忆范围、名称或正文不正确（正文最多 1 MB，不得包含系统托管标记）');
    return transaction(()=>{
      const old=d.id?db.prepare('SELECT * FROM memory WHERE id=?').get(d.id):db.prepare('SELECT * FROM memory WHERE scope=? AND owner=? AND name=?').get(d.scope,d.owner,d.name);
      if(d.id&&!old)throw Error('找不到这条记忆');
      if(old&&d.revision!==old.revision)throw Error('记忆已被修改，请刷新后合并，未覆盖新版本');
      const row={id:old?old.id:crypto.randomUUID(),scope:d.scope,owner:d.owner,name:d.name.trim(),body:d.body,
        revision:old?old.revision+1:1,enabled:d.enabled===false||d.enabled===0?0:1,source:typeof d.source==='string'?d.source.slice(0,4096):'dashboard',updated:Date.now()};
      db.prepare('INSERT INTO memory VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,owner=excluded.owner,name=excluded.name,body=excluded.body,revision=excluded.revision,enabled=excluded.enabled,source=excluded.source,updated=excluded.updated')
        .run(...Object.values(row));
      db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?)').run(row.id,row.revision,row.body,row.enabled,row.source,row.updated);
      db.prepare("INSERT OR REPLACE INTO vault_meta VALUES('memory_version',?)").run(crypto.randomUUID());
      return row;
    });
  }
  function observe(machine,d){
    if(!Array.isArray(d.items)||d.items.length>30)throw Error('记忆采集批次不正确');
    return transaction(()=>{
      for(const x of d.items){
        if(!x||typeof x.path!=='string'||x.path.length>4096||typeof x.body!=='string'||Buffer.byteLength(x.body)>MAX||
          !['machine','project','global'].includes(x.scope)||!['claude','codex','opencode','agy','confirmed'].includes(x.provider)||typeof x.owner!=='string'||x.owner.length>200)throw Error('记忆来源格式不正确');
        const digest=sha(x.body),now=Date.now();
        db.prepare('INSERT INTO memory_observed VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(machine,path) DO UPDATE SET scope=excluded.scope,owner=excluded.owner,provider=excluded.provider,body=excluded.body,sha256=excluded.sha256,updated=excluded.updated')
          .run(machine,x.path,x.scope,x.scope==='machine'?machine:x.owner,x.provider,x.body,digest,now);
        db.prepare('INSERT OR IGNORE INTO memory_observed_history VALUES(?,?,?,?,?)').run(machine,x.path,digest,x.body,now);
      }
    });
  }
  function project(d){
    if(d.op==='rename')return rename(d);
    if(d.op==='delete')return remove(d.id);
    if(!ID.test(d.id||'')||d.id==='global'||typeof d.name!=='string'||d.name.length>200||!Array.isArray(d.paths||[])||(d.paths||[]).length>100||
      (d.mesh!==undefined&&(typeof d.mesh!=='string'||d.mesh.length>80)))throw Error('项目格式不正确（global 为保留 ID）');
    transaction(()=>{
      const old=db.prepare('SELECT * FROM projects WHERE id=?').get(d.id);
      db.prepare('INSERT INTO projects(id,name,mesh) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mesh=excluded.mesh')
        .run(d.id,d.name||old?.name||d.id,d.mesh!==undefined?d.mesh:old?.mesh||'');
      for(const p of d.paths||[]){
        if(typeof p.machine!=='string'||!p.machine||p.machine.length>200)throw Error('项目机器名不正确');
        if(p.remove===true){
          // Without a path the whole machine mapping goes, as before multi-directory support.
          if(typeof p.path==='string'&&p.path)db.prepare('DELETE FROM project_dirs WHERE project=? AND machine=? AND path=?').run(d.id,p.machine,p.path);
          else db.prepare('DELETE FROM project_dirs WHERE project=? AND machine=?').run(d.id,p.machine);
          continue;
        }
        if(typeof p.path!=='string'||!p.path||p.path.length>4096)throw Error('项目路径不正确');
        if(db.prepare('SELECT count(*) n FROM project_dirs WHERE project=? AND machine=?').get(d.id,p.machine).n>=50)throw Error('每台机器最多登记 50 个项目目录');
        db.prepare('INSERT OR IGNORE INTO project_dirs VALUES(?,?,?)').run(d.id,p.machine,p.path);
      }
      bump();
    });
  }
  // Renaming keeps every memory's revision history; deployed blocks under the old ID are retired by the agents.
  function rename(d){
    if(!ID.test(d.id||'')||!ID.test(d.to||'')||d.to==='global')throw Error('项目 ID 不正确');
    return transaction(()=>{
      const old=db.prepare('SELECT * FROM projects WHERE id=?').get(d.id);
      if(!old)throw Error('找不到项目 '+d.id);
      if(db.prepare('SELECT 1 FROM projects WHERE id=?').get(d.to))throw Error('项目 ID 已存在：'+d.to);
      db.prepare('INSERT INTO projects(id,name,mesh) VALUES(?,?,?)').run(d.to,typeof d.name==='string'&&d.name?d.name.slice(0,200):old.name,old.mesh||'');
      db.prepare('UPDATE project_dirs SET project=? WHERE project=?').run(d.to,d.id);
      db.prepare('DELETE FROM project_paths WHERE project=?').run(d.id);
      for(const m of db.prepare("SELECT * FROM memory WHERE scope='project' AND owner=?").all(d.id))
        save({...m,owner:d.to,enabled:!!m.enabled,source:m.source});
      db.prepare("UPDATE memory_observed SET owner=? WHERE scope='project' AND owner=?").run(d.to,d.id);
      db.prepare('DELETE FROM memory_deployments WHERE target=?').run(d.id);
      db.prepare('DELETE FROM projects WHERE id=?').run(d.id);
      bump();
      return {id:d.to};
    });
  }
  function remove(id){
    return transaction(()=>{
      if(!db.prepare('SELECT 1 FROM projects WHERE id=?').get(id))throw Error('找不到项目 '+id);
      const n=db.prepare("SELECT count(*) n FROM memory WHERE scope='project' AND owner=? AND enabled=1").get(id).n;
      if(n)throw Error('项目下还有 '+n+' 条启用的记忆，请先迁走或停用');
      for(const t of ['project_dirs','project_paths'])db.prepare('DELETE FROM '+t+' WHERE project=?').run(id);
      db.prepare('DELETE FROM memory_deployments WHERE target=?').run(id);
      db.prepare('DELETE FROM projects WHERE id=?').run(id);
      bump();
      return {id};
    });
  }
  function effective(machine,project=''){
    return db.prepare(`SELECT * FROM memory WHERE enabled=1 AND (scope='global' OR (scope='machine' AND owner=?) OR (scope='project' AND owner=?))
      ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'machine' THEN 1 ELSE 2 END,name,id`).all(machine,project);
  }
  function bundle(machine){
    // path stays the first directory so agents without multi-directory support keep working.
    const projects=db.prepare('SELECT id,name,mesh FROM projects ORDER BY id').all()
      .map(p=>({id:p.id,name:p.name,dirs:dirs(p.id,p.mesh).filter(x=>x.machine===machine).map(({path,source})=>({path,source}))}))
      .filter(p=>p.dirs.length).map(p=>({...p,path:p.dirs[0].path}));
    const targets=[{target:'global',items:effective(machine)} ,...projects.map(p=>({target:p.id,path:p.path,dirs:p.dirs,items:effective(machine,p.id).filter(x=>x.scope==='project')}))];
    const adoptions=db.prepare('SELECT l.path,l.sha256,l.memory_id,m.scope,m.owner FROM memory_source_links l JOIN memory m ON m.id=l.memory_id WHERE l.machine=? AND m.enabled=1').all(machine)
      .filter(x=>x.scope==='global'||(x.scope==='machine'&&x.owner===machine)||(x.scope==='project'&&projects.some(p=>p.id===x.owner)));
    return {machine,projects,adoptions,targets:targets.map(t=>({...t,revision:sha(JSON.stringify(t)),items:t.items.map(x=>({id:x.id,scope:x.scope,name:x.name,body:x.body,revision:x.revision}))}))};
  }
  function promoted(d){
    const source=db.prepare('SELECT * FROM memory_observed WHERE machine=? AND path=?').get(d.machine,d.path);
    if(!source||source.sha256!==d.sha256)throw Error('来源已改变，请刷新后重新导入');
    const row=save({...d,body:typeof d.body==='string'?d.body:source.body,source:source.machine+':'+source.path});
    if(d.adopt===true)db.prepare('INSERT OR REPLACE INTO memory_source_links VALUES(?,?,?,?)').run(source.machine,source.path,source.sha256,row.id);
    return row;
  }
  const dirReport=v=>Array.isArray(v)?JSON.stringify(v.slice(0,200).filter(x=>x&&typeof x.path==='string').map(x=>({path:x.path.slice(0,4096),
    source:String(x.source||'').slice(0,20),branch:String(x.branch||'').slice(0,200),ok:x.ok!==false,msg:String(x.msg||'').slice(0,300)}))):'';
  return {save,observe,project,rename,remove,effective,bundle,promoted,
    // Changes in linked 项目管理 workspaces must reach the agents even though the memory database did not change.
    linkSignature:()=>sha(JSON.stringify(db.prepare("SELECT id,mesh FROM projects WHERE mesh!=''").all().map(p=>[p.id,linkedDirs(p.mesh)]))),
    list:()=>db.prepare('SELECT * FROM memory ORDER BY scope,owner,name').all(),
    observed:()=>db.prepare('SELECT machine,path,scope,owner,provider,sha256,updated,length(body) AS size FROM memory_observed ORDER BY machine,path').all(),
    readObserved:(machine,path)=>db.prepare('SELECT * FROM memory_observed WHERE machine=? AND path=?').get(machine,path),
    history:id=>db.prepare('SELECT * FROM memory_revisions WHERE id=? ORDER BY revision DESC').all(id),
    // One row per directory (source manual|linked); a project without directories yields one row with machine null.
    projects:()=>db.prepare('SELECT id,name,mesh FROM projects ORDER BY id').all().flatMap(p=>{
      const list=dirs(p.id,p.mesh);
      return list.length?list.map(x=>({id:p.id,name:p.name,mesh:p.mesh,...x})):[{id:p.id,name:p.name,mesh:p.mesh,machine:null,path:null,source:null}];
    }),
    deployments:()=>db.prepare('SELECT * FROM memory_deployments ORDER BY machine,target').all().map(x=>{let d=[];try{d=x.dirs?JSON.parse(x.dirs):[];}catch{}return {...x,dirs:d};}),
    deployed:(machine,d)=>{if(typeof d.target==='string'&&typeof d.revision==='string')db.prepare('INSERT OR REPLACE INTO memory_deployments(machine,target,revision,status,detail,updated,dirs) VALUES(?,?,?,?,?,?,?)')
      .run(machine,d.target.slice(0,200),d.revision.slice(0,64),d.ok?'applied':'conflict',String(d.msg||'').slice(0,500),Date.now(),dirReport(d.dirs));}};
}
module.exports={createMemory,MAX,ID};
