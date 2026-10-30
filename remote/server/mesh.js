// AmeMesh: Cross-machine, cross-agent session communication bus, topology registry, contract gates,
// scoped workspace grants, and tiered file transfer / sneakernet handoff queue.
// Persisted in <dataDir>/mesh-projects.json and automatically synchronized with 糖糖看板's session groups (session-marks.js).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PROJECTS = 50;
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_INBOX = 30;
const MAX_TRANSFERS = 100;
const AUTO_FILE_LIMIT = 50 * 1024 * 1024; // 50 MB threshold before suggesting manual disk handoff

const cleanStr = (v, n) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, n) : '');
const idGen = (prefix = 'p') => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

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
  dispatchControl = null, // async (machineName, payload) => { ok, msg }
  onChange = () => {},
  audit = () => {},
}) {
  const file = path.join(dataDir, 'mesh-projects.json');
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
    p.resolve({ ok: !!d.ok, msg: cleanStr(d.msg, 200) });
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
    return { ...proj, workspaces, nodes };
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

  // Scoped topology view for an agent session: ONLY returns the project & connected nodes it belongs to
  function scopedViewFor({ projectId, machine, sessionId }) {
    let proj = projectId ? data.projects.find((x) => x.id === projectId) : null;
    let selfNode = null;
    if (!proj && machine && sessionId) {
      const found = findBySession(machine, sessionId);
      if (found) { proj = found.project; selfNode = found.node; }
    } else if (proj && machine && sessionId) {
      selfNode = (proj.nodes || []).find((n) => n.machine === machine && n.sessionId === sessionId) || null;
    }
    if (!proj) {
      // Return only annotated catalog folders so a fresh master session can bootstrap a project
      return {
        ok: true,
        project: null,
        self: null,
        availableFolders: fsCatalog ? fsCatalog.list() : [],
        machines: machines ? [...machines.values()].map((m) => ({ machine: m.name, online: !!m.online, control: !!m.control, files: !!m.files })) : [],
      };
    }
    const enriched = enrichProject(proj);
    return {
      ok: true,
      project: enriched,
      self: selfNode ? enriched.nodes.find((n) => n.id === selfNode.id) : null,
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
        transfers: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      data.projects.unshift(proj);
    } else {
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
        role: ['master', 'worker', 'peer'].includes(d.role) ? d.role : 'worker',
        tool: ['claude', 'codex', 'opencode', 'agy'].includes(d.tool) ? d.tool : 'claude',
        cwd: cleanStr(d.cwd, 500),
        goal: cleanStr(d.goal, 1000),
        stopCondition: cleanStr(d.stopCondition, 1000),
        reviewStatus: 'running',
        autoResumeClosed: d.autoResumeClosed !== false,
        inbox: [],
        lastReport: '',
        artifacts: [],
        updatedAt: Date.now(),
      };
      proj.nodes.push(node);
    } else {
      if (machine) node.machine = machine;
      if (sessionId) node.sessionId = sessionId;
      if (typeof d.alias === 'string' && d.alias.trim()) node.alias = cleanStr(d.alias, 60);
      if (['master', 'worker', 'peer'].includes(d.role)) node.role = d.role;
      if (typeof d.cwd === 'string' && d.cwd.trim()) node.cwd = cleanStr(d.cwd, 500);
      if (typeof d.goal === 'string') node.goal = cleanStr(d.goal, 1000);
      if (typeof d.stopCondition === 'string') node.stopCondition = cleanStr(d.stopCondition, 1000);
      if (typeof d.reviewStatus === 'string') node.reviewStatus = cleanStr(d.reviewStatus, 40);
      if (typeof d.autoResumeClosed === 'boolean') node.autoResumeClosed = d.autoResumeClosed;
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
  async function deliverToNode(proj, targetNode, envelopeText, { forceWake = false } = {}) {
    if (!targetNode.sessionId) {
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push({ id: idGen('msg'), text: envelopeText, at: Date.now() });
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
        targetNode.inbox.push({ id: idGen('msg'), text: envelopeText, at: Date.now() });
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
        targetNode.inbox.push({ id: idGen('msg'), text: envelopeText, at: Date.now(), needsManualWake: true });
      }
      save();
      return { ok: true, queued: true, manualWakeRequired: true, msg: '目标会话已关闭（设为手动唤醒），已在项目管理与看板挂起待唤醒提醒' };
    }

    // Session is idle/done (or closed with auto-resume enabled): `send` injects into terminal or triggers resumeHeadless!
    const r = await sendToAgent(targetNode.machine, { t: 'send', id: targetNode.sessionId, text: envelopeText });
    if (!r.ok) {
      // Queue on failure so message is never lost
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push({ id: idGen('msg'), text: envelopeText, at: Date.now() });
      }
      save();
      return { ok: false, queued: true, msg: r.msg || '投递失败，已暂存至节点收件箱' };
    }
    targetNode.updatedAt = Date.now();
    save();
    return { ok: true, delivered: true, msg: isClosed ? '目标会话已关闭，已在后台自动唤醒并注入消息' : '已直接注入目标会话终端' };
  }

  // Spawn a new Worker session on a remote machine in an allowed folder and bind it to the project topology
  async function spawnWorker({
    projectId,
    projectName,
    fromNodeId,
    fromMachine,
    fromSessionId,
    machine,
    cwd,
    tool = 'claude',
    api = '',
    alias = '',
    goal = '',
    stopCondition = '',
    prompt = '',
  }) {
    let proj = projectId ? data.projects.find((x) => x.id === projectId) : null;
    if (!proj && fromMachine && fromSessionId) {
      const found = findBySession(fromMachine, fromSessionId);
      if (found) proj = found.project;
    }
    if (!proj) {
      const r = saveProject({ name: projectName || `协同项目 ${new Date().toISOString().slice(5, 10)}` });
      if (!r.ok) return r;
      proj = data.projects.find((x) => x.id === r.project.id);
    }

    // Ensure master node is registered if caller provided fromMachine + fromSessionId
    let masterNode = fromNodeId ? proj.nodes.find((n) => n.id === fromNodeId) : null;
    if (!masterNode && fromMachine && fromSessionId) {
      const mr = upsertNode(proj.id, { machine: fromMachine, sessionId: fromSessionId, role: 'master', alias: '主控会话' });
      if (mr.ok) masterNode = mr.node;
    }

    // Workspace access boundary check
    const access = checkWorkspaceAccess(proj, machine, cwd, true);
    if (!access.ok) return access;
    if (!proj.workspaces.some((w) => w.machine === machine && isSubPath(w.path, cwd))) {
      proj.workspaces.push({ machine: cleanStr(machine, 60), path: cleanStr(cwd, 500), mode: 'rw', tag: 'worker' });
    }

    // Include folder notes from fsCatalog in the initial contract prompt so the worker knows folder roles
    const cat = fsCatalog ? fsCatalog.get(machine, cwd) : null;
    const contextLines = [
      `[AmeMesh 协同任务契约 | 项目：${proj.name}]`,
      masterNode ? `- 主控节点：${masterNode.alias || masterNode.id} (${masterNode.machine})` : null,
      `- 工作目录：${cwd}`,
      cat && cat.tag ? `- 目录角色标签：${fsCatalog.TAG_LABELS[cat.tag] || cat.tag}` : null,
      cat && cat.userNote ? `- 用户目录备注（请严格遵守）：${cat.userNote}` : null,
      cat && cat.aiNote ? `- AI 历史备注：${cat.aiNote}` : null,
      goal ? `- 本阶段目标（Goal）：${goal}` : null,
      stopCondition ? `- 停机与检视边界（Stop & Review Gate）：${stopCondition}` : `- 停机与检视边界：完成指定目标或遇到阻塞时停下，汇报结果并等待主控会话 Review`,
      prompt ? `\n具体执行指令：\n${prompt}` : null,
    ].filter(Boolean);
    const fullPrompt = contextLines.join('\n').slice(0, 7800);

    const nr = upsertNode(proj.id, {
      machine,
      sessionId: '',
      alias: alias || `${machine}:${path.basename(cwd)}`,
      role: 'worker',
      tool,
      cwd,
      goal,
      stopCondition,
      fromNodeId: masterNode ? masterNode.id : undefined,
      edgeType: 'master-worker',
    });
    if (!nr.ok) return nr;

    // Register pending spawn so when the agent reports the new session in `state` or `meta`, we bind its sessionId automatically
    const spKey = `${machine}|${normFolderPath(cwd)}`;
    const list = pendingSpawns.get(spKey) || [];
    list.push({ projectId: proj.id, nodeId: nr.node.id, t0: Date.now() });
    pendingSpawns.set(spKey, list);

    const launchRes = await sendToAgent(machine, {
      t: 'launch',
      cwd,
      prompt: fullPrompt,
      tool: ['codex', 'opencode', 'agy'].includes(tool) ? tool : 'claude',
      api: api ? { id: api, local: true } : undefined,
    });
    if (!launchRes.ok) {
      nr.node.reviewStatus = 'blocked';
      nr.node.lastAct = '启动失败：' + (launchRes.msg || '');
      save();
      return { ok: false, msg: launchRes.msg || '在目标机器启动会话失败', node: nr.node, project: enrichProject(proj) };
    }
    return { ok: true, node: nr.node, project: enrichProject(proj), msg: launchRes.msg || '已在目标电脑启动协同会话' };
  }

  // Send a structured instruction (Master -> Worker) or peer message (Cowork)
  async function sendMessage({
    projectId,
    fromNodeId,
    fromMachine,
    fromSessionId,
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

    let proj = projectId ? data.projects.find((x) => x.id === projectId) : null;
    let fromNode = null;
    if (!proj && fromMachine && fromSessionId) {
      const f = findBySession(fromMachine, fromSessionId);
      if (f) { proj = f.project; fromNode = f.node; }
    }
    if (!proj && toMachine && toSessionId) {
      const f = findBySession(toMachine, toSessionId);
      if (f) proj = f.project;
    }
    if (!proj) return { ok: false, msg: '找不到对应的协同项目拓扑' };

    if (!fromNode && fromNodeId) fromNode = proj.nodes.find((n) => n.id === fromNodeId) || null;
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

    return deliverToNode(proj, toNode, envelope, { forceWake });
  }

  // Worker reports completion / review gate hit back to its Master node
  async function reportResult({
    projectId,
    fromNodeId,
    fromMachine,
    fromSessionId,
    summary,
    reviewStatus = 'waiting_review',
    artifacts = [],
  }) {
    let proj = projectId ? data.projects.find((x) => x.id === projectId) : null;
    let workerNode = null;
    if (proj && fromNodeId) workerNode = proj.nodes.find((n) => n.id === fromNodeId);
    if (!workerNode && fromMachine && fromSessionId) {
      const f = findBySession(fromMachine, fromSessionId);
      if (f) { proj = f.project; workerNode = f.node; }
    }
    if (!proj || !workerNode) return { ok: false, msg: '找不到汇报节点所属的项目拓扑' };

    workerNode.reviewStatus = ['waiting_review', 'done', 'blocked', 'approved'].includes(reviewStatus) ? reviewStatus : 'waiting_review';
    workerNode.lastReport = cleanStr(summary, 4000);
    if (Array.isArray(artifacts)) {
      workerNode.artifacts = artifacts.map((a) => cleanStr(a, 400)).filter(Boolean).slice(0, 20);
    }
    workerNode.updatedAt = Date.now();

    // Locate upstream master node via edges or role === 'master'
    const inEdge = proj.edges.find((e) => e.to === workerNode.id && e.type === 'master-worker');
    const masterNode = (inEdge && proj.nodes.find((n) => n.id === inEdge.from)) ||
      proj.nodes.find((n) => n.role === 'master' && n.id !== workerNode.id);

    save();
    if (!masterNode) {
      return { ok: true, msg: '已记录节点汇报（当前拓扑未配置主控节点）', project: enrichProject(proj) };
    }

    const envelope = formatEnvelope({
      project: proj,
      fromNode: workerNode,
      toNode: masterNode,
      type: 'report',
      text: workerNode.lastReport,
      artifacts: workerNode.artifacts,
    });
    const deliv = await deliverToNode(proj, masterNode, envelope);
    return { ok: true, masterDelivery: deliv, project: enrichProject(proj) };
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

    // Check workspace write permission on destination
    const dstCheck = checkWorkspaceAccess(proj, cleanToM, path.dirname(cleanToP), true);
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
    save();
    return { ok: true, transfer: item, project: enrichProject(proj) };
  }

  // Confirm a manual disk handoff (sneakernet) is complete and optionally wake the waiting session
  async function confirmTransfer(projectId, transferId, { newToPath = '', wake = true } = {}) {
    const proj = data.projects.find((x) => x.id === projectId);
    if (!proj) return { ok: false, msg: '找不到该项目' };
    const xfer = (proj.transfers || []).find((t) => t.id === transferId);
    if (!xfer) return { ok: false, msg: '找不到该文件传输记录' };
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

      // 2. If session is now idle or done (and has no open permission prompts), flush its inbox
      const isIdle = s.state === 'idle' || s.state === 'done';
      const hasPerms = Array.isArray(s.perms) && s.perms.length > 0;
      if (isIdle && !hasPerms) {
        const found = findBySession(machineName, s.id);
        if (found && Array.isArray(found.node.inbox) && found.node.inbox.length > 0) {
          const autoMsgs = found.node.inbox.filter((m) => !m.needsManualWake);
          if (autoMsgs.length > 0) {
            found.node.inbox = found.node.inbox.filter((m) => m.needsManualWake);
            const combined = autoMsgs.map((m) => m.text).join('\n\n---\n\n');
            dirty = true;
            sendToAgent(machineName, { t: 'send', id: s.id, text: combined }).catch(() => {});
          }
        }
      }
    }
    if (dirty) save();
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
      const machine = url.searchParams.get('machine') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      json(res, 200, scopedViewFor({ projectId, machine, sessionId }));
      return true;
    }
    if (req.method !== 'POST' || !p.startsWith('/api/mesh/')) return false;

    let d = {};
    try { d = JSON.parse(await readBody(req, 32768)); } catch {}
    // Operations that act on remote machines require a fresh TOTP session
    const needsStepUp = ['/api/mesh/spawn', '/api/mesh/send', '/api/mesh/report', '/api/mesh/flush', '/api/mesh/transfer-confirm'].includes(p);
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
      if (op === 'status' || op === 'scope') {
        return reply(scopedViewFor({ projectId: d.projectId, machine: d.machine || machineName, sessionId: d.sessionId }));
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
        const r = await spawnWorker({ ...d, fromMachine: d.fromMachine || machineName });
        return reply(r);
      }
      if (op === 'send') {
        const r = await sendMessage({ ...d, fromMachine: d.fromMachine || machineName });
        return reply(r);
      }
      if (op === 'report') {
        const r = await reportResult({ ...d, fromMachine: d.fromMachine || machineName });
        return reply(r);
      }
      if (op === 'transfer') {
        const r = requestTransfer({ ...d, fromMachine: d.fromMachine || machineName });
        return reply(r);
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
    requestTransfer,
    confirmTransfer,
    flushInbox,
    checkWorkspaceAccess,
    onMachineState,
    onSessionMeta,
    fromAgentResult,
    fromAgentRpc,
    handle,
  };
}

module.exports = { createMesh, isSubPath, formatEnvelope };
