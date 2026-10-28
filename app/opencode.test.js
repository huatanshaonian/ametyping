'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-oc-'));
process.env.OPENCODE_AME_HOME = path.join(T, 'ame');
const SESS = path.join(process.env.OPENCODE_AME_HOME, 'sessions');
const opencode = require('../app/opencode');
const records = require('../app/opencode-records');

const SID = 'ses_abc123456789';
const TOKEN = 'a'.repeat(64);
const requests = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    requests.push({ url: req.url, auth: req.headers['x-ame-bridge'], origin: req.headers.origin, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-ame-bridge'] !== TOKEN) { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/prompt') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/interrupt') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/screen') return res.end(JSON.stringify({ ok: true, screen: '> 你好\n你好呀' }));
    res.statusCode = 404; res.end('{}');
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(SESS, { recursive: true });
  const port = server.address().port;
  fs.writeFileSync(path.join(SESS, `${SID}.jsonl`),
    JSON.stringify({ v: 1, type: 'meta', id: SID, cwd: '/work/proj', title: '演示', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ v: 1, uuid: 'title:改过的名字', role: 'title', text: '改过的名字', timestamp: new Date().toISOString(), cwd: '/work/proj' }) + '\n');
  fs.writeFileSync(path.join(SESS, `${SID}.json`),
    JSON.stringify({ v: 1, id: SID, provider: 'opencode', pid: process.pid, port, token: TOKEN, directory: '/work/proj', cwd: '/work/proj', title: '演示', transcript: path.join(SESS, `${SID}.jsonl`), updated: Date.now() }));
});
test.after(() => { server.close(); fs.rmSync(T, { recursive: true, force: true }); });

test('ids: namespaced for the dashboard, raw for OpenCode', () => {
  const { normalizeSession, providerOf, rawOf } = require('../app/session-source');
  assert.deepEqual(normalizeSession({ provider: 'opencode', session: SID }).session, 'opencode:' + SID);
  assert.equal(providerOf('opencode:' + SID), 'opencode');
  assert.equal(providerOf('codex:abc'), 'codex');
  assert.equal(providerOf(SID), 'claude');
  assert.equal(rawOf('opencode:' + SID), SID);
  assert.equal(opencode.rawId('opencode:' + SID), SID);
  assert.equal(opencode.nsId(SID), 'opencode:' + SID);
  assert.equal(opencode.isId(SID), true);
  assert.equal(opencode.isId('opencode:' + SID), true);
  assert.equal(opencode.isId('ses_'), false);
  assert.equal(opencode.isId('abc'), false);
});

test('the bridge the plugin left behind is used, with its token', async () => {
  assert.ok(opencode.metaOf('opencode:' + SID));
  const r = await opencode.prompt('opencode:' + SID, '继续');
  assert.deepEqual(r, { ok: true });
  const got = requests[requests.length - 1];
  assert.equal(got.url, '/prompt');
  assert.equal(got.auth, TOKEN);
  assert.equal(got.origin, undefined);
  assert.deepEqual(got.body, { sessionID: SID, text: '继续' });
  assert.deepEqual(await opencode.interrupt(SID), { ok: true });
  assert.deepEqual(await opencode.screen(SID), { ok: true, screen: '> 你好\n你好呀' });
});

test('a session whose host is gone says so instead of hanging', async () => {
  fs.mkdirSync(SESS, { recursive: true });
  fs.writeFileSync(path.join(SESS, 'ses_dead.json'), JSON.stringify({ v: 1, id: 'ses_dead', pid: 999999996, port: 1, token: TOKEN }));
  const r = await opencode.prompt('opencode:ses_dead', 'hi');
  assert.equal(r.ok, false);
  assert.match(r.msg, /没在运行/);
  assert.equal(opencode.transcriptOf('opencode:ses_dead'), null);
});

test('mirror files are found and titled', () => {
  assert.equal(opencode.transcriptOf('opencode:' + SID), path.join(SESS, `${SID}.jsonl`));
  assert.equal(records.fileOf(SID), path.join(SESS, `${SID}.jsonl`));
  assert.equal(records.titleOf(SID), '改过的名字');
  assert.deepEqual(records.metaOf(path.join(SESS, `${SID}.jsonl`)), { id: SID, cwd: '/work/proj', title: '演示' });
});

test('the npm shim resolves to the real executable, so a reply is never parsed by cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const bin = path.join(T, 'npmbin');
  const target = path.join(bin, 'node_modules', '@opencode', 'cli', 'bin');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'opencode.exe'), '');
  fs.writeFileSync(path.join(bin, 'opencode.cmd'), '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n');
  const c = opencode.command({ PATH: bin, APPDATA: path.join(T, 'no-appdata') });
  assert.ok(c && c.args.length === 0);
  assert.equal(path.normalize(c.exe).toLowerCase(), path.normalize(path.join(target, 'opencode.exe')).toLowerCase());
  assert.equal(opencode.command({ PATH: path.join(T, 'nowhere'), APPDATA: path.join(T, 'no-appdata') }), null);
});

test('the installer edits JSONC textually: comments survive, a re-run is a no-op, --remove restores', () => {
  const R = path.resolve(__dirname, '..');
  const file = path.join(T, 'opencode.jsonc');
  fs.writeFileSync(file, '{\n  // mine\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": ["other"],\n  "model": "x"\n}\n');
  let r = spawnSync(process.execPath, [path.join(R, 'install-opencode-plugin.js'), '--config', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  let text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\/\/ mine/);
  assert.match(text, /ametyping-opencode/);
  assert.match(text, /"other"/);
  r = spawnSync(process.execPath, [path.join(R, 'install-opencode-plugin.js'), '--config', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  r = spawnSync(process.execPath, [path.join(R, 'install-opencode-plugin.js'), '--config', file, '--remove'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const after = require('../install-opencode-plugin').parseJsonc(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.plugins, ['other']);
  assert.equal(after.model, 'x');
});

test('a config with no plugins key gets one, and the file stays valid JSONC', () => {
  const R = path.resolve(__dirname, '..');
  const file = path.join(T, 'new.json');
  fs.writeFileSync(file, '{\n  "model": "x"\n}\n');
  const r = spawnSync(process.execPath, [path.join(R, 'install-opencode-plugin.js'), '--config', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.model, 'x');
  assert.equal(cfg.plugins.length, 1);
  assert.match(cfg.plugins[0], /opencode-plugin$/);
});
