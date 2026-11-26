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
const child_process = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const transcript = require('../../app/transcript');
const { lineage } = require('../../app/running-sessions');
const records = require('./records');
const commands = require('./commands');
const codex = require('../../app/codex-records');
const opencode = require('../../app/opencode-records');
const agy = require('../../app/agy-records');
const kiro = require('../../app/kiro-records');
const { aiOf } = require('../../app/ai-providers');
const { createFiles } = require('./files');
const { createProfiles } = require('./claude-profiles');
const claudeProfiles = createProfiles();
const { createFsServe } = require('./fs-serve');
const { createArchive } = require('./archive');
const { createNativeArchive } = require('./native-archive');
const { createMemorySync } = require('./memory-sync');
const { createOpenCodeExport } = require('./opencode-export');
const { createArtifacts } = require('./artifacts');
const { createFleet } = require('./fleet');
const { createAgentConfig } = require('./agent-config');
const { createHarness } = require('./harness');
const { agentsOf } = require('./subagents');
const codexAgents = require('./codex-subagents');
const agyAgents = require('./agy-subagents');
const opencodeAgents = require('./opencode-subagents');
const { probeCompute } = require('./compute-probe');
const { findColabBin, probeColabUsage, runColabJob } = require('./colab-runner');
const { loadSugonConfig, probeSugonStatus, scanSugonFailures, runSugonJob } = require('./sugon-runner');
const { readCodexRateLimits } = require('./codex-quota');
const { createCollector, stateSignature } = require('./infra-probe');
const infraCollector = createCollector({ isNas: false });
let infraIntervalMs = 60000, infraWatched = [], infraTargets = [], lastInfraAt = 0, lastInfraSig = '', infraBusy = false;
async function pushInfra(force = false) {
  if (infraBusy || !ws || ws.readyState !== 1) return;
  infraBusy = true;
  try {
    const rep = await infraCollector.collect({ watched: infraWatched, probeTargets: infraTargets });
    const sig = stateSignature(rep);
    const now = Date.now();
    if (force || sig !== lastInfraSig || now - lastInfraAt >= infraIntervalMs) {
      lastInfraSig = sig;
      lastInfraAt = now;
      sendJSON({ t: 'infra', report: rep });
    }
  } catch {} finally { infraBusy = false; }
}
setInterval(() => pushInfra(false), 10000).unref();

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
if (CONTROL) { try { claudeProfiles.install(); } catch (e) { console.error('启动入口检查失败：' + e.message); } }
const profileView = () => CONTROL ? claudeProfiles.list() : { profiles: [], aliases: [] };
// file browsing for the dashboard (agent.json "files": { roots, exclude }); off unless configured; uploads into those
// folders only with "upload": true there (fs-upload.js)
const browse = createFiles(cfg.files);
const nativeArchive=createNativeArchive({send:sendJSON,enabled:cfg.fullArchive!==false,log:console.error});
const openCodeExport=createOpenCodeExport({log:console.error});
const memorySync=createMemorySync({name:NAME,send:sendJSON,folder:p=>browse.writableFolder(p),
  canWrite:()=>CONTROL&&cfg.memory!==false,confirmedDir:cfg.memory&&cfg.memory.confirmedDir||'',
  enabled:cfg.memory!==false,autoApply:!(cfg.memory&&cfg.memory.autoApply===false)});
const fsServe = createFsServe(browse, (o) => sendJSON(o), { sessionFile: (id) => sessionFile(id) });
// 设备更新 and 一键配置 (fleet.js, agent-config.js): this copy's version on every connection; updates and config
// writes only with "control": true
const fleet = createFleet({ cfg, log: console.error });
const agentConfig = createAgentConfig();
// the coding agents installed here (harness.js), with the version: installed / updated from the dashboard
const harness = createHarness();
// (the harnesses are looked up a while after start, not while the connection and the first pet calls are being set up:
// on Windows a socket opened while a child process is started there could hang -- the first pet poll did, in e2e)
// the way out found here (harness.js detectNet): after the harnesses, then every 12 hours and when asked
let harnessList = null, harnessTimer = null, netFound = null, netBusy = null;
const netView = (n) => n && { at: n.at, needProxy: n.needProxy, recommended: n.recommended, recommendedSource: n.recommendedSource,
  direct: { reach: n.direct.reach }, routes: n.routes.map(({ url, source, reach, ms }) => ({ url, source, reach, ms })) };
function lookForWayOut() {
  if (process.env.AME_NO_NET_PROBE) return Promise.resolve(null);       // (tests: no requests to the outside)
  if (!netBusy) netBusy = harness.detectNet().then((n) => { netFound = n; return n; }, (e) => { console.error('网络检测失败：' + e.message); return null; })
    .finally(() => { netBusy = null; });
  return netBusy;
}
function sendFleetVersion() {
  fleet.version()
    .then((v) => sendJSON({ t: 'fleet-version', ...v, control: CONTROL, magpieKey: agentConfig.keyInfo() || undefined,
      harnesses: harnessList || undefined, proxy: agentConfig.net().proxy || undefined, net: netView(netFound) || undefined }))
    .catch((e) => console.error('版本信息读取失败：' + e.message));
  if (!harnessList && !harnessTimer) {
    harnessTimer = setTimeout(() => harness.inventory().then((l) => { harnessList = l; sendFleetVersion(); }, () => {})
      .then(() => CONTROL && lookForWayOut().then((n) => n && sendFleetVersion())), +process.env.AME_HARNESS_DELAY_MS || 20e3);
    harnessTimer.unref();
    if (CONTROL) setInterval(() => lookForWayOut().then((n) => n && sendFleetVersion()), 12 * 3600e3).unref();
  }
}
// after an install / update: the list again, then the version message with it
function refreshHarnesses() { harness.inventory({ fresh: true }).then((l) => { harnessList = l; }, () => {}).finally(sendFleetVersion); }
function onFleetMessage(d) {
  const reply = (t, o) => sendJSON({ t, rid: d.rid, ...o });
  if (!CONTROL) return reply(d.t === 'agent-config' ? 'agent-config-result' : d.t === 'harness-run' ? 'harness-result' : d.t === 'harness-net-probe' ? 'harness-net-result' : 'fleet-result', { ok: false, msg: '这台电脑没开远程控制（agent.json "control": true）' });
  if (d.t === 'harness-run') {
    const s = (v) => (typeof v === 'string' ? v : '');
    harness.run(String(d.id || ''), String(d.action || ''), { proxy: s(d.proxy), fallback: s(d.fallback), target: s(d.target) })
      .then((r) => reply('harness-result', r), (e) => reply('harness-result', { ok: false, msg: '出错：' + e.message }))
      .finally(refreshHarnesses);
    return;
  }
  if (d.t === 'harness-net-probe') {
    lookForWayOut().then((n) => { reply('harness-net-result', n ? { ok: true, net: netView(n) } : { ok: false, msg: '检测失败' }); sendFleetVersion(); });
    return;
  }
  if (d.t === 'fleet-check') return reply('fleet-have', { have: fleet.have(d.files) });
  if (d.t === 'fleet-files') {
    try { reply('fleet-ack', { n: fleet.stage(d.run || d.rid, d.items) }); } catch (e) { reply('fleet-result', { ok: false, msg: e.message }); }
    return;
  }
  if (d.t === 'fleet-apply') {
    fleet.apply(d).then((r) => reply('fleet-result', r), (e) => reply('fleet-result', { ok: false, msg: '更新出错：' + e.message }))
      .finally(sendFleetVersion);
    return;
  }
  if (d.t === 'agent-config') {
    let r; try { r = agentConfig.apply(d); } catch (e) { r = { ok: false, msg: e.message }; }
    reply('agent-config-result', r);
    sendFleetVersion();
  }
}
const PET_PORT = +cfg.petPort || 3940;
const PET_TOKEN_FILE = path.join(os.homedir(), '.ametyping', `control-token-${PET_PORT}`);
const MESH_PORT = +process.env.AME_MESH_BRIDGE_PORT || +cfg.meshPort || 3941;
const MESH_TOKEN_FILE = path.join(os.homedir(), '.ametyping', `mesh-token-${MESH_PORT}`);

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
  // OpenCode sessions: the plugin's append-only mirror (app/opencode-records.js); the pet reports their live state
  const oseen = new Set();
  for (const f of opencode.recentFiles(Math.max(IDLE_DROP_MS, 6 * 3600e3))) {
    const m = opencode.metaOf(f.file);
    if (!m) continue;
    const id = 'opencode:' + m.id;
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(id)) continue;
    oseen.add(id);
    opencodeSess.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: opencode.titleOf(m.id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: f.mtime });
  }
  for (const [id] of pet) {                            // still open but quiet longer than the scan window
    if (!id.startsWith('opencode:') || oseen.has(id)) continue;
    const file = opencode.fileOf(id);
    const m = file && opencode.metaOf(file);
    if (!m) continue;
    oseen.add(id);
    opencodeSess.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: opencode.titleOf(id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: Date.now() });
  }
  for (const id of [...opencodeSess.keys()]) if (!oseen.has(id)) opencodeSess.delete(id);
  opencodeAgentRows = opencodeAgents.scan();
  // Antigravity (agy) sessions: brain/<id>/.system_generated/logs/transcript.jsonl
  const aseen = new Set();
  for (const f of agy.recentFiles(Math.max(IDLE_DROP_MS, 6 * 3600e3))) {
    const m = agy.metaOf(f.file);
    if (!m || m.sub) continue;
    const id = 'agy:' + m.id;
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(id)) continue;
    aseen.add(id);
    agySess.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: agy.titleOf(m.id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: f.mtime });
  }
  for (const [id] of pet) {
    if (!id.startsWith('agy:') || aseen.has(id)) continue;
    const file = agy.fileOf(id);
    const m = file && agy.metaOf(file);
    if (!m || m.sub) continue;
    aseen.add(id);
    agySess.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: agy.titleOf(id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: Date.now() });
  }
  for (const id of [...agySess.keys()]) if (!aseen.has(id)) agySess.delete(id);
  agyAgentRows = agyAgents.scan();
  // Kiro CLI sessions: ~/.kiro/sessions/cli/{id}.jsonl + {id}.json; the pet reports their live state
  const kseen = new Set();
  for (const f of kiro.recentFiles(Math.max(IDLE_DROP_MS, 6 * 3600e3))) {
    const m = kiro.metaOf(f.file);
    if (!m || m.sub) continue;                                     // sub-sessions (session_created_reason "subagent") are not roots
    const id = 'kiro:' + m.id;
    if (now - f.mtime > IDLE_DROP_MS && !pet.has(id)) continue;
    kseen.add(id);
    kiroSess.set(id, { file: f.file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: kiro.titleOf(m.id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: f.mtime });
  }
  for (const [id] of pet) {                                        // still open but quiet longer than the scan window
    if (!id.startsWith('kiro:') || kseen.has(id)) continue;
    const file = kiro.fileOf(id);
    const m = file && kiro.metaOf(file);
    if (!m || m.sub) continue;
    kseen.add(id);
    kiroSess.set(id, { file, project: m.cwd ? path.basename(m.cwd) : '', cwd: m.cwd, title: kiro.titleOf(id) || m.title, model: m.model || null, ai: aiOf(m.model), mtime: Date.now() });
  }
  for (const id of [...kiroSess.keys()]) if (!kseen.has(id)) kiroSess.delete(id);
}
const codexSess = new Map();                         // "codex:<thread id>" -> { file, project, cwd, title }
const codexMeta = new Map();                         // rollout file -> { id, cwd, sub }
const opencodeSess = new Map();                      // "opencode:<session id>" -> { file, project, cwd, title }
const agySess = new Map();                           // "agy:<conversation id>" -> { file, project, cwd, title, model, ai }
const kiroSess = new Map();                          // "kiro:<session id>" -> { file, project, cwd, title, model, ai }
let codexAgentRows = new Map();
let agyAgentRows = new Map();
let opencodeAgentRows = new Map();
// older sessions (agent.json "archiveDays", default 30; 0 = off) still streamed until the server has them whole
const archive = createArchive({ days: cfg.archiveDays != null ? +cfg.archiveDays : 30, claudeFiles: newestFiles, codex, opencode, agy, kiro, projectOf,
  live: (id) => sess.has(id) || codexSess.has(id) || opencodeSess.has(id) || agySess.has(id) || kiroSess.has(id), stored: (id) => serverOff && serverOff[id] });
// the transcript of a session id (Claude Code or "codex:<id>"), for checking which files it wrote
function sessionFile(id) {
  if (id.startsWith('opencode:')) {
    const c = opencodeSess.get(id) || archive.map.get(id);
    if (c) return { file: c.file, opencode: true, cwd: c.cwd };
    const file = opencode.fileOf(id);
    const m = file && opencode.metaOf(file);
    return file ? { file, opencode: true, cwd: m && m.cwd } : null;
  }
  if (id.startsWith('agy:')) {
    const c = agySess.get(id) || archive.map.get(id);
    if (c) return { file: c.file, agy: true, cwd: c.cwd };
    const file = agy.fileOf(id);
    const m = file && agy.metaOf(file);
    return file ? { file, agy: true, cwd: m && m.cwd } : null;
  }
  if (id.startsWith('kiro:')) {
    const c = kiroSess.get(id) || archive.map.get(id);
    if (c) return { file: c.file, kiro: true, cwd: c.cwd };
    const file = kiro.fileOf(id);
    const m = file && kiro.metaOf(file);
    return file ? { file, kiro: true, cwd: m && m.cwd } : null;
  }
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
const { createQuotaNotices } = require('./quota-notices');
// Sanitized inbox shared with the local OpenCode TUI. No gateway credentials.
const quotaNotices = createQuotaNotices({ deliver: n => petCall('POST', '/control/quota', n) });
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
const sentCliUpdates = new Map(); // tool -> last reported `at`
let lastProbeAt = 0;
let lastProbeSig = '';
function maybeReportComputeProbe() {
  if (!ws || ws.readyState !== 1) return;
  const now = Date.now();
  if (now - lastProbeAt < 15000) return;
  try {
    const probe = probeCompute();
    const sig = `${probe.hasGpu}|${probe.gpuBusy}|${probe.cpuBusy}`;
    if (sig !== lastProbeSig || now - lastProbeAt >= 60000) {
      lastProbeSig = sig;
      lastProbeAt = now;
      sendJSON({ t: 'compute-probe', probe });
    }
  } catch {}
  pushLocalQuota(now);
  maybeReportColabStatus(now);
  maybeReportSugonStatus(now);
  maybeScanSugonFailures(now);
}

const COLAB_PROBE_INTERVAL_MS = 5 * 60 * 1000;
let lastColabProbeAt = 0;
let colabProbeBusy = false;
function maybeReportColabStatus(now = Date.now(), force = false) {
  if (!ws || ws.readyState !== 1 || colabProbeBusy) return;
  if (!force && lastColabProbeAt && now - lastColabProbeAt < COLAB_PROBE_INTERVAL_MS) return;
  const bin = findColabBin();
  if (!bin) return;
  colabProbeBusy = true;
  lastColabProbeAt = now;
  probeColabUsage(null, { bin })
    .then((status) => {
      if (ws && ws.readyState === 1 && status) {
        sendJSON({ t: 'colab-status', status });
      }
    })
    .catch(() => {})
    .finally(() => { colabProbeBusy = false; });
}

let lastLocalQuotaAt = 0, lastLocalQuotaSig = '';
function pushLocalQuota(now = Date.now()) {
  if (!ws || ws.readyState !== 1) return;
  if (now - lastLocalQuotaAt < 60000) return;
  lastLocalQuotaAt = now;
  try {
    const q = readCodexRateLimits();
    if (!q) return;
    const sig = JSON.stringify(q.windows);
    if (sig !== lastLocalQuotaSig) {
      lastLocalQuotaSig = sig;
      sendJSON({ t: 'local-quota', quota: q });
    }
  } catch {}
}

async function pollPet() {
  const r = CONTROL ? await petCall('GET', '/control/state') : null;
  pet.clear();
  petUp = !!r; petAllows = !!r && r.control !== false;
  if (r && Array.isArray(r.sessions)) for (const s of r.sessions) if (s && typeof s.id === 'string') pet.set(s.id, s);
  if (r && Array.isArray(r.cliUpdates) && ws && ws.readyState === 1) {
    for (const u of r.cliUpdates) {
      if (!u || typeof u.tool !== 'string' || !u.tool) continue;
      const at = Number(u.at) || 0;
      if (sentCliUpdates.get(u.tool) === at) continue;
      sentCliUpdates.set(u.tool, at);
      sendJSON({ t: 'cli-update', tool: u.tool, detail: String(u.detail || '').slice(0, 160), at });
    }
  }
  maybeReportComputeProbe();
}
// the only things the agent does for the server: type a reply, press a navigation key, read the terminal's screen
// (its menus), answer a permission card,
// start Claude Code in a folder (one the file explorer may browse)
// the alias settings the server resolved for this machine (id / label / proxy / settings); bounded and validated
function apiOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const id = /^[A-Za-z0-9._-]{1,40}$/.test(String(v.id || '')) ? String(v.id) : '';
  return id && v.local === true ? { id, local: true } : null;
}

const GIT_EXEC_OPTS = { timeout: 10000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
function execGit(args) {
  return child_process.execFileSync('git', args, GIT_EXEC_OPTS);
}

function createGitWorktree(repoDir, alias = 'worker', requestedBranch = '') {
  if (typeof repoDir !== 'string' || !repoDir.trim()) {
    return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  }
  let repoRoot = '';
  try {
    repoRoot = execGit(['-C', repoDir.trim(), 'rev-parse', '--show-toplevel']).trim();
  } catch {
    return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  }
  if (!repoRoot) return { ok: false, msg: '目标目录不是 Git 仓库，无法创建 worktree' };
  repoRoot = path.resolve(repoRoot);
  const slug = String(alias || 'worker').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'worker';
  const shortId = crypto.randomBytes(3).toString('hex');
  const reqBr = typeof requestedBranch === 'string' ? requestedBranch.trim() : '';
  const branch = (reqBr && /^[A-Za-z0-9._/-]{1,80}$/.test(reqBr) && !reqBr.includes('..') && !reqBr.startsWith('-'))
    ? reqBr
    : `mesh/${slug}-${shortId}`;
  const wtBase = path.join(repoRoot, '.ame-worktrees');
  const wtPath = path.join(wtBase, `${slug}-${shortId}`);
  try {
    fs.mkdirSync(wtBase, { recursive: true });
    execGit(['-C', repoRoot, 'worktree', 'add', '-b', branch, wtPath]);
  } catch (e) {
    const detail = (e && (e.stderr || e.message) ? String(e.stderr || e.message) : '').trim().slice(0, 160);
    return { ok: false, msg: '创建 git worktree 失败' + (detail ? '：' + detail : '') };
  }
  // Link top-level and first-level subpackage node_modules into the worktree so CJS/ESM tests run immediately
  const linkNodeModules = (relDir = '') => {
    try {
      const src = relDir ? path.join(repoRoot, relDir, 'node_modules') : path.join(repoRoot, 'node_modules');
      const dstParent = relDir ? path.join(wtPath, relDir) : wtPath;
      const dst = path.join(dstParent, 'node_modules');
      if (fs.existsSync(src) && fs.statSync(src).isDirectory() && fs.existsSync(dstParent) && !fs.existsSync(dst)) {
        fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch {}
  };
  linkNodeModules('');
  try {
    for (const ent of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.ame-worktrees') continue;
      linkNodeModules(ent.name);
    }
  } catch {}
  return { ok: true, worktreePath: wtPath, worktreeBranch: branch, worktreeParentRepo: repoRoot };
}

function checkGitWorktree(wtPath, parentRepo = '', branch = '') {
  if (typeof wtPath !== 'string' || !wtPath.trim()) {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: '缺少 worktreePath 参数' };
  }
  const target = path.resolve(wtPath.trim());
  try {
    if (!fs.statSync(target).isDirectory()) {
      return { ok: false, dirty: false, unmergedCommits: 0, msg: 'worktree 目录不存在' };
    }
  } catch {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: 'worktree 目录不存在' };
  }
  let statusOut = '';
  try {
    statusOut = execGit(['-C', target, 'status', '--porcelain']);
  } catch {
    return { ok: false, dirty: false, unmergedCommits: 0, msg: '无法读取 worktree git 状态' };
  }
  const changedCount = String(statusOut || '').split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const dirty = changedCount > 0;
  let targetBranch = typeof branch === 'string' ? branch.trim() : '';
  if (!targetBranch) {
    try {
      const b = execGit(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (b && b !== 'HEAD') targetBranch = b;
    } catch {}
  }
  const baseRepo = (typeof parentRepo === 'string' && parentRepo.trim()) ? path.resolve(parentRepo.trim()) : target;
  let unmergedCommits = 0;
  if (targetBranch && /^[A-Za-z0-9._/-]{1,80}$/.test(targetBranch) && !targetBranch.includes('..') && !targetBranch.startsWith('-')) {
    try {
      const cnt = execGit(['-C', baseRepo, 'rev-list', '--count', `HEAD..${targetBranch}`]).trim();
      unmergedCommits = Number.parseInt(cnt, 10) || 0;
    } catch {
      unmergedCommits = 0;
    }
  }
  const msg = dirty || unmergedCommits > 0
    ? `存在 ${changedCount} 处未提交改动、${unmergedCommits} 个未合并提交`
    : 'worktree 干净，无未合并提交';
  return { ok: true, dirty, changedCount, unmergedCommits, msg };
}

function removeGitWorktree(wtPath, parentRepo = '', branch = '', force = false) {
  if (typeof wtPath !== 'string' || !wtPath.trim()) {
    return { ok: false, msg: '缺少 worktreePath 参数' };
  }
  const resolvedWt = path.resolve(wtPath.trim());
  const wtParent = path.dirname(resolvedWt);
  const wtName = path.basename(resolvedWt);
  if (path.basename(wtParent) !== '.ame-worktrees' || !wtName || wtName === '.' || wtName === '..') {
    return { ok: false, msg: '安全拦截：只能清理 .ame-worktrees 目录下的 worktree' };
  }
  const repo = (typeof parentRepo === 'string' && parentRepo.trim())
    ? path.resolve(parentRepo.trim())
    : path.dirname(wtParent);
  if (typeof parentRepo === 'string' && parentRepo.trim()) {
    const expectedBase = path.join(repo, '.ame-worktrees');
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    if (norm(wtParent) !== norm(expectedBase)) {
      return { ok: false, msg: '安全拦截：worktree 不属于指定的父仓库 .ame-worktrees 目录' };
    }
  }
  const chk = checkGitWorktree(resolvedWt, repo, branch);
  if (chk.ok && !force && (chk.dirty || chk.unmergedCommits > 0)) {
    return {
      ok: false,
      dirty: chk.dirty,
      unmergedCommits: chk.unmergedCommits,
      msg: '该 worktree 存在未提交改动或未合并提交，请先合并或显式强制删除',
    };
  }
  const args = ['-C', repo, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(resolvedWt);
  try {
    execGit(args);
  } catch (e) {
    const detail = (e && (e.stderr || e.message) ? String(e.stderr || e.message) : '').trim().slice(0, 160);
    return { ok: false, msg: '清理 worktree 失败' + (detail ? '：' + detail : '') };
  }
  return { ok: true, msg: '已清理 worktree' };
}

async function control(d) {
  if (!CONTROL) return { ok: false, msg: '这台机器没开远程控制（agent.json 里设 "control": true）' };
  const api = apiOf(d.api);
  if (d.api && !api && d.tool !== 'codex' && d.tool !== 'agy' && d.tool !== 'kiro' && !/^(codex|agy|kiro):/.test(String(d.id || ''))) return { ok: false, msg: '启动入口格式已更新，请刷新看板后再试' };
  let r;
  let wtMeta = null;
  let gitBaseline = null;
  if (d.t === 'send' && typeof d.id === 'string' && typeof d.text === 'string' && d.text.trim() && d.text.length <= 8000) {
    r = await petCall('POST', '/control/send', { id: d.id, text: d.text });
  } else if (d.t === 'key' && typeof d.id === 'string' && typeof d.key === 'string' && /^(up|down|left|right|enter|esc|tab|btab|bksp|ctrlxs|ctrl[abe-y]|btwfork|c:[^\x00-\x1f\x7f]{1,200})$/.test(d.key)) {
    r = await petCall('POST', '/control/key', { id: d.id, key: d.key, screen: d.screen === true, hl: d.hl === true });
  } else if (d.t === 'screen' && typeof d.id === 'string') {
    r = await petCall('POST', '/control/screen', { id: d.id, hl: d.hl === true });
  } else if (d.t === 'launch' && typeof d.cwd === 'string' && typeof d.prompt === 'string' && d.prompt.length <= 8000) {
    if (!browse.enabled) return { ok: false, msg: '这台电脑没开放文件浏览' };
    let cwd; try { cwd = await browse.folder(d.cwd); } catch (e) { return { ok: false, msg: e.message }; }
    if (d.workspaceMode === 'worktree') {
      const wt = createGitWorktree(cwd, d.worktreeAlias || 'worker', d.worktreeBranch || '');
      if (!wt.ok) return { ok: false, msg: wt.msg };
      cwd = wt.worktreePath;
      wtMeta = {
        worktreePath: wt.worktreePath,
        worktreeBranch: wt.worktreeBranch,
        worktreeParentRepo: wt.worktreeParentRepo,
      };
    }
    gitBaseline = collectGitAudit(cwd);
    let meshEnv;
    if (d.meshEnv && typeof d.meshEnv === 'object' && !Array.isArray(d.meshEnv)) {
      const cleanEnv = {};
      if (typeof d.meshEnv.AME_PROJECT_ID === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(d.meshEnv.AME_PROJECT_ID)) {
        cleanEnv.AME_PROJECT_ID = d.meshEnv.AME_PROJECT_ID;
      }
      if (typeof d.meshEnv.AME_NODE_ID === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(d.meshEnv.AME_NODE_ID)) {
        cleanEnv.AME_NODE_ID = d.meshEnv.AME_NODE_ID;
      }
      if (Object.keys(cleanEnv).length > 0) meshEnv = cleanEnv;
    }
    const tool = ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? d.tool : 'claude';
    const model = typeof d.model === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(d.model.trim()) ? d.model.trim() : undefined;
    r = await petCall('POST', '/control/launch', {
      cwd,
      prompt: d.prompt,
      tool,
      ...(model ? { model } : {}),
      api: ['codex', 'opencode', 'agy', 'kiro'].includes(d.tool) ? undefined : api || undefined,
      ...(meshEnv ? { meshEnv } : {}),
    });
  } else if (d.t === 'resume' && typeof d.id === 'string' && (/^opencode:ses_[A-Za-z0-9]{6,80}$/.test(d.id) || /^(codex:|agy:|kiro:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id))) {
    // a past conversation of this machine opened again: the folder is the one its own transcript says it was in last
    const f = sessionFile(d.id);
    const cwd = !f ? '' : (f.codex || f.opencode || f.agy || f.kiro) ? f.cwd || '' : records.lastCwd(f.file);   // (where it was last, not where it began; Codex/Kiro: its folder)
    if (!cwd) return { ok: false, msg: '这台电脑上找不到这个会话的记录' };
    r = await petCall('POST', '/control/launch', { cwd, resume: d.id, api: /^(codex|opencode|agy|kiro):/.test(d.id) ? undefined : api || undefined });
  } else if (d.t === 'decide' && typeof d.id === 'string' && typeof d.perm === 'string' && ['allow', 'always', 'deny', 'defer', 'answer', 'chat'].includes(d.choice)) {
    r = await petCall('POST', '/control/decide', { session: d.id, id: d.perm, choice: d.choice, answers: d.choice === 'answer' ? d.answers : undefined });
  } else if (d.t === 'worktree-check') {
    if (typeof d.worktreePath !== 'string' || !d.worktreePath.trim()) return { ok: false, msg: '缺少 worktreePath 参数' };
    return checkGitWorktree(d.worktreePath, d.worktreeParentRepo || d.parentRepo || '', d.worktreeBranch || d.branch || '');
  } else if (d.t === 'worktree-remove') {
    if (typeof d.worktreePath !== 'string' || !d.worktreePath.trim()) return { ok: false, msg: '缺少 worktreePath 参数' };
    return removeGitWorktree(d.worktreePath, d.worktreeParentRepo || d.parentRepo || '', d.worktreeBranch || d.branch || '', d.force === true);
  } else return { ok: false, msg: '无效请求' };
  if (!r) return { ok: false, msg: '本机糖糖没在运行，没法操作' };
  if (r.ok === false && !petAllows) return { ok: false, msg: '糖糖菜单里没勾「允许远程控制」' };
  setTimeout(() => tick(true), 300);
  // a Shift+Tab reports the permission mode it switched to
  return { ok: !!r.ok, msg: typeof r.msg === 'string' ? r.msg.slice(0, 200) : '', mode: typeof r.mode === 'string' ? r.mode : undefined,
    screen: typeof r.screen === 'string' ? r.screen.slice(0, 9000) : undefined,
    ...(r.ok && wtMeta ? wtMeta : {}),
    ...(r.ok && gitBaseline && gitBaseline.isGit ? { gitBaseline } : {}) };
}

// ---------- shape for the server ----------
const lineOf = (m) => ({ text: m.role === 'tool' ? '⚙ ' + (m.items || []).slice(-1)[0] : (m.text || '').slice(0, 200), t: m.t, type: m.role });
const tailCache = new Map();                         // file -> { sig, state, lines, last }
const TAIL_WORK_STALE_MS = 10 * 60e3;
function tailState(file, parseFn, fallbackMtime) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'idle', lines: [], last: fallbackMtime }; }
  const stale = Date.now() - st.mtimeMs > TAIL_WORK_STALE_MS;
  const sig = `${st.size}|${st.mtimeMs}|${stale ? 1 : 0}`;
  const hit = tailCache.get(file);
  if (hit && hit.sig === sig) return hit;
  const msgs = [];
  try {
    const from = Math.max(0, st.size - 131072);
    const buf = Buffer.alloc(st.size - from);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
    const rawLines = buf.toString('utf8').split('\n');
    if (from > 0) rawLines.shift();
    for (const l of rawLines) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      for (const r of parseFn(o) || []) {
        if (!r || r.role === 'title' || r.role === 'mode' || r.role === 'ctx') continue;
        msgs.push(r);
      }
    }
  } catch {}
  let state = deriveState({ msgs });
  if (state === 'working' && stale) state = 'idle';
  const lines = msgs.slice(-8).map(lineOf).filter((l) => l.text);
  const last = msgs.length && Number.isFinite(msgs[msgs.length - 1].t) ? Math.max(st.mtimeMs, msgs[msgs.length - 1].t) : st.mtimeMs;
  const out = { sig, state, lines, last };
  tailCache.set(file, out);
  if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value);
  return out;
}
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
    const oc = opencodeSess.get(id), ag = agySess.get(id), ki = kiroSess.get(id);
    out.push({ id, label: codexSess.get(id)?.title || ag?.title || ki?.title || p.label || (id.startsWith('codex:') ? 'Codex' : id.startsWith('opencode:') ? 'OpenCode' : id.startsWith('agy:') ? 'Antigravity' : id.startsWith('kiro:') ? 'Kiro' : 'Claude'), project: p.project || (ag && ag.project) || (ki && ki.project) || '', state: p.state, steps: 0, t0: p.t0, last: p.last,
      lines: (p.lines || []).map((l) => ({ text: l.text, t: l.t, type: l.type })), via: p.via, perms: p.perms || [], agents: codexAgentRows.get(id) || agyAgentRows.get(id) || opencodeAgentRows.get(id) || [],
      api: typeof p.api === 'string' ? p.api : undefined, model: p.model || (oc && oc.model) || (ag && ag.model) || (ki && ki.model) || undefined, ai: p.ai || (oc && oc.ai) || (ag && ag.ai) || (ki && ki.ai) || undefined });
  }
  // OpenCode / Antigravity sessions the pet has not reported (the pet restarted, IDE session, or idle): still list their transcript
  for (const [id, c] of opencodeSess) {
    if (pet.has(id) || line.parked.has(id)) continue;
    const ts = tailState(c.file, opencode.recordsOf, c.mtime);
    out.push({ id, label: c.title || c.project || 'OpenCode', project: c.project || '', state: ts.state, steps: 0,
      t0: c.mtime, last: ts.last, lines: ts.lines, via: 'off', perms: [], agents: opencodeAgentRows.get(id) || [], model: c.model || undefined, ai: c.ai || undefined });
  }
  for (const [id, c] of agySess) {
    if (pet.has(id) || line.parked.has(id)) continue;
    const ts = tailState(c.file, agy.recordsOf, c.mtime);
    out.push({ id, label: c.title || c.project || 'Antigravity', project: c.project || '', state: ts.state, steps: 0,
      t0: c.mtime, last: ts.last, lines: ts.lines, via: 'off', perms: [], agents: agyAgentRows.get(id) || [], model: c.model || undefined, ai: c.ai || undefined });
  }
  for (const [id, c] of kiroSess) {
    if (pet.has(id) || line.parked.has(id)) continue;
    out.push({ id, label: c.title || c.project || 'Kiro', project: c.project || '', state: 'idle', steps: 0,
      t0: c.mtime, last: c.mtime, lines: [], via: 'off', perms: [], agents: [], model: c.model || undefined, ai: c.ai || undefined });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
// the subagents this session started (subagents.js), for the dashboard
function safeAgents(file) { try { return agentsOf(file); } catch { return []; } }
function convOf(id) {
  const c = sess.get(id);
  if (!c) {                                          // pet-only session: its progress lines are all there is
    const p = pet.get(id);
    return p ? [{ role: 'sys', text: p.provider === 'codex' ? 'Codex 实时进度 · 对话请回到 Codex' : p.provider === 'opencode' ? 'OpenCode 实时进度 · 对话见记录' : p.provider === 'agy' ? 'Antigravity 实时进度 · 对话见记录' : p.provider === 'kiro' ? 'Kiro 实时进度 · 对话见记录' : '实时进度', t: p.t0 },
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
  const socket = ws = new WebSocket(cfg.server, { headers: { Authorization: 'Bearer ' + cfg.token } });
  socket.on('open', () => {
    if (socket !== ws) return;
    retry = 2000;
    console.log(`已连接看板服务器，机器名「${NAME}」`);
    socket.send(JSON.stringify({ t: 'hello', machine: NAME, control: controlOn(), claudeProfilesVersion: 1,
      vaultVersion:cfg.fullArchive===false?0:1,memoryVersion:1,memoryAllowed:CONTROL&&cfg.memory!==false,
      claudeProfilesAllowed: CONTROL, claudeProfiles: profileView(), files: browse.enabled, upload: browse.canUpload }));
    sendCommands(true);
    sendFleetVersion();
    lastConv.clear(); btwSent.clear();
    serverOff = null; readers.clear(); metaSent.clear(); archive.reset();   // wait for the server's offsets before streaming
    nativeArchive.ready();memorySync.reset();
    tick(true);
    pushInfra(true);
    flushPendingMeshEvents();
    sendMcpStatus();
  });
  socket.on('message', (raw) => {
    if (socket !== ws) return;
    // honoured from the server: a request to read a conversation, and (only with "control": true) send / decide
    let d; try { d = JSON.parse(raw); } catch { return; }
    if(nativeArchive.handle(d))return;
    if(d.t==='memory-bundle'){memorySync.handle(d).catch(e=>console.error('记忆同步失败：'+e.message));return;}
    if (d.t === 'want-conv' && typeof d.id === 'string') sendConv(d.id);
    else if ((d.t === 'fleet-check' || d.t === 'fleet-files' || d.t === 'fleet-apply' || d.t === 'agent-config' || d.t === 'harness-run' || d.t === 'harness-net-probe') && typeof d.rid === 'string') onFleetMessage(d);
    else if (d.t === 'sync' && d.offsets && typeof d.offsets === 'object') {
      fleet.markHealthy();                             // (this agent reached the server: an update's guard stops waiting)
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
      const afiles = new Map();
      if (Object.keys(d.offsets).some((id) => id.startsWith('agy:'))) {
        for (const f of agy.allFiles()) { const file = typeof f === 'string' ? f : f.file; const m = agy.metaOf(file); if (m && !m.sub) afiles.set('agy:' + m.id, m); }
      }
      const kfiles = new Map();
      if (Object.keys(d.offsets).some((id) => id.startsWith('kiro:'))) {
        for (const f of kiro.allFiles()) { const file = typeof f === 'string' ? f : f.file; const m = kiro.metaOf(file); if (m && !m.sub) kfiles.set('kiro:' + m.id, m); }
      }
      for (const id of Object.keys(d.offsets)) {
        if (metaSent.has(id) || readers.has(id) || (!files.has(id) && !cfiles.has(id) && !afiles.has(id) && !kfiles.has(id))) continue;
        metaSent.add(id);
        const cwd = files.has(id) ? records.firstCwd(files.get(id)) : cfiles.has(id) ? cfiles.get(id).cwd : afiles.has(id) ? afiles.get(id).cwd : kfiles.get(id).cwd;
        if (cwd) { const p = pet.get(id); sendJSON({ t: 'meta', id, cwd, api: p && p.api }); }
      }
      pushRecords();
    }
    else if (typeof d.t === 'string' && d.t.startsWith('fs')) fsServe.handle(d);
    // a new daily report: its note goes to the local pet for the morning bubble (information, not remote control)
    else if (d.t === 'report-note' && typeof d.date === 'string') petCall('POST', '/control/report', d);
    // a new mail the NAS found something in: the pet's bubble (information too)
    else if (d.t === 'quota-alert') quotaNotices.add(d.notice);
    else if (d.t === 'mail-alert' && d.alert && typeof d.alert.id === 'string') petCall('POST', '/control/mail', d.alert);
    // a session renamed (the server tells every machine): this one's pet shows the new name at once
    else if (d.t === 'title' && d.machine === NAME && typeof d.id === 'string' && typeof d.title === 'string') petCall('POST', '/control/title', { id: d.id, title: d.title });
    else if (d.t === 'claude-profiles-request' && typeof d.rid === 'string') {
      let r = { ok: false, msg: '这台电脑没开放配置管理' };
      if (CONTROL) {
        try {
          r = d.action === 'list' ? { ok: true } : d.action === 'save'
            ? claudeProfiles.save(d.profile || {}) : { ok: false, msg: '不支持的配置操作' };
          if (r.ok) r.view = profileView();
        } catch { r = { ok: false, msg: '读取本地启动入口失败，请检查 cc-environments 文件' }; }
      }
      try { socket.send(JSON.stringify({ t: 'claude-profiles-result', rid: d.rid, ...r })); } catch {}
    }
    else if (d.t === 'art-check' && typeof d.rid === 'string') {
      if (cfg.artifacts === false) sendJSON({ t: 'art-res', rid: d.rid, items: [], off: true });
      else artifacts.handle(d).catch(() => sendJSON({ t: 'art-res', rid: d.rid, items: [], error: true }));
    }
    else if (d.t === 'mesh-res' && typeof d.rid === 'string') {
      const f = meshPending.get(d.rid);
      if (f) { meshPending.delete(d.rid); f(d); }
    }
    else if ((d.t === 'mcp-res' || d.t === 'mcp-chunk') && typeof d.rid === 'string') mcpFromServer(d);
    else if (d.t === 'mesh-triggers' && Array.isArray(d.triggers)) {
      updateMeshFolderTriggers(d.triggers);
    }
    else if (d.t === 'infra-cfg') {
      if (Number.isFinite(+d.intervalSec) && +d.intervalSec >= 5) infraIntervalMs = +d.intervalSec * 1000;
      if (Array.isArray(d.watched)) infraWatched = d.watched;
      if (Array.isArray(d.probeTargets)) infraTargets = d.probeTargets;
      if (d.collectNow) pushInfra(true);
    }
    else if (d.t === 'infra-ctl' && typeof d.rid === 'string') {
      if (!controlOn()) sendJSON({ t: 'infra-ctl-res', rid: d.rid, ok: false, msg: '这台电脑没开远程控制' });
      else infraCollector.executeControl(d).then(async (r) => {
        const rep = await infraCollector.collect({ watched: infraWatched, probeTargets: infraTargets }).catch(() => null);
        sendJSON({ t: 'infra-ctl-res', rid: d.rid, ...r, report: rep || undefined });
      });
    }
    else if (d.t === 'compute-exec' && typeof d.jobId === 'string') {
      runRemoteCompute(d);
    }
    else if (d.t === 'compute-kill' && typeof d.jobId === 'string') {
      killRemoteCompute(d.jobId);
    }
    else if (d.t === 'colab-exec' && typeof d.jobId === 'string') {
      runRemoteColab(d);
    }
    else if (d.t === 'colab-kill' && typeof d.jobId === 'string') {
      killRemoteColab(d.jobId);
    }
    else if (d.t === 'sugon-exec' && typeof d.jobId === 'string') {
      runRemoteSugon(d);
    }
    else if (d.t === 'sugon-kill' && typeof d.jobId === 'string') {
      killRemoteSugon(d.jobId);
    }
    else if ((d.t === 'send' || d.t === 'key' || d.t === 'screen' || d.t === 'decide' || d.t === 'launch' || d.t === 'resume' || d.t === 'worktree-check' || d.t === 'worktree-remove') && typeof d.rid === 'string') {
      control(d).then((r) => sendJSON({ t: 'result', rid: d.rid, ...r }));
    }
  });
  socket.on('close', () => { if (socket !== ws) return; ws = null; for (const p of [...mcpPending.values()]) p.done({ ok: false, msg: '和看板服务器的连接断了' }); nativeArchive.reset();memorySync.reset();fsServe.stopAll(); setTimeout(connect, retry); retry = Math.min(30000, retry * 1.5); });
  socket.on('error', () => { try { socket.close(); } catch {} });
}
const remoteComputeProcs = new Map(); // jobId -> { child, hbTimer, startMs }
function runRemoteCompute(d) {
  if (!controlOn()) {
    sendJSON({ t: 'compute-done', jobId: d.jobId, exitCode: 1, durationMs: 0, error: '这台电脑没开远程控制（agent.json "control": true）' });
    return;
  }
  const jobId = String(d.jobId || '').trim();
  const cmdStr = String(d.command || '').trim();
  if (!jobId || !cmdStr) return;
  const cwd = (typeof d.cwd === 'string' && d.cwd.trim() && fs.existsSync(d.cwd.trim())) ? d.cwd.trim() : os.homedir();
  const extraEnv = (d.env && typeof d.env === 'object' && !Array.isArray(d.env)) ? d.env : {};
  const startMs = Date.now();
  const rolling = [];
  const child = child_process.spawn(cmdStr, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const onChunk = (buf) => {
    for (const l of buf.toString('utf8').split(/\r?\n/)) {
      if (l.trim()) {
        rolling.push(l);
        if (rolling.length > 40) rolling.shift();
      }
    }
  };
  if (child.stdout) child.stdout.on('data', onChunk);
  if (child.stderr) child.stderr.on('data', onChunk);
  const hbTimer = setInterval(() => {
    sendJSON({ t: 'compute-heartbeat', jobId });
  }, 60000);
  if (hbTimer.unref) hbTimer.unref();
  remoteComputeProcs.set(jobId, { child, hbTimer, startMs });

  let finished = false;
  const finish = (code, errMsg = '') => {
    if (finished) return;
    finished = true;
    clearInterval(hbTimer);
    remoteComputeProcs.delete(jobId);
    sendJSON({
      t: 'compute-done',
      jobId,
      exitCode: code,
      durationMs: Date.now() - startMs,
      tail: rolling.join('\n'),
      ...(errMsg ? { error: errMsg } : {}),
    });
  };
  child.on('close', (code) => finish(code !== null ? code : 1));
  child.on('error', (err) => finish(1, err && err.message ? err.message : '启动进程失败'));
}

function killRemoteCompute(jobId) {
  const entry = remoteComputeProcs.get(String(jobId || ''));
  if (!entry || !entry.child) return;
  try {
    if (process.platform === 'win32' && entry.child.pid) {
      child_process.spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      entry.child.kill('SIGTERM');
    }
  } catch {}
}

const activeColabJobs = new Map(); // jobId -> AbortController
function runRemoteColab(d) {
  if (!controlOn()) {
    sendJSON({ t: 'compute-done', jobId: d.jobId, exitCode: 1, durationMs: 0, error: '这台电脑没开远程控制（agent.json "control": true）' });
    return;
  }
  const jobId = String(d.jobId || '').trim();
  const cmdStr = String(d.command || '').trim();
  if (!jobId || !cmdStr) return;
  const ac = new AbortController();
  activeColabJobs.set(jobId, ac);
  runColabJob({
    jobId,
    gpu: d.gpu || 'A100',
    fallbackGpus: Array.isArray(d.fallbackGpus) ? d.fallbackGpus : ['L4', 'T4'],
    command: cmdStr,
    cwd: typeof d.cwd === 'string' ? d.cwd : '',
    uploadPaths: Array.isArray(d.uploadPaths) ? d.uploadPaths : [],
    downloadPath: typeof d.downloadPath === 'string' ? d.downloadPath : '',
    outputDir: typeof d.outputDir === 'string' ? d.outputDir : '',
    maxDurationMin: Number(d.maxDurationMin) || 120,
    minBalanceCcu: d.minBalanceCcu != null ? Number(d.minBalanceCcu) : 15,
    signal: ac.signal,
    onHeartbeat: () => sendJSON({ t: 'compute-heartbeat', jobId }),
  })
    .then((res) => {
      activeColabJobs.delete(jobId);
      sendJSON({
        t: 'compute-done',
        jobId,
        exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 1,
        durationMs: (res && res.durationMs) || 0,
        tail: (res && res.tail) || '',
        ...(res && res.error ? { error: res.error } : {}),
        colab: res ? {
          gpu: res.gpu || '',
          sessionId: res.sessionId || '',
          stopped: Boolean(res.stopped),
          timedOut: Boolean(res.timedOut),
          cancelled: Boolean(res.cancelled),
        } : undefined,
      });
      maybeReportColabStatus(Date.now(), true);
    })
    .catch((err) => {
      activeColabJobs.delete(jobId);
      sendJSON({
        t: 'compute-done',
        jobId,
        exitCode: 1,
        durationMs: 0,
        error: (err && err.message) || 'Colab 作业运行异常',
      });
    });
}

function killRemoteColab(jobId) {
  const ac = activeColabJobs.get(String(jobId || ''));
  if (!ac) return;
  try { ac.abort(); } catch {}
}

let lastSugonAt = 0, sugonBusy = false;
function maybeReportSugonStatus(now = Date.now(), force = false) {
  if (!ws || ws.readyState !== 1 || sugonBusy) return;
  if (!force && now - lastSugonAt < 5 * 60000) return;
  if (!loadSugonConfig()) return;
  sugonBusy = true;
  lastSugonAt = now;
  probeSugonStatus()
    .then((st) => {
      if (st) sendJSON({ t: 'sugon-status', status: st });
    })
    .catch(() => {})
    .finally(() => { sugonBusy = false; });
}

let lastSugonScanAt = 0, sugonScanBusy = false;
const seenSugonFailures = new Set();
function maybeScanSugonFailures(now = Date.now()) {
  if (!ws || ws.readyState !== 1 || sugonScanBusy) return;
  if (now - lastSugonScanAt < 3 * 60000) return;
  if (!loadSugonConfig()) return;
  sugonScanBusy = true;
  lastSugonScanAt = now;
  scanSugonFailures({ seenFailedIds: seenSugonFailures, lookbackMinutes: 20 })
    .then((alerts) => {
      for (const alert of (Array.isArray(alerts) ? alerts : [])) {
        sendJSON({ t: 'sugon-alert', alert });
      }
    })
    .catch(() => {})
    .finally(() => { sugonScanBusy = false; });
}

const activeSugonJobs = new Map(); // jobId -> AbortController
function runRemoteSugon(d) {
  if (!controlOn()) {
    sendJSON({ t: 'compute-done', jobId: d.jobId, exitCode: 1, durationMs: 0, error: '这台电脑没开远程控制（agent.json "control": true）' });
    return;
  }
  const jobId = String(d.jobId || '').trim();
  const cmdStr = String(d.command || '').trim();
  if (!jobId || !cmdStr) return;
  const ac = new AbortController();
  activeSugonJobs.set(jobId, ac);
  runSugonJob({
    jobId,
    profile: d.sugonProfile || d.profile || '',
    label: d.label || '',
    partition: d.partition || '',
    nodes: Number(d.nodes) || 1,
    ntasks: Number(d.ntasks) || 1,
    gpus: Number(d.gpus) || 0,
    walltime: d.walltime || '',
    remoteWorkDir: d.remoteWorkDir || '',
    command: cmdStr,
    uploadPaths: Array.isArray(d.uploadPaths) ? d.uploadPaths : [],
    downloadPath: typeof d.downloadPath === 'string' ? d.downloadPath : '',
    outputDir: typeof d.outputDir === 'string' ? d.outputDir : '',
    signal: ac.signal,
    onHeartbeat: () => sendJSON({ t: 'compute-heartbeat', jobId }),
  })
    .then((res) => {
      activeSugonJobs.delete(jobId);
      sendJSON({
        t: 'compute-done',
        jobId,
        exitCode: res && typeof res.exitCode === 'number' ? res.exitCode : 1,
        durationMs: (res && res.durationMs) || 0,
        tail: (res && res.tail) || '',
        ...(res && res.slurmJobId ? { slurmJobId: res.slurmJobId } : {}),
        ...(res && res.profileId ? { profileId: res.profileId } : {}),
        ...(res && res.transferMethod ? { transferMethod: res.transferMethod } : {}),
        ...(res && res.transferWarning ? { transferWarning: res.transferWarning } : {}),
        ...(res && res.error ? { error: res.error } : {}),
      });
      maybeReportSugonStatus(Date.now(), true);
    })
    .catch((err) => {
      activeSugonJobs.delete(jobId);
      sendJSON({ t: 'compute-done', jobId, exitCode: 1, durationMs: 0, error: (err && err.message) || '曙光作业运行异常' });
    });
}

function killRemoteSugon(jobId) {
  const ac = activeSugonJobs.get(String(jobId || ''));
  if (!ac) return;
  try { ac.abort(); } catch {}
}

function sendJSON(o) { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} }

// new transcript lines of every tracked session, as slim records (a few batches per session per tick)
function pushRecords() {
  if (!serverOff || !ws || ws.readyState !== 1) return;
  archive.scan();
  for (const id of [...readers.keys()]) if (!sess.has(id) && !codexSess.has(id) && !opencodeSess.has(id) && !agySess.has(id) && !kiroSess.has(id) && !archive.map.has(id)) readers.delete(id);
  // (a terminal parked on a background session: what it still writes is that session's, already sent as such)
  const old = [...archive.map].filter(([id]) => !sess.has(id) && !codexSess.has(id) && !opencodeSess.has(id) && !agySess.has(id) && !kiroSess.has(id) && !line.parked.has(id));
  for (const [id, c] of [...sess, ...codexSess, ...opencodeSess, ...agySess, ...kiroSess, ...old]) {
    let r = readers.get(id);
    if (!r || r.file !== c.file) {
      const isCodex = id.startsWith('codex:');
      const isOpenCode = id.startsWith('opencode:');
      const isAgy = id.startsWith('agy:');
      const isKiro = id.startsWith('kiro:');
      r = records.createReader(c.file, serverOff[id] || 0, isCodex ? codex.recordsOf : isOpenCode ? opencode.recordsOf : isAgy ? agy.recordsOf : isKiro ? kiro.recordsOf : undefined); readers.set(id, r);
      if (isCodex || isOpenCode || isAgy || isKiro) r.cwd = c.cwd || null;
      // what the server needs to list the session and say how to resume it, even if nothing new gets written
      sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (pet.get(id) || {}).api, model: c.model || undefined, ai: c.ai || undefined });
      r.sentTitle = c.title || '';
    }
    if ((id.startsWith('codex:') || id.startsWith('opencode:') || id.startsWith('agy:') || id.startsWith('kiro:')) && r.sentTitle !== (c.title || '')) {
      sendJSON({ t: 'meta', id, project: c.project || '', title: c.title || '', cwd: r.cwd || undefined, api: (pet.get(id) || {}).api, model: c.model || undefined, ai: c.ai || undefined });
      r.sentTitle = c.title || '';
    }
    for (let k = 0; k < 8; k++) {
      if (ws.bufferedAmount > 8e6) return;                             // let the socket drain first
      let b; try { b = records.readNext(r); } catch { b = null; }
      if (!b) { if (archive.map.has(id) && !sess.has(id) && !codexSess.has(id) && !opencodeSess.has(id) && !agySess.has(id) && !kiroSess.has(id)) { archive.done(id); readers.delete(id); } break; }
      sendJSON({ t: 'rec', id, from: b.from, to: b.to, reset: b.reset || undefined, recs: b.recs,
        project: c.project || '', title: c.title || '', cwd: b.cwd || undefined, model: c.model || undefined, ai: c.ai || undefined });
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
  let list = [], codexList = [], agyList = [], kiroList = [], opencodeList = [];
  try { list = commands.scan(os.homedir()); codexList = commands.scanCodex(os.homedir()); agyList = commands.scanAgy(os.homedir()); kiroList = commands.scanKiro(os.homedir()); opencodeList = commands.scanOpenCode(os.homedir()); } catch {}
  const sig = JSON.stringify([list, codexList, agyList, kiroList, opencodeList]);
  if (!force && sig === cmdsSig) return;
  cmdsSig = sig;
  sendJSON({ t: 'cmds', list });
  sendJSON({ t: 'cmds', provider: 'codex', list: codexList });
  sendJSON({ t: 'cmds', provider: 'agy', list: agyList });
  sendJSON({ t: 'cmds', provider: 'kiro', list: kiroList });
  sendJSON({ t: 'cmds', provider: 'opencode', list: opencodeList });
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
    const profiles = profileView();
    const sig = JSON.stringify([controlOn(), profiles, [...line.parked], ...list.map((s) => [s.id, s.label, s.state, s.last, s.via, s.perms.map((p) => p.id), tailT(s), (s.agents || []).map((a) => a.id + a.state + (a.act || ''))])]);
    if (sig !== lastSig || force === true) {
      lastSig = sig;
      sendJSON({ t: 'state', control: controlOn(), files: browse.enabled, upload: browse.canUpload, sessions: list, parked: [...line.parked], claudeProfiles: profiles });
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
setInterval(()=>{nativeArchive.tick();if(cfg.fullArchive!==false)openCodeExport.tick();memorySync.tick().catch(e=>console.error('记忆采集失败：'+e.message));},500).unref();
// Collect local git working-tree changes (zero-token boundary audit for report / done board_post)
function collectGitAudit(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const targetDir = cwd.trim();
  try {
    if (!fs.statSync(targetDir).isDirectory()) return null;
  } catch {
    return null;
  }
  let out = '';
  let repoRoot = targetDir;
  try {
    out = child_process.execFileSync('git', ['-C', targetDir, '-c', 'core.quotepath=false', 'status', '--porcelain'], {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const top = child_process.execFileSync('git', ['-C', targetDir, 'rev-parse', '--show-toplevel'], {
        timeout: 1500,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (top) repoRoot = top;
    } catch {}
  } catch {
    return { checked: true, isGit: false, changedFiles: [], fingerprints: {} };
  }
  const files = [];
  const fingerprints = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    let p = line.slice(3).trim();
    if (!p) continue;
    const arrowIdx = p.indexOf(' -> ');
    if (arrowIdx >= 0) p = p.slice(arrowIdx + 4).trim();
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1);
    }
    p = p.replace(/\\/g, '/');
    if (p) {
      files.push(p);
      if (files.length <= 200) {
        try {
          const st = fs.statSync(path.join(repoRoot, p));
          fingerprints[p] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          fingerprints[p] = 'deleted';
        }
      }
    }
  }
  return { checked: true, isGit: true, changedFiles: files.slice(0, 200), fingerprints };
}
// Local loopback bridge (127.0.0.1:3941) for AmeMesh CLI / MCP tools running inside local coding agent sessions
const meshPending = new Map();
const MESH_TOKEN = crypto.randomBytes(24).toString('hex');
function startMeshBridge() {
  const srv = http.createServer((req, res) => {
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.origin || req.headers['x-ame-mesh'] !== MESH_TOKEN) return out(403, { ok: false, msg: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/mesh/local-info') {
      return out(200, { ok: true, machine: NAME, online: !!(ws && ws.readyState === 1), sessions: stateList().map((s) => ({ id: s.id, label: s.label, project: s.project, state: s.state })) });
    }
    if (req.method === 'POST' && req.url === '/mcp/call') return mcpCall(req, res, out);
    if (req.method !== 'POST' || req.url !== '/mesh/rpc') return out(404, { ok: false });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(body || '{}'); } catch { return out(400, { ok: false, msg: 'invalid json' }); }
      if (!ws || ws.readyState !== 1) {
        if (d.op === 'event') {
          savePendingMeshEvent(d);
          return out(200, { ok: true, queued: true, msg: 'agent 离线，事件已加入暂存队列，将在重新连接时自动上报' });
        }
        return out(200, { ok: false, msg: '本机 agent 尚未连接上群晖服务器' });
      }
      if ((d.op === 'report' || (d.op === 'board_post' && d.done === true))
        && !d.gitAudit && typeof d.callerCwd === 'string' && d.callerCwd.trim()) {
        d.gitAudit = collectGitAudit(d.callerCwd.trim());
      }
      const rid = 'mrpc-' + crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        if (meshPending.delete(rid)) out(200, { ok: false, msg: '群晖服务器响应超时' });
      }, 20000);
      if (timer.unref) timer.unref();
      meshPending.set(rid, (reply) => {
        clearTimeout(timer);
        const { t, rid: _r, ...rest } = reply;
        out(200, rest);
      });
      sendJSON({ ...d, t: 'mesh-req', rid, fromMachine: d.fromMachine || NAME });
    });
  });
  srv.on('error', () => {});
  srv.listen(MESH_PORT, '127.0.0.1', () => {
    try {
      fs.mkdirSync(path.dirname(MESH_TOKEN_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(MESH_TOKEN_FILE, JSON.stringify({ port: MESH_PORT, token: MESH_TOKEN, machine: NAME }), { mode: 0o600 });
    } catch {}
    if (CONTROL && !process.env.AME_NO_MCP_INSTALL && MESH_PORT === 3941) {
      try { require('../../install-mesh-mcp').installAll({ quiet: true }); } catch {}
    }
    sendMcpStatus();
  });
  srv.unref();
}

// Windose's other MCP servers (remote/mcp/client.js: 文献下载, 研究档案) through the same bridge: a call goes to the
// server as "mcp-req" and comes back as "mcp-res" -- a PDF first in "mcp-chunk" pieces (the server takes 4 MB a message
// from an agent, and sends a large file in parts too). Off with agent.json "mcp": false.
const mcpPending = new Map();
const MCP_MAX = 100 * 1024 * 1024;
function mcpCall(req, res, out) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
  req.on('end', () => {
    let d = {}; try { d = JSON.parse(body || '{}'); } catch { return out(400, { ok: false, msg: 'invalid json' }); }
    if (cfg.mcp === false) return out(200, { ok: false, msg: '这台电脑的 agent 关掉了 MCP 转发（agent.json 里 "mcp": false）' });
    if (!['literature', 'research'].includes(d.service) || !['info', 'call', 'pdf'].includes(d.op)) return out(400, { ok: false, msg: '不支持的请求' });
    if (!ws || ws.readyState !== 1) return out(200, { ok: false, msg: '本机 agent 还没连上看板服务器' });
    const rid = 'mcp-' + crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { if (mcpPending.delete(rid)) out(200, { ok: false, msg: '看板服务器响应超时' }); }, d.op === 'pdf' ? 600e3 : 120e3);
    if (timer.unref) timer.unref();
    mcpPending.set(rid, { parts: [], size: 0, done: (r) => {
      clearTimeout(timer);
      const { t, rid: _r, file, ...rest } = r;
      const p = mcpPending.get(rid); mcpPending.delete(rid);
      if (file && p) {
        const buf = Buffer.concat(p.parts);
        if (buf.length !== file.bytes) return out(200, { ok: false, msg: 'PDF 传到一半断了' });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'X-Job': encodeURIComponent(JSON.stringify(file.job || null)) });
        return res.end(buf);
      }
      out(200, rest);
    } });
    sendJSON({ t: 'mcp-req', rid, service: d.service, op: d.op, args: d.args && typeof d.args === 'object' ? d.args : {}, client: String(d.client || '').slice(0, 40) });
  });
}
function mcpFromServer(d) {
  const p = mcpPending.get(d.rid);
  if (!p) return;
  if (d.t === 'mcp-chunk') {
    const b = Buffer.from(String(d.b64 || ''), 'base64');
    p.size += b.length;
    if (p.size > MCP_MAX) return p.done({ ok: false, msg: '文件太大' });
    p.parts.push(b);
  } else p.done(d);
}
// which coding agents here have which of the MCP servers (install-mesh-mcp.js), for 控制面板 › MCP
function sendMcpStatus() {
  let clients = [];
  try { clients = require('../../install-mesh-mcp').status().map(({ id, label, present, servers, error }) => ({ id, label, present, servers, error })); } catch {}
  sendJSON({ t: 'mcp-status', clients, forward: cfg.mcp !== false, auto: CONTROL && !process.env.AME_NO_MCP_INSTALL && MESH_PORT === 3941 });
}
startMeshBridge();
connect();
console.log(`Ame 看板 agent 启动，扫描 ${PROJECTS}；文件浏览：${browse.enabled ? '开' : '关'}；远程控制：${CONTROL ? `开（经本机糖糖 127.0.0.1:${PET_PORT}，糖糖菜单里还要勾「允许远程控制」）` : '关'}`);

// ---- AmeMesh Folder Watcher & Offline Event Queue ----
let meshFolderTriggers = [];
const folderWatchState = new Map(); // triggerId -> { initialized: boolean, files: Map<relPath, { size, mtimeMs, stableCount }> }

function savePendingMeshEvent(evt) {
  try {
    const dir = path.join(os.homedir(), '.ametyping');
    fs.mkdirSync(dir, { recursive: true });
    const pendingFile = path.join(dir, 'pending-mesh-events.json');
    let list = [];
    try {
      const raw = fs.readFileSync(pendingFile, 'utf8');
      list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    } catch {}
    list.push(evt);
    const tmpFile = `${pendingFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, pendingFile);
  } catch {}
}

function flushPendingMeshEvents() {
  const pendingFile = path.join(os.homedir(), '.ametyping', 'pending-mesh-events.json');
  if (!fs.existsSync(pendingFile)) return;
  const flushingFile = `${pendingFile}.flushing-${Date.now()}`;
  try {
    fs.renameSync(pendingFile, flushingFile);
  } catch {
    return;
  }
  try {
    const raw = fs.readFileSync(flushingFile, 'utf8');
    const events = JSON.parse(raw);
    if (Array.isArray(events) && events.length > 0) {
      for (const evt of events) {
        const rid = 'evt_' + crypto.randomBytes(4).toString('hex');
        sendJSON({ ...evt, t: 'mesh-req', rid, op: 'event', fromMachine: NAME });
      }
    }
  } catch {}
  try {
    fs.unlinkSync(flushingFile);
  } catch {}
}

const IGNORED_WATCH_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vs']);

function globToRegex(glob = '*') {
  const normalized = String(glob || '*').replace(/\\/g, '/');
  if (!normalized || normalized === '*') return /^.*$/;
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                            .replace(/\*/g, '.*')
                            .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function scanDirFiles(dirPath, globRe, maxDepth = 4, maxFiles = 5000, matchRelPath = false) {
  const depthLimit = Math.max(1, Math.min(6, Math.floor(+maxDepth || 4)));
  const fileLimit = Math.max(1, Math.floor(+maxFiles || 5000));
  const useRelPath = matchRelPath || globRe.source.includes('/');
  const result = [];

  function walk(curDir, relPrefix, depth) {
    if (result.length >= fileLimit || depth > depthLimit) return;
    let entries;
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (result.length >= fileLimit) break;
      const fullPath = path.join(curDir, ent.name);
      const relPath = relPrefix ? path.join(relPrefix, ent.name) : ent.name;
      if (ent.isFile()) {
        const target = useRelPath ? relPath.replace(/\\/g, '/') : ent.name;
        if (globRe.test(target)) {
          try {
            const st = fs.statSync(fullPath);
            result.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
          } catch {}
        }
      } else if (ent.isDirectory()) {
        if (IGNORED_WATCH_DIRS.has(ent.name)) continue;
        if (depth < depthLimit) {
          walk(fullPath, relPath, depth + 1);
        }
      }
    }
  }

  walk(dirPath, '', 1);
  return result;
}

function pollFolderTriggers() {
  for (const trig of meshFolderTriggers) {
    if (!trig || !trig.path) continue;
    let state = folderWatchState.get(trig.id);
    if (!state) {
      state = { initialized: false, files: new Map() };
      folderWatchState.set(trig.id, state);
    }
    const globStr = trig.glob || '*';
    const globRe = globToRegex(globStr);
    const matchRelPath = /[\\/]/.test(globStr);
    const maxDepth = Math.max(1, Math.min(6, Math.floor(+(trig.maxDepth || 4))));
    const scanned = scanDirFiles(trig.path, globRe, maxDepth, 5000, matchRelPath);
    const scannedKeys = new Set();
    const readyFiles = [];

    if (!state.initialized) {
      for (const f of scanned) {
        state.files.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs, stableCount: 2 });
      }
      state.initialized = true;
      continue;
    }

    for (const f of scanned) {
      scannedKeys.add(f.relPath);
      const prev = state.files.get(f.relPath);
      if (!prev) {
        state.files.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs, stableCount: 1 });
      } else if (prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) {
        state.files.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs, stableCount: 1 });
      } else {
        if (prev.stableCount === 1) {
          prev.stableCount = 2;
          readyFiles.push(f.relPath);
        }
      }
    }

    for (const key of state.files.keys()) {
      if (!scannedKeys.has(key)) state.files.delete(key);
    }

    if (readyFiles.length > 0) {
      const rid = 'evt_' + crypto.randomBytes(4).toString('hex');
      sendJSON({
        t: 'mesh-req',
        rid,
        op: 'event',
        fromMachine: NAME,
        projectId: trig.projectId,
        triggerId: trig.id,
        source: 'folder',
        kind: 'files_ready',
        path: trig.path,
        files: readyFiles,
        label: trig.label,
      });
    }
  }
}

function updateMeshFolderTriggers(triggers) {
  meshFolderTriggers = Array.isArray(triggers) ? triggers : [];
  const curIds = new Set(meshFolderTriggers.map((t) => t.id));
  for (const id of folderWatchState.keys()) {
    if (!curIds.has(id)) folderWatchState.delete(id);
  }
}

const FOLDER_POLL_MS = +process.env.AME_FOLDER_POLL_MS || 15000;
const folderPollTimer = setInterval(pollFolderTriggers, FOLDER_POLL_MS);
if (folderPollTimer.unref) folderPollTimer.unref();

