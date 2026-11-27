// AmeMesh Swarm coordination: message delivery, quota failover, L3 auto-judge, blackboard/channels/tasks,
// worker spawning & worktree lifecycle, review/report/send, inbox flush, and folder/run event triggers.
'use strict';
const path = require('path');
const { formatWakePrompt } = require('../mesh-board');
const { normalizeRoleAlias } = require('../mesh-repair');
const { judgeL3Stall } = require('../mesh-auto-judge');
const {
  MAX_INBOX,
  TOOLS,
  SPAWN_ALLOWED_KEYS,
  cleanStr,
  normalizeStrArray,
  idGen,
  normFolderPath,
  isSubPath,
  formatEnvelope,
  mentionTokenOf,
  deliverPromptFor,
  inferToolFromSessionId,
  evaluateGitAudit,
  formatAuditWarnings,
} = require('./helpers');

function createMeshSwarm(ctx) {
  const {
    dataDir,
    data,
    machines,
    store,
    fsCatalog,
    getMagpie,
    getEgress,
    notify,
    pendingSpawns,
    save,
    recordEvent,
    roleStore,
    knownRoles,
    board,
    modelRouter,
    sendToAgent,
    syncMarksGroup,
    liveSessionOf,
    enrichProject,
    findBySession,
    findProjectNode,
    resolveCaller,
    saveProject,
    checkWorkspaceAccess,
    upsertNode,
  } = ctx;

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

    const safeEnvelope = deliverPromptFor(targetNode.tool, envelopeText);
    const r = await sendToAgent(targetNode.machine, { t: 'send', id: targetNode.sessionId, text: safeEnvelope });
    if (!r.ok) {
      targetNode.inbox = targetNode.inbox || [];
      if (targetNode.inbox.length < MAX_INBOX) {
        targetNode.inbox.push(inboxItem({ needsManualWake: true }));
      }
      save();
      return { ok: false, queued: true, msg: r.msg || '投递失败，已暂存至节点收件箱' };
    }
    if (ctx.watchdog) ctx.watchdog.onNodeCommand(proj.id, targetNode.id);
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
    const cfg = ctx.watchdog ? ctx.watchdog.getConfig() : {};
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
        const rem = (pendingSpawns.get(spKey) || []).filter((x) => x.nodeId !== node.id);
        if (rem.length) pendingSpawns.set(spKey, rem);
        else pendingSpawns.delete(spKey);
        node.tool = prevTool;
        node.model = prevModel;
        node.sessionId = prevSid;
        modelRouter.markCooldown(fb.harness, fbModel, (launchRes && launchRes.msg) || 'relay_launch_failed');
        exclude.push(fbKey);
      }

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

  async function handleL3Idle(proj, masterNode) {
    if (!proj || !masterNode || proj.deliveryGate !== 'L3' || proj.autoJudgeDone === true) return null;
    proj.lastAutoJudgeAt = Date.now();
    const live = liveSessionOf(masterNode.machine, masterNode.sessionId);
    const masterLastOutput = [
      masterNode.lastReport || '',
      (live && (live.tail || live.lastAct || live.preview)) || '',
    ].filter(Boolean).join('\n---\n');
    let boardEntries = [];
    try {
      const b = board.read(proj.id, { since: 0, limit: 30 });
      boardEntries = (b && Array.isArray(b.entries)) ? b.entries.slice(-15) : [];
    } catch {}

    const count = Number(proj.autoJudgeCount) || 0;
    const cap = Number(proj.maxAutoJudge) || 5;
    const verdictRes = await judgeL3Stall({
      project: proj,
      masterLastOutput,
      boardEntries,
      autoJudgeCount: count,
      maxAutoJudge: cap,
      dataDir,
      egress: typeof getEgress === 'function' ? getEgress() : null,
      magpie: typeof getMagpie === 'function' ? getMagpie() : null,
    });

    const tagInfo = `${verdictRes.provider}${verdictRes.model ? ' · ' + verdictRes.model : ''}`;
    if (verdictRes.verdict === 'CONTINUE' && verdictRes.followupPrompt) {
      proj.autoJudgeCount = count + 1;
      recordEvent(proj, {
        source: 'watchdog',
        kind: 'L3_AUTO_CONTINUE',
        machine: masterNode.machine,
        nodeId: masterNode.id,
        summary: `L3 裁判续推 (${proj.autoJudgeCount}/${cap})：${verdictRes.reason}`,
        payload: { provider: verdictRes.provider, model: verdictRes.model },
      });
      try {
        await postBoard({
          projectId: proj.id,
          agent: 'L3 裁判',
          kind: 'control',
          text: `[L3 自动续推 ${proj.autoJudgeCount}/${cap} · ${tagInfo}] ${verdictRes.reason}`,
        });
      } catch {}
      await sendToAgent(masterNode.machine, {
        t: 'send',
        id: masterNode.sessionId,
        text: `[L3 Auto-Mode 裁判指令 ${proj.autoJudgeCount}/${cap}]\n${verdictRes.followupPrompt}`,
      });
      save();
      return verdictRes;
    }

    proj.autoJudgeDone = true;
    const isDone = verdictRes.verdict === 'DONE';
    recordEvent(proj, {
      source: 'watchdog',
      kind: isDone ? 'L3_AUTO_DONE' : 'L3_AUTO_ESCALATE',
      machine: masterNode.machine,
      nodeId: masterNode.id,
      summary: `L3 裁判${isDone ? '确认完成' : '请求人工介入'}：${verdictRes.reason}`,
      payload: { verdict: verdictRes.verdict, provider: verdictRes.provider, model: verdictRes.model },
    });
    try {
      await postBoard({
        projectId: proj.id,
        agent: 'L3 裁判',
        kind: isDone ? 'control' : 'alert',
        text: `[L3 裁判 · ${verdictRes.verdict} · ${tagInfo}] ${verdictRes.reason}`,
      });
    } catch {}
    if (typeof notify === 'function') {
      try {
        notify({
          title: isDone ? `L3 项目已完成 · ${proj.name}` : `L3 项目需人工拍板 · ${proj.name}`,
          body: `${verdictRes.reason}（已自动续推 ${count}/${cap} 轮）`,
          tag: `l3-judge-${proj.id}`,
          url: `/#proj=${proj.id}`,
        });
      } catch {}
    }
    save();
    return verdictRes;
  }

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

    const resolvedIds = new Set(Array.isArray(entry.targets) ? entry.targets : []);
    const targets = (proj.nodes || []).filter((n) => {
      if (n.archived) return false;
      if (fromNode && n.id === fromNode.id) return false;
      if (entry.mentionAll || entry.targetsAll || n.wakeMode === 'all') return true;
      if (channelSubscribedIds.has(n.id)) return true;
      return resolvedIds.has(n.id);
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

    let masterNode = resolved.node;
    if (!masterNode && fromNodeId) {
      masterNode = proj.nodes.find((n) => n.id === fromNodeId || n.alias === fromNodeId) || null;
    }
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

    const access = checkWorkspaceAccess(proj, machine, cwd, true);
    if (!access.ok) return access;
    if (!proj.workspaces.some((w) => w.machine === machine && isSubPath(w.path, cwd))) {
      proj.workspaces.push({ machine: cleanStr(machine, 60), path: cleanStr(cwd, 500), mode: 'rw', tag: 'worker' });
    }

    const roleAlias = normalizeRoleAlias({ role: cleanStr(role, 60) || 'worker', alias: cleanStr(alias, 60), knownRoles: knownRoles() });
    const cleanRole = cleanStr(roleAlias.role, 32) || 'worker';
    const cleanAlias = roleAlias.alias;
    const defaultAlias = `${machine}:${path.win32.basename(String(cwd || '')) || cwd}`;
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
    const effectivePool = cleanPool || (!hasExplicitTool ? ((roleDef && roleDef.defaultPool) || 'fast-coder') : '');

    const workerNodeId = idGen('node');

    const normBoundaries = normalizeStrArray(boundaries, 40, 300);
    const normDoneWhen = normalizeStrArray(doneWhen, 30, 400);
    const normChecks = normalizeStrArray(checks, 20, 300);

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
          worktreeAlias: cleanAlias || workerNodeId,
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
            alias: cleanAlias || defaultAlias,
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
          text: `${masterMention}[模型池耗尽] 为节点 ${cleanAlias || workerNodeId} 选型失败，模型池「${effectivePool}」所有候选均不可用（${cleanStr(lastErr, 120)}）。`,
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
      alias: cleanAlias || defaultAlias,
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

  async function reviewNode({ projectId, nodeId, action = 'approve', note = '', closeTerminal = false, fromNodeId, fromMachine, fromSessionId, callerCwd } = {}) {
    const safeFromNodeId = fromNodeId && fromNodeId !== nodeId ? fromNodeId : undefined;
    const resolved = resolveCaller({ projectId, nodeId: safeFromNodeId, machine: fromMachine, sessionId: fromSessionId, callerCwd });
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
        const masterNode = (proj.nodes || []).find((n) => n.role === 'master' && n.id !== target.id) || null;
        postRes = await postBoard({
          projectId: proj.id,
          fromNodeId: masterNode ? masterNode.id : null,
          text: `${mentionTokenOf(target)} [打回返工] ${cleanNote}`,
        });
      }
      save();
      return {
        ok: true,
        projectId: proj.id,
        action: 'reject',
        node: { id: target.id, alias: target.alias, reviewStatus: target.reviewStatus, archived: false },
        ...(postRes && postRes.entry ? { boardSeq: postRes.entry.seq, deliveries: postRes.deliveries } : {}),
        msg: `已打回节点「${target.alias || target.id}」返工`,
      };
    }

    return { ok: false, msg: '无效的 review action（仅支持 approve / reject / archive）' };
  }

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

  async function reportResult({
    projectId,
    fromNodeId,
    nodeId,
    fromMachine,
    machine,
    fromSessionId,
    sessionId,
    callerCwd,
    cwd,
    summary,
    reviewStatus = 'waiting_review',
    artifacts = [],
    doneWhenStatus = null,
    checksOutput = '',
    gitAudit = null,
    boundaries = null,
  } = {}) {
    const { project: proj, node: workerNode } = resolveCaller({
      projectId,
      nodeId: fromNodeId || nodeId,
      machine: fromMachine || machine,
      sessionId: fromSessionId || sessionId,
      callerCwd: callerCwd || cwd,
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
    if (ctx.watchdog) {
      ctx.watchdog.onNodeReport(proj.id, workerNode.id, workerNode.reviewStatus);
    }

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

  function bindPendingSpawn(machineName, sessionId, rawCwd, now = Date.now()) {
    if (!machineName || !sessionId || !rawCwd) return false;
    const spKey = `${machineName}|${normFolderPath(rawCwd)}`;
    const waiting = pendingSpawns.get(spKey);
    if (!waiting || !waiting.length) return false;
    const alreadyBound = data.projects.some((p) => (p.nodes || []).some((n) => n.machine === machineName && n.sessionId === sessionId));
    if (alreadyBound) return false;

    for (let i = waiting.length - 1; i >= 0; i--) {
      const p = data.projects.find((x) => x.id === waiting[i].projectId);
      const nd = p && (p.nodes || []).find((n) => n.id === waiting[i].nodeId);
      if (!nd || nd.sessionId) waiting.splice(i, 1);
    }
    if (!waiting.length) {
      pendingSpawns.delete(spKey);
      return false;
    }

    const sTool = inferToolFromSessionId(sessionId);
    let pickIdx = waiting.findIndex((w) => {
      const p = data.projects.find((x) => x.id === w.projectId);
      const nd = p && (p.nodes || []).find((n) => n.id === w.nodeId);
      return nd && !nd.sessionId && (!nd.tool || nd.tool === sTool);
    });
    if (pickIdx < 0) pickIdx = 0;
    const [match] = waiting.splice(pickIdx, 1);
    if (!waiting.length) pendingSpawns.delete(spKey);
    const proj = data.projects.find((p) => p.id === match.projectId);
    const node = proj && (proj.nodes || []).find((n) => n.id === match.nodeId);
    if (node && !node.sessionId) {
      node.sessionId = sessionId;
      node.updatedAt = now;
      syncMarksGroup(proj);
      return true;
    }
    return false;
  }

  function onMachineState(machineName, sessionsList) {
    let dirty = false;
    const now = Date.now();
    for (const [k, arr] of pendingSpawns) {
      const keep = arr.filter((x) => now - x.t0 < 120e3);
      if (keep.length) pendingSpawns.set(k, keep); else pendingSpawns.delete(k);
    }

    for (const s of sessionsList || []) {
      if (!s || typeof s.id !== 'string') continue;
      const savedInfo = store && store.info && store.info(machineName, s.id);
      const sCwd = s.cwd || (savedInfo && savedInfo.cwd) || '';
      if (sCwd && bindPendingSpawn(machineName, s.id, sCwd, now)) {
        dirty = true;
      }

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
              if (Array.isArray(e.targets)) return e.targets.includes(node.id) || Boolean(e.targetsAll);
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
    if (ctx.watchdog) ctx.watchdog.tick();
  }

  function onSessionMeta(machineName, sessionId, cwd) {
    if (bindPendingSpawn(machineName, sessionId, cwd)) {
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

    let trig = null;
    if (d.triggerId) {
      trig = (proj.triggers || []).find((t) => t.id === d.triggerId);
      if (trig) {
        if (trig.enabled === false) return { ok: false, msg: '触发器已禁用' };
        const maxPerHour = (ctx.watchdog && ctx.watchdog.getConfig().triggerMaxPerHour) || 6;
        trig.fireTimestamps = (trig.fireTimestamps || []).filter((t) => nowTs - t <= 3600e3);
        if (trig.fireTimestamps.length >= maxPerHour) {
          return { ok: false, msg: `触发器已达每小时上限 (${maxPerHour}次)` };
        }
        trig.fireTimestamps.push(nowTs);
        trig.lastTriggeredAt = nowTs;
      }
    }

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

  return {
    deliverToNode,
    handleQuotaExhausted,
    handleL3Idle,
    postBoard,
    readBoard,
    manageChannel,
    manageTask,
    spawnWorker,
    checkNodeWorktree,
    removeNodeWorktree,
    reviewNode,
    sendMessage,
    reportResult,
    flushInbox,
    onMachineState,
    onSessionMeta,
    syncAgentTriggers,
    upsertTrigger,
    removeTrigger,
    emitEvent,
  };
}

module.exports = { createMeshSwarm };
