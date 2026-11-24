'use strict';
// 设备更新 & 一键配置: agent/fleet.js + agent/update-guard.js (version, staging, apply, restart guard and rollback),
// agent/agent-config.js (Claude Code / Codex / OpenCode files), server/fleet (the orchestration over a fake agent
// socket that runs the real agent modules in temp folders) and server/fleet/magpie-keys.js (against a fake Magpie).
// Nothing real is touched: every home, repository and server lives in a temp folder.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const { createFleet: createAgentFleet, blobId } = require('../agent/fleet');
const { guard } = require('../agent/update-guard');
const { createAgentConfig, withBypass } = require('../agent/agent-config');
const { createHarness, readNet, writeNet, proxyFor } = require('../agent/harness');
const { createFleet: createServerFleet } = require('../server/fleet');
const { createMagpieKeys } = require('../server/fleet/magpie-keys');

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'ame-fleet-' + t + '-'));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const C1 = 'a'.repeat(40), C2 = 'b'.repeat(40);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// ---------- agent: version ----------
test('files mode: the version comes from .ame-version.json; outside systemd it does not update itself', async () => {
  const root = tmp('root'), home = tmp('home');
  write(path.join(root, '.ame-version.json'), JSON.stringify({ commit: C1 }));
  const under = await createAgentFleet({ root, home, platform: 'linux', env: { INVOCATION_ID: 'x' } }).version();
  assert.equal(under.mode, 'files'); assert.equal(under.commit, C1); assert.equal(under.auto, true);
  const manual = await createAgentFleet({ root, home, platform: 'linux', env: {} }).version();
  assert.equal(manual.auto, false); assert.match(manual.why, /systemd/);
  const off = await createAgentFleet({ root, home, platform: 'linux', env: { INVOCATION_ID: 'x' }, cfg: { autoUpdate: false } }).version();
  assert.equal(off.auto, false); assert.match(off.why, /autoUpdate/);
});

test('git mode: a development checkout (worktrees, other branch, linked worktree, uncommitted) is never auto-updated', async () => {
  const root = tmp('git'), home = tmp('home');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  write(path.join(root, 'a.js'), '1\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
  const f = createAgentFleet({ root, home, platform: 'win32' });
  let v = await f.version();
  assert.equal(v.mode, 'git'); assert.equal(v.auto, true, v.why); assert.equal(v.commit.length, 40);
  write(path.join(root, 'a.js'), '2\n');
  v = await f.version(); assert.equal(v.auto, false); assert.match(v.why, /没提交/);
  git(root, 'checkout', '-q', '--', 'a.js');
  const wt = path.join(tmp('wt'), 'w'); git(root, 'worktree', 'add', '-q', wt, '-b', 'feature/x');
  v = await f.version(); assert.equal(v.auto, false); assert.match(v.why, /工作树/);
  const linked = await createAgentFleet({ root: wt, home, platform: 'win32' }).version();
  assert.equal(linked.auto, false);
  git(root, 'worktree', 'remove', '--force', wt);
  git(root, 'checkout', '-qb', 'dev');
  v = await f.version(); assert.equal(v.auto, false); assert.match(v.why, /分支 dev/);
});

// ---------- agent: staging, apply, guard ----------
function filesAgent() {
  const root = tmp('root'), home = tmp('home');
  write(path.join(root, 'remote/agent/agent.js'), 'old agent\n');
  write(path.join(root, 'remote/agent/keep.js'), 'same\n');
  write(path.join(root, '.ame-version.json'), JSON.stringify({ commit: C1 }));
  let guards = 0;
  const f = createAgentFleet({ root, home, platform: 'linux', env: { INVOCATION_ID: 'x' }, spawnGuard: () => { guards++; } });
  return { root, home, f, guards: () => guards };
}
const item = (p, s) => ({ path: p, blob: blobId(Buffer.from(s)), b64: Buffer.from(s).toString('base64') });

test('staging refuses a path outside the copy and a file that does not match its blob id', () => {
  const { f } = filesAgent();
  assert.throws(() => f.stage('r1', [{ ...item('../evil.js', 'x') }]), /不合规/);
  assert.throws(() => f.stage('r1', [{ ...item('a.js', 'x'), b64: Buffer.from('y').toString('base64') }]), /校验/);
});

test('apply backs up, writes, stamps the version; the guard keeps it when the new agent reports in', async () => {
  const { root, home, f, guards } = filesAgent();
  const have = f.have({ 'remote/agent/agent.js': 'x', 'remote/agent/keep.js': 'x', 'remote/agent/new.js': 'x' });
  assert.equal(have['remote/agent/keep.js'], blobId(Buffer.from('same\n'))); assert.equal(have['remote/agent/new.js'], null);
  f.stage('r2', [item('remote/agent/agent.js', 'new agent\n'), item('remote/agent/new.js', 'added\n')]);
  const r = await f.apply({ rid: 'r2', mode: 'files', commit: C2, files: ['remote/agent/agent.js', 'remote/agent/new.js'] });
  assert.equal(r.ok, true, r.msg); assert.equal(r.restart, true); assert.equal(guards(), 1);
  assert.equal(fs.readFileSync(path.join(root, 'remote/agent/agent.js'), 'utf8'), 'new agent\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ame-version.json'))).commit, C2);
  // a second update while this one is not confirmed is refused
  assert.match((await f.apply({ rid: 'r3', mode: 'files', commit: C1, files: [] })).msg, /还没确认/);
  // the agent that wrote the update does not count as the new one
  f.markHealthy();
  const dir = path.join(home, '.ametyping', 'fleet');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).healthy, undefined);
  let restarts = 0;
  const g = guard({ dir, root, platform: 'linux', waitMs: 3000, pollMs: 50, headless: async () => '',
    restart: async () => { restarts++; setTimeout(() => {               // the new agent: another process marks it
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))); fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ ...p, healthy: Date.now(), healthyPid: -1 }));
    }, 100); return { ok: true }; } });
  const last = await g;
  assert.equal(last.ok, true); assert.equal(last.commit, C2); assert.equal(restarts, 1);
  assert.equal(fs.existsSync(path.join(dir, 'pending.json')), false);
  assert.equal((await f.version()).last.ok, true);
});

test('the guard puts the old files back when the new agent does not come back', async () => {
  const { root, home, f } = filesAgent();
  f.stage('r4', [item('remote/agent/agent.js', 'broken agent\n'), item('remote/agent/new.js', 'added\n')]);
  assert.equal((await f.apply({ rid: 'r4', mode: 'files', commit: C2, files: ['remote/agent/agent.js', 'remote/agent/new.js'] })).ok, true);
  const dir = path.join(home, '.ametyping', 'fleet');
  let restarts = 0;
  const last = await guard({ dir, root, platform: 'linux', waitMs: 300, pollMs: 50, restart: async () => { restarts++; return { ok: true }; } });
  assert.equal(last.ok, false); assert.match(last.msg, /没有连上/); assert.equal(last.tried, C2);
  assert.equal(restarts, 2);                                          // (the new version, then the old one again)
  assert.equal(fs.readFileSync(path.join(root, 'remote/agent/agent.js'), 'utf8'), 'old agent\n');
  assert.equal(fs.existsSync(path.join(root, 'remote/agent/new.js')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ame-version.json'))).commit, C1);
});

// ---------- agent: config files ----------
test('Claude Code settings: only the gateway keys change; ANTHROPIC_API_KEY goes; a backup is kept', () => {
  const home = tmp('home'), c = createAgentConfig({ home, env: {} });
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { a: 1 }, env: { HTTP_PROXY: 'http://p:1', ANTHROPIC_API_KEY: 'old', ANTHROPIC_BASE_URL: 'https://old' } }));
  const r = c.apply({ gateway: 'https://gw.example/v1', key: { id: 'k1', name: 'windose-pc', secret: 'sk-new-secret-1' }, targets: ['claude'], models: { opus: 'x/opus' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json')));
  assert.deepEqual(j.hooks, { a: 1 }); assert.equal(j.model, 'opus');
  assert.equal(j.env.HTTP_PROXY, 'http://p:1'); assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(j.env.ANTHROPIC_AUTH_TOKEN, 'sk-new-secret-1'); assert.equal(j.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(j.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'x/opus');
  assert.ok(fs.existsSync(r.results[0].backup));
  assert.deepEqual(c.keyInfo(), { id: 'k1', name: 'windose-pc' });
  assert.doesNotMatch(JSON.stringify(c.keyInfo()), /secret/);
  // a later call without a key uses the stored one
  assert.equal(c.apply({ gateway: 'https://gw.example', targets: ['claude'] }).ok, true);
  // an unreadable file is left alone
  write(path.join(home, '.claude', 'settings.json'), '{ broken');
  const bad = c.apply({ gateway: 'https://gw.example', targets: ['claude'] });
  assert.equal(bad.ok, false); assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ broken');
});

test('Claude Code with a proxy of its own: the gateway goes into NO_PROXY; none is added where there is no proxy', () => {
  assert.equal(withBypass('localhost,127.0.0.1', 'gw.example'), 'localhost,127.0.0.1,gw.example');
  assert.equal(withBypass('localhost,GW.example', 'gw.example'), 'localhost,GW.example');
  assert.equal(withBypass('*', 'gw.example'), '*');
  assert.equal(withBypass('', 'gw.example'), 'localhost,127.0.0.1,gw.example');
  const home = tmp('home'), c = createAgentConfig({ home, env: {} });
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost', no_proxy: 'localhost' } }));
  const key = { id: 'k', name: 'n', secret: 'sk-new-secret-1' };
  const r = c.apply({ gateway: 'https://gw.example', key, targets: ['claude'] });
  const e = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'))).env;
  assert.equal(e.NO_PROXY, 'localhost,gw.example'); assert.equal(e.no_proxy, 'localhost,gw.example'); assert.match(r.results[0].msg, /NO_PROXY/);
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
  c.apply({ gateway: 'https://gw.example', targets: ['claude'] });
  const e2 = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'))).env;
  assert.ok(!('NO_PROXY' in e2) && !Object.keys(e2).some((k) => /proxy/i.test(k)), JSON.stringify(e2));
});

test('Codex: its config.toml is left alone; the proxy is recorded for it; no Magpie key needed', () => {
  const home = tmp('home'), c = createAgentConfig({ home, env: {} });
  const toml = '# mine\nmodel = "gpt-6.2-sol"\n[mcp_servers.ame-mesh]\ncommand = "node"\n';
  write(path.join(home, '.codex', 'config.toml'), toml);
  const none = c.apply({ targets: ['codex'] });
  assert.equal(none.ok, false); assert.match(none.results[0].msg, /代理/);
  assert.equal(c.apply({ targets: ['codex'], proxy: 'socks5://x' }).ok, false);
  const r = c.apply({ targets: ['codex'], proxy: 'http://127.0.0.1:10808' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.key, null);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), toml);
  assert.deepEqual(readNet(home), { proxy: 'http://127.0.0.1:10808', tools: ['codex'] });
  assert.equal(proxyFor('codex', home), 'http://127.0.0.1:10808'); assert.equal(proxyFor('claude', home), '');
  // a proxy sent along with another target is kept for installs, without making Codex use it
  const home2 = tmp('home'), c2 = createAgentConfig({ home: home2, env: {} });
  c2.apply({ gateway: 'https://gw.example', key: { id: 'k', name: 'n', secret: 'sk-new-secret-1' }, targets: ['claude'], proxy: 'http://10.0.0.1:3128' });
  assert.deepEqual(readNet(home2), { proxy: 'http://10.0.0.1:3128', tools: [] });
});

// ---------- agent: harnesses ----------
function fakeHarnessHost({ installed = {} } = {}) {
  const home = tmp('home'), bin = path.join(home, 'bin'), root = tmp('root'), calls = [];
  fs.mkdirSync(bin, { recursive: true });
  for (const [n, v] of Object.entries(installed)) write(path.join(bin, n), v);
  for (const f of ['install-codex-hooks.js', 'install-mesh-mcp.js']) write(path.join(root, f), '');
  const exec = async (cmd, args, o = {}) => {
    calls.push({ cmd, args, proxy: o.env && o.env.HTTPS_PROXY });
    if (args[0] === '--version') { try { return { ok: true, out: fs.readFileSync(cmd, 'utf8') + '\n', err: '' }; } catch { return { ok: false, out: '', err: 'x' }; } }
    if (args[0] === 'install' && args[1] === '-g') { write(path.join(bin, 'codex'), 'codex-cli 0.171.0'); return { ok: true, out: 'added 2 packages', err: '' }; }
    if (args[0] === 'update' || args[0] === 'upgrade') { write(cmd, String(fs.readFileSync(cmd, 'utf8')).replace(/\d+$/, (n) => +n + 1)); return { ok: true, out: 'updated', err: '' }; }
    return { ok: true, out: '', err: '' };
  };
  const hz = createHarness({ home, root, platform: 'linux', env: { PATH: bin, HOME: home }, exec });
  return { home, bin, root, calls, hz };
}

test('harness inventory: found by the program, with its version', async () => {
  const { hz } = fakeHarnessHost({ installed: { claude: '2.1.330 (Claude Code)', agy: '1.5.14' } });
  const inv = await hz.inventory();
  assert.deepEqual(inv.map((x) => x.id), ['claude', 'codex', 'opencode', 'agy']);
  const by = Object.fromEntries(inv.map((x) => [x.id, x]));
  assert.equal(by.claude.installed, true); assert.equal(by.claude.version, '2.1.330 (Claude Code)');
  assert.equal(by.codex.installed, false); assert.equal(by.agy.version, '1.5.14');
});

test('harness install: the fixed command, through the recorded proxy, then the AmeTyping hooks and MCP', async () => {
  const { home, root, calls, hz } = fakeHarnessHost();
  writeNet({ proxy: 'http://127.0.0.1:10808', tools: ['codex'] }, home);
  assert.equal((await hz.run('rm', 'install')).ok, false);
  assert.equal((await hz.run('codex', 'uninstall')).ok, false);
  assert.match((await hz.run('codex', 'update')).msg, /先安装/);
  const r = await hz.run('codex', 'install');
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.after, 'codex-cli 0.171.0');
  const npm = calls.find((c) => c.args[0] === 'install');
  assert.deepEqual(npm.args.slice(0, 3), ['install', '-g', '@openai/codex@latest']); assert.equal(npm.proxy, 'http://127.0.0.1:10808');
  const after = calls.filter((c) => c.cmd === process.execPath).map((c) => path.basename(c.args[0]));
  assert.deepEqual(after, ['install-codex-hooks.js', 'install-mesh-mcp.js']);
  assert.ok(calls.filter((c) => c.cmd === process.execPath).every((c) => c.args[0].startsWith(root)));
  assert.match(r.notes.join(' '), /codex login/);
  assert.match((await hz.run('codex', 'install')).msg, /已经装了/);
  // the proxy can be given for one run; a malformed one is refused
  assert.match((await hz.run('codex', 'update', { proxy: 'http://a b' })).msg, /代理/);
});

test('harness update: its own updater (claude update, opencode upgrade)', async () => {
  const { bin, calls, hz } = fakeHarnessHost({ installed: { claude: '2.1.330', opencode: '1.19.6' } });
  const r = await hz.run('claude', 'update');
  assert.equal(r.ok, true); assert.equal(r.before, '2.1.330'); assert.equal(r.after, '2.1.331');
  assert.deepEqual(calls.find((c) => c.args[0] === 'update'), { cmd: path.join(bin, 'claude'), args: ['update'], proxy: undefined });
  assert.equal((await hz.run('opencode', 'update')).after, '1.19.7');
});

test('OpenCode: the key file, the gateway in providers.magpie; the template for a computer without opencode.json', () => {
  const home = tmp('home'), c = createAgentConfig({ home, env: {} });
  const template = { $schema: 's', model: 'magpie/group/x', providers: { magpie: { name: 'Magpie', settings: { baseURL: 'https://t/v1', apiKey: '{file:~/k}' }, models: { 'group/x': {} } } } };
  const r = c.apply({ gateway: 'https://gw.example', key: { id: 'k', name: 'n', secret: 'sk-open-1234' }, targets: ['opencode'], template });
  assert.equal(r.ok, true, JSON.stringify(r));
  const dir = path.join(home, '.config', 'opencode');
  assert.equal(fs.readFileSync(path.join(dir, '.secrets', 'magpie-nas.key'), 'utf8').trim(), 'sk-open-1234');
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json')));
  assert.equal(j.providers.magpie.settings.baseURL, 'https://gw.example/v1');
  assert.match(j.providers.magpie.settings.apiKey, /^\{file:.*magpie-nas\.key\}$/); assert.deepEqual(j.providers.magpie.models, { 'group/x': {} });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'), /sk-open/);
  // an existing config keeps its own models and other providers
  write(path.join(dir, 'opencode.json'), JSON.stringify({ model: 'mine/m', providers: { mine: { a: 1 }, magpie: { models: { only: {} }, settings: { baseURL: 'x', headers: { h: 1 } } } } }));
  c.apply({ gateway: 'https://gw2.example', targets: ['opencode'], template });
  const k = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json')));
  assert.equal(k.model, 'mine/m'); assert.deepEqual(k.providers.mine, { a: 1 }); assert.deepEqual(k.providers.magpie.models, { only: {} });
  assert.deepEqual(k.providers.magpie.settings.headers, { h: 1 }); assert.equal(k.providers.magpie.settings.baseURL, 'https://gw2.example/v1');
});

// ---------- server: Magpie keys against a fake Magpie ----------
function fakeMagpie({ version = 'new', admin = true } = {}) {
  const keys = [{ id: 'adm', name: 'Windose 管理', off: false }], seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (version === 'old') return send(404, { error: { message: 'magpie serves /v1/chat/completions, ...' } });
      if (req.headers.origin || req.headers['sec-fetch-mode']) return send(403, { error: { code: 'admin_browser_refused', message: 'no pages' } });
      if (req.headers.authorization !== 'Bearer admin-secret') return send(401, { error: { code: 'admin_key_required' } });
      if (!admin) return send(403, { error: { code: 'gateway_key_not_admin', message: 'no' } });
      const a = req.url.replace('/v1/magpie/admin/', ''), d = body ? JSON.parse(body) : {};
      if (a === 'gateway-keys') return send(200, { keys });
      if (a === 'gateway-keys/add-key') { keys.push({ id: 'id' + keys.length, name: d.name, off: false }); return send(200, { keys, secret: 'sk-magpie-new' + keys.length }); }
      if (a === 'gateway-keys/rotate-key') return send(200, { keys, secret: 'sk-magpie-rotated' });
      send(404, { error: { message: 'this action is not in the management API' } });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, keys, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}

test('Magpie keys: made through the management API with no browser headers; the same name is rotated', async () => {
  const m = await fakeMagpie(), dir = tmp('cfg'), keyFile = path.join(dir, 'admin.key');
  fs.writeFileSync(keyFile, 'admin-secret\n');
  try {
    const k = createMagpieKeys({ config: { baseURL: m.url, adminKeyFile: keyFile } });
    assert.equal(k.available().ok, true);
    const a = await k.issue('windose-pc');
    assert.equal(a.secret, 'sk-magpie-new2'); assert.equal(a.name, 'windose-pc'); assert.equal(a.rotated, false);
    const b = await k.issue('windose-pc');
    assert.equal(b.rotated, true); assert.equal(b.id, a.id); assert.equal(b.secret, 'sk-magpie-rotated');
    assert.equal(await k.usable(a.id), true); assert.equal(await k.usable('nope'), false);
    assert.ok(m.seen.every((s) => !s.headers.origin && !s.headers['sec-fetch-mode'] && !s.headers['sec-fetch-site']));
    // not from another host, and a missing key file is said plainly
    assert.match(createMagpieKeys({ config: { baseURL: 'http://192.168.1.2:3425/v1', adminKeyFile: keyFile } }).available().msg, /127\.0\.0\.1/);
    assert.match(createMagpieKeys({ config: { baseURL: m.url } }).available().msg, /adminKeyFile/);
  } finally { m.srv.close(); }
});

test('Magpie keys: an old Magpie and a key without the admin level get messages that say what to do', async () => {
  const dir = tmp('cfg'), keyFile = path.join(dir, 'admin.key'); fs.writeFileSync(keyFile, 'admin-secret');
  const old = await fakeMagpie({ version: 'old' });
  try { await assert.rejects(createMagpieKeys({ config: { baseURL: old.url, adminKeyFile: keyFile } }).issue('x'), /升级/); } finally { old.srv.close(); }
  const noadm = await fakeMagpie({ admin: false });
  try { await assert.rejects(createMagpieKeys({ config: { baseURL: noadm.url, adminKeyFile: keyFile } }).list(), /gateway-key admin/); } finally { noadm.srv.close(); }
});

// ---------- server: the orchestration with an agent socket that runs the real agent modules ----------
function setup({ agentCfg = {}, edited = false, platform = 'linux', env = { INVOCATION_ID: 'x' }, magpieKeys } = {}) {
  const dataDir = tmp('data'), bundle = path.join(dataDir, 'fleet', 'bundle');
  const files = { 'remote/agent/agent.js': 'new agent\n', 'remote/agent/keep.js': 'same\n' };
  for (const [p, s] of Object.entries(files)) write(path.join(bundle, 'files', p), s);
  const manifest = { commit: C2, at: new Date().toISOString(), headless: [], files: Object.fromEntries(Object.entries(files).map(([p, s]) => [p, blobId(Buffer.from(s))])),
    known: [blobId(Buffer.from('old agent\n')), blobId(Buffer.from('same\n'))] };
  write(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  write(path.join(dataDir, 'fleet', 'state.json'), JSON.stringify({ settings: { auto: true, gateway: 'https://gw.example', models: {} } }));
  const root = tmp('root'), home = tmp('home');
  write(path.join(root, 'remote/agent/agent.js'), edited ? 'edited by hand\n' : 'old agent\n');
  write(path.join(root, 'remote/agent/keep.js'), 'same\n');
  write(path.join(root, '.ame-version.json'), JSON.stringify({ commit: C1 }));
  let guards = 0;
  const agent = createAgentFleet({ root, home, platform, env, cfg: agentCfg, spawnGuard: () => { guards++; } });
  const conf = createAgentConfig({ home, env: {} });
  const machines = new Map();
  let fleet;
  // what agent.js does with these messages (onFleetMessage), answering asynchronously as a socket would
  const ws = { readyState: 1, sent: [], send(text) {
    const d = JSON.parse(text); this.sent.push(d);
    const reply = (t, o) => setImmediate(() => fleet.fromAgent(m, { t, rid: d.rid, ...o }, ws));
    if (d.t === 'fleet-check') reply('fleet-have', { have: agent.have(d.files) });
    else if (d.t === 'fleet-files') { try { reply('fleet-ack', { n: agent.stage(d.run, d.items) }); } catch (e) { reply('fleet-result', { ok: false, msg: e.message }); } }
    else if (d.t === 'fleet-apply') agent.apply(d).then((r) => reply('fleet-result', r));
    else if (d.t === 'agent-config') reply('agent-config-result', conf.apply(d));
    else if (d.t === 'harness-run') setTimeout(() => reply('harness-result', { ok: true, id: d.id, before: '1.0', after: '1.1', msg: '已更新：1.1', notes: [] }), 20);
  } };
  const m = { name: 'dell97', online: true, sockets: new Set([ws]) };
  machines.set('dell97', m);
  const changes = [];
  fleet = createServerFleet({ dataDir, machines, control: true, onChange: () => changes.push(1), tickMs: 3600e3, magpieKeys,
    templateFile: path.join(dataDir, 'none.json') });
  const harnesses = [{ id: 'claude', installed: true, version: '1.0' }, { id: 'codex', installed: true, version: '1.0' },
    { id: 'opencode', installed: false }, { id: 'agy', installed: false }];
  const hello = async () => fleet.fromAgent(m, { t: 'fleet-version', ...(await agent.version()), control: true, magpieKey: conf.keyInfo(), harnesses }, ws);
  return { fleet, agent, root, home, ws, hello, guards: () => guards, dataDir };
}
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test('a machine behind the bundle is updated by itself: only the changed file sent, then done when it reconnects', async () => {
  const s = setup();
  await s.hello();
  assert.ok(await until(() => s.guards() === 1), 'the update reaches the guard');
  const run = () => s.fleet.view().machines.find((x) => x.name === 'dell97').run;
  assert.equal(run().status, 'restarting');
  const sentFiles = s.ws.sent.filter((d) => d.t === 'fleet-files').flatMap((d) => d.items.map((i) => i.path));
  assert.deepEqual(sentFiles, ['remote/agent/agent.js']);
  assert.equal(fs.readFileSync(path.join(s.root, 'remote/agent/agent.js'), 'utf8'), 'new agent\n');
  // the new agent: the guard has finished, it reconnects at the new commit
  fs.rmSync(path.join(s.home, '.ametyping', 'fleet', 'pending.json'));
  await s.hello();
  assert.equal(run().status, 'ok'); assert.equal(s.fleet.view().machines[0].behind, false);
  // once per machine and commit: nothing more goes out
  const n = s.ws.sent.length; await s.hello(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.ws.sent.length, n);
});

test('a file edited on the machine stops the update until it is forced', async () => {
  const s = setup({ edited: true });
  await s.hello();
  assert.equal((await s.fleet.update('dell97')).ok, false);
  assert.equal(s.fleet.view().machines[0].run.status, 'blocked');
  assert.match(s.fleet.view().machines[0].run.msg, /被直接改过/);
  await s.hello();                                                   // (no automatic retry of a blocked commit)
  assert.equal(s.guards(), 0);
  const r = await s.fleet.update('dell97', { force: true });
  assert.equal(r.ok, true, r.msg); assert.equal(s.guards(), 1);
});

test('a development copy is never updated, not even when asked', async () => {
  const s = setup({ agentCfg: { autoUpdate: false } });
  await s.hello();
  const r = await s.fleet.update('dell97', { force: true });
  assert.equal(r.ok, false); assert.match(r.msg, /autoUpdate/);
  assert.equal(s.ws.sent.length, 0); assert.equal(s.guards(), 0);
});

test('一键配置: a key made for the computer goes to its agent once; the server keeps only its id', async () => {
  const issued = [];
  const s = setup({ magpieKeys: { available: () => ({ ok: true }), usable: async (id) => id === 'k-1', issue: async (name) => { issued.push(name); return { id: 'k-1', name, secret: 'sk-machine-secret', rotated: false }; } } });
  s.agent.apply = async () => ({ ok: false, msg: 'not in this test' });
  await s.hello();
  assert.match((await s.fleet.configure('dell97', { targets: ['codex'] })).msg, /代理/);
  assert.deepEqual(issued, []);                                        // (Codex alone needs no key)
  const r = await s.fleet.configure('dell97', { targets: ['claude', 'codex'], proxy: 'http://127.0.0.1:10808' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(issued, ['windose-dell97']);
  assert.equal(r.key.issued, true); assert.equal(r.key.id, 'k-1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'))).env.ANTHROPIC_AUTH_TOKEN, 'sk-machine-secret');
  assert.equal(fs.existsSync(path.join(s.home, '.codex', 'config.toml')), false);
  assert.equal(proxyFor('codex', s.home), 'http://127.0.0.1:10808');
  assert.equal(s.fleet.view().machines[0].proxy, 'http://127.0.0.1:10808');
  const state = fs.readFileSync(path.join(s.dataDir, 'fleet', 'state.json'), 'utf8');
  assert.doesNotMatch(state, /sk-machine-secret/); assert.match(state, /k-1/);
  assert.doesNotMatch(JSON.stringify(s.fleet.view()), /sk-machine-secret/);
  // the second time: the agent has a usable key, none is made
  await s.hello();
  const again = await s.fleet.configure('dell97', { targets: ['claude'] });
  assert.equal(again.ok, true); assert.equal(again.key.issued, false); assert.deepEqual(issued, ['windose-dell97']);
});

test('harnesses: one machine updates its installed ones one after another, with its proxy; all machines at once', async () => {
  const s = setup();
  s.agent.apply = async () => ({ ok: false, msg: 'not in this test' });
  await s.hello();
  s.fleet.configure('dell97', { targets: ['codex'], proxy: 'http://127.0.0.1:10808' });
  assert.ok(await until(() => s.fleet.view().machines[0].proxy));
  assert.match(s.fleet.harnessRun('dell97', '*', 'install').msg, /只能一起更新/);
  assert.match(s.fleet.harnessRun('dell97', 'rm', 'update').msg, /不认识/);
  const r = s.fleet.harnessRun('dell97', '*', 'update');
  assert.equal(r.ok, true, r.msg); assert.match(r.msg, /claude、codex/);
  assert.match(s.fleet.harnessRun('dell97', 'claude', 'update').msg, /正在/);       // (one run at a time on a machine)
  assert.ok(await until(() => !s.fleet.view().machines[0].harnessBusy));
  const runs = s.ws.sent.filter((d) => d.t === 'harness-run');
  assert.deepEqual(runs.map((d) => d.id), ['claude', 'codex']);
  assert.ok(runs.every((d) => d.action === 'update' && d.proxy === 'http://127.0.0.1:10808'));
  const h = s.fleet.view().machines[0].harness;
  assert.equal(h.claude.status, 'ok'); assert.equal(h.codex.after, '1.1');
  const all = s.fleet.harnessAll();
  assert.equal(all.ok, true, all.msg); assert.match(all.msg, /dell97/);
  assert.ok(await until(() => !s.fleet.view().machines[0].harnessBusy));
  assert.equal(s.ws.sent.filter((d) => d.t === 'harness-run').length, 4);
});
