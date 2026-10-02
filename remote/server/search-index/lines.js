// The conversations in the search index: data/<day>/<machine>/<session>.jsonl, every record one row of `lines`.
// Each file is indexed up to the byte it has reached; a file the store appends to is read on from there.
// Every catch-up of a file inserts one run of row numbers (a chunk: one session, one day) -- kept in memory, so
// which session a row belongs to is known without reading the row.
'use strict';
const fs = require('fs');
const path = require('path');
const { seg, condMaker } = require('./terms');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// one stored record as the text search sees: what was said, tool lines, full commands, paths, task items, plans
function recText(r) {
  if (!r || r.role === 'title' || r.role === 'mode' || r.role === 'ctx') return '';
  const parts = [r.text || '', ...(r.items || [])];
  if (r.x) parts.push(r.x.cmd || '', ...(r.x.p || []), ...((r.x.todos || []).map((t) => t[0])), r.x.plan ? r.x.plan.slice(0, 4000) : '');
  return parts.filter(Boolean).join(' · ');
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS chunks (lo INTEGER PRIMARY KEY, hi INTEGER NOT NULL, machine TEXT, session TEXT, tmax INTEGER, file TEXT);
  CREATE VIRTUAL TABLE IF NOT EXISTS lines USING fts5(seg, text UNINDEXED, machine UNINDEXED, session UNINDEXED, t UNINDEXED, role UNINDEXED, file UNINDEXED, tokenize = 'unicode61');
  CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(lines, 'row');`;
const DROP = 'DROP TABLE IF EXISTS vocab; DROP TABLE IF EXISTS lines; DROP TABLE IF EXISTS chunks;';

function createLines(db, { dataDir, log }) {
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
  const cond = condMaker(db, 'lines', 'vocab');
  const rel = (f) => path.relative(dataDir, f).replace(/\\/g, '/');

  let chunks = [], chunkGen = 0;                                  // (chunkGen: bumped on every change, for byLo's map)
  const loadChunks = () => { chunkGen++; chunks = db.prepare('SELECT lo, hi, machine, session, tmax, file FROM chunks ORDER BY lo').all().map((c) => ({ ...c, key: c.machine + '|' + c.session })); };
  loadChunks();
  const byLo = () => { if (byLo.gen !== chunkGen) { byLo.map = new Map(chunks.map((c) => [c.lo, c])); byLo.gen = chunkGen; } return byLo.map; };
  // the chunks holding rows that match an FTS query (SQLite does the row -> chunk step: fast for common words too)
  const chunksSql = db.prepare(`SELECT DISTINCT (SELECT lo FROM chunks WHERE lo <= lines.rowid ORDER BY lo DESC LIMIT 1) AS clo FROM lines WHERE ${cond.MATCH}`);
  function chunksMatching(arg) { const map = byLo(); return chunksSql.all(arg).map((r) => map.get(r.clo)).filter(Boolean); }

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
      // the same file again right after its last rows (one session busy on its own): its chunk grows instead
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

  function allFiles() {
    const out = [];
    let days = []; try { days = fs.readdirSync(dataDir).filter((d) => DAY.test(d)).sort(); } catch {}
    for (const d of days) {
      let ms = []; try { ms = fs.readdirSync(path.join(dataDir, d)); } catch { continue; }
      for (const m of ms) { let fs2 = []; try { fs2 = fs.readdirSync(path.join(dataDir, d, m)); } catch { continue; } for (const f of fs2) if (f.endsWith('.jsonl')) out.push(path.join(dataDir, d, m, f)); }
    }
    return out;
  }

  // sessions where every term occurs (in any of its records): [{ machine, session, last, all, hits: [{ t, role, text }] }]
  // (machine / session: the store's file-safe names). Ranked first, from row numbers only: sessions with a record
  // holding every term, then the newest; passages only for the sessions shown, each looked up inside that session's
  // own rows (row ranges FTS5 restricts to cheaply) -- the work does not grow with how common a word is.
  function find(terms, { maxSessions = 30, hitsPerSession = 3 } = {}) {
    fresh();
    let cand = null;                                                  // "machine|session" -> last time
    for (const t of terms) {
      const c = cond(t);
      let m;
      if (c.sql === cond.MATCH) {                                     // row numbers only: answered from the index itself
        m = new Map();
        for (const ch of chunksMatching(c.arg)) if ((m.get(ch.key) || 0) < ch.tmax) m.set(ch.key, ch.tmax);
      } else {
        const rows = db.prepare(`SELECT machine, session, max(t) AS last FROM lines WHERE ${c.sql} GROUP BY machine, session`).all(c.arg);
        m = new Map(rows.map((r) => [r.machine + '|' + r.session, r.last]));
      }
      cand = cand ? new Map([...cand].filter(([k]) => m.has(k)).map(([k, v]) => [k, Math.max(v, m.get(k))])) : m;
      if (!cand.size) return [];
    }
    const all = cond.all(terms), both = all.list, first = [all.each[0]];
    let fullSet;
    if (terms.length === 1) fullSet = new Set(cand.keys());
    else if (all.match) fullSet = new Set(chunksMatching(both[0].arg).map((ch) => ch.key));
    else fullSet = new Set(db.prepare(`SELECT DISTINCT machine, session FROM lines WHERE ${both.map((c) => c.sql).join(' AND ')}`).all(...both.map((c) => c.arg)).map((r) => r.machine + '|' + r.session));
    const out = [...cand].map(([k, last]) => ({ k, last, all: fullSet.has(k) }))
      .sort((x, y) => (y.all - x.all) || (y.last - x.last)).slice(0, maxSessions);
    const split = (x) => { const [machine, session] = x.k.split('|'); return { machine, session, last: x.last, all: x.all }; };
    if (!all.match) {
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
      const full = likeHits(both, new Set(out.filter((x) => x.all).map((x) => x.k)));
      const part = likeHits(first, new Set(out.filter((x) => !x.all).map((x) => x.k)));
      return out.map((x) => ({ ...split(x), hits: ((x.all ? full : part).get(x.k) || []).sort((a, b) => b.t - a.t) }));
    }
    const bySession = new Map();
    for (const c of chunks) { if (!bySession.has(c.key)) bySession.set(c.key, []); bySession.get(c.key).push(c); }
    const stmt = (cs) => db.prepare(`SELECT t, role, text FROM lines WHERE ${cs.map((c) => c.sql).join(' AND ')} AND rowid BETWEEN ? AND ? ORDER BY rowid DESC LIMIT ?`);
    const sBoth = stmt(both), sFirst = stmt(first);
    const hitsIn = (k, sql, cs) => {
      const got = [];
      for (const ch of [...(bySession.get(k) || [])].reverse()) {              // newest chunk first
        for (const r of sql.all(...cs.map((c) => c.arg), ch.lo, ch.hi, hitsPerSession - got.length)) got.push({ t: r.t, role: r.role, text: r.text });
        if (got.length >= hitsPerSession) break;
      }
      return got.sort((a, b) => b.t - a.t);
    };
    return out.map((x) => ({ ...split(x), hits: x.all ? hitsIn(x.k, sBoth, both) : hitsIn(x.k, sFirst, first) }));
  }

  return { catchUp, touched, fresh, allFiles, find };
}

module.exports = { createLines, recText, SCHEMA, DROP };
