// AmeMesh: Cross-machine, cross-agent session communication bus, topology registry, contract gates,
// scoped workspace grants, and tiered file transfer / sneakernet handoff queue.
// Persisted in <dataDir>/mesh-projects.json and automatically synchronized with 糖糖看板's session groups (session-marks.js).
'use strict';
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./lib/json-store');
const { createWatchdog, loadMeshConfig } = require('./mesh-watchdog');
const { createBoard } = require('./mesh-board');
const { repairProject } = require('./mesh-repair');
const { createRoleStore } = require('./mesh-roles');
const { createModelRouter } = require('./mesh-model-router');
const { idGen, isSubPath, formatEnvelope } = require('./mesh/helpers');
const { createMeshStores } = require('./mesh/stores');
const { createMeshHpc } = require('./mesh/hpc');
const { createMeshTopology } = require('./mesh/topology');
const { createMeshTransfer } = require('./mesh/transfer');
const { createMeshSwarm } = require('./mesh/swarm');
const { createMeshRoutes } = require('./mesh/routes');

function createMesh({
  dataDir,
  machines,
  store,
  marks,
  fsCatalog,
  getMagpie = () => null,
  getEgress = () => null,
  getTodos = () => [],
  dispatchControl = null, // async (machineName, payload) => { ok, msg }
  onChange = () => {},
  audit = () => {},
  notify = null,
}) {
  const file = path.join(dataDir, 'mesh-projects.json');
  const roleStore = createRoleStore({ dataDir });
  const knownRoles = () => {
    try {
      return roleStore.list().map((r) => r.name);
    } catch {
      return [];
    }
  };

  let data = { projects: [] };
  const raw = readJsonSafe(file);
  if (raw && Array.isArray(raw.projects)) data = raw;
  // Idempotent load-time repair (role/alias swaps, non-master 'master-worker' edges); persist only when changed
  {
    let repaired = false;
    const roles = knownRoles();
    for (const proj of data.projects) {
      try {
        if (repairProject(proj, { knownRoles: roles }).changed) repaired = true;
      } catch {}
    }
    if (repaired) {
      try {
        writeJsonAtomic(file, data, { mode: 0o600, mkdirMode: 0o700 });
      } catch {}
    }
  }

  const pendingSpawns = new Map(); // "machine|cwd" -> [{ projectId, nodeId, t0 }]

  function save() {
    try {
      writeJsonAtomic(file, data, { mode: 0o600, mkdirMode: 0o700 });
    } catch {}
    onChange();
  }

  function recordEvent(proj, evt) {
    if (!proj) return null;
    proj.events = proj.events || [];
    const fullEvt = {
      id: evt.id || idGen('evt'),
      projectId: proj.id,
      ts: evt.ts || Date.now(),
      source: evt.source || 'watchdog',
      kind: evt.kind || '',
      machine: evt.machine || '',
      nodeId: evt.nodeId || null,
      summary: evt.summary || '',
      payload: evt.payload || {},
    };
    proj.events.push(fullEvt);
    if (proj.events.length > 200) {
      proj.events = proj.events.slice(-200);
    }
    save();
    return fullEvt;
  }

  const ctx = {
    dataDir,
    file,
    data,
    machines,
    store,
    marks,
    fsCatalog,
    getMagpie,
    getEgress,
    getTodos,
    dispatchControl,
    onChange,
    audit,
    notify,
    pendingSpawns,
    watchdog: null,
    save,
    recordEvent,
    roleStore,
    knownRoles,
    board: null,
    modelRouter: null,
  };

  // Board resolves @mentions to node ids (`targets`) against the project's current nodes (alias / live label / id / role)
  ctx.board = createBoard({
    dataDir,
    getNodes: (projectId) => {
      const proj = ctx.data.projects.find((x) => x.id === projectId);
      if (!proj) return [];
      return (proj.nodes || []).map((n) => {
        const live = ctx.liveSessionOf(n.machine, n.sessionId);
        return { id: n.id, alias: n.alias || '', role: n.role || '', label: (live && live.label) || '' };
      });
    },
  });

  Object.assign(ctx, createMeshStores(ctx));

  ctx.modelRouter = createModelRouter({
    dataDir,
    getMagpie,
    getLocalQuotas: () => ctx.listLocalQuotas(),
    getExpiringHarnesses: () => {
      const cfg = ctx.watchdog ? ctx.watchdog.getConfig() : {};
      return Array.isArray(cfg.expiringFirstHarnesses) ? cfg.expiringFirstHarnesses : ['codex'];
    },
  });

  Object.assign(ctx, createMeshHpc(ctx));
  Object.assign(ctx, createMeshTopology(ctx));
  Object.assign(ctx, createMeshTransfer(ctx));
  Object.assign(ctx, createMeshSwarm(ctx));

  ctx.watchdog = createWatchdog({
    dataDir,
    getProjects: () => ctx.data.projects,
    getMachines: () => (machines || new Map()),
    liveSessionOf: ctx.liveSessionOf,
    deliverToNode: ctx.deliverToNode,
    sendToAgent: ctx.sendToAgent,
    recordEvent: (p, e) => ctx.recordEvent(p, e),
    notify: typeof notify === 'function' ? notify : async () => ({ sent: 0 }),
    save: ctx.save,
    postBoard: (d) => ctx.postBoard(d),
    onQuotaExhausted: (proj, node, reason) => ctx.handleQuotaExhausted(proj, node, reason),
    onL3Idle: (proj, masterNode) => ctx.handleL3Idle(proj, masterNode),
  });
  ctx.watchdog.start(15000);

  Object.assign(ctx, createMeshRoutes(ctx));

  return {
    listProjects: ctx.listProjects,
    getProject: ctx.getProject,
    scopedViewFor: ctx.scopedViewFor,
    saveProject: ctx.saveProject,
    deleteProject: ctx.deleteProject,
    upsertNode: ctx.upsertNode,
    removeNode: ctx.removeNode,
    addEdge: ctx.addEdge,
    removeEdge: ctx.removeEdge,
    spawnWorker: ctx.spawnWorker,
    reviewNode: ctx.reviewNode,
    sendMessage: ctx.sendMessage,
    reportResult: ctx.reportResult,
    postBoard: ctx.postBoard,
    readBoard: ctx.readBoard,
    manageTask: ctx.manageTask,
    manageChannel: ctx.manageChannel,
    checkNodeWorktree: ctx.checkNodeWorktree,
    removeNodeWorktree: ctx.removeNodeWorktree,
    board: ctx.board,
    requestTransfer: ctx.requestTransfer,
    confirmTransfer: ctx.confirmTransfer,
    flushInbox: ctx.flushInbox,
    configureWorkspaces: ctx.configureWorkspaces,
    checkWorkspaceAccess: ctx.checkWorkspaceAccess,
    onMachineState: ctx.onMachineState,
    onSessionMeta: ctx.onSessionMeta,
    onCliUpdate: ctx.onCliUpdate,
    listCliUpdates: ctx.listCliUpdates,
    clearCliUpdate: ctx.clearCliUpdate,
    onLocalQuota: ctx.onLocalQuota,
    listLocalQuotas: ctx.listLocalQuotas,
    onColabStatus: ctx.onColabStatus,
    onSugonStatus: ctx.onSugonStatus,
    onSugonAlert: ctx.onSugonAlert,
    onSugonQueryRes: ctx.onSugonQueryRes,
    querySugon: ctx.querySugon,
    machinesSummary: ctx.machinesSummary,
    onComputeDone: ctx.onComputeDone,
    fromAgentResult: ctx.fromAgentResult,
    fromAgentRpc: ctx.fromAgentRpc,
    fromAgentFs: ctx.fromAgentFs,
    handle: ctx.handle,
    upsertTrigger: ctx.upsertTrigger,
    removeTrigger: ctx.removeTrigger,
    syncAgentTriggers: ctx.syncAgentTriggers,
    emitEvent: ctx.emitEvent,
    recordEvent: ctx.recordEvent,
    watchdog: ctx.watchdog,
    roleStore: ctx.roleStore,
    modelRouter: ctx.modelRouter,
    computeQueue: ctx.computeQueue,
    listSkills: ctx.listSkills,
  };
}

module.exports = { createMesh, isSubPath, formatEnvelope, createWatchdog, loadMeshConfig };
