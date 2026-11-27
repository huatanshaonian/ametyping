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

  it('scopedViewFor strips bulky snapshot.tree by default, lists existing projects, discovers recent session worktrees, and reports per-machine harnesses', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-status-compact-'));
    try {
      const machines = new Map([
        ['huatanshaonian', {
          name: 'huatanshaonian',
          online: true,
          control: true,
          files: true,
          sessions: new Map(),
          mcpStatus: {
            clients: [
              { id: 'claude', present: true, servers: ['ame-mesh'] },
              { id: 'agy', present: true, servers: ['ame-mesh'] },
              { id: 'codex', present: true, servers: ['ame-mesh'] },
              { id: 'kiro', present: false, servers: [] },
            ],
          },
        }],
        ['remote3090', {
          name: 'remote3090',
          online: true,
          control: true,
          files: true,
          sessions: new Map(),
          mcpStatus: {
            clients: [
              { id: 'claude', present: true, servers: ['ame-mesh'] },
              { id: 'codex', present: true, servers: [] },
            ],
          },
        }],
      ]);
      const fsCatalog = {
        list: () => [{
          key: 'huatanshaonian|d:\\ametyping',
          machine: 'huatanshaonian',
          path: 'D:\\ametyping',
          tag: 'code',
          userNote: '主仓库',
          aiNote: '',
          snapshot: { count: 400, gitBranch: 'main', freeBytes: 1000, tree: [{ name: 'huge.js', dir: false }] },
        }],
        get: () => null,
        TAG_LABELS: { code: '核心代码' },
      };
      const store = {
        sessions: () => ({
          huatanshaonian: [{ id: 's1', cwd: 'D:\\ametyping-embed', last: 2000 }],
          remote3090: [{ id: 's2', cwd: 'D:\\ame-embed', last: 3000 }],
        }),
        info: () => null,
      };
      const mesh = createMesh({
        dataDir: tmp,
        machines,
        store,
        marks: createMarks({ dataDir: tmp }),
        fsCatalog,
        dispatchControl: async () => ({ ok: true }),
      });

      const created = mesh.saveProject({
        name: 'AmeTyping',
        workspaces: [{ machine: 'huatanshaonian', path: 'D:\\ametyping', mode: 'rw' }],
        workspacesLocked: true,
      });
      assert.equal(created.ok, true);

      // Default call (includeTree=false)
      const view = mesh.scopedViewFor({ machine: 'huatanshaonian', callerCwd: 'D:\\ametyping-embed' });
      assert.equal(view.ok, true);
      assert.equal(view.project, null);
      assert.equal(view.callerCwd, 'D:\\ametyping-embed');
      // 1. Existing projects returned so Master doesn't duplicate
      assert.equal(view.projects.length, 1);
      assert.equal(view.projects[0].name, 'AmeTyping');
      assert.equal(view.projects[0].workspacesCount, 1);
      assert.equal(view.projects[0].workspacesLocked, true);
      // 2. snapshot.tree stripped by default, count/gitBranch preserved
      const mainFolder = view.availableFolders.find((f) => f.path === 'D:\\ametyping');
      assert.ok(mainFolder);
      assert.equal(mainFolder.snapshot.count, 400);
      assert.equal(mainFolder.snapshot.gitBranch, 'main');
      assert.equal(mainFolder.snapshot.tree, undefined);
      // 3. Recent session worktrees discovered
      assert.ok(view.availableFolders.some((f) => f.machine === 'huatanshaonian' && f.path === 'D:\\ametyping-embed'));
      assert.ok(view.availableFolders.some((f) => f.machine === 'remote3090' && f.path === 'D:\\ame-embed'));
      // 4. Per-machine installed harnesses exposed
      const mLocal = view.machines.find((m) => m.machine === 'huatanshaonian');
      assert.deepEqual(mLocal.harnesses, ['claude', 'agy', 'codex']);
      assert.deepEqual(mLocal.meshReadyHarnesses, ['claude', 'agy', 'codex']);
      const m3090 = view.machines.find((m) => m.machine === 'remote3090');
      assert.deepEqual(m3090.harnesses, ['claude', 'codex']);
      assert.deepEqual(m3090.meshReadyHarnesses, ['claude']);

      // Explicit includeTree=true retains snapshot.tree
      const fullView = mesh.scopedViewFor({ machine: 'huatanshaonian', includeTree: true });
      const fullMain = fullView.availableFolders.find((f) => f.path === 'D:\\ametyping');
      assert.equal(fullMain.snapshot.tree.length, 1);

      // 5. Write RPCs (workspace / task / board_post) strip bulky snapshot from project in reply
      const replies = [];
      const mockWs = { send: (raw) => replies.push(JSON.parse(raw)) };
      await mesh.fromAgentRpc('huatanshaonian', {
        t: 'mesh-req',
        rid: 'r-ws',
        op: 'workspace',
        projectName: '轻量写操作测试',
        sessionId: 'agy:master-embed',
        callerCwd: 'D:\\ametyping-embed',
        workspaces: [{ machine: 'huatanshaonian', path: 'D:\\ametyping', mode: 'rw' }],
      }, mockWs);
      const wsReply = replies[0];
      assert.equal(wsReply.ok, true);
      assert.ok(wsReply.projectId);
      assert.equal(wsReply.project.workspaces[0].snapshot, undefined);
      // Master auto-bound when explicit sessionId is present
      const statusAfterWs = mesh.scopedViewFor({ projectId: wsReply.projectId, machine: 'huatanshaonian', sessionId: 'agy:master-embed', callerCwd: 'D:\\ametyping-embed' });
      assert.ok(statusAfterWs.self);
      assert.equal(statusAfterWs.self.role, 'master');

      // 6. @master wakes master node even when its alias is Chinese ('主控会话')
      const delivered = [];
      const wNode = mesh.upsertNode(wsReply.projectId, { machine: 'remote3090', sessionId: 's-w', role: 'worker', alias: 'worker-embed' });
      const postRes = await mesh.postBoard({
        projectId: wsReply.projectId,
        fromNodeId: wNode.node.id,
        text: '@master 已完成嵌入检索，请验收',
      });
      assert.equal(postRes.ok, true);
      assert.ok(postRes.deliveries.some((x) => x.nodeId === statusAfterWs.self.id));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('brief skips template @mentions, deduplicates doneWhen numbering, and gitAudit subtracts pre-existing baseline files', async () => {
    const fx = makePhase3Fixture({
      dispatchControl: async (_machine, payload) => {
        if (payload.t === 'launch') {
          return {
            ok: true,
            msg: 'launched',
            gitBaseline: {
              checked: true,
              isGit: true,
              changedFiles: ['clippy/a.js', 'clippy/b.js', 'docs/arch.md'],
              fingerprints: {
                'clippy/a.js': '100:1000',
                'clippy/b.js': '200:1000',
                'docs/arch.md': '300:1000',
              },
            },
          };
        }
        return { ok: true };
      },
    });
    try {

      const sp = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo',
        role: 'worker',
        alias: 'worker-embed',
        goal: '实现嵌入检索',
        boundaries: ['src/embed/**'],
        doneWhen: ['1. 通过全部单测', '2) 无越界改动'],
        prompt: '完成后在黑板发帖汇报',
      });
      assert.equal(sp.ok, true);

      // 7a. Brief entry only mentions target worker-embed, NOT @verifier/@master/@节点别名 from template
      const brd = fx.mesh.readBoard({ projectId: fx.projId, since: 0, limit: 20 });
      const brief = brd.entries.find((e) => e.kind === 'brief');
      assert.ok(brief);
      assert.deepEqual(brief.mentions, ['worker-embed']);
      assert.equal(brief.mentionAll, false);
      // 7b. doneWhen does not double-prefix "1. 1."
      assert.ok(brief.text.includes('  1. 通过全部单测'));
      assert.ok(brief.text.includes('  2. 无越界改动'));
      assert.ok(!brief.text.includes('1. 1.'));

      // 7c. Inline code `@verifier`, stack traces TypeError@e2e-literature.js, and emails are ignored
      const codePost = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: sp.node.id,
        text: '测试行内代码 `@verifier`、堆栈 TypeError@e2e-literature.js 和邮箱 a@b.com 不误点名，只点 @master',
      });
      assert.equal(codePost.ok, true);
      assert.deepEqual(codePost.entry.mentions, ['master']);

      // P0-2. Same-cwd unidentified caller resolves to master (not newer running worker), preventing self-loop suppression
      const masterPostByCwd = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromMachine: 'pc-a',
        callerCwd: 'D:\\repo',
        text: '@worker-embed 请继续推进',
      });
      assert.equal(masterPostByCwd.ok, true);
      assert.equal(masterPostByCwd.entry.nodeId, fx.master.id);
      assert.ok(masterPostByCwd.deliveries.some((x) => x.nodeId === sp.node.id));

      // 8a. Worker only edits allowed file src/embed/index.js; pre-existing clippy/* & docs/arch.md unchanged -> audit passes!
      const repOk = await fx.mesh.reportResult({
        projectId: fx.projId,
        fromNodeId: sp.node.id,
        summary: '嵌入检索完成',
        reviewStatus: 'waiting_review',
        gitAudit: {
          checked: true,
          isGit: true,
          changedFiles: ['clippy/a.js', 'clippy/b.js', 'docs/arch.md', 'src/embed/index.js'],
          fingerprints: {
            'clippy/a.js': '100:1000',
            'clippy/b.js': '200:1000',
            'docs/arch.md': '300:1000',
            'src/embed/index.js': '512:2000',
          },
        },
      });
      assert.equal(repOk.ok, true);
      assert.equal(repOk.audit.ok, true);
      assert.deepEqual(repOk.audit.changedFiles, ['src/embed/index.js']);
      assert.deepEqual(repOk.audit.outOfBounds, []);
      assert.equal(repOk.audit.baselineExcludedCount, 3);

      // 8b. If worker actually modifies a pre-existing dirty file outside boundaries (fingerprint changes), audit still catches it!
      const repBad = await fx.mesh.reportResult({
        projectId: fx.projId,
        fromNodeId: sp.node.id,
        summary: '不小心改了 clippy/a.js',
        reviewStatus: 'waiting_review',
        gitAudit: {
          checked: true,
          isGit: true,
          changedFiles: ['clippy/a.js', 'src/embed/index.js'],
          fingerprints: {
            'clippy/a.js': '999:3000',
            'src/embed/index.js': '512:2000',
          },
        },
      });
      assert.equal(repBad.ok, true);
      assert.equal(repBad.audit.ok, false);
      assert.deepEqual(repBad.audit.outOfBounds, ['clippy/a.js']);

      // Global Skills & Machine Profiles HTTP API
      let httpCode = 0;
      let httpBody = null;
      const fakeJson = (_res, code, body) => { httpCode = code; httpBody = body; };
      await fx.mesh.handle({ method: 'GET' }, {}, new URL('http://local/api/mesh/skills'), '127.0.0.1', fakeJson, async () => ({}));
      assert.equal(httpCode, 200);
      assert.equal(httpBody.ok, true);
      assert.ok(httpBody.skills.some((s) => s.name === 'ame-team' && s.builtin === true));

      await fx.mesh.handle({ method: 'POST' }, {}, new URL('http://local/api/mesh/skills'), '127.0.0.1', fakeJson, async () => JSON.stringify({ op: 'save', name: 'my-custom-skill', raw: '# Custom Skill\nhello' }));
      assert.equal(httpBody.ok, true);
      assert.ok(httpBody.skills.some((s) => s.name === 'my-custom-skill' && s.builtin === false));

      await fx.mesh.handle({ method: 'POST' }, {}, new URL('http://local/api/mesh/skills'), '127.0.0.1', fakeJson, async () => JSON.stringify({ op: 'reset', name: 'my-custom-skill' }));
      assert.equal(httpBody.ok, true);
      assert.ok(!httpBody.skills.some((s) => s.name === 'my-custom-skill'));

      await fx.mesh.handle({ method: 'POST' }, {}, new URL('http://local/api/mesh/machine-profiles'), '127.0.0.1', fakeJson, async () => JSON.stringify({ machine: 'pc-a', role: '主控/轻开发', hardware: 'RTX 4060', note: '本机主力' }));
      assert.equal(httpBody.ok, true);
      assert.equal(httpBody.profile.role, '主控/轻开发');
      const viewWithProf = fx.mesh.scopedViewFor({ machine: 'pc-a' });
      const mPcA = viewWithProf.machines.find((m) => m.machine === 'pc-a');
      assert.equal(mPcA.role, '主控/轻开发');
      assert.equal(mPcA.hardware, 'RTX 4060');

      // OpenCode prompt sanitization: standalone @tokens converted to fullwidth ＠ so OpenCode TUI doesn't throw
      // "No matching files, agents, or references", while parseMentions still recognizes fullwidth ＠master
      const capturedOc = [];
      const fxOc = makePhase3Fixture({
        dispatchControl: async (_m, payload) => {
          capturedOc.push(payload);
          return { ok: true, msg: 'launched' };
        },
      });
      try {
        const spOc = await fxOc.mesh.spawnWorker({
          projectId: fxOc.projId,
          fromNodeId: fxOc.master.id,
          machine: 'pc-a',
          cwd: 'D:\\repo',
          role: 'worker',
          tool: 'opencode',
          alias: 'worker-oc',
          prompt: '完成后请通知 @master 和 @verifier',
        });
        assert.equal(spOc.ok, true);
        assert.equal(capturedOc.length, 1);
        assert.doesNotMatch(capturedOc[0].prompt, /(?:^|\s)@(?:master|verifier|节点别名)/);
        assert.ok(capturedOc[0].prompt.includes('＠master'));
        // Fullwidth ＠master in board post is also recognized
        const fwPost = await fxOc.mesh.postBoard({
          projectId: fxOc.projId,
          fromNodeId: spOc.node.id,
          text: '＠master OpenCode 完工汇报',
        });
        assert.equal(fwPost.ok, true);
        assert.deepEqual(fwPost.entry.mentions, ['master']);

        // Spaced master alias ("Ametyping Embedding Integration Plan") is matched both via @master (task unlock) and full alias
        fxOc.mesh.upsertNode(fxOc.projId, { id: fxOc.master.id, alias: 'Ametyping Embedding Integration Plan' });
        const spacedPost = await fxOc.mesh.postBoard({
          projectId: fxOc.projId,
          fromNodeId: spOc.node.id,
          text: '@Ametyping Embedding Integration Plan 请检视',
        });
        assert.equal(spacedPost.ok, true);
        assert.ok(spacedPost.deliveries.some((d) => d.nodeId === fxOc.master.id));

        // Infer tool from sessionId prefix (agy:* -> 'agy', not 'claude')
        const agyAuto = fxOc.mesh.upsertNode(fxOc.projId, { machine: 'pc-a', sessionId: 'agy:sess-999', role: 'master' });
        assert.equal(agyAuto.ok, true);
        assert.equal(agyAuto.node.tool, 'agy');
        assert.equal(agyAuto.node.alias, 'master');

        // mesh_review lifecycle: approve -> archive (excluded from @all wakeups while keeping topology trace)
        const revReplies = [];
        const mockWsRev = { send: (raw) => revReplies.push(JSON.parse(raw)) };
        await fxOc.mesh.fromAgentRpc('pc-a', {
          t: 'mesh-req',
          rid: 'r-rev-1',
          op: 'review',
          projectId: fxOc.projId,
          nodeId: spOc.node.id,
          action: 'approve',
        }, mockWsRev);
        assert.equal(revReplies[0].ok, true);
        assert.equal(revReplies[0].node.reviewStatus, 'done');

        await fxOc.mesh.fromAgentRpc('pc-a', {
          t: 'mesh-req',
          rid: 'r-rev-2',
          op: 'review',
          projectId: fxOc.projId,
          nodeId: spOc.node.id,
          action: 'archive',
        }, mockWsRev);
        assert.equal(revReplies[1].ok, true);
        assert.equal(revReplies[1].node.archived, true);

        // Task write RPC returns ultra-compact { ok, projectId, task } without full project/tasks
        await fxOc.mesh.fromAgentRpc('pc-a', {
          t: 'mesh-req',
          rid: 'r-task-1',
          op: 'task',
          action: 'add',
          projectId: fxOc.projId,
          title: '精简载荷测试任务',
        }, mockWsRev);
        assert.equal(revReplies[2].ok, true);
        assert.ok(revReplies[2].task);
        assert.equal(revReplies[2].project, undefined);
        assert.equal(revReplies[2].tasks, undefined);

        // Per-project Claude Code cap (default 2): 2 active claude nodes -> pool skips claude to agy, explicit claude blocked
        fxOc.mesh.upsertNode(fxOc.projId, { machine: 'pc-a', sessionId: 'c-1', role: 'worker', tool: 'claude', alias: 'cc-1' });
        fxOc.mesh.upsertNode(fxOc.projId, { machine: 'pc-a', sessionId: 'c-2', role: 'worker', tool: 'claude', alias: 'cc-2' });
        const explicitBlocked = await fxOc.mesh.spawnWorker({
          projectId: fxOc.projId,
          fromNodeId: fxOc.master.id,
          machine: 'pc-a',
          cwd: 'D:\\repo',
          role: 'worker',
          tool: 'claude',
          alias: 'cc-3',
          prompt: 'should be blocked',
        });
        assert.equal(explicitBlocked.ok, false);
        assert.match(explicitBlocked.msg, /上限/);
        const poolDiverted = await fxOc.mesh.spawnWorker({
          projectId: fxOc.projId,
          fromNodeId: fxOc.master.id,
          machine: 'pc-a',
          cwd: 'D:\\repo',
          role: 'worker',
          pool: 'fast-coder',
          alias: 'diverted-w',
          prompt: 'should pick agy instead of claude',
        });
        assert.equal(poolDiverted.ok, true);
        assert.notEqual(poolDiverted.node.tool, 'claude');

        // CLI update signal: record -> GET /api/mesh/cli-updates -> POST clear
        fxOc.mesh.onCliUpdate('pc-a', { tool: 'codex', detail: 'Update available 0.1.0 -> 0.2.0', at: 123456 });
        let cuBody = null;
        await fxOc.mesh.handle({ method: 'GET' }, {}, new URL('http://local/api/mesh/cli-updates'), '127.0.0.1', (_r, _c, b) => { cuBody = b; }, async () => '{}');
        assert.equal(cuBody.ok, true);
        assert.equal(cuBody.updates.length, 1);
        assert.equal(cuBody.updates[0].machine, 'pc-a');
        assert.equal(cuBody.updates[0].tool, 'codex');
        await fxOc.mesh.handle({ method: 'POST' }, {}, new URL('http://local/api/mesh/cli-updates'), '127.0.0.1', (_r, _c, b) => { cuBody = b; }, async () => JSON.stringify({ machine: 'pc-a', tool: 'codex' }));
        assert.equal(cuBody.ok, true);
        assert.equal(cuBody.updates.length, 0);

        // Agent RPC queue submit for providerType="sugon" omits caller machine so gateway resolves cleanly
        const sugonSockSent = [];
        fxOc.machines.set('vbuntu', {
          name: 'vbuntu',
          online: true,
          control: true,
          sockets: new Set([{
            readyState: 1,
            remoteControlAllowed: true,
            send(raw) { sugonSockSent.push(JSON.parse(raw)); },
          }]),
          sessions: new Map(),
        });
        fxOc.mesh.onSugonStatus('vbuntu', { available: true, defaultPartition: 'kshdnormal' });
        await fxOc.mesh.fromAgentRpc('pc-a', {
          t: 'mesh-req',
          rid: 'r-sugon-sub',
          op: 'queue',
          action: 'submit',
          providerType: 'sugon',
          resource: 'cpu',
          command: 'srun ./cem_solver',
        }, mockWsRev);
        const subReply = revReplies.find((x) => x.rid === 'r-sugon-sub');
        assert.equal(subReply.ok, true);
        assert.equal(sugonSockSent.length, 1);
        assert.equal(sugonSockSent[0].t, 'sugon-exec');
        assert.equal(subReply.job.machine, 'vbuntu');
      } finally {
        fxOc.cleanup();
      }
    } finally {
      fx.cleanup();
    }
  });

  it('reviewNode(reject) wakes target worker via master/system sender without self-suppression, and resolveCaller/pendingSpawns backfill sessionId cleanly', async () => {
    const fx = makePhase3Fixture();
    try {
      // 1a. Reject via Agent RPC (where d.nodeId is the target worker and d.fromNodeId is omitted)
      //     must post as master (NOT target worker) and actually wake worker-1!
      fx.dispatched.length = 0;
      const rpcReplies = [];
      const mockWs = { send: (raw) => rpcReplies.push(JSON.parse(raw)) };
      await fx.mesh.fromAgentRpc('pc-a', {
        t: 'mesh-req',
        rid: 'r-reject-1',
        op: 'review',
        projectId: fx.projId,
        nodeId: fx.worker1.id,
        action: 'reject',
        note: '边界单测漏跑，请补跑后重新交卷',
      }, mockWs);
      assert.equal(rpcReplies.length, 1);
      assert.equal(rpcReplies[0].ok, true);
      assert.equal(rpcReplies[0].action, 'reject');
      assert.equal(rpcReplies[0].node.reviewStatus, 'running');
      assert.ok(rpcReplies[0].boardSeq > 0);
      assert.ok(Array.isArray(rpcReplies[0].deliveries) && rpcReplies[0].deliveries.some((d) => d.nodeId === fx.worker1.id && d.delivered === true));
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'claude:worker-1');
      assert.match(fx.dispatched[0].payload.text, /\[打回返工\] 边界单测漏跑/);

      const boardAfter1 = fx.mesh.readBoard({ projectId: fx.projId, seqList: [rpcReplies[0].boardSeq] });
      assert.equal(boardAfter1.entries[0].nodeId, fx.master.id, 'Reject post should use master nodeId');
      assert.ok(boardAfter1.entries[0].targets.includes(fx.worker1.id), 'Target worker must be in board targets');

      // 1b. Reject in a masterless project (even if caller mistakenly passed fromNodeId === target.id)
      //     falls back to null/system sender and still wakes the target node!
      const noMasterProj = fx.mesh.saveProject({ name: '无Master评审唤醒测试' }).project;
      const loneWorker = fx.mesh.upsertNode(noMasterProj.id, {
        machine: 'pc-a',
        sessionId: 'codex:worker-2',
        alias: 'lone-worker',
        role: 'worker',
        tool: 'codex',
        reviewStatus: 'waiting_review',
      }).node;
      fx.dispatched.length = 0;
      const rejNoMaster = await fx.mesh.reviewNode({
        projectId: noMasterProj.id,
        nodeId: loneWorker.id,
        fromNodeId: loneWorker.id, // simulates accidental caller=target collision
        fromMachine: 'pc-a',
        action: 'reject',
        note: '无主控项目打回唤醒验证',
      });
      assert.equal(rejNoMaster.ok, true);
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'codex:worker-2');
      const boardAfter2 = fx.mesh.readBoard({ projectId: noMasterProj.id, seqList: [rejNoMaster.boardSeq] });
      assert.equal(boardAfter2.entries[0].nodeId, null);
      assert.ok(boardAfter2.entries[0].targets.includes(loneWorker.id));

      // 2a. resolveCaller auto-backfills empty node.sessionId on mesh_task / mesh_board_post / mesh_report
      fx.mesh.saveProject({ id: fx.projId, workspaces: [{ machine: 'pc-a', path: 'D:\\repo', mode: 'rw' }] });
      fx.machines.get('pc-a').sessions.set('codex:auto-t1', { id: 'codex:auto-t1', label: 'Auto T1', state: 'idle', lines: [], perms: [] });
      fx.machines.get('pc-a').sessions.set('agy:auto-b1', { id: 'agy:auto-b1', label: 'Auto B1', state: 'idle', lines: [], perms: [] });
      fx.machines.get('pc-a').sessions.set('kiro:auto-r1', { id: 'kiro:auto-r1', label: 'Auto R1', state: 'idle', lines: [], perms: [] });

      const spTask = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo\\sub1',
        tool: 'codex',
        alias: 'w-task-bind',
        goal: '测试 mesh_task 回填 sessionId',
      });
      assert.equal(spTask.node.sessionId, '');
      await fx.mesh.manageTask({
        projectId: fx.projId,
        fromNodeId: spTask.node.id,
        fromMachine: 'pc-a',
        fromSessionId: 'codex:auto-t1',
        action: 'list',
      });
      assert.equal(spTask.node.sessionId, 'codex:auto-t1');
      assert.ok(fx.marks.get().sessions['pc-a|codex:auto-t1'], 'Auto-bound session should sync into session-marks group');

      const spBoard = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo\\sub2',
        tool: 'agy',
        alias: 'w-board-bind',
        goal: '测试 mesh_board_post 回填 sessionId',
      });
      assert.equal(spBoard.node.sessionId, '');
      await fx.mesh.postBoard({
        projectId: fx.projId,
        nodeId: spBoard.node.id,
        machine: 'pc-a',
        sessionId: 'agy:auto-b1',
        text: '阶段进展同步',
      });
      assert.equal(spBoard.node.sessionId, 'agy:auto-b1');

      const spRep = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo\\sub3',
        tool: 'kiro',
        alias: 'w-rep-bind',
        goal: '测试 mesh_report 回填 sessionId',
      });
      assert.equal(spRep.node.sessionId, '');
      // Bogus sessionId equal to nodeId or duplicate sessionId must NOT bind
      await fx.mesh.manageTask({
        projectId: fx.projId,
        nodeId: spRep.node.id,
        machine: 'pc-a',
        sessionId: spRep.node.id,
        action: 'list',
      });
      assert.equal(spRep.node.sessionId, '');
      await fx.mesh.manageTask({
        projectId: fx.projId,
        nodeId: spRep.node.id,
        machine: 'pc-a',
        sessionId: 'agy:auto-b1', // already used on pc-a by spBoard
        action: 'list',
      });
      assert.equal(spRep.node.sessionId, '');
      // Valid sessionId via reportResult binds cleanly
      await fx.mesh.reportResult({
        projectId: fx.projId,
        nodeId: spRep.node.id,
        machine: 'pc-a',
        sessionId: 'kiro:auto-r1',
        summary: '完成验证',
      });
      assert.equal(spRep.node.sessionId, 'kiro:auto-r1');

      // 2b. onSessionMeta & onMachineState normalize Windows forward/back slashes and verbatim \\?\ prefixes
      const spSlash1 = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\repo\\.ame-worktrees\\slash-test-1',
        tool: 'codex',
        alias: 'w-slash-1',
        goal: '测试正反斜杠归一化',
      });
      assert.equal(spSlash1.node.sessionId, '');
      fx.mesh.onSessionMeta('pc-a', 'codex:slash-s1', 'd:/repo/.ame-worktrees/slash-test-1/');
      assert.equal(spSlash1.node.sessionId, 'codex:slash-s1');

      const spSlash2 = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:/repo/.ame-worktrees/slash-test-2/',
        tool: 'codex',
        alias: 'w-slash-2',
        goal: '测试 Rust verbatim 路径归一化',
      });
      assert.equal(spSlash2.node.sessionId, '');
      fx.machines.get('pc-a').sessions.set('codex:slash-s2', {
        id: 'codex:slash-s2',
        label: 'Slash S2',
        state: 'idle',
        cwd: '\\\\?\\D:\\repo\\.ame-worktrees\\slash-test-2',
        lines: [],
        perms: [],
      });
      fx.mesh.onMachineState('pc-a', [...fx.machines.get('pc-a').sessions.values()]);
      assert.equal(spSlash2.node.sessionId, 'codex:slash-s2');
    } finally {
      fx.cleanup();
    }
  });
});
