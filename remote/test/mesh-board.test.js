'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createBoard,
  parseMentions,
  parseRefs,
  formatWakePrompt,
  checkBoundaries,
} = require('../server/mesh-board');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-board-'));
  const dispatched = [];
  const machines = new Map();
  machines.set('pc-a', {
    name: 'pc-a',
    online: true,
    control: true,
    files: true,
    sessions: new Map([
      ['agy:master-1', { id: 'agy:master-1', label: 'Master', state: 'idle', lines: [], perms: [] }],
      ['claude:worker-1', { id: 'claude:worker-1', label: 'Worker 1', state: 'idle', lines: [], perms: [] }],
      ['codex:verifier-1', { id: 'codex:verifier-1', label: 'Verifier', state: 'idle', lines: [], perms: [] }],
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
    dispatchControl: async (machineName, payload) => {
      dispatched.push({ machine: machineName, payload });
      return { ok: true, msg: 'ok' };
    },
  });

  const projRes = mesh.saveProject({ name: 'Swarm Phase 1 测试项目' });
  const projId = projRes.project.id;

  const master = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'agy:master-1',
    alias: 'master',
    role: 'master',
    tool: 'agy',
  }).node;

  const worker = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'claude:worker-1',
    alias: 'worker-1',
    role: 'worker',
    tool: 'claude',
    boundaries: ['remote/server/mesh.js', 'remote/server/mesh-board.js'],
  }).node;

  const verifier = mesh.upsertNode(projId, {
    machine: 'pc-a',
    sessionId: 'codex:verifier-1',
    alias: 'verifier',
    role: 'peer',
    tool: 'codex',
  }).node;

  return {
    tmp,
    dispatched,
    machines,
    mesh,
    projId,
    master,
    worker,
    verifier,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('mesh-board helpers', () => {
  it('parseMentions extracts deduplicated tokens and handles @all case-insensitively', () => {
    const r1 = parseMentions('@worker-1 请复核，@Verifier 和 @worker-1 注意，@中文节点 也看一下');
    assert.equal(r1.mentionAll, false);
    assert.deepEqual(r1.mentions, ['worker-1', 'Verifier', '中文节点']);

    const r2 = parseMentions('@ALL @worker-1 @All 请同步查看');
    assert.equal(r2.mentionAll, true);
    assert.deepEqual(r2.mentions, ['worker-1']);
  });

  it('parseRefs extracts sorted deduplicated integer floor refs', () => {
    assert.deepEqual(parseRefs('请对照 #12、#5 和 #12 以及 #99'), [5, 12, 99]);
    assert.deepEqual(parseRefs('无引用文本'), []);
  });

  it('checkBoundaries validates exact file, directory prefix, wildcard, and Windows paths', () => {
    const bounds = [
      'remote/server/mesh.js',
      'remote/public/js',
      'remote/test/*.test.js',
      'D:\\proj\\docs\\readme.md',
    ];
    const okRes = checkBoundaries(bounds, [
      './remote/server/mesh.js',
      'remote\\public\\js\\apps\\projects.js',
      'remote/test/mesh-board.test.js',
      'd:/proj/docs/README.md',
    ]);
    assert.equal(okRes.checked, true);
    assert.deepEqual(okRes.outOfBounds, []);

    const badRes = checkBoundaries(bounds, [
      'remote/server/mesh.js',
      'tools/ame-mesh.js',
      'remote/test/sub/nested.test.js',
    ]);
    assert.equal(badRes.checked, true);
    assert.deepEqual(badRes.outOfBounds, ['tools/ame-mesh.js', 'remote/test/sub/nested.test.js']);

    assert.deepEqual(checkBoundaries([], ['anything.js']), { checked: true, outOfBounds: [] });
  });

  it('formatWakePrompt switches between full text (<500) and doorbell (>=500)', () => {
    const project = { name: '电磁求解' };
    const shortEntry = {
      seq: 3,
      agent: 'worker-1',
      text: '已完成对比，误差 < 0.2dB',
      artifacts: ['out/rcs.png'],
    };
    const shortPrompt = formatWakePrompt({ project, entry: shortEntry });
    assert.match(shortPrompt, /\[AmeMesh 黑板通知 #3 \| 项目：电磁求解 \| 来自：worker-1\]/);
    assert.ok(shortPrompt.includes('已完成对比，误差 < 0.2dB'));
    assert.ok(shortPrompt.includes('out/rcs.png'));

    const longBody = 'A'.repeat(120) + 'B'.repeat(400); // 520 chars >= 500
    const longEntry = { seq: 12, agent: 'verifier', text: longBody };
    const longPrompt = formatWakePrompt({ project, entry: longEntry });
    assert.match(longPrompt, /\[AmeMesh 黑板通知 #12 \| 项目：电磁求解 \| 来自：verifier\]/);
    assert.ok(longPrompt.includes('A'.repeat(120)));
    assert.ok(!longPrompt.includes('B'.repeat(50)), 'Long body should not be injected in full');
    assert.ok(longPrompt.includes('正文共 520 字'));
    assert.ok(longPrompt.includes('mesh_board_read(since=11)'));
  });

  it('createBoard persists JSONL monotonically across re-instantiation and supports read filters', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-board-store-'));
    try {
      const b1 = createBoard({ dataDir: tmp });
      const e1 = b1.append('proj_1', { agent: 'master', text: '启动 #1', channel: 'main' });
      const e2 = b1.append('proj_1', { agent: 'worker', text: '@verifier 看 #1', channel: 'dev' });
      const e3 = b1.append('proj_1', { agent: 'verifier', text: '收到 #2', channel: 'main' });
      assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
      assert.deepEqual(e3.refs, [2]);

      // Reload from disk in a fresh board instance
      const b2 = createBoard({ dataDir: tmp });
      assert.equal(b2.latestSeq('proj_1'), 3);
      const e4 = b2.append('proj_1', { agent: 'master', text: '继续' });
      assert.equal(e4.seq, 4);

      const sinceRes = b2.read('proj_1', { since: 2 });
      assert.equal(sinceRes.latestSeq, 4);
      assert.deepEqual(sinceRes.entries.map((e) => e.seq), [3, 4]);

      const chRes = b2.read('proj_1', { channel: 'dev' });
      assert.deepEqual(chRes.entries.map((e) => e.seq), [2]);

      const seqListRes = b2.read('proj_1', { seqList: [1, 3] });
      assert.deepEqual(seqListRes.entries.map((e) => e.seq), [1, 3]);

      b2.removeProject('proj_1');
      assert.equal(b2.latestSeq('proj_1'), 0);
      assert.deepEqual(b2.read('proj_1').entries, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('mesh Swarm Phase 1 integration', () => {
  it('postBoard routes @mentions, updates lastPostSeq/lastMentionedSeq, and readBoard advances lastReadSeq', async () => {
    const fx = makeFixture();
    try {
      // Admin post without fromNode
      const adminPost = await fx.mesh.postBoard({
        projectId: fx.projId,
        agent: '管理员',
        text: '@worker-1 请开始实现',
      });
      assert.equal(adminPost.ok, true);
      assert.equal(adminPost.entry.seq, 1);
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'claude:worker-1');
      assert.match(fx.dispatched[0].payload.text, /#1/);

      // Worker reads board -> advances lastReadSeq
      const readRes = fx.mesh.readBoard({
        projectId: fx.projId,
        nodeId: fx.worker.id,
        since: 0,
      });
      assert.equal(readRes.ok, true);
      assert.equal(readRes.entries.length, 1);
      assert.equal(readRes.lastReadSeq, 1);

      // Worker posts @verifier
      const wPost = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.worker.id,
        text: '@verifier 请复核 #1',
      });
      assert.equal(wPost.ok, true);
      assert.equal(wPost.entry.seq, 2);
      assert.equal(fx.worker.lastPostSeq, 2);
      assert.equal(fx.worker.lastReadSeq, 2);
      assert.equal(fx.verifier.lastMentionedSeq, 2);
      assert.equal(fx.dispatched.length, 2);
      assert.equal(fx.dispatched[1].payload.id, 'codex:verifier-1');
    } finally {
      fx.cleanup();
    }
  });

  it('manageTask blockedBy auto-unlocks downstream task, posts kind:task, and wakes owner', async () => {
    const fx = makeFixture();
    try {
      const t1 = await fx.mesh.manageTask({
        projectId: fx.projId,
        action: 'add',
        title: '完成底层模块',
        ownerNodeId: fx.worker.id,
      });
      assert.equal(t1.ok, true);

      const t2 = await fx.mesh.manageTask({
        projectId: fx.projId,
        action: 'add',
        title: '验收与回归测试',
        ownerNodeId: fx.verifier.id,
        blockedBy: [t1.task.id],
      });
      assert.equal(t2.ok, true);

      // Cannot claim while blocker is unfinished
      const badClaim = await fx.mesh.manageTask({
        projectId: fx.projId,
        action: 'claim',
        taskId: t2.task.id,
        fromNodeId: fx.verifier.id,
      });
      assert.equal(badClaim.ok, false);

      // Mark t1 done -> t2 auto-unlocks and notifies verifier on board
      const doneRes = await fx.mesh.manageTask({
        projectId: fx.projId,
        action: 'update',
        taskId: t1.task.id,
        status: 'done',
      });
      assert.equal(doneRes.ok, true);
      assert.equal(doneRes.unlockedTasks.length, 1);
      assert.equal(doneRes.unlockedTasks[0].id, t2.task.id);

      const boardRes = fx.mesh.readBoard({ projectId: fx.projId, since: 0 });
      assert.equal(boardRes.entries.length, 1);
      assert.equal(boardRes.entries[0].kind, 'task');
      assert.match(boardRes.entries[0].text, /已自动解锁/);
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'codex:verifier-1');
    } finally {
      fx.cleanup();
    }
  });

  it('gitAudit detects out-of-bounds and empty-change in reportResult and postBoard(done:true)', async () => {
    const fx = makeFixture();
    try {
      // 1. Out-of-bounds via reportResult
      const repOob = await fx.mesh.reportResult({
        projectId: fx.projId,
        fromNodeId: fx.worker.id,
        summary: '已完成修改',
        gitAudit: {
          checked: true,
          isGit: true,
          changedFiles: ['remote/server/mesh.js', 'tools/ame-mesh.js'],
        },
      });
      assert.equal(repOob.ok, true);
      assert.equal(repOob.audit.ok, false);
      assert.deepEqual(repOob.audit.outOfBounds, ['tools/ame-mesh.js']);
      assert.match(repOob.entry.text, /\[边界对账告警\] 改动了允许边界之外的文件：tools\/ame-mesh\.js/);
      assert.match(fx.dispatched[0].payload.text, /\[边界对账告警\]/);

      // 2. Empty-change via postBoard(done: true)
      const postEmpty = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.worker.id,
        text: '@master 全部完工 [done]',
        done: true,
        gitAudit: {
          checked: true,
          isGit: true,
          changedFiles: [],
        },
      });
      assert.equal(postEmpty.ok, true);
      assert.equal(postEmpty.entry.audit.emptyChange, true);
      assert.match(postEmpty.entry.text, /\[边界对账告警\] 声明完成但工作区 git status 未检测到任何文件改动/);

      // 3. Valid in-bounds change passes cleanly
      const postOk = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.worker.id,
        text: '@master 仅改边界内文件 [done]',
        done: true,
        gitAudit: {
          checked: true,
          isGit: true,
          changedFiles: ['remote/server/mesh-board.js'],
        },
      });
      assert.equal(postOk.ok, true);
      assert.equal(postOk.entry.audit.ok, true);
      assert.doesNotMatch(postOk.entry.text, /边界对账告警/);
    } finally {
      fx.cleanup();
    }
  });

  it('onMachineState performs race-free unread mention push when busy node transitions to idle', async () => {
    const fx = makeFixture();
    try {
      // Mark worker-1 as working
      fx.machines.get('pc-a').sessions.get('claude:worker-1').state = 'working';

      // Post with skipWake=true (simulates race where mention cursor advances without immediate delivery)
      const p = await fx.mesh.postBoard({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        text: '@worker-1 竞态补推测试消息',
        skipWake: true,
      });
      assert.equal(p.ok, true);
      assert.equal(fx.worker.lastMentionedSeq, 1);
      assert.equal(fx.worker.lastReadSeq, 0);
      assert.equal(fx.dispatched.length, 0);

      // Worker transitions to idle -> onMachineState pushes unread mention once
      fx.machines.get('pc-a').sessions.get('claude:worker-1').state = 'idle';
      fx.mesh.onMachineState('pc-a', [...fx.machines.get('pc-a').sessions.values()]);
      assert.equal(fx.dispatched.length, 1);
      assert.equal(fx.dispatched[0].payload.id, 'claude:worker-1');
      assert.match(fx.dispatched[0].payload.text, /竞态补推测试消息/);
      assert.equal(fx.worker.lastNudgedSeq, 1);

      // Subsequent idle tick does NOT double-push
      fx.mesh.onMachineState('pc-a', [...fx.machines.get('pc-a').sessions.values()]);
      assert.equal(fx.dispatched.length, 1);
    } finally {
      fx.cleanup();
    }
  });

  it('spawnWorker persists structured contract, writes brief entry, and skips older board noise', async () => {
    const fx = makeFixture();
    try {
      await fx.mesh.postBoard({
        projectId: fx.projId,
        agent: '管理员',
        text: '历史噪声楼层',
        skipWake: true,
      });

      const sp = await fx.mesh.spawnWorker({
        projectId: fx.projId,
        fromNodeId: fx.master.id,
        machine: 'pc-a',
        cwd: 'D:\\work\\sub',
        alias: 'worker-2',
        goal: '实现黑板接口',
        boundaries: ['remote/server/mesh-board.js'],
        doneWhen: ['单测全绿', '不越界修改'],
        checks: ['node --test remote/test/mesh-board.test.js'],
      });
      assert.equal(sp.ok, true);
      assert.deepEqual(sp.node.boundaries, ['remote/server/mesh-board.js']);
      assert.deepEqual(sp.node.doneWhen, ['单测全绿', '不越界修改']);
      assert.deepEqual(sp.node.checks, ['node --test remote/test/mesh-board.test.js']);
      assert.equal(sp.node.lastReadSeq, 2); // skipped #1, starts at brief #2

      const launchPayload = fx.dispatched[0].payload;
      assert.match(launchPayload.prompt, /允许修改边界/);
      assert.match(launchPayload.prompt, /验收条件/);
      assert.match(launchPayload.prompt, /必跑验证命令/);

      const b = fx.mesh.readBoard({ projectId: fx.projId, since: 0 });
      assert.equal(b.entries.length, 2);
      assert.equal(b.entries[1].kind, 'brief');
    } finally {
      fx.cleanup();
    }
  });

  it('supports fromAgentRpc and HTTP endpoints for board and task operations', async () => {
    const fx = makeFixture();
    try {
      // RPC calls
      const rpcReplies = [];
      const fakeWs = { send: (raw) => rpcReplies.push(JSON.parse(raw)) };

      await fx.mesh.fromAgentRpc('pc-a', {
        t: 'mesh-req',
        rid: 'r1',
        op: 'board_post',
        projectId: fx.projId,
        nodeId: fx.master.id,
        text: '@worker-1 RPC发帖测试',
      }, fakeWs);
      assert.equal(rpcReplies[0].ok, true);
      assert.equal(rpcReplies[0].entry.seq, 1);

      await fx.mesh.fromAgentRpc('pc-a', {
        t: 'mesh-req',
        rid: 'r2',
        op: 'board_read',
        projectId: fx.projId,
        nodeId: fx.worker.id,
        since: 0,
      }, fakeWs);
      assert.equal(rpcReplies[1].ok, true);
      assert.equal(rpcReplies[1].entries.length, 1);
      assert.equal(rpcReplies[1].lastReadSeq, 1);

      await fx.mesh.fromAgentRpc('pc-a', {
        t: 'mesh-req',
        rid: 'r3',
        op: 'task',
        projectId: fx.projId,
        action: 'add',
        title: 'RPC 任务',
      }, fakeWs);
      assert.equal(rpcReplies[2].ok, true);
      assert.equal(rpcReplies[2].task.title, 'RPC 任务');

      // HTTP handle
      const responses = [];
      const jsonFn = (res, code, body) => responses.push({ code, body });
      const getBoardUrl = new URL(`http://localhost/api/mesh/board?projectId=${fx.projId}&since=0`);
      const handledGet = await fx.mesh.handle({ method: 'GET' }, {}, getBoardUrl, '127.0.0.1', jsonFn, async () => '{}', () => true);
      assert.equal(handledGet, true);
      assert.equal(responses[0].body.ok, true);
      assert.equal(responses[0].body.entries.length, 1);

      const postBoardUrl = new URL('http://localhost/api/mesh/board/post');
      const handledStepUp = await fx.mesh.handle(
        { method: 'POST' },
        {},
        postBoardUrl,
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ projectId: fx.projId, agent: '管理员', text: 'hi' }),
        () => false
      );
      assert.equal(handledStepUp, true);
      assert.equal(responses[1].body.need, 'totp');

      const handledTask = await fx.mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/task'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ projectId: fx.projId, action: 'list' }),
        () => true
      );
      assert.equal(handledTask, true);
      assert.equal(responses[2].body.ok, true);
      assert.equal(responses[2].body.tasks.length, 1);
    } finally {
      fx.cleanup();
    }
  });
});
