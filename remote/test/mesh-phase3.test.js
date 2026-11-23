'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBoard, parseChannelMentions } = require('../server/mesh-board');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');

function makePhase3Fixture({ dispatchControl } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-phase3-'));
  const dispatched = [];
  const sentRaw = [];
  const fakeSock = {
    readyState: 1,
    remoteControlAllowed: true,
    send(raw) { sentRaw.push(JSON.parse(raw)); },
  };
  const machines = new Map();
  machines.set('pc-a', {
    name: 'pc-a',
    online: true,
    control: true,
    files: true,
    sockets: new Set([fakeSock]),
    sessions: new Map([
      ['agy:master-1', { id: 'agy:master-1', label: 'Master', state: 'idle', lines: [], perms: [] }],
      ['claude:worker-1', { id: 'claude:worker-1', label: 'Worker 1', state: 'idle', lines: [], perms: [] }],
      ['codex:worker-2', { id: 'codex:worker-2', label: 'Worker 2', state: 'idle', lines: [], perms: [] }],
    ]),
  });

  const marks = createMarks({ dataDir: tmp });
  const fsCatalog = createFsCatalog({ dataDir: tmp, machines });
  const mesh = createMesh({
    dataDir: tmp,
    machines,
    store: { sessions: () => ({}), info: () => null },
    marks,
    fsCatalog,
    ...(dispatchControl
      ? { dispatchControl }
      : {
          dispatchControl: async (machineName, payload) => {
            dispatched.push({ machine: machineName, payload });
            return { ok: true, msg: 'ok' };
          },
        }),
  });

  const projRes = mesh.saveProject({ name: 'Swarm Phase 3 测试项目' });
  const projId = projRes.project.id;

  const master = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'agy:master-1',
    alias: 'master',
    role: 'master',
    tool: 'agy',
  }).node;

  const worker1 = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'claude:worker-1',
    alias: 'worker-1',
    role: 'worker',
    tool: 'claude',
  }).node;

  const worker2 = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'codex:worker-2',
    alias: 'worker-2',
    role: 'worker',
    tool: 'codex',
  }).node;

  return {
    tmp,
    dispatched,
    sentRaw,
    machines,
    marks,
    fsCatalog,
    mesh,
    projId,
    master,
    worker1,
    worker2,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('Phase 3: Multi-Channel Event Sourcing', () => {
  it('parseChannelMentions extracts deduplicated lowercase channel tokens without colliding with @alias or #seq', () => {
    assert.deepEqual(parseChannelMentions('@#gpu-run 请查看 #3'), ['gpu-run']);
    assert.deepEqual(
      parseChannelMentions('@worker-1 请到 @#GPU-Run 和 @#gpu-run 以及 @#仿真频道 查看 #12'),
      ['gpu-run', '仿真频道']
    );
    assert.deepEqual(parseChannelMentions('普通消息 @master #5'), []);
  });

  it('replays channel create -> subscribe -> @#channel wake -> archive deterministically across disk reload', async () => {
    const fx = makePhase3Fixture();
    try {
      // Initial project has default channel 'main'
      const initProj = fx.mesh.getProject(fx.projId);
      assert.equal(initProj.channels.length, 1);
      assert.equal(initProj.channels[0].name, 'main');
      assert.equal(initProj.channels[0].archived, false);

      // 1. Create channel
      const cr = fx.mesh.manageChannel({
        projectId: fx.projId,
        action: 'create',
        channel: 'GPU-Run',
        desc: 'GPU 并发算例协同频道',
        fromNodeId: fx.master.id,
      });
      assert.equal(cr.ok, true);
      assert.equal(cr.entry.kind, 'control');
      assert.deepEqual(cr.entry.control, {
        op: 'channel_create',
        channel: 'gpu-run',
        desc: 'GPU 并发算例协同频道',
      });

      // 2. Subscribe worker1 (not worker2)
      const sub = fx.mesh.manageChannel({
        projectId: fx.projId,
        action: 'subscribe',
        channel: 'gpu-run',
        nodeId: fx.worker1.id,
        fromNodeId: fx.master.id,
      });
      assert.equal(sub.ok, true);
      const gpuCh1 = sub.channels.find((c) => c.name === 'gpu-run');
      assert.ok(gpuCh1);
      assert.deepEqual(gpuCh1.subscribers, [fx.worker1.id]);

      // 3. postBoard with @#gpu-run wakes only subscribed worker1
      const post1 = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        text: '@#gpu-run 请开始执行网格计算 #1',
      });
      assert.equal(post1.ok, true);
      assert.deepEqual(post1.entry.mentionChannels, ['gpu-run']);
      assert.equal(post1.deliveries.length, 1);
      assert.equal(post1.deliveries[0].nodeId, fx.worker1.id);
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'claude:worker-1');
      assert.equal(fx.worker1.lastMentionedSeq, post1.entry.seq);

      // Posting directly in channel: 'gpu-run' also wakes subscribed worker1
      const post2 = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        channel: 'gpu-run',
        text: '请汇报进度',
      });
      assert.equal(post2.ok, true);
      assert.equal(fx.dispatched.length, 2);
      assert.equal(fx.dispatched[1].payload.id, 'claude:worker-1');

      // 4. Archive channel -> subsequent @#gpu-run does not wake worker1
      const arch = fx.mesh.manageChannel({
        projectId: fx.projId,
        action: 'archive',
        channel: 'gpu-run',
        fromNodeId: fx.master.id,
      });
      assert.equal(arch.ok, true);
      const gpuChArch = arch.channels.find((c) => c.name === 'gpu-run');
      assert.equal(gpuChArch.archived, true);

      const post3 = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        text: '@#gpu-run 归档后不应唤醒',
      });
      assert.equal(post3.ok, true);
      assert.equal(post3.deliveries.length, 0);
      assert.equal(fx.dispatched.length, 2);

      // 5. Reload board & mesh from disk and verify channel state is identically replayed from board.jsonl
      const freshBoard = createBoard({ dataDir: fx.tmp });
      const replayedFromBoard = freshBoard.getChannels(fx.projId);
      assert.deepEqual(replayedFromBoard, arch.channels);

      const freshMesh = createMesh({
        dataDir: fx.tmp,
        machines: fx.machines,
        store: { sessions: () => ({}), info: () => null },
        marks: fx.marks,
        fsCatalog: fx.fsCatalog,
      });
      const replayedProj = freshMesh.getProject(fx.projId);
      assert.deepEqual(replayedProj.channels, arch.channels);
    } finally {
      fx.cleanup();
    }
  });

  it('supports channel HTTP endpoint and agent RPC', async () => {
    const fx = makePhase3Fixture();
    try {
      const rpcReplies = [];
      const fakeWs = { send: (raw) => rpcReplies.push(JSON.parse(raw)) };

      await fx.mesh.fromAgentRpc('pc-a', {
        t: 'mesh-req',
        rid: 'c1',
        op: 'channel',
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        action: 'create',
        channel: 'post-proc',
        desc: '后处理频道',
      }, fakeWs);
      assert.equal(rpcReplies[0].ok, true);
      assert.ok(rpcReplies[0].channels.some((c) => c.name === 'post-proc'));

      const responses = [];
      const jsonFn = (res, code, body) => responses.push({ code, body });
      const handled = await fx.mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/channel'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({
          projectId: fx.projId,
          action: 'subscribe',
          channel: 'post-proc',
          nodeId: fx.worker2.id,
        }),
        () => true
      );
      assert.equal(handled, true);
      assert.equal(responses[0].body.ok, true);
      const ch = responses[0].body.channels.find((c) => c.name === 'post-proc');
      assert.deepEqual(ch.subscribers, [fx.worker2.id]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('Phase 3: Git Worktree Concurrency Isolation', () => {
  it('spawnWorker with workspaceMode=worktree passes launch options, updates node paths, binds pendingSpawn, and forwards check/remove', async () => {
    const dispatched = [];
    const fx = makePhase3Fixture({
      dispatchControl: async (machineName, payload) => {
        dispatched.push({ machine: machineName, payload });
        if (payload.t === 'launch' && payload.workspaceMode === 'worktree') {
          return {
            ok: true,
            msg: 'launched in worktree',
            worktreePath: 'D:\\repo\\.ame-worktrees\\worker-wt',
            worktreeBranch: payload.worktreeBranch || 'mesh/worker-wt',
            worktreeParentRepo: payload.cwd,
          };
        }
        if (payload.t === 'worktree-check') {
          return {
            ok: true,
            dirty: true,
            unmergedCommits: 2,
            msg: '有未合并提交',
          };
        }
        if (payload.t === 'worktree-remove') {
          return { ok: true, msg: 'worktree 已移除' };
        }
        return { ok: true, msg: 'ok' };
      },
    });

    try {
      const sp = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo',
        alias: 'worker-wt',
        tool: 'claude',
        workspaceMode: 'worktree',
        branch: 'mesh/feat-wt',
        goal: '在独立 worktree 中并发开发',
      });
      assert.equal(sp.ok, true);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0].payload.t, 'launch');
      assert.equal(dispatched[0].payload.workspaceMode, 'worktree');
      assert.equal(dispatched[0].payload.worktreeBranch, 'mesh/feat-wt');
      assert.equal(dispatched[0].payload.worktreeAlias, 'worker-wt');

      // Node metadata updated from launchRes
      assert.equal(sp.node.workspaceMode, 'worktree');
      assert.equal(sp.node.cwd, 'D:\\repo\\.ame-worktrees\\worker-wt');
      assert.equal(sp.node.worktreePath, 'D:\\repo\\.ame-worktrees\\worker-wt');
      assert.equal(sp.node.worktreeBranch, 'mesh/feat-wt');
      assert.equal(sp.node.worktreeParentRepo, 'D:\\repo');

      // Session reporting the worktreePath binds cleanly via pendingSpawns
      fx.machines.get('pc-a').sessions.set('claude:wt-sess-1', {
        id: 'claude:wt-sess-1',
        label: 'WT Worker',
        state: 'idle',
        cwd: 'D:\\repo\\.ame-worktrees\\worker-wt',
        lines: [],
        perms: [],
      });
      fx.mesh.onMachineState('pc-a', [...fx.machines.get('pc-a').sessions.values()]);
      assert.equal(sp.node.sessionId, 'claude:wt-sess-1');

      // Inherit node returns isWorktree: false without calling agent
      const inheritChk = await fx.mesh.checkNodeWorktree(fx.projId, fx.worker1.id);
      assert.deepEqual(inheritChk, { ok: true, isWorktree: false });

      // Worktree node forwards worktree-check
      const chk = await fx.mesh.checkNodeWorktree(fx.projId, sp.node.id);
      assert.equal(chk.ok, true);
      assert.equal(chk.isWorktree, true);
      assert.equal(chk.dirty, true);
      assert.equal(chk.unmergedCommits, 2);
      assert.equal(chk.branch, 'mesh/feat-wt');
      assert.equal(chk.worktreePath, 'D:\\repo\\.ame-worktrees\\worker-wt');
      assert.deepEqual(dispatched[1].payload, {
        t: 'worktree-check',
        worktreePath: 'D:\\repo\\.ame-worktrees\\worker-wt',
        parentRepo: 'D:\\repo',
        branch: 'mesh/feat-wt',
      });

      // Worktree node forwards worktree-remove
      const rm = await fx.mesh.removeNodeWorktree(fx.projId, sp.node.id, { force: true });
      assert.equal(rm.ok, true);
      assert.deepEqual(dispatched[2].payload, {
        t: 'worktree-remove',
        worktreePath: 'D:\\repo\\.ame-worktrees\\worker-wt',
        parentRepo: 'D:\\repo',
        branch: 'mesh/feat-wt',
        force: true,
      });
    } finally {
      fx.cleanup();
    }
  });

  it('fromAgentResult preserves worktree & check metadata fields and HTTP worktree endpoints enforce step-up on remove', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-phase3-ws-'));
    const sentToSock = [];
    const fakeSock = {
      readyState: 1,
      remoteControlAllowed: true,
      send(raw) { sentToSock.push(JSON.parse(raw)); },
    };
    const machines = new Map([
      ['pc-a', {
        name: 'pc-a',
        online: true,
        control: true,
        files: true,
        sockets: new Set([fakeSock]),
        sessions: new Map(),
      }],
    ]);
    const mesh = createMesh({
      dataDir: tmp,
      machines,
      store: { sessions: () => ({}), info: () => null },
      marks: createMarks({ dataDir: tmp }),
      fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
    });

    try {
      const proj = mesh.saveProject({ name: 'Worktree WebSocket 元数据测试' }).project;
      const wtNode = mesh.upsertNode(proj.id, {
        machine: 'pc-a',
        alias: 'wt-1',
        workspaceMode: 'worktree',
        worktreePath: 'D:\\repo\\.ame-worktrees\\wt-1',
        worktreeParentRepo: 'D:\\repo',
        worktreeBranch: 'mesh/wt-1',
      }).node;

      // Trigger checkNodeWorktree over WebSocket and resolve via fromAgentResult
      const chkPromise = mesh.checkNodeWorktree(proj.id, wtNode.id);
      assert.equal(sentToSock.length, 1);
      const rid = sentToSock[0].rid;
      assert.equal(sentToSock[0].t, 'worktree-check');

      const handledRes = mesh.fromAgentResult('pc-a', {
        rid,
        ok: true,
        msg: 'checked',
        worktreePath: 'D:\\repo\\.ame-worktrees\\wt-1',
        worktreeBranch: 'mesh/wt-1',
        worktreeParentRepo: 'D:\\repo',
        dirty: true,
        unmergedCommits: 3,
        summary: '2 modified, 3 unmerged',
      });
      assert.equal(handledRes, true);
      const chkOut = await chkPromise;
      assert.equal(chkOut.ok, true);
      assert.equal(chkOut.isWorktree, true);
      assert.equal(chkOut.dirty, true);
      assert.equal(chkOut.unmergedCommits, 3);

      // HTTP /api/mesh/worktree-remove requires fresh TOTP (step-up)
      const responses = [];
      const jsonFn = (res, code, body) => responses.push({ code, body });
      await mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/worktree-remove'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ projectId: proj.id, nodeId: wtNode.id, force: false }),
        () => false
      );
      assert.equal(responses[0].body.need, 'totp');

      // With fresh TOTP, /api/mesh/worktree-remove dispatches worktree-remove
      const rmPromise = mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/worktree-remove'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ projectId: proj.id, nodeId: wtNode.id, force: true }),
        () => true
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(sentToSock.length, 2);
      assert.equal(sentToSock[1].t, 'worktree-remove');
      assert.equal(sentToSock[1].force, true);
      mesh.fromAgentResult('pc-a', { rid: sentToSock[1].rid, ok: true, msg: 'removed' });
      await rmPromise;
      assert.equal(responses[1].body.ok, true);

      // HTTP /api/mesh/worktree-check also dispatches worktree-check
      const chkHttpPromise = mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/worktree-check'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ projectId: proj.id, nodeId: wtNode.id }),
        () => true
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(sentToSock.length, 3);
      assert.equal(sentToSock[2].t, 'worktree-check');
      mesh.fromAgentResult('pc-a', { rid: sentToSock[2].rid, ok: true, dirty: false, unmergedCommits: 0, msg: 'clean' });
      await chkHttpPromise;
      assert.equal(responses[2].body.ok, true);
      assert.equal(responses[2].body.isWorktree, true);
      assert.equal(responses[2].body.dirty, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Master-only mesh_workspace one-shot fence setup with automatic lock and userApproved unlock', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ws-lock-'));
    try {
      const machines = new Map([
        ['pc-a', { name: 'pc-a', online: true, control: true, files: true, sessions: new Map() }],
        ['dell97', { name: 'dell97', online: true, control: true, files: true, sessions: new Map() }],
      ]);
      const mesh = createMesh({
        dataDir: tmp,
        machines,
        store: { sessions: () => ({}), info: () => null },
        marks: createMarks({ dataDir: tmp }),
        fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
        dispatchControl: async () => ({ ok: true }),
      });

      // 1. Master configures cross-machine workspaces once -> auto-locked + board brief
      const r1 = mesh.configureWorkspaces({
        projectName: '围栏锁测试',
        fromMachine: 'pc-a',
        fromSessionId: 's-master',
        workspaces: [
          { machine: 'pc-a', path: 'D:\\proj', mode: 'rw', tag: 'code' },
          { machine: 'dell97', path: '/home/dell/proj', mode: 'rw', tag: 'solver' },
        ],
      });
      assert.equal(r1.ok, true);
      assert.equal(r1.workspacesLocked, true);
      assert.equal(r1.workspaces.length, 2);
      const projId = r1.project.id;

      // 2. Subsequent modification without userApproved is blocked
      const rBlocked = mesh.configureWorkspaces({
        projectId: projId,
        fromMachine: 'pc-a',
        fromSessionId: 's-master',
        workspaces: [{ machine: 'pc-a', path: 'D:\\other', mode: 'rw' }],
      });
      assert.equal(rBlocked.ok, false);
      assert.equal(rBlocked.locked, true);

      // 3. Worker node is always denied even with userApproved=true
      const w = mesh.upsertNode(projId, { machine: 'dell97', sessionId: 's-worker', role: 'worker', alias: 'w1' });
      const rWorker = mesh.configureWorkspaces({
        projectId: projId,
        fromNodeId: w.node.id,
        userApproved: true,
        reason: 'worker试图越权',
        workspaces: [{ machine: 'dell97', path: '/etc', mode: 'rw' }],
      });
      assert.equal(rWorker.ok, false);
      assert.match(rWorker.msg, /仅 Master/);

      // 4. Master with explicit userApproved=true + reason succeeds and logs control audit to board
      const rUnlocked = mesh.configureWorkspaces({
        projectId: projId,
        fromMachine: 'pc-a',
        fromSessionId: 's-master',
        userApproved: true,
        reason: '用户授意新增只读数据目录',
        workspaces: [
          { machine: 'pc-a', path: 'D:\\proj', mode: 'rw', tag: 'code' },
          { machine: 'dell97', path: '/home/dell/proj', mode: 'rw', tag: 'solver' },
          { machine: 'dell97', path: '/home/dell/ref', mode: 'ro', tag: 'data' },
        ],
      });
      assert.equal(rUnlocked.ok, true);
      assert.equal(rUnlocked.workspaces.length, 3);
      assert.equal(rUnlocked.workspacesLocked, true);

      const board = mesh.readBoard({ projectId: projId, since: 0 });
      assert.ok(board.entries.some((e) => e.kind === 'brief' && e.text.includes('初始化并锁定')));
      assert.ok(board.entries.some((e) => e.kind === 'control' && e.text.includes('用户授意新增只读数据目录')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
