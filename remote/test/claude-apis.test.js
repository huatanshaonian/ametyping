'use strict';
// Unit tests for the Claude Code API alias store (server/claude-apis.js): what the control panel sees, how a
// machine's variant wins over the shared settings, and that a key is never handed back to the browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaudeApis, UNCHANGED } = require('../server/claude-apis');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ame-apis-'));

test('shared settings, machine overrides, defaults and masked secrets', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const r = api.set({
    default: 'nebula',
    machines: { dell97: { default: 'deepseek' } },
    aliases: {
      nebula: { label: 'Nebula', proxy: 'inherit', settings: { env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'sk-nebula-secret', ANTHROPIC_MODEL: 'opus' } }, machines: {} },
      deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example', ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-secret' } }, machines: { dell97: { proxy: 'inherit', settings: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-dell-secret' } } } } },
    },
  });
  assert.equal(r.ok, true);
  const v = r.view;
  assert.equal(v.aliases.nebula.settings.env.ANTHROPIC_AUTH_TOKEN, UNCHANGED);
  assert.equal(v.aliases.deepseek.machines.dell97.settings.env.ANTHROPIC_AUTH_TOKEN, UNCHANGED);
  assert.equal(v.aliases.deepseek.settings.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  assert.equal(JSON.stringify(v).includes('sk-nebula-secret'), false);
  assert.equal(api.defaultFor('dell97'), 'deepseek');
  assert.equal(api.defaultFor('other'), 'nebula');
  const d = api.resolve('deepseek', 'dell97');
  assert.equal(d.proxy, 'inherit');
  assert.equal(d.settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-dell-secret');
  assert.equal(d.settings.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  const n = api.resolve('nebula', 'dell97');
  assert.equal(n.proxy, 'inherit');
  assert.equal(n.settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-nebula-secret');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'claude-apis.json')).mode & 0o777, 0o600);
});

test('UNCHANGED keeps a key; a machine placeholder that did not exist inherits shared', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const view = api.set({ default: 'deepseek', machines: {}, aliases: {
    deepseek: { label: 'DeepSeek', proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'sk-old' } }, machines: {} },
  } }).view;
  view.aliases.deepseek.machines.box = { proxy: 'inherit', settings: { env: { ANTHROPIC_AUTH_TOKEN: UNCHANGED, ANTHROPIC_BASE_URL: 'https://b' } } };
  const r = api.set(view);
  assert.equal(r.ok, true);
  const d = api.resolve('deepseek', 'box');
  assert.equal(d.settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-old');
  assert.equal(d.settings.env.ANTHROPIC_BASE_URL, 'https://b');
  // the machine did not really own the key: it is not frozen there
  assert.equal(Object.prototype.hasOwnProperty.call(api.view().aliases.deepseek.machines.box.settings.env, 'ANTHROPIC_AUTH_TOKEN'), false);
});

test('import uses the local settings, drops the local proxy, and sets the machine default', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const r = api.importSettings({ machine: 'dell97', alias: 'nebula', label: 'Nebula', proxy: 'inherit', scope: 'machine',
    settings: { env: { ANTHROPIC_BASE_URL: 'https://n', ANTHROPIC_AUTH_TOKEN: 'sk-n', HTTP_PROXY: 'http://127.0.0.1:1080', HTTPS_PROXY: 'http://127.0.0.1:1080' }, model: 'opus', permissions: { allow: [] }, hooks: { Stop: [] } } });
  assert.equal(r.ok, true);
  const d = api.resolve('nebula', 'dell97');
  assert.equal(d.proxy, 'inherit');
  assert.equal(d.settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-n');
  assert.equal(d.settings.env.HTTP_PROXY, undefined);
  assert.equal(d.settings.env.HTTPS_PROXY, undefined);
  assert.equal(d.settings.model, 'opus');
  assert.equal(d.settings.permissions, undefined);
  assert.equal(d.settings.hooks, undefined);
  assert.equal(api.defaultFor('dell97'), 'nebula');
});

test('a shared import applies to every machine, with the chosen proxy mode', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const r = api.importSettings({ machine: 'box', alias: 'deepseek', label: 'DeepSeek', proxy: 'direct', scope: 'shared',
    settings: { env: { ANTHROPIC_BASE_URL: 'https://d', ANTHROPIC_AUTH_TOKEN: 'sk-shared', HTTP_PROXY: 'http://local' } } });
  assert.equal(r.ok, true);
  assert.equal(api.resolve('deepseek', 'box').settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-shared');
  assert.equal(api.resolve('deepseek', 'another-machine').settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-shared');
  assert.equal(api.resolve('deepseek', 'another-machine').proxy, 'direct');
  assert.equal(api.resolve('deepseek', 'another-machine').settings.env.HTTP_PROXY, undefined);
  assert.equal(api.defaultFor('box'), 'deepseek');
});

test('custom auth headers and proxy passwords are masked too; saving the masked view keeps them', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.example',
    ANTHROPIC_AUTH_TOKEN: 'sk-abcdefgh123',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer abcdef',
    ANTHROPIC_EXTRA: 'x-api-key: hello',
    HTTP_PROXY: 'http://user:password@proxy.example:8080',
    HTTPS_PROXY: 'http://user:password@proxy.example:8080',
    SAFE: 'opus',
  };
  const r = api.set({ aliases: { a: { label: 'a', settings: { env } } } });
  const v = r.view.aliases.a.settings.env;
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_EXTRA', 'HTTP_PROXY', 'HTTPS_PROXY']) assert.equal(v[k], UNCHANGED, k);
  assert.equal(v.SAFE, 'opus');
  const s = JSON.stringify(r.view);
  assert.doesNotMatch(s, /sk-abcdefgh|Bearer abcdef|x-api-key|user:password/);
  api.set(r.view);
  const d = api.resolve('a', 'box');
  assert.equal(d.settings.env.ANTHROPIC_CUSTOM_HEADERS, 'Authorization: Bearer abcdef');
  assert.equal(d.settings.env.ANTHROPIC_EXTRA, 'x-api-key: hello');
  assert.equal(d.settings.env.HTTP_PROXY, 'http://user:password@proxy.example:8080');
  assert.equal(d.settings.env.SAFE, 'opus');
});

test('an explicit proxy with a password is masked too and restored on save', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  const r = api.set({ aliases: { a: { label: 'a', proxy: 'http://user:secret@proxy.example:8080',
    settings: { env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'sk-a' } },
    machines: { box: { proxy: 'http://u:secret@proxy2.example:8080', settings: { env: {} } } } } } });
  const v = r.view.aliases.a;
  assert.equal(v.proxy, UNCHANGED);
  assert.equal(v.machines.box.proxy, UNCHANGED);
  assert.doesNotMatch(JSON.stringify(r.view), /user:secret|u:secret/);
  api.set(r.view);
  assert.equal(api.resolve('a', 'box').proxy, 'http://u:secret@proxy2.example:8080');
  assert.equal(api.resolve('a', 'other').proxy, 'http://user:secret@proxy.example:8080');
  assert.equal(JSON.stringify(api.launchList('box')).includes('proxy'), false);
});

test('CLAUDE_CONFIG_DIR is dropped so every alias uses the default ~/.claude memory', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  api.set({ aliases: { a: { settings: { env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'sk-a', CLAUDE_CONFIG_DIR: 'C:\\elsewhere' } } } } });
  assert.equal('CLAUDE_CONFIG_DIR' in api.view().aliases.a.settings.env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in api.resolve('a', 'box').settings.env, false);
  api.importSettings({ machine: 'box', alias: 'b', settings: { env: { ANTHROPIC_BASE_URL: 'https://b', CLAUDE_CONFIG_DIR: 'C:\\other' } } });
  assert.equal('CLAUDE_CONFIG_DIR' in api.resolve('b', 'box').settings.env, false);
});

test('every save keeps an untouched original and timestamped copies', () => {
  const dir = tmp();
  const file = path.join(dir, 'claude-apis.json');
  fs.writeFileSync(file, JSON.stringify({ aliases: { a: { settings: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-original' } } } } }));
  const api = createClaudeApis({ dataDir: dir });
  api.set({ default: '', machines: {}, aliases: { a: { label: 'a', proxy: 'inherit', settings: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-new' } }, machines: {} } } });
  const bdir = path.join(dir, 'backups', 'claude-apis');
  const original = path.join(bdir, 'claude-apis.original.json');
  assert.equal(fs.existsSync(original), true);
  assert.match(fs.readFileSync(original, 'utf8'), /sk-original/);
  const copies = fs.readdirSync(bdir).filter((n) => /^claude-apis-.*\.json$/.test(n));
  assert.ok(copies.length >= 1 && copies.some((n) => fs.readFileSync(path.join(bdir, n), 'utf8').includes('sk-original')));
  assert.equal(api.view().backupDir, bdir);
  if (process.platform !== 'win32') assert.equal(fs.statSync(original).mode & 0o777, 0o600);
});

test('bad ids and malformed settings are refused without touching the saved file', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  assert.equal(api.set({ aliases: { 'bad id': { settings: {} } } }).ok, false);
  const r = api.set({ aliases: { ok: { settings: { env: { ANTHROPIC_AUTH_TOKEN: 'a\nb', ANTHROPIC_BASE_URL: 'https://ok' } } } } });
  assert.equal(r.ok, true);
  assert.equal(api.resolve('ok', 'box').settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(api.resolve('ok', 'box').settings.env.ANTHROPIC_BASE_URL, 'https://ok');
});

test('the launch list has names only, never a key or a base URL', () => {
  const dir = tmp();
  const api = createClaudeApis({ dataDir: dir });
  api.set({ aliases: { nebula: { label: 'Nebula', settings: { env: { ANTHROPIC_BASE_URL: 'https://n', ANTHROPIC_AUTH_TOKEN: 'sk-secret' } } } } });
  const l = api.launchList('dell97');
  assert.deepEqual(l.aliases.map((a) => a.id), ['nebula']);
  assert.equal(JSON.stringify(l).includes('sk-secret'), false);
  assert.equal(JSON.stringify(l).includes('https://n'), false);
});
