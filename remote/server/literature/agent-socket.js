// 下载 for agents: a small HTTP server on a local socket (a Unix socket owned by the server's user, 0600, in the
// module's own 0700 folder; a named pipe on Windows) -- never on a network address. Who can open the socket can use
// it: on the NAS that is the account the server runs as, reached by agents through SSH (mcp.js).
//   GET  /v1/limits                     what the queue allows (see downloads.limits)
//   POST /v1/downloads  { dois, by }    submit up to 20 DOIs -> { ok, results, limits }
//   GET  /v1/downloads?ids=a,b          those jobs (none given: the latest 30) -> { items, limits }
//   GET  /v1/pdf?id=                    a finished job's PDF (application/pdf; X-Job: the job as JSON)
//   GET /v1/search, POST /v1/evidence/query, GET /v1/contradictions, GET /v1/pages: read-only Zotero research
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const KEY = /^[A-Z0-9]{8}$/;
const DEFAULT_SCHEMA = 'plasma_rcs_v1';
const SCOPE_WARNING = '仅覆盖个人 Zotero 本地库；立项、查新或新点子论证时必须结合外部检索（OpenAlex/NTRS/arXiv/Web）交叉核验';
const KB_ROUTES = new Set(['GET /v1/search', 'POST /v1/evidence/query', 'GET /v1/contradictions', 'GET /v1/pages']);

// where the socket is when config.json does not say ("literature": { "agentSocket": ... })
const defaultSocket = (dir) => process.platform === 'win32'
  ? '\\\\.\\pipe\\ame-lit-' + crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12)
  : path.join(dir, 'agent.sock');

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve) => {
    const parts = []; let n = 0, over = false;
    req.on('data', (c) => { n += c.length; if (n > cap) { over = true; return; } if (!over) parts.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function evidencePaper(item, mirror) {
  const { title = '', year = null, citekey = '' } = mirror.item(item.zoteroKey) || {};
  return { ...item, title, year, citekey };
}

function searchPaper({ key, title, year, venue, citekey, abstract }, score) {
  return { key, title, year, venue, citekey, abstract, score };
}

function createAgentSocket({ socket, downloads, kb, log = () => {}, audit = () => {} }) {
  const json = (res, code, o) => { const b = JSON.stringify(o); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  async function handleKb(req, res, url) {
    const { mirror, fulltext, kbStruct, paradigm, embed } = kb;
    const library = mirror.items();
    const newestYear = library.reduce((year, it) => Math.max(year, Number(it.year) || 0), 0) || null;
    const reply = (code, data, matched = 0) => json(res, code, {
      ok: code < 400, ...data,
      coverage: { matched, library_total: library.length, newest_year: newestYear, scope_warning: SCOPE_WARNING },
    });
    const qs = (name) => url.searchParams.get(name) || '';
    try {
      if (url.pathname === '/v1/search') {
        const q = qs('q').trim();
        if (!q) return reply(400, { msg: '缺少检索词 q' });
        const k = Math.min(50, Math.max(1, Math.trunc(Number(qs('k')) || 10)));
        let semantic = 'off';
        if (typeof embed?.search?.queryLit === 'function') {
          let result;
          try { result = await embed.search.queryLit(q, { topK: k }); } catch {}
          if (result?.ok) {
            const items = (result.items || []).flatMap(({ key, score }) => {
              const item = mirror.item(key);
              return item ? [searchPaper(item, score)] : [];
            }).slice(0, k);
            return reply(200, { semantic: 'ok', items }, items.length);
          }
          semantic = 'unavailable';
        }
        const terms = q.toLowerCase().split(/\s+/);
        const items = library.filter((it) => {
          const text = [it.title, it.abstract].join(' ').toLowerCase();
          return terms.every((term) => text.includes(term));
        }).slice(0, k).map((it) => searchPaper(it, null));
        return reply(200, { semantic, items }, items.length);
      }
      if (url.pathname === '/v1/evidence/query') {
        if (!kbStruct) return reply(503, { msg: '结构化知识库不可用' });
        let d;
        try { d = JSON.parse(await readBody(req)); } catch {}
        if (!d || typeof d !== 'object' || Array.isArray(d)) return reply(400, { msg: '请求体须为 JSON 对象' });
        const { schema_id: schemaId = DEFAULT_SCHEMA, filters = {}, only_verified: onlyVerified = false } = d;
        if (typeof schemaId !== 'string' || !schemaId || !filters || typeof filters !== 'object' || Array.isArray(filters) || typeof onlyVerified !== 'boolean') {
          return reply(400, { msg: 'schema_id、filters 或 only_verified 格式无效' });
        }
        const items = kbStruct.queryEvidence({ schemaId, filters, onlyVerified }).map((item) => evidencePaper(item, mirror));
        return reply(200, { items }, items.length);
      }
      if (url.pathname === '/v1/contradictions') {
        if (!paradigm) return reply(503, { msg: '矛盾分析模块不可用' });
        const schemaId = qs('schema') || DEFAULT_SCHEMA;
        const contradictions = paradigm.listContradictions(schemaId);
        const matrix = paradigm.buildMatrix(schemaId, { rowField: qs('row') || undefined, colField: qs('col') || undefined });
        return reply(200, { contradictions, matrix }, contradictions.length);
      }
      const key = qs('key');
      if (!KEY.test(key)) return reply(400, { msg: 'Zotero 条目键无效' });
      const item = mirror.item(key);
      if (!item) return reply(404, { msg: '找不到这篇' });
      const requested = (qs('pages') || '1').split(',').map((s) => s.trim());
      if (requested.some((s) => !/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s)))) return reply(400, { msg: '页码须为正整数' });
      const doc = await fulltext.forItem(key);
      if (doc?.missing || !doc?.pages?.length) return reply(404, { msg: '没有可读的页文本', reason: doc?.missing || 'no-text' });
      const pages = [...new Set(requested.map(Number))].slice(0, 8).flatMap((page) => {
        const index = doc.labels ? doc.labels.indexOf(page) : page - 1;
        const text = doc.pages[index];
        return typeof text === 'string' ? [{ page, text: text.slice(0, 8000) }] : [];
      });
      return reply(200, { key, title: item.title, total_pages: doc.visionN || doc.pages.length, pages }, pages.length);
    } catch (e) { return reply(500, { msg: e.message }); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'), p = url.pathname;
      if (req.method === 'GET' && p === '/v1/limits') return json(res, 200, downloads.limits());
      if (req.method === 'GET' && p === '/v1/downloads') {
        const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
        return json(res, 200, { items: downloads.list({ ids: ids.length ? ids : null }), limits: downloads.limits() });
      }
      if (req.method === 'POST' && p === '/v1/downloads') {
        const raw = await readBody(req);
        let d = null; try { d = JSON.parse(raw); } catch {}
        if (!d || !Array.isArray(d.dois)) return json(res, 400, { ok: false, msg: '要 { "dois": ["10.xxxx/..."] }' });
        const by = String(d.by || 'agent').replace(/[^\w.@\-+ ]/g, '').slice(0, 80) || 'agent';
        const r = downloads.submit(d.dois.map(String), { by: 'mcp:' + by });
        audit('lit-agent-download', 'socket', by, String(r.results ? r.results.filter((x) => x.ok && !x.duplicate).length : 0));
        return json(res, 200, r);
      }
      if (req.method === 'GET' && p === '/v1/pdf') {
        const f = downloads.pdf(String(url.searchParams.get('id') || ''));
        if (!f.buf) return json(res, 404, { ok: false, msg: f.msg });
        audit('lit-agent-pdf', 'socket', f.job.id);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': f.buf.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'X-Job': encodeURIComponent(JSON.stringify(f.job)) });
        return res.end(f.buf);
      }
      if (kb && KB_ROUTES.has(`${req.method} ${p}`)) return await handleKb(req, res, url);
      json(res, 404, { ok: false, msg: 'not found' });
    } catch (e) { json(res, 500, { ok: false, msg: e.message }); }
  });

  function start() {
    if (process.platform !== 'win32') { try { fs.unlinkSync(socket); } catch {} }          // (left over from the last run)
    server.on('error', (e) => log('文献：下载接口的本地 socket 开不了：' + e.message));
    server.listen(socket, () => {
      if (process.platform !== 'win32') { try { fs.chmodSync(socket, 0o600); } catch {} }
      log('文献：下载接口（MCP 用）在 ' + socket);
    });
  }
  const stop = () => { try { server.close(); } catch {} if (process.platform !== 'win32') { try { fs.unlinkSync(socket); } catch {} } };
  return { start, stop, socket };
}

module.exports = { createAgentSocket, defaultSocket, evidencePaper, DEFAULT_SCHEMA, KEY };
