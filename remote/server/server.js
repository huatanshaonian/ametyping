#!/usr/bin/env node
// Ame remote dashboard -- server. Shows Claude Code sessions and their conversations from every machine,
// and lets the logged-in user reply to a session or answer a permission card on it:
//   agent (per machine, connects out; token auth)  <--->  server  <--->  browser (login + TOTP)
// Down the agent socket go exactly four actions, `send` (type a reply), `key` (one navigation key for the
// terminal's own menus), `decide` (allow / deny a permission) and `launch` (start Claude Code in a folder).
// Both need: control enabled here (config "control", default on), enabled on that machine (its agent.json
// "control": true -- off by default), and the pet running there, which does the actual work just like its
// own panel. Every action is written to the audit log (never the text itself).
// Before the login nothing gives away what this is: a plain login box, no art, no names, noindex.
// Agents connect on their own listener (config "agent": {host, port}), meant for a VPN address only.
// The session list lives in memory only. Conversations arrive as slim records and are written to disk by
// store.js (config "dataDir", default data/ next to config.json); memory holds only the ones being looked at.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { createStore } = require('./store');
const { createWalls } = require('./walls');
const { createFsRelay } = require('./fs-relay');
const { createAgentsAdmin } = require('./agents-admin');
const { createSummary } = require('./summary');
const { createArtifacts } = require('./artifacts');
const { createTodos } = require('./todos');
const { createNotes } = require('./notes');

const CONFIG = process.env.AME_REMOTE_CONFIG || path.join(__dirname, 'config.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { console.error(`读不到 ${CONFIG}，先运行 node setup.js init`); process.exit(1); }
const CONTROL = cfg.control !== false;
const reloadAgents = () => { try { cfg.agents = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).agents || []; } catch {} };

const PUBLIC = path.join(__dirname, '..', 'public');
const ASSETS = path.resolve(__dirname, cfg.assetsDir || path.join('..', '..', 'app', 'assets'));
// the only art the page may load (the pet's assets folder also holds things the web has no use for)
const ASSET_OK = /^(dialog\/(windowbase_active\.png|PixelMplus12-Regular\.ttf)|rig\/(head|torso|face_[a-z]+)\.png|icon256\.png)$/;

// ---------- audit log (logins and agent connects; never conversation text) ----------
const AUDIT = path.join(path.dirname(CONFIG), 'audit.log');
function audit(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  try { fs.appendFileSync(AUDIT, line); } catch {}
  if (process.env.AME_VERBOSE) process.stdout.write(line);
}

// ---------- http helpers ----------
const SEC_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
if (cfg.secureCookies) SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
// with https the cookie gets the __Host- prefix: the browser then only accepts it Secure, Path=/, no Domain
const SID = cfg.secureCookies ? '__Host-sid' : 'sid';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
// the desktop's own files (after login): one level under these folders, plain names only
const STATIC = /^\/(css|js|js\/apps|icons|img|wall|vendor|sounds)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|css|png|webp|jpg|svg|wav)$/;

// Behind the proxy, the client IP is the LAST X-Forwarded-For entry -- the one the proxy itself appended.
// Anything to its left came from the client and could be forged to dodge the per-IP lockout.
function clientIp(req) {
  if (cfg.trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (f) return f; }
  return req.socket.remoteAddress || '?';
}
// requests that change state must come from this site's own pages (on top of SameSite=Strict)
function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  if (origin === cfg.origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function cookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
function setCookie(res, name, val, maxAge) {
  const c = `${name}=${val}; Path=/; HttpOnly; SameSite=Strict${cfg.secureCookies ? '; Secure' : ''}; Max-Age=${maxAge}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
function send(res, code, body, type = 'text/plain; charset=utf-8', extra) {
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req, cap = 4096) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > cap) req.destroy(); });
    req.on('end', () => resolve(b)); req.on('error', () => resolve(''));
  });
}

// ---------- the live picture (in memory only) ----------
// machines: agentName -> { name, online, since, control, sessions: Map(id -> session), sockets:Set }
// a session: { id, machine, label, project, state, steps, t0, last, lines[], msgs[], via, perms[] }
const machines = new Map();
function machine(name) {
  let m = machines.get(name);
  if (!m) { m = { name, online: false, since: 0, sessions: new Map() }; machines.set(name, m); }
  return m;
}
// how to continue a session on its machine (Windows paths get PowerShell syntax)
// (Codex sessions, "codex:<id>", continue with `codex resume`)
function resumeCmd(cwd, id) {
  const cmd = id.startsWith('codex:') ? `codex resume ${id.slice(6)}` : `claude --resume ${id}`;
  if (!cwd) return cmd;
  const q = `'${cwd.replace(/'/g, "''")}'`;
  return /^[A-Za-z]:[\\/]/.test(cwd) ? `cd ${q}; ${cmd}` : `cd '${cwd.replace(/'/g, `'\\''`)}' && ${cmd}`;
}
// what the browser gets: no pids -- what to display, plus the working directory in the resume command.
// Every session ever stored is listed (newest activity first); the ones the agent no longer reports are 'history'.
function snapshot() {
  const stored = store.sessions();
  const names = new Set([...machines.keys(), ...Object.keys(stored)]);
  const out = [];
  for (const name of names) {
    const m = machines.get(name) || { name, online: false, since: 0, sessions: new Map() };
    const ctl = CONTROL && m.online && !!m.control;
    const saved = new Map((stored[name] || []).map((e) => [e.id, e]));
    const list = [...m.sessions.values()].map((s) => {
      const e = saved.get(s.id);
      return { id: s.id, label: s.label, project: s.project, state: s.state, steps: s.steps, t0: s.t0, last: Math.max(s.last, e ? e.last : 0),
        lines: s.lines.slice(-8), via: ctl ? s.via : 'off', perms: ctl ? s.perms : [], resume: resumeCmd(e && e.cwd, s.id), mode: e ? e.mode : '' };
    });
    for (const e of saved.values()) {
      if (m.sessions.has(e.id)) continue;
      list.push({ id: e.id, label: e.title || e.project || (e.id.startsWith('codex:') ? 'Codex' : 'Claude'), project: e.project, state: 'history', steps: 0, t0: e.first, last: e.last,
        lines: [], via: 'off', perms: [], resume: resumeCmd(e.cwd, e.id), mode: e.mode });
    }
    out.push({ machine: name, online: m.online, since: m.since, control: ctl, files: m.online && !!m.files, sessions: list.sort((a, b) => b.last - a.last) });
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine));
}

// ---------- browser websocket clients ----------
const clients = new Set();       // { ws, sub:(machine|null,id|null) }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) { try { c.ws.send(s); } catch {} }
}
// the session list, at most every 2 s (for changes that arrive in bursts)
let listTimer = null;
function broadcastSoon() {
  if (listTimer) return;
  listTimer = setTimeout(() => { listTimer = null; broadcast({ t: 'sessions', data: snapshot() }); }, 2000);
}
const store = createStore(path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data'));
const fsRelay = createFsRelay({ machines, audit: (...a) => audit(...a) });
const agentsAdmin = createAgentsAdmin({ configFile: CONFIG, machines, audit: (...a) => audit(...a) });
const walls = createWalls(path.resolve(path.dirname(CONFIG), cfg.wallDir || path.join(cfg.dataDir || 'data', 'wall')));
const artifacts = createArtifacts({ dir: path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data', 'artifacts'), machines, log: console.log });
// 重要计划: every open browser refreshes its list / desktop widget on a change
const todos = createTodos({ dataDir: path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data'), onChange: () => broadcast({ t: 'todos' }), audit: (...a) => audit(...a) });
// 记事本 (open notepads refresh their list on a change)
const notes = createNotes({ dataDir: path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data'), onChange: () => broadcast({ t: 'notes' }), audit: (...a) => audit(...a) });
// a new daily / weekly report: its short note goes to every connected machine (the pet shows it next morning)
const sendNote = (sock, n) => { try { sock.send(JSON.stringify({ t: 'report-note', ...n })); } catch {} };
const summary = createSummary({ store, dir: path.resolve(path.dirname(CONFIG), cfg.dataDir || 'data', 'reports'), cfg: cfg.summary || {},
  resumeCmd, artifacts, todos, notes, audit: (...a) => audit(...a),
  onNote: (n) => { for (const m of machines.values()) if (m.online && m.sockets) for (const s of m.sockets) sendNote(s, n); } });
function flushAndExit() { try { store.flush(); } catch {} process.exit(0); }
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

function pushConvTo(c) {
  if (!c.sub) return;
  const m = machines.get(c.sub.machine); const s = m && m.sessions.get(c.sub.id);
  // stored records (transcript sessions) or what the agent sent (sessions only the pet knows, e.g. Codex)
  const src = store.has(c.sub.machine, c.sub.id) ? store.tail(c.sub.machine, c.sub.id) : (s ? s.msgs : []);
  const msgs = (src || []).slice(-300).map((x) => ({ role: x.role, text: x.text, items: x.items, t: x.t }));
  try { c.ws.send(JSON.stringify({ t: 'conv', machine: c.sub.machine, id: c.sub.id, msgs })); } catch {}
}

// ---------- agent -> server messages (the ONLY thing the server accepts from a machine) ----------
// hello  {machine, control}             after token auth; marks the machine online
// state  {control, sessions:[{id,label,project,state,steps,t0,last,lines,via,perms}]}   full session list
// conv   {id, msgs:[{role,text,items,t}]}                            a session's conversation (tail)
// result {rid, ok, msg}                                              outcome of a send / decide
const VIA = ['terminal', 'resume', 'busy', 'none', 'unknown', 'codex', 'off'];
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
function onAgentMessage(m, raw, ws) {
  let d; try { d = JSON.parse(raw); } catch { return; }
  if (d.t === 'hello') {
    m.control = d.control === true; m.files = d.files === true; broadcast({ t: 'sessions', data: snapshot() });
    const n = summary && summary.latestNote(); if (n) sendNote(ws, n);          // the pet may have missed it while off
    return;
  }
  if (d.t === 'rec') {
    const r = store.accept(m.name, d);
    if (r.resync != null) { try { ws.send(JSON.stringify({ t: 'sync', offsets: { [d.id]: r.resync } })); } catch {} return; }
    if (r.changed) for (const c of clients) if (c.sub && c.sub.machine === m.name && c.sub.id === d.id) pushConvTo(c);
    // a session only the store knows (e.g. Codex without the pet): the list would not refresh on its own
    // (and a new permission mode is shown in the list's session details)
    if ((r.changed && !m.sessions.has(d.id)) || r.modeChanged) broadcastSoon();
    return;
  }
  if (d.t === 'meta' && typeof d.id === 'string') { store.meta(m.name, d.id, d); return; }
  if ((d.t === 'art-res' || d.t === 'art-chunk') && typeof d.rid === 'string') return artifacts.fromAgent(m, d);
  if ((d.t === 'fs-res' || d.t === 'fs-chunk' || d.t === 'fs-end') && typeof d.rid === 'string') return fsRelay.fromAgent(m, d);
  if (d.t === 'result' && typeof d.rid === 'string') return finishAction(d.rid, m.name, !!d.ok, str(d.msg, 200), d.mode);
  if (d.t === 'state' && Array.isArray(d.sessions)) {
    if (typeof d.control === 'boolean') m.control = d.control;
    if (typeof d.files === 'boolean') m.files = d.files;
    const keep = new Set();
    for (const s of d.sessions) {
      if (!s || typeof s.id !== 'string') continue;
      keep.add(s.id);
      let cur = m.sessions.get(s.id);
      if (!cur) { cur = { id: s.id, machine: m.name, msgs: [] }; m.sessions.set(s.id, cur); }
      cur.label = String(s.label || 'Claude').slice(0, 80);
      cur.project = String(s.project || '').slice(0, 60);
      cur.state = String(s.state || 'idle').slice(0, 16);
      cur.steps = +s.steps || 0;
      cur.t0 = +s.t0 || Date.now(); cur.last = +s.last || Date.now();
      cur.lines = Array.isArray(s.lines) ? s.lines.slice(-8).map((l) => ({ text: String(l.text || '').slice(0, 300), t: +l.t || 0, type: String(l.type || '').slice(0, 16) })) : [];
      cur.via = VIA.includes(s.via) ? s.via : 'off';
      cur.perms = Array.isArray(s.perms) ? s.perms.filter((p) => p && typeof p.id === 'string').slice(0, 10).map((p) => ({
        id: str(p.id, 64), provider: p.provider === 'codex' ? 'codex' : 'claude', tool: str(p.tool, 80),
        cwd: str(p.cwd, 300), subagent: str(p.subagent, 80), input: str(p.input, 8000) })) : [];
    }
    for (const id of [...m.sessions.keys()]) if (!keep.has(id)) m.sessions.delete(id);
    broadcast({ t: 'sessions', data: snapshot() });
  } else if (d.t === 'conv' && typeof d.id === 'string' && Array.isArray(d.msgs)) {
    const s = m.sessions.get(d.id);
    if (!s) return;
    s.msgs = d.msgs.slice(-300).map((x) => ({
      role: ['user', 'assistant', 'tool', 'sys'].includes(x.role) ? x.role : 'sys',
      text: typeof x.text === 'string' ? x.text.slice(0, 20000) : undefined,
      items: Array.isArray(x.items) ? x.items.slice(0, 40).map((i) => String(i).slice(0, 200)) : undefined,
      t: +x.t || 0,
    }));
    for (const c of clients) if (c.sub && c.sub.machine === m.name && c.sub.id === d.id) pushConvTo(c);
  }
}

// ---------- browser -> machine actions ----------
// A browser action gets a server-side rid; the agent's `result` is routed back to that browser only.
const pending = new Map();         // rid -> { c, crid, machine, timer }
const ACTION_MAX = 60, ACTION_WIN = 60e3;
// Claude Code permission modes (app/permission-mode.js): a Shift+Tab's result carries the one it switched to
const MODES = new Set(['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions']);
function finishAction(rid, machineName, ok, msg, mode) {
  const p = pending.get(rid);
  if (!p || p.machine !== machineName) return;
  pending.delete(rid); clearTimeout(p.timer);
  try { p.c.ws.send(JSON.stringify({ t: 'result', rid: p.crid, ok, msg, mode: MODES.has(mode) ? mode : undefined })); } catch {}
}
function onBrowserAction(c, d) {
  const reply = (ok, msg, need) => { try { c.ws.send(JSON.stringify({ t: 'result', rid: d.rid, ok, msg, need })); } catch {} };
  if (!CONTROL) return reply(false, '服务器关闭了远程控制');
  const now = Date.now();
  c.acts = (c.acts || []).filter((t) => now - t < ACTION_WIN);
  if (c.acts.length >= ACTION_MAX) return reply(false, '操作太频繁，稍后再试');
  c.acts.push(now);
  const m = typeof d.machine === 'string' && machines.get(d.machine);
  const s = m && typeof d.id === 'string' && m.sessions.get(d.id);
  if (!m || !m.online || !m.sockets || !m.sockets.size) return reply(false, '这台机器不在线');
  if (!m.control) return reply(false, '这台机器没开远程控制');
  if (!s && d.t !== 'launch') return reply(false, '这个会话已经不在了');
  if (d.t === 'launch' && !m.files) return reply(false, '这台电脑没开放文件浏览，没法选文件夹启动');
  const sess = auth.checkSession(c.sid);
  if (!auth.isFresh(sess)) { c.acts.pop(); return reply(false, '操作前请再输一次验证码', 'totp'); }
  let out;
  if (d.t === 'launch') {
    // a new Claude Code session in a folder of that machine (the agent checks it is a folder it lets you browse)
    const cwd = typeof d.cwd === 'string' ? d.cwd : '', prompt = typeof d.prompt === 'string' ? d.prompt : '';
    if (!cwd || cwd.length > 1000 || prompt.length > 8000) return reply(false, '无效请求');
    out = { t: 'launch', cwd, prompt };
    audit('control-launch', c.ip, m.name, JSON.stringify(cwd).slice(0, 300), `prompt=${prompt.length}`);
  } else if (d.t === 'send') {
    const text = typeof d.text === 'string' ? d.text : '';
    if (!text.trim() || text.length > 8000) return reply(false, '内容为空或太长（最多 8000 字）');
    out = { t: 'send', id: s.id, text };
    audit('control-send', c.ip, m.name, s.id, `len=${text.length}`);
  } else if (d.t === 'key') {
    if (typeof d.key !== 'string' || !/^(up|down|left|right|enter|esc|tab|btab)$/.test(d.key)) return reply(false, '不支持的按键');
    out = { t: 'key', id: s.id, key: d.key };
    audit('control-key', c.ip, m.name, s.id, d.key);
  } else {
    if (typeof d.perm !== 'string' || !['allow', 'deny', 'defer'].includes(d.choice)) return reply(false, '无效请求');
    if (!s.perms.some((p) => p.id === d.perm)) return reply(false, '这个确认已经结束了');
    out = { t: 'decide', id: s.id, perm: d.perm, choice: d.choice };
    audit('control-decide', c.ip, m.name, s.id, d.choice);
  }
  const rid = crypto.randomBytes(12).toString('hex');
  const timer = setTimeout(() => { if (pending.delete(rid)) reply(false, '机器没有回应，结果不确定，请看对话确认'); }, 20000);
  pending.set(rid, { c, crid: d.rid, machine: m.name, timer });
  const sock = [...m.sockets].pop();                                  // the newest connection of that machine
  try { sock.send(JSON.stringify({ ...out, rid })); } catch { pending.delete(rid); clearTimeout(timer); reply(false, '发送失败'); }
}

// ---------- http server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);

  // --- public: the login page (it gives nothing away) ---
  if (req.method === 'GET' && (p === '/login' || p === '/login.html')) return serveFile(res, 'login.html');
  if (req.method === 'GET' && p === '/login.js') return serveFile(res, 'login.js');
  if (req.method === 'GET' && p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');

  // --- state-changing API: same-origin only ---
  if (req.method === 'POST' && p.startsWith('/api/') && !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
  if (req.method === 'POST' && p === '/api/login') return apiLogin(req, res, ip);
  if (req.method === 'POST' && p === '/api/logout') {
    const t = cookies(req)[SID];
    if (t) { auth.endSession(t); for (const c of clients) if (c.sid === t) { try { c.ws.close(4401, 'logged out'); } catch {} } }
    setCookie(res, SID, '', 0);
    return json(res, 200, { ok: true });
  }

  // --- everything below requires a session ---
  const sess = auth.checkSession(cookies(req)[SID]);
  if (!sess) {
    if (req.method === 'GET' && !p.startsWith('/api/')) { res.writeHead(302, { ...SEC_HEADERS, Location: '/login' }); return res.end(); }
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, 'index.html');
  if (req.method === 'GET' && STATIC.test(p)) return serveFile(res, p.slice(1), /^\/(icons|img|wall|sounds)\//.test(p) ? 'max-age=86400' : 'no-cache');
  if (req.method === 'GET' && p.startsWith('/asset/')) return serveAsset(res, p.slice('/asset/'.length));
  if (req.method === 'GET' && p === '/api/sessions') return json(res, 200, { data: snapshot() });
  if (req.method === 'POST' && p === '/api/stepup') return apiStepUp(req, res, ip, sess);
  // the machines allowed to connect (添加电脑): listing is free, changing needs a code entered within the hour
  if (req.method === 'GET' && p === '/api/agents') return json(res, 200, { items: agentsAdmin.list() });
  if (req.method === 'POST' && (p === '/api/agents/add' || p === '/api/agents/remove')) {
    if (!auth.isFresh(sess)) return json(res, 200, { ok: false, need: 'totp', msg: '需要再输一次验证码' });
    let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
    const r = p.endsWith('/add') ? agentsAdmin.add(d.name, ip) : agentsAdmin.remove(String(d.name || ''), ip);
    if (r.ok) broadcast({ t: 'sessions', data: snapshot() });
    return json(res, 200, r);
  }
  // wallpapers the server downloaded (display settings on the desktop)
  if (req.method === 'GET' && p === '/api/walls') return json(res, 200, { items: walls.list().map((w) => ({ name: w.name, url: '/wallpaper/' + w.name })) });
  if (req.method === 'POST' && p === '/api/wall/fetch') return apiWallFetch(req, res, ip);
  if (req.method === 'POST' && p === '/api/wall/delete') {
    let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
    const ok = walls.remove(d.name); if (ok) audit('wall-delete', ip, String(d.name));
    return json(res, ok ? 200 : 404, { ok });
  }
  if (req.method === 'GET' && p.startsWith('/wallpaper/')) {
    const w = walls.file(p.slice('/wallpaper/'.length));
    if (!w) return send(res, 404, 'not found');
    return fs.readFile(w.f, (e, buf) => e ? send(res, 404, 'not found') : send(res, 200, buf, w.type, { 'Cache-Control': 'max-age=86400' }));
  }
  // 日报 (summary/index.js)
  if (summary && /^\/api\/(report|search|ask)/.test(p) && await summary.handle(req, res, url, ip, json)) return;
  if (p.startsWith('/api/todos') && await todos.handle(req, res, p, ip, json, readBody)) return;
  if (/^\/api\/notes?(\/|$)/.test(p) && await notes.handle(req, res, url, ip, json, readBody)) return;
  // a copy of an artifact kept on the NAS (artifacts.js): pictures and text shown, anything else downloaded
  if (req.method === 'GET' && p === '/api/artifact') {
    const f = artifacts.fileOf(String(url.searchParams.get('sha') || ''));
    if (!f) return send(res, 404, 'not found');
    const name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\-一-龥 ]/g, '_').slice(0, 120) || 'file';
    const ext = path.extname(name).toLowerCase();
    const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const TXT = /^\.(txt|md|py|js|ts|m|json|csv|log|sh|ps1|bat|tex|c|cpp|h|java|go|rs|yaml|yml|toml|ini|cfg)$/;
    const type = IMG[ext] || (TXT.test(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    const disp = IMG[ext] || TXT.test(ext) ? 'inline' : 'attachment';
    audit('artifact-read', ip, url.searchParams.get('sha').slice(0, 16));
    return fs.readFile(f, (e, buf) => e ? send(res, 404, 'not found') : send(res, 200, buf, type,
      { 'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'private, max-age=86400' }));
  }

  return send(res, 404, 'not found');
});

function serveFile(res, name, cache) {
  const f = path.join(PUBLIC, name);
  if (!f.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  fs.readFile(f, (e, buf) => e ? send(res, 404, 'not found') : send(res, 200, buf, TYPES[path.extname(f)] || 'application/octet-stream', cache ? { 'Cache-Control': cache } : undefined));
}
function serveAsset(res, rel) {
  rel = rel.replace(/\\/g, '/');
  if (!ASSET_OK.test(rel)) return send(res, 404, 'not found');
  const f = path.join(ASSETS, rel);
  if (!f.startsWith(ASSETS)) return send(res, 404, 'not found');
  fs.readFile(f, (e, buf) => e ? send(res, 404, 'not found') : send(res, 200, buf, TYPES[path.extname(f)] || 'application/octet-stream', { 'Cache-Control': 'max-age=86400' }));
}

// ---------- login: username + password + TOTP in ONE request, one generic answer ----------
// A wrong password and a wrong code look exactly the same, so the password cannot be guessed on its own.
// The code is only checked (and so only used up) once the password is right.
const FAIL = { error: 'failed' };
async function apiLogin(req, res, ip) {
  const wait = auth.lockedFor(ip);
  if (wait > 0) return json(res, 429, { error: 'locked', retryMs: wait });
  let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
  const okUser = typeof d.user === 'string' && auth.sameText(d.user, cfg.user);
  const okPass = typeof d.password === 'string' && d.password.length <= 1024 && auth.verifyPassword(d.password, cfg.password);
  const ok = okUser && okPass && auth.verifyTotp(cfg.totpSecret, d.code);
  if (!ok) {
    auth.recordFail(ip);
    audit('login-fail', ip, okUser && okPass ? '(code)' : '');
    return json(res, 401, FAIL);
  }
  auth.clearFails(ip);
  const sid = auth.newSession(ip, String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(res, SID, sid, 24 * 3600);
  audit('login-ok', ip);
  return json(res, 200, { ok: true });
}
let wallBusy = 0;
async function apiWallFetch(req, res, ip) {
  let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
  if (wallBusy >= 2) return json(res, 429, { ok: false, msg: '正在下载别的图片，稍后再试' });
  wallBusy++;
  try {
    const name = await walls.fetchUrl(d.url);
    audit('wall-fetch', ip, name);
    return json(res, 200, { ok: true, name, url: '/wallpaper/' + name });
  } catch (e) {
    return json(res, 200, { ok: false, msg: String(e && e.message || '下载失败').slice(0, 120) });
  } finally { wallBusy--; }
}
// re-enter the code before acting on a machine (see auth.FRESH_MS)
async function apiStepUp(req, res, ip, sess) {
  const wait = auth.lockedFor(ip);
  if (wait > 0) return json(res, 429, { error: 'locked', retryMs: wait });
  let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
  if (!auth.verifyTotp(cfg.totpSecret, d.code)) {
    auth.recordFail(ip);
    audit('stepup-fail', ip);
    return json(res, 401, FAIL);
  }
  auth.markFresh(sess);
  audit('stepup-ok', ip);
  return json(res, 200, { ok: true });
}

// ---------- websockets: /ws for the browser, /agent for machines ----------
const wssBrowser = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
const AGENT_SPLIT = !!(cfg.agent && cfg.agent.port);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') {
    // the socket can act on machines: only the dashboard's own pages may open it (no cross-site hijacking)
    if (!sameOrigin(req)) {
      audit('ws-bad-origin', clientIp(req), String(req.headers.origin || '-').slice(0, 100));
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
    }
    const sid = cookies(req)[SID];
    if (!auth.checkSession(sid)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wssBrowser.handleUpgrade(req, socket, head, (ws) => wssBrowser.emit('connection', ws, req, sid));
  } else if (url.pathname === '/agent' && !AGENT_SPLIT) {
    agentUpgrade(req, socket, head);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
  }
});
// agents: bearer token (or ?token= for simple clients)
function agentUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  {
    // agents authenticate with a bearer token in the Authorization header (or ?token= for simple clients)
    const hdr = String(req.headers['authorization'] || '');
    const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : url.searchParams.get('token') || '';
    reloadAgents();
    const a = tok && auth.matchAgent(cfg.agents, tok);
    if (!a) { audit('agent-reject', clientIp(req)); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req, a));
  }
}

wssBrowser.on('connection', (ws, req, sid) => {
  const c = { ws, sub: null, sid, ip: clientIp(req) };
  clients.add(c);
  try { ws.send(JSON.stringify({ t: 'sessions', data: snapshot() })); } catch {}
  ws.on('message', (raw) => {
    if (raw.length > 64000) return;
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'watch' && typeof d.machine === 'string' && typeof d.id === 'string') {
      c.sub = { machine: d.machine, id: d.id }; pushConvTo(c);
    } else if (d.t === 'unwatch') c.sub = null;
    else if ((d.t === 'fs' || d.t === 'fs-cancel') && typeof d.rid === 'string' && d.rid.length < 40) {
      if (!auth.checkSession(c.sid)) { try { ws.close(4401, 'logged out'); } catch {} return; }
      fsRelay.fromBrowser(c, d);                                       // read-only file explorer
    }
    else if ((d.t === 'send' || d.t === 'key' || d.t === 'decide' || d.t === 'launch') && typeof d.rid === 'string' && d.rid.length < 40) {
      // the login may have expired or been logged out while the socket stayed open
      if (!auth.checkSession(c.sid)) { try { ws.close(4401, 'logged out'); } catch {} return; }
      onBrowserAction(c, d);
    }
  });
  // the login can expire (or be ended elsewhere) while the socket stays open: re-check every minute
  const recheck = setInterval(() => { if (!auth.checkSessionQuiet(c.sid)) { try { ws.close(4401, 'expired'); } catch {} } }, 60e3);
  const gone = () => { clearInterval(recheck); clients.delete(c); fsRelay.dropClient(c); for (const [rid, p] of pending) if (p.c === c) { clearTimeout(p.timer); pending.delete(rid); } };
  ws.on('close', gone);
  ws.on('error', gone);
});

wssAgent.on('connection', (ws, req, a) => {
  const m = machine(a.name);
  m.online = true; m.since = Date.now();
  if (!m.sockets) m.sockets = new Set();
  m.sockets.add(ws);
  audit('agent-online', a.name, clientIp(req));
  broadcast({ t: 'sessions', data: snapshot() });
  // where the stored conversations of this machine stand: the agent streams on from there
  try { ws.send(JSON.stringify({ t: 'sync', offsets: store.offsets(a.name) })); } catch {}
  ws.on('message', (raw) => onAgentMessage(m, raw, ws));             // size capped by maxPayload
  const ping = setInterval(() => { try { ws.ping(); } catch {} }, 30000);
  const down = () => {
    clearInterval(ping); m.sockets.delete(ws);
    if (m.sockets.size === 0) { m.online = false; fsRelay.dropMachine(a.name); audit('agent-offline', a.name); broadcast({ t: 'sessions', data: snapshot() }); }
  };
  ws.on('close', down); ws.on('error', down);
});

const host = cfg.web && cfg.web.host || '127.0.0.1';
const port = cfg.web && cfg.web.port || 8787;
server.listen(port, host, () => console.log(`Ame 看板监听 http://${host}:${port}  —— 远程控制${CONTROL ? '开（各机器 agent 另需 "control": true）' : '关（只读）'}`));
// agents on their own listener (a VPN address): nothing but /agent is served there, and /agent is not on the web one
if (AGENT_SPLIT) {
  const ah = cfg.agent.host || '127.0.0.1';
  if (ah === '0.0.0.0' || ah === '::') console.warn('警告：agent 监听在所有网卡上，建议改成 VPN 地址（如 Tailscale 的 100.x.x.x）');
  const agentServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  agentServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname === '/agent') return agentUpgrade(req, socket, head);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
  });
  agentServer.listen(cfg.agent.port, ah, () => console.log(`agent 入口 ws://${ah}:${cfg.agent.port}/agent`));
}
