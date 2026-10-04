// Keeping a command-line AI tool on the NAS up to date (Codex, Claude Code -- they write the reports, read the mail):
// the version installed, the newest release (looked up through the same proxies as everything that leaves the NAS) by
// itself every 5 days -- the answer and when are kept in <dataDir>/<name>-check.json, so a restart does not ask again;
// opening the page only shows it, 「现在检查」 asks at once -- the update run only when asked (never by itself), and
// whether it is logged in (no tokens are read out). codex.js and claude.js say how for each tool.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHECK_EVERY = 5 * 86400e3, UPDATE_MS = 10 * 60e3;
const VERSION = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/;

// tool: { name ('codex'), label ('Codex'), bin (path or [cmd, ...args]), pathPrefix, versionHost, updateHost,
//         newest(egress) -> version string (throws when it cannot tell), login(run) -> { ok, text, mode, ... } }
// egress: the proxies (null: direct)
function createCliAdmin({ dataDir, tool, egress = null, log = () => {} }) {
  const file = dataDir ? path.join(dataDir, `${tool.name}-check.json`) : null;
  let latest = null, updating = null, lastUpdate = null;      // latest: { version, at, error }
  try { latest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  async function envFor(host) {
    let env = { ...process.env };
    if (egress) { const p = await egress.pick(host); if (p) env = egress.env(p); }
    if (tool.pathPrefix) env.PATH = tool.pathPrefix + path.delimiter + (env.PATH || '');
    return env;
  }
  // run the tool with these arguments: { code, out (stdout + stderr, the last 4000 characters) }
  function run(args, { env = process.env, timeoutMs = 60e3 } = {}) {
    const [cmd, ...pre] = Array.isArray(tool.bin) ? tool.bin : [tool.bin];
    return new Promise((resolve) => {
      let out = '';
      const p = spawn(cmd, [...pre, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const add = (d) => { out = (out + d).slice(-4000); };
      p.stdout.on('data', add); p.stderr.on('data', add);
      const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: `启动 ${tool.name} 失败：` + e.message }); });
      p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
  }

  async function version() {
    const r = await run(['--version'], { env: await envFor(tool.versionHost).catch(() => process.env), timeoutMs: 20e3 });
    const m = VERSION.exec(r.out);
    return m ? m[1] : '';
  }
  // force: 「现在检查」; otherwise only when the last look is 5 days old (the timer below)
  async function newest(force) {
    if (!force && latest && Date.now() - latest.at < CHECK_EVERY) return latest;
    try {
      const m = VERSION.exec(String(await tool.newest(egress)));
      latest = m ? { version: m[1], at: Date.now(), error: '' } : { version: '', at: Date.now(), error: '没认出版本号' };
    } catch (e) { latest = { version: '', at: Date.now(), error: e.message }; }
    if (file) try { fs.writeFileSync(file, JSON.stringify(latest), { mode: 0o600 }); } catch {}
    return latest;
  }
  const login = () => tool.login(run);

  // 「更新」: one at a time, in the background; status() tells how it went
  function update() {
    if (updating) return { ok: true, already: true };
    updating = (async () => {
      const from = await version();
      const r = await run(['update'], { env: await envFor(tool.updateHost), timeoutMs: UPDATE_MS });
      const to = await version();
      lastUpdate = { at: Date.now(), ok: r.code === 0, from, to, out: r.out.split('\n').filter(Boolean).slice(-8).join('\n') };
      log(`${tool.label} 更新：${from} -> ${to}${r.code === 0 ? '' : '（失败：' + r.out.slice(-200) + '）'}`);
    })().catch((e) => { lastUpdate = { at: Date.now(), ok: false, out: e.message }; }).finally(() => { updating = null; });
    return { ok: true };
  }

  async function status({ check = false } = {}) {
    const [v, n, l] = await Promise.all([version(), check ? newest(true) : Promise.resolve(latest || { version: '', at: 0, error: '' }), login()]);
    return { version: v, latest: n.version, latestError: n.error, checkedAt: n.at, updating: !!updating, lastUpdate, login: l };
  }
  // by itself: looked at an hour after start and then daily; it only asks when the last answer is 5 days old
  const timer = setInterval(() => newest(false).catch(() => {}), 86400e3); timer.unref && timer.unref();
  const first = setTimeout(() => newest(false).catch(() => {}), 3600e3); first.unref && first.unref();

  return { status, update, version, newest, login, stop() { clearInterval(timer); clearTimeout(first); } };
}

module.exports = { createCliAdmin };
