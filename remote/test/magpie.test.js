'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createClient } = require('../server/magpie/client');
const { snapshot } = require('../server/magpie/normalize');
const { createMagpie } = require('../server/magpie');
const { modelsFor } = require('../server/magpie/ai');
const { createAiSettings } = require('../server/ai/settings');
const { createAsk } = require('../server/ai/ask');
const { createQuotaNotices, cleanNotice } = require('../agent/quota-notices');
const { createQuotaNotice } = require('../../app/quota-notice');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'windose-magpie-test-'));
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });
const now = Date.now(), iso = n => new Date(n).toISOString();
const quota = { provider: 'antigravity', user: 'private@example.com', plan: 'Pro', readAt: iso(now), windows: [
  { name: 'Claude & GPT · 7 days', remaining: 50, resetsAt: iso(now + 23 * 3600000) },
  { name: 'Claude & GPT · 5 hours', remaining: 30, resetsAt: iso(now + 3 * 3600000) },
] };
test('each account matches only explicit usage identities; missing/stale values remain unknown', () => {
  const data = snapshot({ data: [quota, { ...quota, user: 'other@example.com' }] }, { accounts: [{ provider: 'antigravity', account: quota.user, calls: 3, cost: 0 }] }, 'today', iso(now));
  assert.equal(data.accounts[0].usage.calls, 3); assert.equal(data.accounts[1].usage, null);
  assert.equal(data.accounts[0].windows[0].amount, null); assert.ok(!JSON.stringify(data).includes(quota.user));
  assert.equal(snapshot(null, { accounts: [{ provider: 'deepseek', account: 'test', calls: 1 }] }).accounts[0].status, 'unknown');
  assert.ok(!JSON.stringify(snapshot({ data: [{ provider: 'api', user: 'sk-private-test-key', windows: [] }] }, { accounts: [{ provider: 'api', account: 'sk-private-test-key', calls: 1 }] })).includes('sk-private-test-key'));
});
test('remote upstream quota and connection-key budget share one card with distinct scopes', () => {
  const raw = { data: [
    { provider: 'gcp', name: 'Remote magpie', kind: 'subscription', from: 'Remote magpie', windows: [], error: 'nothing read on that magpie yet; refresh to have it read' },
    { provider: 'gcp/~keys', name: 'Remote magpie', kind: 'plan', from: 'Remote magpie', user: 'sk-private-remote-key', readAt: iso(now), windows: [{ name: 'Limit', unlimited: true, remaining: 100 }] },
  ] };
  const s = snapshot(raw, { calls: 4, accounts: [] }, 'today', iso(now));
  assert.equal(s.accounts.length, 1); const g = s.accounts[0];
  assert.equal(g.name, 'GCP · Remote Magpie'); assert.equal(g.status, 'partial'); assert.equal(g.quotaStatus, 'unread');
  assert.deepEqual(g.windows, []); assert.equal(g.connectionLimits[0].windows[0].unlimited, true);
  assert.equal(s.totals.calls, 4); assert.ok(!JSON.stringify(s).includes('sk-private-remote-key'));
  assert.equal(snapshot({ data: [raw.data[1]] }).accounts.length, 1, 'an orphan key record is preserved');
  assert.equal(snapshot({ data: [raw.data[0], { ...raw.data[1], provider: 'other/~keys' }] }).accounts.length, 2, 'unrelated remote sources never merge');
});
test('polling, persisted per-cycle reminder dedup, partial failure and read-only public payload', async () => {
  const dir = temp(), notices = []; let fail = false;
  const client = { enabled: true, request: async p => {
    if (fail) throw Error('SECRET body');
    if (p === 'models') return { data: [{ id: 'devin/claude-opus-5-5' }] };
    if (p === 'magpie/quotas') return { data: [quota] };
    return { calls: 2, cost: 0, accounts: [{ provider: 'antigravity', account: quota.user, calls: 2 }] };
  } };
  try {
    let m = createMagpie({ client, dataDir: dir, now: () => now, autoStart: false, onNotice: n => notices.push(n) });
    await m.poll(); assert.equal(notices.length, 1); assert.equal(notices[0].body, '周额度将在 23小时后重置。');
    assert.ok(!JSON.stringify(m.status()).includes(quota.user)); assert.ok(!JSON.stringify(notices).includes(quota.user));
    m.stop(); m = createMagpie({ client, dataDir: dir, now: () => now, autoStart: false }); await m.poll();
    assert.equal(m.activeNotices().length, 1); assert.equal(m.models().length, 1);
    fail = true; await m.poll(); assert.ok(m.status().errors.quotas); assert.equal(m.status().totals.calls, 2);
    assert.ok(!JSON.stringify(m.status()).includes('SECRET')); m.stop();
  } finally { cleanup(dir); }
});
test('Magpie AI selections preserve existing defaults and never turn into Codex when catalogue goes offline', async () => {
  const dir = temp(); let available = true, got;
  const model = 'devin/claude-opus-5-5', slug = modelsFor([{ id: model, name: 'Devin', efforts: ['low'] }])[0].slug;
  const magpie = { models: () => available ? modelsFor([{ id: model, name: 'Devin', efforts: ['low'] }]) : [], run: async x => { got = x; return { ok: true }; } };
  try {
    const settings = createAiSettings({ dataDir: dir, codexHome: dir, claudeHome: dir, magpie });
    assert.equal(settings.pick('ask').provider, 'codex'); settings.set({ tasks: { ask: { model: slug, effort: 'low' } } });
    assert.equal(settings.pick('daily').provider, 'codex'); assert.equal(settings.pick('ask').provider, 'magpie');
    const ask = createAsk({ codex: { timeoutMs: 3000 }, magpie, pick: settings.pick });
    assert.deepEqual(await ask.ask('fixture', { type: 'object' }, 'ask', { apiOnly: true }), { ok: true }); assert.equal(got.model, model);
    available = false; assert.equal(settings.pick('ask').provider, 'magpie');
  } finally { cleanup(dir); }
});
test('native Messages and generic Chat Completions send selected gateway model; errors contain no upstream body', async () => {
  const calls = []; let failing = false;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b); calls.push({ path: req.url, body, headers: req.headers });
      if (failing) { res.writeHead(403); return res.end('SECRET remote key'); }
      if (req.url === '/v1/messages') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"{\\"ok\\":true}"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n'); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const client = createClient({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' });
    const { runMagpie } = require('../server/magpie/ai');
    const cat = [{ id: 'devin/claude-opus-5-5', nativeMessages: true }, { id: 'deepseek/deepseek-flash' }];
    for (const m of cat) assert.deepEqual(await runMagpie({ client, catalog: cat, model: m.id, effort: 'low', prompt: 'fixture', schema: { type: 'object' } }), { ok: true });
    assert.equal(calls[0].body.model, cat[0].id); assert.equal(calls[0].path, '/v1/messages'); assert.equal(calls[1].path, '/v1/chat/completions');
    failing = true; await assert.rejects(runMagpie({ client, catalog: cat, model: cat[0].id, prompt: 'fixture', schema: {} }), e => !e.message.includes('SECRET'));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('agent stores only sanitized inbox, retries pet failure and deduplicates reconnects', async () => {
  const dir = temp(), file = path.join(dir, 'inbox.json'); let success = false, attempts = 0;
  const n = { id: 'a'.repeat(24), title: 'AGY Claude 周额度即将重置', body: '周额度将在 1小时后重置。', createdAt: now, resetAt: now + 3600000, expiresAt: now + 3600000 };
  const a = createQuotaNotices({ file, now: () => now, autoStart: false, deliver: async () => { attempts++; return { ok: success }; } });
  try {
    assert.equal(a.add({ ...n, key: 'SECRET' }), true); await new Promise(r => setImmediate(r)); assert.equal(a.items()[0].petDeliveredAt, undefined);
    success = true; await a.flush(); assert.equal(attempts, 2); a.add(n); await a.flush(); assert.equal(attempts, 2);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET')); assert.equal(cleanNotice({ ...n, body: '安排一次复核' }, now), null);
  } finally { a.stop(); cleanup(dir); }
});
test('pet accepts a durable dedicated notice before app startup, no session/mail channel', () => {
  const dir = temp(), listeners = {};
  const app = { getPath: () => dir, isReady: () => false, whenReady: () => new Promise(() => {}) };
  const n = { id: 'b'.repeat(24), title: 'AGY Claude 周额度即将重置', body: '周额度将在 1小时后重置。', createdAt: now, resetAt: now + 3600000, expiresAt: now + 3600000 };
  try {
    let q = createQuotaNotice({ app, ipcMain: { on: (k, v) => listeners[k] = v } }); assert.ok(q.add(n)); assert.ok(q.add(n));
    q = createQuotaNotice({ app, ipcMain: { on() {} } }); assert.ok(q.add(n));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'quota-notice-seen.json'))); assert.equal(saved.pending.length, 1);
    assert.deepEqual(Object.keys(listeners), ['quota-notice-close', 'quota-notice-open']);
  } finally { cleanup(dir); }
});
