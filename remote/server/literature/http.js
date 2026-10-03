// HTTP(S) for the literature module: the paper sources (OpenAlex, Crossref, arXiv, AIAA, NTRS, Unpaywall), open-access
// PDFs, and Zotero's local API on 127.0.0.1. Hosts listed in `viaProxy` (NTRS refuses mainland addresses) go through
// whichever HTTP proxy gets there (server/egress.js: a CONNECT tunnel, TLS on top); everything else directly.
// Redirects are followed (up to 5), bodies are capped, and every request has a timeout.
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 30e3;
const MAX_BYTES = 60 * 1024 * 1024;

function tunnel(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const s = net.connect(Number(u.port || 80), u.hostname);
    const fail = (e) => { s.destroy(); reject(e); };
    s.setTimeout(TIMEOUT_MS, () => fail(new Error('代理连接超时')));
    s.once('error', fail);
    s.once('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      s.removeListener('data', onData); s.setTimeout(0); s.removeListener('error', fail);
      if (!/^HTTP\/1\.[01] 200/.test(head)) return fail(new Error('代理拒绝了连接：' + head.split('\r\n')[0]));
      resolve(tls.connect({ socket: s, servername: host }));
    };
    s.on('data', onData);
  });
}

// createHttp({ egress, viaProxy: ['ntrs.nasa.gov'], userAgent }) -> { request, get, json }
//   request(url, { method, headers, body, maxBytes, timeoutMs, redirects }) -> { status, headers, body (Buffer), url }
function createHttp({ egress = null, viaProxy = [], userAgent = 'Windose-literature/1.0' } = {}) {
  const proxied = (host) => viaProxy.some((h) => host === h || host.endsWith('.' + h));

  async function once(url, opts) {
    const u = new URL(url);
    const secure = u.protocol === 'https:';
    let createConnection;
    if (secure && egress && proxied(u.hostname)) {
      const proxy = await egress.pick(u.hostname);
      if (!proxy) throw new Error(`连不上 ${u.hostname}：配置的代理都不通`);
      const sock = await tunnel(proxy, u.hostname, u.port || 443).catch((e) => { egress.forget(); throw e; });
      createConnection = () => sock;
    }
    const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
    const lib = secure ? https : http;
    const port = Number(u.port || (secure ? 443 : 80));
    const max = opts.maxBytes || MAX_BYTES;
    return new Promise((resolve, reject) => {
      // (defaultPort only for a tunnel: it drops the port from the Host header, which Zotero's local server refuses)
      const req = lib.request({ hostname: u.hostname, port, defaultPort: createConnection ? port : undefined, path: u.pathname + u.search, method: opts.method || 'GET', createConnection,
        headers: { 'User-Agent': userAgent, Accept: '*/*', ...(opts.headers || {}), ...(body ? { 'Content-Length': body.length } : {}) },
        timeout: opts.timeoutMs || TIMEOUT_MS }, (res) => {
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > max) { req.destroy(new Error('内容太大')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`${u.hostname} 没有回应`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function request(url, opts = {}) {
    let cur = url;
    for (let i = 0; i <= (opts.redirects == null ? 5 : opts.redirects); i++) {
      const r = await once(cur, opts);
      if (r.status >= 300 && r.status < 400 && r.headers.location && (opts.method || 'GET') === 'GET') { cur = new URL(r.headers.location, cur).toString(); continue; }
      return { ...r, url: cur };
    }
    throw new Error('重定向太多次');
  }
  const get = (url, opts = {}) => request(url, { ...opts, method: 'GET' });
  // GET and parse JSON; a non-2xx answer is an error carrying the status
  async function json(url, opts = {}) {
    const r = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (r.status < 200 || r.status >= 300) { const e = new Error(`${new URL(url).hostname} 返回 ${r.status}`); e.status = r.status; throw e; }
    try { return JSON.parse(r.body.toString('utf8')); } catch { throw new Error(`${new URL(url).hostname} 返回的不是 JSON`); }
  }
  return { request, get, json };
}

module.exports = { createHttp };
