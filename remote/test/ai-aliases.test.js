'use strict';
// The NAS AI jobs with Claude Code API aliases: alias entries in the existing model select (no extra dropdown),
// resolve/pick keeps the alias, and ask() runs Claude Code with that alias's base URL / key / proxy mode.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAiSettings } = require('../server/ai/settings');
const { createAsk } = require('../server/ai/ask');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ame-ai-alias-'));
const catalog = (home) => {
  const dir = path.join(home, 'cache', 'model-catalog'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ fetchedAt: 1, catalog: { config: { models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', thinking: { effort_options: [{ id: 'low' }, { id: 'high' }] } },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main', thinking: { effort_options: [] } },
  ] } } }));
};
const stubApis = () => ({
  ids: () => ['deepseek', 'nebula'],
  resolve: (id, machine) => ({ id, label: id, proxy: id === 'deepseek' ? 'direct' : 'inherit',
    settings: { env: { ANTHROPIC_BASE_URL: `https://${id}.example`, ANTHROPIC_AUTH_TOKEN: `sk-${id}`, CLAUDE_CONFIG_DIR: 'C:\\other-memory' } } }),
});

test('a local entry offers its own default model, including DeepSeek bracket syntax', () => {
  const dir = tmp(), home = tmp(); catalog(home);
  const profiles = { ids: () => ['deepseek', 'nebula'], resolve: id => ({ id, local: true, proxy: 'direct',
    settings: { model: id === 'deepseek' ? 'deepseek-flash[1m]' : 'opus', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } } }) };
  const s = createAiSettings({ dataDir: dir, claudeHome: home, codexHome: tmp(), claudeApis: profiles });
  assert.equal(s.view().models.find(m => m.slug === 'api:deepseek:default').model, 'deepseek-flash[1m]');
  s.set({ default: { model: 'api:deepseek:default', effort: '' } });
  assert.equal(s.pick('ask').model, 'deepseek-flash[1m]');
  assert.equal(s.pick('ask').api, 'deepseek');
});

test('alias entries appear in the existing model list and pick keeps the alias', () => {
  const dir = tmp(), home = tmp(); catalog(home);
  const s = createAiSettings({ dataDir: dir, claudeHome: home, codexHome: tmp(), fallbackModel: 'gpt-6-luna', claudeApis: stubApis(), machine: 'nas' });
  const v = s.view();
  const d = v.models.find((m) => m.api === 'deepseek' && m.model === 'claude-opus-5-5');
  assert.ok(d && d.slug === 'api:deepseek:claude-opus-5-5' && d.name === 'claude-deepseek · Opus 5.5');
  assert.ok(v.models.some((m) => m.api === 'nebula' && m.model === 'claude-opus-5-5'));
  s.set({ default: { model: 'api:deepseek:claude-opus-5-5', effort: 'high' } });
  const use = s.pick('ask');
  assert.equal(use.model, 'claude-opus-5-5');
  assert.equal(use.provider, 'claude');
  assert.equal(use.api, 'deepseek');
  assert.equal(use.effort, 'high');
  // the same base model on another alias is still a different backup
  s.set({ backup: { model: 'api:nebula:claude-opus-5-5', effort: '' } });
  const u2 = s.pick('ask');
  assert.equal(u2.backup && u2.backup.api, 'nebula');
  assert.equal(u2.backup && u2.backup.model, 'claude-opus-5-5');
});

test('ask() runs Claude Code with the alias env and direct proxy clearing', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'claude.js');
  const log = path.join(dir, 'env.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({args:process.argv.slice(2), env:process.env}));
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'{}'})+'\\n');
`);
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.HTTP_PROXY = 'http://should-be-gone:1';
  const asker = createAsk({
    codex: { bin: process.execPath, timeoutMs: 10000 },
    claude: { bin: [process.execPath, fake], timeoutMs: 10000 },
    api: null, egress: null,
    pick: () => ({ model: 'claude-opus-5-5', effort: '', provider: 'claude', api: 'deepseek', backup: null }),
    claudeApis: stubApis(), machine: 'nas', log: () => {},
  });
  const r = await asker.ask('hi', { type: 'object' }, 'ask');
  assert.deepEqual(r, {});
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://deepseek.example');
  assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek');
  assert.equal(got.env.HTTP_PROXY, undefined);
  assert.equal(got.env.NO_PROXY, '*');
  assert.equal(got.env.CLAUDE_CONFIG_DIR, undefined);
  assert.ok(got.args.includes('--model') && got.args.includes('claude-opus-5-5'));
  delete process.env.FAKE_CLAUDE_LOG; delete process.env.HTTP_PROXY;
});

test('ask() with inherit and no egress keeps the process proxy', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'claude.js');
  const log = path.join(dir, 'env.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({args:process.argv.slice(2), env:process.env}));
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'{}'})+'\\n');
`);
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.HTTP_PROXY = 'http://keep-me:1';
  const asker = createAsk({
    codex: { bin: process.execPath, timeoutMs: 10000 },
    claude: { bin: [process.execPath, fake], timeoutMs: 10000 },
    api: null, egress: null,
    pick: () => ({ model: 'claude-opus-5-5', effort: '', provider: 'claude', api: 'nebula', backup: null }),
    claudeApis: stubApis(), machine: 'nas', log: () => {},
  });
  await asker.ask('hi', { type: 'object' }, 'ask');
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.HTTP_PROXY, 'http://keep-me:1');
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://nebula.example');
  delete process.env.FAKE_CLAUDE_LOG; delete process.env.HTTP_PROXY;
});

test('ask() with an explicit proxy replaces an inherited NO_PROXY=*', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'claude.js');
  const log = path.join(dir, 'env.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({args:process.argv.slice(2), env:process.env}));
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'{}'})+'\\n');
`);
  process.env.FAKE_CLAUDE_LOG = log;
  process.env.NO_PROXY = '*';
  const apis = { ids: () => ['explicit'], resolve: () => ({ id: 'explicit', proxy: 'http://explicit.example:8080',
    settings: { env: { ANTHROPIC_BASE_URL: 'https://explicit.example', ANTHROPIC_AUTH_TOKEN: 'sk-explicit' } } }) };
  const asker = createAsk({
    codex: { bin: process.execPath, timeoutMs: 10000 },
    claude: { bin: [process.execPath, fake], timeoutMs: 10000 },
    api: null, egress: null,
    pick: () => ({ model: 'claude-opus-5-5', effort: '', provider: 'claude', api: 'explicit', backup: null }),
    claudeApis: apis, machine: 'nas', log: () => {},
  });
  await asker.ask('hi', { type: 'object' }, 'ask');
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(got.env.HTTP_PROXY, 'http://explicit.example:8080');
  assert.equal(got.env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://explicit.example');
  delete process.env.FAKE_CLAUDE_LOG; delete process.env.NO_PROXY;
});

test('ask() with inherit picks the proxy of the alias host', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'claude.js');
  const log = path.join(dir, 'env.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({args:process.argv.slice(2), env:process.env}));
process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'{}'})+'\\n');
`);
  process.env.FAKE_CLAUDE_LOG = log;
  let seen = '';
  const egress = { pick: async (host) => { seen = host; return 'http://proxy.example:8080'; },
    env: (url, base = {}) => ({ ...base, HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1' }), forget: () => {} };
  const asker = createAsk({
    codex: { bin: process.execPath, timeoutMs: 10000 },
    claude: { bin: [process.execPath, fake], timeoutMs: 10000 },
    api: null, egress,
    pick: () => ({ model: 'claude-opus-5-5', effort: '', provider: 'claude', api: 'nebula', backup: null }),
    claudeApis: stubApis(), machine: 'nas', log: () => {},
  });
  await asker.ask('hi', { type: 'object' }, 'ask');
  const got = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(seen, 'nebula.example');
  assert.equal(got.env.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://nebula.example');
  delete process.env.FAKE_CLAUDE_LOG;
});
