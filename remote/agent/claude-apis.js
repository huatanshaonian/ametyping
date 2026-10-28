// Claude Code API aliases on this machine (server/claude-apis.js is the source of truth):
//   ~/.ametyping/claude-apis.local.json   the aliases resolved for this machine (tokens included, 0600)
//   ~/.ametyping/claude-api-launch.js     the launcher the terminal wrappers call (copied from this folder)
//   ~/.local/bin/claude-<id>[.cmd]        one wrapper per alias, so `claude-deepseek` works in a terminal
// The server sends this machine's resolved aliases on connect and after every change. The agent also reads this
// machine's ~/.claude/settings.json when the control panel asks to import it -- only the API-relevant slice, and the
// key goes to the server (never to the browser).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const AME = path.join(HOME, '.ametyping');
const MIRROR = path.join(AME, 'claude-apis.local.json');
const ALIAS_DIR = path.join(AME, 'claude-apis');
const INDEX = path.join(AME, 'claude-apis.index.json');
const LAUNCHER = path.join(AME, 'claude-api-launch.js');
const BIN = path.join(HOME, '.local', 'bin');
const BACKUP = path.join(AME, 'backups');
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'];
const ALIAS = /^[A-Za-z0-9._-]{1,40}$/;
const WIN = process.platform === 'win32';
const MARK = 'ametyping-claude-api';
const SETTINGS_KEYS = ['env', 'model', 'effortLevel', 'modelSettings', 'alwaysThinkingEnabled', 'language'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function pickSettings(j) {
  if (!isObj(j)) return {};
  const out = {};
  for (const k of SETTINGS_KEYS) if (j[k] != null) out[k] = j[k];
  return out;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// an untouched first copy forever, plus the last 20 versions before a change; never deletes the original
function backupFile(file, name, originalName) {
  let buf; try { buf = fs.readFileSync(file); } catch { return null; }
  try {
    fs.mkdirSync(BACKUP, { recursive: true, mode: 0o700 });
    const original = path.join(BACKUP, originalName);
    if (!fs.existsSync(original)) fs.writeFileSync(original, buf, { mode: 0o600 });
    const list = () => { try { return fs.readdirSync(BACKUP).filter((n) => n.startsWith(name + '-') && n.endsWith('.json')).sort(); } catch { return []; } };
    const entries = list();
    const latest = entries.length ? path.join(BACKUP, entries[entries.length - 1]) : '';
    let same = false;
    if (latest) { try { same = fs.readFileSync(latest).equals(buf); } catch {} }
    if (!same) fs.writeFileSync(path.join(BACKUP, `${name}-${stamp()}.json`), buf, { mode: 0o600 });
    const all = list();
    while (all.length > 20) { try { fs.unlinkSync(path.join(BACKUP, all.shift())); } catch {} }
    return original;
  } catch { return null; }
}
function ensureOriginal(file, originalName) {
  const original = path.join(BACKUP, originalName);
  if (fs.existsSync(original)) return;
  try { fs.mkdirSync(BACKUP, { recursive: true, mode: 0o700 }); fs.copyFileSync(file, original); fs.chmodSync(original, 0o600); } catch {}
}
// called before sync/read: settings.json, settings.local.json and the resolved local mirror all get an original copy
function backupSettings() {
  const files = [];
  for (const [f, name, original] of [
    [path.join(HOME, '.claude', 'settings.json'), 'claude-settings', 'claude-settings.original.json'],
    [path.join(HOME, '.claude', 'settings.local.json'), 'claude-settings-local', 'claude-settings-local.original.json'],
    [MIRROR, 'claude-apis.local', 'claude-apis.local.original.json'],
  ]) {
    const p = backupFile(f, name, original);
    if (p) files.push(p);
  }
  return { ok: true, files };
}

// ~/.claude/settings.json's API-relevant part (the control panel imports it; the server strips proxies and secrets stay server-side)
function readSettings() {
  backupSettings();                                  // before anyone reads/imports it
  const f = path.join(HOME, '.claude', 'settings.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, msg: '读不到 ~/.claude/settings.json' }; }
  return { ok: true, settings: pickSettings(j) };
}

// the persistent per-alias settings file (usable as `claude --settings ~/.ametyping/claude-apis/<id>.json`):
// same settings slice the server resolved, with the proxy mode applied
function proxySettings(settings, proxy) {
  const s = JSON.parse(JSON.stringify(settings && typeof settings === 'object' ? settings : {}));
  s.env = s.env && typeof s.env === 'object' ? s.env : {};
  for (const k of Object.keys(s.env)) if (/^AME_/.test(k) || /^CLAUDE_CONFIG_DIR$/i.test(k)) delete s.env[k];
  if (proxy === 'direct') {
    for (const k of PROXY_KEYS) s.env[k] = '';
    for (const k of NO_PROXY_KEYS) s.env[k] = '*';
  } else if (/^https?:\/\//.test(proxy || '')) {
    for (const k of PROXY_KEYS) s.env[k] = proxy;
    for (const k of NO_PROXY_KEYS) s.env[k] = 'localhost,127.0.0.1';
  }
  return s;
}

function writeAtomic(file, text, mode) {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.writeFileSync(file + '.tmp', text, { mode });
  fs.renameSync(file + '.tmp', file);
}
function isOurs(file) {
  try { return fs.readFileSync(file, 'utf8').includes(MARK); } catch { return false; }
}
function removeStale(valid) {
  let names = [];
  try { names = fs.readdirSync(BIN); } catch { return; }
  for (const n of names) {
    if (!/^claude-[A-Za-z0-9._-]+(\.cmd)?$/.test(n)) continue;
    const id = n.replace(/\.cmd$/, '').slice('claude-'.length);
    if (valid.has(id)) continue;
    const f = path.join(BIN, n);
    if (isOurs(f)) { try { fs.unlinkSync(f); } catch {} }
  }
}
const qps = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const qsh = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
function ps1(node) {
  return [
    '# ametyping-claude-api: generated by the AmeTyping agent',
    'param([string]$Alias, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)',
    '$pre = Join-Path $env:USERPROFILE \'.ametyping\\launch.ps1\'',
    'if (Test-Path $pre) { . $pre }',
    '$launcher = Join-Path $env:USERPROFILE \'.ametyping\\claude-api-launch.js\'',
    `& ${qps(node)} $launcher $Alias @Rest`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}
function wrapper(id, node) {
  if (WIN) return [
    '@echo off',
    `rem ${MARK}: generated by the AmeTyping agent`,
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\.ametyping\\claude-api.ps1" -Alias ${id} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  return [
    '#!/bin/sh',
    `# ${MARK}: generated by the AmeTyping agent`,
    '[ -f "$HOME/.ametyping/launch.sh" ] && . "$HOME/.ametyping/launch.sh"',
    `exec ${qsh(node)} "$HOME/.ametyping/claude-api-launch.js" ${id} "$@"`,
    '',
  ].join('\n');
}

// cfg: { machine, default, aliases: { <id>: { label, proxy, settings } } } -- what the server resolved for this machine
function sync(cfg) {
  if (!isObj(cfg) || !isObj(cfg.aliases)) return { ok: false, msg: '别名配置不对' };
  fs.mkdirSync(AME, { recursive: true, mode: 0o700 });
  backupSettings();                                  // the old settings and mirror, before this sync writes the mirror
  const aliases = {};
  for (const [id, a] of Object.entries(cfg.aliases)) {
    if (!ALIAS.test(id) || !isObj(a)) continue;
    const settings = isObj(a.settings) ? JSON.parse(JSON.stringify(a.settings)) : {};
    if (isObj(settings.env)) for (const k of Object.keys(settings.env)) if (/^CLAUDE_CONFIG_DIR$/i.test(k)) delete settings.env[k];
    aliases[id] = { label: typeof a.label === 'string' ? a.label.slice(0, 60) : id,
      proxy: typeof a.proxy === 'string' ? a.proxy : 'inherit',
      settings };
  }
  const mirror = { machine: typeof cfg.machine === 'string' ? cfg.machine : '', default: ALIAS.test(String(cfg.default || '')) ? cfg.default : '', aliases };
  writeAtomic(MIRROR, JSON.stringify(mirror, null, 1), 0o600);
  ensureOriginal(MIRROR, 'claude-apis.local.original.json');   // a brand-new mirror's first version
  // each alias as a persistent settings file on this machine (manual `claude --settings`, other tools)
  try {
    fs.mkdirSync(ALIAS_DIR, { recursive: true, mode: 0o700 });
    let old = [];
    try { old = JSON.parse(fs.readFileSync(INDEX, 'utf8')).ids || []; } catch {}
    for (const [id, a] of Object.entries(aliases)) {
      writeAtomic(path.join(ALIAS_DIR, `${id}.json`), JSON.stringify(proxySettings(a.settings, a.proxy), null, 1), 0o600);
    }
    for (const id of old) if (!aliases[id] && ALIAS.test(id)) { try { fs.unlinkSync(path.join(ALIAS_DIR, `${id}.json`)); } catch {} }
    writeAtomic(INDEX, JSON.stringify({ ids: Object.keys(aliases) }, null, 1), 0o600);
  } catch (e) { console.error('写每机器别名 settings 失败：' + e.message); }
  // the launcher the wrappers call (kept next to the mirror, so it survives a moved repository)
  try { writeAtomic(LAUNCHER, fs.readFileSync(path.join(__dirname, 'claude-api-launch.js'), 'utf8'), 0o600); } catch {}
  try {
    fs.mkdirSync(BIN, { recursive: true, mode: 0o700 });
    if (WIN) {
      const f = path.join(AME, 'claude-api.ps1');
      writeAtomic(f, ps1(process.execPath), 0o600);
      for (const id of Object.keys(aliases)) {
        const w = path.join(BIN, `claude-${id}.cmd`);
        if (fs.existsSync(w) && !isOurs(w)) continue;                 // never overwrite a file of yours
        writeAtomic(w, wrapper(id, process.execPath), 0o644);
      }
    } else {
      for (const id of Object.keys(aliases)) {
        const w = path.join(BIN, `claude-${id}`);
        if (fs.existsSync(w) && !isOurs(w)) continue;
        writeAtomic(w, wrapper(id, process.execPath), 0o755);
        try { fs.chmodSync(w, 0o755); } catch {}
      }
    }
    removeStale(new Set(Object.keys(aliases)));
  } catch (e) { return { ok: false, msg: '写终端别名失败：' + e.message }; }
  return { ok: true };
}

module.exports = { readSettings, sync, backupSettings, MIRROR, ALIAS_DIR, LAUNCHER, BACKUP };
