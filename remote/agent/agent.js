#!/usr/bin/env node
// Ame dashboard agent -- runs on each machine next to Claude Code / Codex / OpenCode / Antigravity / Kiro.
// Orchestrates session scanning, pet control forwarding, fleet updates, compute dispatch, and the local AmeMesh bridge.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const commands = require('./commands');
const { createFiles } = require('./files');
const { createProfiles } = require('./claude-profiles');
const { createFsServe } = require('./fs-serve');
const { createNativeArchive } = require('./native-archive');
const { createMemorySync } = require('./memory-sync');
const { createOpenCodeExport } = require('./opencode-export');
const { createArtifacts } = require('./artifacts');
const { createFleet } = require('./fleet');
const { createAgentConfig } = require('./agent-config');
const { createHarness } = require('./harness');
const { createCollector, stateSignature } = require('./infra-probe');
const { createQuotaNotices } = require('./quota-notices');
const { createSessionScanner } = require('./session-scanner');
const { createPetClient } = require('./pet-client');
const { createComputeDispatcher } = require('./compute-dispatcher');
const { createMeshBridge } = require('./mesh-bridge');
const { closeNodeTerminal } = require('./worktree');

const CFG = process.env.AME_AGENT_CONFIG || path.join(__dirname, 'agent.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch {
  console.error(`读不到 ${CFG}。示例见 agent.example.json：{ "server": "wss://你的域名/agent", "token": "xxx", "name": "本机名", "control": false }`);
  process.exit(1);
}

const NAME = cfg.name || os.hostname();
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SCAN_MS = cfg.scanMs || 2000;
const IDLE_DROP_MS = cfg.keepMs || 30 * 60e3;
const CONTROL = cfg.control === true;
const PET_PORT = +cfg.petPort || 3940;
const PET_TOKEN_FILE = path.join(os.homedir(), '.ametyping', `control-token-${PET_PORT}`);
const MESH_PORT = +process.env.AME_MESH_BRIDGE_PORT || +cfg.meshPort || 3941;
const MESH_TOKEN_FILE = path.join(os.homedir(), '.ametyping', `mesh-token-${MESH_PORT}`);

let ws = null;
let retry = 2000;
const isOnline = () => Boolean(ws && ws.readyState === 1);
function sendJSON(o) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {}
}

const claudeProfiles = createProfiles();
if (CONTROL) {
  try { claudeProfiles.install(); } catch (e) { console.error('启动入口检查失败：' + e.message); }
}
const profileView = () => (CONTROL ? claudeProfiles.list() : { profiles: [], aliases: [] });

const browse = createFiles(cfg.files);
const nativeArchive = createNativeArchive({ send: sendJSON, enabled: cfg.fullArchive !== false, log: console.error });
const openCodeExport = createOpenCodeExport({ log: console.error });
const memorySync = createMemorySync({
  name: NAME,
  send: sendJSON,
  folder: (p) => browse.writableFolder(p),
  canWrite: () => CONTROL && cfg.memory !== false,
  confirmedDir: (cfg.memory && cfg.memory.confirmedDir) || '',
  enabled: cfg.memory !== false,
  autoApply: !(cfg.memory && cfg.memory.autoApply === false),
});

let sessionScanner;
const petClient = createPetClient({
  controlEnabled: CONTROL,
  petPort: PET_PORT,
  petTokenFile: PET_TOKEN_FILE,
  browse,
  sessionFile: (id) => sessionScanner.sessionFile(id),
  sendJSON,
  isOnline,
  onPollDone: () => computeDispatcher.maybeReportComputeProbe(),
  onAfterControl: () => setTimeout(() => tick(true), 300),
});

sessionScanner = createSessionScanner({
  projectsDir: PROJECTS,
  idleDropMs: IDLE_DROP_MS,
  archiveDays: cfg.archiveDays != null ? +cfg.archiveDays : 30,
  petMap: petClient.pet,
  sendJSON,
  getBufferedAmount: () => (ws ? ws.bufferedAmount : 0),
  isOnline,
});

const computeDispatcher = createComputeDispatcher({
  controlOn: petClient.controlOn,
  sendJSON,
  isOnline,
});

const meshBridge = createMeshBridge({
  name: NAME,
  controlEnabled: CONTROL,
  mcpEnabled: cfg.mcp !== false,
  meshPort: MESH_PORT,
  meshTokenFile: MESH_TOKEN_FILE,
  stateList: () => sessionScanner.stateList(),
  sendJSON,
  isOnline,
});

const fsServe = createFsServe(browse, sendJSON, { sessionFile: (id) => sessionScanner.sessionFile(id) });
const artifacts = createArtifacts({ sessionFile: (id) => sessionScanner.sessionFile(id), send: sendJSON });
const quotaNotices = createQuotaNotices({ deliver: (n) => petClient.petCall('POST', '/control/quota', n) });
const fleet = createFleet({ cfg, log: console.error });
const agentConfig = createAgentConfig();
const harness = createHarness();

// ---- Infrastructure collector ----
const infraCollector = createCollector({ isNas: false });
let infraIntervalMs = 60000, infraWatched = [], infraTargets = [], lastInfraAt = 0, lastInfraSig = '', infraBusy = false;
async function pushInfra(force = false) {
  if (infraBusy || !isOnline()) return;
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

// ---- Fleet & Harness management ----
let harnessList = null, harnessTimer = null, netFound = null, netBusy = null;
const netView = (n) => n && {
  at: n.at,
  needProxy: n.needProxy,
  recommended: n.recommended,
  recommendedSource: n.recommendedSource,
  direct: { reach: n.direct.reach },
  routes: n.routes.map(({ url, source, reach, ms }) => ({ url, source, reach, ms })),
};

function lookForWayOut() {
  if (process.env.AME_NO_NET_PROBE) return Promise.resolve(null);
  if (!netBusy) {
    netBusy = harness.detectNet()
      .then((n) => { netFound = n; return n; }, (e) => { console.error('网络检测失败：' + e.message); return null; })
      .finally(() => { netBusy = null; });
  }
  return netBusy;
}

function sendFleetVersion() {
  fleet.version()
    .then((v) => sendJSON({
      t: 'fleet-version',
      ...v,
      control: CONTROL,
      magpieKey: agentConfig.keyInfo() || undefined,
      harnesses: harnessList || undefined,
      hooks: fleet.hookStatus(),
      proxy: agentConfig.net().proxy || undefined,
      net: netView(netFound) || undefined,
    }))
    .catch((e) => console.error('版本信息读取失败：' + e.message));
  if (!harnessList && !harnessTimer) {
    harnessTimer = setTimeout(() => harness.inventory().then((l) => { harnessList = l; sendFleetVersion(); }, () => {})
      .then(() => CONTROL && lookForWayOut().then((n) => n && sendFleetVersion())), +process.env.AME_HARNESS_DELAY_MS || 20e3);
    harnessTimer.unref();
    if (CONTROL) setInterval(() => lookForWayOut().then((n) => n && sendFleetVersion()), 12 * 3600e3).unref();
  }
}

function refreshHarnesses() {
  harness.inventory({ fresh: true }).then((l) => { harnessList = l; }, () => {}).finally(sendFleetVersion);
}

function onFleetMessage(d) {
  const reply = (t, o) => sendJSON({ t, rid: d.rid, ...o });
  const failType = d.t === 'agent-config' ? 'agent-config-result'
    : d.t === 'harness-run' ? 'harness-result'
    : d.t === 'harness-net-probe' ? 'harness-net-result'
    : d.t === 'fleet-sync-hooks' ? 'fleet-sync-hooks-result'
    : d.t === 'fleet-sync-skills' ? 'fleet-sync-skills-result'
    : 'fleet-result';
  if (!CONTROL) return reply(failType, { ok: false, msg: '这台电脑没开远程控制（agent.json "control": true）' });
  if (d.t === 'fleet-sync-hooks') {
    fleet.syncHooksAndMcp()
      .then((r) => reply('fleet-sync-hooks-result', r), (e) => reply('fleet-sync-hooks-result', { ok: false, msg: '同步出错：' + e.message }))
      .finally(() => { sendFleetVersion(); meshBridge.sendMcpStatus(); });
    return;
  }
  if (d.t === 'fleet-sync-skills') {
    let r;
    try { r = fleet.syncSkills(d.skills); } catch (e) { r = { ok: false, msg: '下发出错：' + e.message }; }
    reply('fleet-sync-skills-result', r);
    sendCommands(true);
    return;
  }
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
    let r;
    try { r = agentConfig.apply(d); } catch (e) { r = { ok: false, msg: e.message }; }
    reply('agent-config-result', r);
    sendFleetVersion();
  }
}

// ---- Slash commands & skills inventory ----
let cmdsSig = '';
function sendCommands(force) {
  let list = [], codexList = [], agyList = [], kiroList = [], opencodeList = [];
  try {
    const home = os.homedir();
    list = commands.scan(home);
    codexList = commands.scanCodex(home);
    agyList = commands.scanAgy(home);
    kiroList = commands.scanKiro(home);
    opencodeList = commands.scanOpenCode(home);
  } catch {}
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

// ---- Main scan & state push loop ----
let ticking = false;
async function tick(force) {
  if (ticking) return;
  ticking = true;
  try {
    await petClient.pollPet();
    sessionScanner.forwardBtw();
    sessionScanner.scan();
    sessionScanner.pushStateIfChanged(force, {
      controlOn: petClient.controlOn(),
      browse,
      profiles: profileView(),
    });
    sessionScanner.pushRecords();
  } finally {
    ticking = false;
  }
}
setInterval(tick, SCAN_MS);
setInterval(() => {
  nativeArchive.tick();
  if (cfg.fullArchive !== false) openCodeExport.tick();
  memorySync.tick().catch((e) => console.error('记忆采集失败：' + e.message));
}, 500).unref();

// ---- Server WebSocket connection ----
const FLEET_MSG_TYPES = new Set([
  'fleet-check', 'fleet-files', 'fleet-apply', 'agent-config',
  'harness-run', 'harness-net-probe', 'fleet-sync-hooks', 'fleet-sync-skills',
]);
const CONTROL_MSG_TYPES = new Set([
  'send', 'key', 'screen', 'decide', 'launch', 'resume', 'worktree-check', 'worktree-remove',
]);

function handleServerMessage(socket, raw) {
  if (socket !== ws) return;
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  if (nativeArchive.handle(d)) return;
  if (d.t === 'memory-bundle') { memorySync.handle(d).catch((e) => console.error('记忆同步失败：' + e.message)); return; }
  if (d.t === 'want-conv' && typeof d.id === 'string') return sessionScanner.sendConv(d.id);
  if (FLEET_MSG_TYPES.has(d.t) && typeof d.rid === 'string') return onFleetMessage(d);
  if (d.t === 'sync' && d.offsets && typeof d.offsets === 'object') {
    fleet.markHealthy();
    return sessionScanner.onSync(d.offsets);
  }
  if (typeof d.t === 'string' && d.t.startsWith('fs')) return fsServe.handle(d);
  if (d.t === 'report-note' && typeof d.date === 'string') return void petClient.petCall('POST', '/control/report', d);
  if (d.t === 'quota-alert') return quotaNotices.add(d.notice);
  if (d.t === 'mail-alert' && d.alert && typeof d.alert.id === 'string') return void petClient.petCall('POST', '/control/mail', d.alert);
  if (d.t === 'title' && d.machine === NAME && typeof d.id === 'string' && typeof d.title === 'string') {
    return void petClient.petCall('POST', '/control/title', { id: d.id, title: d.title });
  }
  if (d.t === 'claude-profiles-request' && typeof d.rid === 'string') {
    let r = { ok: false, msg: '这台电脑没开放配置管理' };
    if (CONTROL) {
      try {
        r = d.action === 'list' ? { ok: true } : d.action === 'save'
          ? claudeProfiles.save(d.profile || {}) : { ok: false, msg: '不支持的配置操作' };
        if (r.ok) r.view = profileView();
      } catch { r = { ok: false, msg: '读取本地启动入口失败，请检查 cc-environments 文件' }; }
    }
    try { socket.send(JSON.stringify({ t: 'claude-profiles-result', rid: d.rid, ...r })); } catch {}
    return;
  }
  if (d.t === 'art-check' && typeof d.rid === 'string') {
    if (cfg.artifacts === false) sendJSON({ t: 'art-res', rid: d.rid, items: [], off: true });
    else artifacts.handle(d).catch(() => sendJSON({ t: 'art-res', rid: d.rid, items: [], error: true }));
    return;
  }
  if (d.t === 'mesh-res' && typeof d.rid === 'string') return meshBridge.onMeshRes(d);
  if ((d.t === 'mcp-res' || d.t === 'mcp-chunk') && typeof d.rid === 'string') return meshBridge.mcpFromServer(d);
  if (d.t === 'mesh-triggers' && Array.isArray(d.triggers)) return meshBridge.updateMeshFolderTriggers(d.triggers);
  if (d.t === 'infra-cfg') {
    if (Number.isFinite(+d.intervalSec) && +d.intervalSec >= 5) infraIntervalMs = +d.intervalSec * 1000;
    if (Array.isArray(d.watched)) infraWatched = d.watched;
    if (Array.isArray(d.probeTargets)) infraTargets = d.probeTargets;
    if (d.collectNow) pushInfra(true);
    return;
  }
  if (d.t === 'infra-ctl' && typeof d.rid === 'string') {
    if (!petClient.controlOn()) sendJSON({ t: 'infra-ctl-res', rid: d.rid, ok: false, msg: '这台电脑没开远程控制' });
    else infraCollector.executeControl(d).then(async (r) => {
      const rep = await infraCollector.collect({ watched: infraWatched, probeTargets: infraTargets }).catch(() => null);
      sendJSON({ t: 'infra-ctl-res', rid: d.rid, ...r, report: rep || undefined });
    });
    return;
  }
  if (d.t === 'compute-exec' && typeof d.jobId === 'string') return computeDispatcher.runRemoteCompute(d);
  if (d.t === 'compute-kill' && typeof d.jobId === 'string') return computeDispatcher.killRemoteCompute(d.jobId);
  if (d.t === 'colab-exec' && typeof d.jobId === 'string') return computeDispatcher.runRemoteColab(d);
  if (d.t === 'colab-kill' && typeof d.jobId === 'string') return computeDispatcher.killRemoteColab(d.jobId);
  if (d.t === 'sugon-exec' && typeof d.jobId === 'string') return computeDispatcher.runRemoteSugon(d);
  if (d.t === 'sugon-kill' && typeof d.jobId === 'string') return computeDispatcher.killRemoteSugon(d.jobId);
  if (d.t === 'sugon-query' && typeof d.rid === 'string') return computeDispatcher.handleSugonQuery(d);
  if (d.t === 'mesh-close-node' && typeof d.id === 'string') {
    if (!CONTROL) {
      sendJSON({ t: 'mesh-close-node-res', id: d.id, closed: false, count: 0, detail: '这台电脑没开远程控制' });
      return;
    }
    closeNodeTerminal({ nodeId: d.nodeId, role: d.role })
      .then((r) => sendJSON({
        t: 'mesh-close-node-res',
        id: d.id,
        closed: !!r.closed,
        count: +r.count || 0,
        detail: String(r.detail || '').slice(0, 200),
      }))
      .catch((e) => sendJSON({
        t: 'mesh-close-node-res',
        id: d.id,
        closed: false,
        count: 0,
        detail: String((e && e.message) || '关闭节点终端出错').slice(0, 200),
      }));
    return;
  }
  if (CONTROL_MSG_TYPES.has(d.t) && typeof d.rid === 'string') {
    petClient.control(d).then((r) => sendJSON({ t: 'result', rid: d.rid, ...r }));
  }
}

function connect() {
  const socket = ws = new WebSocket(cfg.server, { headers: { Authorization: 'Bearer ' + cfg.token } });
  socket.on('open', () => {
    if (socket !== ws) return;
    retry = 2000;
    console.log(`已连接看板服务器，机器名「${NAME}」`);
    socket.send(JSON.stringify({
      t: 'hello',
      machine: NAME,
      control: petClient.controlOn(),
      claudeProfilesVersion: 1,
      vaultVersion: cfg.fullArchive === false ? 0 : 1,
      memoryVersion: 1,
      memoryAllowed: CONTROL && cfg.memory !== false,
      claudeProfilesAllowed: CONTROL,
      claudeProfiles: profileView(),
      files: browse.enabled,
      upload: browse.canUpload,
    }));
    sendCommands(true);
    sendFleetVersion();
    sessionScanner.resetConnection();
    nativeArchive.ready();
    memorySync.reset();
    tick(true);
    pushInfra(true);
    meshBridge.flushPendingMeshEvents();
    meshBridge.sendMcpStatus();
  });
  socket.on('message', (raw) => handleServerMessage(socket, raw));
  socket.on('close', () => {
    if (socket !== ws) return;
    ws = null;
    meshBridge.onDisconnect();
    nativeArchive.reset();
    memorySync.reset();
    fsServe.stopAll();
    setTimeout(connect, retry);
    retry = Math.min(30000, retry * 1.5);
  });
  socket.on('error', () => { try { socket.close(); } catch {} });
}

meshBridge.startMeshBridge();
connect();
console.log(`Ame 看板 agent 启动，扫描 ${PROJECTS}；文件浏览：${browse.enabled ? '开' : '关'}；远程控制：${CONTROL ? `开（经本机糖糖 127.0.0.1:${PET_PORT}，糖糖菜单里还要勾「允许远程控制」）` : '关'}`);
