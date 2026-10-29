'use strict';
const crypto=require('crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX=1024*1024;
function createMemory(vault){
  const {db,transaction}=vault;
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
          !['machine','project','global'].includes(x.scope)||!['claude','codex','opencode','confirmed'].includes(x.provider)||typeof x.owner!=='string'||x.owner.length>200)throw Error('记忆来源格式不正确');
        const digest=sha(x.body),now=Date.now();
        db.prepare('INSERT INTO memory_observed VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(machine,path) DO UPDATE SET scope=excluded.scope,owner=excluded.owner,provider=excluded.provider,body=excluded.body,sha256=excluded.sha256,updated=excluded.updated')
          .run(machine,x.path,x.scope,x.scope==='machine'?machine:x.owner,x.provider,x.body,digest,now);
        db.prepare('INSERT OR IGNORE INTO memory_observed_history VALUES(?,?,?,?,?)').run(machine,x.path,digest,x.body,now);
      }
    });
  }
  function project(d){
    if(!ID.test(d.id||'')||d.id==='global'||typeof d.name!=='string'||d.name.length>200||!Array.isArray(d.paths)||d.paths.length>100)throw Error('项目格式不正确（global 为保留 ID）');
    transaction(()=>{
      db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(d.id,d.name);
      for(const p of d.paths){
        if(typeof p.machine!=='string'||!p.machine||p.machine.length>200)throw Error('项目机器名不正确');
        if(p.remove===true){db.prepare('DELETE FROM project_paths WHERE project=? AND machine=?').run(d.id,p.machine);continue;}
        if(typeof p.path!=='string'||!p.path||p.path.length>4096)throw Error('项目路径不正确');
        db.prepare('INSERT INTO project_paths VALUES(?,?,?) ON CONFLICT(project,machine) DO UPDATE SET path=excluded.path').run(d.id,p.machine,p.path);}
      db.prepare("INSERT OR REPLACE INTO vault_meta VALUES('memory_version',?)").run(crypto.randomUUID());
    });
  }
  function effective(machine,project=''){
    return db.prepare(`SELECT * FROM memory WHERE enabled=1 AND (scope='global' OR (scope='machine' AND owner=?) OR (scope='project' AND owner=?))
      ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'machine' THEN 1 ELSE 2 END,name,id`).all(machine,project);
  }
  function bundle(machine){
    const projects=db.prepare('SELECT p.id,p.name,x.path FROM projects p JOIN project_paths x ON p.id=x.project WHERE x.machine=? ORDER BY p.id').all(machine);
    const targets=[{target:'global',items:effective(machine)} ,...projects.map(p=>({target:p.id,path:p.path,items:effective(machine,p.id).filter(x=>x.scope==='project')}))];
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
  return {save,observe,project,effective,bundle,promoted,
    list:()=>db.prepare('SELECT * FROM memory ORDER BY scope,owner,name').all(),
    observed:()=>db.prepare('SELECT machine,path,scope,owner,provider,sha256,updated,length(body) AS size FROM memory_observed ORDER BY machine,path').all(),
    readObserved:(machine,path)=>db.prepare('SELECT * FROM memory_observed WHERE machine=? AND path=?').get(machine,path),
    history:id=>db.prepare('SELECT * FROM memory_revisions WHERE id=? ORDER BY revision DESC').all(id),
    projects:()=>db.prepare('SELECT p.id,p.name,x.machine,x.path FROM projects p LEFT JOIN project_paths x ON p.id=x.project ORDER BY p.id,x.machine').all(),
    deployments:()=>db.prepare('SELECT * FROM memory_deployments ORDER BY machine,target').all(),
    deployed:(machine,d)=>{if(typeof d.target==='string'&&typeof d.revision==='string')db.prepare('INSERT OR REPLACE INTO memory_deployments VALUES(?,?,?,?,?,?)')
      .run(machine,d.target.slice(0,200),d.revision.slice(0,64),d.ok?'applied':'conflict',String(d.msg||'').slice(0,500),Date.now());}};
}
module.exports={createMemory,MAX,ID};
