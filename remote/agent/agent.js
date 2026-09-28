#!/usr/bin/env node
// Ame dashboard agent -- runs on each machine next to Claude Code. It watches this machine's Claude sessions
// and PUSHES them to the dashboard server (session list + conversations, read from the transcript files).
// It connects OUT to the server (no inbound port here).
//
// Data sources:
//   1) direct scan of ~/.claude/projects/*.jsonl -- always available, read-only.
//   2) the local pet (127.0.0.1:3940/control/state, if it is running and control is on) -- how each session
//      can be replied to, pending permission cards, and Codex sessions.
//
// Remote control is OFF unless agent.json says "control": true. When on, the server may ask for exactly two
// things, both carried out by the local pet the same way its own panel does them: type a reply into a
// session (`send`) and answer a permission card (`decide`). Nothing else coming down the socket is honoured.
// This file reuses the pet's transcript parser (../../app/transcript.js).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const transcript = require('../../app/transcript');

const CFG = process.env.AME_AGENT_CONFIG || path.join(__dirname, 'agent.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {
  console.error(`读不到 ${CFG}。示例见 agent.example.json：{ "server": "wss://你的域名/agent", "token": "xxx", "name": "本机名", "control": false }`);
  process.exit(1);
}
const NAME = cfg.name || os.hostname();
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SCAN_MS = cfg.scanMs || 2000;
const IDLE_DROP_MS = cfg.keepMs || 30 * 60e3;      // stop listing a session with no file changes for this long
const CONTROL = cfg.control === true;
const PET_PORT = +cfg.petPort || 3940;
const PET_TOKEN_FILE = path.join(os.homedir(), '.ametyping', `control-token-${PET_PORT}`);

// ---------- discover and read local transcripts ----------
// state per session id: transcript cache (transcript.js) + derived display fields
const sess = new Map();

function newestFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs });
    }
  }
  return out;
}

// state of a session from its parsed messages
function deriveState(c) {
  const msgs = c.msgs || [];
  const last = msgs[msgs.length - 1];
  if (!last) return 'idle';
  if (last.role === 'user') return 'working';          // user just spoke, Claude will answer
  if (last.role === 'tool') return 'working';
  if (last.role === 'assistant') return 'done';
  return 'idle';
}
function projectOf(file) {
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl  -> last path segment as a rough project name
  const enc = path.basename(path.dirname(file));
  const parts = enc.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function scan() {
  const now = Date.now();
  const files = newestFiles();
  const seen = new Set();
  for (const f of files) {
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(f.id)) continue;   // the pet still lists it: keep it (can be resumed)
    seen.add(f.id);
    let c = sess.get(f.id);
    if (!c || c.file !== f.file) { c = { file: f.file, project: projectOf(f.file) }; sess.set(f.id, c); }
    try { transcript.poll(c); } catch {}
    c.mtime = f.mtime;
  }
  for (const id of [...sess.keys()]) if (!seen.has(id)) sess.delete(id);
}

// ---------- the local pet (control API on 127.0.0.1) ----------
const pet = new Map();                               // id -> session as the pet sees it
function petCall(method, p, body) {
  let token;
  try { token = fs.readFileSync(PET_TOKEN_FILE, 'utf8').trim(); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: PET_PORT, method, path: p, timeout: 8000,
      headers: { 'X-Ame-Control': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data);
  });
}
async function pollPet() {
  const r = CONTROL ? await petCall('GET', '/control/state') : null;
  pet.clear();
  if (r && Array.isArray(r.sessions)) for (const s of r.sessions) if (s && typeof s.id === 'string') pet.set(s.id, s);
}
// the only two things the agent does for the server
async function control(d) {
  if (!CONTROL) return { ok: false, msg: '这台机器没开远程控制（agent.json 里设 "control": true）' };
  let r;
  if (d.t === 'send' && typeof d.id === 'string' && typeof d.text === 'string' && d.text.trim() && d.text.length <= 8000) {
    r = await petCall('POST', '/control/send', { id: d.id, text: d.text });
  } else if (d.t === 'decide' && typeof d.id === 'string' && typeof d.perm === 'string' && ['allow', 'deny', 'defer'].includes(d.choice)) {
    r = await petCall('POST', '/control/decide', { session: d.id, id: d.perm, choice: d.choice });
  } else return { ok: false, msg: '无效请求' };
  if (!r) return { ok: false, msg: '本机糖糖没在运行，没法操作' };
  setTimeout(() => tick(true), 300);
  return { ok: !!r.ok, msg: typeof r.msg === 'string' ? r.msg.slice(0, 200) : '' };
}

// ---------- shape for the server ----------
const lineOf = (m) => ({ text: m.role === 'tool' ? '⚙ ' + (m.items || []).slice(-1)[0] : (m.text || '').slice(0, 200), t: m.t, type: m.role });
function stateList() {
  const out = [...sess.entries()].map(([id, c]) => {
    const msgs = c.msgs || [];
    const p = pet.get(id);
    return { id, label: c.title || (p && p.label) || c.project || 'Claude', project: c.project || '',
      state: p ? p.state : deriveState(c),
      steps: 0, t0: msgs[0] ? msgs[0].t : c.mtime, last: c.mtime, lines: msgs.slice(-8).map(lineOf).filter((l) => l.text),
      via: p ? p.via : 'off', perms: p ? p.perms : [] };
  });
  // sessions the pet knows but that have no transcript here (Codex, or a Claude session not written yet)
  for (const [id, p] of pet) {
    if (sess.has(id)) continue;
    out.push({ id, label: p.label || 'Claude', project: p.project || '', state: p.state, steps: 0, t0: p.t0, last: p.last,
      lines: (p.lines || []).map((l) => ({ text: l.text, t: l.t, type: l.type })), via: p.via, perms: p.perms || [] });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
function convOf(id) {
  const c = sess.get(id);
  if (!c) {                                          // pet-only session: its progress lines are all there is
    const p = pet.get(id);
    return p ? [{ role: 'sys', text: p.provider === 'codex' ? 'Codex 实时进度 · 对话请回到 Codex' : '实时进度', t: p.t0 },
      ...(p.lines || []).map((l) => ({ role: 'sys', text: l.text, t: l.t }))] : [];
  }
  return (c.msgs || []).slice(-300).map((m) => ({ role: m.role, text: m.text, items: m.items, t: m.t }));
}

// ---------- connection ----------
let ws = null, retry = 2000;
function connect() {
  ws = new WebSocket(cfg.server, { headers: { Authorization: 'Bearer ' + cfg.token } });
  ws.on('open', () => {
    retry = 2000;
    console.log(`已连接看板服务器，机器名「${NAME}」`);
    ws.send(JSON.stringify({ t: 'hello', machine: NAME, control: CONTROL }));
    lastConv.clear();
    tick(true);
  });
  ws.on('message', (raw) => {
    // honoured from the server: a request to read a conversation, and (only with "control": true) send / decide
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'want-conv' && typeof d.id === 'string') sendConv(d.id);
    else if ((d.t === 'send' || d.t === 'decide') && typeof d.rid === 'string') {
      control(d).then((r) => sendJSON({ t: 'result', rid: d.rid, ...r }));
    }
  });
  ws.on('close', () => { ws = null; setTimeout(connect, retry); retry = Math.min(30000, retry * 1.5); });
  ws.on('error', () => { try { ws.close(); } catch {} });
}
function sendJSON(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }
function sendConv(id) { sendJSON({ t: 'conv', id, msgs: convOf(id) }); }

// push the session list on a change, and each conversation whose content moved
const lastConv = new Map();
let lastSig = '', ticking = false;
const tailT = (s) => (s.lines.length ? s.lines[s.lines.length - 1].t : 0);
async function tick(force) {
  if (ticking) return;
  ticking = true;
  try {
    await pollPet();
    scan();
    const list = stateList();
    const sig = JSON.stringify(list.map((s) => [s.id, s.state, s.last, s.via, s.perms.map((p) => p.id), tailT(s)]));
    if (sig === lastSig && force !== true) return;
    lastSig = sig;
    sendJSON({ t: 'state', control: CONTROL, sessions: list });
    for (const s of list) {
      const cs = `${s.last}|${tailT(s)}`;
      if (lastConv.get(s.id) !== cs) { lastConv.set(s.id, cs); sendConv(s.id); }
    }
  } finally { ticking = false; }
}
setInterval(tick, SCAN_MS);
connect();
console.log(`Ame 看板 agent 启动，扫描 ${PROJECTS}；远程控制：${CONTROL ? `开（经本机糖糖 127.0.0.1:${PET_PORT}）` : '关'}`);
