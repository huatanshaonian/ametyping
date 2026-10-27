// Linux-only, offline acceptance: real /proc, tmux, hook processes, service restart, launch and resume.
// Everything lives in one mkdtemp directory and a private tmux socket. Production services/config are untouched.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { randomUUID } = require('crypto');
if (process.platform !== 'linux') { console.error('Run this test on Linux (requires tmux).'); process.exit(1); }
const ROOT = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-linux-codex-'));
const home = path.join(temp, 'home'), bin = path.join(temp, 'bin'), cwd = path.join(temp, 'work');
for (const d of [home, bin, cwd]) fs.mkdirSync(d);
const socket = path.join(temp, 'tmux.sock'), log = path.join(temp, 'cli.jsonl'), id = randomUUID(), sid = 'codex:' + id;
let port, env, service, token, passed = 0, serviceLog = '', mockProvider;
const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
const tmux = (args) => execFileSync(realTmux, ['-S', socket, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rows = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
async function until(fn, msg, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await fn(); if (r) return r; await sleep(50); }
  throw new Error(msg);
}
const check = (name, fn) => { assert.ok(fn, name); passed++; console.log('PASS ' + name); };
function call(method, url, data, auth = true, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const req = http.request({ host: '127.0.0.1', port, path: url, method, timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(auth ? { 'X-Ame-Control': token } : {}), ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => text += c);
      res.on('end', () => { let body = {}; try { body = JSON.parse(text); } catch {} resolve({ code: res.statusCode, body }); });
    });
    req.once('error', reject); req.on('timeout', () => req.destroy(new Error('request timeout'))); req.end(body);
  });
}
const state = async () => (await call('GET', '/control/state')).body.sessions || [];
const current = async () => (await state()).find((s) => s.id === sid);
const control = async (route, data) => (await call('POST', '/control/' + route, data)).body;
async function start() {
  const s = service = spawn(process.execPath, [path.join(ROOT, 'headless/ame-headless.js')], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  s.stdout.on('data', (d) => serviceLog = (serviceLog + d).slice(-10000));
  s.stderr.on('data', (d) => serviceLog = (serviceLog + d).slice(-10000));
  await until(() => {
    if (s.exitCode != null) throw new Error('service exited: ' + serviceLog);
    try { token = fs.readFileSync(path.join(home, '.ametyping', 'control-token-' + port), 'utf8'); return token; } catch { return false; }
  }, 'service did not start');
}
async function stop() {
  if (!service || service.exitCode != null || service.signalCode) return;
  const child = service; service = null;
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
}
(async () => {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  port = listener.address().port; await new Promise((r) => listener.close(r));
  env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'codex home'), AME_PORT: String(port),
    PATH: bin + ':' + path.dirname(process.execPath) + ':' + process.env.PATH,
    AME_FAKE_ID: id, AME_FAKE_LOG: log, AME_TEST_HOOK: path.join(ROOT, 'codex-hook.js') };
  fs.mkdirSync(env.CODEX_HOME);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec ' + q(process.execPath) + ' ' + q(path.join(ROOT, 'remote/test/fake-codex-tui.js')) + ' "$@"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec ' + q(realTmux) + ' -S ' + q(socket) + ' "$@"\n', { mode: 0o700 });
  await start();
  check('control token is private (0600)', (fs.statSync(path.join(home, '.ametyping', 'control-token-' + port)).mode & 0o777) === 0o600);
  check('unauthenticated control rejected', (await call('GET', '/control/state', null, false)).code === 403);
  check('browser Origin rejected', (await call('GET', '/control/state', null, true, { Origin: 'http://example.invalid' })).code === 403);
  tmux(['new-session', '-d', '-s', 'root', '-x', '120', '-y', '35', '-c', cwd, q(path.join(bin, 'codex'))]);
  const live = await until(async () => { const s = await current(); return s?.via === 'terminal' && s; }, 'Codex hook did not locate its tmux pane');
  check('real hook locates Codex process and private tmux pane', live.provider === 'codex');
  const registryFile = path.join(home, '.ametyping/codex-sessions', id + '.json');
  const record = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const proc = require(path.join(ROOT, 'headless/proc-linux'));
  check('saved process identity matches Linux boot/start identity', record.identity === proc.identity(record.pid) && proc.findCodex(record.pid).pid === record.pid);
  check('hook transcript path reaches the saved session', record.transcript.endsWith('-' + id + '.jsonl'));
  await until(() => rows().some((r) => r.kind === 'ready' && r.id === id), 'CLI input not ready');
  const text = '第一行 hello\n第二行 world';
  check('multiline reply accepted', (await control('send', { id: sid, text })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === text), 'bracketed multiline paste changed text');
  check('real tmux bracketed paste preserves Chinese and newlines exactly', true);
  await until(async () => (await current())?.state === 'done', 'first reply not completed');
  check('literal terminal input accepted', (await control('key', { id: sid, key: 'c:nav-input' })).ok);
  check('Enter reaches terminal', (await control('key', { id: sid, key: 'enter' })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'nav-input'), 'navigation input lost');
  check('terminal screen can be read', (await control('screen', { id: sid })).screen.includes('RECEIVED'));
  for (const choice of ['allow', 'deny', 'defer']) {
    await until(async () => (await current())?.state === 'done', 'previous turn not completed');
    const count = rows().filter((r) => r.kind === 'hook' && r.event === 'PermissionRequest').length;
    assert.ok((await control('send', { id: sid, text: 'PERMISSION' })).ok);
    const pending = await until(async () => { const s = await current(); return s?.perms.length && s.perms[0]; }, 'permission card not listed');
    check('reply blocked while Codex asks (' + choice + ')', !(await control('send', { id: sid, text: 'must not reach terminal' })).ok);
    assert.ok((await control('decide', { session: sid, id: pending.id, choice })).ok);
    const result = await until(() => rows().filter((r) => r.kind === 'hook' && r.event === 'PermissionRequest')[count], 'hook did not receive decision');
    check('real permission hook returns Codex protocol (' + choice + ')', choice === 'defer' ? Object.keys(result.result).length === 0 : result.result.hookSpecificOutput?.decision.behavior === choice);
  }
  await until(async () => (await current())?.state === 'done', 'last permission turn not completed');
  const oldToken = token;
  await stop();
  check('service shutdown removes its token', !fs.existsSync(path.join(home, '.ametyping', 'control-token-' + port)));
  check('Codex tmux session survives headless restart', tmux(['list-sessions', '-F', '#{session_name}']).includes('root'));
  await start();
  check('service rotates its control token', token !== oldToken);
  check('old token rejected after restart', (await call('GET', '/control/state', null, false, { 'X-Ame-Control': oldToken })).code === 403);
  await until(async () => (await current())?.via === 'terminal', 'idle Codex was not adopted after restart');
  check('idle Codex adopted without another hook', true);
  assert.ok((await control('send', { id: sid, text: 'after restart' })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'after restart'), 'reply after restart lost');
  check('adopted session remains replyable', true);
  await until(async () => (await current())?.state === 'done', 'resumed reply not finished');
  tmux(['kill-session', '-t', 'root']);
  await until(() => !proc.alive(record.pid, 'codex'), 'CLI did not exit');
  check('closed CLI starts background resume', (await control('send', { id: sid, text: 'background reply' })).ok);
  check('second reply blocked while background resume runs', !(await control('send', { id: sid, text: 'too soon' })).ok);
  const bg = await until(() => rows().find((r) => r.kind === 'start' && r.exec), 'codex exec resume not started');
  check('background resume uses exact thread and stdin argument', bg.args.join(' ') === `exec resume --skip-git-repo-check ${id} -`);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'background reply'), 'background stdin prompt lost');
  await until(async () => (await current())?.via === 'resume', 'background resume left permanently busy');
  check('background completion restores resumable state', true);
  const reopened = await control('launch', { cwd, resume: sid });
  assert.ok(reopened.ok, reopened.msg);
  await until(async () => (await current())?.via === 'terminal', 'codex resume launch not located');
  check('remote launch reopens Codex thread in real tmux', true);
  assert.ok((await control('send', { id: sid, text: 'reopened reply' })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'reopened reply'), 'reopened reply lost');
  check('reopened session accepts reply', true);
  if (process.env.AME_REAL_CODEX) {
    // Native Codex talks only to this loopback stub, with a dummy key. No account credentials or model are used.
    const requests = [];
    mockProvider = http.createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (c) => body += c);
      req.on('end', () => { try { requests.push(JSON.parse(body)); } catch {} res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"intentional offline acceptance endpoint"}}'); });
    });
    mockProvider.listen(0, '127.0.0.1'); await once(mockProvider, 'listening');
    const nativeHome = path.join(home, 'native codex'); fs.mkdirSync(nativeHome);
    const config = `model = "ame-offline-test"\nmodel_provider = "ame_offline"\nmodel_context_window = 128000\n` +
      `[model_providers.ame_offline]\nname = "Ame offline test"\nbase_url = "http://127.0.0.1:${mockProvider.address().port}/v1"\nenv_key = "AME_OFFLINE_TEST_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n` +
      `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(path.join(nativeHome, 'config.toml'), config);
    execFileSync(process.execPath, [path.join(ROOT, 'install-codex-hooks.js')], { env: { ...env, CODEX_HOME: nativeHome }, stdio: 'pipe' });
    const before = new Set((await state()).map((s) => s.id));
    // Trust bypass is invocation-only, for our own freshly generated hooks in the isolated home, as documented
    // for one-off hook testing. It does not change the user's installed hooks or saved trust decisions.
    const cmd = `env CODEX_HOME=${q(nativeHome)} AME_OFFLINE_TEST_KEY=offline-test-placeholder ${q(process.env.AME_REAL_CODEX)} --no-daemon --no-alt-screen --dangerously-bypass-hook-trust -C ${q(cwd)}`;
    tmux(['new-session', '-d', '-s', 'native', '-x', '120', '-y', '40', '-c', cwd, cmd]);
    // A fresh native CLI can defer creating its thread (and SessionStart) until its first prompt.
    await until(() => /›/.test(tmux(['capture-pane', '-p', '-t', 'native:'])), 'native composer did not become ready');
    tmux(['send-keys', '-t', 'native:', '-l', '--', 'Ame native bootstrap']);
    await sleep(300); // Codex treats an Enter in the same fast input burst as part of a paste.
    tmux(['send-keys', '-t', 'native:', 'Enter']);
    let native;
    try { native = await until(async () => (await state()).find((s) => !before.has(s.id) && s.provider === 'codex' && s.via === 'terminal'), 'native Codex did not emit a locatable SessionStart', 20000); }
    catch (e) { e.message += '\nNATIVE SCREEN:\n' + tmux(['capture-pane', '-p', '-t', 'native:']); throw e; }
    check('native Codex hooks identify its thread and tmux pane', true);
    await until(() => /›/.test(tmux(['capture-pane', '-p', '-t', 'native:'])), 'native composer did not become ready');
    const nativeText = '原生 Codex 第一行\n第二行 Linux 验收';
    assert.ok((await control('send', { id: native.id, text: nativeText })).ok);
    const strings = (o) => typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];
    await until(() => requests.some((r) => strings(r).includes(nativeText)), 'native Codex did not preserve multiline input in its loopback request', 20000);
    check('native Codex preserves Chinese multiline reply exactly', true);
    check('native Codex screen is readable through service', (await control('screen', { id: native.id })).ok);
    await sleep(500);
    await stop(); await start();
    await until(async () => (await state()).some((s) => s.id === native.id && s.via === 'terminal'), 'native Codex not adopted after headless restart');
    check('native Codex is adopted after headless restart without a new message', true);
  }
})().catch((e) => { console.error('FAIL ' + e.stack + '\nSERVICE LOG:\n' + serviceLog + '\nCLI LOG:\n' + JSON.stringify(rows().slice(-12))); process.exitCode = 1; })
  .finally(async () => {
    await stop().catch(() => {});
    try { tmux(['kill-server']); } catch {}
    if (mockProvider) { mockProvider.closeAllConnections(); await new Promise((r) => mockProvider.close(r)); }
    if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('ame-linux-codex-')) fs.rmSync(temp, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
  });
