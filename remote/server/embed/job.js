// Incremental background indexing job for conversations (Stage 1), memories (Stage 2)
// and Zotero literature (items: title/abstract/tags/venue/year; notes/annotations).
// - Concurrency 1, batch size 16 (leaves 3 slots on remote3090 for live queries).
// - Checks /health before each run; skips cleanly when remote3090 is offline.
// - Daily consistency audit catches search.db rebuilds and prunes deleted files.
'use strict';
const fs = require('fs');
const path = require('path');
const { cleanLine, chunkText, hashText } = require('./clean');

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_EVERY_MS = 10 * 60 * 1000;

function parseDurationMs(v, fallback = DEFAULT_EVERY_MS) {
  if (typeof v === 'number' && v > 0) return v;
  const s = String(v || '').trim();
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 3600 * 1000;
  return n;
}

function createJob({
  client,
  store,
  searchIndex = null,
  memoryProvider = null,                 // () => { memories: [{id, name, body, scope, owner, enabled}], observed: [{machine, path, sha256, body}] }
  litProvider = null,                    // () => { items: [{key, title, abstract, tags, venue, year}], notes: [{key, parentKey, text}] }
  dataDir = '',
  batchSize = DEFAULT_BATCH_SIZE,
  everyMs = DEFAULT_EVERY_MS,
  log = () => {},
}) {
  let running = false;
  let stopped = false;
  let timer = null;
  let auditTimer = null;
  let lastError = '';
  let lastRunStats = null;
  let litFn = typeof litProvider === 'function' ? litProvider : null;

  function setLitProvider(fn) {
    litFn = typeof fn === 'function' ? fn : null;
  }

  async function syncLinesOnce({ maxRows = Infinity } = {}) {
    if (!searchIndex || typeof searchIndex.scanLines !== 'function') {
      return { ok: true, skipped: 'no-search-index', processedRows: 0, embedded: 0 };
    }
    if (typeof searchIndex.ready === 'function' && !searchIndex.ready()) {
      return { ok: true, skipped: 'search-index-not-ready', processedRows: 0, embedded: 0 };
    }

    const h = await client.health();
    if (!h.ok) {
      return { ok: false, skipped: 'offline', error: h.error || 'unhealthy', processedRows: 0, embedded: 0 };
    }

    const t0 = Date.now();
    let cursor = Number(store.getCursor('lines_rowid', '0')) || 0;
    // Detect search.db rebuild where rowid restarted lower than our cursor
    if (typeof searchIndex.maxRowid === 'function') {
      const maxId = searchIndex.maxRowid();
      if (maxId < cursor) {
        log(`向量增量：检测到 search.db 已重建（maxRowid ${maxId} < cursor ${cursor}），重置游标重新扫描`);
        cursor = 0;
        store.setCursor('lines_rowid', '0');
      }
    }

    let processedRows = 0;
    let embeddedChunks = 0;
    let reusedChunks = 0;
    let totalTokens = 0;

    while (!stopped && processedRows < maxRows) {
      const limit = Math.min(DEFAULT_SCAN_LIMIT, maxRows - processedRows);
      const rows = searchIndex.scanLines({ afterRowid: cursor, limit });
      if (!rows.length) break;

      const pendingNew = new Map();      // hash -> text
      const pendingRefs = [];
      let batchEndRowid = cursor;

      for (const row of rows) {
        batchEndRowid = row.rowid;
        processedRows++;
        const cleaned = cleanLine(row.text, row.role);
        if (!cleaned) continue;
        const chunks = chunkText(cleaned.text);
        for (const chunk of chunks) {
          const hash = hashText(chunk);
          pendingRefs.push({
            hash,
            machine: row.machine,
            session: row.session,
            t: row.t,
            role: row.role,
            file: row.file,
            tag: cleaned.tag,
          });
          if (store.hasHash(hash) || pendingNew.has(hash)) {
            reusedChunks++;
          } else {
            pendingNew.set(hash, chunk);
          }
        }
      }

      // Embed new unique chunks in batches of `batchSize` (concurrency = 1)
      const newEntries = [...pendingNew.entries()];
      const newVecs = [];
      for (let i = 0; i < newEntries.length; i += batchSize) {
        if (stopped) break;
        const slice = newEntries.slice(i, i + batchSize);
        const texts = slice.map(([, txt]) => txt);
        const { vectors, usage } = await client.embed(texts);
        if (usage && usage.prompt_tokens) totalTokens += Number(usage.prompt_tokens) || 0;
        for (let j = 0; j < slice.length; j++) {
          newVecs.push({ hash: slice[j][0], text: slice[j][1], vec: vectors[j] });
        }
        embeddedChunks += slice.length;
      }

      if (stopped) break;
      store.putChunks(newVecs, pendingRefs);
      cursor = batchEndRowid;
      store.setCursor('lines_rowid', String(cursor));
    }

    store.setCursor('last_sync_at', String(Date.now()));
    const result = {
      ok: true,
      processedRows,
      embedded: embeddedChunks,
      reused: reusedChunks,
      tokens: totalTokens,
      ms: Date.now() - t0,
      cursor,
    };
    if (embeddedChunks > 0) {
      log(`向量增量：新增 ${embeddedChunks} 块（复用 ${reusedChunks}，${totalTokens} tokens，${result.ms} ms）`);
    }
    return result;
  }

  async function syncMemoriesOnce() {
    if (typeof memoryProvider !== 'function') {
      return { ok: true, skipped: 'no-memory-provider', embedded: 0 };
    }
    const h = await client.health();
    if (!h.ok) {
      return { ok: false, skipped: 'offline', error: h.error || 'unhealthy', embedded: 0 };
    }

    const t0 = Date.now();
    const { memories = [], observed = [] } = memoryProvider() || {};
    const wanted = [];
    const seen = { memory: new Set(), observed: new Set() };

    for (const m of memories) {
      if (!m || !m.id || !m.body) continue;
      const text = `${m.name ? m.name + '\n' : ''}${m.body}`.trim();
      if (!text) continue;
      const sha = hashText(text);
      seen.memory.add(m.id);
      const cur = store.getMemoryVec('memory', m.id);
      if (!cur || cur.sha256 !== sha) {
        wanted.push({ kind: 'memory', key: m.id, sha256: sha, text });
      }
    }
    for (const o of observed) {
      if (!o || !o.machine || !o.path || !o.body) continue;
      const key = o.machine + '\0' + o.path;
      const text = String(o.body).trim();
      if (!text) continue;
      const sha = o.sha256 || hashText(text);
      seen.observed.add(key);
      const cur = store.getMemoryVec('observed', key);
      if (!cur || cur.sha256 !== sha) {
        wanted.push({ kind: 'observed', key, sha256: sha, text });
      }
    }

    const toDelete = [];
    for (const kind of ['memory', 'observed']) {
      for (const k of store.listMemoryKeys(kind)) {
        if (!seen[kind].has(k)) toDelete.push({ kind, key: k });
      }
    }

    let embedded = 0;
    const toWrite = [];
    for (let i = 0; i < wanted.length; i += batchSize) {
      if (stopped) break;
      const slice = wanted.slice(i, i + batchSize);
      const { vectors } = await client.embed(slice.map((x) => x.text));
      for (let j = 0; j < slice.length; j++) {
        toWrite.push({ kind: slice[j].kind, key: slice[j].key, sha256: slice[j].sha256, vec: vectors[j] });
      }
      embedded += slice.length;
    }

    if (!stopped) {
      if (toWrite.length) store.putMemories(toWrite);
      if (toDelete.length) store.deleteMemories(toDelete);
      store.setCursor('last_mem_sync_at', String(Date.now()));
    }

    const res = { ok: true, embedded, deleted: toDelete.length, ms: Date.now() - t0 };
    if (embedded > 0 || toDelete.length > 0) {
      log(`记忆向量同步：更新 ${embedded} 条，清理 ${toDelete.length} 条（${res.ms} ms）`);
    }
    return res;
  }

  function litItemText(it) {
    const tags = Array.isArray(it.tags) ? it.tags.map((t) => String((t && t.tag) || t || '').trim()).filter(Boolean).join(' ') : '';
    return [it.title, it.abstract, tags, it.venue, it.year]
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter(Boolean)
      .join('\n');
  }

  async function syncLitOnce() {
    if (!litFn) {
      return { ok: true, skipped: 'no-lit-provider', embedded: 0 };
    }
    const h = await client.health();
    if (!h.ok) {
      return { ok: false, skipped: 'offline', error: h.error || 'unhealthy', embedded: 0 };
    }

    const t0 = Date.now();
    const data = await litFn();
    if (!data || typeof data !== 'object') {
      return { ok: true, skipped: 'no-lit-data', embedded: 0 };
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const wanted = [];
    const seen = { item: new Set(), note: new Set() };

    for (const it of items) {
      if (!it || !it.key) continue;
      const key = String(it.key);
      if (seen.item.has(key)) continue;
      const text = litItemText(it);
      if (!text) continue;
      seen.item.add(key);
      const sha = hashText(text);
      const cur = store.getLitVec('item', key);
      if (!cur || cur.sha256 !== sha) wanted.push({ kind: 'item', key, parentKey: '', sha256: sha, text });
    }
    for (const n of notes) {
      if (!n || !n.key) continue;
      const key = String(n.key);
      if (seen.note.has(key)) continue;
      const text = String(n.text || '').trim();
      if (!text) continue;
      seen.note.add(key);
      const parentKey = String(n.parentKey || '');
      const sha = hashText(text);
      const cur = store.getLitVec('note', key);
      if (!cur || cur.sha256 !== sha || cur.parentKey !== parentKey) {
        wanted.push({ kind: 'note', key, parentKey, sha256: sha, text });
      }
    }

    const toDelete = [];
    for (const kind of ['item', 'note']) {
      for (const k of store.listLitKeys(kind)) {
        if (!seen[kind].has(k)) toDelete.push({ kind, key: k });
      }
    }

    // Concurrency 1, batches of batchSize; each batch is persisted immediately so an
    // interrupted run (offline mid-way, stop()) keeps its progress for the next pass.
    let embedded = 0;
    for (let i = 0; i < wanted.length; i += batchSize) {
      if (stopped) break;
      const slice = wanted.slice(i, i + batchSize);
      const { vectors } = await client.embed(slice.map((x) => x.text));
      store.putLitVecs(slice.map((x, j) => ({ kind: x.kind, key: x.key, parentKey: x.parentKey, sha256: x.sha256, vec: vectors[j] })));
      embedded += slice.length;
    }

    if (!stopped) {
      if (toDelete.length) store.deleteLitVecs(toDelete);
      store.setCursor('last_lit_sync_at', String(Date.now()));
    }

    const res = { ok: true, embedded, deleted: stopped ? 0 : toDelete.length, ms: Date.now() - t0 };
    if (embedded > 0 || res.deleted > 0) {
      log(`文献向量同步：更新 ${embedded} 条，清理 ${res.deleted} 条（${res.ms} ms）`);
    }
    return res;
  }

  // Literature sync must never break the conversation/memory pipeline (Zotero DB may be locked/missing).
  async function syncLitSafe() {
    try {
      return await syncLitOnce();
    } catch (e) {
      const error = e.message || String(e);
      log('文献向量同步出错：' + error);
      return { ok: false, error, embedded: 0 };
    }
  }

  async function auditConsistency() {
    const t0 = Date.now();
    let pruned = { removedFiles: 0, removedVecs: 0 };
    if (dataDir) {
      pruned = store.pruneMissingFiles((rel) => {
        try { return fs.existsSync(path.join(dataDir, rel)); }
        catch { return true; }
      });
    }
    // Reset cursor to 0 and do a cheap catch-up pass: existing hashes are skipped in-memory without calling GPU.
    store.setCursor('lines_rowid', '0');
    const linesRes = await syncLinesOnce();
    const memRes = await syncMemoriesOnce();
    const litRes = await syncLitSafe();
    store.setCursor('last_audit_at', String(Date.now()));
    log(`向量一致性核对完成：清理失效文件 ${pruned.removedFiles}，补算对话 ${linesRes.embedded || 0} 块，记忆 ${memRes.embedded || 0} 条，文献 ${litRes.embedded || 0} 条（${Date.now() - t0} ms）`);
    return { ok: true, pruned, lines: linesRes, memories: memRes, lit: litRes, ms: Date.now() - t0 };
  }

  async function runOnce() {
    if (running || stopped) return { ok: false, skipped: 'busy' };
    running = true;
    try {
      const lines = await syncLinesOnce();
      const memories = await syncMemoriesOnce();
      const lit = await syncLitSafe();
      lastError = '';
      lastRunStats = { at: Date.now(), lines, memories, lit };
      return { ok: lines.ok !== false && memories.ok !== false && lit.ok !== false, lines, memories, lit };
    } catch (e) {
      lastError = e.message || String(e);
      log('向量增量任务出错：' + lastError);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  function scheduleNextAudit() {
    if (stopped) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = Math.max(60000, next.getTime() - now.getTime());
    auditTimer = setTimeout(async () => {
      if (stopped) return;
      if (!running) {
        running = true;
        try { await auditConsistency(); }
        catch (e) { lastError = e.message || String(e); log('向量一致性核对失败：' + lastError); }
        finally { running = false; }
      }
      scheduleNextAudit();
    }, delay);
    if (auditTimer.unref) auditTimer.unref();
  }

  function start() {
    if (timer || stopped) return;
    const ms = parseDurationMs(everyMs, DEFAULT_EVERY_MS);
    timer = setInterval(() => { runOnce(); }, ms);
    if (timer.unref) timer.unref();
    scheduleNextAudit();
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (auditTimer) { clearTimeout(auditTimer); auditTimer = null; }
  }

  function status() {
    return { running, lastError, lastRun: lastRunStats };
  }

  return {
    syncLinesOnce,
    syncMemoriesOnce,
    syncLitOnce,
    setLitProvider,
    auditConsistency,
    runOnce,
    start,
    stop,
    status,
  };
}

module.exports = { createJob, parseDurationMs };
