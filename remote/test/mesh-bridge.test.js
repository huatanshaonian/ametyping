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
const { handleMcpCall, MCP_TOOLS } = require('../../tools/ame-mesh');

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
        mesh.fromAgentRpc('pc-a', { ...d, t: 'mesh-req', rid: 'r1' }, {
          send(raw) {
            const reply = JSON.parse(raw);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply));
          },
        });
      });
    });

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const opts = { auth: { port, token, machine: 'pc-a' } };

    assert.equal(MCP_TOOLS.length, 9);
    const triggerTool = MCP_TOOLS.find((t) => t.name === 'mesh_trigger');
    assert.deepEqual(triggerTool.inputSchema.properties.type.enum, ['folder']);
    assert.equal(triggerTool.inputSchema.properties.maxDepth.type, 'number');

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
