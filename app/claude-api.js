// The Claude Code API alias a launch runs with (remote/server/claude-apis.js is the source of truth; the agent
// keeps this machine's resolved copy in ~/.ametyping/claude-apis.local.json).
//   settingsFile(api)   the alias's settings slice -> a private temp JSON for `claude --settings`
//   envForProxy(api, env)  the child's environment: AME_CLAUDE_API (the hook tells the session which alias it is),
//                          and for `direct` the proxy variables are removed (DeepSeek is reached directly)
//   mirrorAlias(id)     the copy on this machine, for a resume of a session launched earlier
// The key never goes on a command line: it lives in the 0600 temp settings file only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALIAS = /^[A-Za-z0-9._-]{1,40}$/;
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'];
const PROXY = /^(direct|inherit|https?:\/\/\S{1,480})$/;
const CONFIG_DIR = /^CLAUDE_CONFIG_DIR$/i;                // all aliases share the default ~/.claude memory
const BASE_KEYS = ['env', 'model', 'effortLevel', 'modelSettings', 'alwaysThinkingEnabled', 'language'];
const clone = (v) => JSON.parse(JSON.stringify(v));
// the machine's own ~/.claude/settings.json is the base (proxy, model, ...); the alias only overrides what it names.
// Hooks and permissions stay where they are -- they load from the user settings as usual, not twice.
function baseSettings() {
  try {
    // AME_CLAUDE_SETTINGS: tests (and an unusual setup) can name the base file
    const f = process.env.AME_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out = {};
    for (const k of BASE_KEYS) if (j[k] != null) out[k] = j[k];
    return out;
  } catch { return {}; }
}
function mergeSettings(base, over) {
  const out = clone(base && typeof base === 'object' ? base : {});
  for (const [k, v] of Object.entries(over && typeof over === 'object' ? over : {})) {
    if (k === 'env') out.env = { ...(out.env && typeof out.env === 'object' ? out.env : {}), ...(v && typeof v === 'object' ? v : {}) };
    else if (k === 'modelSettings') out.modelSettings = { ...(out.modelSettings && typeof out.modelSettings === 'object' ? out.modelSettings : {}), ...(v && typeof v === 'object' ? v : {}) };
    else out[k] = v;
  }
  return out;
}
function valid(api) {
  return api && typeof api === 'object' && ALIAS.test(String(api.id || '')) && api.settings && typeof api.settings === 'object' && !Array.isArray(api.settings) ? api : null;
}
function mirror() {
  try {
    const f = process.env.AME_CLAUDE_MIRROR || path.join(os.homedir(), '.ametyping', 'claude-apis.local.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && j.aliases && typeof j.aliases === 'object' ? j : { aliases: {} };
  } catch { return { aliases: {} }; }
}
function mirrorAlias(id) {
  if (!ALIAS.test(String(id || ''))) return null;
  const a = mirror().aliases[id];
  return a ? valid({ id, label: a.label || id, proxy: PROXY.test(a.proxy || '') ? a.proxy : 'inherit', settings: a.settings || {} }) : null;
}
function applyProxy(settings, proxy) {
  const s = clone(settings);
  s.env = s.env && typeof s.env === 'object' ? s.env : {};
  for (const k of Object.keys(s.env)) if (/^AME_/.test(k) || CONFIG_DIR.test(k)) delete s.env[k];   // marker / memory dir stay ours
  if (proxy === 'direct') {
    for (const k of PROXY_KEYS) s.env[k] = '';
    for (const k of NO_PROXY_KEYS) s.env[k] = '*';
  } else if (proxy !== 'inherit' && /^https?:\/\//.test(proxy)) {
    for (const k of PROXY_KEYS) s.env[k] = proxy;
    // an inherited NO_PROXY=* (a previous direct launch) must not bypass the explicit proxy
    for (const k of NO_PROXY_KEYS) s.env[k] = 'localhost,127.0.0.1';
  }
  return s;
}
// a temp settings file (0600) for this launch; old ones are cleaned up when they are a day old
function settingsFile(api) {
  const a = valid(api);
  if (!a) return null;
  const dir = process.env.AME_CLAUDE_TMP || path.join(os.homedir(), '.ametyping', 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) {
      if (!/^claude-api-.*\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 86400e3) fs.unlinkSync(p); } catch {}
    }
    const file = path.join(dir, `claude-api-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
    const merged = mergeSettings(baseSettings(), a.settings);
    fs.writeFileSync(file, JSON.stringify(applyProxy(merged, a.proxy || 'inherit'), null, 1), { mode: 0o600 });
    return { file, cleanup: () => { try { fs.unlinkSync(file); } catch {} } };
  } catch { return null; }
}
// the child environment for a launch we start ourselves (background resume). The new-window launch uses
// powershellSnippet() instead, because the console bridge cannot set an environment per window.
// A background resume must either use the session's alias or stop: a missing mirror / failed temp write never falls
// back to an unmarked Claude (which would silently use the machine's base API while the session still says the alias).
function resumePlan(apiId, env = process.env) {
  const wanted = typeof apiId === 'string' ? apiId : '';
  const api = wanted ? mirrorAlias(wanted) : null;
  if (wanted && !api) return { ok: false, msg: `这个会话原来的 API 别名「${wanted}」在本机不可用（镜像读不到）；为避免切换 API，先不续聊。恢复别名后再试。` };
  const sf = api ? settingsFile(api) : null;
  if (api && !sf) return { ok: false, msg: '写 API 设置失败；为避免切换 API，先不续聊。' };
  return { ok: true, api, sf, env: envForProxy(api, env) };
}

function envForProxy(api, env = process.env) {
  const out = { ...env, AME_CLAUDE_API: api && ALIAS.test(String(api.id || '')) ? api.id : '' };
  delete out.CLAUDE_CONFIG_DIR;                           // alt launches keep the default memory directory
  if (!api) return out;
  const proxy = PROXY.test(api.proxy || '') ? api.proxy : 'inherit';
  if (proxy === 'direct') {
    for (const k of PROXY_KEYS) delete out[k];
    for (const k of NO_PROXY_KEYS) out[k] = '*';
  } else if (proxy !== 'inherit' && /^https?:\/\//.test(proxy)) {
    for (const k of PROXY_KEYS) out[k] = proxy;
    for (const k of NO_PROXY_KEYS) out[k] = 'localhost,127.0.0.1';
  }
  // the alias's API env is authoritative over whatever the parent process had
  const extra = api.settings && api.settings.env && typeof api.settings.env === 'object' ? api.settings.env : {};
  for (const [k, v] of Object.entries(extra)) {
    if (PROXY_KEYS.includes(k) || NO_PROXY_KEYS.includes(k) || CONFIG_DIR.test(k)) continue;
    out[k] = String(v);
  }
  out.AME_CLAUDE_API = api.id;
  return out;
}
// the PowerShell prefix for a new console window: the alias marker, and (direct) the proxy taken out of the
// environment launch.ps1 may have set. No key is ever in this string.
function powershellSnippet(api) {
  if (!valid(api)) return '';
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  let s = `$env:AME_CLAUDE_API=${q(api.id)}; Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; `;
  const proxy = PROXY.test(api.proxy || '') ? api.proxy : 'inherit';
  if (proxy === 'direct') s += `Remove-Item Env:${PROXY_KEYS.join(',Env:')},Env:${NO_PROXY_KEYS.join(',Env:')} -ErrorAction SilentlyContinue; `;
  else if (proxy !== 'inherit' && /^https?:\/\//.test(proxy)) {
    s += PROXY_KEYS.map((k) => `$env:${k}=${q(proxy)}; `).join('');
    s += NO_PROXY_KEYS.map((k) => `$env:${k}=${q('localhost,127.0.0.1')}; `).join('');
  }
  return s;
}

module.exports = { valid, mirror, mirrorAlias, settingsFile, resumePlan, envForProxy, powershellSnippet, baseSettings, mergeSettings, ALIAS, PROXY };
