// AmeMesh project & node topology CRUD, workspace security fence, live session resolution, and agent control relay.
'use strict';
const crypto = require('crypto');
const { normalizeRoleAlias, EDGE_TYPES } = require('../mesh-repair');
const {
  MAX_PROJECTS,
  MAX_NODES,
  MAX_EDGES,
  TOOLS,
  NOISE_CWD_RE,
  cleanStr,
  normalizeStrArray,
  idGen,
  normFolderPath,
  isSubPath,
  inferToolFromSessionId,
  summarizeSnapshot,
  summarizeCatalogItem,
} = require('./helpers');

function createMeshTopology(ctx) {
  const {
    data,
    machines,
    store,
    marks,
    fsCatalog,
    dispatchControl,
    board,
    roleStore,
    knownRoles,
    modelRouter,
    save,
  } = ctx;

  const pendingActions = new Map(); // rid -> { machine, resolve, timer }

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

  function findBySession(machineName, sessionId) {
    for (const p of data.projects) {
      const node = (p.nodes || []).find((n) =>
        (n.machine === machineName && n.sessionId === sessionId) || n.id === sessionId || n.alias === sessionId
      );
      if (node) return { project: p, node };
    }
    return null;
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

  function resolveCaller({ projectId, nodeId, machine, sessionId, callerCwd } = {}) {
    const proj = projectId ? data.projects.find((x) => x.id === projectId) || null : null;
    if (projectId && !proj) return { project: null, node: null };

    if (proj && nodeId) {
      const node = (proj.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId) || null;
      if (node) return { project: proj, node };
    }

    if (!projectId && nodeId) {
      for (const p of data.projects) {
        const node = (p.nodes || []).find((n) => n.id === nodeId || n.alias === nodeId);
        if (node) return { project: p, node };
      }
    }

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

  function scopedViewFor({ projectId, nodeId, machine, sessionId, callerCwd, includeTree = false }) {
    const { project: proj, node: selfNode } = resolveCaller({ projectId, nodeId, machine, sessionId, callerCwd });
    const roleCatalog = roleStore.catalog();
    const pools = modelRouter.getPoolsSummary();
    const machList = ctx.machinesSummary();
    if (!proj) {
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
        autoResumeMaster: d.autoResumeMaster !== false,
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

  function checkWorkspaceAccess(proj, machineName, folderPath, needWrite = false) {
    if (!proj.workspaces || !proj.workspaces.length) return { ok: true };
    const matched = proj.workspaces.filter((w) => w.machine === machineName && isSubPath(w.path, folderPath));
    if (!matched.length) {
      return { ok: false, msg: `路径「${machineName}:${folderPath}」不在项目「${proj.name}」分配的允许访问文件夹范围内` };
    }
    matched.sort((a, b) => b.path.length - a.path.length);
    if (needWrite && matched[0].mode === 'ro') {
      return { ok: false, msg: `路径「${machineName}:${folderPath}」在项目「${proj.name}」中被设为只读（ro）` };
    }
    return { ok: true, workspace: matched[0] };
  }

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
    if (typeof d.role === 'string' && d.role.trim()) {
      const ra = normalizeRoleAlias({ role: cleanStr(d.role, 60), alias: cleanStr(d.alias, 60), knownRoles: knownRoles(), autoAlias: d.autoAlias === true });
      if (ra.fixed) d = { ...d, role: ra.role, alias: ra.alias };
    }
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

    const fromId = cleanStr(d.fromNodeId, 40);
    if (fromId && fromId !== node.id && proj.nodes.some((n) => n.id === fromId)) {
      const fromNode = proj.nodes.find((n) => n.id === fromId);
      const edgeType = d.edgeType === 'cowork' || node.role === 'peer'
        ? 'cowork'
        : (fromNode && fromNode.role === 'master' ? 'master-worker' : 'handoff');
      const exists = proj.edges.some((e) => e.from === fromId && e.to === node.id);
      if (!exists && proj.edges.length < MAX_EDGES) {
        proj.edges.push({ from: fromId, to: node.id, type: edgeType });
      }
    }

    syncMarksGroup(proj);
    save();
    return { ok: true, node, project: enrichProject(proj) };
  }

  function configureWorkspaces({
    projectId,
    projectName,
    workspaces,
    deliveryGate,
    maxAutoJudge,
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
    const normGate = typeof deliveryGate === 'string' ? deliveryGate.trim().toUpperCase() : '';
    if (['L1', 'L2', 'L3'].includes(normGate)) {
      proj.deliveryGate = normGate;
      proj.autoJudgeCount = 0;
      proj.autoJudgeDone = false;
    }
    if (Number.isFinite(Number(maxAutoJudge)) && Number(maxAutoJudge) >= 1) {
      proj.maxAutoJudge = Math.min(20, Math.trunc(Number(maxAutoJudge)));
    }
    proj.workspaces = cleaned;
    proj.workspacesLocked = lock !== false;
    proj.updatedAt = Date.now();

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
    const edgeType = EDGE_TYPES.includes(type) ? type : 'cowork';
    if (existing) existing.type = edgeType;
    else proj.edges.push({ from, to, type: edgeType });
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

  return {
    sendToAgent,
    fromAgentResult,
    syncMarksGroup,
    liveSessionOf,
    enrichProject,
    listProjects,
    getProject,
    findBySession,
    findProjectNode,
    resolveCaller,
    collectAvailableFolders,
    scopedViewFor,
    saveProject,
    deleteProject,
    configureWorkspaces,
    checkWorkspaceAccess,
    upsertNode,
    removeNode,
    addEdge,
    removeEdge,
  };
}

module.exports = { createMeshTopology };
