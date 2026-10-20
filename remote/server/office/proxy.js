// /office/... on this site -> the OnlyOffice container (127.0.0.1 on the NAS only), pages and the editor's WebSocket,
// for a logged-in browser only (server.js checks that before calling here). The editor's pages go through untouched --
// none of the dashboard's own headers (its CSP would stop the editor) -- and the container is told its address as
// the browser sees it (X-Forwarded-Host <host>/office: OnlyOffice's way of living under a path).
// The login cookie and any Authorization are not passed on. What only this server should ask the container for
// (converting, the command service, its example app and internal pages) is not served at all.
'use strict';
const http = require('http');

const PREFIX = '/office';
const DROP = new Set(['cookie', 'authorization', 'host', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix', 'x-real-ip', 'proxy-connection', 'keep-alive', 'te']);
// (after the version folder some paths start with, e.g. /9.4.0-1a2b3c/)
const BLOCK = /^\/(example|internal|info|metrics|command|converter|ConvertService\.ashx|coauthoring\/CommandService\.ashx|healthcheck)(\/|$)/i;

// target: 'http://127.0.0.1:8790'; origin: the site's address as browsers use it (config "origin"), else the request's
function createProxy({ target, origin }) {
  const t = new URL(target);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const pub = (req) => {
    if (origin) { const o = new URL(origin); return { host: o.host, proto: o.protocol.replace(':', '') }; }
    return { host: String(req.headers.host || 'localhost'), proto: 'http' };
  };
  const inner = (url) => url.pathname.slice(PREFIX.length) || '/';
  const blocked = (p) => BLOCK.test(p.replace(/^\/\d[\w.]*-[\w]+(?=\/)/, ''));
  function headers(req, upgrade) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && (upgrade || (k !== 'connection' && k !== 'upgrade'))) h[k] = v;
    const p = pub(req);
    return { ...h, host: t.host, 'x-forwarded-host': p.host + PREFIX, 'x-forwarded-proto': p.proto };
  }

  function web(req, res, url) {
    const p = inner(url);
    if (blocked(p)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const up = http.request({ host: t.hostname, port: t.port || 80, method: req.method, path: p + url.search, headers: headers(req, false), agent }, (r) => {
      const out = { ...r.headers };
      delete out['x-powered-by'];
      out['x-robots-tag'] = 'noindex, nofollow';
      // its pages may only be shown inside this site (the editor's frame on the desktop)
      out['content-security-policy'] = [].concat(out['content-security-policy'] || [], "frame-ancestors 'self'");
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('文档服务没有响应'); });
    req.pipe(up);
  }

  // alive(): the login behind it still holds (checked every minute; the socket is cut when it does not)
  function upgrade(req, socket, head, url, alive) {
    const p = inner(url);
    if (blocked(p)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
    const up = http.request({ host: t.hostname, port: t.port || 80, method: 'GET', path: p + url.search, headers: headers(req, true) });
    up.on('upgrade', (r, psock, phead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(r.rawHeaders[i] + ': ' + r.rawHeaders[i + 1]);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psock.write(head);
      psock.pipe(socket); socket.pipe(psock);
      const check = setInterval(() => { if (!alive()) kill(); }, 60e3);
      function kill() { clearInterval(check); psock.destroy(); socket.destroy(); }
      for (const s of [psock, socket]) { s.on('error', kill); s.on('close', kill); }
    });
    up.on('response', (r) => { r.resume(); socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage || ''}\r\n\r\n`); });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.end();
  }

  return { web, upgrade, PREFIX };
}

module.exports = { createProxy, PREFIX };
