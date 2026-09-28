'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createPermissions } = require('./permissions');

async function fixture(t, timeout = 1000) {
  const store = createPermissions(() => {}, timeout);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => store.add({ session: req.url.slice(1), tool: 'Bash', input: { command: 'echo test' } }, res));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { store.clear(); server.closeAllConnections(); server.close(); });
  function request(session = 's') {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/' + session, method: 'POST' }, (res) => {
        let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject); req.end('{}');
    });
    return { req, result };
  }
  return { store, request };
}
async function until(fn) {
  for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail('condition not reached');
}
test('body completion keeps long poll open; allow/deny win only once', async (t) => {
  const { store, request } = await fixture(t);
  for (const choice of ['allow', 'deny']) {
    const r = request(); await until(() => store.list('s').length);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id = store.list('s')[0].id;
    assert.equal(store.decide(id, 'always'), false);
    assert.equal(store.decide(id, choice), true);
    assert.equal(store.decide(id, choice), false);
    assert.deepEqual(await r.result, { choice });
  }
});
test('terminal progress clears only that session; older PreToolUse is ignored', async (t) => {
  const { store, request } = await fixture(t);
  const a = request('a'), b = request('b');
  await until(() => store.list('a').length && store.list('b').length);
  const id = store.list('a')[0].id;
  store.advance({ session: 'a', hookEvent: 'PreToolUse', eventAt: 1 });
  assert.equal(store.list('a').length, 1);
  store.advance({ session: 'a', hookEvent: 'PreToolUse', eventAt: Date.now() + 1 });
  assert.deepEqual(await a.result, {});
  assert.equal(store.decide(id, 'allow'), false);
  assert.equal(store.list('b').length, 1);
  store.advance({ session: 'b', hookEvent: 'SessionEnd' });
  assert.deepEqual(await b.result, {});
});
test('timeout returns no decision', async (t) => {
  const { store, request } = await fixture(t, 35);
  assert.deepEqual(await request().result, {});
  assert.deepEqual(store.list('s'), []);
});
test('client disconnect removes card and invalidates decision', async (t) => {
  const { store, request } = await fixture(t);
  const r = request(); r.result.catch(() => {});
  await until(() => store.list('s').length);
  const id = store.list('s')[0].id;
  r.req.destroy();
  await until(() => !store.list('s').length);
  assert.equal(store.decide(id, 'allow'), false);
});
test('parallel requests have independent decisions; Stop and shutdown release remaining polls', async (t) => {
  const { store, request } = await fixture(t);
  const a = request(), b = request();
  await until(() => store.list('s').length === 2);
  const [first, second] = store.list('s');
  store.decide(first.id, 'deny');
  assert.equal(store.list('s')[0].id, second.id);
  store.advance({ session: 's', hookEvent: 'Stop' });
  const results = await Promise.all([a.result, b.result]);
  assert.equal(results.filter((r) => r.choice === 'deny').length, 1);
  assert.equal(results.filter((r) => !r.choice).length, 1);
  const c = request(); await until(() => store.list('s').length);
  store.clear();
  assert.deepEqual(await c.result, {});
});
