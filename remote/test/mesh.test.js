'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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

test('caller identity injection, callerCwd resolution without sessionId, and auto <50MB streaming file transfer', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mesh-xfer-'));
  try {
    const dispatched = [];
    const fromSent = [];
    const toSent = [];

    const fromSock = {
      readyState: 1,
      filesAllowed: true,
      send(raw) { fromSent.push(JSON.parse(raw)); },
    };
    const toSock = {
      readyState: 1,
      filesAllowed: true,
      uploadAllowed: true,
      send(raw) { toSent.push(JSON.parse(raw)); },
    };

    const machines = new Map();
    machines.set('pc-a', {
      name: 'pc-a',
      online: true,
      control: true,
      files: true,
      upload: true,
      sockets: new Set([fromSock]),
      sessions: new Map([
        ['claude:master-a', { id: 'claude:master-a', label: 'Master A', state: 'idle', lines: [], perms: [] }],
      ]),
    });
    machines.set('gpu-b', {
      name: 'gpu-b',
      online: true,
      control: true,
      files: true,
      upload: true,
      sockets: new Set([toSock]),
      sessions: new Map(),
    });

    const store = {
      sessions: () => ({}),
      info: (m, sid) => (m === 'pc-a' && sid === 'claude:master-a' ? { cwd: 'G:\\proj_master' } : null),
    };

    const mesh = createMesh({
      dataDir: tmp,
      machines,
      store,
      marks: createMarks({ dataDir: tmp }),
      fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
      dispatchControl: async (machineName, payload) => {
        dispatched.push({ machine: machineName, payload });
        return { ok: true, msg: 'ok' };
      },
    });

    // a) spawnWorker with empty fromSessionId auto-registers master via callerCwd/store.info,
    //    injects projectId & nodeId into prompt, and includes meshEnv in launch payload
    const spawnRes = await mesh.spawnWorker({
      projectName: '流式传输与身份注入测试',
      fromMachine: 'pc-a',
      fromSessionId: '',
      callerCwd: 'G:\\proj_master',
      machine: 'gpu-b',
      cwd: '/data/work_b',
      tool: 'claude',
      goal: '计算后传回结果',
      prompt: '运行求解器',
    });
    assert.equal(spawnRes.ok, true);
    const projId = spawnRes.project.id;
    const workerNodeId = spawnRes.node.id;
    assert.ok(projId && workerNodeId);
    assert.ok(spawnRes.project.nodes.some((n) => n.role === 'master' && n.sessionId === 'claude:master-a'), 'Master should be auto-registered');

    const launch = dispatched[0].payload;
    assert.equal(launch.t, 'launch');
    assert.deepEqual(launch.meshEnv, { AME_PROJECT_ID: projId, AME_NODE_ID: workerNodeId });
    assert.match(launch.prompt, new RegExp(`projectId="${projId}", nodeId="${workerNodeId}"`));

    // b) scopedViewFor & reportResult resolve the worker node via callerCwd even when sessionId is empty
    const scopeByCwd = mesh.scopedViewFor({ machine: 'gpu-b', sessionId: '', callerCwd: '/data/work_b' });
    assert.equal(scopeByCwd.ok, true);
    assert.equal(scopeByCwd.project.id, projId);
    assert.equal(scopeByCwd.self.id, workerNodeId);

    const repByCwd = await mesh.reportResult({
      fromMachine: 'gpu-b',
      fromSessionId: '',
      callerCwd: '/data/work_b',
      summary: '已完成第一阶段，准备汇报',
      reviewStatus: 'waiting_review',
    });
    assert.equal(repByCwd.ok, true);
    assert.equal(repByCwd.masterDelivery.delivered, true);
    assert.equal(dispatched[1].machine, 'pc-a');
    assert.equal(dispatched[1].payload.id, 'claude:master-a');
    assert.match(dispatched[1].payload.text, /已完成第一阶段/);

    // c) requestTransfer < 50MB auto mode streams chunks pc-a -> gpu-b with CRC-32 and notifies target node
    const xferRes = mesh.requestTransfer({
      projectId: projId,
      fromMachine: 'pc-a',
      fromPath: 'G:\\proj_master\\mesh_input.bin',
      toMachine: 'gpu-b',
      toPath: '/data/work_b/mesh_input.bin',
      size: 12,
      mode: 'auto',
      notifyNodeId: workerNodeId,
    });
    assert.equal(xferRes.ok, true);
    assert.equal(xferRes.transfer.status, 'transferring');
    assert.equal(fromSent.length, 1);
    assert.equal(fromSent[0].t, 'fs');
    assert.equal(fromSent[0].op, 'read');
    const readRid = fromSent[0].rid;
    assert.ok(readRid.startsWith('mfs-'));

    const part1 = Buffer.from('Hello ');
    const part2 = Buffer.from('AmeMesh!');
    const fullBuf = Buffer.concat([part1, part2]);
    const expectedCrc = zlib.crc32(fullBuf) >>> 0;

    // Source responds with fs-res -> server sends up-open to destination
    assert.equal(mesh.fromAgentFs(machines.get('pc-a'), { t: 'fs-res', rid: readRid, ok: true, size: fullBuf.length, mtime: 12345 }), true);
    assert.equal(toSent.length, 1);
    assert.equal(toSent[0].t, 'fs');
    assert.equal(toSent[0].op, 'up-open');
    assert.equal(toSent[0].path, '/data/work_b');
    assert.equal(toSent[0].name, 'mesh_input.bin');
    assert.equal(toSent[0].size, fullBuf.length);
    const upRid = toSent[0].rid;

    // Source sends chunk 0 BEFORE up-open response arrives (tests pendingChunks buffering)
    assert.equal(mesh.fromAgentFs(machines.get('pc-a'), { t: 'fs-chunk', rid: readRid, i: 0, data: part1.toString('base64') }), true);
    assert.equal(toSent.length, 1, 'Should buffer chunk until up-open responds');

    // Destination responds to up-open -> buffered chunk 0 is flushed as fs-up
    assert.equal(mesh.fromAgentFs(machines.get('gpu-b'), { t: 'fs-res', rid: upRid, ok: true, have: 0 }), true);
    assert.equal(toSent.length, 2);
    assert.equal(toSent[1].t, 'fs-up');
    assert.equal(toSent[1].off, 0);
    assert.equal(Buffer.from(toSent[1].data, 'base64').toString(), 'Hello ');

    // Destination acks chunk 0 -> server sends fs-ack i=0 back to source
    assert.equal(mesh.fromAgentFs(machines.get('gpu-b'), { t: 'fs-up-ack', rid: upRid, have: part1.length }), true);
    assert.equal(fromSent.length, 2);
    assert.deepEqual(fromSent[1], { t: 'fs-ack', rid: readRid, i: 0 });

    // Source sends chunk 1 & fs-end -> server forwards fs-up & fs-up-end with valid CRC-32
    assert.equal(mesh.fromAgentFs(machines.get('pc-a'), { t: 'fs-chunk', rid: readRid, i: 1, data: part2.toString('base64') }), true);
    assert.equal(mesh.fromAgentFs(machines.get('pc-a'), { t: 'fs-end', rid: readRid }), true);
    assert.equal(toSent.length, 4);
    assert.equal(toSent[2].t, 'fs-up');
    assert.equal(toSent[2].off, part1.length);
    assert.equal(Buffer.from(toSent[2].data, 'base64').toString(), 'AmeMesh!');
    assert.equal(toSent[3].t, 'fs-up-end');
    assert.equal(toSent[3].rid, upRid);
    assert.equal(toSent[3].crc, expectedCrc);

    // Destination finishes with fs-up-done -> transfer marked completed & target node notified
    assert.equal(mesh.fromAgentFs(machines.get('gpu-b'), { t: 'fs-up-done', rid: upRid, ok: true, path: '/data/work_b/mesh_input.bin' }), true);
    const updatedProj = mesh.getProject(projId);
    const doneXfer = updatedProj.transfers.find((t) => t.id === xferRes.transfer.id);
    assert.equal(doneXfer.status, 'completed');
    const targetNode = updatedProj.nodes.find((n) => n.id === workerNodeId);
    assert.ok(targetNode.inbox.some((m) => /跨机文件已自动传输就位/.test(m.text)), 'Target worker node should receive handoff_ready notification');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
