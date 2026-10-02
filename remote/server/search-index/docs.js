// Documents in the search index, one row of `docs` each: daily reports, notes, artifacts and mail.
//   sync(kind, items, textOf): small collections that change (reports, notes, artifacts) -- each item has a version
//     (file time, edit time, ...); only what changed is indexed again, what is gone is removed
//   tail(kind, files, parse): append-only .jsonl files (mail: <account>/<YYYY-MM>.jsonl) -- read on from where the
//     index stands, like the conversations; a file that is gone takes its rows with it (an account removed)
//   find(terms, kind, limit): the documents of a kind holding every term, newest first
'use strict';
const fs = require('fs');
const { seg, condMaker } = require('./terms');

const SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(seg, text UNINDEXED, kind UNINDEXED, ref UNINDEXED, t UNINDEXED, file UNINDEXED, tokenize = 'unicode61');
  CREATE VIRTUAL TABLE IF NOT EXISTS dvocab USING fts5vocab(docs, 'row');
  CREATE TABLE IF NOT EXISTS docver (kind TEXT NOT NULL, ref TEXT NOT NULL, ver TEXT, rid INTEGER, PRIMARY KEY (kind, ref));`;
const DROP = 'DROP TABLE IF EXISTS dvocab; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS docver;';

function createDocs(db, { log }) {
  const q = {
    add: db.prepare('INSERT INTO docs (seg, text, kind, ref, t, file) VALUES (?, ?, ?, ?, ?, ?)'),
    del: db.prepare('DELETE FROM docs WHERE rowid = ?'),
    vers: db.prepare('SELECT ref, ver, rid FROM docver WHERE kind = ?'),
    setVer: db.prepare('INSERT OR REPLACE INTO docver (kind, ref, ver, rid) VALUES (?, ?, ?, ?)'),
    delVer: db.prepare('DELETE FROM docver WHERE kind = ? AND ref = ?'),
    off: db.prepare('SELECT off FROM files WHERE path = ?'),
    setOff: db.prepare('INSERT OR REPLACE INTO files (path, off) VALUES (?, ?)'),
    tracked: db.prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\'"),
    dropFile: db.prepare('DELETE FROM docs WHERE file = ?'),
    forget: db.prepare('DELETE FROM files WHERE path = ?'),
  };
  const cond = condMaker(db, 'docs', 'dvocab');
  const txn = (what, f) => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); log(`搜索索引：${what} 没索引上（${e.message}）`); return null; } };

  // items: [{ ref, ver, t }]; textOf(ref) -> the text to search (empty: not indexed)
  function sync(kind, items, textOf) {
    const have = new Map(q.vers.all(kind).map((r) => [r.ref, r]));
    const want = new Set();
    const changed = items.filter((it) => { want.add(String(it.ref)); const h = have.get(String(it.ref)); return !h || h.ver !== String(it.ver); });
    const gone = [...have.keys()].filter((ref) => !want.has(ref));
    if (!changed.length && !gone.length) return 0;
    return txn(kind, () => {
      for (const it of changed) {
        const ref = String(it.ref), h = have.get(ref);
        if (h && h.rid != null) q.del.run(h.rid);
        const text = String(textOf(it.ref) || '');
        const rid = text ? Number(q.add.run(seg(text), text, kind, ref, +it.t || 0, '').lastInsertRowid) : null;
        q.setVer.run(kind, ref, String(it.ver), rid);
      }
      for (const ref of gone) { const h = have.get(ref); if (h.rid != null) q.del.run(h.rid); q.delVer.run(kind, ref); }
      return changed.length + gone.length;
    });
  }

  // files: [{ abs, rel }] (rel: "<kind>/..." -- what the offsets are kept under); parse(record) -> { ref, t, text } | null
  function tail(kind, files, parse) {
    const now = new Set(files.map((f) => f.rel));
    for (const { path: p } of q.tracked.all(kind.replace(/[\\%_]/g, (c) => '\\' + c) + '/%')) {
      if (!now.has(p)) txn(p, () => { q.dropFile.run(p); q.forget.run(p); });   // gone (an account removed)
    }
    for (const { abs, rel } of files) {
      let st; try { st = fs.statSync(abs); } catch { continue; }
      const row = q.off.get(rel);
      let off = row ? row.off : 0;
      if (st.size === off) continue;
      txn(rel, () => {
        if (st.size < off) { q.dropFile.run(rel); off = 0; }         // rewritten: index it again
        const n = st.size - off, buf = Buffer.alloc(n);
        const fd = fs.openSync(abs, 'r'); try { fs.readSync(fd, buf, 0, n, off); } finally { fs.closeSync(fd); }
        const end = buf.lastIndexOf(10) + 1;
        for (const l of buf.toString('utf8', 0, end).split('\n')) {
          if (!l) continue;
          let r; try { r = JSON.parse(l); } catch { continue; }
          const d = parse(r);
          if (d && d.text) q.add.run(seg(d.text), d.text, kind, String(d.ref), +d.t || 0, rel);
        }
        q.setOff.run(rel, off + end);
      });
    }
  }

  // -> [{ ref, t, text }]: every term in the one document, newest first
  function find(terms, kind, limit = 50) {
    const all = cond.all(terms).list;
    return db.prepare(`SELECT ref, t, text FROM docs WHERE ${all.map((c) => c.sql).join(' AND ')} AND kind = ? ORDER BY t DESC LIMIT ?`)
      .all(...all.map((c) => c.arg), kind, limit);
  }

  return { sync, tail, find };
}

module.exports = { createDocs, SCHEMA, DROP };
