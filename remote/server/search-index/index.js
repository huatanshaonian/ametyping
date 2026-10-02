// The search index: what the NAS keeps, in SQLite, so search stays fast as it grows.
//   lines.js  the conversations (data/<day>/<machine>/<session>.jsonl)
//   docs.js   daily reports, notes, artifacts, mail
//   terms.js  how text is cut into the index's tokens and how a query word is looked up (both tables alike)
// The files stay the truth: the index only follows them, and a missing, damaged or older index is simply built again
// from them (the conversations in the background; search scans the files meanwhile). <dataDir>/search.db
// Node's built-in node:sqlite (Node 22.5+) -- nothing to install. Without it, open() returns null and search scans.
'use strict';
const fs = require('fs');
const path = require('path');
const lines = require('./lines');
const docs = require('./docs');

const VERSION = '5';
const SWEEP_BATCH = 40;                 // conversation files per step of the background sweep

// node:sqlite still prints an "experimental" warning when loaded: not for this one
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) { if (/SQLite/i.test(String(w && w.message || w))) return; return emit.call(process, w, ...rest); };
  try { return require('node:sqlite'); } catch { return null; } finally { setTimeout(() => { process.emitWarning = emit; }, 0); }
}

function open({ dataDir, log = () => {} }) {
  const sqlite = loadSqlite();
  if (!sqlite) { log('搜索索引：这个 Node 没有 node:sqlite，搜索改为逐个文件扫描'); return null; }
  const file = path.join(dataDir, 'search.db');
  let db;
  const create = () => {
    db = new sqlite.DatabaseSync(file);
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, off INTEGER NOT NULL);`);
    const v = db.prepare('SELECT v FROM meta WHERE k = ?').get('version');
    if (!v || v.v !== VERSION) {                                   // new, or an older layout: start over
      db.exec(lines.DROP + docs.DROP + ' DELETE FROM files;');
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('version', VERSION);
    }
    db.exec(lines.SCHEMA + docs.SCHEMA);
  };
  try { create(); }
  catch (e) {                                                       // damaged: put it aside and build a new one
    log('搜索索引打不开（' + e.message + '），重建');
    try { db && db.close(); } catch {}
    for (const sfx of ['', '-wal', '-shm']) { try { fs.renameSync(file + sfx, file + sfx + '.bad'); } catch {} }
    try { create(); } catch (e2) { log('搜索索引建不起来：' + e2.message); return null; }
  }
  const L = lines.createLines(db, { dataDir, log }), D = docs.createDocs(db, { log });

  // every conversation file once, in steps (a new or rebuilt index); ready when done
  let ready = false;
  function sweep(done = () => {}) {
    const files = L.allFiles(), t0 = Date.now();
    let i = 0;
    const step = () => {
      for (const end = Math.min(files.length, i + SWEEP_BATCH); i < end; i++) L.catchUp(files[i]);
      if (i < files.length) return setImmediate(step);
      ready = true;
      log(`搜索索引就绪：${files.length} 个对话文件（${Date.now() - t0} ms）`);
      done();
    };
    step();
  }

  return {
    // conversations
    find: L.find, touched: L.touched, catchUp: L.catchUp, sweep, ready: () => ready,
    // documents (reports, notes, artifacts, mail): kept in step by the caller just before a search
    docs: D,
    close: () => { try { db.close(); } catch {} },
  };
}

module.exports = { open, recText: lines.recText, seg: require('./terms').seg };
