'use strict';
// Background resumes must use the session's alias or stop -- never start an unmarked Claude that would use the machine's
// base API while the session still says another alias. Also covers the Linux resume's --settings plumbing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { resumePlan } = require('../../app/claude-api');

const WIN = process.platform === 'win32';
let capture = null;                       // the next spawn is recorded here (the modules capture this dispatcher once)
const origSpawn = cp.spawn;
cp.spawn = (exe, args, opts) => {
  if (!capture) return origSpawn(exe, args, opts);
  const c = capture;
  c.exe = exe; c.args = args; c.opts = opts;
  const p = new EventEmitter();
  p.pid = 1234; p.kill = () => {};
  p.stdin = new EventEmitter(); p.stdin.end = (text) => { c.text = text; };
  c.p = p;
  return p;
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-resume-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  const base = path.join(dir, 'base.json'); fs.writeFileSync(base, '{}');
  const mirror = path.join(home, '.ametyping', 'claude-apis.local.json');
  const tmp = path.join(home, '.ametyping', 'tmp');
  return { dir, home, base, mirror, tmp };
}
function withEnv(env, fn) {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

test('resumePlan: a missing alias stops instead of using the machine API', async () => {
  const s = setup();
  fs.writeFileSync(s.mirror, JSON.stringify({ aliases: {} }));
  await withEnv({ AME_CLAUDE_MIRROR: s.mirror, AME_CLAUDE_TMP: s.tmp, AME_CLAUDE_SETTINGS: s.base }, () => {
    const r = resumePlan('gone');
    assert.equal(r.ok, false);
    assert.match(r.msg, /不可用/);
  });
});

test('resumePlan: a settings file that cannot be written stops instead of continuing unmarked', async () => {
  const s = setup();
  fs.writeFileSync(s.mirror, JSON.stringify({ aliases: { deepseek: { proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://d', ANTHROPIC_AUTH_TOKEN: 'sk-d' } } } } }));
  fs.writeFileSync(path.join(s.dir, 'not-a-dir'), 'x');
  await withEnv({ AME_CLAUDE_MIRROR: s.mirror, AME_CLAUDE_TMP: path.join(s.dir, 'not-a-dir', 'tmp'), AME_CLAUDE_SETTINGS: s.base }, () => {
    const r = resumePlan('deepseek');
    assert.equal(r.ok, false);
    assert.match(r.msg, /写 API 设置失败/);
  });
});

test('resumePlan: a known alias gives the settings file and the alias environment', async () => {
  const s = setup();
  fs.writeFileSync(s.mirror, JSON.stringify({ aliases: { deepseek: { proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://d', ANTHROPIC_AUTH_TOKEN: 'sk-d' } } } } }));
  await withEnv({ AME_CLAUDE_MIRROR: s.mirror, AME_CLAUDE_TMP: s.tmp, AME_CLAUDE_SETTINGS: s.base }, () => {
    const r = resumePlan('deepseek');
    assert.equal(r.ok, true);
    assert.ok(r.sf && fs.existsSync(r.sf.file));
    assert.equal(r.env.AME_CLAUDE_API, 'deepseek');
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'sk-d');
    const settings = JSON.parse(fs.readFileSync(r.sf.file, 'utf8'));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://d');
    r.sf.cleanup();
  });
});

test('Windows background resume: missing alias never spawns; a known alias spawns with --settings', { skip: !WIN }, async () => {
  const s = setup();
  fs.writeFileSync(s.mirror, JSON.stringify({ aliases: {} }));
  const bin = path.join(s.dir, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude.exe'), '');
  const env = { AME_CLAUDE_MIRROR: s.mirror, AME_CLAUDE_TMP: s.tmp, AME_CLAUDE_SETTINGS: s.base, PATH: bin + path.delimiter + process.env.PATH };
  await withEnv(env, async () => {
    const { createRemoteControl } = require('../../app/remote-control');
    const id1 = 'aaaaaaaa-1111-2222-3333-444444444444', id2 = 'bbbbbbbb-1111-2222-3333-444444444444';
    const s1 = { id: id1, provider: 'claude', state: 'ended', claudePid: null, api: 'gone', cwd: s.dir };
    const s2 = { id: id2, provider: 'claude', state: 'ended', claudePid: null, api: 'deepseek', cwd: s.dir };
    const rc = createRemoteControl({ sessions: new Map([[id1, s1], [id2, s2]]), permissions: { list: () => [] }, bridge: {}, procAlive: async () => false, pushBubble: () => {}, home: () => s.home });
    capture = {};
    const r1 = await rc.chatSend(id1, 'hi');
    assert.equal(r1.ok, false);
    assert.match(r1.msg, /不可用/);
    assert.equal(capture.exe, undefined, 'spawn must not be called');
    fs.writeFileSync(s.mirror, JSON.stringify({ aliases: { deepseek: { proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://d', ANTHROPIC_AUTH_TOKEN: 'sk-d' } } } } }));
    capture = {};
    const r2 = await rc.chatSend(id2, 'hi');
    assert.equal(r2.ok, true, r2.msg);
    const i = capture.args.indexOf('--settings');
    assert.ok(i >= 0);
    assert.equal(capture.opts.env.AME_CLAUDE_API, 'deepseek');
    assert.equal(capture.opts.env.ANTHROPIC_AUTH_TOKEN, 'sk-d');
    const settings = JSON.parse(fs.readFileSync(capture.args[i + 1], 'utf8'));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://d');
    capture.p.emit('exit'); capture.p.emit('close');
    capture = null;
  });
});

test('Linux resume: --settings goes before -p --resume, with the environment passed', async () => {
  const s = setup();
  const bin = path.join(s.dir, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude'), '');
  const settings = path.join(s.dir, 'alias.json');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, AME_CLAUDE_API: 'deepseek' };
  const { resume } = require('../../headless/resume');
  capture = {};
  const r = resume('aaaaaaaa-1111-2222-3333-444444444444', s.dir, env, 'hello', () => {}, false, settings);
  assert.equal(r.ok, true);
  assert.deepEqual(capture.args.slice(0, 2), ['--settings', settings]);
  assert.deepEqual(capture.args.slice(-3), ['-p', '--resume', 'aaaaaaaa-1111-2222-3333-444444444444']);
  assert.equal(capture.opts.env, env);
  assert.equal(capture.text, 'hello');
  capture = null;
});
