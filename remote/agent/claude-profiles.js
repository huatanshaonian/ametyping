// Local provider files share one Claude installation/history: ~/cc-environments/<provider>/settings.json.
// This module is also the standalone launcher installed on machines without an existing Start-CC launcher.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const BYPASS = ['NO_PROXY', 'no_proxy'];
const RESET = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AWS', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER', ...PROXIES, ...BYPASS];
const EXTRA = new Set(['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', ...PROXIES, ...BYPASS]);
const AUTH = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS'];
const CLEAR = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', ...EXTRA, ...RESET];
const folderOf = id => id === 'nebula' ? 'apinebula' : id;
const idOf = folder => folder === 'apinebula' ? 'nebula' : folder;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const qps = s => "'" + String(s).replace(/'/g, "''") + "'";
const qsh = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function createProfiles(options = {}) {
  const home = options.home || os.homedir();
  const root = options.root || process.env.AME_CC_HOME || path.join(home, 'cc-environments');
  const shared = path.join(home, '.claude', 'settings.json');
  const win = (options.platform || process.platform) === 'win32';
  const resolveFile = (id, write = false) => {
    if (!ID.test(String(id || '')) || ['runtime', 'backups'].includes(folderOf(id))) throw new Error('无效的启动入口');
    const dir = path.join(root, folderOf(id)), file = path.join(dir, 'settings.json');
    if (fs.existsSync(dir) && path.dirname(fs.realpathSync(dir)) !== fs.realpathSync(root)) throw new Error('配置目录不在 cc-environments 内');
    if (fs.existsSync(file) && path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) throw new Error('配置文件不在对应目录内');
    if (!write && !fs.existsSync(file)) throw new Error('这台电脑没有 claude-' + id + '，请先配置对应入口');
    return file;
  };
  function settings(id) {
    const file = resolveFile(id), stat = fs.statSync(file);
    if (stat.size > 256 * 1024) throw new Error('API 配置文件过大');
    let j; try { j = parse(file); } catch { throw new Error('API 配置不是有效的 JSON：' + file); }
    if (!object(j) || !object(j.env)) throw new Error('API 配置需要 env 对象');
    const env = {};
    for (const [k, v] of Object.entries(j.env)) {
      if ((/^ANTHROPIC_[A-Z0-9_]+$/.test(k) || EXTRA.has(k)) && typeof v === 'string' && v.length <= 8000) env[k] = v;
    }
    return { env, model: typeof j.model === 'string' ? j.model : '' };
  }
  function read(id) {
    try {
      const s = settings(id), proxies = PROXIES.map(k => s.env[k]).filter(Boolean);
      const base = new URL(s.env.ANTHROPIC_BASE_URL || '');
      const proxy = proxies[0] || '';
      const publicProxy = proxy && (() => { try { const p = new URL(proxy); return p.username || p.password ? '__UNCHANGED__' : proxy; } catch { return ''; } })();
      return { ok: true, profile: { id, command: 'claude-' + id, file: resolveFile(id),
        baseUrl: base.username || base.password || base.search ? '__UNCHANGED__' : base.href.replace(/\/$/, ''),
        baseHost: base.host, model: s.model, hasCredential: AUTH.some(k => !!s.env[k]),
        network: proxies.length ? 'proxy' : 'direct', proxy: publicProxy || '' } };
    } catch (e) { return { ok: false, msg: e.message }; }
  }
  function list() {
    let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch {}
    const profiles = [];
    for (const d of dirs) {
      if (!d.isDirectory() || !ID.test(d.name) || ['runtime', 'backups'].includes(d.name)) continue;
      const id = idOf(d.name), r = read(id);
      if (r.ok && !profiles.some(p => p.id === id)) profiles.push(r.profile);
    }
    profiles.sort((a, b) => a.id.localeCompare(b.id));
    return { root, sharedDirectory: path.join(home, '.claude'), sharedState: path.join(home, '.claude.json'),
      profiles, aliases: profiles.map(p => ({ id: p.id, label: p.command, model: p.model, network: p.network })), default: '' };
  }
  function resolve(id) {
    const s = settings(id);
    if (!s.model || !s.env.ANTHROPIC_BASE_URL || !AUTH.some(k => s.env[k])) throw new Error('claude-' + id + ' 尚未配置接口、密钥或默认模型');
    return { id, local: true, label: 'claude-' + id, settings: s,
      proxy: PROXIES.map(k => s.env[k]).find(Boolean) || 'direct' };
  }
  function save(d) {
    try {
      const id = String(d.id || ''), file = resolveFile(id, true);
      let original = {};
      if (fs.existsSync(file)) { try { original = parse(file); } catch { throw new Error('原配置不是有效的 JSON，请先修正该电脑上的配置文件'); } }
      if (!object(original)) throw new Error('原配置格式不正确');
      const env = object(original.env) ? { ...original.env } : {};
      const baseUrl = d.baseUrl === '__UNCHANGED__' ? env.ANTHROPIC_BASE_URL : d.baseUrl;
      const base = new URL(baseUrl);
      if (!/^https?:$/.test(base.protocol)) throw new Error('接口地址需要 http 或 https');
      if (typeof d.model !== 'string' || !d.model.trim() || d.model.length > 120 || /[\r\n]/.test(d.model)) throw new Error('请填写默认模型');
      env.ANTHROPIC_BASE_URL = baseUrl;
      if (d.key) {
        if (typeof d.key !== 'string' || d.key.length > 8000 || /[\r\n]/.test(d.key)) throw new Error('密钥格式不正确');
        const auth = env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
        env[auth] = d.key;
        env[auth === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = '';
      }
      if (d.network === 'direct') {
        for (const k of PROXIES) env[k] = '';
        for (const k of BYPASS) env[k] = 'localhost,127.0.0.1,' + base.hostname;
      } else if (d.network === 'proxy') {
        const proxy = d.proxy === '__UNCHANGED__' ? PROXIES.map(k => env[k]).find(Boolean) : d.proxy;
        let p; try { p = new URL(proxy); } catch { throw new Error('请填写这台电脑的代理地址'); }
        if (!/^https?:$/.test(p.protocol)) throw new Error('代理需要 http 或 https');
        for (const k of PROXIES) env[k] = proxy;
        for (const k of BYPASS) env[k] = 'localhost,127.0.0.1';
      } else throw new Error('请选择网络方式');
      const next = { ...original, env, model: d.model.trim() };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) {
        const dir = path.join(root, 'backups', folderOf(id)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const backup = path.join(dir, 'settings-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
        fs.copyFileSync(file, backup); fs.chmodSync(backup, 0o600);
      }
      const tmp = file + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
      try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
      finally { try { fs.unlinkSync(tmp); } catch {} }
      install();
      return read(id);
    } catch (e) { return { ok: false, msg: e.message }; }
  }
  function infer(env = process.env) {
    if (env.AME_CLAUDE_API && ID.test(env.AME_CLAUDE_API)) return env.AME_CLAUDE_API;
    for (const p of list().profiles) {
      const s = settings(p.id);
      if (s.env.ANTHROPIC_BASE_URL === env.ANTHROPIC_BASE_URL &&
        AUTH.some(k => s.env[k] && s.env[k] === env[k])) return p.id;
    }
    return '';
  }
  function runtime(id, sourceEnv = process.env) {
    const p = resolve(id), s = p.settings;
    let base = {}; try { base = parse(shared); } catch {}
    const env = { ...sourceEnv };
    for (const k of Object.keys(env)) if (RESET.includes(k) || /^ANTHROPIC_/.test(k)) delete env[k];
    for (const [k, v] of Object.entries(object(base.env) ? base.env : {}))
      if (!RESET.slice(0, 2).includes(k) && !/^AME_/.test(k)) env[k] = String(v);
    const overlay = {};
    for (const k of new Set([...CLEAR, ...Object.keys(env).filter(k => /^ANTHROPIC_/.test(k))])) overlay[k] = '';
    Object.assign(overlay, s.env);
    // A provider without proxy values is direct, including when the parent came from a proxy-backed session.
    if (!PROXIES.some(k => overlay[k])) for (const k of BYPASS) overlay[k] = overlay[k] || 'localhost,127.0.0.1,' + new URL(s.env.ANTHROPIC_BASE_URL).hostname;
    for (const [k, v] of Object.entries(overlay)) { if (v) env[k] = v; else delete env[k]; }
    delete env.CLAUDE_CONFIG_DIR; delete env.CLAUDE_CODE_PROJECT_DIR_NAME; env.AME_CLAUDE_API = id;
    const dir = path.join(root, 'runtime'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'windose-' + folderOf(id) + '-' + process.pid + '-' + crypto.randomBytes(5).toString('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify({ env: overlay, model: s.model }, null, 2), { mode: 0o600 });
    return { env, file, args: ['--settings', file, '--setting-sources', 'user,project,local', '--model', s.model],
      cleanup() { try { fs.unlinkSync(file); } catch {} } };
  }
  function executable(env = process.env) {
    for (const dir of String(env.PATH || '').split(path.delimiter).concat(path.join(home, '.local', 'bin'))) {
      const file = path.join(dir, win ? 'claude.exe' : 'claude');
      if (dir && fs.existsSync(file)) return file;
    }
    throw new Error('找不到 Claude Code 程序');
  }
  function command(id, { cwd = process.cwd(), args = [], env = process.env, native = false } = {}) {
    resolve(id);
    const ps = path.join(root, 'Start-CC.ps1');
    if (win && !native && fs.existsSync(ps) && ['nebula', 'deepseek'].includes(id)) return { exe: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(windowCommand(id, cwd, args), 'utf16le').toString('base64')],
      env: { ...env, AME_CLAUDE_API: id }, cleanup() {} };
    const exe = executable(env), r = runtime(id, env);
    return { exe, args: [...r.args, ...args], env: r.env, file: r.file, cleanup: r.cleanup };
  }
  function windowCommand(id, cwd, args = []) {
    resolve(id);
    const ps = path.join(root, 'Start-CC.ps1');
    const before = '$windosePreviousApi=$env:AME_CLAUDE_API; try { $env:AME_CLAUDE_API=' + qps(id) + '; ';
    const after = ' } finally { $env:AME_CLAUDE_API=$windosePreviousApi }';
    if (fs.existsSync(ps) && ['nebula', 'deepseek'].includes(id)) {
      const check = args.includes('-Check'), rest = args.filter(a => a !== '-Check');
      return before + '& ' + qps(ps) + ' -EnvironmentName ' + qps(folderOf(id)) + ' -ProjectDir ' + qps(cwd) +
        (check ? ' -Check' : '') + (rest.length ? ' -ClaudeArgs @(' + rest.map(qps).join(',') + ')' : '') + after;
    }
    const r = command(id, { cwd, args, native: true });
    return before + 'Remove-Item Env:CLAUDE_CONFIG_DIR,Env:CLAUDE_CODE_PROJECT_DIR_NAME -ErrorAction SilentlyContinue; & ' +
      qps(r.exe) + ' ' + r.args.map(qps).join(' ') + after;
  }
  function install() {
    // Existing user-owned launchers are the authority. Install missing entry points only.
    if (!fs.existsSync(root)) return;
    const standalone = path.join(root, 'Start-CC.js');
    const marker = '// Windose cc-environments launcher';
    const source = marker + '\n' + fs.readFileSync(__filename, 'utf8').replace(/^\/\/ Windose cc-environments launcher\n/, '');
    if (!fs.existsSync(standalone) || fs.readFileSync(standalone, 'utf8').startsWith(marker)) fs.writeFileSync(standalone, source, { mode: 0o600 });
    const bin = path.join(home, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    for (const p of list().profiles) {
      const file = path.join(bin, p.command + (win ? '.cmd' : ''));
      let old = ''; try { old = fs.readFileSync(file, 'utf8'); } catch {}
      if (old && !old.includes('ametyping-claude-api') && !old.includes('Windose cc-environments launcher')) continue;
      const text = win ? '@echo off\r\nrem ' + marker.slice(3) + '\r\n"' + process.execPath + '" "' + standalone + '" ' + p.id + ' %*\r\n'
          : '#!/bin/sh\n# ' + marker.slice(3) + '\nexec ' + qsh(process.execPath) + ' ' + qsh(standalone) + ' ' + qsh(p.id) + ' "$@"\n';
      if (text !== old) fs.writeFileSync(file, text, { mode: win ? 0o644 : 0o755 });
    }
  }
  return { home, root, list, read, save, resolve, infer, runtime, command, windowCommand, install };
}
module.exports = { createProfiles, ID, folderOf, idOf };
if (require.main === module) {
  const profiles = createProfiles(), id = idOf(process.argv[2] || ''), input = process.argv.slice(3);
  let cwd = process.cwd(), check = false, args = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '-ProjectDir') cwd = path.resolve(input[++i] || '');
    else if (input[i] === '-Check') check = true;
    else args.push(input[i]);
  }
  try {
    if (check) { const r = profiles.read(id); if (!r.ok) throw new Error(r.msg); console.log(JSON.stringify(r.profile)); }
    else {
      const plan = profiles.command(id, { cwd, args });
      const p = spawn(plan.exe, plan.args, { cwd, env: plan.env, stdio: 'inherit', windowsHide: false });
      p.on('error', () => { plan.cleanup(); console.error('启动 Claude Code 失败'); process.exitCode = 1; });
      p.on('close', code => { plan.cleanup(); process.exitCode = code == null ? 1 : code; });
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
