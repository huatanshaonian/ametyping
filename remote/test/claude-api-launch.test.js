'use strict';
// The terminal wrapper's launcher: it reads the machine's local alias copy, writes the settings to a 0600 temp file,
// clears the proxy for `direct`, marks AME_CLAUDE_API, and runs `claude --settings <file> ...`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const LAUNCHER = path.resolve(__dirname, '..', 'agent', 'claude-api-launch.js');
const WIN = process.platform === 'win32';
// an empty base for the tests that do not exercise the machine's own settings
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-base-'));
const baseFile = path.join(baseDir, 'settings.json');
fs.writeFileSync(baseFile, '{}');
process.env.AME_CLAUDE_SETTINGS = baseFile;
const fake = (dir) => {
  const script = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(script, `const fs=require('fs');
const args=process.argv.slice(2);
const i=args.indexOf('--settings');
const settings=i>=0?fs.readFileSync(args[i+1],'utf8'):'';
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({args, settings, env:{ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN,HTTP_PROXY:process.env.HTTP_PROXY,NO_PROXY:process.env.NO_PROXY,AME_CLAUDE_API:process.env.AME_CLAUDE_API}}));
`);
  const bin = path.join(dir, WIN ? 'claude.cmd' : 'claude');
  fs.writeFileSync(bin, WIN
    ? `@echo off\r\nnode "%FAKE_LOG_SCRIPT%" %*\r\n`
    : `#!/bin/sh\nexec node "$FAKE_LOG_SCRIPT" "$@"\n`, { mode: 0o755 });
  if (!WIN) fs.chmodSync(bin, 0o755);
  return { script, bin };
};

test('direct: temp settings, proxy cleared, AME_CLAUDE_API, arguments passed through', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-work-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    machine: 'box', default: 'deepseek',
    aliases: { deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deep' } } } },
  }), { mode: 0o600 });
  const log = path.join(dir, 'log.json');
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'deepseek', '--resume', 'abc'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: log, FAKE_LOG_SCRIPT: f.script, HTTP_PROXY: 'http://should-be-gone:1', NO_PROXY: 'localhost' },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, 'sk-deep');
  assert.equal(got.env.HTTP_PROXY, undefined);
  assert.equal(got.env.NO_PROXY, '*');
  assert.equal(got.env.AME_CLAUDE_API, 'deepseek');
  assert.deepEqual(got.args.slice(-2), ['--resume', 'abc']);
  const i = got.args.indexOf('--settings');
  assert.ok(i >= 0);
  const temp = got.args[i + 1];
  assert.equal(fs.existsSync(temp), false, 'the temp settings file is removed when claude exits');
  const settings = JSON.parse(got.settings);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-deep');
  assert.equal(settings.env.HTTP_PROXY, '');
  assert.equal(settings.env.NO_PROXY, '*');
});

test('inherit leaves the proxy environment alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-work-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    machine: 'box', default: 'nebula',
    aliases: { nebula: { label: 'Nebula', proxy: 'inherit', settings: { env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'sk-neb' } } } },
  }));
  const log = path.join(dir, 'log.json');
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'nebula'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: log, FAKE_LOG_SCRIPT: f.script, HTTP_PROXY: 'http://keep-me:1' },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.HTTP_PROXY, 'http://keep-me:1');
  assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, 'sk-neb');
  assert.deepEqual(got.args, ['--settings', got.args[1]]);
});

test('the machine\'s own settings stay the base (proxy and model), the alias only overrides the API', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-work-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  const base = path.join(dir, 'base.json');
  fs.writeFileSync(base, JSON.stringify({ env: { HTTP_PROXY: 'http://base-proxy:1', ANTHROPIC_AUTH_TOKEN: 'base-token', ANTHROPIC_BASE_URL: 'https://base.example', CLAUDE_CONFIG_DIR: 'C:\\other-memory' }, model: 'base-model' }));
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    machine: 'box', default: 'nebula',
    aliases: { nebula: { label: 'Nebula', proxy: 'inherit', settings: { env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'sk-neb', CLAUDE_CONFIG_DIR: 'C:\\other-memory' } } } },
  }));
  const log = path.join(dir, 'log.json');
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'nebula'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: log, FAKE_LOG_SCRIPT: f.script, AME_CLAUDE_SETTINGS: base },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  const settings = JSON.parse(got.settings);
  assert.equal(settings.env.HTTP_PROXY, 'http://base-proxy:1');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-neb');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://nebula.example');
  assert.equal(settings.model, 'base-model');
  assert.equal('CLAUDE_CONFIG_DIR' in settings.env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in got.env, false);
  assert.equal(got.env.AME_CLAUDE_API, 'nebula');
});

test('claude.cmd: a prompt with & stays one argument and is not executed by cmd', () => {
  if (!WIN) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-work-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    aliases: { deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deep' } } } },
  }));
  const log = path.join(dir, 'log.json'), marker = path.join(dir, 'injected.txt');
  const prompt = `x & echo INJECTED > ${marker}`;
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'deepseek', prompt], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: log, FAKE_LOG_SCRIPT: f.script },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.ok(got.args.includes(prompt), JSON.stringify(got.args));
  assert.equal(fs.existsSync(marker), false, 'the & part was executed');
});

test('claude.cmd: a parameter cmd would expand (%) is refused', () => {
  if (!WIN) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    aliases: { deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deep' } } } },
  }));
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'deepseek', '100% done'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: path.join(dir, 'log.json'), FAKE_LOG_SCRIPT: f.script },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /claude\.cmd 不能安全传递/);
});

test('explicit proxy: an inherited NO_PROXY=* is replaced, so the proxy is used', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-work-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-bin-'));
  const f = fake(dir);
  const base = path.join(dir, 'base.json');
  fs.writeFileSync(base, JSON.stringify({ env: { NO_PROXY: '*', ANTHROPIC_AUTH_TOKEN: 'base-token' } }));
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({
    aliases: { proxy: { label: 'Proxy', proxy: 'http://proxy.example:8080', settings: { env: { ANTHROPIC_BASE_URL: 'https://p.example', ANTHROPIC_AUTH_TOKEN: 'sk-p' } } } },
  }));
  const log = path.join(dir, 'log.json');
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'proxy'], {
    cwd: work, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home, AME_CLAUDE_BIN: f.bin, FAKE_LOG: log, FAKE_LOG_SCRIPT: f.script, AME_CLAUDE_SETTINGS: base, NO_PROXY: '*' },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(got.env.HTTP_PROXY, 'http://proxy.example:8080');
  const settings = JSON.parse(got.settings);
  assert.equal(settings.env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(settings.env.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-p');
});

test('an alias this machine does not have is refused', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-launch-home-'));
  fs.mkdirSync(path.join(home, '.ametyping'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ametyping', 'claude-apis.local.json'), JSON.stringify({ aliases: {} }));
  const r = cp.spawnSync(process.execPath, [LAUNCHER, 'missing'], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, USERPROFILE: home, HOME: home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /没有别名 missing/);
});
