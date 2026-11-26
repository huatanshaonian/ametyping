'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { judgeL3Stall, ruleBasedJudge } = require('../server/mesh-auto-judge');
const { createWatchdog } = require('../server/mesh-watchdog');

describe('L3 Auto-Mode Independent Judge (mesh-auto-judge)', () => {
  it('enforces hard maxAutoJudge cap before calling any LLM', async () => {
    let llmCalled = false;
    const res = await judgeL3Stall({
      project: { id: 'p1', name: 'CEM 优化', tasks: [{ id: 't1', title: 'Phase 2', status: 'todo' }] },
      autoJudgeCount: 5,
      maxAutoJudge: 5,
      googleAiKey: { get: () => 'AIzaSyFakeKey123456789012345', models: () => [{ model: 'gemini-2.5-flash' }] },
      runGoogleAiFn: async () => { llmCalled = true; return { verdict: 'CONTINUE', reason: 'x', followupPrompt: 'go' }; },
    });
    assert.equal(res.verdict, 'ESCALATE');
    assert.equal(res.provider, 'hard-cap');
    assert.equal(llmCalled, false);
  });

  it('uses Google AI Studio first and handles CONTINUE, DONE, and ESCALATE verdicts', async () => {
    let magpieCalled = false;
    const baseOpts = {
      project: { id: 'p1', name: 'CEM 优化', tasks: [{ id: 't1', title: '扫频验证', status: 'todo' }] },
      masterLastOutput: 'Phase 1 已通过单测，请问是否继续 Phase 2？',
      autoJudgeCount: 1,
      maxAutoJudge: 5,
      googleAiKey: { get: () => 'AIzaSyFakeKey123456789012345', models: () => [{ model: 'gemini-2.5-flash' }] },
      magpie: { status: () => ({ enabled: true, models: [{ id: 'claude-sonnet' }] }), run: async () => { magpieCalled = true; return {}; } },
    };

    const cont = await judgeL3Stall({
      ...baseOpts,
      runGoogleAiFn: async ({ model }) => {
        assert.equal(model, 'gemini-2.5-flash');
        return { verdict: 'CONTINUE', reason: 'Phase 1 已绿，可继续 Phase 2', followupPrompt: '请直接开始 Phase 2 扫频验证。' };
      },
    });
    assert.equal(cont.verdict, 'CONTINUE');
    assert.equal(cont.provider, 'Google AI Studio');
    assert.equal(magpieCalled, false);
    assert.match(cont.followupPrompt, /Phase 2/);

    const done = await judgeL3Stall({
      ...baseOpts,
      runGoogleAiFn: async () => ({ verdict: 'DONE', reason: '全部指标达标', followupPrompt: '' }),
    });
    assert.equal(done.verdict, 'DONE');
    assert.equal(done.followupPrompt, '');

    const esc = await judgeL3Stall({
      ...baseOpts,
      runGoogleAiFn: async () => ({ verdict: 'ESCALATE', reason: '连续两次 OOM，需用户决定分区', followupPrompt: '' }),
    });
    assert.equal(esc.verdict, 'ESCALATE');
  });

  it('falls back deterministically when no LLM is configured', async () => {
    assert.equal(ruleBasedJudge({ project: { tasks: [{ id: 't1', title: 'A', status: 'blocked' }] } }).verdict, 'ESCALATE');
    assert.equal(ruleBasedJudge({ project: { tasks: [{ id: 't1', title: 'A', status: 'done' }] } }).verdict, 'DONE');
    assert.equal(ruleBasedJudge({ project: { tasks: [{ id: 't1', title: 'A', status: 'todo' }] } }).verdict, 'CONTINUE');
  });

  it('triggers onL3Idle in mesh-watchdog only for L3 projects when all nodes stay idle', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-wd-l3-'));
    let curMs = 1_000_000;
    const triggered = [];
    const projL3 = {
      id: 'p_l3',
      name: 'L3 项目',
      deliveryGate: 'L3',
      tasks: [{ id: 't1', title: 'Next step', status: 'todo' }],
      nodes: [
        { id: 'm1', role: 'master', machine: 'pc', sessionId: 's_m' },
        { id: 'w1', role: 'coder', machine: 'pc', sessionId: 's_w' },
      ],
    };
    const projL1 = {
      id: 'p_l1',
      name: 'L1 项目',
      deliveryGate: 'L1',
      tasks: [{ id: 't2', title: 'Wait user', status: 'todo' }],
      nodes: [{ id: 'm2', role: 'master', machine: 'pc', sessionId: 's_m2' }],
    };
    let workerState = 'working';
    try {
      const wd = createWatchdog({
        dataDir: tmp,
        getProjects: () => [projL3, projL1],
        getMachines: () => new Map([['pc', { online: true }]]),
        liveSessionOf: (_m, sid) => {
          if (sid === 's_w') return { online: true, state: workerState, asking: false };
          return { online: true, state: 'idle', asking: false };
        },
        now: () => curMs,
        l3IdleMs: 30e3,
        onL3Idle: async (p, m) => { triggered.push({ projectId: p.id, masterId: m.id }); p.lastAutoJudgeAt = curMs; },
      });

      // Worker still working -> must NOT trigger
      wd.tick();
      curMs += 40e3;
      wd.tick();
      assert.equal(triggered.length, 0);

      // Worker becomes idle -> starts timer, triggers after 30s (only for L3, never L1)
      workerState = 'idle';
      wd.tick();
      assert.equal(triggered.length, 0);
      curMs += 31e3;
      wd.tick();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(triggered.length, 1);
      assert.equal(triggered[0].projectId, 'p_l3');
      assert.equal(triggered[0].masterId, 'm1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
