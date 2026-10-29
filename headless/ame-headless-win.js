#!/usr/bin/env node
// AmeTyping headless service for Windows: the pet's local API without the pet -- no window, no animation, no keyboard
// hook. For a computer where only the dashboard is wanted (install/install-windows.ps1, AME_MODE=headless).
// Claude Code / Codex hooks (../hook-relay.js, ../permission-hook.js, ../codex-hook.js) post to it on 127.0.0.1:3940
// exactly as they would to the pet, and the dashboard agent (../remote/agent/agent.js) drives it through /control/*.
// Everything that touches a console window is the pet's own code: the console bridge (../app/bridge.js), replies, keys,
// screens and launching (../app/remote-control.js), finding a session's terminal (../app/session-locate.js).
//   POST /event/<type>   session progress            POST /permission   a card, held open until answered
//   /control/state|send|key|screen|launch|decide|title   for the agent; token in ~/.ametyping/control-token-<port>
// Remote control has no switch of its own here (the pet's tray option): agent.json's "control" decides, as on Linux.
// Run with node (the installer starts it hidden, through conhost --headless). Its log: ~/.ametyping/headless.log.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const APP = path.join(__dirname, '..', 'app');
const bridge = require(path.join(APP, 'bridge'));
const { createPermissions } = require(path.join(APP, 'permissions'));
const { normalizeSession } = require(path.join(APP, 'session-source'));
const { createRemoteControl } = require(path.join(APP, 'remote-control'));
const { adoptRunning } = require(path.join(APP, 'session-adopt'));
const { lineage } = require(path.join(APP, 'running-sessions'));
const { CLAUDE_EXE, TERM_HOSTS, createLocator } = require(path.join(APP, 'session-locate'));
const { createWinSessions } = require('./sessions-win');

const PORT = +process.env.AME_PORT || 3940;
const HOME = os.homedir();

// ---- a small log (nobody sees this process's console) ----
const LOG = path.join(HOME, '.ametyping', 'headless.log');
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200e3) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const { locate, procAlive } = createLocator({ bridge });
// A card answered (on the dashboard or in the terminal) puts the session back to work: left "waiting" with 需要确认 as
// its last line, the dashboard's reply box would stay blocked until the next hook event (as in the pet's main.js)
const PERM_END = { decided: (e) => (e.choice === 'allow' ? '已允许' : e.choice === 'always' ? '已总是允许' : e.choice === 'answer' ? '已回答' : e.choice === 'chat' ? '先聊聊' : '已拒绝'),
  closed: () => '已在终端处理', advanced: () => '已在终端处理' };
const permissions = createPermissions((sid, end) => {
  const s = sessions.map.get(sid), say = end && PERM_END[end.why];
  if (say && s && s.state === 'waiting' && !permissions.list(sid).length) sessions.event('thinking', { session: sid, text: `${say(end)}：${end.tool}` });
});
const sessions = createWinSessions({
  procAlive, cards: (id) => permissions.list(id),
  onGone: (id) => { permissions.advance({ session: id, hookEvent: 'SessionEnd' }); sessions.event('quit', { session: id }); },
});
const rc = createRemoteControl({ sessions: sessions.map, permissions, bridge, procAlive, pushBubble: () => {}, home: () => HOME });

// background sessions and the terminals parked on them (running-sessions.js): a parked terminal is the background
// session's window, not a session of its own -- left out, as the pet does. Looked up at most every 3 s.
let lineageAt = 0, lineageNow = { bg: new Set(), parked: new Set() };
function sessionLineage() {
  if (Date.now() - lineageAt > 3000) {
    lineageAt = Date.now();
    try { lineageNow = lineage(HOME, (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }); } catch {}
  }
  return lineageNow;
}

// ---- control API for the agent ----
const CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');
const tokenFile = path.join(HOME, '.ametyping', `control-token-${PORT}`);
function writeToken() {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, CONTROL_TOKEN, { mode: 0o600 });
}
function removeToken() { try { if (fs.readFileSync(tokenFile, 'utf8') === CONTROL_TOKEN) fs.unlinkSync(tokenFile); } catch {} }
function controlOk(req) {
  const t = Buffer.from(String(req.headers['x-ame-control'] || ''));
  return !req.headers.origin && t.length === CONTROL_TOKEN.length && crypto.timingSafeEqual(t, Buffer.from(CONTROL_TOKEN));
}
function controlState() {
  const { bg, parked } = sessionLineage();
  return sessions.list().filter((s) => !parked.has(s.id)).map((s) => ({
    id: s.id, label: sessions.label(s), project: s.project, provider: s.provider, state: s.state, via: sessions.via(s), bg: bg.has(s.id),
    t0: s.t0, last: s.last, lines: s.lines.slice(-8), btw: rc.btwList(s), api: s.api || undefined,
    perms: permissions.list(s.id).map((p) => ({ id: p.id, provider: p.provider, tool: p.tool, cwd: p.cwd, subagent: p.subagent, always: p.always, ask: p.ask || undefined,
      input: JSON.stringify(p.input || {}, null, 2).slice(0, 8000) })),
  }));
}
async function onControl(req, res, body) {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!controlOk(req)) return out(403, { ok: false });
  if (req.method === 'GET' && req.url === '/control/state') return out(200, { sessions: controlState() });
  let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
  // a session renamed with /rename (no hook says so; the NAS heard it from the agent's records)
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
    return out(200, await rc.launch(d.cwd, d.prompt || '', typeof d.resume === 'string' ? d.resume : '', ['codex', 'opencode'].includes(d.tool) ? d.tool : 'claude', d.api));
  }
  if (req.method === 'POST' && req.url === '/control/decide') {
    if (typeof d.session !== 'string' || !permissions.list(d.session).some((p) => p.id === d.id)) return out(200, { ok: false, msg: '这个确认已经结束了' });
    return out(200, permissions.decide(d.id, d.choice, { answers: d.answers }) ? { ok: true } : { ok: false, msg: '请求已结束' });
  }
  // (/control/report and /control/mail: the pet's morning and mail bubbles -- nothing to show them here)
  return out(404, { ok: false });
}

// ---- hook endpoints ----
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
      permissions.add(d, res);                                      // held open until decided / timed out / hook gone
      sessions.event('waiting', { ...d, text: `需要确认：${d.tool}` });
      if (d.pid && d.provider !== 'opencode') locate(sessions.map.get(d.session), d.pid).catch(() => {});
      return;
    }
    if (!m) { res.writeHead(404); res.end(); return; }
    permissions.advance(d);
    // the hook waits for this answer, so its parent process is still alive while we look it up (briefly: the bridge's
    // first start takes a moment, and the hook must not hold Claude Code up for it)
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
  bridge.start();                                                    // warm up: the first hook event needs the process lookup fast
  // Claude Code sessions already open (a restart, the computer waking up): on the list at once
  setTimeout(() => adoptRunning({ sessions: sessions.map, bridge, home: HOME, isClaude: (n) => CLAUDE_EXE.test(n), isTerminal: (n) => TERM_HOSTS.test(n), onChange: () => {} })
    .then((n) => { if (n) log(`接回了 ${n} 个已在运行的 Claude / Codex 会话`); }, (e) => log('adopt: ' + e.message)), 1500);
});
function stop() { permissions.clear(); removeToken(); bridge.stop(); process.exit(0); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop);
// a crash goes to the log; the scheduled task starts the service again within a minute
process.on('uncaughtException', (e) => { log('出错退出：' + (e && e.stack || e)); permissions.clear(); removeToken(); process.exit(1); });
