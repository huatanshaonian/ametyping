'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const SOUNDS_DIR = path.join(PUB, 'sounds');

test('all configured sound assets exist and pass server STATIC whitelist', () => {
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const m = srvSrc.match(/const STATIC = (\/.*\/);/);
  assert.ok(m, 'STATIC regex found in server.js');
  // eslint-disable-next-line no-eval
  const STATIC = eval(m[1]);
  assert.ok(srvSrc.includes("'.mp3': 'audio/mpeg'"), 'TYPES includes .mp3 MIME');

  const soundSrc = fs.readFileSync(path.join(PUB, 'js', 'sound.js'), 'utf8');
  const entries = [...soundSrc.matchAll(/^\s*\['([a-z]+)',\s*'([^']+)',\s*'([^']+)'/gm)];
  assert.ok(entries.length >= 12, `expected >= 12 sound events, got ${entries.length}`);

  for (const [, ev, , file] of entries) {
    const fn = file.includes('.') ? file : `${file}.wav`;
    assert.ok(fs.existsSync(path.join(SOUNDS_DIR, fn)), `sound file exists for ${ev}: ${fn}`);
    assert.ok(STATIC.test(`/sounds/${fn}`), `STATIC regex permits /sounds/${fn}`);
  }

  // Extended ringout.mp3 should be > 15KB (~2.8s two-ring cadence, not 3KB 0.47s hangup beep)
  const ringoutStat = fs.statSync(path.join(SOUNDS_DIR, 'ringout.mp3'));
  assert.ok(ringoutStat.size > 15000, `ringout.mp3 is extended two-ring cadence (${ringoutStat.size} bytes)`);
});

test('long-task classifier distinguishes short follow-ups, waiting pauses, and genuine long runs', () => {
  // Mirror classifyRunCompletion logic from alerts.js
  const LONG_ACTIVE_MS = 180_000;
  const LONG_MIN_DELTA_STEPS = 8;
  const SUBAGENT_LONG_MS = 90_000;
  function classify(rec, s) {
    if (!rec) return 'done';
    const curSteps = Number(s && s.steps) || 0;
    const maxSteps = Math.max(curSteps, rec.maxSteps || 0);
    const deltaSteps = Math.max(0, maxSteps - (rec.startSteps || 0));
    const hadAgents = Boolean(rec.hadAgents || (s && Array.isArray(s.agents) && s.agents.length > 0));
    if (rec.activeMs >= LONG_ACTIVE_MS && (deltaSteps >= LONG_MIN_DELTA_STEPS || hadAgents)) return 'tada';
    if (hadAgents && rec.activeMs >= SUBAGENT_LONG_MS && deltaSteps >= 4) return 'tada';
    return 'done';
  }

  // 1) Quick follow-up in an old 60-step session -> 'done' (NOT false positive tada)
  assert.equal(classify({ activeMs: 12_000, startSteps: 60, maxSteps: 62, hadAgents: false }, { steps: 62 }), 'done');

  // 2) Session sat waiting for permission for 20 min, actual AI active work only 45s -> 'done'
  assert.equal(classify({ activeMs: 45_000, startSteps: 2, maxSteps: 15, hadAgents: false }, { steps: 15 }), 'done');

  // 3) Slow single-step network stall (4 min, only 2 steps, no subagents) -> 'done'
  assert.equal(classify({ activeMs: 240_000, startSteps: 5, maxSteps: 7, hadAgents: false }, { steps: 7 }), 'done');

  // 4) Genuine long run (>= 3 min active work AND >= 8 delta steps) -> 'tada'
  assert.equal(classify({ activeMs: 195_000, startSteps: 10, maxSteps: 22, hadAgents: false }, { steps: 22 }), 'tada');

  // 5) Multi-subagent orchestration (>= 1.5 min active work + subagents + >= 4 steps) -> 'tada'
  assert.equal(classify({ activeMs: 110_000, startSteps: 3, maxSteps: 9, hadAgents: true }, { steps: 9 }), 'tada');
});
