'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRoleStore } = require('../server/mesh-roles');
const { createModelRouter } = require('../server/mesh-model-router');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');

describe('mesh-roles hot-reload role library', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-roles-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads built-in roles, supports hot override, custom roles, catalog, and reset', () => {
    const store = createRoleStore({ dataDir: tmpDir });
    const list = store.list();
    const names = list.map((r) => r.name);
    assert.deepEqual(names.slice(0, 4), ['master', 'worker', 'verifier', 'peer']);

    const verifier = store.get('verifier');
    assert.equal(verifier.readOnly, true);
    assert.equal(verifier.defaultPool, 'flagship');
    assert.equal(verifier.builtin, true);
    assert.equal(verifier.overridden, false);

    // Save user override for worker
    const overrideRes = store.save('worker', [
      '---',
      'name: worker',
      'summary: 自定义执行者摘要',
      'defaultPool: heavy-reasoner',
      'workspaceMode: worktree',
      'readOnly: false',
      '---',
      '自定义执行规范正文',
    ].join('\n'));
    assert.equal(overrideRes.ok, true);
    assert.equal(overrideRes.role.overridden, true);
    assert.equal(overrideRes.role.defaultPool, 'heavy-reasoner');
    assert.equal(overrideRes.role.workspaceMode, 'worktree');
    assert.match(overrideRes.role.body, /自定义执行规范正文/);

    // External hot-reload: drop a new custom role file directly on disk
    const customDir = path.join(tmpDir, 'mesh-roles');
    fs.writeFileSync(path.join(customDir, 'solver-runner.md'), [
      '---',
      'name: solver-runner',
      'summary: CEM 电磁仿真运行员',
      'defaultPool: fast-coder',
      'workspaceMode: inherit',
      'readOnly: false',
      '---',
      '专职监控 FEKO/MoM 求解作业。',
    ].join('\n'), 'utf8');

    const solverRole = store.get('solver-runner');
    assert.ok(solverRole);
    assert.equal(solverRole.builtin, false);
    assert.equal(solverRole.overridden, false);
    assert.equal(solverRole.summary, 'CEM 电磁仿真运行员');

    const cat = store.catalog();
    assert.ok(cat.some((line) => line.startsWith('solver-runner') && line.includes('CEM 电磁仿真运行员')));

    // Reset worker override -> restores builtin template
    const resetRes = store.reset('worker');
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.role.overridden, false);
    assert.equal(resetRes.role.defaultPool, 'fast-coder');

    // Invalid name rejected
    const badSave = store.save('../evil', '---');
    assert.equal(badSave.ok, false);
  });
});

describe('mesh-model-router', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-router-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('integrates Magpie live quota, skips exhausted provider, and selects healthy fallback', () => {
    let curTime = 1000000;
    let magpieAccounts = [
      {
        provider: 'anthropic',
        name: 'Claude Pro',
        status: 'ok',
        windows: [{ name: '5h', remaining: 0, limit: 100, display: '0%', resetsAt: '2026-11-23T12:00:00Z' }],
      },
      {
        provider: 'openai',
        name: 'OpenAI Plus',
        status: 'ok',
        windows: [{ name: 'daily', remaining: 82, limit: 100, display: '82%' }],
      },
    ];

    const router = createModelRouter({
      dataDir: tmpDir,
      getMagpie: () => ({ status: () => ({ accounts: magpieAccounts }) }),
      now: () => curTime,
    });

    // In fast-coder: agy:gemini-4-hydrogen-medium is #1 and healthy; claude:sonnet (anthropic) is exhausted
    const pick1 = router.selectCandidate('fast-coder');
    assert.equal(pick1.ok, true);
    assert.equal(pick1.candidate.harness, 'agy');
    assert.equal(pick1.candidate.model, 'gemini-4-hydrogen-medium');

    const status1 = router.getPoolsStatus();
    assert.equal(status1['fast-coder'][0].status, 'healthy');
    assert.equal(status1['fast-coder'][1].magpieInfo, '82%');
    assert.equal(status1['fast-coder'][3].status, 'exhausted');

    // Cooldown agy models and codex -> falls back to opencode:gpt-6.2-sol
    router.markCooldown('agy', 'gemini-4-hydrogen-medium', '429 rate limit', curTime + 60e3);
    router.markCooldown('codex', 'gpt-6.2-terra', '429 rate limit', curTime + 60e3);
    router.markCooldown('agy', 'claude-sonnet-5-5-medium', '429 rate limit', curTime + 60e3);
    const pick2 = router.selectCandidate('fast-coder');
    assert.equal(pick2.ok, true);
    assert.equal(pick2.candidate.harness, 'opencode');
    assert.equal(pick2.candidate.model, 'gpt-6.2-sol');

    // Advance past cooldown -> agy Gemini becomes healthy again
    curTime += 61e3;
    const pick3 = router.selectCandidate('fast-coder');
    assert.equal(pick3.ok, true);
    assert.equal(pick3.candidate.harness, 'agy');
    assert.equal(pick3.candidate.model, 'gemini-4-hydrogen-medium');

    // Error status on all matching Magpie accounts also marks exhausted
    magpieAccounts = [
      { provider: 'anthropic', name: 'Claude 1', status: 'error', windows: [] },
    ];
    const statusErr = router.getPoolsStatus();
    assert.equal(statusErr['fast-coder'][3].status, 'exhausted');
  });
});

describe('mesh Swarm Phase 2 integration (roles + model pool fallback + HTTP API)', () => {
  it('injects external role rules, auto-fallbacks on spawn failure, alerts on pool exhaustion, and serves roles/pools HTTP API', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-mesh-p2-'));
    try {
      const launchCalls = [];
      let failHarnesses = new Set(['claude']);
      let magpiePolled = 0;

      const machines = new Map();
      machines.set('pc-a', {
        name: 'pc-a',
        online: true,
        control: true,
        files: true,
        sessions: new Map([
          ['agy:master-1', { id: 'agy:master-1', label: 'Master', state: 'idle', lines: [], perms: [] }],
          ['codex:idle-1', { id: 'codex:idle-1', label: 'Idle Codex', state: 'idle', lines: [], perms: [] }],
        ]),
      });

      const mesh = createMesh({
        dataDir: tmp,
        machines,
        store: { sessions: () => ({}), info: () => null },
        marks: createMarks({ dataDir: tmp }),
        fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
        getMagpie: () => ({
          status: () => ({ accounts: [] }),
          poll: async () => { magpiePolled += 1; },
        }),
        dispatchControl: async (machineName, payload) => {
          launchCalls.push({ machine: machineName, payload });
          if (payload.t === 'launch' && failHarnesses.has(payload.tool)) {
            return { ok: false, msg: `429 ${payload.tool} quota exhausted` };
          }
          return { ok: true, msg: 'ok' };
        },
      });

      const projRes = mesh.saveProject({
        name: 'Phase2 联调测试',
        workspaces: [{ machine: 'pc-a', path: 'D:\\work', mode: 'rw' }],
      });
      const projId = projRes.project.id;
      const masterNode = mesh.upsertNode(projId, {
        machine: 'pc-a',
        sessionId: 'agy:master-1',
        alias: 'master',
        role: 'master',
        tool: 'agy',
      }).node;
      mesh.upsertNode(projId, {
        machine: 'pc-a',
        sessionId: 'codex:idle-1',
        alias: 'helper-codex',
        role: 'worker',
        tool: 'codex',
      });

      // 1. scopedViewFor exposes roleCatalog and pools summary for Master
      const scope = mesh.scopedViewFor({ projectId: projId, nodeId: masterNode.id });
      assert.equal(scope.ok, true);
      assert.ok(Array.isArray(scope.roleCatalog) && scope.roleCatalog.some((l) => l.startsWith('verifier')));
      assert.ok(Array.isArray(scope.pools) && scope.pools.some((p) => p.name === 'flagship'));

      // 2. Spawn verifier (defaults to flagship pool; claude fails -> spreads away from busy agy/codex to idle opencode)
      const spRes = await mesh.spawnWorker({
        projectId: projId,
        fromNodeId: masterNode.id,
        machine: 'pc-a',
        cwd: 'D:\\work\\verify',
        alias: 'verifier-1',
        role: 'verifier',
        goal: '验收黑板实现',
      });
      assert.equal(spRes.ok, true);
      assert.equal(spRes.node.role, 'verifier');
      assert.equal(spRes.node.pool, 'flagship');
      assert.equal(spRes.node.tool, 'opencode');
      assert.equal(spRes.node.model, 'gpt-6.2-astra');

      const launchAttemptTools = launchCalls.filter((c) => c.payload.t === 'launch').map((c) => c.payload.tool);
      assert.deepEqual(launchAttemptTools, ['claude', 'opencode']);
      const agyLaunch = launchCalls[1].payload;
      assert.match(agyLaunch.prompt, /只读硬约束|NEVER modify business code/);
      assert.match(agyLaunch.prompt, /readOnly=true/);

      // Claude should now be in cooldown inside flagship pool
      const poolsBefore = mesh.modelRouter.getPoolsStatus();
      assert.equal(poolsBefore.flagship.find((c) => c.harness === 'claude').status, 'cooldown');

      // 3. Exhaust entire pool -> returns { ok: false, exhausted: true } and posts watchdog alert on board
      failHarnesses = new Set(['claude', 'codex', 'agy', 'opencode']);
      const exRes = await mesh.spawnWorker({
        projectId: projId,
        fromNodeId: masterNode.id,
        machine: 'pc-a',
        cwd: 'D:\\work\\fail',
        alias: 'worker-fail',
        role: 'worker',
        pool: 'fast-coder',
        goal: '必败测试',
      });
      assert.equal(exRes.ok, false);
      assert.equal(exRes.exhausted, true);

      const boardAfter = mesh.readBoard({ projectId: projId, since: 0 });
      assert.ok(boardAfter.entries.some((e) => e.kind === 'watchdog' && e.text.includes('模型池耗尽')));

      // 4. HTTP API routes for /api/mesh/roles and /api/mesh/pools
      const responses = [];
      const jsonFn = (res, code, body) => responses.push({ code, body });

      await mesh.handle({ method: 'GET' }, {}, new URL('http://localhost/api/mesh/roles'), '127.0.0.1', jsonFn, async () => '{}', () => true);
      assert.equal(responses[0].body.ok, true);
      assert.equal(responses[0].body.roles.length, 4);

      await mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/roles'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ name: 'plot-analyst', raw: '---\nname: plot-analyst\nsummary: 绘图分析\ndefaultPool: fast-coder\n---\n生成高精度图表。' }),
        () => true
      );
      assert.equal(responses[1].body.ok, true);
      assert.equal(responses[1].body.role.name, 'plot-analyst');

      await mesh.handle({ method: 'GET' }, {}, new URL('http://localhost/api/mesh/pools'), '127.0.0.1', jsonFn, async () => '{}', () => true);
      assert.equal(responses[2].body.ok, true);
      assert.equal(responses[2].body.pools.flagship.find((c) => c.harness === 'claude').status, 'cooldown');

      await mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/pools'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ op: 'reset-cooldown', harness: 'claude', model: 'opus' }),
        () => true
      );
      assert.equal(responses[3].body.ok, true);
      assert.equal(responses[3].body.pools.flagship.find((c) => c.harness === 'claude').status, 'healthy');

      await mesh.handle(
        { method: 'POST' },
        {},
        new URL('http://localhost/api/mesh/pools'),
        '127.0.0.1',
        jsonFn,
        async () => JSON.stringify({ op: 'probe', harness: 'codex' }),
        () => true
      );
      assert.equal(responses[4].body.ok, true);
      assert.equal(responses[4].body.probed, true);
      assert.equal(magpiePolled, 1);
      assert.ok(launchCalls.some((c) => c.payload.t === 'send' && c.payload.id === 'codex:idle-1' && c.payload.text === '/usage'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('deprioritizes <10% low-quota candidates, spreads concurrency across harnesses, and filters by installed harnesses', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-router-spread-'));
    try {
      const mockMagpie = {
        status: () => ({
          accounts: [
            { provider: 'anthropic', status: 'ok', windows: [{ remaining: 5, limit: 100, display: '5/100' }] },
            { provider: 'openai', status: 'ok', windows: [{ remaining: 80, limit: 100, display: '80/100' }] },
          ],
        }),
      };
      const router = createModelRouter({ dataDir: tmp, getMagpie: () => mockMagpie });

      const pick1 = router.selectCandidate('fast-coder');
      assert.equal(pick1.ok, true);
      assert.equal(pick1.candidate.harness, 'agy');

      const pick2 = router.selectCandidate('fast-coder', {
        activeCounts: { byHarness: { agy: 1 }, byCandidate: { 'agy|gemini-4-hydrogen-medium': 1 } },
      });
      assert.equal(pick2.ok, true);
      assert.equal(pick2.candidate.harness, 'codex');

      const pick3 = router.selectCandidate('fast-coder', { availableHarnesses: ['claude'] });
      assert.equal(pick3.ok, true);
      assert.equal(pick3.candidate.harness, 'claude');
      assert.equal(pick3.candidate.status, 'low_quota');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
