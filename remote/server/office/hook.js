// What the OnlyOffice container asks of this server, on a listener of its own that only the container can reach (the
// docker bridge's address on the NAS; config office.hook): the file to open, and its callback when the editor saves.
//   GET  /doc/<id>/<tok>   the file as it was opened
//   POST /cb/<id>/<tok>    {status, url, users, ...} signed with the shared secret:
//        1 being edited   2 ready to save (everyone closed it)   6 saved with the Save button (forcesave)
//        3 / 7 saving failed                                    4 closed without changes
// A saved version is fetched from the container at once (its link is the container's, under /office as the browser
// saw it), kept as v<n> and announced (onSaved) -- unless it is the same as the last one. The page that opened the
// editor writes it back to the computer (public/js/apps/office.js), through the upload every write goes through.
'use strict';
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { verify } = require('./jwt');
const { PREFIX } = require('./proxy');

const MAX_FILE = 200 * 1024 * 1024;

function createHook({ sessions, secret, target, host, port, onSaved, onClosed, log = console.log }) {
  const t = new URL(target);
  const sameTok = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  // a version from the container, to file f; -> its sha256
  function fetchVersion(link, f) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(link); } catch { return reject(new Error('bad url')); }
      const p = u.pathname.startsWith(PREFIX + '/') ? u.pathname.slice(PREFIX.length) : u.pathname;
      const tmp = f + '.part', out = fs.createWriteStream(tmp), hash = crypto.createHash('sha256');
      let n = 0;
      const fail = (e) => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(e); };
      const req = http.get({ host: t.hostname, port: t.port || 80, path: p + u.search, timeout: 60e3 }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return fail(new Error('HTTP ' + r.statusCode)); }
        r.on('data', (c) => { n += c.length; if (n > MAX_FILE) { req.destroy(); return fail(new Error('too large')); } hash.update(c); });
        r.on('error', fail);
        r.pipe(out);
        out.on('finish', () => { if (n <= MAX_FILE) fs.rename(tmp, f, (e) => e ? fail(e) : resolve(hash.digest('hex'))); });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', fail);
    });
  }

  async function callback(m, d) {
    m.last = Date.now();
    if (d.status === 1) { sessions.put(m); return; }
    if (d.status === 2 || d.status === 6) {
      const v = m.v + 1, f = sessions.file(m, v);
      const sha = await fetchVersion(d.url, f);
      const fresh = sha !== m.sha;
      if (fresh) { m.v = v; m.sha = sha; m.size = fs.statSync(f).size; } else fs.rmSync(f, { force: true });
      if (d.status === 2) m.done = Date.now();
      sessions.put(m);
      if (fresh) onSaved(m, d.status === 2);
      else if (d.status === 2) onClosed(m);
      return;
    }
    if (d.status === 3 || d.status === 4) m.done = Date.now();
    sessions.put(m);
    if (d.status === 3 || d.status === 7) onSaved(m, d.status === 3, '文档服务保存失败');
    else if (d.status === 4) onClosed(m);
  }

  const server = http.createServer((req, res) => {
    const mm = /^\/(doc|cb)\/([a-f0-9]{24})\/([A-Za-z0-9_-]{20,40})$/.exec(req.url.split('?')[0]);
    const m = mm && sessions.get(mm[2]);
    if (!m || !sameTok(mm[3], m.tok)) { res.writeHead(404); return res.end(); }
    if (mm[1] === 'doc' && req.method === 'GET') {
      const s = fs.createReadStream(sessions.file(m));
      s.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
      s.on('open', () => res.writeHead(200, { 'Content-Type': 'application/octet-stream' }));
      return s.pipe(res);
    }
    if (mm[1] !== 'cb' || req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body; try { body = JSON.parse(b); } catch { return reply(res, 400, { error: 1 }); }
      // signed: in the body (token) or in the header, as {payload}
      const h = String(req.headers.authorizationjwt || req.headers.authorization || '');
      const fromHead = h.startsWith('Bearer ') ? verify(h.slice(7), secret) : null;
      const d = (body.token && verify(body.token, secret)) || (fromHead && (fromHead.payload || fromHead));
      if (!d || typeof d.status !== 'number') { log('office: 回调签名不对，已忽略'); return reply(res, 403, { error: 1 }); }
      try { await callback(m, d); reply(res, 200, { error: 0 }); }
      catch (e) { log('office: 取回保存的版本失败 ' + (e.message || e)); reply(res, 200, { error: 1 }); }
    });
  });
  // the bridge may come up after this server (booting): try again until it is there
  let retry = null;
  const listen = () => server.listen(port, host);
  server.on('error', (e) => { if (e.code === 'EADDRNOTAVAIL' || e.code === 'EADDRINUSE') { clearTimeout(retry); retry = setTimeout(listen, 30e3); retry.unref(); } else log('office hook: ' + e.message); });
  server.on('listening', () => log(`office: 文档服务回调入口 http://${host}:${port}`));
  listen();
  return { close: () => { clearTimeout(retry); server.close(); } };
}

module.exports = { createHook };
