'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');
const { handleMcpCall, MCP_TOOLS, runCli } = require('../../tools/ame-mesh');

test('ame-mesh tool bridge (MCP & CLI) communicates over local loopback to NAS mesh', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-bridge-'));
  let srv = null;
  try {
    const machines = new Map();
    machines.set('pc-a', {
      name: 'pc-a',
      online: true,
      control: true,
      files: true,
      sessions: new Map([['agy:s1', { id: 'agy:s1', label: 'Main Agy', state: 'idle', lines: [], perms: [] }]]),
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
    const mesh = createMesh({
      dataDir: tmp,
      machines,
      store: { sessions: () => ({}), info: () => null },
      marks,
      fsCatalog,
      dispatchControl: async () => ({ ok: true, msg: 'launched' }),
    });

    // Spin up a local loopback server mimicking agent.js's mesh bridge forwarding to mesh.fromAgentRpc
    const token = 'test-secret-token-123';
    const capturedRequests = [];
    srv = http.createServer((req, res) => {
      if (req.headers['x-ame-mesh'] !== token) {
        res.writeHead(403);
        return res.end('{}');
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const d = JSON.parse(body || '{}');
        capturedRequests.push(d);
        const NEW_OPS = new Set(['board_post', 'board_read', 'task']);
        mesh.fromAgentRpc('pc-a', { ...d, t: 'mesh-req', rid: 'r1' }, {
          send(raw) {
            const reply = JSON.parse(raw);
            if (NEW_OPS.has(d.op) && reply && reply.ok === false && /未知|unknown|unsupported/i.test(reply.msg || '')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true, op: d.op, mocked: true }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply));
          },
        });
      });
    });

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const opts = { auth: { port, token, machine: 'pc-a' } };

    assert.equal(MCP_TOOLS.length, 12);
    const statusTool = MCP_TOOLS.find((t) => t.name === 'mesh_status');
    assert.match(statusTool.description, /roleCatalog/);
    assert.match(statusTool.description, /pools/);

    const triggerTool = MCP_TOOLS.find((t) => t.name === 'mesh_trigger');
    assert.deepEqual(triggerTool.inputSchema.properties.type.enum, ['folder']);
    assert.equal(triggerTool.inputSchema.properties.maxDepth.type, 'number');

    const spawnTool = MCP_TOOLS.find((t) => t.name === 'mesh_spawn');
    assert.equal(spawnTool.inputSchema.properties.role.type, 'string');
    assert.equal(spawnTool.inputSchema.properties.pool.type, 'string');
    assert.equal(spawnTool.inputSchema.properties.model.type, 'string');
    assert.equal(spawnTool.inputSchema.properties.boundaries.type, 'array');
    assert.equal(spawnTool.inputSchema.properties.doneWhen.type, 'array');
    assert.equal(spawnTool.inputSchema.properties.checks.type, 'array');

    const reportTool = MCP_TOOLS.find((t) => t.name === 'mesh_report');
    assert.equal(reportTool.inputSchema.properties.doneWhenStatus.type, 'array');
    assert.equal(reportTool.inputSchema.properties.checksOutput.type, 'string');
    assert.equal(reportTool.inputSchema.properties.boundaries.type, 'array');

    const boardPostTool = MCP_TOOLS.find((t) => t.name === 'mesh_board_post');
    assert.ok(boardPostTool);
    assert.deepEqual(boardPostTool.inputSchema.required, ['text']);
    assert.equal(boardPostTool.inputSchema.properties.channel.default, 'main');
    assert.equal(boardPostTool.inputSchema.properties.done.type, 'boolean');

    const boardReadTool = MCP_TOOLS.find((t) => t.name === 'mesh_board_read');
    assert.ok(boardReadTool);
    assert.equal(boardReadTool.inputSchema.properties.since.type, 'number');
    assert.equal(boardReadTool.inputSchema.properties.seqList.items.type, 'number');

    const taskTool = MCP_TOOLS.find((t) => t.name === 'mesh_task');
    assert.ok(taskTool);
    assert.deepEqual(taskTool.inputSchema.required, ['action']);
    assert.deepEqual(taskTool.inputSchema.properties.action.enum, ['list', 'add', 'claim', 'update', 'remove']);
    assert.deepEqual(taskTool.inputSchema.properties.status.enum, ['pending', 'in_progress', 'review', 'done', 'blocked']);

    // 1. AI writes a folder note via `mesh_note`
    const noteRes = await handleMcpCall('mesh_note', {
      machine: 'gpu-b',
      path: '/work/cem_po',
      tag: 'solver',
      aiNote: 'PO 与渐近条带求解器，Python 3.11',
    }, opts);
    assert.equal(noteRes.ok, true);
    assert.equal(fsCatalog.get('gpu-b', '/work/cem_po').aiNote, 'PO 与渐近条带求解器，Python 3.11');
    assert.equal(capturedRequests[capturedRequests.length - 1].callerCwd, process.cwd());

    // 2. Master spawns a worker on gpu-b via `mesh_spawn`
    const spawnRes = await handleMcpCall('mesh_spawn', {
      projectName: 'CEM 跨机求解验证',
      sessionId: 'agy:s1',
      machine: 'gpu-b',
      cwd: '/work/cem_po',
      tool: 'claude',
      alias: 'GPU计算节点',
      goal: '运行 test_algorithms.py 校验解析条带精度',
      stopCondition: '输出误差表格后停下等待 Review',
      prompt: '开始执行测试',
    }, opts);
    assert.equal(spawnRes.ok, true);
    assert.equal(spawnRes.project.name, 'CEM 跨机求解验证');
    assert.equal(spawnRes.project.nodes.length, 2); // master + worker

    // 3. Query `mesh_status` from Master session
    const statusRes = await handleMcpCall('mesh_status', {
      sessionId: 'agy:s1',
    }, opts);
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.project.id, spawnRes.project.id);
    assert.equal(statusRes.self.role, 'master');

    // 4. Verify AME_PROJECT_ID / AME_NODE_ID env fallback and callerCwd attachment in handleMcpCall
    const prevProjEnv = process.env.AME_PROJECT_ID;
    const prevNodeEnv = process.env.AME_NODE_ID;
    const workerNode = spawnRes.project.nodes.find((n) => n.role === 'worker');
    try {
      process.env.AME_PROJECT_ID = spawnRes.project.id;
      process.env.AME_NODE_ID = workerNode.id;

      await handleMcpCall('mesh_report', {
        summary: 'env fallback test',
      }, { ...opts, cwd: '/work/cem_po' });

      const envReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(envReq.op, 'report');
      assert.equal(envReq.projectId, spawnRes.project.id);
      assert.equal(envReq.fromNodeId, workerNode.id);
      assert.equal(envReq.nodeId, workerNode.id);
      assert.equal(envReq.callerCwd, '/work/cem_po');

      // Explicit params override env fallbacks and opts.cwd
      await handleMcpCall('mesh_report', {
        projectId: 'explicit-proj',
        fromNodeId: 'explicit-node',
        callerCwd: '/custom/cwd',
        summary: 'explicit override test',
      }, { ...opts, cwd: '/work/cem_po' });

      const overrideReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(overrideReq.projectId, 'explicit-proj');
      assert.equal(overrideReq.fromNodeId, 'explicit-node');
      assert.equal(overrideReq.nodeId, workerNode.id);
      assert.equal(overrideReq.callerCwd, '/custom/cwd');

      // 5. Verify mesh_spawn role/pool/model forwarding + mesh_board_post / mesh_board_read / mesh_task forwarding
      const spawnRoleRes = await handleMcpCall('mesh_spawn', {
        machine: 'gpu-b',
        cwd: '/work/cem_po',
        role: 'verifier',
        pool: 'flagship',
        model: 'claude-opus',
        alias: '验收节点',
        goal: '复核求解结果',
        prompt: '只读核查测试输出',
      }, opts);
      assert.equal(spawnRoleRes.ok, true);
      const spawnRoleReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(spawnRoleReq.op, 'spawn');
      assert.equal(spawnRoleReq.role, 'verifier');
      assert.equal(spawnRoleReq.pool, 'flagship');
      assert.equal(spawnRoleReq.model, 'claude-opus');

      const bpRes = await handleMcpCall('mesh_board_post', {
        text: '完成求解 #1 @all',
        channel: 'main',
        done: true,
        doneWhenStatus: ['1: pass'],
        checksOutput: 'ok',
        boundaries: ['tools/ame-mesh.js'],
      }, opts);
      assert.equal(bpRes.ok, true);
      const bpReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(bpReq.op, 'board_post');
      assert.equal(bpReq.done, true);
      assert.deepEqual(bpReq.doneWhenStatus, ['1: pass']);
      assert.deepEqual(bpReq.boundaries, ['tools/ame-mesh.js']);

      const brRes = await handleMcpCall('mesh_board_read', {
        since: 0,
        limit: 20,
        seqList: [1, 2],
      }, opts);
      assert.equal(brRes.ok, true);
      const brReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(brReq.op, 'board_read');
      assert.equal(brReq.since, 0);
      assert.equal(brReq.limit, 20);
      assert.deepEqual(brReq.seqList, [1, 2]);

      const taskRes = await handleMcpCall('mesh_task', {
        action: 'add',
        title: 'Task 1',
        blockedBy: ['t0'],
        boundaries: ['remote/agent/agent.js'],
        doneWhen: ['1. passes tests'],
        checks: ['node --test remote/test/mesh-bridge.test.js'],
        boardRefs: [1],
      }, opts);
      assert.equal(taskRes.ok, true);
      const taskReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(taskReq.op, 'task');
      assert.equal(taskReq.action, 'add');
      assert.deepEqual(taskReq.blockedBy, ['t0']);
      assert.deepEqual(taskReq.boundaries, ['remote/agent/agent.js']);
      assert.deepEqual(taskReq.doneWhen, ['1. passes tests']);
      assert.deepEqual(taskReq.checks, ['node --test remote/test/mesh-bridge.test.js']);
      assert.deepEqual(taskReq.boardRefs, [1]);

      // 6. Verify CLI subcommand mapping & array/number/boolean flag coercion
      await runCli([
        'board-post',
        '--text', 'cli post',
        '--done', 'true',
        '--boundaries', 'a.js, b.js',
        '--doneWhenStatus', 'ok1,ok2',
      ], opts);
      const cliBpReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(cliBpReq.op, 'board_post');
      assert.equal(cliBpReq.done, true);
      assert.deepEqual(cliBpReq.boundaries, ['a.js', 'b.js']);
      assert.deepEqual(cliBpReq.doneWhenStatus, ['ok1', 'ok2']);

      await runCli([
        'board-read',
        '--since', '0',
        '--limit', '15',
        '--seqList', '3, 4',
      ], opts);
      const cliBrReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(cliBrReq.op, 'board_read');
      assert.equal(cliBrReq.since, 0);
      assert.equal(cliBrReq.limit, 15);
      assert.deepEqual(cliBrReq.seqList, [3, 4]);

      await runCli([
        'task',
        '--action', 'add',
        '--title', 'cli task',
        '--blockedBy', 't1,t2',
        '--doneWhen', 'd1,d2',
        '--checks', 'c1,c2',
        '--boardRefs', '7,8',
      ], opts);
      const cliTaskReq = capturedRequests[capturedRequests.length - 1];
      assert.equal(cliTaskReq.op, 'task');
      assert.deepEqual(cliTaskReq.blockedBy, ['t1', 't2']);
      assert.deepEqual(cliTaskReq.doneWhen, ['d1', 'd2']);
      assert.deepEqual(cliTaskReq.checks, ['c1', 'c2']);
      assert.deepEqual(cliTaskReq.boardRefs, [7, 8]);
    } finally {
      if (prevProjEnv === undefined) delete process.env.AME_PROJECT_ID;
      else process.env.AME_PROJECT_ID = prevProjEnv;
      if (prevNodeEnv === undefined) delete process.env.AME_NODE_ID;
      else process.env.AME_NODE_ID = prevNodeEnv;
    }
  } finally {
    if (srv) srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
