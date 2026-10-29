// The authoritative archive. Unlike search.db this database must never be rebuilt or discarded.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const text = (v, n = 4096) => typeof v === 'string' ? v.slice(0, n) : '';
const CHUNK = 512 * 1024;
function openVault(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'knowledge.sqlite');
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS vault_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO vault_meta VALUES('version','1');
    CREATE TABLE IF NOT EXISTS sources(machine TEXT NOT NULL,key TEXT NOT NULL,generation TEXT NOT NULL,
      provider TEXT NOT NULL,session TEXT NOT NULL,parent TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,cwd TEXT NOT NULL,
      size INTEGER NOT NULL,mtime REAL NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,
      digest TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(machine,key,generation));
    CREATE INDEX IF NOT EXISTS sources_session ON sources(machine,session);
    CREATE INDEX IF NOT EXISTS sources_latest ON sources(machine,key,created DESC);
    CREATE TABLE IF NOT EXISTS chunks(machine TEXT NOT NULL,key TEXT NOT NULL,generation TEXT NOT NULL,
      start INTEGER NOT NULL,data BLOB NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(machine,key,generation,start),
      FOREIGN KEY(machine,key,generation) REFERENCES sources(machine,key,generation));
    CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,
      body TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,source TEXT NOT NULL,updated INTEGER NOT NULL,
      UNIQUE(scope,owner,name));
    CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,
      enabled INTEGER NOT NULL,source TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(id,revision));
    CREATE TABLE IF NOT EXISTS memory_observed(machine TEXT NOT NULL,path TEXT NOT NULL,scope TEXT NOT NULL,owner TEXT NOT NULL,
      provider TEXT NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(machine,path));
    CREATE TABLE IF NOT EXISTS memory_observed_history(machine TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,
      body TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(machine,path,sha256));
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_paths(project TEXT NOT NULL,machine TEXT NOT NULL,path TEXT NOT NULL,
      PRIMARY KEY(project,machine),FOREIGN KEY(project) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS memory_deployments(machine TEXT NOT NULL,target TEXT NOT NULL,revision TEXT NOT NULL,
      status TEXT NOT NULL,detail TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(machine,target));
    CREATE TABLE IF NOT EXISTS memory_source_links(machine TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,
      memory_id TEXT NOT NULL,PRIMARY KEY(machine,path),FOREIGN KEY(memory_id) REFERENCES memory(id));`);
  if (db.prepare("SELECT value FROM vault_meta WHERE key='version'").get().value !== '1') throw new Error('不支持的记忆数据库版本');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const source = (m, key, gen) => db.prepare('SELECT * FROM sources WHERE machine=? AND key=? AND generation=?').get(m, key, gen);
  const latest = (m, key) => db.prepare('SELECT * FROM sources WHERE machine=? AND key=? ORDER BY created DESC,rowid DESC LIMIT 1').get(m, key);
  function begin(machine, d) {
    if (!/^[a-f0-9]{64}$/.test(d.key || '') || !['claude','codex','opencode','agy','workspace'].includes(d.provider) ||
        !Number.isSafeInteger(d.size) || d.size < 0 || !Number.isFinite(d.mtime) || typeof d.path !== 'string' || d.path.length > 4096) throw new Error('无效的采集源');
    let s = latest(machine, d.key);
    if (!s || d.reset === true || d.size < s.bytes || (s.complete && d.size === s.bytes && d.mtime !== s.mtime)) {
      const generation = crypto.randomUUID(), now = Date.now();
      db.prepare('INSERT INTO sources(machine,key,generation,provider,session,parent,kind,path,cwd,size,mtime,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(machine,d.key,generation,d.provider,text(d.session,200),text(d.parent,200),text(d.kind,50),d.path,text(d.cwd),d.size,d.mtime,now,now);
      s = source(machine,d.key,generation);
    } else db.prepare('UPDATE sources SET size=?,mtime=?,complete=CASE WHEN bytes=? THEN complete ELSE 0 END,updated=? WHERE machine=? AND key=? AND generation=?')
      .run(d.size,d.mtime,d.size,Date.now(),machine,d.key,s.generation);
    const tail = db.prepare('SELECT start,data FROM chunks WHERE machine=? AND key=? AND generation=? ORDER BY start DESC LIMIT 1').get(machine,d.key,s.generation);
    const b = tail ? Buffer.from(tail.data) : Buffer.alloc(0);
    return { generation:s.generation,offset:s.bytes,tailStart:tail ? tail.start : 0,tailSize:b.length,tailHash:hash(b) };
  }
  function append(machine,d) {
    const s = source(machine,d.key,d.generation);
    if (!s || !Number.isSafeInteger(d.start) || typeof d.data !== 'string' || d.data.length > Math.ceil(CHUNK/3)*4) throw new Error('无效的数据块');
    const b = Buffer.from(d.data,'base64');
    if (!b.length || b.length > CHUNK || b.toString('base64') !== d.data || hash(b) !== d.sha256 || d.start + b.length > s.size) throw new Error('数据块校验失败');
    if (d.start !== s.bytes) {
      const old = db.prepare('SELECT sha256,length(data) AS size FROM chunks WHERE machine=? AND key=? AND generation=? AND start=?').get(machine,d.key,d.generation,d.start);
      if (old && old.sha256 === d.sha256 && old.size === b.length) return { offset:s.bytes };
      throw new Error('采集偏移不一致，请重新连接');
    }
    transaction(() => {
      db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(machine,d.key,d.generation,d.start,b,d.sha256);
      db.prepare('UPDATE sources SET bytes=?,complete=0,updated=? WHERE machine=? AND key=? AND generation=?').run(s.bytes+b.length,Date.now(),machine,d.key,d.generation);
    });
    return { offset:s.bytes+b.length };
  }
  function* data(machine,key,generation) {
    const s=source(machine,key,generation);if(!s)return;
    for(let start=0;start<s.bytes;){
      const c=db.prepare('SELECT data FROM chunks WHERE machine=? AND key=? AND generation=? AND start=?').get(machine,key,generation,start);
      if(!c)throw Error('存档数据块缺失');const b=Buffer.from(c.data);start+=b.length;yield b;
    }
  }
  function finish(machine,d) {
    const s = source(machine,d.key,d.generation);
    if (!s || s.bytes !== s.size || !/^[a-f0-9]{64}$/.test(d.sha256 || '')) throw new Error('文件尚未完整接收');
    const h = crypto.createHash('sha256'); for (const b of data(machine,d.key,d.generation)) h.update(b);
    const digest = h.digest('hex');
    if (digest !== d.sha256) throw new Error('整文件校验失败，源文件可能已改写，请重新采集');
    db.prepare('UPDATE sources SET complete=1,digest=?,updated=? WHERE machine=? AND key=? AND generation=?').run(digest,Date.now(),machine,d.key,d.generation);
    return { offset:s.bytes,complete:true,digest };
  }
  function list({machine='',session='',limit=200,offset=0}={}) {
    return db.prepare(`SELECT s.* FROM sources s WHERE (?='' OR machine=?) AND (?='' OR session=?)
      AND rowid=(SELECT rowid FROM sources t WHERE t.machine=s.machine AND t.key=s.key ORDER BY created DESC,rowid DESC LIMIT 1)
      ORDER BY updated DESC LIMIT ? OFFSET ?`).all(machine,machine,session,session,Math.min(500,Math.max(1,+limit||200)),Math.max(0,+offset||0));
  }
  return {db,file,transaction,begin,append,finish,source,latest,list,data,
    stats:()=>db.prepare('SELECT count(*) AS versions,coalesce(sum(bytes),0) AS bytes,sum(complete) AS verified FROM sources').get(),
    async snapshot(dest) { await backup(db,dest); fs.chmodSync(dest,0o600); },
    close(){db.close();} };
}
module.exports={openVault,hash,CHUNK};
