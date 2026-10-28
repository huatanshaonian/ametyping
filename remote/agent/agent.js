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
// Remote control is OFF unless agent.json says "control": true AND the local pet allows it (its tray option
// "允许远程控制"; the Linux headless service has no such option and always allows it). When on, the server may ask for exactly two
// things, both carried out by the local pet the same way its own panel does them: type a reply into a
// session (`send`) and answer a permission card (`decide`). Nothing else coming down the socket is honoured.
// Conversations go to the server as slim records (records.js), streamed from the byte offset the server has
// stored; the server writes them to disk. This file reuses the pet's transcript parser (../../app/transcript.js).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const transcript = require('../../app/transcript');
const { lineage } = require('../../app/running-sessions');
const records = require('./records');
const commands = require('./commands');
const codex = require('../../app/codex-records');
const { createFiles } = require('./files');
const claudeApis = require('./claude-apis');
const { createFsServe } = require('./fs-serve');
const { createArchive } = require('./archive');
const { createArtifacts } = require('./artifacts');
const { agentsOf } = require('./subagents');
const codexAgents = require('./codex-subagents');

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
// file browsing for the dashboard (agent.json "files": { roots, exclude }); off unless configured; uploads into those
// folders only with "upload": true there (fs-upload.js)
const browse = createFiles(cfg.files);
const fsServe = createFsServe(browse, (o) => sendJSON(o), { sessionFile: (id) => sessionFile(id) });
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

// Background sessions of Claude Code's and the terminals parked on them (app/running-sessions.js lineage). A parked
// terminal is the background session's window, not a session: it is left out here too -- the pet not listing it is
// not enough, for its old transcript keeps being written to and would count as a session with recent activity.
let line = { bg: new Set(), parked: new Set() };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function scan() {
  const now = Date.now();
  const files = newestFiles();
  const seen = new Set();
  try { line = lineage(os.homedir(), pidAlive); } catch {}
  for (const f of files) {
    if (line.parked.has(f.id)) continue;
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(f.id)) continue;   // the pet still lists it: keep it (can be resumed)
    seen.add(f.id);
    let c = sess.get(f.id);
    if (!c || c.file !== f.file) { c = { file: f.file, project: projectOf(f.file) }; sess.set(f.id, c); }
    try { transcript.poll(c); } catch {}
    c.mtime = f.mtime;
  }
  for (const id of [...sess.keys()]) if (!seen.has(id)) sess.delete(id);
  // Codex CLI sessions: only stored on the server (the pet reports their live state); same idle rule
  const cseen = new Set();
  const cfiles = codex.recentFiles(Math.max(IDLE_DROP_MS, 6 * 3600e3));
  const subs = [];
  for (const f of cfiles) {
    let m = codexMeta.get(f.file);
    if (!m) { m = codex.metaOf(f.file); if (m) codexMeta.set(f.file, m); }    // a brand-new file may not have its first line yet
    if (!m) continue;
    if (m.sub) { subs.push(f); continue; }                                 // sub-threads are nested, not root sessions
    const id = 'codex:' + m.id;
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(id)) continue;
    cseen.add(id);
    codexSess.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: codex.titleOf(m.id) });
  }
  codexAgentRows = codexAgents.scan(subs);
  // A still-open CLI may have been idle longer than the scan window, including a freshly resumed old thread.
  for (const [id] of pet) {
    if (!id.startsWith('codex:') || cseen.has(id)) continue;
    const previous = codexSess.get(id), file = previous && fs.existsSync(previous.file) ? previous.file : codex.fileOf(id.slice(6));
    const m = file && (codexMeta.get(file) || codex.metaOf(file));
    if (!m || m.sub) continue;
    cseen.add(id);
    codexSess.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: codex.titleOf(m.id) });
  }
  for (const id of [...codexSess.keys()]) if (!cseen.has(id)) codexSess.delete(id);
}
const codexSess = new Map();                         // "codex:<thread id>" -> { file, project, cwd, title }
const codexMeta = new Map();                         // rollout file -> { id, cwd, sub }
let codexAgentRows = new Map();
// older sessions (agent.json "archiveDays", default 30; 0 = off) still streamed until the server has them whole
const archive = createArchive({ days: cfg.archiveDays != null ? +cfg.archiveDays : 30, claudeFiles: newestFiles, codex, projectOf,
  live: (id) => sess.has(id) || codexSess.has(id), stored: (id) => serverOff && serverOff[id] });
// the transcript of a session id (Claude Code or "codex:<id>"), for checking which files it wrote
function sessionFile(id) {
  if (id.startsWith('codex:')) {
    const c = codexSess.get(id) || archive.map.get(id);
    if (c) return { file: c.file, codex: true, cwd: c.cwd };
    for (const file of codex.allFiles()) {
      let m = codexMeta.get(file); if (!m) { m = codex.metaOf(file); if (m) codexMeta.set(file, m); }
      if (m && 'codex:' + m.id === id) return { file, codex: true, cwd: m.cwd };
    }
    return null;
  }
  const f = newestFiles().find((x) => x.id === id);
  return f ? { file: f.file, codex: false } : null;
}
// files made in sessions, checked and backed up when the server's daily summary asks (agent.json "artifacts": false = off)
const artifacts = createArtifacts({ sessionFile, send: (o) => sendJSON(o) });

// ---------- the local pet (control API on 127.0.0.1) ----------
const pet = new Map();                               // id -> session as the pet sees it
let petUp = false, petAllows = false;                // pet reachable / its "允许远程控制" option (absent = allowed)
const controlOn = () => CONTROL && petUp && petAllows;
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
  petUp = !!r; petAllows = !!r && r.control !== false;
  if (r && Array.isArray(r.sessions)) for (const s of r.sessions) if (s && typeof s.id === 'string') pet.set(s.id, s);
}
// the only things the agent does for the server: type a reply, press a navigation key, read the terminal's screen
// (its menus), answer a permission card,
// start Claude Code in a folder (one the file explorer may browse)
// the alias settings the server resolved for this machine (id / label / proxy / settings); bounded and validated
function apiOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = /^[A-Za-z0-9._-]{1,40}$/.test(String(v.id || '')) ? String(v.id) : '';
  if (!id) return null;
  const proxy = typeof v.proxy === 'string' && /^(direct|inherit|https?:\/\/\S{1,480})$/.test(v.proxy) ? v.proxy : 'inherit';
  const settings = v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings) ? v.settings : {};
  if (JSON.stringify(settings).length > 256 * 1024) return null;
  return { id, label: typeof v.label === 'string' ? v.label.slice(0, 60) : id, proxy, settings };
}

async function control(d) {
  if (!CONTROL) return { ok: false, msg: '这台机器没开远程控制（agent.json 里设 "control": true）' };
  const api = apiOf(d.api);
  let r;
  if (d.t === 'send' && typeof d.id === 'string' && typeof d.text === 'string' && d.text.trim() && d.text.length <= 8000) {
    r = await petCall('POST', '/control/send', { id: d.id, text: d.text });
  } else if (d.t === 'key' && typeof d.id === 'string' && typeof d.key === 'string' && /^(up|down|left|right|enter|esc|tab|btab|bksp|ctrlxs|ctrl[abe-y]|btwfork|c:[^\x00-\x1f\x7f]{1,200})$/.test(d.key)) {
    r = await petCall('POST', '/control/key', { id: d.id, key: d.key, screen: d.screen === true, hl: d.hl === true });
  } else if (d.t === 'screen' && typeof d.id === 'string') {
    r = await petCall('POST', '/control/screen', { id: d.id, hl: d.hl === true });
  } else if (d.t === 'launch' && typeof d.cwd === 'string' && typeof d.prompt === 'string' && d.prompt.length <= 8000) {
    if (!browse.enabled) return { ok: false, msg: '这台电脑没开放文件浏览' };
    let cwd; try { cwd = await browse.folder(d.cwd); } catch (e) { return { ok: false, msg: e.message }; }
    r = await petCall('POST', '/control/launch', { cwd, prompt: d.prompt, tool: d.tool === 'codex' ? 'codex' : 'claude', api: d.tool === 'codex' ? undefined : api || undefined });
  } else if (d.t === 'resume' && typeof d.id === 'string' && /^(codex:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id)) {
    // a past conversation of this machine opened again: the folder is the one its own transcript says it was in last
    const f = sessionFile(d.id);
    const cwd = !f ? '' : f.codex ? f.cwd || '' : records.lastCwd(f.file);   // (where it was last, not where it began; Codex: its folder)
    if (!cwd) return { ok: false, msg: '这台电脑上找不到这个会话的记录' };
    r = await petCall('POST', '/control/launch', { cwd, resume: d.id, api: d.id.startsWith('codex:') ? undefined : api || undefined });
  } else if (d.t === 'decide' && typeof d.id === 'string' && typeof d.perm === 'string' && ['allow', 'always', 'deny', 'defer', 'answer', 'chat'].includes(d.choice)) {
    r = await petCall('POST', '/control/decide', { session: d.id, id: d.perm, choice: d.choice, answers: d.choice === 'answer' ? d.answers : undefined });
  } else return { ok: false, msg: '无效请求' };
  if (!r) return { ok: false, msg: '本机糖糖没在运行，没法操作' };
  if (r.ok === false && !petAllows) return { ok: false, msg: '糖糖菜单里没勾「允许远程控制」' };
  setTimeout(() => tick(true), 300);
  // a Shift+Tab reports the permission mode it switched to
  return { ok: !!r.ok, msg: typeof r.msg === 'string' ? r.msg.slice(0, 200) : '', mode: typeof r.mode === 'string' ? r.mode : undefined,
    screen: typeof r.screen === 'string' ? r.screen.slice(0, 9000) : undefined };
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
      via: p ? p.via : 'off', perms: p ? p.perms : [], bg: !!(p && p.bg) || line.bg.has(id), agents: safeAgents(c.file),
      api: p && typeof p.api === 'string' ? p.api : undefined };
  });
  // sessions the pet knows but that have no transcript here (Codex, or a Claude session not written yet)
  for (const [id, p] of pet) {
    if (sess.has(id) || line.parked.has(id)) continue;
    out.push({ id, label: codexSess.get(id)?.title || p.label || (id.startsWith('codex:') ? 'Codex' : 'Claude'), project: p.project || '', state: p.state, steps: 0, t0: p.t0, last: p.last,
      lines: (p.lines || []).map((l) => ({ text: l.text, t: l.t, type: l.type })), via: p.via, perms: p.perms || [], agents: codexAgentRows.get(id) || [],
      api: typeof p.api === 'string' ? p.api : undefined });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
// the subagents this session started (subagents.js), for the dashboard
function safeAgents(file) { try { return agentsOf(file); } catch { return []; } }
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
// record streaming: per session a reader at the offset the server has stored (null until the server's "sync")
let serverOff = null;
const readers = new Map();
const metaSent = new Set();                          // sessions whose working directory was reported on this connection
function connect() {
  ws = new WebSocket(cfg.server, { headers: { Authorization: 'Bearer ' + cfg.token } });
  ws.on('open', () => {
    retry = 2000;
    console.log(`已连接看板服务器，机器名「${NAME}」`);
    ws.send(JSON.stringify({ t: 'hello', machine: NAME, control: controlOn(), files: browse.enabled, upload: browse.canUpload }));
    sendCommands(true);
    lastConv.clear(); btwSent.clear();
    serverOff = null; readers.clear(); metaSent.clear(); archive.reset();   // wait for the server's offsets before streaming
    tick(true);
  });
  ws.on('message', (raw) => {
    // honoured from the server: a request to read a conversation, and (only with "control": true) send / decide
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.t === 'want-conv' && typeof d.id === 'string') sendConv(d.id);
    else if (d.t === 'sync' && d.offsets && typeof d.offsets === 'object') {
      // where the server stands per session: (re)start streaming there
      serverOff = serverOff || {};
      for (const [id, off] of Object.entries(d.offsets)) {
        if (!Number.isFinite(off) || off < 0) continue;
        serverOff[id] = off;
        const r = readers.get(id); if (r) { r.offset = off; r.skipping = false; }
      }
      // sessions the server stores but nobody is streaming right now (long idle): still tell it where they live,
      // so the dashboard can say how to resume them -- once per connection
      const files = new Map(newestFiles().map((f) => [f.id, f.file]));
      const cfiles = new Map();
      if (Object.keys(d.offsets).some((id) => id.startsWith('codex:'))) {
        for (const file of codex.allFiles()) { const m = codexMeta.get(file) || codex.metaOf(file); if (m && !m.sub) cfiles.set('codex:' + m.id, m); }
      }
      for (const id of Object.keys(d.offsets)) {
        if (metaSent.has(id) || readers.has(id) || (!files.has(id) && !cfiles.has(id))) continue;
        metaSent.add(id);
        const cwd = files.has(id) ? records.firstCwd(files.get(id)) : cfiles.get(id).cwd;
        if (cwd) { const p = pet.get(id); sendJSON({ t: 'meta', id, cwd, api: p && p.api }); }
      }
      pushRecords();
    }
    else if (typeof d.t === 'string' && d.t.startsWith('fs')) fsServe.handle(d);
    // a new daily report: its note goes to the local pet for the morning bubble (information, not remote control)
    else if (d.t === 'report-note' && typeof d.date === 'string') petCall('POST', '/control/report', d);
    // a new mail the NAS found something in: the pet's bubble (information too)
    else if (d.t === 'mail-alert' && d.alert && typeof d.alert.id === 'string') petCall('POST', '/control/mail', d.alert);
    // a session renamed (the server tells every machine): this one's pet shows the new name at once
    else if (d.t === 'title' && d.machine === NAME && typeof d.id === 'string' && typeof d.title === 'string') petCall('POST', '/control/title', { id: d.id, title: d.title });
    else if (d.t === 'claude-apis') {
      if (!CONTROL) return;                                  // read-only machine: no remote config, no wrappers
      try { const r = claudeApis.sync(d); if (r && r.ok === false) console.error('别名同步失败：' + r.msg); }
      catch (e) { console.error('别名同步失败：' + e.message); }
    }
    else if (d.t === 'read-claude-settings' && typeof d.rid === 'string') {
      const r = CONTROL ? claudeApis.readSettings() : { ok: false, msg: '这台机器没开远程控制' };
      sendJSON({ t: 'claude-settings', rid: d.rid, ...r });
    }
    else if (d.t === 'backup-claude-settings' && typeof d.rid === 'string') {
      const r = CONTROL ? claudeApis.backupSettings() : { ok: false, msg: '这台机器没开远程控制' };
      sendJSON({ t: 'claude-settings-backup', rid: d.rid, ...r });
    }
    else if (d.t === 'art-check' && typeof d.rid === 'string') {
      if (cfg.artifacts === false) sendJSON({ t: 'art-res', rid: d.rid, items: [], off: true });
      else artifacts.handle(d).catch(() => sendJSON({ t: 'art-res', rid: d.rid, items: [], error: true }));
    }
    else if ((d.t === 'send' || d.t === 'key' || d.t === 'screen' || d.t === 'decide' || d.t === 'launch' || d.t === 'resume') && typeof d.rid === 'string') {
      control(d).then((r) => sendJSON({ t: 'result', rid: d.rid, ...r }));
    }
  });
  ws.on('close', () => { ws = null; fsServe.stopAll(); setTimeout(connect, retry); retry = Math.min(30000, retry * 1.5); });
  ws.on('error', () => { try { ws.close(); } catch {} });
}
function sendJSON(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }

// new transcript lines of every tracked session, as slim records (a few batches per session per tick)
function pushRecords() {
  if (!serverOff || !ws || ws.readyState !== 1) return;
  archive.scan();
  for (const id of [...readers.keys()]) if (!sess.has(id) && !codexSess.has(id) && !archive.map.has(id)) readers.delete(id);
  // (a terminal parked on a background session: what it still writes is that session's, already sent as such)
  const old = [...archive.map].filter(([id]) => !sess.has(id) && !codexSess.has(id) && !line.parked.has(id));
  for (const [id, c] of [...sess, ...codexSess, ...old]) {
    let r = readers.get(id);
    if (!r || r.file !== c.file) {
      const isCodex = id.startsWith('codex:');
      r = records.createReader(c.file, serverOff[id] || 0, isCodex ? codex.recordsOf : undefined); readers.set(id, r);
      if (isCodex) r.cwd = c.cwd || null;
      // what the server needs to list the session and say how to resume it, even if nothing new gets written
      sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (pet.get(id) || {}).api });
      r.sentTitle = c.title || '';
    }
    if (id.startsWith('codex:') && r.sentTitle !== (c.title || '')) {
      sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (pet.get(id) || {}).api });
      r.sentTitle = c.title || '';
    }
    for (let k = 0; k < 8; k++) {
      if (ws.bufferedAmount > 8e6) return;                             // let the socket drain first
      let b; try { b = records.readNext(r); } catch { b = null; }
      if (!b) { if (archive.map.has(id) && !sess.has(id) && !codexSess.has(id)) { archive.done(id); readers.delete(id); } break; }
      sendJSON({ t: 'rec', id, from: b.from, to: b.to, reset: b.reset || undefined, recs: b.recs,
        project: c.project || '', title: c.title || '', cwd: b.cwd || undefined });
      r.offset = b.to;
      if (b.to === b.from) break;
    }
  }
}
function sendConv(id) { sendJSON({ t: 'conv', id, msgs: convOf(id) }); }

// /btw asked from the dashboard or the panel: Claude Code shows the answer only on its screen, where the pet reads it
// (app/btw-panel.js) and lists it with the session. The question, then the answer, go to the server once each
// (again after a reconnect: the server keeps each once).
const btwSent = new Set();
function forwardBtw() {
  if (!ws || ws.readyState !== 1) return;
  const live = new Set();
  for (const [id, p] of pet) {
    if (!Array.isArray(p.btw)) continue;
    for (const b of p.btw) {
      if (!b || typeof b.k !== 'string' || typeof b.q !== 'string' || !Number.isFinite(b.t)) continue;
      const k = `${id}|${b.k}`, ka = k + '|a';
      live.add(k); live.add(ka);
      const q = b.q.slice(0, 2000), a = typeof b.a === 'string' ? b.a.slice(0, 100e3) : null;
      if (!btwSent.has(k)) { btwSent.add(k); sendJSON({ t: 'btw', id, k: b.k.slice(0, 40), q, at: b.t }); }
      if (a && !btwSent.has(ka)) { btwSent.add(ka); sendJSON({ t: 'btw', id, k: b.k.slice(0, 40), q, at: b.t, a, ta: Number.isFinite(b.ta) ? b.ta : Date.now() }); }
    }
  }
  for (const k of btwSent) if (!live.has(k)) btwSent.delete(k);
}

// this machine's own slash commands, skills and plugin commands (commands.js) for the dashboard's suggestions:
// on connecting, then whenever a look every 10 minutes finds them changed
let cmdsSig = '';
function sendCommands(force) {
  let list = [], codexList = [];
  try { list = commands.scan(os.homedir()); codexList = commands.scanCodex(os.homedir()); } catch {}
  const sig = JSON.stringify([list, codexList]);
  if (!force && sig === cmdsSig) return;
  cmdsSig = sig;
  sendJSON({ t: 'cmds', list });
  sendJSON({ t: 'cmds', provider: 'codex', list: codexList });
}
setInterval(() => sendCommands(false), 10 * 60e3).unref();

// push the session list on a change, and each conversation whose content moved
const lastConv = new Map();
let lastSig = '', ticking = false;
const tailT = (s) => (s.lines.length ? s.lines[s.lines.length - 1].t : 0);
async function tick(force) {
  if (ticking) return;
  ticking = true;
  try {
    await pollPet();
    forwardBtw();
    scan();
    const list = stateList();
    const sig = JSON.stringify([controlOn(), [...line.parked], ...list.map((s) => [s.id, s.label, s.state, s.last, s.via, s.perms.map((p) => p.id), tailT(s), (s.agents || []).map((a) => a.id + a.state + (a.act || ''))])]);
    if (sig !== lastSig || force === true) {
      lastSig = sig;
      sendJSON({ t: 'state', control: controlOn(), files: browse.enabled, upload: browse.canUpload, sessions: list, parked: [...line.parked] });
      for (const s of list) {
        if (sess.has(s.id)) continue;                // transcript sessions: the server builds them from the records
        const cs = `${s.last}|${tailT(s)}`;
        if (lastConv.get(s.id) !== cs) { lastConv.set(s.id, cs); sendConv(s.id); }
      }
    }
    pushRecords();                                   // every tick: a backlog (a long history) goes out over several
  } finally { ticking = false; }
}
setInterval(tick, SCAN_MS);
connect();
console.log(`Ame 看板 agent 启动，扫描 ${PROJECTS}；文件浏览：${browse.enabled ? '开' : '关'}；远程控制：${CONTROL ? `开（经本机糖糖 127.0.0.1:${PET_PORT}，糖糖菜单里还要勾「允许远程控制」）` : '关'}`);
