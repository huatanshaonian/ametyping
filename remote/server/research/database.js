'use strict';
const { documentId, normalize, VERSION, segments, hash } = require('./normalize');
const { segmentKey, VERSION: EXTRACT_VERSION } = require('./extract');
const { seg } = require('../search-index/terms');
const crypto=require('crypto');

function createResearchStore(vault) {
  const db = vault.db;
  db.exec(`CREATE TABLE IF NOT EXISTS research_documents(id TEXT PRIMARY KEY,machine TEXT NOT NULL,key TEXT NOT NULL,
    generation TEXT NOT NULL,digest TEXT NOT NULL,provider TEXT NOT NULL,session TEXT NOT NULL,cwd TEXT NOT NULL,
    parser TEXT NOT NULL,events INTEGER NOT NULL,created INTEGER NOT NULL,size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS research_project_sources(project TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(project,document),FOREIGN KEY(document) REFERENCES research_documents(id));
    CREATE TABLE IF NOT EXISTS research_events(id TEXT PRIMARY KEY,document TEXT NOT NULL,line INTEGER NOT NULL,
      part INTEGER NOT NULL,t INTEGER,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,suppressed INTEGER NOT NULL,
      details TEXT NOT NULL,FOREIGN KEY(document) REFERENCES research_documents(id));
    CREATE INDEX IF NOT EXISTS research_event_document ON research_events(document,line,part);
    CREATE VIRTUAL TABLE IF NOT EXISTS research_event_fts USING fts5(seg,event UNINDEXED,document UNINDEXED,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS research_jobs(id TEXT PRIMARY KEY,project TEXT NOT NULL,document TEXT NOT NULL,
      model TEXT NOT NULL,version TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',usage TEXT NOT NULL DEFAULT '[]',created INTEGER NOT NULL,updated INTEGER NOT NULL,
      FOREIGN KEY(document) REFERENCES research_documents(id));
    CREATE INDEX IF NOT EXISTS research_job_state ON research_jobs(state,created);
    CREATE TABLE IF NOT EXISTS research_attempts(job TEXT NOT NULL,attempt INTEGER NOT NULL,model TEXT NOT NULL,
      request_id TEXT NOT NULL,response TEXT NOT NULL,validation_error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,
      PRIMARY KEY(job,attempt),FOREIGN KEY(job) REFERENCES research_jobs(id));
    CREATE TABLE IF NOT EXISTS research_work(id TEXT PRIMARY KEY,job TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,
      objective TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,
      FOREIGN KEY(job) REFERENCES research_jobs(id));`);
  if(!db.prepare('PRAGMA table_info(research_documents)').all().some(x=>x.name==='size'))
    db.exec('ALTER TABLE research_documents ADD COLUMN size INTEGER NOT NULL DEFAULT 0');

  const doc = id => db.prepare('SELECT * FROM research_documents WHERE id=?').get(id);
  function importSource(project, ref, {maxBytes=64*1024*1024}={}) {
    const s = ref.generation ? vault.source(ref.machine, ref.key, ref.generation) : vault.latest(ref.machine, ref.key);
    if (!s || !s.complete || s.bytes !== s.size) throw Error('来源尚未完成整文件校验');
    if(s.size>maxBytes)throw Error('此来源超过首轮同步解析的 64 MiB 上限；原始存档已保留，需后台解析后再导入');
    if (s.kind !== 'native' || !['claude', 'codex', 'opencode', 'agy', 'kiro'].includes(s.provider)) throw Error('请选择原生会话记录，附件不能单独抽取');
    const id = documentId(s);
    vault.transaction(() => {
      if (!doc(id)) {
        const insert = db.prepare('INSERT INTO research_events VALUES(?,?,?,?,?,?,?,?,?,?)');
        const fts = db.prepare('INSERT INTO research_event_fts VALUES(?,?,?)');
        // Deferred document FK: create the document before parsing, then roll everything back on parse failure.
        db.prepare('INSERT INTO research_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,s.machine,s.key,s.generation,s.digest,s.provider,s.session,s.cwd,VERSION,0,Date.now(),s.size);
        let count = 0;
        const digest=crypto.createHash('sha256');
        function* snapshot(){let left=s.size;for(const raw of vault.data(s.machine,s.key,s.generation)){
          if(!left)break;const bytes=raw.subarray(0,left);left-=bytes.length;digest.update(bytes);yield bytes;
        }if(left)throw Error('原始存档前缀缺失');}
        for (const e of normalize(s, snapshot())) {
          insert.run(e.id,id,e.line,e.part,e.t,e.role,e.kind,e.text,+e.suppressed,JSON.stringify(e.details));
          if (!e.suppressed) fts.run(seg(e.text),e.id,id);
          count++;
        }
        if(digest.digest('hex')!==s.digest)throw Error('导入时原始存档 SHA-256 不匹配');
        if (!count) throw Error('该来源没有可识别的会话事件，未标记为已解析');
        db.prepare('UPDATE research_documents SET events=? WHERE id=?').run(count,id);
      }
      db.prepare('INSERT OR IGNORE INTO research_project_sources VALUES(?,?)').run(project,id);
    });
    return doc(id);
  }
  function* events(document) {
    for (const e of db.prepare('SELECT * FROM research_events WHERE document=? ORDER BY line,part').iterate(document))
      yield { ...e, source_id: e.document, suppressed: !!e.suppressed, details: JSON.parse(e.details) };
  }
  function enqueue(project, document, model, { maxJobs = 3, maxChars = 18000, segmentIndices = null } = {}) {
    if (!db.prepare('SELECT 1 FROM research_project_sources WHERE project=? AND document=?').get(project,document)) throw Error('来源不属于此项目');
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw Error('单次任务上限为 1～100');
    if(segmentIndices!==null&&(!Array.isArray(segmentIndices)||segmentIndices.some(x=>!Number.isInteger(x)||x<0)))throw Error('片段选择无效');
    const items = []; let total = 0, remaining = 0;
    vault.transaction(() => {
      for (const batch of segments(events(document),maxChars)) {
        total++;
        if(segmentIndices&&!segmentIndices.includes(total-1))continue;
        const id = hash(project + ':' + segmentKey(document,batch,model));
        if (db.prepare('SELECT 1 FROM research_jobs WHERE id=?').get(id)) continue;
        if (items.length >= maxJobs) { remaining++; continue; }
        const now = Date.now();
        db.prepare('INSERT INTO research_jobs(id,project,document,model,version,input,state,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id,project,document,model,EXTRACT_VERSION,JSON.stringify(batch),'queued',now,now);
        items.push(id);
      }
    });
    return { ids: items, segments: total, remaining };
  }
  function finish(job, result, usage) {
    vault.transaction(() => {
      db.prepare('DELETE FROM research_work WHERE job=?').run(job.id);
      const insert = db.prepare('INSERT INTO research_work VALUES(?,?,?,?,?,?,?,?,?)');
      result.work_items.forEach((w,i) => insert.run(hash(job.id+':'+i),job.id,job.project,w.title,w.objective,w.kind,w.state,JSON.stringify(w),Date.now()));
      db.prepare("UPDATE research_jobs SET state='succeeded',error='',usage=?,updated=? WHERE id=?").run(JSON.stringify(usage),Date.now(),job.id);
    });
  }
  function list(project) {
    const documents = db.prepare('SELECT d.* FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=? ORDER BY d.created DESC').all(project);
    const jobs = db.prepare('SELECT id,document,model,version,state,attempts,error,usage,created,updated FROM research_jobs WHERE project=? ORDER BY created DESC LIMIT 200').all(project).map(j=>({...j,usage:JSON.parse(j.usage)}));
    const work = db.prepare('SELECT w.*,d.machine,d.session,d.cwd FROM research_work w JOIN research_jobs j ON j.id=w.job JOIN research_documents d ON d.id=j.document WHERE w.project=? ORDER BY w.created DESC LIMIT 300').all(project).map(w=>({...w,body:JSON.parse(w.body)}));
    return { documents, jobs, work, totals: { jobs: db.prepare('SELECT count(*) n FROM research_jobs WHERE project=?').get(project).n,
      work: db.prepare('SELECT count(*) n FROM research_work WHERE project=?').get(project).n } };
  }
  function search(project, query, limit = 30) {
    const tokens = seg(String(query || '').trim()).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,20);
    if (!tokens.length) return [];
    const match = tokens.map(t=>'"'+t.replace(/"/g,'""')+'"').join(' AND ');
    return db.prepare(`SELECT e.id,e.document,e.line,e.part,e.t,e.role,e.kind,substr(e.text,1,1200) text,d.machine,d.session,d.cwd
      FROM research_event_fts f JOIN research_events e ON e.id=f.event JOIN research_documents d ON d.id=e.document
      JOIN research_project_sources p ON p.document=e.document WHERE research_event_fts MATCH ? AND p.project=?
      ORDER BY e.t DESC,e.line DESC LIMIT ?`).all(match,project,Math.max(1,Math.min(100,+limit||30)));
  }
  function evidenceFor(project, id) {
    const e = db.prepare(`SELECT e.*,d.machine,d.session,d.cwd,d.key,d.generation,d.digest,d.size source_size FROM research_events e
      JOIN research_project_sources p ON p.document=e.document JOIN research_documents d ON d.id=e.document WHERE p.project=? AND e.id=?`).get(project,id);
    if (!e) throw Error('找不到项目原文');
    const around = db.prepare('SELECT id,line,part,t,role,kind,text FROM research_events WHERE document=? AND line BETWEEN ? AND ? ORDER BY line,part LIMIT 15')
      .all(e.document,Math.max(1,e.line-2),e.line+2);
    if(!around.some(x=>x.id===e.id))around.push({id:e.id,line:e.line,part:e.part,t:e.t,role:e.role,kind:e.kind,text:e.text});
    around.sort((a,b)=>a.line-b.line||a.part-b.part);
    return { ...e, details:JSON.parse(e.details), around };
  }
  function documentFor(project,id) {
    const d=db.prepare('SELECT d.* FROM research_documents d JOIN research_project_sources p ON p.document=d.id WHERE p.project=? AND d.id=?').get(project,id);
    if(!d)throw Error('找不到项目资料');return d;
  }
  return { db, doc, documentFor, events, importSource, enqueue, finish, list, search, evidenceFor };
}
module.exports = { createResearchStore };
