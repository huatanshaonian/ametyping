'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { once } = require('events');
const { mapHook, toolSummary, transcriptOf } = require('./kiro-hook');
const installer = require('./install-kiro-hooks');

const SID = '12345678-1234-1234-1234-1234567890ab';

test('Kiro lifecycle events map to the right pet endpoints', () => {
  const common = { cwd: 'D:/project' };
  const cases = { agentSpawn: 'idle', userPromptSubmit: 'message', stop: 'done' };
  for (const [hook, event] of Object.entries(cases)) {
    const m = mapHook({ ...common, hook_event_name: hook, prompt: 'hi', assistant_response: 'bye' }, SID);
    assert.equal(m.route, '/event/' + event);
    assert.equal(m.body.provider, 'kiro');
    assert.equal(m.body.session, SID);
    assert.equal(m.body.cwd, 'D:/project');
    assert.equal(m.body.project, 'project');
  }
  // PascalCase and the SessionStart alias are accepted too
  assert.equal(mapHook({ ...common, hook_event_name: 'AgentSpawn' }, SID).route, '/event/idle');
  assert.equal(mapHook({ ...common, hook_event_name: 'Stop' }, SID).route, '/event/done');
});

test('PreToolUse tells reading apart from thinking; PostToolUse flags failures', () => {
  const read = mapHook({ hook_event_name: 'preToolUse', tool_name: 'read', tool_input: { operations: [{ path: '/a/b.js' }] } }, SID);
  assert.equal(read.route, '/event/reading');
  assert.match(read.body.text, /b\.js/);
  const shell = mapHook({ hook_event_name: 'preToolUse', tool_name: 'shell', tool_input: { command: 'cargo test' } }, SID);
  assert.equal(shell.route, '/event/thinking');
  assert.match(shell.body.text, /cargo test/);
  const write = mapHook({ hook_event_name: 'preToolUse', tool_name: 'write', tool_input: { path: 'src/x.rs' } }, SID);
  assert.equal(write.route, '/event/thinking');
  // a failed tool result (status "error" or success false) -> /event/error
  assert.equal(mapHook({ hook_event_name: 'postToolUse', tool_name: 'shell', tool_response: { status: 'error' } }, SID).route, '/event/error');
  assert.equal(mapHook({ hook_event_name: 'postToolUse', tool_name: 'shell', tool_response: { success: false } }, SID).route, '/event/error');
  assert.equal(mapHook({ hook_event_name: 'postToolUse', tool_name: 'shell', tool_response: { success: true } }, SID).route, '/event/thinking');
});

test('toolSummary and transcriptOf', () => {
  assert.equal(toolSummary('read', { operations: [{ path: '/x/y.txt' }] }).read, true);
  assert.equal(toolSummary('grep', { pattern: 'TODO' }).read, true);
  assert.equal(toolSummary('shell', { command: 'ls' }).read, false);
  assert.equal(toolSummary('write', { path: '/a/b' }).read, false);
  const home = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
  assert.equal(transcriptOf(SID), path.join(home, 'sessions', 'cli', SID + '.jsonl'));
  assert.equal(transcriptOf('not-a-uuid'), '');          // only a real UUID yields a path
});

test('a missing session id or unknown event maps to null', () => {
  assert.equal(mapHook({ hook_event_name: 'agentSpawn' }, ''), null);          // no KIRO_SESSION_ID
  assert.equal(mapHook({ hook_event_name: 'nope' }, SID), null);
  assert.equal(mapHook(null, SID), null);
});

// ---- installer: object and array formats, idempotency, --remove, preserving other hooks ----
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ame-kiro-')); }

test('installer writes object-format hooks, preserves others, is idempotent, and removes cleanly', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'default.json');
  fs.writeFileSync(target, JSON.stringify({ name: 'default', hooks: { stop: [{ command: 'keep-me' }] } }, null, 2));
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cmd = installer.commandFor(node, path.join(__dirname, 'kiro-hook.js'), () => true);

  const cfg = JSON.parse(fs.readFileSync(target, 'utf8'));
  const merged = installer.apply(cfg, false, cmd);
  for (const trigger of installer.TRIGGERS) {
    assert.ok(merged.hooks[trigger].some((h) => h.command === cmd), trigger + ' installed');
  }
  assert.ok(merged.hooks.stop.some((h) => h.command === 'keep-me'), 'unrelated hook kept');
  assert.ok(merged.hooks.preToolUse.some((h) => h.matcher === '*'), 'preToolUse gets a wildcard matcher');
  // idempotent: applying again changes nothing
  assert.deepEqual(installer.apply(merged, false, cmd), merged);
  // remove: our hooks gone, the kept one stays
  const removed = installer.apply(merged, true, cmd);
  for (const trigger of installer.TRIGGERS) {
    const arr = removed.hooks && removed.hooks[trigger];
    assert.ok(!arr || !arr.some((h) => h.command === cmd), trigger + ' removed');
  }
  assert.ok(removed.hooks.stop.some((h) => h.command === 'keep-me'), 'kept hook survives removal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installer preserves array-format hooks', () => {
  const cfg = { name: 'arr', hooks: [{ name: 'other', trigger: 'stop', action: { type: 'command', command: 'keep-me' } }] };
  const cmd = 'node /opt/ame/kiro-hook.js';
  const merged = installer.apply(cfg, false, cmd);
  assert.ok(Array.isArray(merged.hooks), 'still an array');
  assert.ok(merged.hooks.some((h) => h.name === 'other'), 'unrelated array hook kept');
  for (const trigger of installer.TRIGGERS) {
    assert.ok(merged.hooks.some((h) => h.trigger === trigger && h.action.command === cmd), trigger + ' installed in array form');
  }
  assert.deepEqual(installer.apply(merged, false, cmd), merged);        // idempotent
  const removed = installer.apply(merged, true, cmd);
  assert.ok(removed.hooks.some((h) => h.name === 'other'), 'kept array hook survives');
  assert.ok(!removed.hooks.some((h) => h.action && h.action.command === cmd), 'ours removed from array');
});

test('install() backs up, refuses to clobber malformed JSON, and resolves targets', () => {
  const dir = tmpDir();
  const home = path.join(dir, 'home');
  process.env.KIRO_HOME = path.join(home, '.kiro');
  try {
    // a bare name resolves under KIRO_HOME/agents
    assert.equal(installer.resolveTarget('my-agent'), path.join(home, '.kiro', 'agents', 'my-agent.json'));
    assert.equal(installer.resolveTarget(''), path.join(home, '.kiro', 'agents', 'default.json'));
    // install into a fresh target creates the file with our hooks
    const target = installer.resolveTarget('my-agent');
    const r = installer.install(target, false);
    assert.equal(r.changed, true);
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(installer.TRIGGERS.every((t) => written.hooks[t]));
    // second install is a no-op and makes no backup
    const again = installer.install(target, false);
    assert.equal(again.changed, false);
    // a malformed existing file is never overwritten
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.throws(() => installer.install(bad, false), /JSON/);
    assert.equal(fs.readFileSync(bad, 'utf8'), '{not json');
    // remove makes a backup of the previous content
    installer.install(target, true);
    assert.ok(fs.readdirSync(path.dirname(target)).some((n) => n.includes('.ame-backup-')), 'a backup was written');
  } finally {
    delete process.env.KIRO_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commandFor never begins with a quoted path (Kiro runs it through the shell)', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(installer.commandFor(node, 'D:\\ametyping\\kiro-hook.js', () => true), 'node D:/ametyping/kiro-hook.js');
  assert.equal(installer.commandFor(node, 'D:\\my pet\\kiro-hook.js', () => true), 'node "D:/my pet/kiro-hook.js"');
  assert.equal(installer.commandFor('/usr/bin/node', '/opt/ame/kiro-hook.js', () => true), '/usr/bin/node /opt/ame/kiro-hook.js');
  assert.equal(installer.commandFor(node, 'D:\\a\\kiro-hook.js', () => false), '"C:/Program Files/nodejs/node.exe" D:/a/kiro-hook.js');
});

// ---- the real hook process posts to the loopback endpoint and never pollutes stdout ----
function child(port, input, session = SID) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'kiro-hook.js')], {
      env: { ...process.env, AME_PORT: String(port), KIRO_SESSION_ID: session }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { p.kill(); reject(new Error('hook timed out')); }, 4000);
    p.stdout.on('data', (c) => stdout += c); p.stderr.on('data', (c) => stderr += c);
    p.on('error', reject);
    p.on('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('real hook process -> loopback HTTP, stdout stays empty', async (t) => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', (c) => body += c);
    req.on('end', () => { received = { route: req.url, body: JSON.parse(body) }; res.end('{}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;

  const r = await child(port, { hook_event_name: 'userPromptSubmit', cwd: 'D:/p', prompt: '写点中文' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');                    // agentSpawn/userPromptSubmit stdout is added to context: must stay empty
  assert.equal(r.stderr, '');
  assert.equal(received.route, '/event/message');
  assert.equal(received.body.provider, 'kiro');
  assert.equal(received.body.session, SID);
  assert.match(received.body.text, /写点中文/);

  // malformed input exits 0 without crashing
  const bad = await child(port, '{bad');
  assert.equal(bad.code, 0); assert.equal(bad.stdout, '');
  // no session id -> nothing sent, still exit 0
  const nosid = await child(port, { hook_event_name: 'stop' }, '');
  assert.equal(nosid.code, 0); assert.equal(nosid.stdout, '');
});
