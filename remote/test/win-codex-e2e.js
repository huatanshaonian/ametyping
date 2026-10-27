// Real Windows console bridge, hooks and isolated headless service. Optional native Codex uses loopback only.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { fork, spawnSync, execFileSync } = require('child_process');
const { once } = require('events');
const { randomUUID } = require('crypto');
if (process.platform !== 'win32') { console.error('Run this test on Windows.'); process.exit(1); }
process.env.AME_TEST_HIDDEN_CONSOLES = '1';
require('./win-console-test-preload');
const ROOT = path.resolve(__dirname, '../..'), OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const temp = fs.mkdtempSync(path.join(OUT, 'win-codex-'));
const home = path.join(temp, 'home'), bin = path.join(temp, 'bin'), fixtureBin = path.join(temp, 'fixture'), cwd = path.join(temp, 'work');
for (const d of [home, bin, fixtureBin, cwd]) fs.mkdirSync(d);
const log = path.join(temp, 'cli.jsonl'), id = randomUUID(), sid = 'codex:' + id;
const bridge = require(path.join(ROOT, 'app/bridge'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qps = (s) => "'" + String(s).replace(/'/g, "''") + "'";
let service, env, token, port, passed = 0, provider, nativeWrapper = 0;
const fixtureWrappers = new Set();
const tokenFile = () => path.join(home, '.ametyping', 'control-token-' + port);
const rows = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const check = (n, c) => { assert.ok(c, n); passed++; console.log('PASS ' + n); };
async function until(fn, msg, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); }
  throw new Error(msg);
}
function call(method, url, data, auth = true, extra = {}) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : '';
    const req = http.request({ host: '127.0.0.1', port, path: url, method, timeout: 12000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(auth ? { 'X-Ame-Control': token } : {}), ...extra } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => text += c);
      res.on('end', () => { let body = {}; try { body = JSON.parse(text); } catch {} resolve({ code: res.statusCode, body }); });
    });
    req.once('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout'))); req.end(body);
  });
}
const state = async () => (await call('GET', '/control/state')).body.sessions || [];
const current = async () => (await state()).find((s) => s.id === sid);
const control = async (route, data) => (await call('POST', '/control/' + route, data)).body;
async function start() {
  service = fork(path.join(ROOT, 'headless/ame-headless-win.js'), [], { cwd, env, windowsHide: true,
    execArgv: ['--require', path.join(__dirname, 'win-console-test-preload.js')], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await until(() => {
    if (service.exitCode != null) throw new Error('headless service exited');
    try { token = fs.readFileSync(tokenFile(), 'utf8'); return token; } catch { return false; }
  }, 'headless service did not write token');
}
async function stop() {
  if (!service || service.exitCode != null || service.signalCode) return;
  const child = service; service = null;
  const closed = once(child, 'close'); child.send({ ameTestStop: true }); await closed;
}
function kill(pid) { if (pid) spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); }
(async () => {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  port = listener.address().port; await new Promise((r) => listener.close(r));
  const fake = path.join(fixtureBin, 'codex.exe');
  try { fs.linkSync(process.execPath, fake); } catch { fs.copyFileSync(process.execPath, fake); }
  fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${fake}" "${path.join(__dirname, 'fake-codex-tui.js')}" %*\r\n`);
  env = { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, 'codex home'), AME_PORT: String(port),
    PATH: [bin, path.dirname(process.execPath), process.env.SystemRoot + '\\System32', process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0', process.env.SystemRoot].join(path.delimiter),
    AME_FAKE_ID: id, AME_FAKE_LOG: log, AME_TEST_HOOK: path.join(ROOT, 'codex-hook.js'), AME_TEST_HIDDEN_CONSOLES: '1' };
  fs.mkdirSync(env.CODEX_HOME);
  await start();
  check('Windows headless service starts on isolated port', (await call('GET', '/control/state')).code === 200);
  check('unauthenticated control rejected', (await call('GET', '/control/state', null, false)).code === 403);
  check('browser Origin rejected', (await call('GET', '/control/state', null, true, { Origin: 'http://example.invalid' })).code === 403);
  const launched = await control('launch', { cwd, tool: 'codex' }); assert.ok(launched.ok, launched.msg);
  await until(() => rows().some((r) => r.kind === 'ready'), 'hidden Codex console not ready');
  const fixturePid = rows().find((r) => r.kind === 'start').pid;
  const fixtureChain = await bridge.ancestors(fixturePid);
  if (fixtureChain[1]?.name.toLowerCase() === 'cmd.exe') fixtureWrappers.add(fixtureChain[1].pid);
  const s = await until(async () => { const s = await current(); return s?.via === 'terminal' && s; }, 'launched Codex was not classified as an interactive terminal');
  check('remote launch locates Codex in its own hidden console', s.provider === 'codex');
  const registry = JSON.parse(fs.readFileSync(path.join(home, '.ametyping/codex-sessions', id + '.json'), 'utf8'));
  check('input target is exactly the test fixture PID', registry.pid === fixturePid);
  check('saved process identity matches actual Windows creation time', registry.identity === await bridge.identity(registry.pid));
  check('terminal screen reads Unicode prompt', /› Ask Codex/.test((await control('screen', { id: sid })).screen));
  const text = '第一行 hello\n\n第三行 world';
  check('Windows multiline reply accepted', (await control('send', { id: sid, text })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === text), 'Ctrl+J multiline text changed');
  check('WriteConsoleInput and Ctrl+J preserve Chinese and empty lines', true);
  await until(async () => (await current())?.state === 'done', 'reply did not finish');
  assert.ok((await control('key', { id: sid, key: 'down' })).ok);
  await until(() => rows().some((r) => r.kind === 'key' && r.key === '\x1b[B'), 'Down key did not arrive');
  check('navigation key reaches real console input', true);
  for (const choice of ['allow', 'deny', 'defer']) {
    await until(async () => (await current())?.state === 'done', 'previous turn not finished');
    const count = rows().filter((r) => r.kind === 'hook' && r.event === 'PermissionRequest').length;
    assert.ok((await control('send', { id: sid, text: 'PERMISSION' })).ok);
    const card = await until(async () => { const s = await current(); return s?.perms?.[0]; }, 'permission card missing');
    check('reply blocked during approval (' + choice + ')', !(await control('send', { id: sid, text: 'must not reach terminal' })).ok);
    assert.ok((await control('decide', { session: sid, id: card.id, choice })).ok);
    const result = await until(() => rows().filter((r) => r.kind === 'hook' && r.event === 'PermissionRequest')[count], 'hook decision missing');
    check('Codex hook decision protocol (' + choice + ')', choice === 'defer' ? Object.keys(result.result).length === 0 : result.result.hookSpecificOutput?.decision.behavior === choice);
  }
  await until(async () => (await current())?.state === 'done', 'last turn not finished');
  const old = token; await stop();
  check('graceful Windows shutdown removes token', !fs.existsSync(tokenFile()));
  check('Codex survives service restart', await bridge.alive(registry.pid));
  await start();
  check('restart rotates token', token !== old);
  check('old token rejected', (await call('GET', '/control/state', null, false, { 'X-Ame-Control': old })).code === 403);
  await until(async () => (await current())?.via === 'terminal', 'idle CLI not adopted after restart');
  check('idle Codex adopted without another hook', true);
  assert.ok((await control('send', { id: sid, text: 'after restart' })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'after restart'), 'adopted reply lost');
  check('adopted session accepts replies', true);
  await until(async () => (await current())?.state === 'done', 'adopted turn not finished');
  kill(registry.pid);
  check('closed CLI resumes through npm-style cmd shim', (await control('send', { id: sid, text: 'background reply' })).ok);
  check('reply blocked while background run is busy', !(await control('send', { id: sid, text: 'too soon' })).ok);
  const bg = await until(() => rows().find((r) => r.kind === 'start' && r.exec), 'background Codex did not start');
  check('background resume uses correct thread and stdin', bg.args.join(' ') === `exec resume --skip-git-repo-check ${id} -`);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'background reply'), 'background prompt lost');
  await until(async () => (await current())?.via === 'resume', 'background run left permanently busy');
  check('completed background run becomes resumable', true);
  assert.ok((await control('launch', { cwd, resume: sid })).ok);
  const resumed = await until(() => rows().find((r) => r.kind === 'start' && !r.exec && r.args[0] === 'resume'), 'resumed fixture not started');
  const resumedChain = await bridge.ancestors(resumed.pid);
  if (resumedChain[1]?.name.toLowerCase() === 'cmd.exe') fixtureWrappers.add(resumedChain[1].pid);
  await until(async () => (await current())?.via === 'terminal', 'reopened Codex not interactive');
  check('remote resume reopens interactive Windows console', true);
  assert.ok((await control('send', { id: sid, text: 'reopened reply' })).ok);
  await until(() => rows().some((r) => r.kind === 'input' && r.text === 'reopened reply'), 'reopened prompt lost');
  check('reopened Codex accepts replies', true);
  if (process.env.AME_REAL_CODEX) {
    const requests = [];
    provider = http.createServer((req, res) => {
      let body = ''; req.setEncoding('utf8'); req.on('data', (c) => body += c);
      req.on('end', () => { try { requests.push(JSON.parse(body)); } catch {} res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"intentional offline Windows acceptance endpoint"}}'); });
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    const nativeHome = path.join(home, 'native codex'); fs.mkdirSync(nativeHome);
    fs.writeFileSync(path.join(nativeHome, 'config.toml'), `model = "ame-offline-test"\nmodel_provider = "ame_offline"\nmodel_context_window = 128000\n` +
      `[model_providers.ame_offline]\nname = "Ame offline test"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nenv_key = "AME_OFFLINE_TEST_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n` +
      `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
    execFileSync(process.execPath, [path.join(ROOT, 'install-codex-hooks.js')], { env: { ...env, CODEX_HOME: nativeHome }, windowsHide: true });
    const before = new Set((await state()).map((s) => s.id));
    const ps = `$env:USERPROFILE=${qps(home)}; $env:HOME=${qps(home)}; $env:CODEX_HOME=${qps(nativeHome)}; $env:AME_PORT=${qps(String(port))}; $env:AME_OFFLINE_TEST_KEY='offline-test-placeholder'; & ${qps(process.env.AME_REAL_CODEX)} --no-daemon --no-alt-screen --dangerously-bypass-hook-trust -C ${qps(cwd)}`;
    nativeWrapper = await bridge.launch('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], cwd);
    const nativePid = await until(async () => (await bridge.descendants(nativeWrapper)).find((p) => /^codex\.exe$/i.test(p.name))?.pid, 'native child not started');
    await until(async () => /›/.test(await bridge.screen(nativeWrapper) || ''), 'native composer not ready');
    assert.ok((await bridge.send(nativeWrapper, 'Ame native bootstrap')).ok);
    let native;
    try { native = await until(async () => (await state()).find((s) => !before.has(s.id) && s.provider === 'codex' && s.via === 'terminal'), 'native Codex hooks not located', 25000); }
    catch (e) { e.message += '\nNATIVE SCREEN:\n' + await bridge.screen(nativeWrapper); throw e; }
    check('native Codex hooks locate Windows console', true);
    const nativeRecord = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(home, '.ametyping/codex-sessions', native.id.slice(6) + '.json'), 'utf8')); } catch { return null; }
    }, 'native process identity was not saved');
    check('native input target is our own child PID', nativeRecord.pid === nativePid);
    const nativeText = '原生 Codex 第一行\n第二行 Windows 验收';
    assert.ok((await control('send', { id: native.id, text: nativeText })).ok);
    const strings = (o) => typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];
    await until(() => requests.some((r) => strings(r).includes(nativeText)), 'native multiline text did not reach loopback exactly', 25000);
    check('native Codex receives Chinese multiline reply exactly', true);
    check('native Codex screen readable', (await control('screen', { id: native.id })).ok);
    await sleep(500); await stop(); await start();
    await until(async () => (await state()).some((s) => s.id === native.id && s.via === 'terminal'), 'native CLI not adopted after restart');
    check('native Codex adopted after Windows service restart', true);
  }
})().catch((e) => {
  console.error('FAIL ' + e.stack);
  try { console.error('SERVICE LOG:\n' + fs.readFileSync(path.join(home, '.ametyping/headless.log'), 'utf8')); } catch {}
  console.error('CLI LOG:\n' + JSON.stringify(rows().slice(-12))); process.exitCode = 1;
}).finally(async () => {
  await stop().catch(() => {});
  // Only fixture PIDs logged inside our private test directory, and our own native wrapper, are terminated.
  for (const pid of new Set(rows().filter((r) => r.kind === 'start').map((r) => r.pid))) if (await bridge.alive(pid)) kill(pid);
  for (const pid of fixtureWrappers) if (await bridge.alive(pid)) kill(pid);
  kill(nativeWrapper); bridge.stop();
  if (provider) { provider.closeAllConnections(); await new Promise((r) => provider.close(r)); }
  const target = fs.realpathSync(temp), root = fs.realpathSync(OUT);
  if (path.dirname(target) === root && path.basename(target).startsWith('win-codex-')) fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
});
