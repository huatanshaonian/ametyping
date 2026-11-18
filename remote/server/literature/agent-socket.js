// 下载 for agents: a small HTTP server on a local socket (a Unix socket owned by the server's user, 0600, in the
// module's own 0700 folder; a named pipe on Windows) -- never on a network address. Who can open the socket can use
// it: on the NAS that is the account the server runs as, reached by agents through SSH (mcp.js). Only the downloads are
// served here, nothing else of the dashboard:
//   GET  /v1/limits                     what the queue allows (see downloads.limits)
//   POST /v1/downloads  { dois, by }    submit up to 20 DOIs -> { ok, results, limits }
//   GET  /v1/downloads?ids=a,b          those jobs (none given: the latest 30) -> { items, limits }
//   GET  /v1/pdf?id=                    a finished job's PDF (application/pdf; X-Job: the job as JSON)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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

function createAgentSocket({ socket, downloads, log = () => {}, audit = () => {} }) {
  const json = (res, code, o) => { const b = JSON.stringify(o); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
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

module.exports = { createAgentSocket, defaultSocket };
