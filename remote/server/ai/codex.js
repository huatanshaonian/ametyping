// Keeping the Codex CLI on the NAS up to date (it writes the reports, reads the mail): the version installed, the
// newest release (GitHub, through the same proxies as everything that leaves the NAS) looked up by itself every 5 days
// -- the answer and when are kept in <dataDir>/codex-check.json, so a restart does not ask again; opening the page only
// shows it, 「现在检查」 asks at once -- and `codex update` run only when asked (never by itself), and whether it is
// logged in (`codex login status` and when the sign-in was last refreshed -- no tokens are read out). The standalone install switches its `current` link to the new
// release, so a report being written at that moment carries on with the old one.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { request } = require('../google/http');

const CHECK_EVERY = 5 * 86400e3, UPDATE_MS = 10 * 60e3;
const VERSION = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

// codex: { bin (path or [cmd, ...args]), pathPrefix }; egress: the proxies (null: direct)
function createCodexAdmin({ dataDir, codex, egress = null, codexHome = path.join(os.homedir(), '.codex'), log = () => {} }) {
  const file = dataDir ? path.join(dataDir, 'codex-check.json') : null;
  let latest = null, updating = null, lastUpdate = null;      // latest: { version, at, error }
  try { latest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  async function envFor(host) {
    let env = { ...process.env };
    if (egress) { const p = await egress.pick(host); if (p) env = egress.env(p); }
    if (codex.pathPrefix) env.PATH = codex.pathPrefix + path.delimiter + (env.PATH || '');
    return env;
  }
  // run codex with these arguments: { code, out (stdout + stderr, the last 4000 characters) }
  function run(args, { env = process.env, timeoutMs = 60e3 } = {}) {
    const [cmd, ...pre] = Array.isArray(codex.bin) ? codex.bin : [codex.bin];
    return new Promise((resolve) => {
      let out = '';
      const p = spawn(cmd, [...pre, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const add = (d) => { out = (out + d).slice(-4000); };
      p.stdout.on('data', add); p.stderr.on('data', add);
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '启动 codex 失败：' + e.message }); });
      p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
  }

  async function version() {
    const r = await run(['--version'], { env: await envFor('chatgpt.com').catch(() => process.env), timeoutMs: 20e3 });
    const m = VERSION.exec(r.out);
    return m ? m[1] : '';
  }
  // the newest release on GitHub (tags look like rust-v0.158.0)
  // force: 「现在检查」; otherwise only when the last look is 5 days old (the timer below)
  async function newest(force) {
    if (!force && latest && Date.now() - latest.at < CHECK_EVERY) return latest;
    try {
      const r = await request('https://api.github.com/repos/openai/codex/releases/latest', { headers: { 'User-Agent': 'Windose', Accept: 'application/vnd.github+json' } }, egress);
      const m = r.status === 200 && r.json && VERSION.exec(String(r.json.tag_name || ''));
      latest = m ? { version: m[1], at: Date.now(), error: '' } : { version: '', at: Date.now(), error: 'GitHub 回答 ' + r.status };
    } catch (e) { latest = { version: '', at: Date.now(), error: e.message }; }
    if (file) try { fs.writeFileSync(file, JSON.stringify(latest), { mode: 0o600 }); } catch {}
    return latest;
  }
  async function login() {
    const r = await run(['login', 'status'], { timeoutMs: 20e3 });
    let mode = '', refreshed = '';
    try { const a = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')); mode = String(a.auth_mode || ''); refreshed = String(a.last_refresh || ''); } catch {}
    const text = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    return { ok: r.code === 0 && !/not logged in/i.test(text), text: text.slice(0, 200), mode, refreshed };
  }

  // 「更新 Codex」: one at a time, in the background; status() tells how it went
  function update() {
    if (updating) return { ok: true, already: true };
    updating = (async () => {
      const from = await version();
      const r = await run(['update'], { env: await envFor('github.com'), timeoutMs: UPDATE_MS });
      const to = await version();
      lastUpdate = { at: Date.now(), ok: r.code === 0, from, to, out: r.out.split('\n').filter(Boolean).slice(-8).join('\n') };
      log(`Codex 更新：${from} -> ${to}${r.code === 0 ? '' : '（失败：' + r.out.slice(-200) + '）'}`);
    })().catch((e) => { lastUpdate = { at: Date.now(), ok: false, out: e.message }; }).finally(() => { updating = null; });
    return { ok: true };
  }

  async function status({ check = false } = {}) {
    const [v, n, l] = await Promise.all([version(), check ? newest(true) : Promise.resolve(latest || { version: '', at: 0, error: '' }), login()]);
    return { version: v, latest: n.version, latestError: n.error, checkedAt: n.at, updating: !!updating, lastUpdate, login: l };
  }
  // by itself: looked at an hour after start and then daily; it only asks GitHub when the last answer is 5 days old
  const timer = setInterval(() => newest(false).catch(() => {}), 86400e3); timer.unref && timer.unref();
  const first = setTimeout(() => newest(false).catch(() => {}), 3600e3); first.unref && first.unref();

  return { status, update, version, newest, login, stop() { clearInterval(timer); clearTimeout(first); } };
}

module.exports = { createCodexAdmin };
