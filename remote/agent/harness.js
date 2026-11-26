// The coding agents ("harnesses") on this computer -- Claude Code, Codex, OpenCode, Antigravity (agy) -- for
// 控制面板 › Skill 与协同 › 设备与 Harness:
//   inventory()            -> [{ id, label, installed, path, version, method, line }]   found by the program itself, not
//                             by its config folder (a config folder can be there before the program: memory sync, MCP
//                             registration); method: how it was installed, which decides how it is updated
//   run(id, action, opts)  action 'install' | 'update': only the commands written here, never one sent by the server;
//                          downloads through the proxy (opts.proxy set for this computer, else the one detectNet found,
//                          else opts.fallback). opts.target: the newest version the server knows -- an update that
//                          leaves an older one says so, and OpenCode's old 1.x line is moved to it. After an install
//                          the AmeTyping hooks, MCP registration and plugin of that harness are written too.
//   detectNet()            which way out works here: the proxies this computer uses (set here, its interactive shell's,
//                          Windows' system proxy, the agent's own environment, local proxy ports) and going direct,
//                          each tried against OpenAI, npm, GitHub and the installers' hosts; the first proxy that
//                          reaches them all is recommended (kept in harness-net.json "detected")
// Installing writes no configuration of the harness's own (checked on panasonic 2026-11-24: installing Claude Code and
// Antigravity into a home whose config files were written first, and updating all four, left them byte for byte).
// The ways out differ per computer (2026-11-25): this PC and panasonic a local client at 127.0.0.1:10808; dell97 the
// router's sing-box (192.168.114.1:7890) only in interactive bash (~/proxy.sh); dell211 the same router, through its
// PowerShell profile and Windows' system proxy. The agent and headless services have none of them in their environment.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const tail = (s, n = 1500) => (s.length > n ? '…' + s.slice(-n) : s);
const VERSION = /(\d+)\.(\d+)\.(\d+)/;
const vnum = (s) => { const m = VERSION.exec(String(s || '')); return m ? m.slice(1).map(Number) : null; };
// a < b (versions as the programs print them; '' for unknown)
function older(a, b) {
  const x = vnum(a), y = vnum(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
const plain = (s) => { const m = VERSION.exec(String(s || '')); return m ? m[0] : ''; };

// per harness: program names, extra places installers put them, how to install it, how each kind of install updates
const SPEC = {
  claude: { label: 'Claude Code', names: ['claude'], dirs: (h) => [path.join(h, '.local', 'bin'), path.join(h, '.claude', 'local')],
    install: { linux: 'curl -fsSL https://claude.ai/install.sh | bash', win32: 'irm https://claude.ai/install.ps1 | iex' },
    update: { npm: '@anthropic-ai/claude-code@latest', self: ['update'] }, after: ['install-mesh-mcp.js'] },
  codex: { label: 'Codex', names: ['codex'], dirs: (h) => [path.join(h, '.local', 'bin')],
    install: { npm: '@openai/codex@latest' }, update: { npm: '@openai/codex@latest', self: ['update'] }, after: ['install-codex-hooks.js', 'install-mesh-mcp.js'] },
  opencode: { label: 'OpenCode', names: ['opencode'], dirs: (h) => [path.join(h, '.opencode', 'bin')],
    install: { npm: '@opencode/cli@latest' }, update: { self: ['upgrade'] }, after: ['install-opencode-plugin.js', 'install-mesh-mcp.js'] },
  agy: { label: 'Antigravity', names: ['agy'], dirs: (h, env) => [path.join(h, '.local', 'bin'), path.join(env.LOCALAPPDATA || path.join(h, 'AppData', 'Local'), 'agy', 'bin')],
    install: { linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', win32: 'irm https://antigravity.google/cli/install.ps1 | iex' },
    update: { self: ['update'] }, after: ['install-agy-hooks.js', 'install-mesh-mcp.js'] },
};
const IDS = Object.keys(SPEC);
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
const PROXY_URL = /^https?:\/\/[^\s'"\\]+$/;
// what goes direct whatever the proxy: the LAN, Tailscale, the NAS's gateway
const NO_PROXY = 'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10,.huatan.org,.ts.net,.local';

// this computer's network for the harnesses: ~/.ametyping/harness-net.json
//   { proxy: set for this computer (一键配置), detected: what detectNet found ('' = none needed / none works),
//     detectedAt, tools: the harnesses the dashboard starts through it (Codex: Claude Code and OpenCode reach Magpie
//     on the LAN and need none) }
const netFile = (home = os.homedir()) => path.join(home, '.ametyping', 'harness-net.json');
function readNet(home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(netFile(home), 'utf8'));
    return { proxy: PROXY_URL.test(j.proxy || '') ? j.proxy : '', detected: PROXY_URL.test(j.detected || '') ? j.detected : '',
      detectedAt: +j.detectedAt || 0, tools: Array.isArray(j.tools) ? j.tools.filter((t) => IDS.includes(t)) : ['codex'] };
  } catch { return { proxy: '', detected: '', detectedAt: 0, tools: ['codex'] }; }
}
function writeNet(n, home = os.homedir()) {
  const f = netFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify({ ...readNet(home), ...n }, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}
// the proxy a harness the dashboard starts should use ('' for none): set here, else detected
const proxyFor = (tool, home = os.homedir()) => { const n = readNet(home); return n.tools.includes(tool) ? (n.proxy || n.detected) : ''; };

// ---- reaching the outside: one GET, direct or through an HTTP proxy (CONNECT) -> status, or 0 when it did not answer ----
// (the request is written by hand on the TLS socket: https.request with agent:false ignores createConnection and goes
// direct -- through the proxy only by seeming, as found on dell97 2026-11-25)
function get(url, { proxy = '', timeout = 7000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    let done = false, sock = null, raw = null;
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch {} try { raw && raw.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => end(0), timeout);
    const fetchOver = (socket) => {
      sock = tls.connect({ ...(socket ? { socket } : { host: u.hostname, port: +u.port || 443 }), servername: u.hostname, ALPNProtocols: ['http/1.1'] });
      sock.on('secureConnect', () => sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: Windose\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
      let buf = '';
      sock.on('data', (d) => { buf += d.toString('latin1'); const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf); if (m) end(+m[1]); else if (buf.length > 4096) end(0); });
      sock.on('error', () => end(0));
      sock.on('end', () => end(0));
    };
    if (!proxy) return fetchOver(null);
    let p; try { p = new URL(proxy); } catch { return end(0); }
    const c = http.request({ host: p.hostname, port: +p.port || 80, method: 'CONNECT', path: `${u.hostname}:443`, headers: { Host: `${u.hostname}:443` } });
    c.on('connect', (res, socket) => { raw = socket; if (res.statusCode !== 200) return end(0); fetchOver(socket); });
    c.on('error', () => end(0));
    c.end();
  });
}
// what has to be reachable, and the answer that means it is (OpenAI refuses some regions with 403: only 401 is fine)
const TARGETS = [
  { id: 'openai', url: 'https://api.openai.com/v1/models', ok: (s) => s === 401 || s === 200 },
  { id: 'npm', url: 'https://registry.npmjs.org/-/ping', ok: (s) => s === 200 },
  { id: 'github', url: 'https://github.com/', ok: (s) => s >= 200 && s < 400 },
  { id: 'claude', url: 'https://downloads.claude.ai/claude-code-releases/latest', ok: (s) => s === 200 },
  { id: 'agy', url: 'https://antigravity.google/cli/install.sh', ok: (s) => s === 200 },
];
const portOpen = (port, host = '127.0.0.1') => new Promise((res) => {
  const s = net.connect({ host, port, timeout: 800 }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); });
});
// "host:port", "http=h:p;https=h:p" (Windows' ProxyServer) or a URL -> an http:// URL, or ''
function proxyUrlOf(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (/[;=]/.test(s)) { const m = /(?:^|;)https=([^;]+)/i.exec(s) || /(?:^|;)http=([^;]+)/i.exec(s); s = m ? m[1] : ''; }
  if (!s || /^socks/i.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return PROXY_URL.test(s) ? s.replace(/\/+$/, '') : '';
}

function createHarness({ home = os.homedir(), env = process.env, platform = process.platform, root = ROOT,
  exec = (cmd, args, o) => new Promise((res) => execFile(cmd, args, { windowsHide: true, maxBuffer: 16e6, ...o },
    (e, out, err) => res({ ok: !e, code: e ? e.code : 0, out: String(out || ''), err: String(err || '') || (e && !err ? e.message : '') }))),
  probe = get, ports = [10808, 10809, 7890, 7897] } = {}) {
  const win = platform === 'win32';
  const sep = path.delimiter;                          // (PATH as this system writes it)
  const npmDir = win ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm') : '';
  // where the programs may be: PATH, then the node this agent runs on (npm -g puts them beside it), then installers' own
  // folders -- a systemd service does not have the login shell's PATH
  function searchDirs() {
    const extra = [path.dirname(process.execPath), npmDir];
    for (const s of Object.values(SPEC)) extra.push(...s.dirs(home, env));
    return [...new Set([...String(env.PATH || env.Path || '').split(sep), ...extra].filter(Boolean))];
  }
  function childEnv(proxy) {
    const e = { ...env, PATH: searchDirs().join(sep) };
    if (win) delete e.Path;
    if (proxy) { for (const k of PROXY_KEYS) e[k] = proxy; e.NO_PROXY = e.no_proxy = NO_PROXY; }
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
  // how it was installed: 'npm' (a global npm package), or 'self' (its own installer, which updates it)
  function methodOf(id, bin) {
    if (!bin) return '';
    let real = bin; try { real = fs.realpathSync(bin); } catch {}
    const npm = /[\\/]node_modules[\\/]/.test(real) || (win && npmDir && path.dirname(bin).toLowerCase() === npmDir.toLowerCase());
    return npm ? 'npm' : 'self';
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
      const bin = find(id), version = bin ? await versionOf(bin, e) : '';
      const v = vnum(version);
      return { id, label: SPEC[id].label, installed: !!bin, path: bin, version, method: methodOf(id, bin),
        line: id === 'opencode' && v && v[0] < 2 ? 'legacy' : undefined };
    }));
    cacheAt = Date.now();
    return cache;
  }

  // the command for an action: [program, args] -- npm through this node's npm, a script through bash / PowerShell
  function commandFor(id, action, h = {}, { proxy = '', target = '' } = {}) {
    const s = SPEC[id];
    const npmCmd = (pkg) => {
      const npm = path.join(path.dirname(process.execPath), win ? 'npm.cmd' : 'npm');
      return [fs.existsSync(npm) ? npm : (win ? 'npm.cmd' : 'npm'), ['install', '-g', pkg, '--no-audit', '--no-fund']];
    };
    if (action === 'update') {
      if (!h.path) return null;
      if (h.method === 'npm' && s.update.npm) return npmCmd(s.update.npm);
      // OpenCode 1.x requires --major to cross into 2.x (confirmed on panasonic 2026-11-26)
      if (id === 'opencode' && h.line === 'legacy') return [h.path, ['upgrade', '--major']];
      // Windows standalone codex.exe invokes PowerShell 5.1 irm without proxy/TLS1.2; run the official script with proxy set
      if (win && id === 'codex' && h.method === 'self') {
        const pre = '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; '
          + (proxy ? `[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy('${proxy.replace(/'/g, '')}', $true); ` : '');
        return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          pre + '$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex']];
      }
      return s.update.self ? [h.path, s.update.self] : null;
    }
    if (s.install.npm) return npmCmd(s.install.npm);
    const script = s.install[win ? 'win32' : 'linux'];
    if (!script) return null;
    if (!win) return ['bash', ['-c', script]];
    // Windows PowerShell 5.1 does not read HTTPS_PROXY: the web requests of the script are given the proxy themselves
    const pre = '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; '
      + (proxy ? `[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy('${proxy.replace(/'/g, '')}', $true); ` : '');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', pre + script]];
  }

  // ---- which way out works ----
  async function candidates() {
    const out = [], add = (url, source) => { const u = proxyUrlOf(url); if (u && !out.some((c) => c.url === u)) out.push({ url: u, source }); };
    const n = readNet(home);
    add(n.proxy, '这台电脑设置的');
    if (win) {
      // the PowerShell profile's environment (what a terminal here has), then the system proxy
      const ps = await exec('powershell.exe', ['-NoLogo', '-NonInteractive', '-Command', 'Write-Output "$env:HTTPS_PROXY|$env:HTTP_PROXY"'], { timeout: 15e3 });
      for (const v of String(ps.out).trim().split('|')) add(v, 'PowerShell 配置文件');
      const reg = await exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { timeout: 8e3 });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(reg.out), server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(reg.out);
      if (enabled && server) add(server[1], 'Windows 系统代理');
    } else {
      // an interactive shell's environment (~/.bashrc: proxy.sh and the like)
      const sh = await exec('bash', ['-ic', 'printf "%s|%s" "${HTTPS_PROXY:-$https_proxy}" "${HTTP_PROXY:-$http_proxy}"'], { timeout: 15e3, env: { ...env, HOME: home } });
      for (const v of String(sh.out).trim().split('|')) add(v, '交互 shell（~/.bashrc）');
    }
    add(env.HTTPS_PROXY || env.https_proxy, 'agent 的环境变量');
    add(env.HTTP_PROXY || env.http_proxy, 'agent 的环境变量');
    for (const p of ports) if (await portOpen(p)) add(`http://127.0.0.1:${p}`, `本机端口 ${p}`);
    return out;
  }
  async function reach(proxy) {
    const t0 = Date.now();
    const res = await Promise.all(TARGETS.map(async (t) => [t.id, t.ok(await probe(t.url, { proxy }))]));
    return { reach: Object.fromEntries(res), ms: Date.now() - t0 };
  }
  // -> { at, direct: { reach }, routes: [{ url, source, reach, ms }], recommended, recommendedSource, needProxy }
  async function detectNet({ save = true } = {}) {
    const list = await candidates();
    const [direct, ...routes] = await Promise.all([reach(''), ...list.map((c) => reach(c.url))]);
    const all = (r) => TARGETS.every((t) => r.reach[t.id]);
    const needProxy = !all(direct);
    const i = routes.findIndex(all);
    const out = { at: Date.now(), direct, routes: list.map((c, k) => ({ ...c, ...routes[k] })), needProxy,
      recommended: needProxy && i >= 0 ? list[i].url : '', recommendedSource: needProxy && i >= 0 ? list[i].source : '' };
    if (save) try { writeNet({ detected: out.recommended, detectedAt: out.at }, home); } catch {}
    return out;
  }

  const busy = new Set();
  // -> { ok, id, action, before, after, target, behind, msg, notes, log }
  async function run(id, action, { proxy = '', fallback = '', target = '' } = {}) {
    if (!SPEC[id]) return { ok: false, msg: '不认识的 harness：' + String(id).slice(0, 20) };
    if (action !== 'install' && action !== 'update') return { ok: false, msg: '只能安装或更新' };
    for (const p of [proxy, fallback]) if (p && !PROXY_URL.test(p)) return { ok: false, msg: '代理地址格式不对' };
    if (busy.has(id)) return { ok: false, msg: SPEC[id].label + ' 正在安装或更新' };
    busy.add(id);
    try {
      const n = readNet(home), via = proxy || n.proxy || n.detected || fallback;
      const before = (await inventory({ fresh: true })).find((h) => h.id === id);
      if (action === 'install' && before.installed) return { ok: true, id, action, before: before.version, after: before.version, msg: '已经装了，没有重装' };
      if (action === 'update' && !before.installed) return { ok: false, id, action, msg: '还没装，先安装' };
      if (action === 'update' && target && !older(before.version, target) && before.line !== 'legacy')
        return { ok: true, id, action, before: before.version, after: before.version, target, msg: '已经是最新版（' + plain(target) + '）' };
      const cmd = commandFor(id, action, before, { proxy: via, target });
      if (!cmd) return { ok: false, id, action, msg: '这个系统上没有现成的安装方法' };
      const e = childEnv(via);
      const r = await call(cmd[0], cmd[1], { timeout: 15 * 60e3, env: e, cwd: home });
      const log = [`$ ${path.basename(cmd[0])} ${cmd[1].join(' ').slice(0, 200)}${via ? '  （经 ' + via + '）' : ''}`, tail(r.out), tail(r.err)].filter((x) => x.trim()).join('\n');
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
      if (after.line === 'legacy') notes.push('OpenCode 还在旧的 1.x 线上（看板的配置按 2.x 写），需要迁移到 2.x');
      // the version did not move although a newer one exists: not "already the newest"
      const behind = !!(target && older(after.version, target));
      const changed = before.version !== after.version;
      const msg = !r.ok ? `命令出错（${r.code}）` + (behind ? `，仍是 ${plain(after.version)}` : '')
        : action === 'install' ? `已安装：${after.version}`
        : behind ? `命令跑完了，但版本还是 ${plain(after.version)}（最新是 ${plain(target)}）`
        : changed ? `已更新：${plain(before.version)} → ${plain(after.version)}` : '已经是最新版';
      return { ok: r.ok && !behind, id, action, before: before.version, after: after.version, target, behind, msg, notes, log };
    } finally { busy.delete(id); }
  }
  return { inventory, run, commandFor, find, methodOf, detectNet, candidates };
}

module.exports = { createHarness, SPEC, IDS, TARGETS, readNet, writeNet, proxyFor, netFile, PROXY_URL, NO_PROXY, older, plain, proxyUrlOf, get };
