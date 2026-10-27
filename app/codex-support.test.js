'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-codex-support-'));
process.env.CODEX_HOME = path.join(home, 'custom codex home');
const records = require('./codex-records');
const registry = require('./codex-sessions');
const { adoptRunning } = require('./session-adopt');
const { mapHook } = require('../codex-hook');
const { mergeHooks, removeHooks, install, EVENTS } = require('../install-codex-hooks');
const agents = require('../remote/agent/codex-subagents');
const ID = '01900000-0000-7000-8000-000000000001';
const SUB = '01900000-0000-7000-8000-000000000002';
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2020', '01', '01');
fs.mkdirSync(dir, { recursive: true });
const L = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n';
const rollout = (id, payload, extra = '') => {
  const file = path.join(dir, `rollout-old-${id}.jsonl`);
  fs.writeFileSync(file, L({ type: 'session_meta', payload: { id, cwd: home, ...payload } }) + extra);
  return file;
};
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('custom CODEX_HOME and a recently resumed thread in an old date directory', () => {
  const file = rollout(ID, {});
  assert.ok(records.recentFiles(60000).some((r) => r.file === file));
  assert.equal(records.fileOf(ID), file);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'session_index.jsonl'), L({ id: ID, thread_name: '自定义目录里的会话' }));
  assert.equal(records.titleOf(ID), '自定义目录里的会话');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(file, old, old);
  assert.ok(!records.recentFiles(60000).some((r) => r.file === file));
});

test('hook transcript and process stay with the root; a child finishing does not finish the parent', () => {
  const p = { session_id: ID, cwd: home, transcript_path: 'root.jsonl', hook_event_name: 'SessionStart' };
  assert.equal(mapHook(p).body.transcript, 'root.jsonl');
  for (const event of ['Stop', 'SessionEnd', 'SessionStart', 'SubagentStop']) {
    const r = mapHook({ ...p, hook_event_name: event, agent_id: SUB });
    assert.equal(r.route, '/event/thinking');
    assert.equal(r.body.pid, undefined);
    assert.equal(r.body.transcript, undefined);
  }
  assert.match(mapHook({ ...p, hook_event_name: 'PreCompact' }).body.text, /压缩/);
});

test('Codex subagent metadata variants are grouped under the parent, not listed as root threads', () => {
  const file = rollout(SUB, { source: { subagent: { spawn: { parent_thread_id: ID, agent_nickname: '小雨', agent_role: 'worker' } } } },
    L({ type: 'event_msg', payload: { type: 'task_started' } }) +
    L({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' } }));
  assert.equal(records.metaOf(file).sub, true);
  let rows = agents.scan([{ file, mtime: fs.statSync(file).mtimeMs }]).get('codex:' + ID);
  assert.equal(rows[0].name, '小雨');
  assert.equal(rows[0].state, 'run');
  assert.match(rows[0].act, /npm test/);
  fs.appendFileSync(file, L({ type: 'event_msg', payload: { type: 'task_complete' } }));
  rows = agents.scan([{ file, mtime: fs.statSync(file).mtimeMs }]).get('codex:' + ID);
  assert.equal(rows[0].state, 'done');
  assert.equal(agents.scan([{ file, mtime: Date.now() - 7 * 3600e3 }]).size, 0);
});

test('a restarted service adopts an idle Codex CLI only with the same process identity', async () => {
  const s = { provider: 'codex', rawSession: ID, claudePid: 42, processIdentity: 'started-1', cwd: home, transcript: records.fileOf(ID) };
  registry.remember(s, home);
  const bridge = { ancestors: async () => [{ pid: 42, name: 'codex.exe' }, { pid: 43, name: 'node.exe' }, { pid: 44, name: 'pwsh.exe' }], identity: async () => 'started-1' };
  const opts = { bridge, home, isClaude: () => false, isTerminal: (n) => n === 'pwsh.exe', onChange: () => {} };
  const sessions = new Map();
  assert.equal(await adoptRunning({ ...opts, sessions }), 1);
  const adopted = sessions.get('codex:' + ID);
  assert.equal(adopted.terminal, true);
  assert.equal(adopted.rawSession, ID);
  assert.equal(adopted.transcript, s.transcript);
  assert.equal(await adoptRunning({ ...opts, sessions }), 0);
  bridge.identity = async () => 'reused-pid';
  assert.equal(await adoptRunning({ ...opts, sessions: new Map() }), 0);
  assert.equal(registry.list(home).length, 0);
  registry.remember(s, home);
  registry.remember({ ...s, rawSession: SUB }, home);
  assert.deepEqual(registry.list(home).map((r) => r.id), [SUB]);
  registry.forget(SUB, home);
  assert.equal(registry.list(home).length, 0);
});

test('install, relocate, reinstall, remove: preserve unrelated hooks and never create a --remove file', () => {
  const other = { type: 'command', command: 'other-hook' };
  const base = { description: 'keep', hooks: { Stop: [{ hooks: [other] }], FutureEvent: [{ hooks: [{ type: 'command', command: 'node C:\\old\\codex-hook.js' }] }] } };
  const next = mergeHooks(base, 'node D:/new/codex-hook.js');
  assert.equal(next.hooks.FutureEvent, undefined);
  assert.deepEqual(removeHooks(next), { description: 'keep', hooks: { Stop: [{ hooks: [other] }] } });
  for (const event of ['PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop']) assert.ok(EVENTS.includes(event));
  const target = path.join(home, 'hooks.json');
  fs.writeFileSync(target, JSON.stringify(base));
  install(target);
  const installed = fs.readFileSync(target, 'utf8');
  install(target);
  assert.equal(fs.readFileSync(target, 'utf8'), installed);
  execFileSync(process.execPath, [path.resolve(__dirname, '..', 'install-codex-hooks.js'), '--remove', target], { windowsHide: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), removeHooks(base));
  assert.ok(!fs.existsSync(path.join(home, '--remove')));
});

test('Codex plan/context metadata and skills are read without Claude commands', () => {
  assert.equal(records.recordsOf({ type: 'turn_context', payload: { collaboration_mode: { mode: 'plan' } } })[0].text, 'plan');
  const skills = path.join(process.env.CODEX_HOME, 'skills', 'check');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: check\ndescription: 检查项目\n---');
  const own = require('../remote/agent/commands').scanCodex(home);
  assert.deepEqual(own, [{ name: 'check', desc: '检查项目', src: 'skill' }]);
});

test('reply suggestions switch provider and insert Codex skills with $, not Claude slash commands', async () => {
  const h = (tag, props = {}, ...children) => ({ tag, ...props, children, events: {},
    addEventListener(name, fn) { this.events[name] = fn; }, replaceChildren(...c) { this.children = c; } });
  const source = fs.readFileSync(path.join(__dirname, '../remote/public/js/apps/dash-slash.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function createSlash', 'function createSlash');
  const urls = [];
  const createSlash = new Function('h', 'fetch', source + '\nreturn createSlash;')(h, async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ list: url.endsWith('codex') ? [{ name: 'check', desc: '检查', src: 'skill' }] : [] }) };
  });
  let provider = 'codex';
  const say = h('textarea', { value: '', selectionStart: 0, selectionEnd: 0, disabled: false });
  say.setSelectionRange = (a, b) => { say.selectionStart = a; say.selectionEnd = b; };
  const slash = createSlash({ say, machine: () => 'box', provider: () => provider, onFill: () => {} });
  const input = async (v) => { say.value = v; say.selectionStart = say.selectionEnd = v.length; await say.events.input(); };
  await input('/init');
  assert.match(slash.el.children[0].children[1].text, /AGENTS.md/);
  await input('/btw');
  assert.equal(slash.el.hidden, true);
  await input('$che');
  assert.equal(slash.el.children[0].children[0].text, '$check');
  say.events.keydown({ key: 'Tab', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(say.value, '$check ');
  provider = 'claude';
  await input('/init');
  assert.match(slash.el.children[0].children[1].text, /CLAUDE.md/);
  assert.equal(urls.length, 2); // Provider-specific cache; no fetch for each keystroke.
});

test('Linux process lookup skips nested helpers and identities distinguish boot and process start', () => {
  const entries = new Map([[20, ['sh', 19]], [19, ['codex', 18]], [18, ['node', 8]], [8, ['codex', 7]], [7, ['bash', 1]]]);
  let boot = 'boot-A', start = '1234';
  const fakeFs = { readFileSync(file) {
    if (file === '/proc/sys/kernel/random/boot_id') return boot;
    const m = /^\/proc\/(\d+)\/(comm|stat)$/.exec(file), entry = m && entries.get(+m[1]);
    if (!entry) throw new Error('process gone');
    if (m[2] === 'comm') return entry[0];
    const fields = Array(21).fill('0'); fields[0] = 'S'; fields[1] = String(entry[1]); fields[19] = start;
    return `${m[1]} (${entry[0]}) ${fields.join(' ')}`;
  } };
  const module = { exports: {} };
  require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../headless/proc-linux.js'), 'utf8'), { module, require: () => fakeFs });
  const proc = module.exports;
  assert.equal(proc.findCodex(20).pid, 8);
  assert.equal(proc.identity(8), 'boot-A:1234');
  start = '5678'; assert.notEqual(proc.identity(8), 'boot-A:1234');
  boot = 'boot-B'; assert.equal(proc.identity(8), 'boot-B:5678');
  assert.equal(proc.findCodex(99), null);
});

test('child hooks keep the parent cwd and transcript while showing child progress', () => {
  const sessions = require('../headless/sessions').createSessions();
  const d = { session: 'codex:' + ID, rawSession: ID, provider: 'codex', cwd: home, project: 'root', transcript: 'root.jsonl' };
  sessions.event('idle', d);
  const child = mapHook({ session_id: ID, agent_id: SUB, hook_event_name: 'SubagentStop', cwd: 'child-dir', transcript_path: 'child.jsonl' });
  sessions.event('thinking', { ...child.body, session: d.session });
  const s = sessions.map.get(d.session);
  assert.equal(s.cwd, home);
  assert.equal(s.project, 'root');
  assert.equal(s.transcript, 'root.jsonl');
  assert.equal(s.state, 'thinking');
});
