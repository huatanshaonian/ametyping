// AmeMesh: Cross-machine, cross-agent session communication bus, topology registry, contract gates,
// scoped workspace grants, and tiered file transfer / sneakernet handoff queue.
// Persisted in <dataDir>/mesh-projects.json and automatically synchronized with 糖糖看板's session groups (session-marks.js).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { createWatchdog, loadMeshConfig } = require('./mesh-watchdog');
const { createBoard, formatWakePrompt, checkBoundaries } = require('./mesh-board');
const { createRoleStore } = require('./mesh-roles');
const { createModelRouter } = require('./mesh-model-router');
const { createComputeQueue } = require('./mesh-compute-queue');
const { evaluateFableAdvice } = require('./mesh-fable-advisor');

const MAX_PROJECTS = 50;
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_INBOX = 30;
const MAX_TRANSFERS = 100;
const AUTO_FILE_LIMIT = 50 * 1024 * 1024; // 50 MB threshold before suggesting manual disk handoff
const TOOLS = ['claude', 'codex', 'opencode', 'agy', 'kiro']; // coding agents a node / spawn may be

const cleanStr = (v, n) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, n) : '');
const normalizeStrArray = (arr, maxLen, itemMax) =>
  (Array.isArray(arr) ? arr.map((x) => cleanStr(x, itemMax)).filter(Boolean).slice(0, maxLen) : []);
const idGen = (prefix = 'p') => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

let CRC_TABLE = null;
function crc32Of(buf, crc = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function normFolderPath(p) {
  let s = String(p || '').trim().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '\\';
  return /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

function isSubPath(parentPath, childPath) {
  const p = normFolderPath(parentPath);
  const c = normFolderPath(childPath);
  if (!p || !c) return false;
  if (p === c) return true;
  const sep = /^[A-Za-z]:/.test(p) ? '\\' : '/';
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

// Format a structured message envelope injected into a coding agent's terminal or resume prompt
function formatEnvelope({ project, fromNode, toNode, type, text, goal, stopCondition, artifacts }) {
  const senderLabel = fromNode ? `${fromNode.alias || fromNode.id} (${fromNode.machine})` : '项目管理中心';
  const lines = [];
  if (type === 'report') {
    lines.push(`[AmeMesh 节点汇报 | 项目：${project.name} | 来自：${senderLabel} -> ${toNode.alias || toNode.id}]`);
    lines.push(`汇报内容：${text}`);
    if (Array.isArray(artifacts) && artifacts.length) {
      lines.push(`产出文件/图表：${artifacts.join(', ')}`);
    }
    lines.push(`请检视（Review）上述结果并决定下一步操作。`);
  } else if (type === 'cowork') {
    lines.push(`[AmeMesh 平级协同消息 (Cowork) | 项目：${project.name} | 来自：${senderLabel}]`);
    if (goal) lines.push(`协同目标：${goal}`);
    lines.push(`消息内容：${text}`);
    if (stopCondition) lines.push(`阶段边界（达成即停）：${stopCondition}`);
  } else if (type === 'handoff_ready') {
    lines.push(`[AmeMesh 大文件就位通知 | 项目：${project.name}]`);
    lines.push(text);
  } else {
    lines.push(`[AmeMesh 主控任务指令 | 项目：${project.name} | 来自：${senderLabel}]`);
    if (goal || toNode.goal) lines.push(`执行目标（Goal）：${goal || toNode.goal}`);
    lines.push(`具体指令：${text}`);
    if (stopCondition || toNode.stopCondition) {
      lines.push(`停机与检视边界（Stop & Review Gate）：${stopCondition || toNode.stopCondition}（达成此条件或遇阻塞时请停止继续发散，调用 mesh_report 汇报并等待检视）`);
    }
  }
  return lines.join('\n');
}

function createMesh({
  dataDir,
  machines,
  store,
  marks,
  fsCatalog,
  getMagpie = () => null,
  getTodos = () => [],
  dispatchControl = null, // async (machineName, payload) => { ok, msg }
  onChange = () => {},
  audit = () => {},
  notify = null,
}) {
  const file = path.join(dataDir, 'mesh-projects.json');
  const board = createBoard({ dataDir });
  const roleStore = createRoleStore({ dataDir });
  const localQuotas = new Map(); // provider -> { ...quota, machine, reportedAt }
  function onLocalQuota(machineName, quota) {
    if (!quota || typeof quota !== 'object' || !quota.provider) return;
    const prov = cleanStr(quota.provider, 40).toLowerCase();
    if (!prov) return;
    const prev = localQuotas.get(prov);
    const nextTs = Date.parse(quota.readAt || '') || Date.now();
    const prevTs = prev ? (Date.parse(prev.readAt || '') || prev.reportedAt || 0) : 0;
    if (!prev || nextTs >= prevTs) {
      localQuotas.set(prov, {
        ...quota,
        provider: prov,
        machine: cleanStr(machineName, 60),
        reportedAt: Date.now(),
      });
    }
  }
  function listLocalQuotas() {
    return [...localQuotas.values()];
  }
  let watchdog = null;
  const modelRouter = createModelRouter({
    dataDir,
    getMagpie,
    getLocalQuotas: () => listLocalQuotas(),
    getExpiringHarnesses: () => {
      const cfg = watchdog ? watchdog.getConfig() : {};
      return Array.isArray(cfg.expiringFirstHarnesses) ? cfg.expiringFirstHarnesses : ['codex'];
    },
  });
  function resolveColabGateway(preferredMachine = '') {
    const prov = computeQueue.getProvider('colab');
    const gw = (prov && prov.meta && prov.meta.machine) || '';
    const candidates = [preferredMachine, gw].filter(Boolean);
    for (const name of candidates) {
      const m = machines && machines.get(name);
      const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
      if (sock) return { machine: name, sock };
    }
    return { machine: candidates[0] || '', sock: null };
  }

  function onColabStatus(machineName, status = {}) {
    const mName = cleanStr(machineName, 60);
    if (!mName || !status || typeof status !== 'object') return;
    const available = Boolean(status.available);
    const balanceCcu = Number.isFinite(Number(status.balanceCcu)) ? Number(status.balanceCcu) : null;
    const burnRatePerHour = Number.isFinite(Number(status.burnRatePerHour)) ? Number(status.burnRatePerHour) : null;
    const activeRuntimes = Number.isFinite(Number(status.activeRuntimes)) ? Math.max(0, Math.trunc(Number(status.activeRuntimes))) : 0;
    const at = Number(status.at) || Date.now();
    const errTxt = cleanStr(status.error || '', 160);
    const note = available
      ? `网关机 ${mName} · 剩余 ${balanceCcu != null ? balanceCcu.toFixed(2) : '—'} CCU · 消耗 ${burnRatePerHour != null ? burnRatePerHour.toFixed(2) : '0.00'}/h · 活动运行时 ${activeRuntimes}`
      : `网关机 ${mName} · Colab CLI 不可用${errTxt ? `（${errTxt}）` : ''}`;
    computeQueue.registerProvider({
      id: 'colab',
      name: 'Google Colab (WSL CLI)',
      status: available ? 'active' : 'offline',
      note,
      meta: {
        machine: mName,
        available,
        balanceCcu,
        burnRatePerHour,
        activeRuntimes,
        error: errTxt,
        at,
      },
    });
    computeQueue.reconcile();
    onChange();
  }

  function dispatchRemoteComputeJob(job) {
    if (!job || !job.command) return;
    if (job.providerType === 'colab') {
      const { machine: gwMachine, sock } = resolveColabGateway(job.machine);
      if (!sock) {
        computeQueue.complete(job.id, {
          ok: false,
          reason: `Google Colab 网关机 ${gwMachine || '(未就绪)'} 不在线或未开启远程控制，无法执行 Colab 作业`,
        });
        return;
      }
      if (gwMachine && job.machine !== gwMachine) job.machine = gwMachine;
      try {
        sock.send(JSON.stringify({
          t: 'colab-exec',
          jobId: job.id,
          gpu: job.colabGpu || 'A100',
          fallbackGpus: Array.isArray(job.fallbackGpus) ? job.fallbackGpus : ['L4', 'T4'],
          command: job.command,
          cwd: job.cwd || '',
          label: job.label || '',
          uploadPaths: Array.isArray(job.uploadPaths) ? job.uploadPaths : [],
          downloadPath: job.downloadPath || '',
          outputDir: job.outputDir || '',
          maxDurationMin: job.maxDurationMin || 120,
          minBalanceCcu: job.minBalanceCcu != null ? job.minBalanceCcu : 15,
        }));
      } catch (e) {
        computeQueue.complete(job.id, { ok: false, reason: '下发 Colab 作业失败：' + (e && e.message) });
      }
      return;
    }
    if (!job.machine) return;
    const m = machines && machines.get(job.machine);
    const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
    if (!sock) {
      computeQueue.complete(job.id, { ok: false, reason: `机器 ${job.machine} 不在线或未开启远程控制，无法执行远程算例` });
      return;
    }
    const env = {};
    if (Array.isArray(job.assignedGpus) && job.assignedGpus.length) {
      const gpuStr = job.assignedGpus.join(',');
      env.CUDA_VISIBLE_DEVICES = gpuStr;
      env.AME_ASSIGNED_GPUS = gpuStr;
    }
    if (Array.isArray(job.assignedNuma) && job.assignedNuma.length) {
      env.AME_ASSIGNED_NUMA = job.assignedNuma.join(',');
    }
    if (job.assignedCpus) env.AME_ASSIGNED_CPUS = job.assignedCpus;
    if (job.resource === 'cpu' && job.assignedCpuCount > 0 && Array.isArray(job.assignedNuma) && job.assignedNuma.length === 1) {
      env.OMP_NUM_THREADS = String(Math.max(1, Math.min(32, Math.floor(job.assignedCpuCount / 2) || job.assignedCpuCount)));
    }
    try {
      sock.send(JSON.stringify({
        t: 'compute-exec',
        jobId: job.id,
        command: job.command,
        cwd: job.cwd || '',
        label: job.label || '',
        env,
      }));
    } catch (e) {
      computeQueue.complete(job.id, { ok: false, reason: '下发远程作业失败：' + (e && e.message) });
    }
  }

  function cancelRemoteComputeJob(job) {
    if (!job) return;
    if (job.providerType === 'colab') {
      const { sock } = resolveColabGateway(job.machine);
      if (sock) {
        try { sock.send(JSON.stringify({ t: 'colab-kill', jobId: job.id })); } catch {}
      }
      return;
    }
    if (!job.machine) return;
    const m = machines && machines.get(job.machine);
    const sock = m && m.sockets && [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
    if (sock) {
      try { sock.send(JSON.stringify({ t: 'compute-kill', jobId: job.id })); } catch {}
    }
  }

  async function onComputeDone(machineName, d = {}) {
    const jobId = cleanStr(d.jobId, 60);
    if (!jobId) return;
    const exitCode = Number.isFinite(Number(d.exitCode)) ? Number(d.exitCode) : 1;
    const ok = exitCode === 0;
    const durationMs = Math.max(0, Number(d.durationMs) || 0);
    const tail = typeof d.tail === 'string' ? d.tail.slice(-2000) : '';
    const r = computeQueue.complete(jobId, {
      ok,
      reason: ok ? '' : (cleanStr(d.error, 160) || `exit ${exitCode}`),
      exitCode,
      durationMs,
      tail,
    });
    const job = r && r.job;
    if (job && job.projectId) {
      try {
        await emitEvent({
          source: 'run',
          kind: ok ? 'exit_ok' : 'exit_err',
          machine: machineName || job.machine,
          projectId: job.projectId,
          nodeId: job.nodeId || '',
          label: job.label || job.command.slice(0, 60),
          exitCode,
          durationMs,
          tail,
          cwd: job.cwd || '',
        });
      } catch {}
    }
  }

  const computeQueue = createComputeQueue({
    dataDir,
    getMachineProbe: (mName) => (machines && machines.get(mName) && machines.get(mName).computeProbe) || null,
    onDispatchRemote: dispatchRemoteComputeJob,
    onCancelRemote: cancelRemoteComputeJob,
    onChange: () => onChange(),
  });
  let data = { projects: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.projects)) data = raw;
  } catch {}

  const pendingSpawns = new Map(); // "machine|cwd" -> [{ projectId, nodeId, t0 }]

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
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

  // Send a control command (`send` / `launch` / `resume`) to a machine's agent
  function sendToAgent(machineName, payload) {
    if (typeof dispatchControl === 'function') return dispatchControl(machineName, payload);
    const m = machines && machines.get(machineName);
    if (!m || !m.online || !m.sockets || !m.sockets.size) {
      return Promise.resolve({ ok: false, msg: `机器「${machineName}」不在线` });
    }
    const sock = [...m.sockets].reverse().find((s) => s.readyState === 1 && s.remoteControlAllowed === true);
    if (!sock) return Promise.resolve({ ok: false, msg: `机器「${machineName}」未开启远程控制` });
    const rid = 'mesh-' + crypto.randomBytes(10).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingActions.delete(rid)) resolve({ ok: false, msg: '机器响应超时' });
      }, 20000);
      if (timer.unref) timer.unref();
      pendingActions.set(rid, { machine: machineName, resolve, timer });
      try {
        sock.send(JSON.stringify({ ...payload, rid }));
      } catch {
        clearTimeout(timer);
        pendingActions.delete(rid);
        resolve({ ok: false, msg: '发送控制指令失败' });
      }
    });
  }

  const pendingActions = new Map(); // rid -> { machine, resolve, timer }
  function fromAgentResult(machineName, d) {
    if (!d || typeof d.rid !== 'string' || !d.rid.startsWith('mesh-')) return false;
    const p = pendingActions.get(d.rid);
    if (!p || p.machine !== machineName) return true;
    clearTimeout(p.timer);
    pendingActions.delete(d.rid);
    const res = { ok: !!d.ok, msg: cleanStr(d.msg, 200) };
    if (d.worktreePath !== undefined) res.worktreePath = cleanStr(String(d.worktreePath || ''), 500);
    if (d.worktreeBranch !== undefined) res.worktreeBranch = cleanStr(String(d.worktreeBranch || ''), 120);
    if (d.worktreeParentRepo !== undefined) res.worktreeParentRepo = cleanStr(String(d.worktreeParentRepo || ''), 500);
    if (d.dirty !== undefined) res.dirty = !!d.dirty;
    if (d.unmergedCommits !== undefined) res.unmergedCommits = +d.unmergedCommits || 0;
    if (d.summary !== undefined) res.summary = cleanStr(String(d.summary || ''), 1000);
    if (d.gitBaseline && typeof d.gitBaseline === 'object' && d.gitBaseline.isGit) {
      const files = Array.isArray(d.gitBaseline.changedFiles)
        ? d.gitBaseline.changedFiles.map((x) => cleanStr(String(x || ''), 300)).filter(Boolean).slice(0, 200)
        : [];
      const fp = {};
      if (d.gitBaseline.fingerprints && typeof d.gitBaseline.fingerprints === 'object') {
        for (const f of files) {
          const v = d.gitBaseline.fingerprints[f];
          if (typeof v === 'string' && v.length <= 64) fp[f] = v;
        }
      }
      res.gitBaseline = { checked: true, isGit: true, changedFiles: files, fingerprints: fp };
    }
    p.resolve(res);
    return true;
  }

  // Ensure a matching group exists in 糖糖看板 (session-marks.js) and bind all session keys in the project to it
  function syncMarksGroup(proj) {
    if (!marks) return;
    const allGroups = marks.get().groups || [];
    let grp = proj.groupId ? allGroups.find((g) => g.id === proj.groupId) : null;
    if (!grp) {
      grp = allGroups.find((g) => g.name === proj.name);
      if (!grp) {
        const r = marks.group({ op: 'add', name: proj.name });
        if (r && r.ok && r.group) grp = r.group;
      }
      if (grp) proj.groupId = grp.id;
    } else if (grp.name !== proj.name) {
      marks.group({ op: 'rename', id: grp.id, name: proj.name });
    }
    if (!proj.groupId) return;
    for (const n of proj.nodes || []) {
      if (n.sessionId && n.machine) {
        const key = `${n.machine}|${n.sessionId}`;
        marks.set({ key, group: proj.groupId, ...(n.role === 'master' ? { pinned: true } : {}) });
      }
    }
  }

  // Live session status lookup from `machines` or `store`
  function liveSessionOf(machineName, sessionId) {
    if (!machineName || !sessionId) return null;
    const m = machines && machines.get(machineName);
    const live = m && m.sessions && m.sessions.get(sessionId);
    if (live) {
      const lastLine = [...(live.lines || [])].reverse().find((l) => l && l.text);
      const asking = (live.perms && live.perms.length > 0) || (live.state === 'waiting' && lastLine && /需要确认|等待权限/.test(lastLine.text));
      return {
        online: !!m.online,
        state: live.state || 'idle',
        asking,
        label: live.label || '',
        model: live.model || '',
        lastAct: lastLine ? lastLine.text : '',
        last: live.last || 0,
        via: live.via || 'off',
      };
    }
    const saved = store && store.sessions && (store.sessions()[machineName] || []).find((x) => x.id === sessionId);
    if (saved) {
      return {
        online: !!(m && m.online),
        state: 'history',
        asking: false,
        label: saved.title || saved.project || '',
        lastAct: '（会话已关闭，可唤醒续聊）',
        last: saved.last || 0,
        via: 'resume',
      };
    }
    return null;
  }

  // Enrich a project with live session states and VFS catalog snapshots for its workspaces
  function enrichProject(proj) {
    const workspaces = (proj.workspaces || []).map((w) => {
      const cat = fsCatalog ? fsCatalog.get(w.machine, w.path) : null;
      return {
        ...w,
        tag: (cat && cat.tag) || w.tag || '',
        tagLabel: (cat && fsCatalog.TAG_LABELS && fsCatalog.TAG_LABELS[cat.tag]) || (cat && cat.tag) || w.tag || '',
        userNote: (cat && cat.userNote) || '',
        aiNote: (cat && cat.aiNote) || '',
        snapshot: (cat && cat.snapshot) || null,
      };
    });
    const nodes = (proj.nodes || []).map((n) => {
      const live = liveSessionOf(n.machine, n.sessionId);
      return {
        ...n,
        key: n.sessionId ? `${n.machine}|${n.sessionId}` : '',
        liveState: live ? live.state : (n.sessionId ? 'offline' : 'spawning'),
        asking: live ? live.asking : false,
        label: (live && live.label) || n.alias || n.id,
        model: n.model || (live && live.model) || '',
        lastAct: (live && live.lastAct) || n.lastAct || '',
        last: (live && live.last) || n.updatedAt || proj.createdAt,
      };
    });
    return {
      ...proj,
      workspaces,
      nodes,
      tasks: proj.tasks || [],
      channels: board.getChannels(proj.id),
      boardSeq: board.latestSeq(proj.id),
      triggers: proj.triggers || [],
      events: (proj.events || []).slice(-50),
    };
  }

  function listProjects() {
    return data.projects.map(enrichProject);
  }

  function getProject(id) {
    const p = data.projects.find((x) => x.id === id);
    return p ? enrichProject(p) : null;
  }

  // Find which project and node a given (machine, sessionId) or nodeId belongs to
  function findBySession(machineName, sessionId) {
    for (const p of data.projects) {
      const node = (p.nodes || []).find((n) =>
        (n.machine === machineName && n.sessionId === sessionId) || n.id === sessionId || n.alias === sessionId
      );
      if (node) return { project: p, node };
    }
    return null;
  }

  // Resolve caller project and node using explicit ids, session, or machine + cwd fallback
  function resolveCaller({ projectId, nodeId, machine, sessionId, callerCwd } = {}) {
    const proj = projectId ? data.projects.find((x) => x.id === projectId) || null : null;
    if (projectId && !proj) return { project: null, node: null };

    // a) If projectId and nodeId match an existing project & node (by id or alias)
    if (proj && nodeId) {
      const node = (proj.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId) || null;
      if (node) return { project: proj, node };
    }

    // b) If nodeId alone matches a node across data.projects (when projectId is omitted)
    if (!projectId && nodeId) {
      for (const p of data.projects) {
        const node = (p.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId);
        if (node) return { project: p, node };
      }
    }

    // c) If machine and sessionId are non-empty, try findBySession (or within proj if specified)
    if (machine && sessionId) {
      if (proj) {
        const node = (proj.nodes || []).find((n) =>
          (n.machine === machine && n.sessionId === sessionId) || n.id === sessionId || n.alias === sessionId
        ) || null;
        if (node) return { project: proj, node };
      } else {
        const found = findBySession(machine, sessionId);
        if (found) return found;
      }
    }

    // d) Fallback by machine + callerCwd
    if (machine && callerCwd) {
      const normCaller = normFolderPath(callerCwd);
      const searchProjs = proj ? [proj] : data.projects;
      const candidates = [];
      for (const p of searchProjs) {
        for (const n of p.nodes || []) {
          if (n.machine !== machine) continue;
          const cwdMatch = n.cwd
            ? (normFolderPath(n.cwd) === normCaller || isSubPath(n.cwd, callerCwd))
            : Boolean(proj && n.role === 'master');
          if (cwdMatch) {
            candidates.push({ project: p, node: n });
          }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => {
          // Spawned workers receive AME_NODE_ID and match in branch (a)/(b);
          // an un-identified caller in a shared directory is usually the Master session.
          const aMaster = a.node.role === 'master' ? 1 : 0;
          const bMaster = b.node.role === 'master' ? 1 : 0;
          if (bMaster !== aMaster) return bMaster - aMaster;
          const aExact = normFolderPath(a.node.cwd) === normCaller ? 1 : 0;
          const bExact = normFolderPath(b.node.cwd) === normCaller ? 1 : 0;
          if (bExact !== aExact) return bExact - aExact;
          const aRun = a.node.reviewStatus === 'running' ? 1 : 0;
          const bRun = b.node.reviewStatus === 'running' ? 1 : 0;
          if (bRun !== aRun) return bRun - aRun;
          return (b.node.updatedAt || 0) - (a.node.updatedAt || 0);
        });
        return candidates[0];
      }
    }

    return { project: proj, node: null };
  }

  function summarizeSnapshot(snap, includeTree = false) {
    if (!snap || typeof snap !== 'object') return null;
    if (includeTree) return snap;
    return {
      sep: snap.sep,
      freeBytes: snap.freeBytes,
      totalBytes: snap.totalBytes,
      gitBranch: snap.gitBranch ?? null,
      count: snap.count || 0,
      truncated: !!snap.truncated,
      scannedAt: snap.scannedAt || 0,
    };
  }

  function summarizeCatalogItem(item, includeTree = false) {
    if (!item || typeof item !== 'object') return item;
    return {
      ...item,
      snapshot: summarizeSnapshot(item.snapshot, includeTree),
    };
  }

  const NOISE_CWD_RE = /^(?:\/tmp(?:\/|$)|\/var\/tmp|[a-z]:\/windows\/system32|[a-z]:\/users\/[^/]+(?:\/desktop|\/downloads|\/documents\/codex|\/appdata\/local\/temp|\/appdata\/roaming\/claude\/scratch-workspaces|\/\.claude\/projects)(?:\/|$)|.*\/\.claude\/worktrees\/|.*\/\.ame-worktrees\/|.*\/ame-(?:launch|mode|key|perm)test)/i;

  function collectAvailableFolders(includeTree = false) {
    const out = [];
    const seen = new Set();
    const addKey = (m, p) => `${m}|${normFolderPath(p)}`;

    if (fsCatalog) {
      for (const item of fsCatalog.list()) {
        if (!item || !item.machine || !item.path) continue;
        const k = addKey(item.machine, item.path);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(summarizeCatalogItem(item, includeTree));
      }
    }

    for (const p of data.projects) {
      for (const w of p.workspaces || []) {
        if (!w || !w.machine || !w.path) continue;
        const k = addKey(w.machine, w.path);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          key: k,
          machine: w.machine,
          path: w.path,
          tag: w.tag || '',
          userNote: '',
          aiNote: '',
          source: 'project_workspace',
          projectId: p.id,
          projectName: p.name,
          snapshot: null,
        });
      }
    }

    if (store && typeof store.sessions === 'function') {
      const allByMachine = store.sessions() || {};
      for (const [mName, list] of Object.entries(allByMachine)) {
        if (!Array.isArray(list)) continue;
        let added = 0;
        const sorted = [...list].sort((a, b) => (b.last || 0) - (a.last || 0));
        for (const s of sorted) {
          if (added >= 15) break;
          const rawCwd = s && (s.cwd || (store.info && store.info(mName, s.id)?.cwd));
          if (!rawCwd || typeof rawCwd !== 'string') continue;
          const normSlash = rawCwd.replace(/\\/g, '/').replace(/\/$/, '');
          if (NOISE_CWD_RE.test(normSlash)) continue;
          const k = addKey(mName, rawCwd);
          if (seen.has(k)) continue;
          seen.add(k);
          added++;
          out.push({
            key: k,
            machine: mName,
            path: rawCwd,
            tag: '',
            userNote: '',
            aiNote: '',
            source: 'recent_session',
            lastUsedAt: s.last || 0,
            snapshot: null,
          });
        }
      }
    }
    return out;
  }

  // ---------- Global Skills store (builtin mesh-skills & repo skills/*/SKILL.md + dataDir/mesh-skills/*/SKILL.md) ----------
  const builtinSkillsDirs = [
    path.join(__dirname, 'mesh-skills'),
    path.resolve(__dirname, '../../skills'),
  ];
  const userSkillsDir = path.join(dataDir, 'mesh-skills');
  const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

  function findBuiltinSkillPath(name) {
    for (const dir of builtinSkillsDirs) {
      const p = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  function parseSkillDescription(raw) {
    const src = String(raw || '');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
    if (fm) {
      const m = /^description:\s*(?:>\s*\r?\n([\s\S]*?)(?:\r?\n[a-zA-Z0-9_-]+:|$)|(.+))$/m.exec(fm[1]);
      if (m) {
        return cleanStr((m[1] || m[2] || '').replace(/\s+/g, ' ').trim(), 240);
      }
    }
    const h1 = /^#\s+(.+)$/m.exec(src);
    return h1 ? cleanStr(h1[1], 240) : '';
  }

  function listSkills() {
    const names = new Set();
    const scanDir = (dir) => {
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!ent.isDirectory() || !SKILL_NAME_RE.test(ent.name)) continue;
          if (fs.existsSync(path.join(dir, ent.name, 'SKILL.md'))) names.add(ent.name);
        }
      } catch {}
    };
    for (const dir of builtinSkillsDirs) scanDir(dir);
    scanDir(userSkillsDir);
    return [...names].sort().map((name) => {
      const builtinPath = findBuiltinSkillPath(name);
      const userPath = path.join(userSkillsDir, name, 'SKILL.md');
      const hasBuiltin = Boolean(builtinPath);
      const hasUser = fs.existsSync(userPath);
      const activePath = hasUser ? userPath : builtinPath;
      let raw = '';
      let updatedAt = 0;
      try {
        raw = fs.readFileSync(activePath, 'utf8');
        updatedAt = Math.trunc(fs.statSync(activePath).mtimeMs);
      } catch {}
      return {
        name,
        description: parseSkillDescription(raw),
        raw,
        builtin: hasBuiltin,
        overridden: hasBuiltin && hasUser,
        updatedAt,
      };
    });
  }

  function saveSkill(name, raw) {
    const cleanName = String(name || '').trim().toLowerCase();
    if (!SKILL_NAME_RE.test(cleanName)) {
      return { ok: false, msg: 'Skill 名称须为小写字母/数字/连字符/下划线（1~48 字符）' };
    }
    const content = String(raw || '');
    if (!content.trim() || content.length > 100000) {
      return { ok: false, msg: 'Skill 内容不能为空且不超过 100 KB' };
    }
    try {
      const dir = path.join(userSkillsDir, cleanName);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, 'SKILL.md');
      fs.writeFileSync(target + '.tmp', content, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(target + '.tmp', target);
      const skills = listSkills();
      return { ok: true, skill: skills.find((s) => s.name === cleanName) || null, skills };
    } catch (e) {
      return { ok: false, msg: '保存 Skill 失败：' + e.message };
    }
  }

  function resetSkill(name) {
    const cleanName = String(name || '').trim().toLowerCase();
    if (!SKILL_NAME_RE.test(cleanName)) return { ok: false, msg: '无效的 Skill 名称' };
    try {
      const dir = path.join(userSkillsDir, cleanName);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, skills: listSkills() };
    } catch (e) {
      return { ok: false, msg: '还原/删除 Skill 失败：' + e.message };
    }
  }

  // ---------- CLI update signals (machine|tool -> { machine, tool, detail, at }) ----------
  const cliUpdatesFile = path.join(dataDir, 'mesh-cli-updates.json');
  function loadCliUpdates() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cliUpdatesFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  let cliUpdatesMap = loadCliUpdates();
  function persistCliUpdates() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(cliUpdatesFile + '.tmp', JSON.stringify(cliUpdatesMap, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(cliUpdatesFile + '.tmp', cliUpdatesFile);
    } catch {}
  }
  function onCliUpdate(machineName, d = {}) {
    const mach = cleanStr(machineName, 60);
    const tool = cleanStr(d.tool, 32).toLowerCase();
    if (!mach || !tool) return;
    const key = `${mach}|${tool}`;
    cliUpdatesMap[key] = {
      machine: mach,
      tool,
      detail: cleanStr(d.detail, 160) || 'Update available',
      at: Number(d.at) || Date.now(),
    };
    persistCliUpdates();
  }
  function listCliUpdates() {
    return Object.values(cliUpdatesMap).sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  function clearCliUpdate({ machine = '', tool = '' } = {}) {
    const m = cleanStr(machine, 60);
    const t = cleanStr(tool, 32).toLowerCase();
    if (m && t) delete cliUpdatesMap[`${m}|${t}`];
    else if (m) { for (const k of Object.keys(cliUpdatesMap)) if (k.startsWith(m + '|')) delete cliUpdatesMap[k]; }
    else cliUpdatesMap = {};
    persistCliUpdates();
    return { ok: true, updates: listCliUpdates() };
  }

  // ---------- Machine role & hardware profiles (dataDir/mesh-machine-profiles.json) ----------
  const machineProfilesFile = path.join(dataDir, 'mesh-machine-profiles.json');
  function loadMachineProfiles() {
    try {
      const parsed = JSON.parse(fs.readFileSync(machineProfilesFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  let machineProfiles = loadMachineProfiles();
  function persistMachineProfiles() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(machineProfilesFile + '.tmp', JSON.stringify(machineProfiles, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(machineProfilesFile + '.tmp', machineProfilesFile);
    } catch {}
  }

  function saveMachineProfile({ machine, role = '', hardware = '', software = '', note = '' } = {}) {
    const mName = cleanStr(machine, 60);
    if (!mName) return { ok: false, msg: '缺少机器名' };
    machineProfiles[mName] = {
      role: cleanStr(role, 120),
      hardware: cleanStr(hardware, 240),
      software: cleanStr(software, 400),
      note: cleanStr(note, 1000),
      updatedAt: Date.now(),
    };
    persistMachineProfiles();
    return { ok: true, profile: machineProfiles[mName], machines: machinesSummary() };
  }

  function computeSummaryForMachine(mName, liveMachine) {
    const probe = (liveMachine && liveMachine.computeProbe) || null;
    const topo = computeQueue.topologyFor(mName);
    const qList = computeQueue.list({ machine: mName });
    const allJobs = (qList && Array.isArray(qList.jobs)) ? qList.jobs : [];
    const runningJobs = allJobs.filter((j) => j.status === 'running');
    const queuedJobs = allJobs.filter((j) => j.status === 'queued');
    const occupiedGpus = [];
    for (const j of runningJobs) {
      if (j.resource === 'gpu' && Array.isArray(j.assignedGpus)) {
        for (const idx of j.assignedGpus) if (!occupiedGpus.includes(idx)) occupiedGpus.push(idx);
      }
    }
    const probeGpus = Array.isArray(probe && probe.gpus) ? probe.gpus : [];
    const gpus = probeGpus.length
      ? probeGpus.map((g) => ({
          index: g.index,
          name: g.name || '',
          memUsedMiB: g.memUsedMiB || 0,
          memTotalMiB: g.memTotalMiB || 0,
          utilPct: g.utilPct || 0,
          busy: Boolean(g.busy),
          numaNode: Number.isInteger(g.numaNode) ? g.numaNode : null,
          managedBy: (runningJobs.find((j) => j.resource === 'gpu' && Array.isArray(j.assignedGpus) && j.assignedGpus.includes(g.index)) || {}).id || '',
        }))
      : topo.gpus.map((g) => ({
          index: g.index,
          name: g.name || '',
          memUsedMiB: 0,
          memTotalMiB: 0,
          utilPct: 0,
          busy: Boolean(g.busy),
          numaNode: g.numaNode,
          managedBy: (runningJobs.find((j) => j.resource === 'gpu' && Array.isArray(j.assignedGpus) && j.assignedGpus.includes(g.index)) || {}).id || '',
        }));
    return {
      hasGpu: Boolean((probe && probe.hasGpu) || probeGpus.length > 0),
      gpus,
      cpuCount: (probe && probe.cpuCount) || (probe && probe.cores) || 0,
      cpuBusy: Boolean(probe && probe.cpuBusy),
      load1: (probe && probe.load1) || 0,
      numaCount: topo.numaNodes.length,
      runningCount: runningJobs.length,
      queuedCount: queuedJobs.length,
      occupiedGpus,
      probeAt: (probe && probe.at) || 0,
    };
  }

  function computeDirsForMachine(mName) {
    const out = [];
    const seen = new Set();
    if (fsCatalog && typeof fsCatalog.list === 'function') {
      for (const f of fsCatalog.list()) {
        if (!f || f.machine !== mName || !f.path) continue;
        const k = normFolderPath(f.path);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          path: f.path,
          tag: f.tag || '',
          gitBranch: (f.snapshot && f.snapshot.gitBranch) || '',
        });
        if (out.length >= 12) break;
      }
    }
    return out;
  }

  function machinesSummary() {
    const seen = new Set();
    const list = [];
    if (machines) {
      for (const m of machines.values()) {
        seen.add(m.name);
        const clients = Array.isArray(m.mcpStatus && m.mcpStatus.clients) ? m.mcpStatus.clients : [];
        const harnesses = clients.filter((c) => c && c.present && c.id).map((c) => c.id);
        const meshReadyHarnesses = clients
          .filter((c) => c && c.present && c.id && Array.isArray(c.servers) && c.servers.includes('ame-mesh'))
          .map((c) => c.id);
        const prof = machineProfiles[m.name] || {};
        list.push({
          machine: m.name,
          online: !!m.online,
          control: !!m.control,
          files: !!m.files,
          harnesses,
          meshReadyHarnesses,
          role: prof.role || '',
          hardware: prof.hardware || '',
          software: prof.software || '',
          note: prof.note || '',
          compute: computeSummaryForMachine(m.name, m),
          computeDirs: computeDirsForMachine(m.name),
          updatedAt: prof.updatedAt || 0,
        });
      }
    }
    for (const [mName, prof] of Object.entries(machineProfiles)) {
      if (seen.has(mName)) continue;
      list.push({
        machine: mName,
        online: false,
        control: false,
        files: false,
        harnesses: [],
        meshReadyHarnesses: [],
        role: (prof && prof.role) || '',
        hardware: (prof && prof.hardware) || '',
        software: (prof && prof.software) || '',
        note: (prof && prof.note) || '',
        compute: computeSummaryForMachine(mName, null),
        computeDirs: computeDirsForMachine(mName),
        updatedAt: (prof && prof.updatedAt) || 0,
      });
    }
    return list;
  }

  // Scoped topology view for an agent session: ONLY returns the project & connected nodes it belongs to
  function scopedViewFor({ projectId, nodeId, machine, sessionId, callerCwd, includeTree = false }) {
    const { project: proj, node: selfNode } = resolveCaller({ projectId, nodeId, machine, sessionId, callerCwd });
    const roleCatalog = roleStore.catalog();
    const pools = modelRouter.getPoolsSummary();
    const machList = machinesSummary();
    if (!proj) {
      // Return compact project list + summarized folders (without bulky snapshot.tree by default)
      return {
        ok: true,
        project: null,
        self: null,
        callerCwd: callerCwd || '',
        projects: data.projects.map((p) => ({
          id: p.id,
          name: p.name,
          workspacesCount: (p.workspaces || []).length,
          nodesCount: (p.nodes || []).length,
          workspacesLocked: !!p.workspacesLocked,
          workspaces: (p.workspaces || []).map((w) => ({ machine: w.machine, path: w.path, mode: w.mode })),
        })),
        roleCatalog,
        pools,
        availableFolders: collectAvailableFolders(!!includeTree),
        machines: machList,
      };
    }
    const enriched = enrichProject(proj);
    const projectView = includeTree
      ? enriched
      : { ...enriched, workspaces: (enriched.workspaces || []).map((w) => ({ ...w, snapshot: summarizeSnapshot(w.snapshot, false) })) };
    return {
      ok: true,
      project: projectView,
      self: selfNode ? projectView.nodes.find((n) => n.id === selfNode.id) : null,
      roleCatalog,
      pools,
      machines: machList,
    };
  }

  // Create or update a collaborative project
  function saveProject(d) {
    const name = cleanStr(d.name, 60);
    let proj = d.id ? data.projects.find((x) => x.id === d.id) : null;
    if (!proj) {
      if (!name) return { ok: false, msg: '项目名称不能为空' };
      if (data.projects.length >= MAX_PROJECTS) return { ok: false, msg: '项目数量已达上限' };
      proj = {
        id: idGen('proj'),
        name,
        desc: cleanStr(d.desc, 500),
        groupId: '',
        autoResumeMaster: d.autoResumeMaster !== false, // default true: auto wake master on report
        workspaces: [],
        workspacesLocked: !!d.workspacesLocked,
        nodes: [],
        edges: [],
        tasks: [],
        transfers: [],
        triggers: [],
        events: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.projects.unshift(proj);
    } else {
      if (!Array.isArray(proj.tasks)) proj.tasks = [];
      if (name) proj.name = name;
      if (typeof d.desc === 'string') proj.desc = cleanStr(d.desc, 500);
      if (typeof d.autoResumeMaster === 'boolean') proj.autoResumeMaster = d.autoResumeMaster;
      if (typeof d.workspacesLocked === 'boolean') proj.workspacesLocked = d.workspacesLocked;
      proj.updatedAt = Date.now();
    }
    if (Array.isArray(d.workspaces)) {
      proj.workspaces = d.workspaces
        .filter((w) => w && typeof w.machine === 'string' && typeof w.path === 'string' && w.machine && w.path)
        .slice(0, 40)
        .map((w) => ({
          machine: cleanStr(w.machine, 60),
          path: cleanStr(w.path, 500),
          mode: w.mode === 'ro' ? 'ro' : 'rw',
          tag: cleanStr(w.tag, 40),
        }));
    }
    syncMarksGroup(proj);
    save();
    return { ok: true, project: enrichProject(proj) };
  }

  function deleteProject(id) {
    const idx = data.projects.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, msg: '找不到该项目' };
    data.projects.splice(idx, 1);
    board.removeProject(id);
    save();
    return { ok: true };
  }

  function compactProjectForRpc(proj) {
    if (!proj || typeof proj !== 'object') return proj;
    return {
      id: proj.id,
      name: proj.name,
      groupId: proj.groupId || '',
      workspacesLocked: !!proj.workspacesLocked,
      boardSeq: proj.boardSeq || 0,
      workspaces: (proj.workspaces || []).map((w) => ({
        machine: w.machine,
        path: w.path,
        mode: w.mode,
        tag: w.tag || '',
      })),
      nodes: (proj.nodes || []).map((n) => ({
        id: n.id,
        machine: n.machine,
        sessionId: n.sessionId || '',
        alias: n.alias || '',
        role: n.role || 'worker',
        tool: n.tool || '',
        pool: n.pool || '',
        model: n.model || '',
        cwd: n.cwd || '',
        workspaceMode: n.workspaceMode || 'inherit',
        worktreeBranch: n.worktreeBranch || '',
        reviewStatus: n.reviewStatus || 'running',
        liveState: n.liveState || '',
        lastReport: n.lastReport || '',
      })),
      edges: proj.edges || [],
      tasks: proj.tasks || [],
      channels: proj.channels || [],
      eventsCount: (proj.events || []).length,
      transfersCount: (proj.transfers || []).length,
      triggersCount: (proj.triggers || []).length,
    };
  }

  // Master-only one-shot workspace fence setup with automatic locking (immutable unless explicitly userApproved)
  function configureWorkspaces({
    projectId,
    projectName,
    workspaces,
    lock = true,
    userApproved = false,
    reason = '',
    fromNodeId,
    fromMachine,
    fromSessionId,
    callerCwd,
  } = {}) {
    const resolved = resolveCaller({
      projectId,
      nodeId: fromNodeId,
      machine: fromMachine,
      sessionId: fromSessionId,
      callerCwd,
    });
    if (resolved.node && resolved.node.role !== 'master') {
      return { ok: false, msg: '仅 Master 主控节点有权配置项目工作区安全围栏' };
    }
    let proj = resolved.project || (projectId ? data.projects.find((x) => x.id === projectId) : null);
    if (!proj) {
      const r = saveProject({ name: projectName || `协同项目 ${new Date().toISOString().slice(5, 10)}` });
      if (!r.ok) return r;
      proj = data.projects.find((x) => x.id === r.project.id);
    }
    if (!proj) return { ok: false, msg: '找不到所属项目' };

    if (proj.workspacesLocked === true && userApproved !== true) {
      return {
        ok: false,
        locked: true,
        msg: '项目工作区安全围栏已锁定（workspacesLocked=true）。除非获得用户明确授意并传入 userApproved=true 与 reason，否则禁止改动或扩权。',
      };
    }

    if (!Array.isArray(workspaces) || !workspaces.length) {
      return { ok: false, msg: 'workspaces 不能为空数组，请提供至少一个 { machine, path, mode } 规则' };
    }
    const cleaned = workspaces
      .filter((w) => w && typeof w.machine === 'string' && typeof w.path === 'string' && w.machine.trim() && w.path.trim())
      .slice(0, 40)
      .map((w) => ({
        machine: cleanStr(w.machine, 60),
        path: cleanStr(w.path, 500),
        mode: w.mode === 'ro' ? 'ro' : 'rw',
        tag: cleanStr(w.tag, 40),
      }));
    if (!cleaned.length) {
      return { ok: false, msg: 'workspaces 中没有有效的 { machine, path } 条目' };
    }

    const wasLocked = proj.workspacesLocked === true;
    proj.workspaces = cleaned;
    proj.workspacesLocked = lock !== false;
    proj.updatedAt = Date.now();

    // Auto-register calling session as Master only when explicit fromSessionId is provided (never guess unrelated sessions)
    if (!resolved.node && fromMachine && fromSessionId) {
      upsertNode(proj.id, {
        machine: fromMachine,
        sessionId: fromSessionId,
        role: 'master',
        alias: '主控会话',
        cwd: callerCwd || '',
      });
    }

    const fenceList = cleaned.map((w) => `${w.machine}:${w.path} (${w.mode})`).join('；');
    const cleanReason = cleanStr(reason, 200);
    const noteText = wasLocked
      ? `[安全围栏已按用户授意更新并${proj.workspacesLocked ? '重新锁定' : '解锁'}] 原因：${cleanReason || '用户明确授意'}\n允许范围：${fenceList}`
      : `[项目安全围栏已由 Master 初始化并${proj.workspacesLocked ? '锁定' : '暂未锁定'}]\n允许范围：${fenceList}`;
    board.append(proj.id, {
      channel: 'main',
      kind: wasLocked ? 'control' : 'brief',
      agent: (resolved.node && (resolved.node.alias || resolved.node.id)) || 'Master',
      nodeId: resolved.node ? resolved.node.id : '',
      text: noteText,
      control: wasLocked ? { op: 'workspaces_update', locked: proj.workspacesLocked, reason: cleanReason } : undefined,
    });
    save();
    return {
      ok: true,
      workspaces: proj.workspaces,
      workspacesLocked: proj.workspacesLocked,
      project: enrichProject(proj),
      msg: proj.workspacesLocked ? '安全围栏已配置并锁定（后续除非用户明确授意，不再允许改动）' : '安全围栏已配置',
    };
  }

  // Check if a folder path on a machine is permitted by the project's workspace scope
  // (If the project has explicit workspaces configured, enforce them; if empty, allow and auto-register)
  function checkWorkspaceAccess(proj, machineName, folderPath, needWrite = false) {
    if (!proj.workspaces || !proj.workspaces.length) return { ok: true };
    const matched = proj.workspaces.filter((w) => w.machine === machineName && isSubPath(w.path, folderPath));
    if (!matched.length) {
      return { ok: false, msg: `路径「${machineName}:${folderPath}」不在项目「${proj.name}」分配的允许访问文件夹范围内` };
    }
    // Innermost workspace rule wins
    matched.sort((a, b) => b.path.length - a.path.length);
    if (needWrite && matched[0].mode === 'ro') {
      return { ok: false, msg: `路径「${machineName}:${folderPath}」在项目「${proj.name}」中被设为只读（ro）` };
    }
    return { ok: true, workspace: matched[0] };
  }

  function inferToolFromSessionId(sid = '') {
    const s = String(sid || '');
    if (s.startsWith('agy:')) return 'agy';
    if (s.startsWith('codex:')) return 'codex';
    if (s.startsWith('opencode:')) return 'opencode';
    if (s.startsWith('kiro:')) return 'kiro';
    return 'claude';
  }

  // Bind an existing session or register a new node into a project's topology
  function upsertNode(projectId, d) {
    let proj = projectId ? data.projects.find((x) => x.id === projectId) : null;
    if (!proj && d.projectName) {
      const r = saveProject({ name: d.projectName });
      if (!r.ok) return r;
      proj = data.projects.find((x) => x.id === r.project.id);
    }
    if (!proj) return { ok: false, msg: '找不到所属项目' };
    if (proj.nodes.length >= MAX_NODES && !d.id) return { ok: false, msg: '项目节点数已达上限' };

    const machine = cleanStr(d.machine, 60);
    const sessionId = cleanStr(d.sessionId, 120);
    let node = (d.id && proj.nodes.find((n) => n.id === d.id)) ||
      (machine && sessionId && proj.nodes.find((n) => n.machine === machine && n.sessionId === sessionId));

    if (!node) {
      const roleVal = cleanStr(d.role, 32) || 'worker';
      const rawAlias = cleanStr(d.alias, 60);
      const inferredTool = TOOLS.includes(d.tool) ? d.tool : inferToolFromSessionId(sessionId);
      node = {
        id: cleanStr(d.id, 40) || idGen('node'),
        machine,
        sessionId,
        alias: rawAlias || (roleVal === 'master' ? 'master' : '协作节点'),
        role: roleVal,
        tool: inferredTool,
        pool: cleanStr(d.pool, 60),
        model: cleanStr(d.model, 120),
        cwd: cleanStr(d.cwd, 500),
        goal: cleanStr(d.goal, 1000),
        stopCondition: cleanStr(d.stopCondition, 1000),
        reviewStatus: 'running',
        archived: Boolean(d.archived),
        autoResumeClosed: d.autoResumeClosed !== false,
        inbox: [],
        lastReport: '',
        artifacts: [],
        lastReadSeq: 0,
        lastPostSeq: 0,
        lastMentionedSeq: 0,
        lastMentionedAt: 0,
        lastNudgedSeq: 0,
        wakeMode: d.wakeMode === 'all' ? 'all' : 'mentions',
        workspaceMode: d.workspaceMode === 'worktree' ? 'worktree' : 'inherit',
        worktreeBranch: cleanStr(d.worktreeBranch, 120),
        worktreeParentRepo: cleanStr(d.worktreeParentRepo, 500),
        worktreePath: cleanStr(d.worktreePath, 500),
        boundaries: normalizeStrArray(d.boundaries, 40, 300),
        doneWhen: normalizeStrArray(d.doneWhen, 30, 400),
        checks: normalizeStrArray(d.checks, 20, 300),
        updatedAt: Date.now(),
      };
      proj.nodes.push(node);
    } else {
      if (machine) node.machine = machine;
      if (sessionId) node.sessionId = sessionId;
      if (typeof d.alias === 'string' && d.alias.trim()) node.alias = cleanStr(d.alias, 60);
      if (typeof d.role === 'string' && d.role.trim()) node.role = cleanStr(d.role, 32);
      if (TOOLS.includes(d.tool)) node.tool = d.tool;
      if (typeof d.pool === 'string') node.pool = cleanStr(d.pool, 60);
      if (typeof d.model === 'string') node.model = cleanStr(d.model, 120);
      if (typeof d.cwd === 'string' && d.cwd.trim()) node.cwd = cleanStr(d.cwd, 500);
      if (typeof d.goal === 'string') node.goal = cleanStr(d.goal, 1000);
      if (typeof d.stopCondition === 'string') node.stopCondition = cleanStr(d.stopCondition, 1000);
      if (typeof d.reviewStatus === 'string') node.reviewStatus = cleanStr(d.reviewStatus, 40);
      if (typeof d.autoResumeClosed === 'boolean') node.autoResumeClosed = d.autoResumeClosed;
      if (d.wakeMode === 'all' || d.wakeMode === 'mentions') node.wakeMode = d.wakeMode;
      if (d.workspaceMode === 'worktree' || d.workspaceMode === 'inherit') node.workspaceMode = d.workspaceMode;
      if (typeof d.worktreeBranch === 'string') node.worktreeBranch = cleanStr(d.worktreeBranch, 120);
      if (typeof d.worktreeParentRepo === 'string') node.worktreeParentRepo = cleanStr(d.worktreeParentRepo, 500);
      if (typeof d.worktreePath === 'string') node.worktreePath = cleanStr(d.worktreePath, 500);
      if (Array.isArray(d.boundaries)) node.boundaries = normalizeStrArray(d.boundaries, 40, 300);
      if (Array.isArray(d.doneWhen)) node.doneWhen = normalizeStrArray(d.doneWhen, 30, 400);
      if (Array.isArray(d.checks)) node.checks = normalizeStrArray(d.checks, 20, 300);
      node.updatedAt = Date.now();
    }

    // Add edge if parentNodeId or peerNodeId is specified
    const fromId = cleanStr(d.fromNodeId, 40);
    if (fromId && fromId !== node.id && proj.nodes.some((n) => n.id === fromId)) {
      const edgeType = d.edgeType === 'cowork' || node.role === 'peer' ? 'cowork' : 'master-worker';
      const exists = proj.edges.some((e) => e.from === fromId && e.to === node.id);
      if (!exists && proj.edges.length < MAX_EDGES) {
        proj.edges.push({ from: fromId, to: node.id, type: edgeType });
      }
    }

    syncMarksGroup(proj);
    save();
    return { ok: true, node, project: enrichProject(proj) };
  }

  function removeNode(projectId, nodeId) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    proj.nodes = proj.nodes.filter((n) => n.id !== nodeId);
    proj.edges = proj.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    save();
    return { ok: true, project: enrichProject(proj) };
  }

  function addEdge(projectId, { from, to, type = 'cowork' }) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    if (from === to) return { ok: false, msg: '不能连接节点自身' };
    if (!proj.nodes.some((n) => n.id === from) || !proj.nodes.some((n) => n.id === to)) {
      return { ok: false, msg: '节点不存在' };
    }
    const existing = proj.edges.find((e) => (e.from === from && e.to === to) || (type === 'cowork' && e.from === to && e.to === from));
    if (existing) existing.type = type === 'master-worker' ? 'master-worker' : 'cowork';
    else proj.edges.push({ from, to, type: type === 'master-worker' ? 'master-worker' : 'cowork' });
    save();
    return { ok: true, project: enrichProject(proj) };
  }

  function removeEdge(projectId, { from, to }) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    proj.edges = proj.edges.filter((e) => !(e.from === from && e.to === to));
    save();
    return { ok: true, project: enrichProject(proj) };
  }

  // OpenCode TUI parses bare ASCII `@token` in prompts as local file/agent references and errors with
  // "No matching files, agents, or references" when no file matches. Convert standalone `@token` to fullwidth `＠token`
  // when dispatching prompts to OpenCode (mesh-board parseMentions accepts both `@` and `＠`).
  // Pick a whitespace-free @mention token for system-generated posts so regex parsing never truncates aliases with spaces
  function mentionTokenOf(node) {
    if (!node) return '@master';
    const alias = String(node.alias || '').trim();
    if (alias && !/\s/.test(alias)) return `@${alias}`;
    if (node.role === 'master') return '@master';
    return `@${node.id}`;
  }

  function sanitizeForOpenCode(text) {
    return String(text || '').replace(/(^|[\s([{"'（【「，。；：、！？])@([#A-Za-z0-9_\u4e00-\u9fa5-]+)/g, '$1＠$2');
  }

  function deliverPromptFor(tool, text) {
    return tool === 'opencode' ? sanitizeForOpenCode(text) : text;
  }

  // Deliver a message to a target node immediately if idle/closed(with autoResume), or queue in inbox if working
  async function deliverToNode(proj, targetNode, envelopeText, { forceWake = false, seq = 0 } = {}) {
    const inboxItem = (extra = {}) => ({
      id: idGen('msg'),
      text: envelopeText,
      at: Date.now(),
      ...(seq ? { seq } : {}),
      ...extra,
    });
    if (!targetNode.sessionId) {
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push(inboxItem());
      }
      save();
      return { ok: true, queued: true, msg: '节点正在启动中，消息已放入收件箱，启动完成后自动投递' };
    }

    const live = liveSessionOf(targetNode.machine, targetNode.sessionId);
    const state = live ? live.state : 'history';
    const isWorking = ['working', 'thinking', 'reading', 'message'].includes(state);
    const isAsking = live && live.asking;

    // If session is actively working or waiting on a permission card, queue in inbox for non-intrusive delivery on Stop
    if ((isWorking || isAsking) && !forceWake) {
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push(inboxItem());
      }
      save();
      return {
        ok: true,
        queued: true,
        msg: isAsking ? '目标会话正在等待权限确认，消息已存入收件箱' : '目标会话正在执行中，消息已存入收件箱，待本轮结束后自动注入',
      };
    }

    // If session is closed ('history' or 'ended'), check autoResume policy
    const isClosed = state === 'history' || state === 'ended' || !live;
    const allowAuto = targetNode.role === 'master' ? proj.autoResumeMaster !== false : targetNode.autoResumeClosed !== false;
    if (isClosed && !allowAuto && !forceWake) {
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push(inboxItem({ needsManualWake: true }));
      }
      save();
      return { ok: true, queued: true, manualWakeRequired: true, msg: '目标会话已关闭（设为手动唤醒），已在项目管理与看板挂起待唤醒提醒' };
    }

    // Session is idle/done (or closed with auto-resume enabled): `send` injects into terminal or triggers resumeHeadless!
    const safeEnvelope = deliverPromptFor(targetNode.tool, envelopeText);
    const r = await sendToAgent(targetNode.machine, { t: 'send', id: targetNode.sessionId, text: safeEnvelope });
    if (!r.ok) {
      // Queue on failure with needsManualWake so onMachineState does not drop it on the next tick
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push(inboxItem({ needsManualWake: true }));
      }
      save();
      return { ok: false, queued: true, msg: r.msg || '投递失败，已暂存至节点收件箱' };
    }
    if (watchdog) watchdog.onNodeCommand(proj.id, targetNode.id);
    if (seq) targetNode.lastNudgedSeq = Math.max(targetNode.lastNudgedSeq || 0, seq);
    targetNode.updatedAt = Date.now();
    save();
    return { ok: true, delivered: true, msg: isClosed ? '目标会话已关闭，已在后台自动唤醒并注入消息' : '已直接注入目标会话终端' };
  }

  function projectHarnessCounts(proj) {
    const counts = {};
    if (!proj || !Array.isArray(proj.nodes)) return counts;
    for (const n of proj.nodes) {
      if (!n || n.archived || n.reviewStatus === 'done') continue;
      const h = String(n.tool || '').trim();
      if (!h) continue;
      counts[h] = (counts[h] || 0) + 1;
    }
    return counts;
  }

  function getMaxPerHarness() {
    const cfg = watchdog ? watchdog.getConfig() : {};
    const claudeCap = Number(cfg.maxClaudePerProject);
    const out = {};
    if (Number.isFinite(claudeCap) && claudeCap > 0) out.claude = claudeCap;
    else if (cfg.maxClaudePerProject === undefined) out.claude = 2;
    return out;
  }

  function activeModelCounts() {
    const byHarness = {};
    const byCandidate = {};
    for (const p of data.projects) {
      for (const n of p.nodes || []) {
        if (!n || n.archived || n.reviewStatus !== 'running') continue;
        const h = String(n.tool || '').trim();
        if (!h) continue;
        byHarness[h] = (byHarness[h] || 0) + 1;
        const ck = `${h}|${String(n.model || '').trim()}`;
        byCandidate[ck] = (byCandidate[ck] || 0) + 1;
      }
    }
    return { byHarness, byCandidate };
  }

  function machineHarnesses(machineName) {
    const m = machines && machines.get(machineName);
    const clients = Array.isArray(m && m.mcpStatus && m.mcpStatus.clients) ? m.mcpStatus.clients : [];
    return clients.filter((c) => c && c.present && c.id).map((c) => c.id);
  }

  async function handleQuotaExhausted(proj, node, reason = 'quota') {
    if (!proj || !node) return;
    const prevKey = `${node.tool || 'claude'}|${node.model || ''}`;
    modelRouter.markCooldown(node.tool || 'claude', node.model || '', reason);
    const masterNode = (proj.nodes || []).find((n) => n.role === 'master' && n.id !== node.id);
    const masterMention = `${mentionTokenOf(masterNode)} `;

    if (node.pool) {
      const exclude = [prevKey];
      const relayCwd = node.cwd || ((proj.workspaces || []).find((w) => w.machine === node.machine) || {}).path || '';
      const roleDef = roleStore.get(node.role);
      const availHarnesses = machineHarnesses(node.machine);

      // Build rich cross-harness handoff context from live session lines, board history, and pending tasks
      const liveM = machines && machines.get(node.machine);
      const liveSess = liveM && liveM.sessions && node.sessionId ? liveM.sessions.get(node.sessionId) : null;
      const recentLines = liveSess && Array.isArray(liveSess.lines)
        ? liveSess.lines.filter((l) => l && l.text).slice(-10).map((l) => `  - ${String(l.text).slice(0, 180)}`)
        : [];
      const recentBoard = board.read(proj.id, { since: 0, limit: 12 }).entries || [];
      const boardSummary = recentBoard.slice(-6).map((e) => `  - #${e.seq} [${e.agent}]: ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      const myTasks = (proj.tasks || []).filter((t) => t.status !== 'done' && (!t.ownerNodeId || t.ownerNodeId === node.id));

      for (let attempt = 0; attempt < 10; attempt++) {
        const pick = modelRouter.selectCandidate(node.pool, {
          exclude,
          activeCounts: activeModelCounts(),
          availableHarnesses: availHarnesses.length ? availHarnesses : null,
          projectHarnessCounts: projectHarnessCounts(proj),
          maxPerHarness: getMaxPerHarness(),
        });
        if (!pick.ok || !pick.candidate) break;
        const fb = pick.candidate;
        const fbTool = TOOLS.includes(fb.harness) ? fb.harness : 'claude';
        const fbModel = fb.model || '';
        const fbKey = `${fb.harness}|${fbModel}`;

        await postBoard({
          projectId: proj.id,
          agent: '模型路由',
          kind: 'watchdog',
          text: `节点 ${node.alias || node.id} (${node.tool}${node.model ? ':' + node.model : ''}) 命中额度/限流熔断（${cleanStr(reason, 80)}），自动回落至 ${fbTool}${fbModel ? ':' + fbModel : ''}（模型池 ${node.pool}）接力执行。`,
          skipWake: true,
        });

        if (!relayCwd) {
          node.tool = fbTool;
          node.model = fbModel;
          node.updatedAt = Date.now();
          save();
          return;
        }

        const sinceSeq = Math.max(0, node.lastReadSeq || 0);
        const relayLines = [
          `[AmeMesh 跨 Harness 上下文完整接力 | 项目：${proj.name}]`,
          `- 接管节点：${node.alias || node.id} (projectId="${proj.id}", nodeId="${node.id}")`,
          `- 接力原因：原模型 ${prevKey} 额度耗尽/限流，由模型池「${node.pool}」自动切换至 ${fbTool}${fbModel ? ':' + fbModel : ''}`,
          roleDef && roleDef.body ? `- 角色规范（${roleDef.name}）：\n${roleDef.body}` : null,
          roleDef && roleDef.readOnly ? '- [只读角色硬约束] 你是只读验收角色，严禁修改任何业务代码或产出文件。' : null,
          fb.quirks ? `- 模型微调提示：${fb.quirks}` : null,
          node.goal ? `- 当前目标：${node.goal}` : null,
          node.stopCondition ? `- 停机条件：${node.stopCondition}` : null,
          Array.isArray(node.boundaries) && node.boundaries.length ? `- 允许修改边界（Boundaries）：${node.boundaries.join(', ')}` : null,
          Array.isArray(node.doneWhen) && node.doneWhen.length ? `- 验收条件（Done When）：\n${node.doneWhen.map((x, i) => `  ${i + 1}. ${String(x).replace(/^\s*\d+[\.\)、]\s*/, '')}`).join('\n')}` : null,
          Array.isArray(node.checks) && node.checks.length ? `- 必跑验证命令：${node.checks.join(' ; ')}` : null,
          node.lastReport ? `- 上次阶段汇报：${node.lastReport.slice(0, 400)}` : null,
          myTasks.length ? `- 待完成任务：\n${myTasks.map((t) => `  - [${t.id}] (${t.status}) ${t.title}`).join('\n')}` : null,
          recentLines.length ? `- 前任会话最后进展（上下文继承）：\n${recentLines.join('\n')}` : null,
          boardSummary.length ? `- 最近黑板记录：\n${boardSummary.join('\n')}` : null,
          `- 如需更多历史细节可调用 mesh_board_read(since=${sinceSeq})，请基于上述继承上下文无缝继续完成任务。`,
        ].filter(Boolean);

        const prevTool = node.tool;
        const prevModel = node.model;
        const prevSid = node.sessionId;
        node.tool = fbTool;
        node.model = fbModel;
        node.sessionId = '';
        node.reviewStatus = 'running';
        node.lastAct = '';
        node.updatedAt = Date.now();

        const spKey = `${node.machine}|${normFolderPath(relayCwd)}`;
        const spList = pendingSpawns.get(spKey) || [];
        spList.push({ projectId: proj.id, nodeId: node.id, t0: Date.now() });
        pendingSpawns.set(spKey, spList);

        const launchRes = await sendToAgent(node.machine, {
          t: 'launch',
          cwd: relayCwd,
          prompt: deliverPromptFor(fbTool, relayLines.join('\n').slice(0, 7800)),
          tool: fbTool,
          ...(fbModel ? { model: fbModel } : {}),
          meshEnv: { AME_PROJECT_ID: proj.id, AME_NODE_ID: node.id },
        });
        if (launchRes && launchRes.ok) {
          save();
          return;
        }
        // Rollback pending spawn & cooldown failed fallback candidate before trying next
        const rem = (pendingSpawns.get(spKey) || []).filter((x) => x.nodeId !== node.id);
        if (rem.length) pendingSpawns.set(spKey, rem);
        else pendingSpawns.delete(spKey);
        node.tool = prevTool;
        node.model = prevModel;
        node.sessionId = prevSid;
        modelRouter.markCooldown(fb.harness, fbModel, (launchRes && launchRes.msg) || 'relay_launch_failed');
        exclude.push(fbKey);
      }

      // Entire pool exhausted
      node.watchdogAlert = { code: 'POOL_EXHAUSTED', label: '模型池全部耗尽', at: Date.now() };
      recordEvent(proj, {
        source: 'watchdog',
        kind: 'POOL_EXHAUSTED',
        machine: node.machine,
        nodeId: node.id,
        summary: `模型池「${node.pool}」内所有候选均已冷却或耗尽`,
        payload: { pool: node.pool, reason: cleanStr(reason, 120) },
      });
      await postBoard({
        projectId: proj.id,
        agent: '模型路由',
        kind: 'watchdog',
        text: `${masterMention}[模型池耗尽] 节点 ${node.alias || node.id} 所属模型池「${node.pool}」内所有候选模型均已冷却或耗尽（原因：${cleanStr(reason, 120)}），请介入降级模型组或等待额度重置。`,
      });
      if (typeof notify === 'function') {
        notify({
          title: '看门狗 · 模型池全部耗尽',
          body: `${proj.name} / 模型池「${node.pool}」内所有候选均不可用`,
          tag: `pool-exhausted-${proj.id}-${node.pool}`,
          url: `/#proj=${proj.id}`,
        });
      }
      save();
      return;
    }

    // Node has no pool configured: alert master
    recordEvent(proj, {
      source: 'watchdog',
      kind: 'QUOTA_EXHAUSTED',
      machine: node.machine,
      nodeId: node.id,
      summary: `节点 ${node.alias || node.id} (${prevKey}) 额度耗尽，已熔断冷却`,
      payload: { reason: cleanStr(reason, 120) },
    });
    await postBoard({
      projectId: proj.id,
      agent: '模型路由',
      kind: 'watchdog',
      text: `${masterMention}[额度耗尽] 节点 ${node.alias || node.id} (${prevKey}) 触发额度/限流熔断，未绑定模型池无法自动回落，请手动处理。`,
    });
    if (typeof notify === 'function') {
      notify({
        title: '看门狗 · 节点额度耗尽',
        body: `${proj.name} / ${node.alias || node.id} (${prevKey}) 额度耗尽`,
        tag: `quota-${node.id}`,
        url: `/#proj=${proj.id}`,
      });
    }
    save();
  }

  watchdog = createWatchdog({
    dataDir,
    getProjects: () => data.projects,
    getMachines: () => (machines || new Map()),
    liveSessionOf,
    deliverToNode,
    sendToAgent,
    recordEvent: (p, e) => recordEvent(p, e),
    notify: typeof notify === 'function' ? notify : async () => ({ sent: 0 }),
    save,
    postBoard: (d) => postBoard(d),
    onQuotaExhausted: (proj, node, reason) => handleQuotaExhausted(proj, node, reason),
  });
  watchdog.start(15000);

  function evaluateGitAudit(node, gitAudit, explicitBoundaries) {
    if (!gitAudit || !gitAudit.checked || !gitAudit.isGit) return null;
    const boundaries = (Array.isArray(explicitBoundaries) && explicitBoundaries.length)
      ? explicitBoundaries
      : (node && Array.isArray(node.boundaries) ? node.boundaries : []);
    const rawChangedFiles = Array.isArray(gitAudit.changedFiles) ? gitAudit.changedFiles : [];
    const curFingerprints = (gitAudit.fingerprints && typeof gitAudit.fingerprints === 'object') ? gitAudit.fingerprints : null;
    const baseline = node && node.gitBaseline && Array.isArray(node.gitBaseline.files) ? node.gitBaseline : null;
    let changedFiles = rawChangedFiles;
    let baselineExcludedCount = 0;
    if (baseline && baseline.files.length) {
      const baseSet = new Set(baseline.files.map((f) => String(f || '').replace(/\\/g, '/')));
      const baseFp = (baseline.fingerprints && typeof baseline.fingerprints === 'object') ? baseline.fingerprints : null;
      changedFiles = rawChangedFiles.filter((f) => {
        const nf = String(f || '').replace(/\\/g, '/');
        if (!baseSet.has(nf)) return true;
        // If both sides have file fingerprints and the file was modified since launch, keep it in audit
        if (baseFp && curFingerprints && typeof baseFp[nf] === 'string' && typeof curFingerprints[nf] === 'string') {
          if (baseFp[nf] !== curFingerprints[nf]) return true;
        }
        baselineExcludedCount += 1;
        return false;
      });
    }
    const res = checkBoundaries(boundaries, changedFiles);
    const emptyChange = changedFiles.length === 0 && boundaries.length > 0;
    return {
      checked: true,
      isGit: true,
      changedFiles: changedFiles.slice(0, 100),
      outOfBounds: res.outOfBounds,
      emptyChange,
      ...(baselineExcludedCount > 0 ? { baselineExcludedCount } : {}),
      ok: res.outOfBounds.length === 0 && !emptyChange,
    };
  }

  function formatAuditWarnings(auditRes) {
    if (!auditRes || auditRes.ok) return [];
    const warnings = [];
    if (auditRes.outOfBounds.length) {
      warnings.push(`[边界对账告警] 改动了允许边界之外的文件：${auditRes.outOfBounds.join(', ')}`);
    }
    if (auditRes.emptyChange) {
      warnings.push('[边界对账告警] 声明完成但工作区 git status 未检测到任何文件改动');
    }
    return warnings;
  }

  // Unified Blackboard: append post, update cursors, evaluate git audit, and route @mentions via hybrid wakeup
  async function postBoard(d = {}) {
    const resolved = resolveCaller({
      projectId: d.projectId,
      nodeId: d.fromNodeId || d.nodeId,
      machine: d.fromMachine || d.machine,
      sessionId: d.fromSessionId || d.sessionId,
      callerCwd: d.callerCwd || d.cwd,
    });
    const proj = resolved.project;
    if (!proj) return { ok: false, msg: '找不到对应的协同项目' };
    const fromNode = resolved.node || null;

    let text = cleanStr(d.text, 12000);
    if (!text) return { ok: false, msg: '发帖内容不能为空' };

    const kind = cleanStr(d.kind, 20) || 'post';
    const shouldAudit = Boolean(d.done || kind === 'report' || d.gitAudit);
    const auditRes = shouldAudit ? evaluateGitAudit(fromNode, d.gitAudit, d.boundaries) : null;
    const warnings = formatAuditWarnings(auditRes);
    if (warnings.length) {
      text = `${text}\n${warnings.join('\n')}`;
    }

    const agentName = cleanStr(d.agent, 60) || (fromNode ? (fromNode.alias || fromNode.id) : '管理员');
    const artifacts = normalizeStrArray(d.artifacts, 20, 400);
    const entry = board.append(proj.id, {
      channel: cleanStr(d.channel, 40) || 'main',
      kind,
      agent: agentName,
      nodeId: fromNode ? fromNode.id : null,
      text,
      ...(Array.isArray(d.mentions) ? { mentions: d.mentions } : {}),
      ...(typeof d.mentionAll === 'boolean' ? { mentionAll: d.mentionAll } : {}),
      artifacts,
      done: Boolean(d.done),
      audit: auditRes,
    });

    if (fromNode) {
      fromNode.lastPostSeq = entry.seq;
      fromNode.lastReadSeq = Math.max(fromNode.lastReadSeq || 0, entry.seq);
      fromNode.updatedAt = Date.now();
    }

    const mentionSet = new Set((entry.mentions || []).map((m) => String(m).toLowerCase()));
    const wakeChannelSet = new Set((entry.mentionChannels || []).map((c) => String(c).toLowerCase()));
    const entryChannel = String(entry.channel || 'main').toLowerCase();
    if (entryChannel && entryChannel !== 'main') {
      wakeChannelSet.add(entryChannel);
    }
    const channelSubscribedIds = new Set();
    if (wakeChannelSet.size > 0) {
      for (const chObj of board.getChannels(proj.id)) {
        if (chObj.archived) continue;
        if (wakeChannelSet.has(String(chObj.name || '').toLowerCase())) {
          for (const subId of chObj.subscribers || []) {
            channelSubscribedIds.add(subId);
          }
        }
      }
    }

    const lowerText = String(entry.text || '').toLowerCase();
    const targets = (proj.nodes || []).filter((n) => {
      if (n.archived) return false;
      if (fromNode && n.id === fromNode.id) return false;
      if (entry.mentionAll || n.wakeMode === 'all') return true;
      if (channelSubscribedIds.has(n.id)) return true;
      const aliasL = String(n.alias || '').toLowerCase();
      const idL = String(n.id || '').toLowerCase();
      const roleL = String(n.role || '').toLowerCase();
      if ((aliasL && mentionSet.has(aliasL)) || (idL && mentionSet.has(idL)) || (roleL && mentionSet.has(roleL))) return true;
      // Fallback full-alias match for legacy nodes whose alias contains spaces (e.g. "@Ametyping Embedding Plan")
      if (aliasL && /\s/.test(aliasL) && (lowerText.includes('@' + aliasL) || lowerText.includes('＠' + aliasL))) return true;
      return false;
    });

    const deliveries = [];
    for (const targetNode of targets) {
      targetNode.lastMentionedSeq = entry.seq;
      targetNode.lastMentionedAt = entry.ts;
      if (d.skipWake !== true) {
        const wakePrompt = formatWakePrompt({ project: proj, entry, targetNode });
        const deliv = await deliverToNode(proj, targetNode, wakePrompt, { seq: entry.seq });
        deliveries.push({ nodeId: targetNode.id, alias: targetNode.alias, ...deliv });
      }
    }

    save();
    return { ok: true, entry, deliveries, project: enrichProject(proj) };
  }

  function readBoard(d = {}) {
    const resolved = resolveCaller({
      projectId: d.projectId,
      nodeId: d.nodeId || d.fromNodeId,
      machine: d.machine || d.fromMachine,
      sessionId: d.sessionId || d.fromSessionId,
      callerCwd: d.callerCwd || d.cwd,
    });
    const proj = resolved.project;
    if (!proj) return { ok: false, msg: '找不到对应的协同项目' };
    const node = resolved.node || null;

    let seqList = null;
    if (Array.isArray(d.seqList)) {
      seqList = d.seqList.map((x) => parseInt(x, 10)).filter((n) => Number.isSafeInteger(n) && n > 0);
    } else if (typeof d.seqList === 'string' && d.seqList.trim()) {
      seqList = d.seqList.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isSafeInteger(n) && n > 0);
    }

    const { entries, latestSeq } = board.read(proj.id, {
      since: Number(d.since) || 0,
      limit: Number(d.limit) || 50,
      channel: cleanStr(d.channel, 40),
      seqList,
    });

    if (node && entries.length) {
      const maxSeq = entries.reduce((mx, e) => (e.seq > mx ? e.seq : mx), 0);
      node.lastReadSeq = Math.max(node.lastReadSeq || 0, maxSeq);
      if (Array.isArray(node.inbox) && node.inbox.length) {
        node.inbox = node.inbox.filter((m) => m && m.seq && m.seq > node.lastReadSeq);
      }
      save();
    }

    return {
      ok: true,
      projectId: proj.id,
      entries,
      latestSeq,
      lastReadSeq: node ? node.lastReadSeq || 0 : 0,
    };
  }

  // Event-sourced Multi-Channel management (create / subscribe / unsubscribe / archive / list)
  function manageChannel(d = {}) {
    const resolved = resolveCaller({
      projectId: d.projectId,
      nodeId: d.fromNodeId,
      machine: d.fromMachine || d.machine,
      sessionId: d.fromSessionId || d.sessionId,
      callerCwd: d.callerCwd || d.cwd,
    });
    let proj = resolved.project;
    if (!proj && d.nodeId) {
      const byNode = resolveCaller({ projectId: d.projectId, nodeId: d.nodeId });
      proj = byNode.project;
    }
    if (!proj) return { ok: false, msg: '找不到所属项目' };
    const fromNode = resolved.node || null;

    const action = cleanStr(d.action, 20) || 'list';
    if (action === 'list') {
      return { ok: true, channels: board.getChannels(proj.id), project: enrichProject(proj) };
    }

    const rawCh = cleanStr(d.channel, 40);
    if (!rawCh || !/^[A-Za-z0-9_\u4e00-\u9fa5-]{1,32}$/.test(rawCh)) {
      return { ok: false, msg: '频道名不合法，仅支持 1~32 位字母、数字、中文、下划线或连字符' };
    }
    const ch = rawCh.toLowerCase();

    const resolveTargetNodeId = (raw) => {
      const val = cleanStr(raw, 60);
      if (!val) return '';
      const matched = (proj.nodes || []).find((n) => n.id === val || n.alias === val);
      return matched ? matched.id : val;
    };
    const targetNodeId = resolveTargetNodeId(d.nodeId) || (fromNode ? fromNode.id : '');
    const cleanDesc = cleanStr(d.desc, 200);
    const agentName = cleanStr(d.agent, 60) || (fromNode ? (fromNode.alias || fromNode.id) : '管理员');

    if (action === 'create') {
      const entry = board.append(proj.id, {
        channel: ch,
        kind: 'control',
        agent: agentName,
        nodeId: fromNode ? fromNode.id : null,
        text: `[频道控制] 创建频道 #${ch}${cleanDesc ? '：' + cleanDesc : ''}`,
        control: { op: 'channel_create', channel: ch, desc: cleanDesc },
      });
      save();
      return { ok: true, entry, channels: board.getChannels(proj.id), project: enrichProject(proj) };
    }

    if (action === 'subscribe' || action === 'unsubscribe') {
      if (!targetNodeId) return { ok: false, msg: '请指定要操作的节点 nodeId' };
      const label = action === 'subscribe' ? '订阅' : '退订';
      const entry = board.append(proj.id, {
        channel: ch,
        kind: 'control',
        agent: agentName,
        nodeId: fromNode ? fromNode.id : null,
        text: `[频道控制] 节点 ${targetNodeId} ${label}频道 #${ch}`,
        control: { op: `channel_${action}`, channel: ch, nodeId: targetNodeId },
      });
      save();
      return { ok: true, entry, channels: board.getChannels(proj.id), project: enrichProject(proj) };
    }

    if (action === 'archive') {
      if (ch === 'main') return { ok: false, msg: '默认频道 main 不可归档' };
      const entry = board.append(proj.id, {
        channel: ch,
        kind: 'control',
        agent: agentName,
        nodeId: fromNode ? fromNode.id : null,
        text: `[频道控制] 归档频道 #${ch}`,
        control: { op: 'channel_archive', channel: ch },
      });
      save();
      return { ok: true, entry, channels: board.getChannels(proj.id), project: enrichProject(proj) };
    }

    return { ok: false, msg: '未知的 channel 操作：' + action };
  }

  // Shared Task List with deterministic `blockedBy` auto-unlock
  async function manageTask(d = {}) {
    const resolved = resolveCaller({
      projectId: d.projectId,
      nodeId: d.fromNodeId || d.nodeId,
      machine: d.fromMachine || d.machine,
      sessionId: d.fromSessionId || d.sessionId,
      callerCwd: d.callerCwd || d.cwd,
    });
    const proj = resolved.project;
    if (!proj) return { ok: false, msg: '找不到所属项目' };
    proj.tasks = proj.tasks || [];
    const action = cleanStr(d.action, 20) || 'list';

    const resolveOwnerId = (rawOwner) => {
      const val = cleanStr(rawOwner, 60);
      if (!val) return '';
      const matched = (proj.nodes || []).find((n) => n.id === val || n.alias === val);
      return matched ? matched.id : val;
    };

    if (action === 'list') {
      return { ok: true, tasks: proj.tasks, project: enrichProject(proj) };
    }

    if (action === 'add') {
      const title = cleanStr(d.title, 200);
      if (!title) return { ok: false, msg: '任务标题不能为空' };
      if (proj.tasks.length >= 200) return { ok: false, msg: '项目任务数量已达上限 (200)' };
      const now = Date.now();
      const task = {
        id: cleanStr(d.taskId || d.id, 40) || idGen('task'),
        title,
        desc: cleanStr(d.desc, 2000),
        ownerNodeId: resolveOwnerId(d.ownerNodeId),
        status: ['pending', 'in_progress', 'review', 'done', 'blocked'].includes(d.status) ? d.status : 'pending',
        blockedBy: normalizeStrArray(d.blockedBy, 20, 40),
        boundaries: normalizeStrArray(d.boundaries, 40, 300),
        doneWhen: normalizeStrArray(d.doneWhen, 30, 400),
        checks: normalizeStrArray(d.checks, 20, 300),
        boardRefs: Array.isArray(d.boardRefs)
          ? d.boardRefs.map((x) => parseInt(x, 10)).filter((n) => Number.isSafeInteger(n) && n > 0)
          : [],
        artifacts: normalizeStrArray(d.artifacts, 20, 400),
        createdAt: now,
        updatedAt: now,
      };
      proj.tasks.push(task);
      save();
      return { ok: true, task, tasks: proj.tasks, project: enrichProject(proj) };
    }

    const targetId = cleanStr(d.taskId || d.id, 40);
    const task = proj.tasks.find((t) => t.id === targetId);
    if (!task) return { ok: false, msg: '找不到指定任务' };

    if (action === 'claim') {
      const hasPendingDep = (task.blockedBy || []).some((depId) => {
        const dep = proj.tasks.find((x) => x.id === depId);
        return dep && dep.status !== 'done';
      });
      if (hasPendingDep) {
        return { ok: false, msg: '前置依赖任务尚未完成，无法认领' };
      }
      const ownerId = (resolved.node && resolved.node.id) || resolveOwnerId(d.ownerNodeId || d.nodeId);
      if (ownerId) task.ownerNodeId = ownerId;
      if (task.status === 'pending') task.status = 'in_progress';
      task.updatedAt = Date.now();
      save();
      return { ok: true, task, tasks: proj.tasks, project: enrichProject(proj) };
    }

    if (action === 'update') {
      const prevStatus = task.status;
      if (typeof d.title === 'string' && d.title.trim()) task.title = cleanStr(d.title, 200);
      if (typeof d.desc === 'string') task.desc = cleanStr(d.desc, 2000);
      if (typeof d.ownerNodeId === 'string') task.ownerNodeId = resolveOwnerId(d.ownerNodeId);
      if (['pending', 'in_progress', 'review', 'done', 'blocked'].includes(d.status)) task.status = d.status;
      if (Array.isArray(d.blockedBy)) task.blockedBy = normalizeStrArray(d.blockedBy, 20, 40);
      if (Array.isArray(d.boundaries)) task.boundaries = normalizeStrArray(d.boundaries, 40, 300);
      if (Array.isArray(d.doneWhen)) task.doneWhen = normalizeStrArray(d.doneWhen, 30, 400);
      if (Array.isArray(d.checks)) task.checks = normalizeStrArray(d.checks, 20, 300);
      if (Array.isArray(d.boardRefs)) {
        task.boardRefs = d.boardRefs.map((x) => parseInt(x, 10)).filter((n) => Number.isSafeInteger(n) && n > 0);
      }
      if (Array.isArray(d.artifacts)) task.artifacts = normalizeStrArray(d.artifacts, 20, 400);
      task.updatedAt = Date.now();
      save();

      const unlockedTasks = [];
      if (prevStatus !== 'done' && task.status === 'done') {
        for (const t of proj.tasks) {
          if (t.status !== 'pending' || !Array.isArray(t.blockedBy) || !t.blockedBy.includes(task.id)) continue;
          const allDepsDone = t.blockedBy.every((depId) => {
            const dep = proj.tasks.find((x) => x.id === depId);
            return dep && dep.status === 'done';
          });
          if (allDepsDone) {
            const ownerNode = (t.ownerNodeId && proj.nodes.find((n) => n.id === t.ownerNodeId || n.alias === t.ownerNodeId)) ||
              proj.nodes.find((n) => n.role === 'master') || null;
            const prefix = ownerNode ? `${mentionTokenOf(ownerNode)} ` : '';
            await postBoard({
              projectId: proj.id,
              agent: '任务调度',
              kind: 'task',
              text: `${prefix}前置任务 [${task.id}] 已完成，任务 [${t.id}]「${t.title}」已自动解锁，可开始执行。`,
            });
            unlockedTasks.push(t);
          }
        }
      }
      return { ok: true, task, unlockedTasks, tasks: proj.tasks, project: enrichProject(proj) };
    }

    if (action === 'remove') {
      proj.tasks = proj.tasks.filter((t) => t.id !== targetId);
      save();
      return { ok: true, tasks: proj.tasks, project: enrichProject(proj) };
    }

    return { ok: false, msg: '未知的 task 操作：' + action };
  }

  const SPAWN_ALLOWED_KEYS = new Set([
    'projectId', 'projectName', 'machine', 'cwd', 'role', 'pool', 'tool', 'model', 'api',
    'alias', 'goal', 'stopCondition', 'prompt', 'boundaries', 'doneWhen', 'checks',
    'workspaceMode', 'branch',
    // Internal RPC / caller identity fields
    't', 'rid', 'op', 'sessionId', 'nodeId', 'fromNodeId', 'fromMachine', 'fromSessionId', 'callerCwd',
  ]);

  // Spawn a new Worker session on a remote machine in an allowed folder and bind it to the project topology
  async function spawnWorker(rawParams = {}) {
    if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
      const unknownKeys = Object.keys(rawParams).filter((k) => rawParams[k] !== undefined && !SPAWN_ALLOWED_KEYS.has(k));
      if (unknownKeys.length) {
        return {
          ok: false,
          invalidParams: unknownKeys,
          msg: `mesh_spawn 收到未定义参数：${unknownKeys.join(', ')}。请改用 pool（推荐，如 fast-coder / flagship / heavy-reasoner，由系统按额度自动选型），或显式指定 tool（claude/codex/opencode/agy/kiro）、model 与 alias；禁止凭记忆传参。`,
        };
      }
    }
    const {
      projectId,
      projectName,
      fromNodeId,
      fromMachine,
      fromSessionId,
      callerCwd,
      machine,
      cwd,
      role = 'worker',
      pool = '',
      tool = '',
      model = '',
      api = '',
      alias = '',
      goal = '',
      stopCondition = '',
      prompt = '',
      boundaries = [],
      doneWhen = [],
      checks = [],
      workspaceMode = '',
      branch = '',
    } = rawParams || {};
    const resolved = resolveCaller({
      projectId,
      nodeId: fromNodeId,
      machine: fromMachine,
      sessionId: fromSessionId,
      callerCwd,
    });
    let proj = resolved.project;
    if (!proj) {
      const r = saveProject({ name: projectName || `协同项目 ${new Date().toISOString().slice(5, 10)}` });
      if (!r.ok) return r;
      proj = data.projects.find((x) => x.id === r.project.id);
    }

    // Ensure master node is registered ONLY when caller explicitly provides fromSessionId (never guess unrelated sessions)
    let masterNode = resolved.node;
    if (!masterNode && fromNodeId) {
      masterNode = proj.nodes.find((n) => n.id === fromNodeId || n.alias === fromNodeId) || null;
    }
    // Never let an unidentified same-cwd fallback misattribute a worker node as the spawning master
    if (masterNode && masterNode.role !== 'master' && !fromNodeId && !fromSessionId) {
      masterNode = proj.nodes.find((n) => n.role === 'master') || null;
    }
    if (!masterNode && fromMachine && fromSessionId) {
      const mr = upsertNode(proj.id, {
        machine: fromMachine,
        sessionId: fromSessionId,
        role: 'master',
        alias: '主控会话',
        ...(callerCwd ? { cwd: callerCwd } : {}),
      });
      if (mr.ok) masterNode = mr.node;
    }

    // Workspace access boundary check
    const access = checkWorkspaceAccess(proj, machine, cwd, true);
    if (!access.ok) return access;
    if (!proj.workspaces.some((w) => w.machine === machine && isSubPath(w.path, cwd))) {
      proj.workspaces.push({ machine: cleanStr(machine, 60), path: cleanStr(cwd, 500), mode: 'rw', tag: 'worker' });
    }

    const cleanRole = cleanStr(role, 32) || 'worker';
    const roleDef = roleStore.get(cleanRole);
    const effectiveWorkspaceMode = (workspaceMode === 'worktree' || workspaceMode === 'inherit')
      ? workspaceMode
      : (roleDef && roleDef.workspaceMode === 'worktree' ? 'worktree' : 'inherit');
    const cleanBranch = cleanStr(branch, 120);
    const cleanTool = cleanStr(tool, 40);
    if (cleanTool && !TOOLS.includes(cleanTool)) {
      return {
        ok: false,
        msg: `不支持的 tool 值「${cleanTool}」（仅支持 ${TOOLS.join(' / ')}）；常规派活推荐不传 tool，直接传 pool（如 fast-coder / flagship / heavy-reasoner）。`,
      };
    }
    const hasExplicitTool = Boolean(cleanTool && TOOLS.includes(cleanTool));
    const cleanPool = cleanStr(pool, 60);
    const cleanModel = cleanStr(model, 120);
    // Default to pool routing when neither pool nor explicit tool is specified (never silently default to claude)
    const effectivePool = cleanPool || (!hasExplicitTool ? ((roleDef && roleDef.defaultPool) || 'fast-coder') : '');

    const workerNodeId = idGen('node');

    const normBoundaries = normalizeStrArray(boundaries, 40, 300);
    const normDoneWhen = normalizeStrArray(doneWhen, 30, 400);
    const normChecks = normalizeStrArray(checks, 20, 300);

    // Include folder notes from fsCatalog and external role definition in initial contract prompt
    const cat = fsCatalog ? fsCatalog.get(machine, cwd) : null;
    const baseContextLines = [
      `[AmeMesh 协同任务契约 | 项目：${proj.name}]`,
      masterNode ? `- 主控节点：${masterNode.alias || masterNode.id} (${masterNode.machine})` : null,
      `- 节点身份标识（调用 mesh_board_post / mesh_report / mesh_send / mesh_task / mesh_run 时务必携带，避免同目录多节点并行时身份串台）：projectId="${proj.id}", nodeId="${workerNodeId}", role="${cleanRole}"`,
      `- 工作目录：${cwd}`,
      roleDef && roleDef.body ? `- 角色规范（${roleDef.name}）：\n${roleDef.body}` : null,
      roleDef && roleDef.readOnly ? '- [只读验收硬约束] 当前角色 readOnly=true：严禁修改、新建或删除任何业务代码与配置文件，仅可读取源码、审阅黑板并运行验证命令。' : null,
      cat && cat.tag ? `- 目录角色标签：${fsCatalog.TAG_LABELS[cat.tag] || cat.tag}` : null,
      cat && cat.userNote ? `- 用户目录备注（请严格遵守）：${cat.userNote}` : null,
      cat && cat.aiNote ? `- AI 历史备注：${cat.aiNote}` : null,
      goal ? `- 本阶段目标（Goal）：${goal}` : null,
      stopCondition ? `- 停机与检视边界（Stop & Review Gate）：${stopCondition}` : `- 停机与检视边界：完成指定目标或遇到阻塞时停下，汇报结果并等待主控会话 Review`,
      normBoundaries.length ? `- 允许修改边界（Boundaries，严禁越界修改其他文件）：${normBoundaries.join(', ')}` : null,
      normDoneWhen.length ? `- 验收条件（Done When，交卷时逐条核对）：\n${normDoneWhen.map((item, idx) => `  ${idx + 1}. ${String(item).replace(/^\s*\d+[\.\)、]\s*/, '')}`).join('\n')}` : null,
      normChecks.length ? `- 必跑验证命令（Checks）：${normChecks.join(' ; ')}` : null,
      '- 协作黑板约定：可通过 mesh_board_post 与成员公开协同（正文里用 at+节点别名 点名、用 #楼层号 引用历史帖子）；严禁擅自 git commit/push。',
      '- 长时间计算约定：预计耗时超过 10 分钟的求解或跑批任务，请使用 mesh_run 工具或 `node tools/ame-mesh.js run --label "任务名" -- <命令>` 在后台脱离运行，随后可调用 mesh_report(reviewStatus="blocked") 等待计算结束自动唤醒。',
    ].filter(Boolean);

    const buildFullPrompt = (quirksText) => {
      const lines = [...baseContextLines];
      if (quirksText) lines.push(`- 模型微调提示：${quirksText}`);
      if (prompt) lines.push(`\n具体执行指令：\n${prompt}`);
      return lines.join('\n').slice(0, 7800);
    };

    const masterMention = `${mentionTokenOf(masterNode)} `;
    const spKey = `${machine}|${normFolderPath(cwd)}`;
    const worktreeLaunchFields = effectiveWorkspaceMode === 'worktree'
      ? {
          workspaceMode: 'worktree',
          worktreeBranch: cleanBranch,
          worktreeAlias: cleanStr(alias, 60) || workerNodeId,
        }
      : {};

    const finalizeLaunchedWorker = (nr, launchRes, launchPromptText) => {
      if (effectiveWorkspaceMode === 'worktree' && launchRes.worktreePath) {
        nr.node.cwd = cleanStr(launchRes.worktreePath, 500);
        nr.node.worktreePath = cleanStr(launchRes.worktreePath, 500);
        nr.node.worktreeBranch = cleanStr(launchRes.worktreeBranch || cleanBranch, 120);
        nr.node.worktreeParentRepo = cleanStr(launchRes.worktreeParentRepo || cwd, 500);
        nr.node.updatedAt = Date.now();

        const wtKey = `${machine}|${normFolderPath(nr.node.worktreePath)}`;
        if (wtKey !== spKey) {
          const origRem = (pendingSpawns.get(spKey) || []).filter((x) => x.nodeId !== nr.node.id);
          if (origRem.length) pendingSpawns.set(spKey, origRem);
          else pendingSpawns.delete(spKey);

          const wtList = pendingSpawns.get(wtKey) || [];
          if (!wtList.some((x) => x.nodeId === nr.node.id)) {
            wtList.push({ projectId: proj.id, nodeId: nr.node.id, t0: Date.now() });
            pendingSpawns.set(wtKey, wtList);
          }
        }
      }

      if (launchRes && launchRes.gitBaseline && launchRes.gitBaseline.isGit && Array.isArray(launchRes.gitBaseline.changedFiles)) {
        nr.node.gitBaseline = {
          files: launchRes.gitBaseline.changedFiles.slice(0, 200),
          fingerprints: (launchRes.gitBaseline.fingerprints && typeof launchRes.gitBaseline.fingerprints === 'object')
            ? launchRes.gitBaseline.fingerprints
            : {},
          capturedAt: Date.now(),
        };
      }

      const briefEntry = board.append(proj.id, {
        channel: 'main',
        kind: 'brief',
        agent: masterNode ? (masterNode.alias || masterNode.id) : '主控会话',
        nodeId: masterNode ? masterNode.id : null,
        text: `@${nr.node.alias || nr.node.id} 派活契约已下发\n${launchPromptText}`,
        mentions: [nr.node.alias || nr.node.id],
        skipTextMentionParse: true,
      });
      nr.node.lastReadSeq = briefEntry.seq;
      if (masterNode) {
        masterNode.lastPostSeq = briefEntry.seq;
        masterNode.lastReadSeq = Math.max(masterNode.lastReadSeq || 0, briefEntry.seq);
      }
      save();
      return { ok: true, node: nr.node, project: enrichProject(proj), msg: launchRes.msg || '已在目标电脑启动协同会话' };
    };

    if (effectivePool) {
      const exclude = [];
      let nr = null;
      let lastErr = '';
      let launchPrompt = '';
      let launched = false;

      for (let attempt = 0; attempt < 15; attempt++) {
        const availHarnesses = machineHarnesses(machine);
        const pick = modelRouter.selectCandidate(effectivePool, {
          exclude,
          activeCounts: activeModelCounts(),
          availableHarnesses: availHarnesses.length ? availHarnesses : null,
          projectHarnessCounts: projectHarnessCounts(proj),
          maxPerHarness: getMaxPerHarness(),
        });
        if (!pick.ok || !pick.candidate) {
          lastErr = pick.msg || lastErr || `模型池「${effectivePool}」无可用候选`;
          break;
        }
        const cand = pick.candidate;
        const attemptTool = TOOLS.includes(cand.harness) ? cand.harness : 'claude';
        const attemptModel = cand.model || cleanModel || '';
        launchPrompt = buildFullPrompt(cand.quirks || '');

        if (!nr) {
          nr = upsertNode(proj.id, {
            id: workerNodeId,
            machine,
            sessionId: '',
            alias: alias || `${machine}:${path.basename(cwd)}`,
            role: cleanRole,
            tool: attemptTool,
            pool: effectivePool,
            model: attemptModel,
            cwd,
            goal,
            stopCondition,
            workspaceMode: effectiveWorkspaceMode,
            worktreeBranch: cleanBranch,
            boundaries: normBoundaries,
            doneWhen: normDoneWhen,
            checks: normChecks,
            fromNodeId: masterNode ? masterNode.id : undefined,
            edgeType: cleanRole === 'peer' ? 'cowork' : 'master-worker',
          });
          if (!nr.ok) return nr;
        } else {
          nr.node.tool = attemptTool;
          nr.node.model = attemptModel;
          nr.node.pool = effectivePool;
          nr.node.updatedAt = Date.now();
        }

        const list = pendingSpawns.get(spKey) || [];
        if (!list.some((x) => x.nodeId === nr.node.id)) {
          list.push({ projectId: proj.id, nodeId: nr.node.id, t0: Date.now() });
          pendingSpawns.set(spKey, list);
        }

        const launchRes = await sendToAgent(machine, {
          t: 'launch',
          cwd,
          prompt: deliverPromptFor(attemptTool, launchPrompt),
          tool: attemptTool,
          ...(attemptModel ? { model: attemptModel } : {}),
          api: api ? { id: api, local: true } : undefined,
          meshEnv: { AME_PROJECT_ID: proj.id, AME_NODE_ID: workerNodeId },
          ...worktreeLaunchFields,
        });
        if (launchRes && launchRes.ok) {
          launched = true;
          return finalizeLaunchedWorker(nr, launchRes, launchPrompt);
        }

        lastErr = (launchRes && launchRes.msg) || '启动失败';
        modelRouter.markCooldown(cand.harness, cand.model || '', lastErr);
        exclude.push(`${cand.harness}|${cand.model || ''}`);
      }

      if (!launched) {
        const rem = (pendingSpawns.get(spKey) || []).filter((x) => x.nodeId !== workerNodeId);
        if (rem.length) pendingSpawns.set(spKey, rem);
        else pendingSpawns.delete(spKey);
        if (nr && nr.node) {
          nr.node.reviewStatus = 'blocked';
          nr.node.lastAct = '启动失败：' + lastErr;
        }
        await postBoard({
          projectId: proj.id,
          agent: '模型路由',
          kind: 'watchdog',
          text: `${masterMention}[模型池耗尽] 为节点 ${alias || workerNodeId} 选型失败，模型池「${effectivePool}」所有候选均不可用（${cleanStr(lastErr, 120)}）。`,
        });
        save();
        return {
          ok: false,
          exhausted: true,
          msg: lastErr || `模型池「${effectivePool}」内所有候选均不可用`,
          ...(nr && nr.node ? { node: nr.node } : {}),
          project: enrichProject(proj),
        };
      }
    }

    const explicitTool = hasExplicitTool ? cleanTool : 'claude';
    // Pre-check Magpie quota / cooldown even when Master explicitly specifies a tool
    if (typeof modelRouter.evaluateToolQuota === 'function') {
      const qEval = modelRouter.evaluateToolQuota(explicitTool, cleanModel);
      if (qEval && !qEval.healthy) {
        return {
          ok: false,
          exhausted: true,
          msg: `指定 Harness「${explicitTool}${cleanModel ? ':' + cleanModel : ''}」当前无法拉起：${qEval.reason || qEval.magpieInfo || '额度已耗尽或处于冷却'}。请改用 pool（如 fast-coder / flagship）由系统自动分流，或更换其他可用 Harness。`,
        };
      }
    }
    const maxCaps = getMaxPerHarness();
    const toolCap = Number(maxCaps[explicitTool]);
    if (Number.isFinite(toolCap) && toolCap > 0) {
      const curProjCounts = projectHarnessCounts(proj);
      if ((curProjCounts[explicitTool] || 0) >= toolCap) {
        return {
          ok: false,
          msg: `当前项目活跃 ${explicitTool} 成员已达上限（${toolCap} 个），请改用 pool 自动分流到其他 Harness（如 agy），或在「Skill 与协同 › 全局模型池」中调高上限`,
        };
      }
    }
    const fullPrompt = buildFullPrompt('');

    const nr = upsertNode(proj.id, {
      id: workerNodeId,
      machine,
      sessionId: '',
      alias: alias || `${machine}:${path.basename(cwd)}`,
      role: cleanRole,
      tool: explicitTool,
      pool: '',
      model: cleanModel,
      cwd,
      goal,
      stopCondition,
      workspaceMode: effectiveWorkspaceMode,
      worktreeBranch: cleanBranch,
      boundaries: normBoundaries,
      doneWhen: normDoneWhen,
      checks: normChecks,
      fromNodeId: masterNode ? masterNode.id : undefined,
      edgeType: cleanRole === 'peer' ? 'cowork' : 'master-worker',
    });
    if (!nr.ok) return nr;

    // Register pending spawn so when the agent reports the new session in `state` or `meta`, we bind its sessionId automatically
    const list = pendingSpawns.get(spKey) || [];
    list.push({ projectId: proj.id, nodeId: nr.node.id, t0: Date.now() });
    pendingSpawns.set(spKey, list);

    const launchRes = await sendToAgent(machine, {
      t: 'launch',
      cwd,
      prompt: deliverPromptFor(explicitTool, fullPrompt),
      tool: explicitTool,
      ...(cleanModel ? { model: cleanModel } : {}),
      api: api ? { id: api, local: true } : undefined,
      meshEnv: { AME_PROJECT_ID: proj.id, AME_NODE_ID: workerNodeId },
      ...worktreeLaunchFields,
    });
    if (!launchRes.ok) {
      nr.node.reviewStatus = 'blocked';
      nr.node.lastAct = '启动失败：' + (launchRes.msg || '');
      save();
      return { ok: false, msg: launchRes.msg || '在目标机器启动会话失败', node: nr.node, project: enrichProject(proj) };
    }
    return finalizeLaunchedWorker(nr, launchRes, fullPrompt);
  }

  function findProjectNode(projectId, nodeId) {
    if (projectId) {
      const proj = data.projects.find((x) => x.id === projectId);
      if (!proj) return { proj: null, node: null };
      const node = (proj.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId) || null;
      return { proj, node };
    }
    if (nodeId) {
      for (const p of data.projects) {
        const node = (p.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId);
        if (node) return { proj: p, node };
      }
    }
    return { proj: null, node: null };
  }

  async function checkNodeWorktree(projectId, nodeId) {
    const { proj, node } = findProjectNode(projectId, nodeId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    if (!node) return { ok: false, msg: '找不到该节点' };
    if (node.workspaceMode !== 'worktree' || !node.worktreePath) {
      return { ok: true, isWorktree: false };
    }
    const r = await sendToAgent(node.machine, {
      t: 'worktree-check',
      worktreePath: node.worktreePath,
      parentRepo: node.worktreeParentRepo || '',
      branch: node.worktreeBranch || '',
    });
    return {
      ok: !!r.ok,
      isWorktree: true,
      dirty: !!r.dirty,
      unmergedCommits: +r.unmergedCommits || 0,
      branch: node.worktreeBranch || r.worktreeBranch || '',
      worktreePath: node.worktreePath,
      msg: r.msg || '',
    };
  }

  async function removeNodeWorktree(projectId, nodeId, { force = false } = {}) {
    const { proj, node } = findProjectNode(projectId, nodeId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    if (!node) return { ok: false, msg: '找不到该节点' };
    if (node.workspaceMode !== 'worktree' || !node.worktreePath) {
      return { ok: true, isWorktree: false, msg: '该节点未使用独立 worktree' };
    }
    return sendToAgent(node.machine, {
      t: 'worktree-remove',
      worktreePath: node.worktreePath,
      parentRepo: node.worktreeParentRepo || '',
      branch: node.worktreeBranch || '',
      force: !!force,
    });
  }

  // Master-only silent review / lifecycle management: approve, reject, or archive (retire while keeping topology trace)
  async function reviewNode({ projectId, nodeId, action = 'approve', note = '', closeTerminal = false, fromNodeId, fromMachine, fromSessionId, callerCwd } = {}) {
    const resolved = resolveCaller({ projectId, nodeId: fromNodeId, machine: fromMachine, sessionId: fromSessionId, callerCwd });
    let proj = resolved.project;
    if (!proj && nodeId) {
      for (const p of data.projects) {
        if ((p.nodes || []).some((n) => n.id === nodeId || n.alias === nodeId)) { proj = p; break; }
      }
    }
    if (!proj) return { ok: false, msg: '找不到对应的协同项目' };
    const target = (proj.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId);
    if (!target) return { ok: false, msg: '找不到目标节点：' + String(nodeId || '') };
    const cleanNote = cleanStr(note, 2000);
    const act = String(action || 'approve').trim().toLowerCase();

    if (act === 'approve') {
      target.reviewStatus = 'done';
      target.watchdogAlert = null;
      if (cleanNote) target.lastAct = '已批准结单：' + cleanNote.slice(0, 120);
      target.updatedAt = Date.now();
      save();
      return { ok: true, projectId: proj.id, action: 'approve', node: { id: target.id, alias: target.alias, reviewStatus: target.reviewStatus, archived: !!target.archived }, msg: `已静默批准节点「${target.alias || target.id}」结单` };
    }

    if (act === 'archive') {
      target.reviewStatus = 'done';
      target.archived = true;
      target.autoResumeClosed = false;
      target.watchdogAlert = null;
      let terminalClosed = false;
      let closeMsg = '';
      if (closeTerminal === true) {
        if (target.role === 'master') {
          closeMsg = '（安全保护：禁止关闭主控会话终端）';
        } else if (target.sessionId && target.machine) {
          const live = liveSessionOf(target.machine, target.sessionId);
          if (live && live.online && live.state !== 'history' && live.state !== 'ended') {
            const exitRes = await sendToAgent(target.machine, { t: 'send', id: target.sessionId, text: '/exit' });
            terminalClosed = Boolean(exitRes && exitRes.ok);
            closeMsg = terminalClosed ? '，已发送 /exit 优雅退出会话' : `（发送退出指令失败：${(exitRes && exitRes.msg) || '未知'}）`;
          } else {
            closeMsg = '（会话已处于关闭状态）';
          }
        }
      }
      target.lastAct = cleanNote ? `已归档退役：${cleanNote.slice(0, 120)}` : `已归档退役（保留拓扑痕迹${terminalClosed ? '，已退出会话' : ''}）`;
      target.updatedAt = Date.now();
      save();
      return {
        ok: true,
        projectId: proj.id,
        action: 'archive',
        terminalClosed,
        node: { id: target.id, alias: target.alias, reviewStatus: target.reviewStatus, archived: true },
        msg: `节点「${target.alias || target.id}」已归档退役${closeMsg}`,
      };
    }

    if (act === 'reject') {
      target.reviewStatus = 'running';
      target.archived = false;
      target.watchdogAlert = null;
      target.updatedAt = Date.now();
      let postRes = null;
      if (cleanNote) {
        postRes = await postBoard({
          projectId: proj.id,
          fromNodeId: resolved.node ? resolved.node.id : fromNodeId,
          fromMachine,
          fromSessionId,
          callerCwd,
          text: `${mentionTokenOf(target)} [打回返工] ${cleanNote}`,
        });
      }
      save();
      return { ok: true, projectId: proj.id, action: 'reject', node: { id: target.id, alias: target.alias, reviewStatus: target.reviewStatus, archived: false }, ...(postRes && postRes.entry ? { boardSeq: postRes.entry.seq } : {}), msg: `已打回节点「${target.alias || target.id}」返工` };
    }

    return { ok: false, msg: '无效的 review action（仅支持 approve / reject / archive）' };
  }

  // Send a structured instruction (Master -> Worker) or peer message (Cowork)
  async function sendMessage({
    projectId,
    fromNodeId,
    fromMachine,
    fromSessionId,
    callerCwd,
    toNodeId,
    toMachine,
    toSessionId,
    text,
    goal,
    stopCondition,
    type,
    forceWake = false,
  }) {
    const cleanText = cleanStr(text, 6000);
    if (!cleanText) return { ok: false, msg: '消息内容不能为空' };

    const callerResolved = resolveCaller({
      projectId,
      nodeId: fromNodeId,
      machine: fromMachine,
      sessionId: fromSessionId,
      callerCwd,
    });
    let proj = callerResolved.project;
    let fromNode = callerResolved.node;
    if (!proj && toMachine && toSessionId) {
      const f = findBySession(toMachine, toSessionId);
      if (f) proj = f.project;
    }
    if (!proj && toNodeId) {
      const f = resolveCaller({ nodeId: toNodeId });
      if (f.project) proj = f.project;
    }
    if (!proj) return { ok: false, msg: '找不到对应的协同项目拓扑' };

    if (!fromNode && fromNodeId) fromNode = proj.nodes.find((n) => n.id === fromNodeId || n.alias === fromNodeId) || null;
    let toNode = toNodeId ? proj.nodes.find((n) => n.id === toNodeId || n.alias === toNodeId) : null;
    if (!toNode && toMachine && toSessionId) {
      toNode = proj.nodes.find((n) => n.machine === toMachine && n.sessionId === toSessionId) || null;
    }
    if (!toNode) return { ok: false, msg: '在当前项目拓扑中找不到目标会话节点' };

    if (typeof goal === 'string' && goal.trim()) toNode.goal = cleanStr(goal, 1000);
    if (typeof stopCondition === 'string' && stopCondition.trim()) toNode.stopCondition = cleanStr(stopCondition, 1000);
    toNode.reviewStatus = 'running';

    const edge = fromNode && proj.edges.find((e) =>
      (e.from === fromNode.id && e.to === toNode.id) || (e.from === toNode.id && e.to === fromNode.id)
    );
    const msgType = type || (edge && edge.type === 'cowork' ? 'cowork' : toNode.role === 'peer' ? 'cowork' : 'command');
    const envelope = formatEnvelope({ project: proj, fromNode, toNode, type: msgType, text: cleanText, goal, stopCondition });

    const toTag = toNode.alias || toNode.id;
    const entry = board.append(proj.id, {
      channel: 'main',
      kind: 'post',
      agent: fromNode ? (fromNode.alias || fromNode.id) : '项目管理中心',
      nodeId: fromNode ? fromNode.id : null,
      text: `@${toTag} ${cleanText}`,
      mentions: [toTag],
    });
    if (fromNode) {
      fromNode.lastPostSeq = entry.seq;
      fromNode.lastReadSeq = Math.max(fromNode.lastReadSeq || 0, entry.seq);
    }
    toNode.lastMentionedSeq = entry.seq;
    toNode.lastMentionedAt = entry.ts;

    return deliverToNode(proj, toNode, envelope, { forceWake, seq: entry.seq });
  }

  // Worker reports completion / review gate hit back to its Master node
  async function reportResult({
    projectId,
    fromNodeId,
    fromMachine,
    fromSessionId,
    callerCwd,
    summary,
    reviewStatus = 'waiting_review',
    artifacts = [],
    doneWhenStatus = null,
    checksOutput = '',
    gitAudit = null,
    boundaries = null,
  }) {
    const { project: proj, node: workerNode } = resolveCaller({
      projectId,
      nodeId: fromNodeId,
      machine: fromMachine,
      sessionId: fromSessionId,
      callerCwd,
    });
    if (!proj || !workerNode) return { ok: false, msg: '找不到汇报节点所属的项目拓扑' };

    workerNode.reviewStatus = ['waiting_review', 'done', 'blocked', 'approved'].includes(reviewStatus) ? reviewStatus : 'waiting_review';
    let reportText = cleanStr(summary, 4000);
    if (Array.isArray(doneWhenStatus) && doneWhenStatus.length) {
      const statusText = doneWhenStatus
        .map((x) => (typeof x === 'string' ? cleanStr(x, 200) : `${cleanStr(x.item || x.title || '', 200)}:${x.ok ? '通过' : '未通过'}`))
        .filter(Boolean)
        .join('；');
      if (statusText) reportText += `\n验收自检：${statusText}`;
    }
    if (typeof checksOutput === 'string' && checksOutput.trim()) {
      reportText += `\n验证输出：${cleanStr(checksOutput, 1000)}`;
    }
    const auditRes = evaluateGitAudit(workerNode, gitAudit, boundaries);
    const warnings = formatAuditWarnings(auditRes);
    if (warnings.length) {
      reportText += `\n${warnings.join('\n')}`;
    }
    workerNode.lastReport = reportText;
    if (Array.isArray(artifacts)) {
      workerNode.artifacts = artifacts.map((a) => cleanStr(a, 400)).filter(Boolean).slice(0, 20);
    }
    workerNode.updatedAt = Date.now();
    if (watchdog) {
      watchdog.onNodeReport(proj.id, workerNode.id, workerNode.reviewStatus);
    }

    // Locate upstream master node via edges or role === 'master'
    const inEdge = proj.edges.find((e) => e.to === workerNode.id && e.type === 'master-worker');
    const masterNode = (inEdge && proj.nodes.find((n) => n.id === inEdge.from)) ||
      proj.nodes.find((n) => n.role === 'master' && n.id !== workerNode.id);

    const masterTag = masterNode ? (masterNode.alias || masterNode.id) : '';
    const statusTag = workerNode.reviewStatus === 'blocked' ? '[blocked]' : '[done]';
    const entry = board.append(proj.id, {
      channel: 'main',
      kind: 'report',
      agent: workerNode.alias || workerNode.id,
      nodeId: workerNode.id,
      text: `${masterTag ? '@' + masterTag + ' ' : ''}${statusTag} ${workerNode.lastReport}`,
      mentions: masterTag ? [masterTag] : [],
      artifacts: workerNode.artifacts || [],
      done: workerNode.reviewStatus === 'done' || workerNode.reviewStatus === 'waiting_review',
      audit: auditRes,
    });
    workerNode.lastPostSeq = entry.seq;
    workerNode.lastReadSeq = Math.max(workerNode.lastReadSeq || 0, entry.seq);
    if (masterNode) {
      masterNode.lastMentionedSeq = entry.seq;
      masterNode.lastMentionedAt = entry.ts;
    }

    save();
    if (!masterNode) {
      return { ok: true, msg: '已记录节点汇报（当前拓扑未配置主控节点）', entry, audit: auditRes, project: enrichProject(proj) };
    }

    const envelope = formatEnvelope({
      project: proj,
      fromNode: workerNode,
      toNode: masterNode,
      type: 'report',
      text: workerNode.lastReport,
      artifacts: workerNode.artifacts,
    });
    const deliv = await deliverToNode(proj, masterNode, envelope, { seq: entry.seq });
    return { ok: true, masterDelivery: deliv, entry, audit: auditRes, project: enrichProject(proj) };
  }

  const activeTransfers = new Map(); // readRid | upRid -> transfer state

  function agentFileSock(machineName, needUpload = false) {
    const m = machines && machines.get(machineName);
    if (!m || !m.online || !m.files || !m.sockets || !m.sockets.size) return null;
    const open = [...m.sockets].reverse().filter((s) => s && s.readyState === 1);
    if (!open.length) return null;
    if (needUpload) {
      const hasUpload = m.upload || open.some((s) => s.uploadAllowed === true);
      if (!hasUpload) return null;
      return open.find((s) => s.uploadAllowed === true && s.filesAllowed !== false) ||
        open.find((s) => s.filesAllowed !== false) ||
        open[0];
    }
    return open.find((s) => s.filesAllowed === true) || open.find((s) => s.filesAllowed !== false) || open[0];
  }

  function sendAgentFs(machineName, needUpload, payload) {
    const sock = agentFileSock(machineName, needUpload);
    if (!sock) return false;
    try {
      sock.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function cleanupTransfer(st) {
    if (st.done) return;
    st.done = true;
    clearTimeout(st.timer);
    activeTransfers.delete(st.readRid);
    activeTransfers.delete(st.upRid);
  }

  function failTransfer(st, reason) {
    if (st.done) return;
    cleanupTransfer(st);
    st.item.status = 'pending';
    st.item.error = cleanStr(reason || '传输失败', 300);
    st.item.updatedAt = Date.now();
    save();
  }

  function touchTransfer(st) {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      if (st.done) return;
      sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
      sendAgentFs(st.toMachine, true, { t: 'fs-cancel', rid: st.upRid, drop: false });
      failTransfer(st, '跨机传输超时（60秒无响应）');
    }, 60e3);
    if (st.timer.unref) st.timer.unref();
  }

  function processTransferChunk(st, i, buf) {
    const off = st.sentOff;
    st.sentOff += buf.length;
    st.crc = crc32Of(buf, st.crc);
    const endOff = off + buf.length;
    if (endOff <= st.have) {
      sendAgentFs(st.fromMachine, false, { t: 'fs-ack', rid: st.readRid, i });
      return true;
    }
    const sendOff = off < st.have ? st.have : off;
    const slice = off < st.have ? buf.subarray(st.have - off) : buf;
    st.awaitingAck.push({ i, endOff });
    const ok = sendAgentFs(st.toMachine, true, {
      t: 'fs-up',
      rid: st.upRid,
      off: sendOff,
      data: slice.toString('base64'),
    });
    if (!ok) {
      sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
      failTransfer(st, '向目标机器发送数据块失败');
      return false;
    }
    return true;
  }

  function finishTransferReadIfReady(st) {
    if (st.done || st.upEndSent || !st.readEnded || st.phase !== 'streaming') return;
    st.upEndSent = true;
    st.phase = 'finishing';
    const ok = sendAgentFs(st.toMachine, true, { t: 'fs-up-end', rid: st.upRid, crc: st.crc >>> 0 });
    if (!ok) {
      failTransfer(st, '向目标机器发送结束校验请求失败');
    }
  }

  function startAutoTransfer(proj, item) {
    const readRid = 'mfs-r-' + crypto.randomBytes(8).toString('hex');
    const upRid = 'mfs-u-' + crypto.randomBytes(8).toString('hex');
    const remotePath = /^[A-Za-z]:[\\/]/.test(item.toPath) || /^\\\\/.test(item.toPath) ? path.win32 : path.posix;
    const st = {
      proj,
      item,
      readRid,
      upRid,
      fromMachine: item.fromMachine,
      toMachine: item.toMachine,
      dstDir: remotePath.dirname(item.toPath),
      dstName: remotePath.basename(item.toPath),
      phase: 'reading',
      size: 0,
      mtime: 0,
      have: 0,
      sentOff: 0,
      crc: 0,
      pendingChunks: [],
      awaitingAck: [],
      readEnded: false,
      upEndSent: false,
      timer: null,
      done: false,
    };
    activeTransfers.set(readRid, st);
    activeTransfers.set(upRid, st);
    touchTransfer(st);
    const ok = sendAgentFs(st.fromMachine, false, {
      t: 'fs',
      rid: readRid,
      op: 'read',
      path: item.fromPath,
      dl: true,
    });
    if (!ok) {
      failTransfer(st, '向源机器发送读取请求失败');
    }
  }

  function fromAgentFs(machineObj, d) {
    if (!d || typeof d.rid !== 'string' || !d.rid.startsWith('mfs-')) return false;
    const st = activeTransfers.get(d.rid);
    if (!st || st.done) return true;
    const mName = typeof machineObj === 'string' ? machineObj : (machineObj && machineObj.name);
    if (d.rid === st.readRid && mName && mName !== st.fromMachine) return true;
    if (d.rid === st.upRid && mName && mName !== st.toMachine) return true;

    touchTransfer(st);

    if (d.rid === st.readRid) {
      if (d.t === 'fs-res') {
        if (!d.ok) {
          failTransfer(st, '读取源文件失败：' + (d.msg || ''));
          return true;
        }
        const sz = Number(d.size) || 0;
        if (sz >= AUTO_FILE_LIMIT) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          cleanupTransfer(st);
          st.item.size = sz;
          st.item.mode = 'manual_disk';
          st.item.status = 'pending';
          st.item.error = '';
          st.item.note = (st.item.note ? st.item.note + '；' : '') + '实际文件 >= 50MB，已自动转为移动硬盘人工摆渡';
          st.item.updatedAt = Date.now();
          save();
          return true;
        }
        st.size = sz;
        st.mtime = Number.isFinite(d.mtime) ? d.mtime : 0;
        st.item.size = sz;
        st.item.updatedAt = Date.now();
        st.phase = 'up_opening';
        save();
        const ok = sendAgentFs(st.toMachine, true, {
          t: 'fs',
          rid: st.upRid,
          op: 'up-open',
          path: st.dstDir,
          name: st.dstName,
          size: sz,
          mtime: st.mtime,
          overwrite: true,
        });
        if (!ok) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          failTransfer(st, '向目标机器发送写入请求失败');
        }
        return true;
      }
      if (d.t === 'fs-chunk') {
        const buf = typeof d.data === 'string' ? Buffer.from(d.data, 'base64') : Buffer.alloc(0);
        if (st.phase === 'up_opening' || st.phase === 'reading') {
          if (st.pendingChunks.length < 16) st.pendingChunks.push({ i: d.i, buf });
        } else if (st.phase === 'streaming') {
          processTransferChunk(st, d.i, buf);
        }
        return true;
      }
      if (d.t === 'fs-end') {
        st.readEnded = true;
        finishTransferReadIfReady(st);
        return true;
      }
      return true;
    }

    if (d.rid === st.upRid) {
      if (d.t === 'fs-res') {
        if (!d.ok) {
          sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
          failTransfer(st, '目标写入失败：' + (d.msg || ''));
          return true;
        }
        st.have = Number.isSafeInteger(d.have) && d.have > 0 ? d.have : 0;
        st.phase = 'streaming';
        const buffered = st.pendingChunks.splice(0, st.pendingChunks.length);
        for (const c of buffered) {
          if (!processTransferChunk(st, c.i, c.buf)) return true;
        }
        finishTransferReadIfReady(st);
        return true;
      }
      if (d.t === 'fs-up-ack') {
        if (d.checking) return true;
        while (
          st.awaitingAck.length > 0 &&
          (typeof d.have !== 'number' || st.awaitingAck[0].endOff <= d.have)
        ) {
          const acked = st.awaitingAck.shift();
          sendAgentFs(st.fromMachine, false, { t: 'fs-ack', rid: st.readRid, i: acked.i });
        }
        return true;
      }
      if (d.t === 'fs-up-done') {
        if (d.ok) {
          cleanupTransfer(st);
          st.item.status = 'completed';
          st.item.error = '';
          st.item.updatedAt = Date.now();
          recordEvent(st.proj, {
            source: 'transfer',
            kind: 'auto_done',
            machine: st.item.toMachine,
            summary: '跨机文件自动传输完成：' + st.dstName,
          });
          const targetNode = (st.item.notifyNodeId && st.proj.nodes.find((n) => n.id === st.item.notifyNodeId)) ||
            st.proj.nodes.find((n) => n.machine === st.item.toMachine) ||
            st.proj.nodes.find((n) => n.role === 'master');
          if (targetNode) {
            const msg = formatEnvelope({
              project: st.proj,
              toNode: targetNode,
              type: 'handoff_ready',
              text: `跨机文件已自动传输就位：源 [${st.item.fromMachine}:${st.item.fromPath}] -> 目标 [${st.item.toMachine}:${d.path || st.item.toPath}]。请直接读取该路径继续后续任务。`,
            });
            deliverToNode(st.proj, targetNode, msg).catch(() => {});
          }
        } else {
          failTransfer(st, d.msg || '传输校验失败');
        }
        return true;
      }
    }
    return true;
  }

  // Register a cross-machine file transfer or sneakernet (manual disk copy) handoff request
  function requestTransfer({
    projectId,
    fromMachine,
    fromPath,
    toMachine,
    toPath,
    size = 0,
    mode = '', // 'auto' | 'manual_disk'
    notifyNodeId = '',
    note = '',
  }) {
    const proj = projectId ? data.projects.find((x) => x.id === projectId) : data.projects[0];
    if (!proj) return { ok: false, msg: '请先创建或指定协同项目' };
    const cleanFromM = cleanStr(fromMachine, 60), cleanFromP = cleanStr(fromPath, 600);
    const cleanToM = cleanStr(toMachine, 60), cleanToP = cleanStr(toPath, 600);
    if (!cleanFromM || !cleanFromP || !cleanToM || !cleanToP) return { ok: false, msg: '源路径和目标路径不能为空' };
    if (cleanFromM === cleanToM && normFolderPath(cleanFromP) === normFolderPath(cleanToP)) {
      return { ok: false, msg: '源路径与目标路径完全相同，无需传输' };
    }

    // Check workspace write permission on destination
    const remotePath = /^[A-Za-z]:[\\/]/.test(cleanToP) || /^\\\\/.test(cleanToP) ? path.win32 : path.posix;
    const dstCheck = checkWorkspaceAccess(proj, cleanToM, remotePath.dirname(cleanToP), true);
    if (!dstCheck.ok) return dstCheck;

    const numSize = +size || 0;
    const finalMode = mode === 'manual_disk' || numSize >= AUTO_FILE_LIMIT ? 'manual_disk' : 'auto';
    const item = {
      id: idGen('xfer'),
      fromMachine: cleanFromM,
      fromPath: cleanFromP,
      toMachine: cleanToM,
      toPath: cleanToP,
      size: numSize,
      mode: finalMode,
      status: 'pending',
      notifyNodeId: cleanStr(notifyNodeId, 40),
      note: cleanStr(note, 500),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    proj.transfers = proj.transfers || [];
    if (proj.transfers.length >= MAX_TRANSFERS) proj.transfers.pop();
    proj.transfers.unshift(item);

    if (finalMode === 'auto') {
      const fromSock = agentFileSock(cleanFromM, false);
      const toSock = agentFileSock(cleanToM, true);
      if (fromSock && toSock) {
        item.status = 'transferring';
        item.error = '';
        save();
        startAutoTransfer(proj, item);
        return { ok: true, transfer: item, project: enrichProject(proj) };
      }
      const fromM = machines && machines.get(cleanFromM);
      const toM = machines && machines.get(cleanToM);
      const toHasUpload = toM && (toM.upload || [...(toM.sockets || [])].some((s) => s && s.readyState === 1 && s.uploadAllowed === true));
      if (!fromM || !fromM.online) item.error = `源机器「${cleanFromM}」不在线`;
      else if (!fromM.files) item.error = `源机器「${cleanFromM}」未开启文件服务`;
      else if (!fromSock) item.error = `源机器「${cleanFromM}」无可用文件连接`;
      else if (!toM || !toM.online) item.error = `目标机器「${cleanToM}」不在线`;
      else if (!toM.files) item.error = `目标机器「${cleanToM}」未开启文件服务`;
      else if (!toHasUpload) item.error = `目标机器「${cleanToM}」未开启文件上传`;
      else item.error = `目标机器「${cleanToM}」无可用上传连接`;
    }

    save();
    return { ok: true, transfer: item, project: enrichProject(proj) };
  }

  // Confirm a manual disk handoff (sneakernet) is complete and optionally wake the waiting session
  async function confirmTransfer(projectId, transferId, { newToPath = '', wake = true } = {}) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    const xfer = (proj.transfers || []).find((t) => t.id === transferId);
    if (!xfer) return { ok: false, msg: '找不到该文件传输记录' };
    for (const st of activeTransfers.values()) {
      if (st.item === xfer && !st.done) {
        sendAgentFs(st.fromMachine, false, { t: 'fs-cancel', rid: st.readRid });
        sendAgentFs(st.toMachine, true, { t: 'fs-cancel', rid: st.upRid, drop: true });
        cleanupTransfer(st);
      }
    }
    if (typeof newToPath === 'string' && newToPath.trim()) {
      xfer.toPath = cleanStr(newToPath, 600);
    }
    xfer.status = 'completed';
    xfer.updatedAt = Date.now();
    save();

    const targetNode = (xfer.notifyNodeId && proj.nodes.find((n) => n.id === xfer.notifyNodeId)) ||
      proj.nodes.find((n) => n.machine === xfer.toMachine) ||
      proj.nodes.find((n) => n.role === 'master');

    if (wake && targetNode) {
      const msg = formatEnvelope({
        project: proj,
        toNode: targetNode,
        type: 'handoff_ready',
        text: `超大文件已通过人工硬盘拷贝就位：源 [${xfer.fromMachine}:${xfer.fromPath}] -> 目标 [${xfer.toMachine}:${xfer.toPath}]。请直接读取该路径继续后续任务。`,
      });
      await deliverToNode(proj, targetNode, msg, { forceWake: true });
    }
    return { ok: true, transfer: xfer, project: enrichProject(proj) };
  }

  // Flush queued inbox messages when a session transitions to idle/done, and bind newly spawned sessions by cwd
  function onMachineState(machineName, sessionsList) {
    let dirty = false;
    const now = Date.now();
    // Clean expired pending spawns (> 2 minutes)
    for (const [k, arr] of pendingSpawns) {
      const keep = arr.filter((x) => now - x.t0 < 120e3);
      if (keep.length) pendingSpawns.set(k, keep); else pendingSpawns.delete(k);
    }

    for (const s of sessionsList || []) {
      if (!s || typeof s.id !== 'string') continue;
      // 1. Check if this session matches a pending spawn on this machine
      const savedInfo = store && store.info && store.info(machineName, s.id);
      const sCwd = s.cwd || (savedInfo && savedInfo.cwd) || '';
      if (sCwd) {
        const spKey = `${machineName}|${normFolderPath(sCwd)}`;
        const waiting = pendingSpawns.get(spKey);
        if (waiting && waiting.length) {
          const alreadyBound = data.projects.some((p) => p.nodes.some((n) => n.machine === machineName && n.sessionId === s.id));
          if (!alreadyBound) {
            const sTool = inferToolFromSessionId(s.id);
            let pickIdx = waiting.findIndex((w) => {
              const p = data.projects.find((x) => x.id === w.projectId);
              const nd = p && p.nodes.find((n) => n.id === w.nodeId);
              return nd && !nd.sessionId && (!nd.tool || nd.tool === sTool);
            });
            if (pickIdx < 0) pickIdx = 0;
            const [match] = waiting.splice(pickIdx, 1);
            if (!waiting.length) pendingSpawns.delete(spKey);
            const proj = data.projects.find((p) => p.id === match.projectId);
            const node = proj && proj.nodes.find((n) => n.id === match.nodeId);
            if (node && !node.sessionId) {
              node.sessionId = s.id;
              node.updatedAt = now;
              syncMarksGroup(proj);
              dirty = true;
            }
          }
        }
      }

      // 2. If session is now idle or done (and has no open permission prompts), flush its inbox and any unread @mentions
      const isIdle = s.state === 'idle' || s.state === 'done';
      const hasPerms = Array.isArray(s.perms) && s.perms.length > 0;
      const canInject = !s.via || s.via !== 'off';
      if (isIdle && !hasPerms && canInject) {
        const found = findBySession(machineName, s.id);
        if (found) {
          const node = found.node;
          const parts = [];
          let autoMsgs = [];
          if (Array.isArray(node.inbox) && node.inbox.length > 0) {
            autoMsgs = node.inbox.filter((m) => !m.needsManualWake);
            if (autoMsgs.length > 0) {
              node.inbox = node.inbox.filter((m) => m.needsManualWake);
              parts.push(...autoMsgs.map((m) => m.text));
              const maxFlushedSeq = autoMsgs.reduce((mx, m) => Math.max(mx, m.seq || 0), 0);
              if (maxFlushedSeq) node.lastNudgedSeq = Math.max(node.lastNudgedSeq || 0, maxFlushedSeq);
              dirty = true;
            }
          }

          const cursor = Math.max(node.lastReadSeq || 0, node.lastNudgedSeq || 0);
          let unreadWakeText = '';
          if ((node.lastMentionedSeq || 0) > cursor) {
            const { entries } = board.read(found.project.id, { since: cursor, limit: 20 });
            const aliasL = String(node.alias || '').toLowerCase();
            const idL = String(node.id || '').toLowerCase();
            const subscribedChannels = new Set(
              board.getChannels(found.project.id)
                .filter((c) => !c.archived && Array.isArray(c.subscribers) && c.subscribers.includes(node.id))
                .map((c) => String(c.name || '').toLowerCase())
            );
            const unread = entries.filter((e) => {
              if (e.nodeId && e.nodeId === node.id) return false;
              if (e.mentionAll || node.wakeMode === 'all') return true;
              const mc = Array.isArray(e.mentionChannels) ? e.mentionChannels.map((x) => String(x).toLowerCase()) : [];
              const ech = String(e.channel || 'main').toLowerCase();
              if (subscribedChannels.size && ((ech !== 'main' && subscribedChannels.has(ech)) || mc.some((c) => subscribedChannels.has(c)))) {
                return true;
              }
              const ms = Array.isArray(e.mentions) ? e.mentions.map((x) => String(x).toLowerCase()) : [];
              const roleL = String(node.role || '').toLowerCase();
              return (aliasL && ms.includes(aliasL)) || (idL && ms.includes(idL)) || (roleL && ms.includes(roleL));
            });
            if (unread.length > 0) {
              unreadWakeText = unread
                .map((entry) => formatWakePrompt({ project: found.project, entry, targetNode: node }))
                .join('\n\n---\n\n');
              parts.push(unreadWakeText);
            }
            node.lastNudgedSeq = Math.max(node.lastNudgedSeq || 0, node.lastMentionedSeq || 0);
            dirty = true;
          }

          if (parts.length > 0) {
            const combined = parts.join('\n\n---\n\n');
            sendToAgent(machineName, { t: 'send', id: s.id, text: combined }).then((r) => {
              if (!r || !r.ok) {
                const fallbackMsgs = [...autoMsgs.map((m) => ({ ...m, needsManualWake: true }))];
                if (unreadWakeText) {
                  fallbackMsgs.push({ id: idGen('msg'), text: unreadWakeText, at: Date.now(), needsManualWake: true });
                }
                node.inbox = [...fallbackMsgs, ...(node.inbox || [])].slice(0, MAX_INBOX);
                save();
              }
            }).catch(() => {});
          }
        }
      }
    }
    if (dirty) save();
    syncAgentTriggers(machineName);
    if (watchdog) watchdog.tick();
  }

  // Also bind pending spawns when agent sends `meta` with `cwd`
  function onSessionMeta(machineName, sessionId, cwd) {
    if (!cwd || !sessionId) return;
    const spKey = `${machineName}|${normFolderPath(cwd)}`;
    const waiting = pendingSpawns.get(spKey);
    if (!waiting || !waiting.length) return;
    const alreadyBound = data.projects.some((p) => p.nodes.some((n) => n.machine === machineName && n.sessionId === sessionId));
    if (alreadyBound) return;
    const match = waiting.shift();
    if (!waiting.length) pendingSpawns.delete(spKey);
    const proj = data.projects.find((p) => p.id === match.projectId);
    const node = proj && proj.nodes.find((n) => n.id === match.nodeId);
    if (node && !node.sessionId) {
      node.sessionId = sessionId;
      node.updatedAt = Date.now();
      syncMarksGroup(proj);
      save();
    }
  }

  function syncAgentTriggers(machineName) {
    if (!machineName) return;
    const triggers = [];
    for (const p of data.projects) {
      for (const t of p.triggers || []) {
        if (t.machine === machineName && t.type === 'folder' && t.enabled !== false) {
          triggers.push({
            id: t.id,
            projectId: p.id,
            machine: t.machine,
            path: t.path,
            glob: t.glob,
            maxDepth: t.maxDepth || 4,
            label: t.label,
          });
        }
      }
    }
    const m = machines && machines.get(machineName);
    if (m && m.sockets) {
      for (const ws of m.sockets) {
        try { ws.send(JSON.stringify({ t: 'mesh-triggers', triggers })); } catch {}
      }
    }
  }

  function upsertTrigger(projectId, d = {}) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '项目不存在' };
    if (d.type !== 'process' && d.path) {
      const acc = checkWorkspaceAccess(proj, d.machine, d.path, false);
      if (!acc.ok) return { ok: false, msg: acc.msg };
    }
    proj.triggers = proj.triggers || [];
    let trig = d.id || d.triggerId ? proj.triggers.find((t) => t.id === (d.id || d.triggerId)) : null;
    if (!trig) {
      if (proj.triggers.length >= 50) return { ok: false, msg: '触发器数量已达上限 (50)' };
      trig = {
        id: idGen('trig'),
        projectId: proj.id,
        type: 'folder',
        machine: cleanStr(d.machine, 60),
        targetNodeId: cleanStr(d.targetNodeId, 40) || null,
        label: cleanStr(d.label, 80) || cleanStr(d.path, 120) || '触发器',
        path: cleanStr(d.path, 500),
        glob: cleanStr(d.glob, 80) || '*',
        maxDepth: Math.max(1, Math.min(6, Math.floor(+d.maxDepth || 4))),
        enabled: d.enabled !== false,
        createdAt: Date.now(),
        lastTriggeredAt: null,
        fireTimestamps: [],
      };
      proj.triggers.push(trig);
    } else {
      trig.type = 'folder';
      if (d.machine) trig.machine = cleanStr(d.machine, 60);
      if (d.targetNodeId !== undefined) trig.targetNodeId = cleanStr(d.targetNodeId, 40) || null;
      if (d.label) trig.label = cleanStr(d.label, 80);
      if (d.path) trig.path = cleanStr(d.path, 500);
      if (d.glob) trig.glob = cleanStr(d.glob, 80);
      if (d.maxDepth !== undefined) trig.maxDepth = Math.max(1, Math.min(6, Math.floor(+d.maxDepth || 4)));
      if (d.enabled !== undefined) trig.enabled = !!d.enabled;
    }
    save();
    syncAgentTriggers(trig.machine);
    return { ok: true, trigger: trig, project: enrichProject(proj) };
  }

  function removeTrigger(projectId, triggerId) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '项目不存在' };
    const trig = (proj.triggers || []).find((t) => t.id === triggerId);
    const m = trig ? trig.machine : null;
    proj.triggers = (proj.triggers || []).filter((t) => t.id !== triggerId);
    save();
    if (m) syncAgentTriggers(m);
    return { ok: true, project: enrichProject(proj) };
  }

  const recentEventDebounce = new Map();
  async function emitEvent(d) {
    if (!d || typeof d !== 'object') return { ok: false, msg: '无效事件' };
    const nowTs = Date.now();
    // Fast-path deduplication (5 seconds)
    const dedupeKey = `${d.projectId || ''}|${d.triggerId || ''}|${d.source || ''}|${d.machine || ''}|${d.sessionId || ''}|${d.nodeId || ''}|${d.kind || ''}|${d.label || ''}|${(d.files || []).join(',')}`;
    const lastSeen = recentEventDebounce.get(dedupeKey) || 0;
    if (nowTs - lastSeen < 5000) {
      return { ok: true, deduped: true };
    }
    recentEventDebounce.set(dedupeKey, nowTs);
    if (recentEventDebounce.size > 500) {
      for (const [k, v] of recentEventDebounce.entries()) {
        if (nowTs - v > 60000) recentEventDebounce.delete(k);
      }
    }

    // Locate target project
    let proj = d.projectId ? data.projects.find((p) => p.id === d.projectId) : null;
    if (!proj && d.sessionId && d.machine) {
      proj = data.projects.find((p) => (p.nodes || []).some((n) => n.machine === d.machine && n.sessionId === d.sessionId));
    }
    if (!proj && d.cwd && d.machine) {
      const normCwd = normFolderPath(d.cwd);
      proj = data.projects.find((p) =>
        (p.nodes || []).some((n) => n.machine === d.machine && normFolderPath(n.cwd) === normCwd) ||
        (p.workspaces || []).some((w) => w.machine === d.machine && normFolderPath(w.path) === normCwd)
      );
    }
    if (!proj && data.projects.length === 1) {
      proj = data.projects[0];
    }
    if (!proj) return { ok: false, msg: '未找到匹配的项目' };

    // Rate-limit if bound to trigger
    let trig = null;
    if (d.triggerId) {
      trig = (proj.triggers || []).find((t) => t.id === d.triggerId);
      if (trig) {
        if (trig.enabled === false) return { ok: false, msg: '触发器已禁用' };
        const maxPerHour = (watchdog && watchdog.getConfig().triggerMaxPerHour) || 6;
        trig.fireTimestamps = (trig.fireTimestamps || []).filter((t) => nowTs - t <= 3600e3);
        if (trig.fireTimestamps.length >= maxPerHour) {
          return { ok: false, msg: `触发器已达每小时上限 (${maxPerHour}次)` };
        }
        trig.fireTimestamps.push(nowTs);
        trig.lastTriggeredAt = nowTs;
      }
    }

    // Locate target node
    let targetNode = null;
    if (d.targetNodeId) {
      targetNode = (proj.nodes || []).find((n) => n.id === d.targetNodeId);
    }
    if (!targetNode && d.nodeId) {
      targetNode = (proj.nodes || []).find((n) => n.id === d.nodeId);
    }
    if (!targetNode && trig && trig.targetNodeId) {
      targetNode = (proj.nodes || []).find((n) => n.id === trig.targetNodeId);
    }
    if (!targetNode && d.sessionId && d.machine) {
      targetNode = (proj.nodes || []).find((n) => n.machine === d.machine && n.sessionId === d.sessionId);
    }
    if (!targetNode) {
      targetNode = (proj.nodes || []).find((n) => n.role === 'master') ||
                   (proj.nodes || []).find((n) => n.machine === d.machine) ||
                   (proj.nodes || [])[0];
    }

    // Record event
    const summary = d.summary || (d.source === 'run'
      ? `计算作业「${d.label || '后台作业'}」退出 (${d.exitCode})`
      : d.source === 'folder'
      ? `目录「${d.path || ''}」检测到文件就绪 (${(d.files || []).join(', ')})`
      : '外部事件');
    const evt = {
      id: idGen('evt'),
      projectId: proj.id,
      ts: nowTs,
      source: d.source || 'run',
      kind: d.kind || '',
      machine: d.machine || (targetNode ? targetNode.machine : ''),
      nodeId: targetNode ? targetNode.id : null,
      summary,
      payload: { ...d },
    };
    recordEvent(proj, evt);

    // Format envelope
    let envelopeText = '';
    const machLabel = d.machine || (targetNode ? targetNode.machine : '');
    if (d.source === 'run') {
      envelopeText = `[AmeMesh 计算进程结束事件 | 项目：${proj.name} | 机器：${machLabel}]\n作业名称：${d.label || '后台作业'}\n退出码：${d.exitCode}（耗时 ${Math.round((d.durationMs || 0) / 1000)}s）\n${d.tail ? '日志末尾：\n' + d.tail + '\n' : ''}请检查计算结果并继续后续处理或调用 mesh_report 汇报。`;
    } else if (d.source === 'folder') {
      envelopeText = `[AmeMesh 目录文件就绪事件 | 项目：${proj.name} | 机器：${machLabel}]\n监听目录：${d.path}\n新增/变更文件：${(d.files || []).join(', ')}\n请读取上述文件继续任务。`;
    } else {
      envelopeText = `[AmeMesh 外部事件 | 项目：${proj.name}]\n${summary}`;
    }

    if (targetNode) {
      if (targetNode.reviewStatus === 'blocked') {
        targetNode.reviewStatus = 'running';
      }
      await deliverToNode(proj, targetNode, envelopeText);
    }

    if (d.source === 'run' && d.exitCode !== 0 && typeof notify === 'function') {
      notify({
        title: `后台作业异常退出 (${d.exitCode}) · ${d.label || '后台作业'}`,
        body: `${proj.name} (${machLabel})`,
        tag: `run-${evt.id}`,
        url: `/#proj=${proj.id}`,
      });
    }

    save();
    return { ok: true, event: evt, delivered: !!targetNode };
  }

  // Flush manual-wake or queued inbox messages on user demand
  async function flushInbox(projectId, nodeId) {
    const proj = data.projects.find((x) => x.id === projectId);
    const node = proj && proj.nodes.find((n) => n.id === nodeId);
    if (!proj || !node) return { ok: false, msg: '找不到该节点' };
    if (!node.inbox || !node.inbox.length) return { ok: true, msg: '收件箱为空' };
    const combined = node.inbox.map((m) => m.text).join('\n\n---\n\n');
    node.inbox = [];
    save();
    return deliverToNode(proj, node, combined, { forceWake: true });
  }

  // HTTP API handler for browser (`项目管理` app)
  async function handle(req, res, url, ip, json, readBody, isFresh) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/mesh/projects') {
      json(res, 200, { ok: true, projects: listProjects() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/scope') {
      const projectId = url.searchParams.get('projectId') || '';
      const nodeId = url.searchParams.get('nodeId') || '';
      const machine = url.searchParams.get('machine') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      const callerCwd = url.searchParams.get('callerCwd') || '';
      const includeTree = url.searchParams.get('includeTree') === '1' || url.searchParams.get('includeTree') === 'true';
      json(res, 200, scopedViewFor({ projectId, nodeId, machine, sessionId, callerCwd, includeTree }));
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/config') {
      json(res, 200, { ok: true, config: watchdog.getConfig() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/roles') {
      json(res, 200, { ok: true, roles: roleStore.list() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/pools') {
      json(res, 200, { ok: true, pools: modelRouter.getPoolsStatus() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/skills') {
      json(res, 200, { ok: true, skills: listSkills() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/machine-profiles') {
      json(res, 200, { ok: true, machines: machinesSummary() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/cli-updates') {
      json(res, 200, { ok: true, updates: listCliUpdates() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/queue') {
      const mach = url.searchParams.get('machine') || '';
      const resource = url.searchParams.get('resource') || '';
      const q = computeQueue.list({ machine: mach, resource });
      json(res, 200, { ...q, machines: machinesSummary() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/local-quotas') {
      json(res, 200, { ok: true, quotas: listLocalQuotas() });
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/fable-advice') {
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      const mpStatus = typeof getMagpie === 'function' ? getMagpie()?.status?.() : null;
      const todoItems = typeof getTodos === 'function' ? (getTodos() || []) : [];
      json(res, 200, evaluateFableAdvice({
        magpieStatus: mpStatus,
        projects: data.projects,
        todos: todoItems,
        readBoard: (pid, opts) => board.read(pid, opts),
        force,
      }));
      return true;
    }
    if (req.method === 'GET' && p === '/api/mesh/board') {
      const projectId = url.searchParams.get('projectId') || '';
      const nodeId = url.searchParams.get('nodeId') || '';
      const machine = url.searchParams.get('machine') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      const callerCwd = url.searchParams.get('callerCwd') || '';
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const limit = Number(url.searchParams.get('limit') || 50) || 50;
      const channel = url.searchParams.get('channel') || '';
      const seqListRaw = url.searchParams.get('seqList') || '';
      const seqList = seqListRaw
        ? seqListRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isSafeInteger(n) && n > 0)
        : null;
      json(res, 200, readBoard({ projectId, nodeId, machine, sessionId, callerCwd, since, limit, channel, seqList }));
      return true;
    }
    if (req.method !== 'POST' || !p.startsWith('/api/mesh/')) return false;

    let d = {};
    try { d = JSON.parse(await readBody(req, 32768)); } catch {}
    // Operations that act on remote machines require a fresh TOTP session
    const needsStepUp = ['/api/mesh/spawn', '/api/mesh/fable-advice/launch', '/api/mesh/send', '/api/mesh/report', '/api/mesh/flush', '/api/mesh/transfer-confirm', '/api/mesh/board/post', '/api/mesh/worktree-remove', '/api/mesh/queue'].includes(p);
    if (needsStepUp && typeof isFresh === 'function' && !isFresh()) {
      json(res, 200, { ok: false, need: 'totp', msg: '远程操作前请再输一次验证码' });
      return true;
    }

    if (p === '/api/mesh/project') {
      const r = d.op === 'delete' ? deleteProject(d.id) : saveProject(d);
      if (r.ok) audit('mesh-project', ip, d.op || 'save', String(d.name || d.id || '').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/node') {
      const r = d.op === 'delete' ? removeNode(d.projectId, d.nodeId) : upsertNode(d.projectId, d);
      if (r.ok) audit('mesh-node', ip, d.op || 'upsert', String(d.projectId || '').slice(0, 24));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/edge') {
      const r = d.op === 'delete' ? removeEdge(d.projectId, d) : addEdge(d.projectId, d);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/spawn') {
      const r = await spawnWorker(d);
      if (r.ok) audit('mesh-spawn', ip, String(d.machine || ''), String(d.cwd || '').slice(0, 120));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/send') {
      const r = await sendMessage(d);
      if (r.ok) audit('mesh-send', ip, String(d.projectId || ''), String(d.toNodeId || ''));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/review') {
      const r = await reviewNode(d);
      if (r.ok) audit('mesh-review', ip, String(d.action || ''), String(d.nodeId || '').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/report') {
      const r = await reportResult(d);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/flush') {
      const r = await flushInbox(d.projectId, d.nodeId);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/transfer') {
      const r = requestTransfer(d);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/transfer-confirm') {
      const r = await confirmTransfer(d.projectId, d.transferId, d);
      if (r.ok) audit('mesh-transfer-confirm', ip, String(d.transferId || ''));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/fable-advice/launch') {
      const mach = cleanStr(d.machine, 60);
      const cwd = cleanStr(d.cwd, 500);
      const title = cleanStr(d.title, 120) || 'Fable 顾问诊断';
      const prompt = cleanStr(d.advisorPrompt || d.prompt, 7000);
      if (!mach || !cwd || !prompt) {
        json(res, 200, { ok: false, msg: '启动 Fable 顾问会话需要指定 machine、cwd 与 prompt' });
        return true;
      }
      const r = await spawnWorker({
        projectId: cleanStr(d.projectId, 40) || undefined,
        machine: mach,
        cwd,
        role: 'verifier',
        tool: 'opencode',
        model: 'magpie/devin/claude-fable-5-2',
        alias: cleanStr(d.alias, 60) || 'fable-advisor',
        goal: `只读深度诊断与方案拍板：${title}`,
        stopCondition: '输出根因分析、方案对比与最小验证步骤后停下，严禁修改任何业务文件',
        prompt,
      });
      if (r.ok) audit('mesh-fable-launch', ip, mach, title.slice(0, 60));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/config') {
      json(res, 200, { ok: true, config: watchdog.updateConfig(d) });
      return true;
    }
    if (p === '/api/mesh/watchdog-dismiss') {
      json(res, 200, watchdog.dismissAlert(d.projectId, d.nodeId));
      return true;
    }
    if (p === '/api/mesh/trigger-upsert') {
      json(res, 200, upsertTrigger(d.projectId, d));
      return true;
    }
    if (p === '/api/mesh/trigger-remove') {
      json(res, 200, removeTrigger(d.projectId, d.triggerId));
      return true;
    }
    if (p === '/api/mesh/event') {
      json(res, 200, await emitEvent(d));
      return true;
    }
    if (p === '/api/mesh/board/post') {
      const r = await postBoard(d);
      if (r.ok) audit('mesh-board-post', ip, String(d.projectId || ''), String(d.agent || '管理员').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/task') {
      const r = await manageTask(d);
      if (r.ok) audit('mesh-task', ip, String(d.action || ''), String(d.taskId || d.title || '').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/channel') {
      const r = manageChannel(d);
      if (r.ok) audit('mesh-channel', ip, String(d.action || ''), String(d.channel || '').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/worktree-check') {
      const r = await checkNodeWorktree(d.projectId, d.nodeId);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/worktree-remove') {
      const r = await removeNodeWorktree(d.projectId, d.nodeId, { force: !!d.force });
      if (r.ok) audit('mesh-worktree-remove', ip, String(d.projectId || ''), String(d.nodeId || '').slice(0, 40));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/roles') {
      const r = d.op === 'reset' ? roleStore.reset(d.name) : roleStore.save(d.name, d.raw);
      if (r.ok) audit('mesh-roles', ip, d.op || 'save', String(d.name || '').slice(0, 32));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/skills') {
      const r = d.op === 'reset' ? resetSkill(d.name) : saveSkill(d.name, d.raw);
      if (r.ok) audit('mesh-skills', ip, d.op || 'save', String(d.name || '').slice(0, 48));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/machine-profiles') {
      const r = saveMachineProfile(d);
      if (r.ok) audit('mesh-machine-profiles', ip, 'save', String(d.machine || '').slice(0, 60));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/cli-updates') {
      const r = clearCliUpdate(d);
      audit('mesh-cli-updates', ip, 'clear', `${d.machine || 'all'}:${d.tool || 'all'}`);
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/queue') {
      let r;
      if (d.op === 'submit') {
        const provType = cleanStr(d.providerType, 32) || 'local-agent';
        const needMachine = provType !== 'colab';
        if ((needMachine && !cleanStr(d.machine, 60)) || !cleanStr(d.command, 1000)) {
          r = { ok: false, msg: needMachine ? '提交远程作业需要提供 machine 与 command' : '提交 Colab 作业需要提供 command' };
        } else {
          r = computeQueue.enqueue({
            machine: d.machine || '',
            resource: d.resource || 'gpu',
            gpus: d.gpus,
            numa: d.numa,
            priority: d.priority || 'normal',
            mode: 'remote',
            providerType: provType,
            colabGpu: d.colabGpu || d.gpu || '',
            fallbackGpus: d.fallbackGpus,
            maxDurationMin: d.maxDurationMin,
            minBalanceCcu: d.minBalanceCcu,
            uploadPaths: d.uploadPaths,
            downloadPath: d.downloadPath || '',
            outputDir: d.outputDir || '',
            cwd: d.cwd || '',
            label: d.label || '',
            projectId: d.projectId || '',
            nodeId: d.nodeId || '',
            command: d.command,
          });
        }
      } else if (d.op === 'cancel') r = computeQueue.cancel(d.jobId);
      else if (d.op === 'prioritize') r = computeQueue.setPriority(d.jobId, d.priority || 'urgent');
      else if (d.op === 'clear_done') r = computeQueue.clearDone();
      else if (d.op === 'set_slots') r = computeQueue.setSlots(d);
      else r = { ok: false, msg: '未知的 queue 操作' };
      if (r.ok) audit('mesh-queue', ip, String(d.op || ''), String(d.jobId || d.machine || ''));
      json(res, 200, r);
      return true;
    }
    if (p === '/api/mesh/pools') {
      if (d.op === 'reset-cooldown') {
        const r = modelRouter.resetCooldown(d.harness, d.model);
        audit('mesh-pools', ip, 'reset-cooldown', String(d.harness || 'all'));
        json(res, 200, { ...r, pools: modelRouter.getPoolsStatus() });
        return true;
      }
      if (d.op === 'probe') {
        const targetHarness = cleanStr(d.harness, 40);
        let probedNode = null;
        for (const proj of data.projects) {
          for (const node of proj.nodes || []) {
            if (!node.sessionId) continue;
            if (targetHarness && node.tool !== targetHarness) continue;
            const live = liveSessionOf(node.machine, node.sessionId);
            if (live && live.online && ['idle', 'done'].includes(live.state) && !live.asking) {
              probedNode = node;
              break;
            }
          }
          if (probedNode) break;
        }
        let probeMsg = '';
        if (probedNode) {
          const sendRes = await sendToAgent(probedNode.machine, { t: 'send', id: probedNode.sessionId, text: '/usage' });
          probeMsg = sendRes && sendRes.ok
            ? `已向空闲节点 ${probedNode.alias || probedNode.id} 发送 /usage 探活`
            : `发送 /usage 探活失败：${(sendRes && sendRes.msg) || ''}`;
        } else {
          probeMsg = targetHarness ? `暂无空闲的 ${targetHarness} 节点可执行 /usage 探活` : '暂无空闲节点可执行 /usage 探活';
        }
        const mp = typeof getMagpie === 'function' ? getMagpie() : null;
        if (mp && typeof mp.poll === 'function') {
          try { await mp.poll(); } catch {}
        }
        json(res, 200, { ok: true, probed: !!probedNode, msg: probeMsg, pools: modelRouter.getPoolsStatus() });
        return true;
      }
      const r = modelRouter.savePools(d.pools);
      if (r.ok) audit('mesh-pools', ip, 'save', String(Object.keys(d.pools || {}).length));
      json(res, 200, { ...r, pools: modelRouter.getPoolsStatus() });
      return true;
    }
    return false;
  }

  // Agent-originated mesh RPC requests over the `/agent` WebSocket (`{ t: 'mesh-req', rid, op, ... }`)
  async function fromAgentRpc(machineName, d, ws) {
    if (!d || d.t !== 'mesh-req' || typeof d.rid !== 'string') return false;
    const reply = (resObj) => {
      let out = resObj;
      if (out && typeof out === 'object' && d.op !== 'status' && d.op !== 'scope' && d.includeTree !== true) {
        const pid = out.projectId || (out.project && out.project.id) || '';
        if (d.op === 'task' && d.action && d.action !== 'list') {
          // Ultra-compact task write reply (~1 KB) to never hit 16 KB truncation
          out = {
            ok: !!out.ok,
            ...(out.msg ? { msg: out.msg } : {}),
            ...(pid ? { projectId: pid } : {}),
            ...(out.task ? { task: out.task } : {}),
            ...(Array.isArray(out.unlockedTasks) && out.unlockedTasks.length ? { unlockedTasks: out.unlockedTasks } : {}),
          };
        } else if (out.project) {
          out = {
            ...out,
            projectId: pid,
            project: compactProjectForRpc(out.project),
          };
        }
      }
      try { ws.send(JSON.stringify({ t: 'mesh-res', rid: d.rid, ...out })); } catch {}
    };
    try {
      const op = d.op;
      const callerNodeId = d.fromNodeId || d.nodeId;
      const callerCwd = d.callerCwd || d.cwd;
      if (op === 'status' || op === 'scope') {
        return reply(scopedViewFor({ projectId: d.projectId, nodeId: callerNodeId, machine: d.machine || machineName, sessionId: d.sessionId, callerCwd, includeTree: d.includeTree === true }));
      }
      if (op === 'tree') {
        if (!fsCatalog) return reply({ ok: false, msg: '目录服务未启用' });
        const targetM = d.machine || machineName;
        if (d.refresh) {
          const sr = await fsCatalog.syncTree(targetM, d.path, d.depth);
          if (!sr.ok) return reply(sr);
        }
        const item = fsCatalog.get(targetM, d.path);
        if (item && item.snapshot) return reply({ ok: true, item });
        const sr = await fsCatalog.syncTree(targetM, d.path, d.depth);
        return reply(sr);
      }
      if (op === 'note') {
        if (!fsCatalog) return reply({ ok: false, msg: '目录服务未启用' });
        const r = fsCatalog.setNote({
          machine: d.machine || machineName,
          path: d.path,
          tag: d.tag,
          aiNote: d.aiNote,
          byAi: true, // strictly protects userNote
        });
        return reply(r);
      }
      if (op === 'spawn') {
        const r = await spawnWorker({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'send') {
        const r = await sendMessage({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'report') {
        const r = await reportResult({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'review') {
        const r = await reviewNode({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'board_post') {
        const r = await postBoard({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'board_read') {
        const r = readBoard({ ...d, nodeId: callerNodeId, machine: d.machine || machineName, sessionId: d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'task') {
        const r = await manageTask({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'channel') {
        const r = manageChannel({ ...d, fromNodeId: d.fromNodeId || callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'workspace') {
        const r = configureWorkspaces({ ...d, fromNodeId: d.fromNodeId || callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'transfer') {
        const r = requestTransfer({ ...d, fromMachine: d.fromMachine || machineName });
        return reply(r);
      }
      if (op === 'delete-project') {
        return reply(deleteProject(d.projectId || d.id));
      }
      if (op === 'event') {
        return reply(await emitEvent({ ...d, fromMachine: d.fromMachine || machineName }));
      }
      if (op === 'queue') {
        const act = String(d.action || 'list').trim().toLowerCase();
        if (act === 'submit') {
          const provType = cleanStr(d.providerType, 32) || 'local-agent';
          return reply(computeQueue.enqueue({
            ...d,
            providerType: provType,
            machine: d.machine || (provType === 'colab' ? '' : machineName),
            nodeId: d.nodeId || callerNodeId,
            mode: 'remote',
            priority: d.priority || 'normal',
            gpus: d.gpus,
            numa: d.numa,
          }));
        }
        if (act === 'prioritize') return reply(computeQueue.setPriority(d.jobId, d.priority || 'urgent'));
        if (act === 'enqueue') {
          return reply(computeQueue.enqueue({
            ...d,
            machine: d.machine || machineName,
            nodeId: d.nodeId || callerNodeId,
            gpus: d.gpus,
            numa: d.numa,
          }));
        }
        if (act === 'poll') return reply(computeQueue.poll(d.jobId));
        if (act === 'heartbeat') return reply(computeQueue.heartbeat(d.jobId));
        if (act === 'complete') return reply(computeQueue.complete(d.jobId, { ok: d.ok !== false, reason: d.reason || '' }));
        if (act === 'cancel') return reply(computeQueue.cancel(d.jobId));
        if (act === 'topology') return reply({ ok: true, machine: d.machine || machineName, topology: computeQueue.topologyFor(d.machine || machineName) });
        return reply(computeQueue.list({ machine: d.machine || '', resource: d.resource || '' }));
      }
      if (op === 'trigger') {
        if (d.action === 'list') {
          const proj = d.projectId ? data.projects.find((p) => p.id === d.projectId) : null;
          const trigs = proj ? (proj.triggers || []) : data.projects.flatMap((p) => p.triggers || []);
          return reply({ ok: true, triggers: trigs });
        }
        if (d.action === 'add') {
          return reply(upsertTrigger(d.projectId, d));
        }
        if (d.action === 'remove') {
          return reply(removeTrigger(d.projectId, d.triggerId));
        }
        if (d.action === 'pause') {
          return reply(upsertTrigger(d.projectId, { id: d.triggerId, enabled: false }));
        }
        if (d.action === 'resume') {
          return reply(upsertTrigger(d.projectId, { id: d.triggerId, enabled: true }));
        }
        return reply({ ok: false, msg: '未知的 trigger 操作：' + String(d.action) });
      }
      return reply({ ok: false, msg: '未知的 mesh 操作：' + String(op) });
    } catch (e) {
      return reply({ ok: false, msg: String((e && e.message) || '内部错误').slice(0, 200) });
    }
  }

  return {
    listProjects,
    getProject,
    scopedViewFor,
    saveProject,
    deleteProject,
    upsertNode,
    removeNode,
    addEdge,
    removeEdge,
    spawnWorker,
    sendMessage,
    reportResult,
    postBoard,
    readBoard,
    manageTask,
    manageChannel,
    checkNodeWorktree,
    removeNodeWorktree,
    board,
    requestTransfer,
    confirmTransfer,
    flushInbox,
    configureWorkspaces,
    checkWorkspaceAccess,
    onMachineState,
    onSessionMeta,
    onCliUpdate,
    listCliUpdates,
    clearCliUpdate,
    onLocalQuota,
    listLocalQuotas,
    onColabStatus,
    onComputeDone,
    fromAgentResult,
    fromAgentRpc,
    fromAgentFs,
    handle,
    upsertTrigger,
    removeTrigger,
    syncAgentTriggers,
    emitEvent,
    recordEvent,
    watchdog,
    roleStore,
    modelRouter,
    computeQueue,
  };
}

module.exports = { createMesh, isSubPath, formatEnvelope, createWatchdog, loadMeshConfig };
