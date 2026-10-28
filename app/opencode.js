// What OpenCode needs on the machine: the bridge the plugin leaves behind (how to reply into a session), the
// executable and arguments to start or continue one, and the mirror file with its conversation. There is no
// terminal to type into and no screen to read: the plugin answers through OpenCode's own session API, and the
// conversation it mirrors is what the panel and the dashboard show.
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = process.env.OPENCODE_AME_HOME || path.join(os.homedir(), '.ametyping', 'opencode');
const SESSIONS = path.join(ROOT, 'sessions');
const PREFIX = 'opencode:';
const rawId = (id) => String(id || '').replace(/^opencode:/, '');
const nsId = (id) => (id ? PREFIX + rawId(id) : id);
const isId = (id) => /^(opencode:)?ses_[A-Za-z0-9]{6,80}$/.test(String(id || ''));

// the plugin writes <session>.json next to <session>.jsonl: where its control endpoint is, and which process hosts it
function metaOf(id) {
  const raw = rawId(id);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let o;
  try { o = JSON.parse(fs.readFileSync(path.join(SESSIONS, `${raw}.json`), 'utf8')); } catch { return null; }
  if (!o || o.v !== 1 || o.id !== raw || !Number.isInteger(o.port) || o.port <= 0 || typeof o.token !== 'string' || !/^[a-f0-9]{64}$/.test(o.token)) return null;
  if (!Number.isInteger(o.pid) || !alive(o.pid)) return null;
  return o;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function transcriptOf(id) {
  const raw = rawId(id);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const file = path.join(SESSIONS, `${raw}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

// one call to the plugin's loopback endpoint (token from its session file; no Origin, like Ame's own control API)
function call(meta, url, body, timeout = 15000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port: meta.port, method: 'POST', path: url, timeout,
        headers: { 'X-Ame-Bridge': meta.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
        res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
      });
    } catch { return resolve(null); }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data);
  });
}
async function prompt(id, text) {
  const m = metaOf(id);
  if (!m) return { ok: false, msg: 'OpenCode 没在运行（插件没有登记这个会话），只能等它重新打开后从终端回复' };
  const r = await call(m, '/prompt', { sessionID: m.id, text });
  return r && r.ok ? { ok: true } : { ok: false, msg: (r && r.msg) || '发送失败：OpenCode 没回应' };
}
async function interrupt(id) {
  const m = metaOf(id);
  if (!m) return { ok: false, msg: 'OpenCode 没在运行' };
  const r = await call(m, '/interrupt', { sessionID: m.id }, 8000);
  return r && r.ok ? { ok: true } : { ok: false, msg: (r && r.msg) || '中断失败' };
}
async function screen(id) {
  const m = metaOf(id);
  if (!m) return { ok: false, msg: 'OpenCode 没在运行，没有画面' };
  const r = await call(m, '/screen', { sessionID: m.id }, 8000);
  return r && r.ok ? { ok: true, screen: String(r.screen || '') } : { ok: false, msg: (r && r.msg) || '读不到画面' };
}
async function title(id, name) {
  const m = metaOf(id);
  if (!m) return { ok: false, msg: 'OpenCode 没在运行' };
  const r = await call(m, '/title', { sessionID: m.id, title: name }, 8000);
  return r && r.ok ? { ok: true } : { ok: false, msg: (r && r.msg) || '改名失败' };
}

// how to start it here: a native opencode.exe on PATH, or the npm shim's real executable (opencode.cmd is a thin
// wrapper; going through cmd.exe would re-parse a reply containing & or | as another command, so the target .exe is
// used directly). On Linux/macOS the opencode program itself.
function exeFromShim(file) {
  const dir = path.dirname(file);
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const m of s.matchAll(/"([^"]+\.exe)"/gi)) {
    let p = m[1].trim().replace(/^%~dp0%?\\?/i, '').replace(/^%dp0%\\?/i, '');
    if (!p || /%/.test(p)) continue;                 // another variable: not a path we can resolve
    if (!path.isAbsolute(p)) p = path.join(dir, p);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function command(env) {
  const dirs = ((env && env.PATH) || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    for (const d of dirs) { const f = path.join(d, 'opencode.exe'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
    for (const d of dirs) { const f = path.join(d, 'opencode.cmd'); if (fs.existsSync(f)) { const exe = exeFromShim(f); if (exe) return { exe, args: [] }; } }
    const npm = ((env && env.APPDATA) || process.env.APPDATA) && path.join((env && env.APPDATA) || process.env.APPDATA, 'npm');
    if (npm) {
      const f = path.join(npm, 'opencode.exe'); if (fs.existsSync(f)) return { exe: f, args: [] };
      const c = path.join(npm, 'opencode.cmd'); const exe = fs.existsSync(c) && exeFromShim(c); if (exe) return { exe, args: [] };
    }
    return null;
  }
  for (const d of dirs) { const f = path.join(d, 'opencode'); if (fs.existsSync(f)) return { exe: f, args: [] }; }
  for (const f of [path.join(os.homedir(), '.local', 'bin', 'opencode'), path.join(os.homedir(), '.bun', 'bin', 'opencode')]) if (fs.existsSync(f)) return { exe: f, args: [] };
  return null;
}

// a new session (with an optional first message) or an existing one, opened in its folder with the normal TUI
function launchSpec({ resume = '', prompt = '' } = {}) {
  const c = command();
  if (!c) return null;
  const raw = rawId(resume);
  if (resume) return { ...c, args: [...c.args, '-s', raw] };
  const first = String(prompt || '').trim();
  return { ...c, args: [...c.args, ...(first ? ['--prompt', first] : [])] };
}

// a session whose process is gone: continue it without a terminal (`opencode run --auto --session <id>`); the server
// loads our plugin again, so its events and mirror keep coming. --auto matters here: a non-interactive run cannot ask
// for permission and would reject every request it has to make.
function resume(id, cwd, text, env) {
  const c = command(env);
  const raw = rawId(id);
  if (!c || !isId(raw)) return null;
  const p = spawn(c.exe, [...c.args, 'run', '--auto', '-s', raw, '--format', 'json', String(text)], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), env: env || process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  p.on('error', () => {});
  return p;
}

module.exports = { ROOT, SESSIONS, PREFIX, rawId, nsId, isId, metaOf, alive, transcriptOf, prompt, interrupt, screen, title, command, launchSpec, resume };
