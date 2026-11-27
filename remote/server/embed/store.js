// Derived vector store: <dataDir>/vectors.sqlite (Node built-in node:sqlite, zero external deps).
// Keeps conversation chunk vectors (deduplicated by SHA-256) + refs, memory entry vectors,
// and literature vectors (lit_vec: Zotero item title/abstract + notes/annotations).
// lit_vec is added via CREATE TABLE IF NOT EXISTS, so SCHEMA_VERSION stays '1' and existing stores are kept.
// Vectors are kept in memory as Float32Arrays for fast brute-force dot-product search.
// Deleting the file or changing model/dims/task/ruleVersion cleanly rebuilds from scratch.
'use strict';
const fs = require('fs');
const path = require('path');
const { dot } = require('./client');
const { loadSqlite, quarantineSqliteFiles } = require('../lib/sqlite-util');

const SCHEMA_VERSION = '1';

function toBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBlob(buf, dims) {
  const u8 = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  const f32 = new Float32Array(copy.buffer);
  return dims && f32.length > dims ? f32.subarray(0, dims) : f32;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vec (
    hash TEXT PRIMARY KEY,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL,
    text TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS refs (
    hash TEXT NOT NULL,
    machine TEXT NOT NULL,
    session TEXT NOT NULL,
    t INTEGER NOT NULL,
    role TEXT NOT NULL,
    file TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (hash, machine, session, t, role, file)
  );
  CREATE INDEX IF NOT EXISTS refs_hash ON refs (hash);
  CREATE INDEX IF NOT EXISTS refs_file ON refs (file);
  CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mem_vec (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE TABLE IF NOT EXISTS lit_vec (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    parent_key TEXT NOT NULL DEFAULT '',
    sha256 TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
`;

const DROP_ALL = `
  DROP TABLE IF EXISTS refs;
  DROP TABLE IF EXISTS vec;
  DROP TABLE IF EXISTS cursor;
  DROP TABLE IF EXISTS mem_vec;
  DROP TABLE IF EXISTS lit_vec;
`;

function openStore({ dataDir, model = 'Qwen3-Embedding-4B', dims = 2560, task = '', ruleVersion = '1', log = () => {} }) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    log('向量库：当前 Node 不支持 node:sqlite');
    return null;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'vectors.sqlite');

  const expectedMeta = {
    schema_version: SCHEMA_VERSION,
    model: String(model),
    dims: String(dims),
    task: String(task),
    rule_version: String(ruleVersion),
  };

  let db;
  let rebuilt = false;

  const init = () => {
    db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    const rows = db.prepare('SELECT k, v FROM meta').all();
    const cur = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    const mismatch = Object.entries(expectedMeta).some(([k, v]) => cur[k] !== v);
    if (rows.length > 0 && mismatch) {
      log(`向量库配置变更（${JSON.stringify(cur)} -> ${JSON.stringify(expectedMeta)}），清空重建`);
      db.exec(DROP_ALL);
      db.exec(SCHEMA);
      rebuilt = true;
    }
    const setMeta = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
    for (const [k, v] of Object.entries(expectedMeta)) setMeta.run(k, v);
  };

  try {
    init();
  } catch (e) {
    log('向量库打不开（' + e.message + '），移走并重建');
    try { db && db.close(); } catch {}
    quarantineSqliteFiles(file);
    try {
      init();
      rebuilt = true;
    } catch (e2) {
      log('向量库建不起来：' + e2.message);
      return null;
    }
  }

  const q = {
    hasVec: db.prepare('SELECT 1 FROM vec WHERE hash = ?'),
    putVec: db.prepare('INSERT OR IGNORE INTO vec (hash, dims, vec, text, created) VALUES (?, ?, ?, ?, ?)'),
    putRef: db.prepare('INSERT OR IGNORE INTO refs (hash, machine, session, t, role, file, tag) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getVec: db.prepare('SELECT hash, text FROM vec WHERE hash = ?'),
    getRefs: db.prepare('SELECT machine, session, t, role, file, tag FROM refs WHERE hash = ? ORDER BY t DESC'),
    getCursor: db.prepare('SELECT v FROM cursor WHERE k = ?'),
    setCursor: db.prepare('INSERT OR REPLACE INTO cursor (k, v) VALUES (?, ?)'),
    putMem: db.prepare('INSERT OR REPLACE INTO mem_vec (kind, key, sha256, dims, vec, updated) VALUES (?, ?, ?, ?, ?, ?)'),
    delMem: db.prepare('DELETE FROM mem_vec WHERE kind = ? AND key = ?'),
    putLit: db.prepare('INSERT OR REPLACE INTO lit_vec (kind, key, parent_key, sha256, dims, vec, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    delLit: db.prepare('DELETE FROM lit_vec WHERE kind = ? AND key = ?'),
    allRefsFiles: db.prepare('SELECT DISTINCT file FROM refs'),
    delRefsByFile: db.prepare('DELETE FROM refs WHERE file = ?'),
    delOrphanVecs: db.prepare('DELETE FROM vec WHERE hash NOT IN (SELECT DISTINCT hash FROM refs)'),
  };

  // In-memory vector indexes
  const chunkIndex = new Map();          // hash -> Float32Array
  const memIndex = new Map();            // "kind\0key" -> { kind, key, sha256, vec: Float32Array }
  const litIndex = new Map();            // "kind\0key" -> { kind, key, parentKey, sha256, vec: Float32Array }

  function loadMemory() {
    chunkIndex.clear();
    for (const r of db.prepare('SELECT hash, vec FROM vec').iterate()) {
      chunkIndex.set(r.hash, fromBlob(r.vec, dims));
    }
    memIndex.clear();
    for (const r of db.prepare('SELECT kind, key, sha256, vec FROM mem_vec').iterate()) {
      memIndex.set(r.kind + '\0' + r.key, { kind: r.kind, key: r.key, sha256: r.sha256, vec: fromBlob(r.vec, dims) });
    }
    litIndex.clear();
    for (const r of db.prepare('SELECT kind, key, parent_key, sha256, vec FROM lit_vec').iterate()) {
      litIndex.set(r.kind + '\0' + r.key, { kind: r.kind, key: r.key, parentKey: r.parent_key || '', sha256: r.sha256, vec: fromBlob(r.vec, dims) });
    }
  }
  loadMemory();

  function hasHash(hash) {
    return chunkIndex.has(hash) || !!q.hasVec.get(hash);
  }

  // Batch write vectors + refs in one transaction and update in-memory index.
  function putChunks(vecs, refs) {
    if (!vecs.length && !refs.length) return;
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const v of vecs) {
        const f32 = v.vec instanceof Float32Array ? v.vec : new Float32Array(v.vec);
        q.putVec.run(v.hash, f32.length, toBlob(f32), v.text, now);
        chunkIndex.set(v.hash, f32);
      }
      for (const r of refs) {
        q.putRef.run(r.hash, r.machine, r.session, +r.t || 0, String(r.role || ''), String(r.file || ''), String(r.tag || ''));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function putRefs(refs) {
    if (!refs.length) return;
    db.exec('BEGIN');
    try {
      for (const r of refs) {
        q.putRef.run(r.hash, r.machine, r.session, +r.t || 0, String(r.role || ''), String(r.file || ''), String(r.tag || ''));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function getCursor(k, fallback = null) {
    const r = q.getCursor.get(k);
    return r ? r.v : fallback;
  }

  function setCursor(k, v) {
    q.setCursor.run(k, String(v));
  }

  // Top-K brute-force dot-product search without sorting the entire corpus.
  function searchVectors(queryVec, topK = 50) {
    if (!chunkIndex.size || !queryVec || !queryVec.length) return [];
    const k = Math.max(1, topK);
    const best = [];                     // sorted descending by score, length <= k
    let minScore = -Infinity;

    for (const [hash, vec] of chunkIndex.entries()) {
      const s = dot(queryVec, vec);
      if (best.length < k) {
        best.push({ hash, score: s });
        if (best.length === k) {
          best.sort((a, b) => b.score - a.score);
          minScore = best[k - 1].score;
        }
      } else if (s > minScore) {
        // Insert into sorted top-K array
        let pos = k - 1;
        while (pos > 0 && best[pos - 1].score < s) {
          best[pos] = best[pos - 1];
          pos--;
        }
        best[pos] = { hash, score: s };
        minScore = best[k - 1].score;
      }
    }
    if (best.length < k) best.sort((a, b) => b.score - a.score);

    return best.map((item) => {
      const row = q.getVec.get(item.hash);
      const refs = q.getRefs.all(item.hash);
      return {
        hash: item.hash,
        score: item.score,
        text: row ? row.text : '',
        refs,
      };
    });
  }

  // Prune refs whose files no longer exist (given a predicate exists(relPath)) and drop orphan vectors.
  function pruneMissingFiles(exists) {
    const files = q.allRefsFiles.all().map((r) => r.file).filter(Boolean);
    const gone = files.filter((f) => !exists(f));
    if (!gone.length) return { removedFiles: 0, removedVecs: 0 };
    let removedVecs = 0;
    db.exec('BEGIN');
    try {
      for (const f of gone) q.delRefsByFile.run(f);
      const res = q.delOrphanVecs.run();
      removedVecs = Number(res.changes || 0);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (removedVecs > 0) loadMemory();
    return { removedFiles: gone.length, removedVecs };
  }

  // ---- Stage 2: Memory vectors ----
  function getMemoryVec(kind, key) {
    return memIndex.get(kind + '\0' + key) || null;
  }

  function listMemoryKeys(kind) {
    const out = [];
    for (const v of memIndex.values()) if (v.kind === kind) out.push(v.key);
    return out;
  }

  function putMemories(entries) {
    if (!entries.length) return;
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const e of entries) {
        const f32 = e.vec instanceof Float32Array ? e.vec : new Float32Array(e.vec);
        q.putMem.run(e.kind, e.key, e.sha256, f32.length, toBlob(f32), now);
        memIndex.set(e.kind + '\0' + e.key, { kind: e.kind, key: e.key, sha256: e.sha256, vec: f32 });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function deleteMemories(keys) {
    if (!keys.length) return;
    db.exec('BEGIN');
    try {
      for (const { kind, key } of keys) {
        q.delMem.run(kind, key);
        memIndex.delete(kind + '\0' + key);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function searchMemories(queryVec, { topK = 10, kinds = ['memory'] } = {}) {
    if (!memIndex.size || !queryVec || !queryVec.length) return [];
    const allow = new Set(kinds);
    const scored = [];
    for (const e of memIndex.values()) {
      if (!allow.has(e.kind)) continue;
      scored.push({ kind: e.kind, key: e.key, sha256: e.sha256, score: dot(queryVec, e.vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  // Pairwise cosine similarity among a given list of { label, kind, key } items.
  function similarMemoryPairs(items, { threshold = 0.85 } = {}) {
    const vecs = items.map((it) => getMemoryVec(it.kind, it.key)?.vec || null);
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      if (!vecs[i]) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (!vecs[j]) continue;
        const s = dot(vecs[i], vecs[j]);
        if (s >= threshold) {
          pairs.push({
            left: items[i].label,
            right: items[j].label,
            score: s,
          });
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    return pairs;
  }

  // ---- Literature vectors (Zotero items: title/abstract; notes/annotations) ----
  function getLitVec(kind, key) {
    return litIndex.get(kind + '\0' + key) || null;
  }

  function listLitKeys(kind) {
    const out = [];
    for (const v of litIndex.values()) if (v.kind === kind) out.push(v.key);
    return out;
  }

  function putLitVecs(entries) {
    if (!entries || !entries.length) return;
    const now = Date.now();
    const staged = [];
    db.exec('BEGIN');
    try {
      for (const e of entries) {
        const f32 = e.vec instanceof Float32Array ? e.vec : new Float32Array(e.vec);
        const parentKey = String(e.parentKey || '');
        q.putLit.run(e.kind, e.key, parentKey, e.sha256, f32.length, toBlob(f32), now);
        staged.push({ kind: e.kind, key: e.key, parentKey, sha256: e.sha256, vec: f32 });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const e of staged) litIndex.set(e.kind + '\0' + e.key, e);
  }

  function deleteLitVecs(keys) {
    if (!keys || !keys.length) return;
    db.exec('BEGIN');
    try {
      for (const { kind, key } of keys) q.delLit.run(kind, key);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const { kind, key } of keys) litIndex.delete(kind + '\0' + key);
  }

  function searchLit(queryVec, { topK = 30, kinds = ['item', 'note'] } = {}) {
    if (!litIndex.size || !queryVec || !queryVec.length) return [];
    const allow = new Set(kinds);
    const scored = [];
    for (const e of litIndex.values()) {
      if (!allow.has(e.kind)) continue;
      scored.push({ kind: e.kind, key: e.key, parentKey: e.parentKey, score: dot(queryVec, e.vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  // Papers most similar to a given Zotero item (item vectors only, excluding itself).
  function similarLitItems(itemKey, { topK = 10 } = {}) {
    const self = litIndex.get('item\0' + itemKey);
    if (!self) return [];
    const scored = [];
    for (const e of litIndex.values()) {
      if (e.kind !== 'item' || e.key === itemKey) continue;
      scored.push({ key: e.key, score: dot(self.vec, e.vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, topK));
  }

  function stats() {
    const refsCount = db.prepare('SELECT count(*) AS n FROM refs').get().n;
    const memCount = [...memIndex.values()].filter((x) => x.kind === 'memory').length;
    const obsCount = [...memIndex.values()].filter((x) => x.kind === 'observed').length;
    const litCount = { item: 0, note: 0 };
    for (const x of litIndex.values()) if (x.kind in litCount) litCount[x.kind]++;
    return {
      file,
      rebuilt,
      dims,
      model,
      ruleVersion,
      chunks: chunkIndex.size,
      refs: refsCount,
      memories: memCount,
      observed: obsCount,
      linesRowid: Number(getCursor('lines_rowid', '0')) || 0,
      lastSyncAt: Number(getCursor('last_sync_at', '0')) || 0,
      lastAuditAt: Number(getCursor('last_audit_at', '0')) || 0,
      lastMemSyncAt: Number(getCursor('last_mem_sync_at', '0')) || 0,
      litItems: litCount.item,
      litNotes: litCount.note,
      lastLitSyncAt: Number(getCursor('last_lit_sync_at', '0')) || 0,
    };
  }

  function close() {
    try { db.close(); } catch {}
  }

  return {
    file,
    dims,
    hasHash,
    putChunks,
    putRefs,
    getCursor,
    setCursor,
    searchVectors,
    pruneMissingFiles,
    getMemoryVec,
    listMemoryKeys,
    putMemories,
    deleteMemories,
    searchMemories,
    similarMemoryPairs,
    getLitVec,
    listLitKeys,
    putLitVecs,
    deleteLitVecs,
    searchLit,
    similarLitItems,
    stats,
    close,
  };
}

module.exports = { openStore, SCHEMA_VERSION, toBlob };
