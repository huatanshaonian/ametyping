'use strict';
// Windows quick launch (app/remote-control.js): the alias's settings go into a 0600 temp file passed as
// `--settings`, AME_CLAUDE_API marks the session for the hook, and `direct` removes the proxy launch.ps1 may set.
// The bridge is faked: nothing is really started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRemoteControl } = require('../../app/remote-control');
const { envForProxy } = require('../../app/claude-api');

const api = (proxy) => ({ id: 'deepseek', label: 'DeepSeek', proxy, settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-test-secret' } } });

function rcWith(calls) {
  const bridge = {
    launch: async (exe, args, cwd) => { calls.push({ exe, args, cwd }); return 4321; },
    screen: async () => null,
    key: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    ancestors: async () => [],
    identity: async () => null,
  };
  return createRemoteControl({
    sessions: new Map(), permissions: { list: () => [] }, bridge, procAlive: async () => false,
    pushBubble: () => {}, home: () => os.homedir(), onBtw: () => {},
  });
}
const decode = (call) => {
  const i = call.args.indexOf('-EncodedCommand');
  assert.ok(i >= 0 && call.args[i + 1], JSON.stringify(call.args));
  return Buffer.from(call.args[i + 1], 'base64').toString('utf16le');
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-win-launch-'));
// the machine's own settings are the base; the alias overlays its API values
const baseFile = path.join(tmp, 'base-settings.json');
fs.writeFileSync(baseFile, JSON.stringify({
  env: { HTTP_PROXY: 'http://base-proxy:1', HTTPS_PROXY: 'http://base-proxy:1', NO_PROXY: '*', ANTHROPIC_AUTH_TOKEN: 'base-token', ANTHROPIC_BASE_URL: 'https://base.example', CLAUDE_CONFIG_DIR: 'C:\\other-memory' },
  model: 'base-model',
}));
process.env.AME_CLAUDE_SETTINGS = baseFile;

test('a direct alias: --settings file, AME_CLAUDE_API, proxy removed after launch.ps1', async () => {
  const calls = [];
  const rc = rcWith(calls);
  const r = await rc.launch(tmp, '第一句话', '', 'claude', api('direct'));
  assert.equal(r.ok, true, r.msg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'powershell.exe');
  const cmd = decode(calls[0]);
  const m = /'--settings' '([^']+)'/.exec(cmd);
  assert.ok(m, cmd);
  assert.equal(fs.existsSync(m[1]), true);
  const settings = JSON.parse(fs.readFileSync(m[1], 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-secret');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  assert.equal(settings.env.HTTP_PROXY, '');
  assert.equal(settings.env.NO_PROXY, '*');
  assert.equal(settings.model, 'base-model');                        // the machine's base is kept
  assert.match(cmd, /\$env:AME_CLAUDE_API='deepseek'/);
  assert.match(cmd, /Remove-Item Env:/);
  assert.match(cmd, /Remove-Item Env:CLAUDE_CONFIG_DIR/);
  assert.equal('CLAUDE_CONFIG_DIR' in settings.env, false);
  assert.match(cmd, /'第一句话'/);
  try { fs.unlinkSync(m[1]); } catch {}
});

test('envForProxy for a background resume also clears NO_PROXY=* for an explicit proxy', () => {
  const e = envForProxy({ id: 'x', proxy: 'http://proxy.example:8080', settings: { env: {} } }, { NO_PROXY: '*', HTTP_PROXY: 'http://old:1', CLAUDE_CONFIG_DIR: 'C:\\other-memory' });
  assert.equal(e.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(e.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(e.AME_CLAUDE_API, 'x');
  assert.equal('CLAUDE_CONFIG_DIR' in e, false);
});

test('an explicit proxy clears an inherited NO_PROXY=* so it is actually used', async () => {
  const calls = [];
  const rc = rcWith(calls);
  const r = await rc.launch(tmp, '', '', 'claude', { id: 'explicit', label: 'Explicit', proxy: 'http://proxy.example:8080',
    settings: { env: { ANTHROPIC_BASE_URL: 'https://explicit.example', ANTHROPIC_AUTH_TOKEN: 'sk-exp' } } });
  assert.equal(r.ok, true, r.msg);
  const cmd = decode(calls[0]);
  assert.match(cmd, /\$env:NO_PROXY='localhost,127\.0\.0\.1'/);
  const m = /'--settings' '([^']+)'/.exec(cmd);
  assert.ok(m);
  const settings = JSON.parse(fs.readFileSync(m[1], 'utf8'));
  assert.equal(settings.env.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(settings.env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-exp');
  try { fs.unlinkSync(m[1]); } catch {}
});

test('an inherit alias leaves the proxy alone', async () => {
  const calls = [];
  const rc = rcWith(calls);
  const r = await rc.launch(tmp, '', '', 'claude', api('inherit'));
  assert.equal(r.ok, true, r.msg);
  const cmd = decode(calls[0]);
  assert.doesNotMatch(cmd, /Remove-Item Env:HTTP_PROXY/);              // the proxy stays
  assert.match(cmd, /Remove-Item Env:CLAUDE_CONFIG_DIR/);              // memory always defaults
  const m = /'--settings' '([^']+)'/.exec(cmd);
  assert.ok(m);
  const settings = JSON.parse(fs.readFileSync(m[1], 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-secret');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  assert.equal(settings.env.HTTP_PROXY, 'http://base-proxy:1');     // inherited from the machine
  assert.equal(settings.model, 'base-model');
  try { fs.unlinkSync(m[1]); } catch {}
});
