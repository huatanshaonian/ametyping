'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { mapHook, decision } = require('./codex-hook');
const { normalizeSession } = require('./app/session-source');
const { createPermissions } = require('./app/permissions');
const { mergeHooks, commandFor, EVENTS } =require('./install-codex-hooks');

test('Codex lifecycle, patches, command failures and permission output', () => {
  const common = { session_id: 's', cwd: 'D:/project' };
  for (const [hook, event] of Object.entries({ SessionStart: 'idle', SessionEnd: 'quit', UserPromptSubmit: 'message', Stop: 'done', Interrupt: 'paused' })) {
    assert.equal(mapHook({ ...common, hook_event_name: hook }).route, '/event/' + event);
  }
  const patch = mapHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Update File: app/a.js\n*** Add File: app/b.js' } });
  assert.match(patch.body.text, /app\/a.js、app\/b.js/);
  assert.equal(mapHook({ ...common, hook_event_name: 'PostToolUse', tool_response: { exit_code: 1 } }).route, '/event/error');
  assert.equal(mapHook(null), null);
  assert.deepEqual(decision({ choice: 'always' }), {});
  assert.deepEqual(decision({ choice: 'defer' }), {});
  assert.equal(decision({ choice: 'deny' }).hookSpecificOutput.decision.behavior, 'deny');
});
test('provider namespace separates equal upstream session IDs', () => {
  assert.equal(normalizeSession({ session: 's' }).session, 's');
  assert.equal(normalizeSession({ session: 's', provider: 'codex' }).session, 'codex:s');
});
test('installer merges without replacing unrelated hooks and is idempotent', () => {
  const other = { type: 'command', command: 'other-hook', timeout: 10 };
  const old = { description: 'keep', hooks: { Stop: [{ matcher: '.*', hooks: [other] }] } };
  const next = mergeHooks(old, 'ame-hook');
  assert.equal(next.description, 'keep');
  assert.deepEqual(next.hooks.Stop[0].hooks[0], other);
  assert.deepEqual(mergeHooks(next, 'ame-hook'), next);
  for (const event of EVENTS) {
    assert.equal(next.hooks[event].at(-1).hooks[0].async, undefined);
    assert.equal(next.hooks[event].at(-1).hooks[0].timeout, event === 'PermissionRequest' ? 120 : 3);
  }
  assert.equal(old.hooks.Stop.length, 1);
});
test('the command runs in PowerShell too: never begins with a quoted path; an earlier install is replaced', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(commandFor(node, 'D:\\ametyping\\codex-hook.js', () => true), 'node D:/ametyping/codex-hook.js');
  assert.equal(commandFor(node, 'D:\\my pet\\codex-hook.js', () => true), 'node "D:/my pet/codex-hook.js"');
  assert.equal(commandFor('/usr/bin/node', '/opt/ame/codex-hook.js', () => true), '/usr/bin/node /opt/ame/codex-hook.js');
  assert.equal(commandFor(node, 'D:\\a\\codex-hook.js', () => false), '"C:/Program Files/nodejs/node.exe" D:/a/codex-hook.js');
  const before = mergeHooks({}, '"C:/Program Files/nodejs/node.exe" "D:/ametyping/codex-hook.js"');
  const after = mergeHooks(before, 'node D:/ametyping/codex-hook.js', 'D:/ametyping/codex-hook.js');
  for (const event of EVENTS) assert.deepEqual(after.hooks[event].map((g) => g.hooks[0].command), ['node D:/ametyping/codex-hook.js']);
});

function child(port, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'codex-hook.js')], {
      env: { ...process.env, AME_PORT: String(port) }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { p.kill(); reject(new Error('hook timed out')); }, 4000);
    p.stdout.on('data', (c) => stdout += c); p.stderr.on('data', (c) => stderr += c);
    p.on('error', reject);
    p.on('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
test('real hook process -> HTTP long poll -> panel decision -> Codex protocol', async (t) => {
  let choice = 'allow', received;
  const store = createPermissions(() => {}, 500);
  const server = http.createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', (c) => body += c);
    req.on('end', () => {
      received = { route: req.url, body: JSON.parse(body) };
      if (req.url === '/permission') {
        const d = normalizeSession(received.body);
        const id = store.add(d, res);
        setTimeout(() => {
          if (choice === 'Interrupt') store.advance({ ...d, hookEvent: 'Interrupt' });
          else store.decide(id, choice);
        }, 10);
      } else res.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { store.clear(); server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const input = { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo 中文' } };
  for (choice of ['allow', 'deny', 'defer', 'Interrupt']) {
    const r = await child(port, input);
    assert.equal(r.code, 0); assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), decision({ choice }));
    assert.equal(received.body.input.command, 'echo 中文');
    assert.equal(store.list('codex:s').length, 0);
  }
  const stop = await child(port, { session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'done' });
  assert.equal(received.route, '/event/done');
  assert.deepEqual(JSON.parse(stop.stdout), {});
  const malformed = await child(port, '{bad json');
  assert.equal(malformed.code, 0); assert.deepEqual(JSON.parse(malformed.stdout), {});
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  const absent = await child(port, input);
  assert.equal(absent.code, 0); assert.deepEqual(JSON.parse(absent.stdout), {});
});
