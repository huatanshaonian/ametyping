#!/usr/bin/env node
// AmeTyping headless service for Linux: the pet's local API without the pet. Claude Code hooks
// (../hook-relay.js, ../permission-hook.js) post to it on 127.0.0.1:3940 exactly as they would to the pet,
// and the dashboard agent (../remote/agent/agent.js) drives it through the same /control/* endpoints.
//   POST /event/<type>   session progress (hook-relay.js)
//   POST /permission     a permission prompt, held open until answered from the dashboard (permission-hook.js)
//   /control/state|send|decide   for the agent; token in ~/.ametyping/control-token-<port>, requests with Origin refused
// Replies are typed into the session's tmux pane; a session whose process is gone is resumed with `claude -p --resume`.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPermissions } = require('../app/permissions');
const { normalizeSession } = require('../app/session-source');
const { createSessions } = require('./sessions');
const proc = require('./proc-linux');
const tmux = require('./tmux');
const { resume } = require('./resume');

const PORT = +process.env.AME_PORT || 3940;
const sessions = createSessions();
const permissions = createPermissions(() => {});

// ---- where does a session live: its Claude process and tmux pane (looked up from the hook's parent pid) ----
function locate(s, pid) {
  if (!s || s.provider === 'codex' || !pid || s.fromPid === pid) return;
  const c = proc.findClaude(pid);
  if (!c) return;
  s.fromPid = pid;
  s.claudePid = c.pid; s.claudeComm = c.comm;
  s.headless = c.parent === process.pid;                             // a `claude -p --resume` we started ourselves
  s.target = s.headless ? null : proc.tmuxPaneOf(c.pid);
  // the environment the session was started with (proxy, API settings...): a background resume reuses it
  if (!s.headless) {
    const env = proc.environ(c.pid);
    delete env.TMUX; delete env.TMUX_PANE;
    if (env.PATH) s.env = env;
  }
}

// ---- reply to a session ----
async function chatSend(id, text) {
  const s = sessions.map.get(id);
  if (!s) return { ok: false, msg: '这个会话已经不在列表里了' };
  if (s.provider === 'codex') return { ok: false, msg: '请在 Codex 中继续对话；这里可以查看进度和处理权限' };
  if (s.headless) return { ok: false, msg: '后台续聊还在跑，等它这一轮完成再发' };
  if (s.claudePid && proc.alive(s.claudePid, s.claudeComm)) {
    if (!s.target) return { ok: false, msg: '这个会话不在 tmux 里，没法从这里回复（用 tmux 启动 claude 就可以）' };
    // the terminal is showing a prompt (permission, question): pasted text would land in it and pick options
    if (s.state === 'waiting' || permissions.list(s.id).length) return { ok: false, msg: '它在等你确认，先处理确认（卡片或终端里）' };
    const r = await tmux.send(s.target, text);
    return r.ok ? { ok: true } : { ok: false, msg: '发送失败：' + r.err };
  }
  if (s.state !== 'ended' && !s.claudePid) return { ok: false, msg: '还不知道这个会话在哪个终端里（等它下一次有动静）' };
  const r = resume(s.rawSession || s.id, s.cwd, s.env, text, () => {
    Object.assign(s, { headless: false, claudePid: null, claudeComm: null, fromPid: null, target: null, state: 'ended', last: Date.now() });
  });
  if (!r.ok) return r;
  Object.assign(s, { headless: true, state: 'message', last: Date.now() });
  return { ok: true, msg: '这个会话已经关了，在后台用 claude -p --resume 续上（需要确认权限的操作会被跳过）' };
}

// ---- control API for the agent ----
const CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');
const tokenFile = path.join(os.homedir(), '.ametyping', `control-token-${PORT}`);
function writeToken() {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, CONTROL_TOKEN, { mode: 0o600 });
}
function removeToken() { try { if (fs.readFileSync(tokenFile, 'utf8') === CONTROL_TOKEN) fs.unlinkSync(tokenFile); } catch {} }
function controlOk(req) {
  const t = Buffer.from(String(req.headers['x-ame-control'] || ''));
  return !req.headers.origin && t.length === CONTROL_TOKEN.length && crypto.timingSafeEqual(t, Buffer.from(CONTROL_TOKEN));
}
function controlState() {
  return sessions.list().map((s) => ({
    id: s.id, label: sessions.label(s), project: s.project, provider: s.provider, state: s.state, via: sessions.via(s),
    t0: s.t0, last: s.last, lines: s.lines.slice(-8),
    perms: permissions.list(s.id).map((p) => ({ id: p.id, provider: p.provider, tool: p.tool, cwd: p.cwd, subagent: p.subagent,
      input: JSON.stringify(p.input || {}, null, 2).slice(0, 8000) })),
  }));
}
async function onControl(req, res, body) {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!controlOk(req)) return out(403, { ok: false });
  if (req.method === 'GET' && req.url === '/control/state') return out(200, { sessions: controlState() });
  let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
  if (req.method === 'POST' && req.url === '/control/send') {
    const text = typeof d.text === 'string' ? d.text : '';
    if (typeof d.id !== 'string' || !text.trim() || text.length > 8000) return out(400, { ok: false, msg: '内容为空或太长' });
    return out(200, await chatSend(d.id, text));
  }
  if (req.method === 'POST' && req.url === '/control/decide') {
    if (typeof d.session !== 'string' || !permissions.list(d.session).some((p) => p.id === d.id)) return out(200, { ok: false, msg: '这个确认已经结束了' });
    return out(200, permissions.decide(d.id, d.choice) ? { ok: true } : { ok: false, msg: '请求已结束' });
  }
  return out(404, { ok: false });
}

// ---- hook endpoints ----
const server = http.createServer((req, res) => {
  const m = req.method === 'POST' && /^\/event\/([a-z]+)$/.exec(req.url);
  const permission = req.method === 'POST' && req.url === '/permission';
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > (permission ? 2e6 : 20000)) req.destroy(); });
  req.on('end', () => {
    if (req.url.startsWith('/control/')) return onControl(req, res, body).catch(() => { try { res.writeHead(500); res.end('{}'); } catch {} });
    let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
    d = normalizeSession(d);
    if (permission) {
      if (typeof d.session !== 'string' || !d.session || typeof d.tool !== 'string' || !d.tool) { res.writeHead(400); res.end('{}'); return; }
      permissions.add(d, res);                                      // held open until decided / timed out / hook gone
      sessions.event('waiting', { ...d, text: `需要确认：${d.tool}` });
      if (d.pid) locate(sessions.map.get(d.session), d.pid);
      return;
    }
    if (!m) { res.writeHead(404); res.end(); return; }
    permissions.advance(d);
    // look the process up before answering: the hook's parent is guaranteed alive while it waits for us
    if (d.pid && m[1] !== 'quit') locate(sessions.ensure(d.session || 'unknown', d), d.pid);
    res.writeHead(200); res.end();
    sessions.event(m[1], d);
  });
});

setInterval(() => sessions.expire(), 5000).unref();
server.on('error', (e) => { console.error(`监听 127.0.0.1:${PORT} 失败：${e.message}`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  writeToken();
  console.log(`Ame 无头服务监听 127.0.0.1:${PORT}；控制令牌 ${tokenFile}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { permissions.clear(); removeToken(); process.exit(0); });
