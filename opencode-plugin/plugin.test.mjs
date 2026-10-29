// The plugin inside a stand-in OpenCode server: events reach Ame's local service, the conversation is mirrored,
// permission cards are answered through ctx.permission.reply, and Ame can reply through the plugin's endpoint.
// No OpenCode process is needed: the server's client API is faked, everything else is the real plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-oc-plugin-'));
const ROOT = path.join(T, 'ame');
const PROJ = path.join(T, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
process.env.OPENCODE_AME_HOME = ROOT;

const received = [], asked = [], prompted = [], replies = [], interrupted = [];
let answer = { choice: 'allow' };
const ame = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    let d = {}; try { d = JSON.parse(body); } catch {}
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/permission') {
      asked.push(d);
      setTimeout(() => res.end(JSON.stringify(answer)), 60);
      return;
    }
    received.push({ url: req.url, body: d });
    res.end('{}');
  });
});

function queue() {
  const items = [], waiters = [];
  return {
    push(x) { if (waiters.length) waiters.shift()(x); else items.push(x); },
    next(signal) {
      if (items.length) return Promise.resolve(items.shift());
      return new Promise((r) => {
        waiters.push(r);
        if (signal) signal.addEventListener('abort', () => r({ type: 'server.connected' }), { once: true });
      });
    },
  };
}

test.before(async () => { await new Promise((r) => ame.listen(0, '127.0.0.1', r)); });
test.after(() => { ame.close(); fs.rmSync(T, { recursive: true, force: true }); });

test('a stand-in OpenCode server drives the real plugin', { timeout: 30000 }, async () => {
  process.env.AME_PORT = String(ame.address().port);
  const q = queue();
  const messages = [
    { id: 'm1', type: 'user', time: { created: 1700000000000 }, text: '你好' },
    { id: 'm2', type: 'assistant', time: { created: 1700000001000, completed: 1700000002000 }, finish: 'stop', content: [{ type: 'text', text: '你好呀' }] },
  ];
  const sessionID = 'ses_plugin0001';
  const info = { id: sessionID, title: '演示会话', location: { directory: PROJ }, time: { created: 1, updated: 2 } };
  const ctx = {
    location: { directory: PROJ },
    app: { version: 'test' },
    event: {
      subscribe: ({ signal }) => (async function* () { while (!signal.aborted) yield await q.next(signal); })(),
    },
    session: {
      list: async () => ({ data: [] }),
      get: async () => info,
      context: async () => messages,
      prompt: async (input) => { prompted.push(input); },
      interrupt: async (input) => { interrupted.push(input); },
      update: async () => {},
    },
    permission: { reply: async (input) => { replies.push(input); } },
  };
  const plugin = (await import(new URL('./index.js', import.meta.url).href)).default;
  assert.equal(plugin.id, 'ametyping');
  const cleanup = await plugin.setup(ctx);
  assert.equal(typeof cleanup, 'function');
  let bridgeFile = null;
  try {

  // event -> Ame, and the conversation mirror
  const ev = (type, data = {}) => q.push({ id: 'evt' + Math.random(), type, location: { directory: PROJ }, data: { sessionID, ...data } });
  ev('session.created', { title: '演示会话', location: { directory: PROJ } });
  ev('session.inbox.delivered');
  ev('session.execution.started');
  ev('session.text.ended', { text: '你好呀' });
  ev('session.execution.succeeded');
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };
  assert.ok(await until(() => received.some((e) => e.url === '/event/done')), JSON.stringify(received));
  assert.ok(received.some((e) => e.url === '/event/thinking' && e.body.provider === 'opencode'));
  assert.ok(received.some((e) => e.url === '/event/message'));
  const mirror = path.join(ROOT, 'sessions', `${sessionID}.jsonl`);
  assert.ok(await until(() => fs.existsSync(mirror) && /你好呀/.test(fs.readFileSync(mirror, 'utf8')), 5000));
  const lines = fs.readFileSync(mirror, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'meta');
  assert.ok(lines.some((l) => l.role === 'user' && l.text === '你好'));
  assert.ok(lines.some((l) => l.role === 'assistant' && l.text === '你好呀'));

  // the control endpoint Ame uses to reply / interrupt
  const bridges = fs.readdirSync(path.join(ROOT, 'bridges'));
  assert.equal(bridges.length, 1);
  bridgeFile = path.join(ROOT, 'bridges', bridges[0]);
  const bridge = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
  const call = (url, body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: url,
      headers: { 'X-Ame-Bridge': bridge.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    r.end(data);
  });
  assert.deepEqual(await call('/prompt', { sessionID, text: '继续' }), { ok: true });
  assert.deepEqual(prompted, [{ sessionID, text: '继续' }]);
  assert.deepEqual(await call('/interrupt', { sessionID }), { ok: true });
  assert.equal(interrupted.length, 1);
  const shot = await call('/screen', { sessionID });
  assert.ok(shot.ok && /你好呀/.test(shot.screen));

  // a permission prompt: the card waits in Ame, its answer goes back through ctx.permission.reply
  ev('permission.asked', { id: 'p1', action: 'shell', resources: ['echo hi'], save: ['shell: echo *'] });
  assert.ok(await until(() => replies.length === 1, 5000));
  assert.deepEqual(replies[0], { sessionID, requestID: 'p1', decision: 'once' });
  assert.equal(asked[0].provider, 'opencode');
  assert.equal(asked[0].tool, 'shell');
  assert.deepEqual(asked[0].suggestions, ['shell: echo *']);
  answer = { choice: 'always' };
  ev('permission.asked', { id: 'p2', action: 'shell', resources: ['ls'] });
  assert.ok(await until(() => replies.length === 2, 5000));
  assert.equal(replies[1].decision, 'always');
  answer = { choice: 'deny' };
  ev('permission.asked', { id: 'p3', action: 'shell', resources: ['rm x'] });
  assert.ok(await until(() => replies.length === 3, 5000));
  assert.equal(replies[2].decision, 'reject');

  // a prompt answered in the terminal closes Ame's card (the long poll ends) instead of waiting an hour
  } finally {
    await cleanup();
  }
  assert.ok(!fs.existsSync(bridgeFile));
});
