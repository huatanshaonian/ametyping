'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProfileRequests } = require('../server/claude-profile-requests');
function socket(allowed = true, version = 1) {
  return { readyState: 1, claudeProfilesAllowed: allowed, claudeProfilesVersion: version, sent: [], send(text) { this.sent.push(JSON.parse(text)); } };
}
test('requests select a capable connection, not the newest unrelated/read-only socket', async () => {
  const good = socket(), readonly = socket(false), old = socket(true, 0);
  const r = createProfileRequests(), m = { sockets: new Set([good, readonly, old]) };
  const promise = r.request(m, 'list');
  assert.equal(good.sent.length, 1); assert.equal(readonly.sent.length + old.sent.length, 0);
  const rid = good.sent[0].rid;
  assert.equal(r.finish(readonly, { rid, ok: true }), false);
  r.finish(good, { rid, ok: true, view: { profiles: [{ id: 'deepseek', model: 'flash', env: { key: 'do-not-echo' } }] } });
  const response = await promise;
  assert.equal(response.ok, true);
  assert.doesNotMatch(JSON.stringify(response), /do-not-echo/);
});
test('an old agent fails immediately with actionable text, rather than waiting for a timeout', async () => {
  const old = socket(true, 0), r = createProfileRequests();
  const value = await r.request({ sockets: new Set([old]) }, 'list');
  assert.equal(value.ok, false); assert.match(value.msg, /更新并重启/); assert.equal(old.sent.length, 0);
});
test('disconnect resolves only the requests belonging to that connection', async () => {
  const s = socket(), r = createProfileRequests(), pending = r.request({ sockets: new Set([s]) }, 'save');
  r.drop(socket()); r.drop(s);
  assert.match((await pending).msg, /断开/);
});
test('timeouts describe uncertainty without echoing submitted keys', async () => {
  const s = socket(), r = createProfileRequests({ timeoutMs: 10 });
  const response = await r.request({ sockets: new Set([s]) }, 'save', { key: 'private-key-value' });
  assert.equal(response.ok, false); assert.match(response.msg, /超时/);
  assert.doesNotMatch(JSON.stringify(response), /private-key-value/);
});
