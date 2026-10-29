'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createProfiles } = require('../agent/claude-profiles');
function fixture(platform = 'linux') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-cc-profiles-')), root = path.join(home, 'cc-environments');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const shared = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'shared-hook' }] }] },
    permissions: { allow: ['Read'] }, env: { ANTHROPIC_AUTH_TOKEN: 'shared-old-token', HTTP_PROXY: 'http://old-proxy:1' } });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), shared);
  fs.writeFileSync(path.join(home, '.claude.json'), '{"history":"shared"}');
  const write = (name, j) => { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(j)); };
  write('apinebula', { env: { ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'nebula-token', HTTPS_PROXY: 'http://localhost:10808' }, model: 'opus' });
  write('deepseek', { env: { ANTHROPIC_BASE_URL: 'https://deepseek.example/anthropic', ANTHROPIC_API_KEY: 'deepseek-key' }, model: 'deepseek-flash[1m]', unrelated: { keep: true } });
  return { home, root, api: createProfiles({ home, root, platform }), shared };
}
test('discovers both independent files and publishes metadata without keys', () => {
  const f = fixture(), v = f.api.list();
  assert.deepEqual(v.aliases.map(p => p.id), ['deepseek', 'nebula']);
  assert.match(v.profiles.find(p => p.id === 'nebula').file, /apinebula/);
  assert.equal(v.profiles.find(p => p.id === 'deepseek').model, 'deepseek-flash[1m]');
  assert.doesNotMatch(JSON.stringify(v), /nebula-token|deepseek-key|shared-old-token/);
});
test('runtime overlays provider values and clears previous API/cloud/proxy state', () => {
  const f = fixture();
  const r = f.api.runtime('deepseek', { ANTHROPIC_AUTH_TOKEN: 'previous-token', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: stale',
    HTTPS_PROXY: 'http://previous:1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CONFIG_DIR: '/other-history' });
  try {
    const overlay = JSON.parse(fs.readFileSync(r.file));
    assert.equal(r.env.ANTHROPIC_API_KEY, 'deepseek-key');
    assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(r.env.HTTPS_PROXY, undefined);
    assert.equal(r.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(r.env.CLAUDE_CODE_USE_VERTEX, undefined);
    assert.equal(r.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(r.env.AME_CLAUDE_API, 'deepseek');
    assert.equal(overlay.env.ANTHROPIC_AUTH_TOKEN, '');
    assert.equal(overlay.model, 'deepseek-flash[1m]');
    assert.equal(overlay.hooks, undefined);
    assert.ok(r.args.includes('user,project,local'));
    assert.deepEqual(r.args.slice(-2), ['--model', 'deepseek-flash[1m]']);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8'), f.shared);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8'), '{"history":"shared"}');
    if (process.platform !== 'win32') assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  } finally { r.cleanup(); }
  assert.equal(fs.existsSync(r.file), false);
});
test('Windows delegates to the existing unified launcher with project and resume arguments', () => {
  const f = fixture('win32'), file = path.join(f.root, 'Start-CC.ps1');
  fs.writeFileSync(file, '# Existing user launcher');
  const r = f.api.command('nebula', { cwd: f.home, args: ['--resume', 'record-id'] });
  assert.equal(r.exe, 'powershell.exe');
  const cmd = Buffer.from(r.args[r.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.ok(cmd.includes(file));
  assert.match(cmd, /-EnvironmentName 'apinebula'/);
  assert.ok(cmd.includes("-ProjectDir '" + f.home + "'"));
  assert.match(cmd, /-ClaudeArgs @\('--resume','record-id'\)/);
  assert.equal(r.env.AME_CLAUDE_API, 'nebula');
  f.api.install();
  assert.equal(fs.readFileSync(file, 'utf8'), '# Existing user launcher');
});
test('installation preserves user-owned commands and both profile sources', () => {
  const f = fixture('win32'), bin = path.join(f.home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const command = path.join(bin, 'claude-deepseek.cmd');
  fs.writeFileSync(command, '@echo user-owned');
  const source = fs.readFileSync(path.join(f.root, 'deepseek/settings.json'), 'utf8');
  f.api.install();
  assert.equal(fs.readFileSync(command, 'utf8'), '@echo user-owned');
  assert.equal(fs.readFileSync(path.join(f.root, 'deepseek/settings.json'), 'utf8'), source);
});
test('saving updates the selected local profile, preserves blank key, and backs up the original', () => {
  const f = fixture(), before = fs.readFileSync(path.join(f.root, 'deepseek/settings.json'), 'utf8');
  const r = f.api.save({ id: 'deepseek', baseUrl: 'https://new.example/anthropic', model: 'new-model', key: '', network: 'direct' });
  assert.equal(r.ok, true, r.msg);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'deepseek/settings.json')));
  assert.equal(saved.env.ANTHROPIC_API_KEY, 'deepseek-key');
  assert.equal(saved.unrelated.keep, true);
  const backup = fs.readdirSync(path.join(f.root, 'backups/deepseek'))[0];
  assert.equal(fs.readFileSync(path.join(f.root, 'backups/deepseek', backup), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.home, '.claude/settings.json'), 'utf8'), f.shared);
  assert.doesNotMatch(JSON.stringify(r), /deepseek-key/);
});
test('new key and proxy edits are local and masked in responses', () => {
  const f = fixture();
  const r = f.api.save({ id: 'nebula', baseUrl: 'https://n.example', model: 'opus', key: 'new-credential', network: 'proxy', proxy: 'http://u:password@proxy.example:8080' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.profile.proxy, '__UNCHANGED__');
  assert.doesNotMatch(JSON.stringify(r), /new-credential|password/);
  const r2 = f.api.save({ id: 'nebula', baseUrl: 'https://n.example', model: 'opus', key: '', network: 'proxy', proxy: '__UNCHANGED__' });
  assert.equal(r2.ok, true, r2.msg);
  assert.equal(f.api.resolve('nebula').settings.env.ANTHROPIC_AUTH_TOKEN, 'new-credential');
});
test('invalid IDs and missing entries fail without creating alternate history or falling back', () => {
  const f = fixture();
  assert.throws(() => f.api.resolve('../outside'));
  assert.throws(() => f.api.resolve('missing'));
  assert.equal(f.api.save({ id: '../outside', baseUrl: 'https://a', model: 'm', network: 'direct' }).ok, false);
  assert.equal(f.api.save({ id: 'runtime', baseUrl: 'https://a', model: 'm', network: 'direct' }).ok, false);
  assert.equal(fs.existsSync(path.join(f.home, 'outside')), false);
});
test('hook detection recognizes existing native entries without changing their launchers', () => {
  const f = fixture();
  assert.equal(f.api.infer({ ANTHROPIC_BASE_URL: 'https://nebula.example', ANTHROPIC_AUTH_TOKEN: 'nebula-token' }), 'nebula');
  assert.equal(f.api.infer({ ANTHROPIC_BASE_URL: 'https://deepseek.example/anthropic', ANTHROPIC_API_KEY: 'deepseek-key' }), 'deepseek');
  assert.equal(f.api.infer({ ANTHROPIC_BASE_URL: 'https://unknown.example', ANTHROPIC_API_KEY: 'other' }), '');
});
