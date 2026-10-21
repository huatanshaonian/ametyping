// Editing Word / Excel / PowerPoint files in the browser with OnlyOffice Docs (a container on the NAS; config "office":
//   { url: 'http://127.0.0.1:8790', jwtEnv: '<the container's env file with JWT_SECRET>',
//     hook: { host: '172.17.0.1', port: 8791 }, hookUrl: 'http://host.docker.internal:8791' }).
// A file open in a viewer is handed over by the page (it has it already), kept here (sessions.js) and opened in the
// editor with a config this server signs. The editor's pages come through /office (proxy.js, behind the login); the
// container fetches the file and reports each save on its own listener (hook.js); the page that opened it is told and
// writes the new version back to the computer through the ordinary upload (with its code check).
//   GET  /api/office                         -> { on, up }   (up: the container answers)
//   POST /api/office/open?machine&path&name  the file as the body -> { ok, id, config, api }
//   GET  /api/office/file?id&v               a saved version
// The browser is told { t:'office', id, v, final } on each new version, { t:'office', id, msg } when saving failed and
// { t:'office', id, closed:true } when the editor closed with nothing new.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { sign, readSecret } = require('./jwt');
const { createSessions } = require('./sessions');
const { createProxy } = require('./proxy');
const { createHook } = require('./hook');

const MAX = 100 * 1024 * 1024;
const MAX_OPEN = 40;                      // files being edited (kept on disk) at a time
// what the editor opens and saves in the same format (the old .doc / .xls / .ppt would come back as something else)
const KINDS = { docx: 'word', xlsx: 'cell', pptx: 'slide' };

function receive(req, f) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(f, { mode: 0o600 }), hash = crypto.createHash('sha256');
    let n = 0, bad = false;
    const fail = () => { if (bad) return; bad = true; req.destroy(); out.destroy(); resolve(null); };
    req.on('data', (c) => { n += c.length; if (n > MAX) fail(); else hash.update(c); });
    req.on('aborted', fail); req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!bad) resolve({ size: n, sha: hash.digest('hex') }); });
    req.pipe(out);
  });
}

function createOffice({ conf, dataDir, origin, user, audit, broadcast, log = console.log }) {
  if (!conf || !conf.url || !conf.hookUrl) return null;
  const secret = readSecret(conf.jwtEnv || '');
  if (!secret) { log('office: 读不到文档服务的 JWT_SECRET，在线编辑关闭'); return null; }
  const sessions = createSessions(path.join(dataDir, 'office'));
  const proxy = createProxy({ target: conf.url, origin });
  const hookUrl = conf.hookUrl.replace(/\/+$/, '');
  const hook = createHook({ sessions, secret, target: conf.url, host: (conf.hook && conf.hook.host) || '172.17.0.1', port: (conf.hook && conf.hook.port) || 8791, log,
    onSaved: (m, final, msg) => {
      if (!msg) audit('office-saved', m.machine, m.path.slice(0, 300), 'v' + m.v);
      broadcast({ t: 'office', id: m.id, v: m.v, final: !!final, ...(msg ? { msg } : {}) });
    },
    onClosed: (m) => broadcast({ t: 'office', id: m.id, closed: true }) });

  // is the container there (asked at most every 20 s)
  let up = { at: 0, ok: false, wait: null };
  function health() {
    if (Date.now() - up.at < 20e3) return Promise.resolve(up.ok);
    if (up.wait) return up.wait;
    up.wait = new Promise((resolve) => {
      const done = (ok) => { up = { at: Date.now(), ok, wait: null }; resolve(ok); };
      const req = http.get(new URL('/healthcheck', conf.url), { timeout: 4000 }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => done(r.statusCode === 200 && b.trim() === 'true')); });
      req.on('timeout', () => req.destroy()); req.on('error', () => done(false));
    });
    return up.wait;
  }

  function editorConfig(m) {
    const c = {
      document: { fileType: m.ext, key: m.id, title: m.name, url: `${hookUrl}/doc/${m.id}/${m.tok}`,
        permissions: { edit: true, download: true, print: true, comment: true, review: true, copy: true } },
      documentType: KINDS[m.ext],
      editorConfig: {
        callbackUrl: `${hookUrl}/cb/${m.id}/${m.tok}`, mode: 'edit', lang: 'zh-CN', region: 'zh-CN',
        user: { id: 'ame', name: user || '我' },
        coEditing: { mode: 'fast', change: false },
        // the Save button saves to the computer (forcesave); a document's macros and plugins never run: the editor
        // lives in this site's own pages
        // (spelling off at first: its dictionary is English, and marks every Chinese word)
        customization: { forcesave: true, autosave: true, macros: false, plugins: false, help: false, feedback: false, uiTheme: 'theme-classic-light',
          features: { spellcheck: { mode: false } } },
      },
    };
    c.token = sign(c, secret);
    return c;
  }

  async function handle(req, res, url, ip, json, send) {
    const p = url.pathname, q = url.searchParams;
    if (req.method === 'GET' && p === '/api/office') return json(res, 200, { on: true, up: await health() }), true;
    if (req.method === 'POST' && p === '/api/office/open') {
      const machine = String(q.get('machine') || ''), fp = String(q.get('path') || ''), name = path.basename(String(q.get('name') || '').replace(/\\/g, '/'));
      const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
      const kind = ext && KINDS[ext.toLowerCase()];
      if (!machine || machine.length > 100 || !fp || fp.length > 4096 || !name || name.length > 255 || !kind) return json(res, 400, { ok: false, msg: '这种文件不能在线编辑' }), true;
      if (+req.headers['content-length'] > MAX) return json(res, 413, { ok: false, msg: '文件过大（超过 100 MB）' }), true;
      if (sessions.count() >= MAX_OPEN) { sessions.sweep(); if (sessions.count() >= MAX_OPEN) return json(res, 429, { ok: false, msg: '正在编辑的文件太多，先关掉几个' }), true; }
      if (!await health()) return json(res, 503, { ok: false, msg: '文档服务没有运行' }), true;
      const m = sessions.create({ machine, path: fp, name, ext: ext.toLowerCase() });
      const got = await receive(req, sessions.file(m));
      if (!got || !got.size) { sessions.remove(m.id); return json(res, 400, { ok: false, msg: got ? '文件是空的' : '文件没传完整' }), true; }
      Object.assign(m, { size: got.size, sha: got.sha }); sessions.put(m);
      audit('office-open', ip, machine, fp.slice(0, 300));
      return json(res, 200, { ok: true, id: m.id, config: editorConfig(m), api: proxy.PREFIX + '/web-apps/apps/api/documents/api.js' }), true;
    }
    if (req.method === 'GET' && p === '/api/office/file') {
      const m = sessions.get(q.get('id')), v = +q.get('v');
      if (!m || !Number.isInteger(v) || v < 1 || v > m.v) return send(res, 404, 'not found'), true;
      fs.readFile(sessions.file(m, v), (e, buf) => e ? send(res, 404, 'not found')
        : send(res, 200, buf, 'application/octet-stream', { 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(m.name)}` }));
      return true;
    }
    return false;
  }

  return { handle, web: proxy.web, upgrade: proxy.upgrade, PREFIX: proxy.PREFIX, close: () => hook.close() };
}

module.exports = { createOffice, KINDS };
