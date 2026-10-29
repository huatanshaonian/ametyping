'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { EventEmitter } = require('events');
const { resumePlan } = require('../../app/claude-api');
let capture = null;
const spawn = cp.spawn;
cp.spawn = (exe, args, opts) => {
  if (!capture) return spawn(exe, args, opts);
  Object.assign(capture, { exe, args, opts });
  const p = new EventEmitter(); p.pid = 1234; p.stdin = new EventEmitter(); p.stdin.end = () => {};
  capture.child = p; return p;
};
test.after(() => { cp.spawn = spawn; });
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-resume-')), root = path.join(home, 'cc-environments');
  fs.mkdirSync(path.join(root, 'deepseek'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deepseek/settings.json'), JSON.stringify({ model: 'deepseek-flash[1m]',
    env: { ANTHROPIC_BASE_URL: 'https://d.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'invented-key' } }));
  const old = process.env.AME_CC_HOME; process.env.AME_CC_HOME = root;
  return { home, root, restore() { if (old === undefined) delete process.env.AME_CC_HOME; else process.env.AME_CC_HOME = old; } };
}
test('missing entry stops without consulting the obsolete mirror', () => {
  const f = setup();
  try { const p = resumePlan('gone'); assert.equal(p.ok, false); assert.match(p.msg, /没有 claude-gone/); }
  finally { f.restore(); }
});
test('Windows background plan uses the existing Start-CC launcher and marks the profile', () => {
  const f = setup();
  try {
    fs.writeFileSync(path.join(f.root, 'Start-CC.ps1'), '# user launcher');
    if (process.platform !== 'win32') return;
    const p = resumePlan('deepseek', {}, { cwd: f.home, args: ['-p', '--resume', 'record'] });
    assert.equal(p.ok, true, p.msg); assert.equal(p.command.exe, 'powershell.exe');
    const cmd = Buffer.from(p.command.args[p.command.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.ok(cmd.includes('deepseek')); assert.ok(cmd.includes(f.home));
    assert.match(cmd, /-ClaudeArgs @\('-p','--resume','record'\)/);
    assert.equal(p.env.AME_CLAUDE_API, 'deepseek');
    assert.doesNotMatch(p.command.args.join(' '), /invented-key/);
  } finally { f.restore(); }
});
test('Windows background reply rejects missing entry; valid entry spawns only its launcher', { skip: process.platform !== 'win32' }, async () => {
  const f = setup(), oldPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(f.root, 'Start-CC.ps1'), '# user launcher');
    const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude.exe'), '');
    process.env.PATH = bin;
    const { createRemoteControl } = require('../../app/remote-control');
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    const s = { id, provider: 'claude', state: 'ended', api: 'gone', cwd: f.home };
    const rc = createRemoteControl({ sessions: new Map([[id, s]]), permissions: { list: () => [] }, bridge: {},
      procAlive: async () => false, pushBubble() {}, home: () => f.home });
    capture = {};
    assert.equal((await rc.chatSend(id, 'fixture')).ok, false); assert.equal(capture.exe, undefined);
    s.api = 'deepseek';
    assert.equal((await rc.chatSend(id, 'fixture')).ok, true);
    assert.equal(capture.exe, 'powershell.exe');
    const cmd = Buffer.from(capture.args[capture.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.ok(cmd.includes(path.join(f.root, 'Start-CC.ps1')));
    capture.child.emit('close');
  } finally { capture = null; process.env.PATH = oldPath; f.restore(); }
});
test('Linux background execution accepts the complete provider plan, including model and settings sources', () => {
  const { resume } = require('../../headless/resume');
  const command = { exe: '/fixture/claude', args: ['--settings', '/fixture/runtime.json', '--setting-sources',
    'user,project,local', '--model', 'deepseek-flash[1m]', '-p', '--resume', 'record'] };
  capture = {};
  try {
    assert.equal(resume('record', os.tmpdir(), {}, 'prompt', () => {}, false, '', command).ok, true);
    assert.equal(capture.exe, command.exe); assert.deepEqual(capture.args, command.args);
  } finally { capture = null; }
});
