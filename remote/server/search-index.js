// A full-text index of the stored conversations (data/<day>/<machine>/<session>.jsonl) in SQLite, so search stays
// fast as the archive grows. The .jsonl files stay the truth: the index only follows them -- each file is indexed up
// to the byte it has reached, a file the store appends to is read on from there, and a missing, damaged or older
// index is simply built again from the files (in the background; search falls back to scanning meanwhile).
//   <dataDir>/search.db   FTS5. Chinese (and Japanese / Korean) is indexed as overlapping two-character pieces
//                         (网格加密 -> 网格 格加 加密), so any query of two or more such characters is an index lookup (a
//                         longer one: those pieces as a phrase); other text by words (unicode61: case-insensitive, a
//                         query word also matches longer words it begins). A single Chinese character, or a word
//                         that only occurs inside a longer one, is looked for with LIKE over the stored text.
// Node's built-in node:sqlite (Node 22.5+) -- nothing to install. Without it, open() returns null and search scans.
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = '4';
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

// text as the index's tokens: each CJK run as overlapping pairs (one character alone stays), the rest as it is
function seg(s) {
  return String(s).replace(CJK_RUN, (run) => ' ' + (run.length < 2 ? run : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)).join(' ')) + ' ');
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SWEEP_BATCH = 40;
const PREFIX_MAX = 40;                  // a query word standing for more indexed words than this stays a prefix query                 // files per step of the background sweep

// node:sqlite still prints an "experimental" warning when loaded: not for this one
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) { if (/SQLite/i.test(String(w && w.message || w))) return; return emit.call(process, w, ...rest); };
  try { return require('node:sqlite'); } catch { return null; } finally { setTimeout(() => { process.emitWarning = emit; }, 0); }
}

// one stored record as the text search sees: what was said, tool lines, full commands, paths, task items, plans
function recText(r) {
  if (!r || r.role === 'title' || r.role === 'mode' || r.role === 'ctx') return '';
  const parts = [r.text || '', ...(r.items || [])];
  if (r.x) parts.push(r.x.cmd || '', ...(r.x.p || []), ...((r.x.todos || []).map((t) => t[0])), r.x.plan ? r.x.plan.slice(0, 4000) : '');
  return parts.filter(Boolean).join(' · ');
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
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, off INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (lo INTEGER PRIMARY KEY, hi INTEGER NOT NULL, machine TEXT, session TEXT, tmax INTEGER, file TEXT);`);
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(lines, 'row');");
    const v = db.prepare('SELECT v FROM meta WHERE k = ?').get('version');
    if (!v || v.v !== VERSION) {                                   // new, or an older layout: start over
      db.exec(`DROP TABLE IF EXISTS vocab; DROP TABLE IF EXISTS lines; DELETE FROM files; DELETE FROM chunks;
        CREATE VIRTUAL TABLE lines USING fts5(seg, text UNINDEXED, machine UNINDEXED, session UNINDEXED, t UNINDEXED, role UNINDEXED, file UNINDEXED, tokenize = 'unicode61');`);
      db.exec("CREATE VIRTUAL TABLE vocab USING fts5vocab(lines, 'row');");
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('version', VERSION);
    }
  };
  try { create(); }
  catch (e) {                                                       // damaged: put it aside and build a new one
    log('搜索索引打不开（' + e.message + '），重建');
    try { db && db.close(); } catch {}
    for (const sfx of ['', '-wal', '-shm']) { try { fs.renameSync(file + sfx, file + sfx + '.bad'); } catch {} }
    try { create(); } catch (e2) { log('搜索索引建不起来：' + e2.message); return null; }
  }

  const q = {
    off: db.prepare('SELECT off FROM files WHERE path = ?'),
    setOff: db.prepare('INSERT OR REPLACE INTO files (path, off) VALUES (?, ?)'),
    add: db.prepare('INSERT INTO lines (seg, text, machine, session, t, role, file) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    dropFile: db.prepare('DELETE FROM lines WHERE file = ?'),
    dropChunks: db.prepare('DELETE FROM chunks WHERE file = ?'),
    addChunk: db.prepare('INSERT INTO chunks (lo, hi, machine, session, tmax, file) VALUES (?, ?, ?, ?, ?, ?)'),
    maxRow: db.prepare('SELECT rowid AS r FROM lines ORDER BY rowid DESC LIMIT 1'),   // (max(rowid) would read every row)
    growChunk: db.prepare('UPDATE chunks SET hi = ?, tmax = max(tmax, ?) WHERE lo = ?'),
  };
  const rel = (f) => path.relative(dataDir, f).replace(/\\/g, '/');

  // which session a row belongs to without reading the row: every catch-up of a file inserts one run of row numbers
  // (a chunk), kept in memory sorted by its first row; a lookup is a binary search
  let chunks = [], chunkGen = 0;                                  // (chunkGen: bumped on every change, for byLo's map)
  const loadChunks = () => { chunkGen++; chunks = db.prepare('SELECT lo, hi, machine, session, tmax, file FROM chunks ORDER BY lo').all().map((c) => ({ ...c, key: c.machine + '|' + c.session })); };
  loadChunks();
  const byLo = () => { if (byLo.gen !== chunkGen) { byLo.map = new Map(chunks.map((c) => [c.lo, c])); byLo.gen = chunkGen; } return byLo.map; };
  // the chunks holding rows that match an FTS query (SQLite does the row -> chunk step: fast for common words too)
  const chunksSql = () => chunksSql.s || (chunksSql.s = db.prepare('SELECT DISTINCT (SELECT lo FROM chunks WHERE lo <= lines.rowid ORDER BY lo DESC LIMIT 1) AS clo FROM lines WHERE lines MATCH ?'));
  function chunksMatching(arg) { const map = byLo(); return chunksSql().all(arg).map((r) => map.get(r.clo)).filter(Boolean); }

  // read one conversation file on from where the index stands (only whole lines: the store appends whole lines)
  function catchUp(f) {
    let st; try { st = fs.statSync(f); } catch { return; }
    const key = rel(f), row = q.off.get(key);
    let off = row ? row.off : 0;
    if (st.size === off) return;
    const [, machine, name] = key.split('/');
    db.exec('BEGIN');
    try {
      if (st.size < off) { q.dropFile.run(key); q.dropChunks.run(key); off = 0; }   // rewritten: index it again
      const n = st.size - off, buf = Buffer.alloc(n);
      const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, n, off); } finally { fs.closeSync(fd); }
      const end = buf.lastIndexOf(10) + 1;                           // up to the last complete line
      const sess = name.replace(/\.jsonl$/, ''), first = ((q.maxRow.get() || {}).r || 0) + 1;
      let tmax = 0, added = 0;
      for (const l of buf.toString('utf8', 0, end).split('\n')) {
        if (!l) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        const text = recText(r);
        if (!text) continue;
        q.add.run(seg(text), text, machine, sess, +r.t || 0, String(r.role || ''), key);
        added++; tmax = Math.max(tmax, +r.t || 0);
      }
      const last = ((q.maxRow.get() || {}).r || 0);
      if (added && last - first + 1 !== added) throw new Error('row numbers not consecutive');
      const prev = chunks[chunks.length - 1];
      const grow = added && prev && prev.hi === first - 1 && prev.file === key && st.size >= (row ? row.off : 0);
      if (grow) q.growChunk.run(last, tmax, prev.lo);
      else if (added) q.addChunk.run(first, last, machine, sess, tmax, key);
      q.setOff.run(key, off + end);
      db.exec('COMMIT');
      if (st.size < (row ? row.off : 0)) loadChunks();
      else if (grow) { prev.hi = last; prev.tmax = Math.max(prev.tmax, tmax); chunkGen++; }
      else if (added) { chunks.push({ lo: first, hi: last, machine, session: sess, tmax, file: key, key: machine + '|' + sess }); chunkGen++; }
    } catch (e) { db.exec('ROLLBACK'); loadChunks(); log(`搜索索引：${key} 没索引上（${e.message}）`); }
  }

  // what the store wrote since the last search: indexed before the next one
  const dirty = new Set();
  const touched = (f) => dirty.add(f);
  function fresh() { for (const f of dirty) catchUp(f); dirty.clear(); }

  // every file once, in steps (a new or rebuilt index); ready when done
  let ready = false;
  function allFiles() {
    const out = [];
    let days = []; try { days = fs.readdirSync(dataDir).filter((d) => DAY.test(d)).sort(); } catch {}
    for (const d of days) {
      let ms = []; try { ms = fs.readdirSync(path.join(dataDir, d)); } catch { continue; }
      for (const m of ms) { let fs2 = []; try { fs2 = fs.readdirSync(path.join(dataDir, d, m)); } catch { continue; } for (const f of fs2) if (f.endsWith('.jsonl')) out.push(path.join(dataDir, d, m, f)); }
    }
    return out;
  }
  function sweep(done = () => {}) {
    const files = allFiles(), t0 = Date.now();
    let i = 0;
    const step = () => {
      for (const end = Math.min(files.length, i + SWEEP_BATCH); i < end; i++) catchUp(files[i]);
      if (i < files.length) return setImmediate(step);
      ready = true;
      log(`搜索索引就绪：${files.length} 个对话文件（${Date.now() - t0} ms）`);
      done();
    };
    step();
  }

  // sessions where every term occurs (in any of its records): [{ machine, session, last, all, hits: [{ t, role, text }] }]
  // machine / session are the store's file-safe names. A term goes to the index as a phrase of its tokens (the last
  // one a prefix when it is a word); one with a lone CJK character, or no tokens, is a LIKE over the stored text.
  const like = (t) => '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const vocabSql = () => vocabSql.s || (vocabSql.s = db.prepare('SELECT term FROM vocab WHERE term >= ? AND term < ? LIMIT ' + (PREFIX_MAX + 1)));
  const LIKE = (t) => ({ sql: "text LIKE ? ESCAPE '\\'", arg: like(t) });
  function cond(t) {
    if ((t.match(CJK_RUN) || []).some((r) => r.length < 2)) return LIKE(t);
    const toks = seg(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!toks.length) return LIKE(t);
    const prefix = /[\p{L}\p{N}]$/u.test(t) && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]$/.test(t);
    const phrase = (ws) => '"' + ws.join(' ').replace(/"/g, '""') + '"';
    if (!prefix) return { sql: 'lines MATCH ?', arg: phrase(toks) };
    const last = toks[toks.length - 1].toLowerCase(), head = toks.slice(0, -1);
    const words = vocabSql().all(last, last + '\uffff').map((r) => r.term);
    if (!words.length) return { sql: 'lines MATCH ?', arg: phrase(toks) };              // (nothing: matches nothing)
    if (words.length > PREFIX_MAX) return { sql: 'lines MATCH ?', arg: phrase(toks) + ' *' };
    return { sql: 'lines MATCH ?', arg: '(' + words.map((w) => phrase([...head, w])).join(' OR ') + ')' };
  }
  function find(terms, { maxSessions = 30, hitsPerSession = 3 } = {}) {
    fresh();
    let cand = null;                                                  // "machine|session" -> last time
    for (const t of terms) {
      const c = cond(t);
      let m;
      if (c.sql === 'lines MATCH ?') {                                // row numbers only: answered from the index itself
        m = new Map();
        for (const ch of chunksMatching(c.arg)) if ((m.get(ch.key) || 0) < ch.tmax) m.set(ch.key, ch.tmax);
      } else {
        const rows = db.prepare(`SELECT machine, session, max(t) AS last FROM lines WHERE ${c.sql} GROUP BY machine, session`).all(c.arg);
        m = new Map(rows.map((r) => [r.machine + '|' + r.session, r.last]));
      }
      cand = cand ? new Map([...cand].filter(([k]) => m.has(k)).map(([k, v]) => [k, Math.max(v, m.get(k))])) : m;
      if (!cand.size) return [];
    }
    // rank first, from row numbers only: sessions with a record holding every term (one query of all the terms), then
    // the newest; passages only for the sessions shown, each looked up inside that session's own rows (row ranges
    // FTS5 restricts to cheaply) -- the work does not grow with how common a word is
    const all = terms.map(cond);
    const allMatch = all.every((c) => c.sql === 'lines MATCH ?');
    const both = allMatch ? [{ sql: 'lines MATCH ?', arg: all.map((c) => c.arg).join(' AND ') }] : all;
    let fullSet;
    if (terms.length === 1) fullSet = new Set(cand.keys());
    else if (allMatch) {
      fullSet = new Set(chunksMatching(both[0].arg).map((ch) => ch.key));
    } else fullSet = new Set(db.prepare(`SELECT DISTINCT machine, session FROM lines WHERE ${all.map((c) => c.sql).join(' AND ')}`).all(...all.map((c) => c.arg)).map((r) => r.machine + '|' + r.session));
    const out = [...cand].map(([k, last]) => ({ k, last, all: fullSet.has(k) }))
      .sort((x, y) => (y.all - x.all) || (y.last - x.last)).slice(0, maxSessions);
    const bySession = new Map();
    for (const c of chunks) { if (!bySession.has(c.key)) bySession.set(c.key, []); bySession.get(c.key).push(c); }
    const stmts = new Map();
    const hitsIn = (k, cs) => {
      const sqlKey = cs === both ? 'both' : 'first';
      if (!stmts.has(sqlKey)) stmts.set(sqlKey, db.prepare(`SELECT t, role, text FROM lines WHERE ${cs.map((c) => c.sql).join(' AND ')} AND rowid BETWEEN ? AND ? ORDER BY rowid DESC LIMIT ?`));
      const sql = stmts.get(sqlKey), got = [];
      for (const ch of [...(bySession.get(k) || [])].reverse()) {              // newest chunk first
        for (const r of sql.all(...cs.map((c) => c.arg), ch.lo, ch.hi, hitsPerSession - got.length)) got.push({ t: r.t, role: r.role, text: r.text });
        if (got.length >= hitsPerSession) break;
      }
      return got.sort((x, y) => y.t - x.t);
    };
    // a LIKE term (a lone CJK character) cannot use row ranges: one pass over the matching rows, newest first, for all
    // the shown sessions at once
    const likeHits = (cs, want) => {
      const got = new Map(); let full = 0;
      if (!want.size) return got;
      for (const r of db.prepare(`SELECT machine, session, t, role, text FROM lines WHERE ${cs.map((c) => c.sql).join(' AND ')} ORDER BY rowid DESC`).iterate(...cs.map((c) => c.arg))) {
        const k = r.machine + '|' + r.session, l = got.get(k) || [];
        if (!want.has(k) || l.length >= hitsPerSession) continue;
        l.push({ t: r.t, role: r.role, text: r.text }); got.set(k, l);
        if (l.length === hitsPerSession && ++full === want.size) break;
      }
      return got;
    };
    if (!allMatch) {
      const full = likeHits(both, new Set(out.filter((x) => x.all).map((x) => x.k)));
      const part = likeHits([all[0]], new Set(out.filter((x) => !x.all).map((x) => x.k)));
      return out.map((x) => { const [machine, session] = x.k.split('|'); return { machine, session, last: x.last, all: x.all, hits: ((x.all ? full : part).get(x.k) || []).sort((a, b) => b.t - a.t) }; });
    }
    return out.map((x) => { const [machine, session] = x.k.split('|'); return { machine, session, last: x.last, all: x.all, hits: hitsIn(x.k, x.all ? both : [all[0]]) }; });
  }

  return { find, touched, sweep, ready: () => ready, catchUp, close: () => { try { db.close(); } catch {} } };
}

module.exports = { open, recText, seg };
