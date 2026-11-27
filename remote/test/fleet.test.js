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
const { createHarness, readNet, writeNet, proxyFor, proxyUrlOf } = require('../agent/harness');
const { createReleases } = require('../server/fleet/releases');
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
  v = await f.version(); assert.equal(v.auto, false); assert.match(v.why, /本地改了文件.*a\.js/); assert.deepEqual(v.dirtyFiles, ['a.js']);
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
  assert.equal(readNet(home).proxy, 'http://127.0.0.1:10808'); assert.deepEqual(readNet(home).tools, ['codex']);
  assert.equal(proxyFor('codex', home), 'http://127.0.0.1:10808'); assert.equal(proxyFor('claude', home), '');
  // a proxy sent along with another target is kept for this computer (installs, and Codex: always through a proxy)
  const home2 = tmp('home'), c2 = createAgentConfig({ home: home2, env: {} });
  c2.apply({ gateway: 'https://gw.example', key: { id: 'k', name: 'n', secret: 'sk-new-secret-1' }, targets: ['claude'], proxy: 'http://10.0.0.1:3128' });
  assert.equal(readNet(home2).proxy, 'http://10.0.0.1:3128');
  // none set: the proxy the agent found is used and not frozen as the computer's own; the default only when none was found
  const home3 = tmp('home'), c3 = createAgentConfig({ home: home3, env: {} });
  writeNet({ detected: 'http://192.168.114.1:7890', detectedAt: 1 }, home3);
  const d3 = c3.apply({ targets: ['codex'], fallback: 'http://127.0.0.1:10808' });
  assert.equal(d3.ok, true, JSON.stringify(d3)); assert.match(d3.results[0].msg, /192\.168\.114\.1:7890（自动检测到的）/);
  assert.equal(readNet(home3).proxy, ''); assert.equal(proxyFor('codex', home3), 'http://192.168.114.1:7890');
  const home4 = tmp('home'), c4 = createAgentConfig({ home: home4, env: {} });
  assert.match(c4.apply({ targets: ['codex'], fallback: 'http://127.0.0.1:10808' }).results[0].msg, /默认代理/);
  assert.equal(proxyFor('codex', home4), 'http://127.0.0.1:10808');
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

test('harness update by how it was installed: npm package, Codex standalone, OpenCode 1.x moved to 2.x by name', () => {
  const home = tmp('home'), npmPkg = path.join(home, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), bin = path.join(home, 'bin');
  write(npmPkg, ''); fs.mkdirSync(bin, { recursive: true });
  let linked = true; try { fs.symlinkSync(npmPkg, path.join(bin, 'codex')); } catch { linked = false; }      // (Windows without the right: skipped)
  write(path.join(home, 'standalone', 'codex'), '');
  const hz = createHarness({ home, platform: 'linux', env: { PATH: bin }, exec: async () => ({ ok: true, out: '', err: '' }) });
  if (linked) {
    assert.equal(hz.methodOf('codex', path.join(bin, 'codex')), 'npm');
    assert.deepEqual(hz.commandFor('codex', 'update', { path: path.join(bin, 'codex'), method: 'npm' }).slice(1)[0].slice(0, 3), ['install', '-g', '@openai/codex@latest']);
  }
  assert.equal(hz.methodOf('codex', path.join(home, 'standalone', 'codex')), 'self');
  assert.deepEqual(hz.commandFor('codex', 'update', { path: '/x/codex', method: 'self' }), ['/x/codex', ['update']]);
  assert.deepEqual(hz.commandFor('opencode', 'update', { path: '/x/opencode', method: 'self', line: 'legacy' }, { target: '2.4.1' }), ['/x/opencode', ['upgrade', '--major']]);
  assert.deepEqual(hz.commandFor('opencode', 'update', { path: '/x/opencode', method: 'self' }, { target: '2.4.1' }), ['/x/opencode', ['upgrade']]);
  // Windows standalone codex.exe uses PowerShell wrapper with TLS1.2 + DefaultWebProxy
  const hzWin = createHarness({ home: tmp('home'), env: {}, platform: 'win32' });
  const winCodex = hzWin.commandFor('codex', 'update', { path: 'C:\\x\\codex.exe', method: 'self' }, { proxy: 'http://127.0.0.1:10808' });
  assert.equal(winCodex[0], 'powershell.exe');
  assert.match(winCodex[1].join(' '), /Tls12[\s\S]*DefaultWebProxy[\s\S]*127\.0\.0\.1:10808[\s\S]*chatgpt\.com\/codex\/install\.ps1/);
  // Windows: the install script's own web requests are given the proxy (PowerShell 5.1 does not read HTTPS_PROXY)
  const wz = createHarness({ home, platform: 'win32', env: {}, exec: async () => ({ ok: true, out: '', err: '' }) });
  const ps = wz.commandFor('agy', 'install', {}, { proxy: 'http://192.168.114.1:7890' });
  assert.equal(ps[0], 'powershell.exe'); assert.match(ps[1].pop(), /WebProxy\('http:\/\/192\.168\.114\.1:7890', \$true\).*irm https:\/\/antigravity\.google\/cli\/install\.ps1 \| iex/);
});

test('harness update against the newest version: nothing to do, or a version that did not move is not "the newest"', async () => {
  const { hz, calls } = fakeHarnessHost({ installed: { claude: '2.1.331 (Claude Code)', agy: '1.5.14' } });
  const same = await hz.run('claude', 'update', { target: '2.1.331' });
  assert.equal(same.ok, true); assert.match(same.msg, /已经是最新版/); assert.equal(calls.filter((c) => c.args[0] === 'update').length, 0);
  // agy's updater moves it on by one patch only: 1.5.15, not the newest 1.5.16
  const stuck = await hz.run('agy', 'update', { target: '1.5.16' });
  assert.equal(stuck.ok, false); assert.equal(stuck.behind, true); assert.match(stuck.msg, /版本还是 1\.5\.15（最新是 1\.5\.16）/);
  const caught = await hz.run('agy', 'update', { target: '1.5.16' });
  assert.equal(caught.ok, true); assert.match(caught.msg, /1\.5\.15 → 1\.5\.16/);
});

test('the way out: candidates from the interactive shell and local ports, each tried; the first that reaches everything', async () => {
  const home = tmp('home');
  const exec = async (cmd, args) => (cmd === 'bash' && args[0] === '-ic' ? { ok: true, out: 'http://192.168.114.1:7890|http://192.168.114.1:7890', err: '' } : { ok: true, out: '', err: '' });
  // direct: OpenAI refuses this region; the router reaches all; the local port answers nothing abroad
  const probe = async (url, { proxy }) => {
    if (!proxy) return /openai|claude\.ai|github/.test(url) ? 403 : 200;
    if (proxy.includes('192.168.114.1')) return /openai/.test(url) ? 401 : 200;
    return 0;
  };
  const hz = createHarness({ home, platform: 'linux', env: { HTTPS_PROXY: 'http://127.0.0.1:9' }, exec, probe, ports: [] });
  const n = await hz.detectNet();
  assert.equal(n.needProxy, true); assert.equal(n.recommended, 'http://192.168.114.1:7890'); assert.match(n.recommendedSource, /交互 shell/);
  assert.deepEqual(n.routes.map((r) => r.url), ['http://192.168.114.1:7890', 'http://127.0.0.1:9']);
  assert.equal(n.direct.reach.openai, false); assert.equal(n.direct.reach.npm, true);
  assert.equal(readNet(home).detected, 'http://192.168.114.1:7890'); assert.equal(proxyFor('codex', home), 'http://192.168.114.1:7890');
  // set for the computer: it comes first, and is what Codex uses
  writeNet({ proxy: 'http://10.0.0.5:3128' }, home);
  assert.equal(proxyFor('codex', home), 'http://10.0.0.5:3128');
  // direct reaches everything: no proxy needed
  const hz2 = createHarness({ home: tmp('home'), platform: 'linux', env: {}, exec: async () => ({ ok: true, out: '', err: '' }), probe: async (u) => (/openai/.test(u) ? 401 : 200), ports: [] });
  const d = await hz2.detectNet();
  assert.equal(d.needProxy, false); assert.equal(d.recommended, '');
  // Windows' ProxyServer forms
  assert.equal(proxyUrlOf('192.168.114.1:7890'), 'http://192.168.114.1:7890');
  assert.equal(proxyUrlOf('http=a:1;https=b:2'), 'http://b:2');
  assert.equal(proxyUrlOf('socks=x:1'), '');
});

test('reaching out: a real request through a local CONNECT proxy, and a dead proxy answers 0', async () => {
  // a TLS server standing in for the outside, and an HTTP proxy that tunnels to it
  const tls = require('tls'), net = require('net');
  const { execFileSync } = require('child_process');
  const dir = tmp('tls');
  let key, cert;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    key = fs.readFileSync(path.join(dir, 'k.pem')); cert = fs.readFileSync(path.join(dir, 'c.pem'));
  } catch { return; }                                                       // (no openssl here: skipped)
  const site = tls.createServer({ key, cert }, (s) => { s.on('data', () => s.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  let tunnels = 0;
  const proxy = http.createServer().on('connect', (req, sock) => {
    tunnels++;
    const up = net.connect(site.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const { get } = require('../agent/harness');
    assert.equal(await get('https://localhost:443/v1/models', { proxy: `http://127.0.0.1:${proxy.address().port}` }), 401);
    assert.equal(tunnels, 1, 'the request went through the proxy, not around it');
    assert.equal(await get('https://localhost/x', { proxy: 'http://127.0.0.1:1', timeout: 2000 }), 0);
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    site.close(); proxy.close();
  }
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
  return { fleet, agent, root, home, ws, hello, guards: () => guards, dataDir, mach: m };
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

// ---------- server: the daily harness check ----------
function fakeReleases({ claude = '2.1.331', codex = '0.172.0', opencode = '2.4.1', agy = '1.5.16' } = {}) {
  const seen = [];
  const md = '# Changelog\n\n## 2.1.331\n- Added /goal command\n- Fixed a crash\n\n## 2.1.330\n- Faster startup\n\n## 2.1.329\n- Old thing\n';
  const request = async (url) => {
    seen.push(url);
    const ok = (s) => ({ status: 200, body: Buffer.from(typeof s === 'string' ? s : JSON.stringify(s)) });
    if (url.includes('claude-code-releases/latest')) return ok(claude + '\n');
    if (url.includes('@openai/codex/latest')) return ok({ version: codex });
    if (url.includes('@opencode/cli/latest')) return ok({ version: opencode });
    if (url.includes('manifests/linux_amd64.json')) return ok({ version: agy });
    if (url.includes('CHANGELOG.md')) return ok(md);
    if (url.includes('openai/codex/releases')) return ok([{ tag_name: 'rust-v0.172.0', body: '- New: codex exec --json' }, { tag_name: 'rust-v0.171.0', body: '- fixes' }, { tag_name: 'rust-v0.170.0', body: '- older' }]);
    if (url.includes('anomalyco/opencode/releases')) return ok([{ tag_name: 'v2.4.1', body: 'fix' }, { tag_name: 'v1.19.6', body: 'legacy' }]);
    return { status: 404, body: Buffer.from('') };
  };
  return { request, seen };
}

test('releases: the newest of each, the notes since the oldest installed, condensed; nothing asked the second time', async () => {
  const dataDir = tmp('data'), { request } = fakeReleases(), asked = [];
  const ask = async (prompt) => { asked.push(prompt); return { items: [{ id: 'claude', major: ['新增 /goal 命令'], highlights: ['启动更快'], other: '另有 1 项修复' }, { id: 'codex', major: [], highlights: ['exec 支持 --json'], other: '' }] }; };
  let t = 1000;
  const rel = createReleases({ dataDir, request, ask, now: () => t });
  const r = await rel.check({ since: { claude: '2.1.329 (Claude Code)', codex: 'codex-cli 0.170.0' } });
  assert.deepEqual(r.errors, {});
  assert.equal(rel.latestOf('claude'), '2.1.331'); assert.equal(rel.latestOf('agy'), '1.5.16');
  // the notes given: 2.1.330 and 2.1.331 (after the oldest installed 2.1.329), Codex 0.171 and 0.172, OpenCode only 2.4.1
  assert.match(asked[0], /## 2\.1\.331[\s\S]*## 2\.1\.330/); assert.doesNotMatch(asked[0], /## 2\.1\.329|Old thing/);
  assert.match(asked[0], /0\.172\.0[\s\S]*0\.171\.0/); assert.doesNotMatch(asked[0], /#### 0\.170\.0|- older/); assert.doesNotMatch(asked[0], /v1\.19\.6|legacy/);
  const claude = r.fresh.find((x) => x.id === 'claude');
  assert.deepEqual(claude.major, ['新增 /goal 命令']); assert.equal(claude.from, '2.1.329');
  assert.equal(r.fresh.find((x) => x.id === 'agy').noNotes, true);
  // the next day, nothing new: nothing asked, nothing added
  t = 2000; const again = await rel.check({ since: {} });
  assert.equal(again.fresh.length, 0); assert.equal(asked.length, 1);
  assert.equal(rel.historyBetween(0, 1500).length, 4); assert.equal(rel.historyBetween(1500, 3000).length, 0);
  // the model failing: the notes' first lines instead
  const rel2 = createReleases({ dataDir: tmp('data'), request, ask: async () => { throw new Error('quota'); }, now: () => 5 });
  const r2 = await rel2.check({});
  assert.match(r2.errors.summary, /quota/); assert.deepEqual(r2.fresh.find((x) => x.id === 'claude').highlights, ['Added /goal command', 'Fixed a crash']);
});

test('daily check: computers behind update only what is behind; on Windows not what has a session open; the report digest', async () => {
  const { request } = fakeReleases();
  let t = Date.parse('2026-11-25T03:50:00');
  const dataDir = tmp('data');
  const rel = createReleases({ dataDir, request, ask: async () => ({ items: [{ id: 'claude', major: ['新增 /goal 命令'], highlights: [], other: '' }] }), now: () => t });
  const machines = new Map();
  let fleet;
  const mk = (name, platform, harnesses, sessions = []) => {
    const m = { name, online: true, sessions: new Map(sessions.map((id) => [id, { id }])) };
    const ws = { readyState: 1, sent: [], send(text) { const d = JSON.parse(text); this.sent.push(d);
      if (d.t === 'harness-run') setTimeout(() => fleet.fromAgent(m, { t: 'harness-result', rid: d.rid, ok: true, id: d.id, before: '1', after: d.target, msg: '已更新' }, ws), 5); } };
    m.sockets = new Set([ws]);
    machines.set(name, m);
    return { m, ws, hello: () => fleet.fromAgent(m, { t: 'fleet-version', mode: 'git', commit: C1, auto: false, why: 'x', control: true, platform, harnesses }, ws) };
  };
  // (a fresh server waits 15 minutes before its first daily check)
  const early = createServerFleet({ dataDir: tmp('data'), machines: new Map(), control: true, tickMs: 3600e3, releases: rel, now: () => t });
  assert.equal(early.dailyDue(), false); early.close();
  fleet = createServerFleet({ dataDir, machines, control: true, tickMs: 3600e3, releases: rel, now: () => t, dailyGraceMs: 0,
    magpieKeys: { available: () => ({ ok: true }), usable: async () => true, issue: async () => ({}) } });
  const lin = mk('dell97', 'linux', [{ id: 'claude', installed: true, version: '2.1.323 (Claude Code)' }, { id: 'codex', installed: true, version: 'codex-cli 0.172.0' },
    { id: 'opencode', installed: true, version: 'opencode v1.19.6', line: 'legacy' }, { id: 'agy', installed: false }]);
  const win = mk('dell211', 'win32', [{ id: 'claude', installed: true, version: '2.1.311' }, { id: 'codex', installed: true, version: 'codex-cli 0.171.0' }],
    ['11111111-2222-3333-4444-555555555555']);
  const off = mk('samsung_blue', 'win32', [{ id: 'claude', installed: true, version: '2.1.300' }]);
  lin.hello(); win.hello(); off.hello();
  const answer = {};
  await fleet.handle({ method: 'POST' }, null, new URL('http://x/api/fleet/settings'), '', (_r, _c, v) => Object.assign(answer, v),
    async () => JSON.stringify({ harnessOff: { machine: 'samsung_blue', off: true } }), () => true);
  assert.equal(answer.ok, true, JSON.stringify(answer)); assert.equal(fleet.view().machines.find((x) => x.name === 'samsung_blue').harnessOff, true);
  assert.equal(fleet.dailyDue(), true);
  const d = await fleet.dailyCheck();
  assert.match(d.msg, /新版本 .*Claude Code 2\.1\.331/);
  await until(() => !fleet.view().machines.some((m) => m.harnessBusy));
  const runs = (x) => x.ws.sent.filter((m) => m.t === 'harness-run').map((m) => `${m.id}@${m.target}`);
  // dell97: Claude behind, OpenCode on the old line (moved to 2.4.1); Codex already newest -- not touched
  assert.deepEqual(runs(lin), ['claude@2.1.331', 'opencode@2.4.1']);
  // dell211: Claude has a session open there (Windows) -- only Codex
  assert.deepEqual(runs(win), ['codex@0.172.0']);
  assert.deepEqual(runs(off), []);
  assert.equal(fleet.dailyDue(), false, 'once a day');
  // what the report of that night gets
  const hx = fleet.digest(t - 3600e3, t + 3600e3);
  assert.deepEqual(hx.releases.find((r) => r.id === 'claude').major, ['新增 /goal 命令']);
  assert.ok(hx.updates.some((u) => u.machine === 'dell97' && u.id === 'claude' && u.ok && u.by === 'daily'), JSON.stringify(hx.updates));
  assert.ok(hx.updates.some((u) => u.machine === 'dell211' && u.id === 'claude' && u.skipped));
  assert.ok(hx.behind.some((b) => b.machine === 'samsung_blue' && b.id === 'claude'));
  assert.equal(fleet.digest(0, 1), null);
  // the next day after 03:40 it is due again
  t = Date.parse('2026-11-26T03:45:00'); assert.equal(fleet.dailyDue(), true);
  fleet.close();
});

test('a computer\'s proxy: set for it, else what its agent found, else the default -- and what a harness run carries', async () => {
  const s = setup();
  s.agent.apply = async () => ({ ok: false, msg: 'not in this test' });
  const net = { at: 1, needProxy: true, recommended: 'http://192.168.114.1:7890', recommendedSource: '交互 shell（~/.bashrc）',
    direct: { reach: { npm: true } }, routes: [{ url: 'http://192.168.114.1:7890', source: '交互 shell（~/.bashrc）', ms: 900, reach: { openai: true, npm: true } }] };
  const ver = await s.agent.version();
  const send = (n) => s.fleet.fromAgent(s.mach, { t: 'fleet-version', ...ver, control: true, harnesses: [{ id: 'claude', installed: true, version: '2.1.300' }], net: n }, s.ws);
  send(null);
  const eff = () => s.fleet.view().machines[0].effective;
  assert.deepEqual(eff(), { proxy: '', source: '' });
  send(net);
  assert.deepEqual(eff(), { proxy: 'http://192.168.114.1:7890', source: '自动检测：交互 shell（~/.bashrc）' });
  assert.equal(s.fleet.view().machines[0].version.net.routes[0].reach.openai, true);
  assert.equal(s.fleet.view().machines[0].version.net.routes[0].reach.github, false);
  await s.fleet.configure('dell97', { targets: ['codex'], proxy: 'http://10.1.1.1:3128' });
  assert.deepEqual(eff(), { proxy: 'http://10.1.1.1:3128', source: '为这台电脑设置的' });
  // a harness run: the proxy set for it, the default as fallback, the newest version known
  s.fleet.harnessRun('dell97', 'claude', 'update');
  await until(() => s.ws.sent.some((d) => d.t === 'harness-run'));
  const run = s.ws.sent.find((d) => d.t === 'harness-run');
  assert.equal(run.proxy, 'http://10.1.1.1:3128'); assert.equal(run.fallback, ''); assert.equal(typeof run.target, 'string');
  s.fleet.close();
});

test('git mode: origin fallback fetch goes through the way out found for this computer (the agent has no proxy of its own)', async () => {
  const root = tmp('git'), home = tmp('home');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  write(path.join(root, 'a.js'), '1\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
  writeNet({ detected: 'http://192.168.114.1:7890', detectedAt: 1 }, home);
  const calls = [];
  const gitRun = async (cmd, args, cwd, t, env) => { calls.push({ args, proxy: env && env.HTTPS_PROXY, noProxy: env && env.NO_PROXY });
    return args.includes('fetch') ? { ok: false, out: '', err: 'stop here' } : { ok: true, out: args.includes('rev-parse') ? (args.includes('--abbrev-ref') ? 'main' : 'c'.repeat(40)) : '', err: '' }; };
  const f = createAgentFleet({ root, home, platform: 'linux', gitRun });
  await f.apply({ rid: 'r', mode: 'git', commit: 'd'.repeat(40) });
  const fetch = calls.find((c) => c.args.includes('fetch'));
  assert.ok(fetch, 'git fetch was run'); assert.equal(fetch.proxy, 'http://192.168.114.1:7890'); assert.match(fetch.noProxy, /192\.168\.0\.0\/16/);
  // other git commands (status, rev-parse) without it
  assert.ok(calls.filter((c) => !c.args.includes('fetch')).every((c) => !c.proxy));
  // set for the computer: that one
  writeNet({ proxy: 'http://10.0.0.5:3128' }, home);
  calls.length = 0; await f.apply({ rid: 'r2', mode: 'git', commit: 'd'.repeat(40) });
  assert.equal(calls.find((c) => c.args.includes('fetch')).proxy, 'http://10.0.0.5:3128');
});

test('git mode via NAS HTTP bundle: authenticates, verifies sha256, and fast-forwards to exact deployed commit', async () => {
  const { createGitBundle } = require('../deploy/deploy-lib');
  const upstream = tmp('up'), client = tmp('cli'), home = tmp('home'), dataDir = tmp('srv');
  git(upstream, 'init', '-q', '-b', 'main'); git(upstream, 'config', 'user.email', 't@t'); git(upstream, 'config', 'user.name', 't');
  write(path.join(upstream, 'a.js'), 'v1\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'v1');
  const c1 = git(upstream, 'rev-parse', 'HEAD');
  git(client, 'clone', '-q', upstream, '.');
  git(client, 'config', 'user.email', 't@t'); git(client, 'config', 'user.name', 't');
  // Upstream moves ahead to c2 (deployed) and c3 (newer, NOT deployed yet)
  write(path.join(upstream, 'a.js'), 'v2\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'v2');
  const c2 = git(upstream, 'rev-parse', 'HEAD');
  write(path.join(upstream, 'a.js'), 'v3\n'); git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'v3');

  const bundleDir = path.join(dataDir, 'fleet', 'bundle');
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, 'repo.bundle');
  const gb = createGitBundle(c2, bundlePath, { depth: 10, cwd: upstream });
  write(path.join(bundleDir, 'manifest.json'), JSON.stringify({
    commit: c2, at: new Date().toISOString(), files: {}, headless: [], known: [],
    gitBundle: { file: 'repo.bundle', sha256: gb.sha256, size: gb.size, base: gb.base },
  }));

  const fleetSrv = createServerFleet({
    dataDir, machines: new Map(), control: true,
    authAgent: (req) => req.headers.authorization === 'Bearer tok-123' ? { name: 'box' } : null,
  });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await fleetSrv.handleAgent(req, res, url, '127.0.0.1')) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    // Unauthorized request gets 401
    const unauth = await new Promise((r) => http.get(`http://127.0.0.1:${port}/api/fleet/bundle`, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(unauth, 401);
    // Wrong commit gets 409
    const mismatch = await new Promise((r) => http.get(`http://127.0.0.1:${port}/api/fleet/bundle?commit=${c1}`, { headers: { Authorization: 'Bearer tok-123' } }, (res) => { res.resume(); r(res.statusCode); }));
    assert.equal(mismatch, 409);

    let guards = 0;
    const agentFleet = createAgentFleet({
      root: client, home, platform: 'linux',
      cfg: { server: `ws://127.0.0.1:${port}/agent`, token: 'tok-123' },
      spawnGuard: () => { guards++; },
    });
    // Point origin at a broken URL so only the NAS bundle can succeed
    git(client, 'remote', 'set-url', 'origin', 'http://127.0.0.1:1/nonexistent.git');
    const r = await agentFleet.apply({
      rid: 'r-gb', mode: 'git', commit: c2,
      gitBundle: { path: '/api/fleet/bundle', sha256: gb.sha256, size: gb.size },
    });
    assert.equal(r.ok, true, r.msg);
    assert.equal(r.restart, true);
    assert.equal(guards, 1);
    assert.equal(git(client, 'rev-parse', 'HEAD'), c2, 'pinned to deployed commit c2, not c3');
    assert.equal(fs.readFileSync(path.join(client, 'a.js'), 'utf8').trim(), 'v2');
  } finally {
    fleetSrv.close();
    srv.close();
  }
});

test('agent hookStatus detects installed hooks and syncSkills writes, skips unchanged, and backs up overwritten files', () => {
  const root = tmp('root-sk'), home = tmp('home-sk');
  // Prepare Claude and AGY directories; only Claude has our hook configured
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node /x/hook-relay.js' }] }],
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'node /x/permission-hook.js' }] }],
    },
  }));
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  write(path.join(home, '.gemini', 'config', 'hooks.json'), JSON.stringify({ hooks: {} }));

  const agent = createAgentFleet({ root, home, platform: 'linux', env: {} });
  const hs = agent.hookStatus();
  const byId = Object.fromEntries(hs.map((x) => [x.id, x]));
  assert.equal(byId.claude.present, true);
  assert.equal(byId.claude.installed, true);
  assert.equal(byId.agy.present, true);
  assert.equal(byId.agy.installed, false);
  assert.equal(byId.codex.present, false);

  // First sync writes to Claude, shared ~/.agents, and AGY skill dirs
  const r1 = agent.syncSkills([{ name: 'demo-skill', raw: '---\nname: demo-skill\n---\n# v1\n' }]);
  assert.equal(r1.ok, true, r1.msg);
  assert.equal(r1.written, 3);
  assert.equal(r1.unchanged, 0);
  const claudeSkill = path.join(home, '.claude', 'skills', 'demo-skill', 'SKILL.md');
  const agentsSkill = path.join(home, '.agents', 'skills', 'demo-skill', 'SKILL.md');
  const agySkill = path.join(home, '.gemini', 'config', 'skills', 'demo-skill', 'SKILL.md');
  assert.equal(fs.readFileSync(claudeSkill, 'utf8'), '---\nname: demo-skill\n---\n# v1\n');
  assert.equal(fs.readFileSync(agentsSkill, 'utf8'), '---\nname: demo-skill\n---\n# v1\n');
  assert.equal(fs.readFileSync(agySkill, 'utf8'), '---\nname: demo-skill\n---\n# v1\n');

  // Second sync with identical content is idempotent
  const r2 = agent.syncSkills([{ name: 'demo-skill', raw: '---\nname: demo-skill\n---\n# v1\n' }]);
  assert.equal(r2.ok, true);
  assert.equal(r2.written, 0);
  assert.equal(r2.unchanged, 3);

  // Third sync with updated content overwrites and creates backups
  const r3 = agent.syncSkills([{ name: 'demo-skill', raw: '---\nname: demo-skill\n---\n# v2\n' }]);
  assert.equal(r3.ok, true);
  assert.equal(r3.written, 3);
  assert.equal(fs.readFileSync(claudeSkill, 'utf8'), '---\nname: demo-skill\n---\n# v2\n');
  const backups = fs.readdirSync(path.join(home, '.ametyping', 'config-backups', 'skills'));
  assert.ok(backups.length >= 3, 'backups created before overwriting existing SKILL.md');

  // Invalid skill name is rejected
  const bad = agent.syncSkills([{ name: '../escape', raw: 'x' }]);
  assert.equal(bad.ok, false);
});

test('server fleet syncHooks and syncSkills fan out over agent RPC and expose hook status in view()', async () => {
  const dataDir = tmp('data-sync'), root = tmp('root-sync'), home = tmp('home-sync');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const agent = createAgentFleet({ root, home, platform: 'linux' });
  const machines = new Map();
  let fleet;
  const ws = {
    readyState: 1,
    sent: [],
    send(text) {
      const d = JSON.parse(text);
      this.sent.push(d);
      const reply = (t, o) => setImmediate(() => fleet.fromAgent(m, { t, rid: d.rid, ...o }, ws));
      if (d.t === 'fleet-sync-hooks') {
        reply('fleet-sync-hooks-result', {
          ok: true,
          msg: '已同步：Claude Hook、MCP',
          results: [{ name: 'Claude Hook', ok: true, msg: '完成' }, { name: 'MCP', ok: true, msg: '完成' }],
          hooks: [{ id: 'claude', label: 'Claude Code', present: true, installed: true }],
        });
      } else if (d.t === 'fleet-sync-skills') {
        reply('fleet-sync-skills-result', agent.syncSkills(d.skills));
      }
    },
  };
  const m = { name: 'pc1', online: true, sockets: new Set([ws]) };
  machines.set('pc1', m);
  fleet = createServerFleet({
    dataDir,
    machines,
    control: true,
    tickMs: 3600e3,
    getSkills: () => [
      { name: 'alpha-skill', raw: '# alpha\n' },
      { name: 'beta-skill', raw: '# beta\n' },
    ],
  });
  try {
    fleet.fromAgent(m, {
      t: 'fleet-version',
      mode: 'git',
      commit: C1,
      auto: true,
      control: true,
      hooks: [{ id: 'claude', label: 'Claude Code', present: true, installed: false }],
    }, ws);
    assert.equal(fleet.view().machines[0].version.hooks[0].installed, false);

    const hr = await fleet.syncHooks('*', '127.0.0.1');
    assert.equal(hr.ok, true, hr.msg);
    assert.equal(fleet.view().machines[0].version.hooks[0].installed, true);

    const sr = await fleet.syncSkills('*', ['alpha-skill'], '127.0.0.1');
    assert.equal(sr.ok, true, sr.msg);
    assert.equal(sr.count, 1);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'alpha-skill', 'SKILL.md'), 'utf8'), '# alpha\n');
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'beta-skill', 'SKILL.md')), false);
  } finally {
    fleet.close();
  }
});

test('Kiro hookStatus, winCmdQuote trailing-backslash safety, and Fleet bundle static require reachability', () => {
  const { winCmdQuote } = require('../agent/hook-installer-common');
  // CommandLineToArgvW: unquoted plain path keeps trailing backslash safe; quoted path doubles trailing backslashes
  assert.equal(winCmdQuote('D:\\ametyping\\'), 'D:\\ametyping\\');
  assert.equal(winCmdQuote('D:\\my repo\\'), '"D:\\my repo\\\\"');
  assert.equal(winCmdQuote('D:\\ametyping'), 'D:\\ametyping');

  const root = tmp('root-kiro'), home = tmp('home-kiro');
  const kiroAgentCfg = path.join(home, '.kiro', 'agents', 'default.json');
  write(kiroAgentCfg, JSON.stringify({ hooks: { stop: [{ command: 'node D:/ametyping/kiro-hook.js' }] } }));
  const agent = createAgentFleet({ root, home, platform: 'win32' });
  const kiroStatus = agent.hookStatus().find((h) => h.id === 'kiro');
  assert.deepEqual(kiroStatus, { id: 'kiro', label: 'Kiro', present: true, installed: true });

  // Verify every static relative require() from deploy.js HOOKS + remote/agent + headless resolves in working tree
  const repoRoot = path.resolve(__dirname, '..', '..');
  const deploySrc = fs.readFileSync(path.join(repoRoot, 'remote', 'deploy', 'deploy.js'), 'utf8');
  const hooksMatch = /const HOOKS = \[([\s\S]*?)\];/.exec(deploySrc);
  assert.ok(hooksMatch, 'HOOKS list found in deploy.js');
  const hookRoots = [...hooksMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(hookRoots.includes('kiro-hook.js') && hookRoots.includes('install-kiro-hooks.js'));
  assert.ok(hookRoots.includes('remote/agent/hook-common.js') && hookRoots.includes('remote/agent/hook-installer-common.js'));

  const visited = new Set();
  function walkDir(relDir) {
    for (const e of fs.readdirSync(path.join(repoRoot, relDir), { withFileTypes: true })) {
      const rel = path.posix.join(relDir, e.name);
      if (e.isDirectory()) walkDir(rel);
      else visit(rel);
    }
  }
  function visit(relFile) {
    if (visited.has(relFile)) return;
    visited.add(relFile);
    if (!/\.[cm]?js$/.test(relFile)) return;
    const src = fs.readFileSync(path.join(repoRoot, relFile), 'utf8');
    for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(relFile), m[1]));
      const target = [base, base + '.js', base + '/index.js'].find((f) => fs.existsSync(path.join(repoRoot, f)) && fs.statSync(path.join(repoRoot, f)).isFile());
      assert.ok(target, `${relFile} requires unresolved relative path ${m[1]}`);
      visit(target);
    }
  }
  walkDir('remote/agent');
  walkDir('headless');
  for (const h of hookRoots) visit(h);
  for (const mustHave of [
    'remote/agent/hook-common.js', 'remote/agent/hook-installer-common.js',
    'remote/agent/worktree.js', 'remote/agent/compute-dispatcher.js', 'remote/agent/mesh-bridge.js',
    'remote/agent/pet-client.js', 'remote/agent/session-scanner.js',
    'headless/cli-bin.js', 'app/cli-common.js', 'app/session-registry.js', 'app/control-guard.js',
    'app/session-locate.js', 'app/session-adopt.js',
  ]) {
    assert.ok(visited.has(mustHave), `Fleet dependency walk must include ${mustHave}`);
  }
});
