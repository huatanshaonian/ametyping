'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPushEvents, ctxLeft, DONE_MIN } = require('../server/push/events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('approval push waits for grace period and suppresses auto-approved transient prompts', async () => {
  const sent = [];
  const ev = createPushEvents({ push: { notify: (kind, msg) => sent.push({ kind, msg }) }, permGraceMs: 40 });
  const perm = { id: 'p1', provider: 'codex', tool: 'Bash', input: JSON.stringify({ command: 'ls' }) };

  // Transient permission disappears within grace window -> no notification
  ev.sessions('pc1', [{ id: 'codex:1', label: 'Codex', state: 'waiting', perms: [perm], lines: [] }], true);
  await sleep(15);
  ev.sessions('pc1', [{ id: 'codex:1', label: 'Codex', state: 'thinking', perms: [], lines: [] }], true);
  await sleep(45);
  assert.equal(sent.length, 0);

  // Persistent permission survives grace window -> notifies once
  const perm2 = { id: 'p2', provider: 'agy', tool: 'Bash', input: JSON.stringify({ CommandLine: 'npm test' }) };
  ev.sessions('pc1', [{ id: 'agy:1', label: 'Agy', state: 'waiting', perms: [perm2], lines: [] }], true);
  await sleep(60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'approval');
  assert.match(sent[0].msg.body, /npm test/);

  // Re-seeing the same permission does not notify again
  ev.sessions('pc1', [{ id: 'agy:1', label: 'Agy', state: 'waiting', perms: [perm2], lines: [] }], true);
  await sleep(60);
  assert.equal(sent.length, 1);
});

test('done push preserves work duration across intermediate waiting states', () => {
  const sent = [];
  const origNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const ev = createPushEvents({ push: { notify: (kind, msg) => sent.push({ kind, msg }) }, permGraceMs: 0 });
    ev.sessions('pc1', [{ id: 'opencode:ses_123456', label: 'OC', state: 'thinking', perms: [], lines: [] }], true);
    now += (DONE_MIN * 60e3) - 10e3;
    // Enters waiting mid-task (must not reset work start time)
    ev.sessions('pc1', [{ id: 'opencode:ses_123456', label: 'OC', state: 'waiting', perms: [], lines: [] }], true);
    now += 20e3;
    ev.sessions('pc1', [{ id: 'opencode:ses_123456', label: 'OC', state: 'done', perms: [], lines: [{ text: '全部改好了' }] }], true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'done');
    assert.match(sent[0].msg.title, /OC/);
    assert.match(sent[0].msg.body, /全部改好了/);
  } finally {
    Date.now = origNow;
  }
});

test('ctxLeft handles claude, codex, opencode, and agy context windows properly', () => {
  assert.equal(ctxLeft('claude-id', { used: 100000, win: 200000 }), Math.round(((200000 - 33000 - 100000) / (200000 - 33000)) * 100));
  assert.equal(ctxLeft('codex:1', { used: 100000, win: 200000 }), Math.round(((200000 - 100000) / (200000 - 12000)) * 100));
  assert.equal(ctxLeft('opencode:ses_1', { used: 100000, win: 200000 }), 50);
  assert.equal(ctxLeft('agy:1', { used: 100000, win: 1000000 }), 90);
});
