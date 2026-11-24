'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRateLimitsFromLines } = require('../agent/codex-quota');
const { createModelRouter } = require('../server/mesh-model-router');
const { evaluateFableAdvice } = require('../server/mesh-fable-advisor');

describe('Codex local quota + expiring-first routing + Fable advisor', () => {
  it('parses Codex transcript rate_limits (5h primary + 7d secondary) with exact resetsAt', () => {
    const sample = JSON.stringify({
      timestamp: '2026-11-24T04:23:06.277Z',
      payload: {
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'plus',
          primary: { used_percent: 6, window_minutes: 300, resets_at: 1795511817 },
          secondary: { used_percent: 8, window_minutes: 10080, resets_at: 1795570978 },
        },
      },
    });
    const q = parseRateLimitsFromLines('{"noise":1}\n' + sample);
    assert.ok(q);
    assert.equal(q.provider, 'codex');
    assert.equal(q.windows.length, 2);
    assert.equal(q.windows[0].name, '5 hours');
    assert.equal(q.windows[0].remaining, 94);
    assert.equal(q.windows[1].name, '7 days');
    assert.equal(q.windows[1].remaining, 92);
    assert.ok(q.windows[1].resetsAt.startsWith('2026-'));
  });

  it('promotes expiring Codex above AGY while keeping manual Claude excluded from auto-burn', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-expiring-'));
    try {
      const nowMs = Date.parse('2026-11-24T12:00:00Z');
      const in10Hours = new Date(nowMs + 10 * 3600e3).toISOString();
      const in5Days = new Date(nowMs + 5 * 24 * 3600e3).toISOString();

      let localQuotas = [
        {
          provider: 'codex',
          status: 'ok',
          windows: [
            { name: '5 hours', remaining: 90, limit: 100, windowMinutes: 300, resetsAt: new Date(nowMs + 4 * 3600e3).toISOString(), unlimited: false },
            { name: '7 days', remaining: 85, limit: 100, windowMinutes: 10080, resetsAt: in10Hours, unlimited: false },
          ],
        },
      ];
      // Claude ALSO has a window resetting in 10h with 80% left, but MUST NOT be auto-promoted
      const mockMagpie = {
        status: () => ({
          accounts: [
            {
              provider: 'cc-ubuntu/claude',
              status: 'ok',
              windows: [
                { name: '7 days', remaining: 80, limit: null, used: 20, resetsAt: in10Hours, unlimited: false },
              ],
            },
          ],
        }),
      };

      const router = createModelRouter({
        dataDir: tmp,
        getMagpie: () => mockMagpie,
        getLocalQuotas: () => localQuotas,
        now: () => nowMs,
      });

      // Codex 7d resets in 10h with 85% left -> promoted above AGY!
      const pick1 = router.selectCandidate('fast-coder');
      assert.equal(pick1.ok, true);
      assert.equal(pick1.candidate.harness, 'codex');
      assert.equal(pick1.candidate.status, 'expiring_priority');
      assert.equal(pick1.candidate.expiring, true);

      // Once Codex is NOT expiring (5 days left), AGY returns to #1; Claude is NOT promoted despite 10h reset
      localQuotas = [
        {
          provider: 'codex',
          status: 'ok',
          windows: [
            { name: '7 days', remaining: 85, limit: 100, windowMinutes: 10080, resetsAt: in5Days, unlimited: false },
          ],
        },
      ];
      const pick2 = router.selectCandidate('fast-coder');
      assert.equal(pick2.ok, true);
      assert.equal(pick2.candidate.harness, 'agy');
      assert.equal(pick2.candidate.expiring, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('recommends top hard problems for Devin/Fable 5.2 when 7d quota is nearing reset with >=50% left', () => {
    const nowMs = Date.parse('2026-11-24T12:00:00Z');
    const in18Hours = new Date(nowMs + 18 * 3600e3).toISOString();
    const in5Days = new Date(nowMs + 5 * 24 * 3600e3).toISOString();

    const projects = [
      {
        id: 'proj_1',
        name: 'CEM_PO',
        workspaces: [{ machine: 'dell97', path: '/work/cem_po', mode: 'rw' }],
        tasks: [
          { id: 't1', title: 'MoM 奇异积分收敛误差排查', desc: '高阶曲面奇异核积分在掠射角发散', status: 'blocked' },
          { id: 't2', title: '更新 README 错别字', desc: '小改动', status: 'todo' },
        ],
        nodes: [],
      },
    ];
    const todos = [
      { id: 'td1', title: '气动-电磁耦合优化目标函数架构评审', priority: 'high', done: false },
    ];

    // Not due when 5 days left
    const notDue = evaluateFableAdvice({
      magpieStatus: { accounts: [{ provider: 'devin', status: 'ok', windows: [{ name: '7 days', remaining: 95, limit: null, used: 5, resetsAt: in5Days }] }] },
      projects,
      todos,
      now: () => nowMs,
    });
    assert.equal(notDue.due, false);
    assert.equal(notDue.suggestions.length, 0);

    // Due when 18h left & 85% remaining
    const dueRes = evaluateFableAdvice({
      magpieStatus: { accounts: [{ provider: 'devin', status: 'ok', windows: [{ name: '7 days', remaining: 85, limit: null, used: 15, resetsAt: in18Hours }] }] },
      projects,
      todos,
      now: () => nowMs,
    });
    assert.equal(dueRes.due, true);
    assert.equal(dueRes.suggestions.length, 2);
    assert.match(dueRes.suggestions[0].title, /奇异积分/);
    assert.equal(dueRes.suggestions[0].advisorModel, 'magpie/devin/claude-fable-5-2');
    assert.match(dueRes.suggestions[0].advisorPrompt, /只读诊断与方案拍板/);
  });
});
