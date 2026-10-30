'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');

test('mesh topology isolation, auto group binding in session-marks, contract delivery, inbox queueing, and sneakernet handoff', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mesh-'));
  try {
    const dispatched = [];
    const machines = new Map();
    machines.set('pc-a', {
      name: 'pc-a',
      online: true,
      control: true,
      files: true,
      sessions: new Map([
        ['agy:master-1', { id: 'agy:master-1', label: 'Agy Master', state: 'idle', lines: [], perms: [] }],
        ['claude:unrelated-99', { id: 'claude:unrelated-99', label: 'Unrelated Chat', state: 'idle', lines: [], perms: [] }],
      ]),
    });
    machines.set('gpu-b', {
      name: 'gpu-b',
      online: true,
      control: true,
      files: true,
      sessions: new Map(),
    });

    const marks = createMarks({ dataDir: tmp });
    const fsCatalog = createFsCatalog({ dataDir: tmp, machines });
    fsCatalog.setNote({
      machine: 'gpu-b',
      path: '/data/cem_solver',
      tag: 'solver',
      userNote: 'CEM求解器代码目录',
      aiNote: '入口为 run_po.py',
    });

    const mesh = createMesh({
      dataDir: tmp,
      machines,
      store: { sessions: () => ({}), info: () => null },
      marks,
      fsCatalog,
      dispatchControl: async (machineName, payload) => {
        dispatched.push({ machine: machineName, payload });
        return { ok: true, msg: 'ok' };
      },
    });

    // 1. Create a project with workspace boundaries
    const pRes = mesh.saveProject({
      name: '高频条带积分加速',
      desc: '跨机协同求解与误差对比',
      workspaces: [
        { machine: 'pc-a', path: 'G:\\feko_data', mode: 'rw', tag: 'results' },
        { machine: 'gpu-b', path: '/data/cem_solver', mode: 'rw', tag: 'solver' },
        { machine: 'gpu-b', path: '/data/readonly_ref', mode: 'ro', tag: 'docs' },
      ],
    });
    assert.equal(pRes.ok, true);
    const projId = pRes.project.id;
    assert.ok(pRes.project.groupId, 'Should auto-create a group in session-marks');

    // 2. Bind Master session on pc-a
    const mNodeRes = mesh.upsertNode(projId, {
      machine: 'pc-a',
      sessionId: 'agy:master-1',
      alias: '科研主控台',
      role: 'master',
      tool: 'agy',
    });
    assert.equal(mNodeRes.ok, true);
    const masterMark = marks.get().sessions['pc-a|agy:master-1'];
    assert.ok(masterMark && masterMark.group === pRes.project.groupId, 'Master session must auto-join the dashboard group');
    assert.equal(masterMark.pinned, true, 'Master session should be auto-pinned in group');

    // 3. Workspace boundary enforcement: spawning outside allowed workspace or in read-only workspace must fail
    const badSpawn = await mesh.spawnWorker({
      projectId: projId,
      fromMachine: 'pc-a',
      fromSessionId: 'agy:master-1',
      machine: 'gpu-b',
      cwd: '/etc/secret_folder',
      tool: 'claude',
      goal: '非法目录测试',
    });
    assert.equal(badSpawn.ok, false);
    assert.match(badSpawn.msg, /不在项目.*范围内/);

    const roSpawn = await mesh.spawnWorker({
      projectId: projId,
      fromMachine: 'pc-a',
      fromSessionId: 'agy:master-1',
      machine: 'gpu-b',
      cwd: '/data/readonly_ref',
      tool: 'claude',
      goal: '只读目录测试',
    });
    assert.equal(roSpawn.ok, false);
    assert.match(roSpawn.msg, /只读/);

    // 4. Valid worker spawn injects folder notes and contract
    const okSpawn = await mesh.spawnWorker({
      projectId: projId,
      fromMachine: 'pc-a',
      fromSessionId: 'agy:master-1',
      machine: 'gpu-b',
      cwd: '/data/cem_solver',
      tool: 'claude',
      alias: 'FEKO求解器节点',
      goal: '拉取 feat/ribbon 分支并计算球体双站 RCS',
      stopCondition: '生成误差对比图后立即停下等待 Review',
      prompt: '请执行 python run_po.py',
    });
    assert.equal(okSpawn.ok, true);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].machine, 'gpu-b');
    assert.equal(dispatched[0].payload.t, 'launch');
    assert.match(dispatched[0].payload.prompt, /CEM求解器代码目录/, 'User folder note should be injected into spawn contract');
    assert.match(dispatched[0].payload.prompt, /生成误差对比图后立即停下等待 Review/, 'Stop gate should be injected');

    // Simulate gpu-b reporting the new session via meta/state
    machines.get('gpu-b').sessions.set('claude:worker-b1', {
      id: 'claude:worker-b1',
      label: 'Worker B1',
      state: 'working',
      cwd: '/data/cem_solver',
      lines: [{ text: '在跑：python run_po.py', t: Date.now() }],
      perms: [],
    });
    mesh.onMachineState('gpu-b', [...machines.get('gpu-b').sessions.values()]);

    // Verify worker auto-bound its sessionId and joined the dashboard group
    const workerMark = marks.get().sessions['gpu-b|claude:worker-b1'];
    assert.ok(workerMark && workerMark.group === pRes.project.groupId, 'Spawned worker must auto-join dashboard group');

    // 5. Scoped view isolation: querying scope for agy:master-1 must ONLY return nodes in this topology, NOT claude:unrelated-99
    const scope = mesh.scopedViewFor({ machine: 'pc-a', sessionId: 'agy:master-1' });
    assert.equal(scope.ok, true);
    assert.equal(scope.project.nodes.length, 2);
    assert.ok(!scope.project.nodes.some((n) => n.sessionId === 'claude:unrelated-99'), 'Unrelated sessions must not pollute topology state table');

    // 6. Sending message while worker is 'working' queues in inbox, then flushes automatically when worker becomes 'idle'
    const sendWhileBusy = await mesh.sendMessage({
      projectId: projId,
      fromMachine: 'pc-a',
      fromSessionId: 'agy:master-1',
      toNodeId: okSpawn.node.id,
      text: '顺便把频率步长改为 0.5GHz',
    });
    assert.equal(sendWhileBusy.ok, true);
    assert.equal(sendWhileBusy.queued, true);
    assert.equal(dispatched.length, 1, 'Should not interrupt a working terminal immediately');

    // Transition worker to 'done' -> inbox flushes automatically
    machines.get('gpu-b').sessions.get('claude:worker-b1').state = 'done';
    mesh.onMachineState('gpu-b', [...machines.get('gpu-b').sessions.values()]);
    assert.equal(dispatched.length, 2, 'Queued inbox message should be delivered on transition to done/idle');
    assert.equal(dispatched[1].payload.t, 'send');
    assert.equal(dispatched[1].payload.id, 'claude:worker-b1');

    // 7. Worker reports result -> Master (idle) is automatically woken up with review summary
    const rep = await mesh.reportResult({
      fromMachine: 'gpu-b',
      fromSessionId: 'claude:worker-b1',
      summary: '球体 RCS 对比完成，最大均方根误差 0.32 dB',
      reviewStatus: 'waiting_review',
      artifacts: ['/data/cem_solver/out/rcs_cmp.png'],
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.masterDelivery.delivered, true);
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[2].machine, 'pc-a');
    assert.equal(dispatched[2].payload.id, 'agy:master-1');
    assert.match(dispatched[2].payload.text, /0\.32 dB/);

    // 8. Large file transfer (> 50MB) triggers manual_disk (sneakernet) handoff, and confirming wakes the target node
    const xfer = mesh.requestTransfer({
      projectId: projId,
      fromMachine: 'gpu-b',
      fromPath: '/data/cem_solver/out/full_wave_field.h5',
      toMachine: 'pc-a',
      toPath: 'G:\\feko_data\\full_wave_field.h5',
      size: 12 * 1024 * 1024 * 1024, // 12 GB
      note: '球体全波近场数据，需移动硬盘拷贝',
    });
    assert.equal(xfer.ok, true);
    assert.equal(xfer.transfer.mode, 'manual_disk');
    assert.equal(xfer.transfer.status, 'pending');

    const conf = await mesh.confirmTransfer(projId, xfer.transfer.id, {
      newToPath: 'D:\\feko_data\\full_wave_field.h5',
      wake: true,
    });
    assert.equal(conf.ok, true);
    assert.equal(conf.transfer.status, 'completed');
    assert.equal(conf.transfer.toPath, 'D:\\feko_data\\full_wave_field.h5');
    assert.equal(dispatched.length, 4, 'Confirming manual disk handoff should wake target session');
    assert.match(dispatched[3].payload.text, /超大文件已通过人工硬盘拷贝就位/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
