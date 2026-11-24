// The coding agents ("harnesses") on this computer -- Claude Code, Codex, OpenCode, Antigravity (agy) -- for
// 控制面板 › Skill 与协同 › 设备与 Harness:
//   inventory()            -> [{ id, label, installed, path, version }]   found by the program itself, not by its config
//                             folder (a config folder can be there before the program: memory sync, MCP registration)
//   run(id, action, opts)  action 'install' | 'update': only the commands written here, never one sent by the server;
//                          with the machine's proxy (the downloads go abroad). After an install the AmeTyping hooks,
//                          MCP registration and plugin of that harness are written too (the scripts in the repository).
// Installing writes no configuration of the harness's own (checked on panasonic 2026-11-24: npm i -g @openai/codex left
// ~/.codex/config.toml and AGENTS.md byte for byte, its first run only added its state files), so a config written
// before the install is what it reads.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const tail = (s, n = 1500) => (s.length > n ? '…' + s.slice(-n) : s);

// per harness: program names, extra places installers put them, how to install and update it
const SPEC = {
  claude: { label: 'Claude Code', names: ['claude'], dirs: (h) => [path.join(h, '.local', 'bin'), path.join(h, '.claude', 'local')],
    install: { linux: 'curl -fsSL https://claude.ai/install.sh | bash', win32: 'irm https://claude.ai/install.ps1 | iex' },
    update: { self: ['update'] }, after: ['install-mesh-mcp.js'] },
  codex: { label: 'Codex', names: ['codex'], dirs: () => [],
    install: { npm: '@openai/codex@latest' }, update: { npm: '@openai/codex@latest' }, after: ['install-codex-hooks.js', 'install-mesh-mcp.js'] },
  opencode: { label: 'OpenCode', names: ['opencode'], dirs: (h) => [path.join(h, '.opencode', 'bin')],
    install: { npm: '@opencode/cli@latest' }, update: { self: ['upgrade'] }, after: ['install-opencode-plugin.js', 'install-mesh-mcp.js'] },
  agy: { label: 'Antigravity', names: ['agy'], dirs: (h, env) => [path.join(h, '.local', 'bin'), path.join(env.LOCALAPPDATA || path.join(h, 'AppData', 'Local'), 'agy', 'bin')],
    install: { linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', win32: 'irm https://antigravity.google/cli/install.ps1 | iex' },
    update: { self: ['update'] }, after: ['install-agy-hooks.js', 'install-mesh-mcp.js'] },
};
const IDS = Object.keys(SPEC);
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
const PROXY_URL = /^https?:\/\/[^\s'"\\]+$/;

// this computer's proxy as 一键配置 set it: ~/.ametyping/harness-net.json { proxy, tools: ['codex'] } -- the
// downloads of an install or update go through it, and so do the harnesses in tools when the dashboard starts them
// (headless/launch.js). Claude Code and OpenCode reach Magpie on the LAN and need none.
const netFile = (home = os.homedir()) => path.join(home, '.ametyping', 'harness-net.json');
function readNet(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(netFile(home), 'utf8'));
    return { proxy: PROXY_URL.test(j.proxy || '') ? j.proxy : '', tools: Array.isArray(j.tools) ? j.tools.filter((t) => IDS.includes(t)) : [] };
  } catch { return { proxy: '', tools: [] }; }
}
function writeNet(net, home = os.homedir()) {
  const f = netFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify(net, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}
// the proxy a harness the dashboard starts should use ('' for none)
const proxyFor = (tool, home = os.homedir()) => { const n = readNet(home); return n.proxy && n.tools.includes(tool) ? n.proxy : ''; };

function createHarness({ home = os.homedir(), env = process.env, platform = process.platform, root = ROOT,
  exec = (cmd, args, o) => new Promise((res) => execFile(cmd, args, { windowsHide: true, maxBuffer: 16e6, ...o },
    (e, out, err) => res({ ok: !e, code: e ? e.code : 0, out: String(out || ''), err: String(err || '') || (e && !err ? e.message : '') }))) } = {}) {
  const win = platform === 'win32';
  const sep = path.delimiter;                          // (PATH as this system writes it)
  // where the programs may be: PATH, then the node this agent runs on (npm -g puts them beside it), then installers' own
  // folders -- a systemd service does not have the login shell's PATH
  function searchDirs() {
    const extra = [path.dirname(process.execPath), win ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm') : ''];
    for (const s of Object.values(SPEC)) extra.push(...s.dirs(home, env));
    return [...new Set([...String(env.PATH || env.Path || '').split(sep), ...extra].filter(Boolean))];
  }
  function childEnv(proxy) {
    const e = { ...env, PATH: searchDirs().join(sep) };
    if (win) delete e.Path;
    if (proxy) for (const k of PROXY_KEYS) e[k] = proxy;
    return e;
  }
  function find(id) {
    const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const d of searchDirs()) for (const n of SPEC[id].names) for (const x of exts) {
      const f = path.join(d, n + x);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
    return '';
  }
  // a .cmd on Windows only runs through cmd.exe
  // (verbatim: Node would escape the inner quotes as \" and cmd.exe takes those literally; /s strips the outer pair)
  const call = (bin, args, o) => (win && /\.(cmd|bat)$/i.test(bin)
    ? exec(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map((a) => `"${a}"`).join(' ')}"`], { ...o, windowsVerbatimArguments: true })
    : exec(bin, args, o));
  async function versionOf(bin, e) {
    const r = await call(bin, ['--version'], { timeout: 20e3, env: e });
    return ((r.out || r.err).split(/\r?\n/).find((l) => /\d+\.\d+/.test(l)) || '').trim().slice(0, 80);
  }
  let cache = null, cacheAt = 0;
  async function inventory({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cacheAt < 10 * 60e3) return cache;
    const e = childEnv('');
    cache = await Promise.all(IDS.map(async (id) => {
      const bin = find(id);
      return { id, label: SPEC[id].label, installed: !!bin, path: bin, version: bin ? await versionOf(bin, e) : '' };
    }));
    cacheAt = Date.now();
    return cache;
  }

  // the command for an action: [program, args] -- npm through this node's npm, a script through bash / PowerShell
  function commandFor(id, action, bin) {
    const s = SPEC[id], how = action === 'install' ? s.install : s.update;
    if (how.self) return bin ? [bin, how.self] : null;
    if (how.npm) {
      const npm = path.join(path.dirname(process.execPath), win ? 'npm.cmd' : 'npm');
      return [fs.existsSync(npm) ? npm : (win ? 'npm.cmd' : 'npm'), ['install', '-g', how.npm, '--no-audit', '--no-fund']];
    }
    const script = how[win ? 'win32' : 'linux'];
    if (!script) return null;
    return win ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]] : ['bash', ['-c', script]];
  }

  const busy = new Set();
  // -> { ok, id, action, before, after, msg, log }
  async function run(id, action, { proxy = readNet(home).proxy } = {}) {
    if (!SPEC[id]) return { ok: false, msg: '不认识的 harness：' + String(id).slice(0, 20) };
    if (action !== 'install' && action !== 'update') return { ok: false, msg: '只能安装或更新' };
    if (proxy && !PROXY_URL.test(proxy)) return { ok: false, msg: '代理地址格式不对' };
    if (busy.has(id)) return { ok: false, msg: SPEC[id].label + ' 正在安装或更新' };
    busy.add(id);
    try {
      const before = (await inventory({ fresh: true })).find((h) => h.id === id);
      if (action === 'install' && before.installed) return { ok: true, id, action, before: before.version, after: before.version, msg: '已经装了，没有重装' };
      if (action === 'update' && !before.installed) return { ok: false, id, action, msg: '还没装，先安装' };
      const cmd = commandFor(id, action, before.path);
      if (!cmd) return { ok: false, id, action, msg: '这个系统上没有现成的安装方法' };
      const e = childEnv(proxy);
      const r = await call(cmd[0], cmd[1], { timeout: 15 * 60e3, env: e, cwd: home });
      const log = [tail(r.out), tail(r.err)].filter((x) => x.trim()).join('\n');
      const after = (await inventory({ fresh: true })).find((h) => h.id === id);
      if (!after.installed) return { ok: false, id, action, before: before.version, msg: '命令跑完了，但还是找不到 ' + SPEC[id].names[0], log };
      const notes = [];
      if (action === 'install') {
        for (const script of SPEC[id].after) {
          const f = path.join(root, script);
          if (!fs.existsSync(f)) continue;
          const a = await exec(process.execPath, [f], { timeout: 60e3, env: e, cwd: root });
          if (!a.ok) notes.push(script + ' 失败：' + tail(a.err || a.out, 200));
        }
        if (id === 'codex') notes.push('Codex 第一次要登录（codex login --device-auth），再在 /hooks 里信任 AmeTyping 的 hooks');
        if (id === 'agy' || id === 'claude') notes.push('第一次打开时可能要登录或确认');
      }
      return { ok: r.ok, id, action, before: before.version, after: after.version,
        msg: r.ok ? (before.version === after.version && action === 'update' ? '已经是最新版' : `${action === 'install' ? '已安装' : '已更新'}：${after.version}`) : `命令出错（${r.code}）`,
        notes, log };
    } finally { busy.delete(id); }
  }
  return { inventory, run, commandFor, find };
}

module.exports = { createHarness, SPEC, IDS, readNet, writeNet, proxyFor, netFile, PROXY_URL };
