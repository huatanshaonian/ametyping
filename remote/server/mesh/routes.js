// AmeMesh HTTP `/api/mesh/*` router and agent WebSocket `mesh-req` RPC dispatcher.
'use strict';
const { evaluateFableAdvice } = require('../mesh-fable-advisor');
const { cleanStr, compactProjectForRpc } = require('./helpers');

function createMeshRoutes(ctx) {
  const {
    data,
    fsCatalog,
    getMagpie,
    getTodos,
    audit,
    save,
    board,
    watchdog,
    roleStore,
    modelRouter,
    computeQueue,
    listProjects,
    scopedViewFor,
    saveProject,
    deleteProject,
    upsertNode,
    removeNode,
    addEdge,
    removeEdge,
    configureWorkspaces,
    liveSessionOf,
    sendToAgent,
    listSkills,
    saveSkill,
    resetSkill,
    listCliUpdates,
    clearCliUpdate,
    saveMachineProfile,
    machinesSummary,
    listLocalQuotas,
    querySugon,
    spawnWorker,
    checkNodeWorktree,
    removeNodeWorktree,
    reviewNode,
    sendMessage,
    reportResult,
    postBoard,
    readBoard,
    manageChannel,
    manageTask,
    flushInbox,
    requestTransfer,
    confirmTransfer,
    upsertTrigger,
    removeTrigger,
    emitEvent,
  } = ctx;

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
        const needMachine = provType !== 'colab' && provType !== 'sugon';
        if ((needMachine && !cleanStr(d.machine, 60)) || !cleanStr(d.command, 1000)) {
          r = { ok: false, msg: needMachine ? '提交远程作业需要提供 machine 与 command' : `提交 ${provType} 作业需要提供 command` };
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
            sugonProfile: d.sugonProfile || d.profile || '',
            partition: d.partition || '',
            nodes: d.nodes,
            ntasks: d.ntasks,
            walltime: d.walltime || '',
            remoteWorkDir: d.remoteWorkDir || '',
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
    if (p === '/api/mesh/sugon/update-key') {
      const r = await querySugon('update-key', {
        profileId: cleanStr(d.profileId, 60),
        keyContent: typeof d.keyContent === 'string' ? d.keyContent.slice(0, 16384) : '',
        keyFileName: cleanStr(d.keyFileName, 160),
        keyExpireAt: cleanStr(d.keyExpireAt, 40),
        rayfileToken: cleanStr(d.rayfileToken, 200),
      }, 25000);
      if (r && r.ok) audit('mesh-sugon-key', ip, cleanStr(d.profileId, 60), cleanStr(d.keyExpireAt, 40));
      json(res, 200, r || { ok: false, msg: '更新密钥失败' });
      return true;
    }
    if (p === '/api/mesh/project/gate') {
      const proj = data.projects.find((x) => x.id === cleanStr(d.projectId, 40));
      if (!proj) { json(res, 200, { ok: false, msg: '找不到项目' }); return true; }
      const gate = String(d.deliveryGate || '').trim().toUpperCase();
      if (!['L1', 'L2', 'L3'].includes(gate)) { json(res, 200, { ok: false, msg: 'deliveryGate 仅支持 L1 / L2 / L3' }); return true; }
      proj.deliveryGate = gate;
      proj.autoJudgeCount = 0;
      proj.autoJudgeDone = false;
      if (Number.isFinite(Number(d.maxAutoJudge)) && Number(d.maxAutoJudge) >= 1) {
        proj.maxAutoJudge = Math.min(20, Math.trunc(Number(d.maxAutoJudge)));
      }
      save();
      audit('mesh-project-gate', ip, proj.id, gate);
      json(res, 200, { ok: true, projectId: proj.id, deliveryGate: proj.deliveryGate, maxAutoJudge: proj.maxAutoJudge || 5 });
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
        return reply(scopedViewFor({ projectId: d.projectId, nodeId: callerNodeId, machine: d.machine || machineName, sessionId: d.sessionId || d.fromSessionId, callerCwd, includeTree: d.includeTree === true }));
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
          byAi: true,
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
        const r = await reviewNode({ ...d, fromNodeId: d.fromNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'board_post') {
        const r = await postBoard({ ...d, fromNodeId: callerNodeId, fromMachine: d.fromMachine || machineName, fromSessionId: d.fromSessionId || d.sessionId, callerCwd });
        return reply(r);
      }
      if (op === 'board_read') {
        const r = readBoard({ ...d, nodeId: callerNodeId, machine: d.machine || machineName, sessionId: d.sessionId || d.fromSessionId, callerCwd });
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
            machine: d.machine || ((provType === 'colab' || provType === 'sugon') ? '' : machineName),
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
    handle,
    fromAgentRpc,
  };
}

module.exports = { createMeshRoutes };
