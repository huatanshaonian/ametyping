#!/usr/bin/env node
// AmeTyping headless service for Windows: the pet's local API without the pet -- no window, no animation, no keyboard
// hook. For a computer where only the dashboard is wanted (install/install-windows.ps1, AME_MODE=headless).
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bridge = require('../app/bridge');
const { createPermissions } = require('../app/permissions');
const { normalizeSession } = require('../app/session-source');
const { createRemoteControl } = require('../app/remote-control');
const { adoptRunning } = require('../app/session-adopt');
const { lineage } = require('../app/running-sessions');
const { CLAUDE_EXE, TERM_HOSTS, createLocator } = require('../app/session-locate');
const { PERM_END, createControlGuard, createCliUpdateTracker } = require('../app/control-guard');
const { createWinSessions } = require('./sessions-win');

const PORT = +process.env.AME_PORT || 3940;
const HOME = os.homedir();

const LOG = path.join(HOME, '.ametyping', 'headless.log');
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200e3) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const { locate, procAlive } = createLocator({ bridge });
const permissions = createPermissions((sid, end) => {
  const s = sessions.map.get(sid), say = end && PERM_END[end.why];
  if (say && s && s.state === 'waiting' && !permissions.list(sid).length) sessions.event('thinking', { session: sid, text: `${say(end)}：${end.tool}` });
});
const sessions = createWinSessions({
  procAlive, cards: (id) => permissions.list(id),
  onGone: (id) => { permissions.advance({ session: id, hookEvent: 'SessionEnd' }); sessions.event('quit', { session: id }); },
});
const cliUpdates = createCliUpdateTracker();
const rc = createRemoteControl({
  sessions: sessions.map,
  permissions,
  bridge,
  procAlive,
  pushBubble: () => {},
  home: () => HOME,
  onCliUpdate: cliUpdates.record,
});

let lineageAt = 0, lineageNow = { bg: new Set(), parked: new Set() };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function sessionLineage() {
  if (Date.now() - lineageAt > 3000) {
    lineageAt = Date.now();
    try { lineageNow = lineage(HOME, pidAlive); } catch {}
  }
  return lineageNow;
}

const { writeToken, removeToken, controlOk } = createControlGuard(PORT, () => HOME);

function controlState() {
  const { bg, parked } = sessionLineage();
  return sessions.list().filter((s) => !parked.has(s.id)).map((s) => ({
    id: s.id, label: sessions.label(s), project: s.project, provider: s.provider, state: s.state, via: sessions.via(s), bg: bg.has(s.id),
    t0: s.t0, last: s.last, lines: s.lines.slice(-8), btw: rc.btwList(s), api: s.api || undefined,
    ai: s.ai || undefined, model: s.model || undefined,
    perms: permissions.list(s.id).map((p) => ({
      id: p.id, provider: p.provider, tool: p.tool, cwd: p.cwd, subagent: p.subagent, always: p.always, ask: p.ask || undefined,
      input: JSON.stringify(p.input || {}, null, 2).slice(0, 8000),
    })),
  }));
}

async function onControl(req, res, body) {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!controlOk(req)) return out(403, { ok: false });
  if (req.method === 'GET' && req.url === '/control/state') return out(200, { sessions: controlState(), cliUpdates: cliUpdates.values() });
  let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
  if (req.method === 'POST' && req.url === '/control/title') {
    const s = typeof d.id === 'string' && sessions.map.get(d.id), t = typeof d.title === 'string' ? d.title.trim().slice(0, 60) : '';
    if (s && t) s.title = t;
    return out(200, { ok: !!s });
  }
  if (req.method === 'POST' && req.url === '/control/send') {
    const text = typeof d.text === 'string' ? d.text : '';
    if (typeof d.id !== 'string' || !text.trim() || text.length > 8000) return out(400, { ok: false, msg: '内容为空或太长' });
    return out(200, await rc.chatSend(d.id, text));
  }
  if (req.method === 'POST' && req.url === '/control/key') {
    if (typeof d.id !== 'string' || typeof d.key !== 'string') return out(400, { ok: false, msg: '无效请求' });
    return out(200, await rc.chatKey(d.id, d.key, d.screen === true, d.hl === true));
  }
  if (req.method === 'POST' && req.url === '/control/screen') {
    if (typeof d.id !== 'string') return out(400, { ok: false, msg: '无效请求' });
    return out(200, await rc.chatScreen(d.id, d.hl === true));
  }
  if (req.method === 'POST' && req.url === '/control/launch') {
    if (typeof d.cwd !== 'string' || !d.cwd || (d.prompt != null && typeof d.prompt !== 'string')) return out(400, { ok: false, msg: '无效请求' });
    return out(200, await rc.launch(d.cwd, d.prompt || '', typeof d.resume === 'string' ? d.resume : '', ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? d.tool : 'claude', d.api, d.meshEnv, d.model));
  }
  if (req.method === 'POST' && req.url === '/control/decide') {
    if (typeof d.session !== 'string' || !permissions.list(d.session).some((p) => p.id === d.id)) return out(200, { ok: false, msg: '这个确认已经结束了' });
    return out(200, permissions.decide(d.id, d.choice, { answers: d.answers }) ? { ok: true } : { ok: false, msg: '请求已结束' });
  }
  return out(404, { ok: false });
}

const server = http.createServer((req, res) => {
  const m = req.method === 'POST' && /^\/event\/([a-z]+)$/.exec(req.url);
  const permission = req.method === 'POST' && req.url === '/permission';
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > (permission ? 2e6 : 20000)) req.destroy(); });
  req.on('end', async () => {
    if (req.url.startsWith('/control/')) return onControl(req, res, body).catch((e) => { log('control: ' + e.message); try { res.writeHead(500); res.end('{}'); } catch {} });
    let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
    d = normalizeSession(d);
    if (permission) {
      if (typeof d.session !== 'string' || !d.session || typeof d.tool !== 'string' || !d.tool) { res.writeHead(400); res.end('{}'); return; }
      permissions.add(d, res);
      sessions.event('waiting', { ...d, text: `需要确认：${d.tool}` });
      if (d.pid && d.provider !== 'opencode') locate(sessions.map.get(d.session), d.pid).catch(() => {});
      return;
    }
    if (!m) { res.writeHead(404); res.end(); return; }
    permissions.advance(d);
    if (d.pid && m[1] !== 'quit' && d.provider !== 'opencode') {
      const s = sessions.ensure(d.session || 'unknown', d);
      sessions.event(m[1], d);
      await Promise.race([locate(s, d.pid).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    } else sessions.event(m[1], d);
    res.writeHead(200); res.end();
  });
});

setInterval(() => sessions.expire(), 5000).unref();
server.on('error', (e) => { log(`监听 127.0.0.1:${PORT} 失败：${e.message}（糖糖桌宠还开着？两者只能开一个）`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  writeToken();
  log(`无头服务启动，监听 127.0.0.1:${PORT}（pid ${process.pid}）`);
  bridge.start();
  setTimeout(() => adoptRunning({ sessions: sessions.map, bridge, home: HOME, isClaude: (n) => CLAUDE_EXE.test(n), isTerminal: (n) => TERM_HOSTS.test(n), onChange: () => {} })
    .then((n) => { if (n) log(`接回了 ${n} 个已在运行的会话`); }, (e) => log('adopt: ' + e.message)), 1500);
});
function stop() { permissions.clear(); removeToken(); bridge.stop(); process.exit(0); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop);
process.on('uncaughtException', (e) => { log('出错退出：' + (e && e.stack || e)); permissions.clear(); removeToken(); process.exit(1); });
