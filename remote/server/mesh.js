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
  dispatchControl = null, // async (machineName, payload) => { ok, msg }
  onChange = () => {},
  audit = () => {},
  notify = null,
}) {
  const file = path.join(dataDir, 'mesh-projects.json');
  const board = createBoard({ dataDir });
  const roleStore = createRoleStore({ dataDir });
  const modelRouter = createModelRouter({ dataDir, getMagpie });
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
      const asking = (live.perms && live.perms.length > 0) || (live.state === 'waiting' && lastLine && /确认/.test(lastLine.text));
      return {
        online: !!m.online,
        state: live.state || 'idle',
        asking,
        label: live.label || '',
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
          if (n.machine !== machine || !n.cwd) continue;
          if (normFolderPath(n.cwd) === normCaller || isSubPath(n.cwd, callerCwd)) {
            candidates.push({ project: p, node: n });
          }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => {
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

  // Scoped topology view for an agent session: ONLY returns the project & connected nodes it belongs to
  function scopedViewFor({ projectId, nodeId, machine, sessionId, callerCwd }) {
    const { project: proj, node: selfNode } = resolveCaller({ projectId, nodeId, machine, sessionId, callerCwd });
    const roleCatalog = roleStore.catalog();
    const pools = modelRouter.getPoolsSummary();
    if (!proj) {
      // Return only annotated catalog folders so a fresh master session can bootstrap a project
      return {
        ok: true,
        project: null,
        self: null,
        roleCatalog,
        pools,
        availableFolders: fsCatalog ? fsCatalog.list() : [],
        machines: machines ? [...machines.values()].map((m) => ({ machine: m.name, online: !!m.online, control: !!m.control, files: !!m.files })) : [],
      };
    }
    const enriched = enrichProject(proj);
    return {
      ok: true,
      project: enriched,
      self: selfNode ? enriched.nodes.find((n) => n.id === selfNode.id) : null,
      roleCatalog,
      pools,
      machines: machines ? [...machines.values()].map((m) => ({ machine: m.name, online: !!m.online, control: !!m.control, files: !!m.files })) : [],
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
      node = {
        id: cleanStr(d.id, 40) || idGen('node'),
        machine,
        sessionId,
        alias: cleanStr(d.alias, 60) || cleanStr(d.role === 'master' ? '主控会话' : '协作节点', 60),
        role: cleanStr(d.role, 32) || 'worker',
        tool: TOOLS.includes(d.tool) ? d.tool : 'claude',
        pool: cleanStr(d.pool, 60),
        model: cleanStr(d.model, 120),
        cwd: cleanStr(d.cwd, 500),
        goal: cleanStr(d.goal, 1000),
        stopCondition: cleanStr(d.stopCondition, 1000),
        reviewStatus: 'running',
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
    const r = await sendToAgent(targetNode.machine, { t: 'send', id: targetNode.sessionId, text: envelopeText });
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

  async function handleQuotaExhausted(proj, node, reason = 'quota') {
    if (!proj || !node) return;
    const prevKey = `${node.tool || 'claude'}|${node.model || ''}`;
    modelRouter.markCooldown(node.tool || 'claude', node.model || '', reason);
    const masterNode = (proj.nodes || []).find((n) => n.role === 'master' && n.id !== node.id);
    const masterMention = masterNode ? `@${masterNode.alias || masterNode.id} ` : '@master ';

    if (node.pool) {
      const exclude = [prevKey];
      const relayCwd = node.cwd || ((proj.workspaces || []).find((w) => w.machine === node.machine) || {}).path || '';
      const roleDef = roleStore.get(node.role);

      for (let attempt = 0; attempt < 10; attempt++) {
        const pick = modelRouter.selectCandidate(node.pool, { exclude });
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
          `[AmeMesh 跨模型自动接力 | 项目：${proj.name}]`,
          `- 接管节点：${node.alias || node.id} (projectId="${proj.id}", nodeId="${node.id}")`,
          `- 接力原因：原模型 ${prevKey} 额度耗尽/限流，由模型池「${node.pool}」自动切换至 ${fbTool}${fbModel ? ':' + fbModel : ''}`,
          roleDef && roleDef.body ? `- 角色规范（${roleDef.name}）：\n${roleDef.body}` : null,
          roleDef && roleDef.readOnly ? '- [只读角色硬约束] 你是只读验收角色，严禁修改任何业务代码或产出文件。' : null,
          fb.quirks ? `- 模型微调提示：${fb.quirks}` : null,
          node.goal ? `- 当前目标：${node.goal}` : null,
          `- 请立即调用 mesh_board_read(since=${sinceSeq}) 读取未读黑板楼层与任务状态，无缝接力完成工作。`,
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
          prompt: relayLines.join('\n').slice(0, 7800),
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

  const watchdog = createWatchdog({
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
    const changedFiles = Array.isArray(gitAudit.changedFiles) ? gitAudit.changedFiles : [];
    const res = checkBoundaries(boundaries, changedFiles);
    const emptyChange = changedFiles.length === 0 && boundaries.length > 0;
    return {
      checked: true,
      isGit: true,
      changedFiles: changedFiles.slice(0, 100),
      outOfBounds: res.outOfBounds,
      emptyChange,
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

    const targets = (proj.nodes || []).filter((n) => {
      if (fromNode && n.id === fromNode.id) return false;
      if (entry.mentionAll || n.wakeMode === 'all') return true;
      if (channelSubscribedIds.has(n.id)) return true;
      const aliasL = String(n.alias || '').toLowerCase();
      const idL = String(n.id || '').toLowerCase();
      return (aliasL && mentionSet.has(aliasL)) || (idL && mentionSet.has(idL));
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
            const prefix = ownerNode ? `@${ownerNode.alias || ownerNode.id} ` : '';
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

  // Spawn a new Worker session on a remote machine in an allowed folder and bind it to the project topology
  async function spawnWorker({
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
  }) {
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

    // Ensure master node is registered if caller provided fromMachine + (fromSessionId or live session fallback)
    let masterNode = resolved.node;
    if (!masterNode && fromNodeId) {
      masterNode = proj.nodes.find((n) => n.id === fromNodeId || n.alias === fromNodeId) || null;
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
    if (!masterNode && fromMachine && !fromSessionId) {
      const liveSessions = machines && machines.get(fromMachine)?.sessions;
      if (liveSessions && liveSessions.size > 0) {
        let matchedSid = '';
        if (callerCwd) {
          const normCaller = normFolderPath(callerCwd);
          for (const [sid, sess] of liveSessions.entries()) {
            const scwd = (store && store.info && store.info(fromMachine, sid)?.cwd) || (sess && sess.cwd) || '';
            if (scwd && (normFolderPath(scwd) === normCaller || isSubPath(scwd, callerCwd))) {
              matchedSid = sid;
              break;
            }
          }
        }
        if (!matchedSid && liveSessions.size === 1) {
          matchedSid = [...liveSessions.keys()][0];
        }
        if (matchedSid) {
          const mr = upsertNode(proj.id, {
            machine: fromMachine,
            sessionId: matchedSid,
            role: 'master',
            alias: '主控会话',
            ...(callerCwd ? { cwd: callerCwd } : {}),
          });
          if (mr.ok) masterNode = mr.node;
        }
      }
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
    const hasExplicitTool = Boolean(cleanTool && TOOLS.includes(cleanTool));
    const cleanPool = cleanStr(pool, 60);
    const cleanModel = cleanStr(model, 120);
    const effectivePool = cleanPool || (!hasExplicitTool && roleDef && roleDef.defaultPool ? roleDef.defaultPool : '');

    const workerNodeId = idGen('node');

    const normBoundaries = normalizeStrArray(boundaries, 40, 300);
    const normDoneWhen = normalizeStrArray(doneWhen, 30, 400);
    const normChecks = normalizeStrArray(checks, 20, 300);

    // Include folder notes from fsCatalog and external role definition in initial contract prompt
    const cat = fsCatalog ? fsCatalog.get(machine, cwd) : null;
    const baseContextLines = [
      `[AmeMesh 协同任务契约 | 项目：${proj.name}]`,
      masterNode ? `- 主控节点：${masterNode.alias || masterNode.id} (${masterNode.machine})` : null,
      `- 节点身份标识（调用 mesh_report / mesh_send / mesh_run 时可传）：projectId="${proj.id}", nodeId="${workerNodeId}", role="${cleanRole}"`,
      `- 工作目录：${cwd}`,
      roleDef && roleDef.body ? `- 角色规范（${roleDef.name}）：\n${roleDef.body}` : null,
      roleDef && roleDef.readOnly ? '- [只读验收硬约束] 当前角色 readOnly=true：严禁修改、新建或删除任何业务代码与配置文件，仅可读取源码、审阅黑板并运行验证命令。' : null,
      cat && cat.tag ? `- 目录角色标签：${fsCatalog.TAG_LABELS[cat.tag] || cat.tag}` : null,
      cat && cat.userNote ? `- 用户目录备注（请严格遵守）：${cat.userNote}` : null,
      cat && cat.aiNote ? `- AI 历史备注：${cat.aiNote}` : null,
      goal ? `- 本阶段目标（Goal）：${goal}` : null,
      stopCondition ? `- 停机与检视边界（Stop & Review Gate）：${stopCondition}` : `- 停机与检视边界：完成指定目标或遇到阻塞时停下，汇报结果并等待主控会话 Review`,
      normBoundaries.length ? `- 允许修改边界（Boundaries，严禁越界修改其他文件）：${normBoundaries.join(', ')}` : null,
      normDoneWhen.length ? `- 验收条件（Done When，交卷时逐条核对）：\n${normDoneWhen.map((item, idx) => `  ${idx + 1}. ${item}`).join('\n')}` : null,
      normChecks.length ? `- 必跑验证命令（Checks）：${normChecks.join(' ; ')}` : null,
      '- 协作黑板约定：可通过 mesh_board_post(@节点别名 ...) 与成员公开协同，用 #楼层号 引用历史帖子；严禁擅自 git commit/push。',
      '- 长时间计算约定：预计耗时超过 10 分钟的求解或跑批任务，请使用 mesh_run 工具或 `node tools/ame-mesh.js run --label "任务名" -- <命令>` 在后台脱离运行，随后可调用 mesh_report(reviewStatus="blocked") 等待计算结束自动唤醒。',
    ].filter(Boolean);

    const buildFullPrompt = (quirksText) => {
      const lines = [...baseContextLines];
      if (quirksText) lines.push(`- 模型微调提示：${quirksText}`);
      if (prompt) lines.push(`\n具体执行指令：\n${prompt}`);
      return lines.join('\n').slice(0, 7800);
    };

    const masterMention = masterNode ? `@${masterNode.alias || masterNode.id} ` : '@master ';
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

      const briefEntry = board.append(proj.id, {
        channel: 'main',
        kind: 'brief',
        agent: masterNode ? (masterNode.alias || masterNode.id) : '主控会话',
        nodeId: masterNode ? masterNode.id : null,
        text: `@${nr.node.alias || nr.node.id} 派活契约已下发\n${launchPromptText}`,
        mentions: [nr.node.alias || nr.node.id],
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
        const pick = modelRouter.selectCandidate(effectivePool, { exclude });
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
          prompt: launchPrompt,
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
      prompt: fullPrompt,
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
            const match = waiting.shift();
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
              return (aliasL && ms.includes(aliasL)) || (idL && ms.includes(idL));
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
      json(res, 200, scopedViewFor({ projectId, nodeId, machine, sessionId, callerCwd }));
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
    const needsStepUp = ['/api/mesh/spawn', '/api/mesh/send', '/api/mesh/report', '/api/mesh/flush', '/api/mesh/transfer-confirm', '/api/mesh/board/post', '/api/mesh/worktree-remove'].includes(p);
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
      try { ws.send(JSON.stringify({ t: 'mesh-res', rid: d.rid, ...resObj })); } catch {}
    };
    try {
      const op = d.op;
      const callerNodeId = d.fromNodeId || d.nodeId;
      const callerCwd = d.callerCwd || d.cwd;
      if (op === 'status' || op === 'scope') {
        return reply(scopedViewFor({ projectId: d.projectId, nodeId: callerNodeId, machine: d.machine || machineName, sessionId: d.sessionId, callerCwd }));
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
    checkWorkspaceAccess,
    onMachineState,
    onSessionMeta,
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
  };
}

module.exports = { createMesh, isSubPath, formatEnvelope, createWatchdog, loadMeshConfig };
