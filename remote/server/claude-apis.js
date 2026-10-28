// Claude Code API aliases (控制面板 → Claude Code API): one named API (base URL + key + proxy mode) that a
// machine starts Claude Code with. The alias is the same everywhere; a machine variant only overrides what that
// machine needs (a different key, direct instead of its proxy, ...). Entries are merged shared -> machine.
//
//   <dataDir>/claude-apis.json   { default, machines: { <machine>: { default } },
//                                  aliases: { <id>: { label, proxy, settings, machines: { <machine>: { proxy, settings } } } } }
//
// settings is a Claude Code settings slice -- in practice `env` (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
// model, proxy ...), optionally model / effortLevel. Hooks, permissions and the rest never go here: the machine's
// own ~/.claude/settings.json stays the base, and the alias is only layered on top at launch.
// Keys are never given back to the browser: view() replaces secret env values with UNCHANGED, set() puts the old
// value back wherever the placeholder comes back. A real new value in its place replaces it.
'use strict';
const fs = require('fs');
const path = require('path');

const ALIAS = /^[A-Za-z0-9._-]{1,40}$/;
const MACHINE = /^[^\x00-\x1f/\\]{1,80}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const CONFIG_DIR = /^CLAUDE_CONFIG_DIR$/i;           // memory directory: always the default ~/.claude
const SECRET = /TOKEN|KEY|SECRET|PASSWORD|AUTH|HEADER|CREDENTIAL|COOKIE/i;
// a value that is itself a credential, even under a harmless-looking name (custom headers, a proxy with a password, ...)
const SECRET_VALUE = /(?:^|\s)(?:bearer|basic)\s+\S+|sk-[A-Za-z0-9_-]{8,}|x-api-key\s*:|authorization\s*:|\/\/[^\s/@:]+:[^\s/@]+@|[?&](?:api[_-]?key|key|token|password)=/i;
const UNCHANGED = '__UNCHANGED__';
const PROXY = /^(direct|inherit|https?:\/\/\S{1,480})$/;
const SETTINGS_KEYS = new Set(['env', 'model', 'effortLevel', 'modelSettings', 'alwaysThinkingEnabled', 'language']);
const MAX_FILE = 256 * 1024;
const MAX_ALIASES = 50;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function cleanEnv(env) {
  if (!isObj(env)) return {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k) || /^AME_/.test(k) || CONFIG_DIR.test(k) || typeof v !== 'string' || v.length > 4000 || /[\r\n]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}
function cleanModelSettings(m) {
  if (!isObj(m)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(m).slice(0, 50)) {
    if (!/^[\w.:-]{1,60}$/.test(k) || !isObj(v) || typeof v.effortLevel !== 'string' || v.effortLevel.length > 20) continue;
    out[k] = { effortLevel: v.effortLevel };
  }
  return Object.keys(out).length ? out : undefined;
}
// the only part of a settings JSON an alias may carry
function cleanSettings(s) {
  if (!isObj(s)) return {};
  const out = {};
  if (isObj(s.env)) out.env = cleanEnv(s.env);
  if (typeof s.model === 'string' && s.model.length <= 80) out.model = s.model;
  if (typeof s.effortLevel === 'string' && s.effortLevel.length <= 20) out.effortLevel = s.effortLevel;
  const ms = cleanModelSettings(s.modelSettings); if (ms) out.modelSettings = ms;
  if (typeof s.alwaysThinkingEnabled === 'boolean') out.alwaysThinkingEnabled = s.alwaysThinkingEnabled;
  if (typeof s.language === 'string' && s.language.length <= 20) out.language = s.language;
  return out;
}
function mergeSettings(a, b) {
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(isObj(b) ? b : {})) {
    if (k === 'env') out.env = { ...(isObj(out.env) ? out.env : {}), ...(isObj(v) ? v : {}) };
    else if (k === 'modelSettings') out.modelSettings = { ...(isObj(out.modelSettings) ? out.modelSettings : {}), ...(isObj(v) ? v : {}) };
    else out[k] = v;
  }
  return out;
}
const maskEnv = (settings) => {
  if (!isObj(settings) || !isObj(settings.env)) return settings;
  const out = clone(settings);
  for (const k of Object.keys(out.env)) {
    const v = out.env[k];
    if (typeof v !== 'string' || !v) continue;
    if (SECRET.test(k) || SECRET_VALUE.test(v)) out.env[k] = UNCHANGED;
  }
  return out;
};
// an explicit proxy URL with a password (or a token in it) is a credential too
const maskProxy = (v) => {
  if (typeof v !== 'string' || !/^https?:\/\//.test(v)) return v;
  if (SECRET_VALUE.test(v)) return UNCHANGED;
  try { const u = new URL(v); if (u.username || u.password) return UNCHANGED; } catch {}
  return v;
};
// a submitted settings object with UNCHANGED put back to the old value; for a key the old object did not have,
// the placeholder is dropped (so the machine keeps inheriting the shared value instead of freezing it here)
function unmaskSettings(sub, old) {
  const clean = cleanSettings(sub);
  if (!isObj(clean.env)) return clean;
  const env = { ...clean.env };
  for (const k of Object.keys(env)) {
    if (env[k] !== UNCHANGED) continue;
    // the variant did not own this key: leave it out, so it keeps inheriting the shared value
    if (isObj(old) && isObj(old.env) && own(old.env, k)) env[k] = old.env[k];
    else delete env[k];
  }
  return { ...clean, env };
}
function cleanProxy(v, fallback = 'inherit') {
  return typeof v === 'string' && PROXY.test(v) ? v : fallback;
}
// a settings for one machine: shared first, then that machine's variant
function resolveOne(a, machine) {
  const m = a && isObj(a.machines) && isObj(a.machines[machine]) ? a.machines[machine] : {};
  const settings = mergeSettings(a && a.settings, m.settings);
  if (isObj(settings.env)) for (const k of Object.keys(settings.env)) if (CONFIG_DIR.test(k)) delete settings.env[k];
  return { label: str(a && a.label, 60), proxy: cleanProxy(m.proxy || (a && a.proxy), 'inherit'), settings };
}

function createClaudeApis({ dataDir, audit = () => {}, onChange = () => {} }) {
  const file = path.join(dataDir, 'claude-apis.json');
  const backupDir = path.join(dataDir, 'backups', 'claude-apis');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let st = { default: '', machines: {}, aliases: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObj(j)) st = { default: str(j.default, 40), machines: isObj(j.machines) ? j.machines : {}, aliases: isObj(j.aliases) ? j.aliases : {} };
  } catch {}
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  function listBackups(name) {
    try { return fs.readdirSync(backupDir).filter((n) => n.startsWith(name + '-') && n.endsWith('.json')).sort(); } catch { return []; }
  }
  // keep an untouched first copy forever, and the last 20 versions of the file before each save
  function backupFile(name, originalName) {
    let buf; try { buf = fs.readFileSync(file); } catch { return null; }
    try {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const original = path.join(backupDir, originalName);
      if (!fs.existsSync(original)) fs.writeFileSync(original, buf, { mode: 0o600 });
      const entries = listBackups(name);
      const latest = entries.length ? path.join(backupDir, entries[entries.length - 1]) : '';
      let same = false;
      if (latest) { try { same = fs.readFileSync(latest).equals(buf); } catch {} }
      if (!same) fs.writeFileSync(path.join(backupDir, `${name}-${stamp()}.json`), buf, { mode: 0o600 });
      const all = listBackups(name);
      while (all.length > 20) { try { fs.unlinkSync(path.join(backupDir, all.shift())); } catch {} }
      return original;
    } catch { return null; }
  }
  function ensureOriginal(name, originalName) {
    const original = path.join(backupDir, originalName);
    if (fs.existsSync(original)) return;
    try { fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); fs.copyFileSync(file, original); fs.chmodSync(original, 0o600); } catch {}
  }
  const save = () => {
    backupFile('claude-apis', 'claude-apis.original.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    ensureOriginal('claude-apis', 'claude-apis.original.json');    // a brand-new file's first version is its original
  };
  const ids = () => Object.keys(st.aliases).filter((x) => ALIAS.test(x));

  // what the control panel may see: secrets replaced, nothing else
  function view() {
    const aliases = {};
    for (const id of ids()) {
      const a = st.aliases[id];
      aliases[id] = { label: str(a.label, 60) || id, proxy: maskProxy(cleanProxy(a.proxy)), settings: maskEnv(cleanSettings(a.settings)), machines: {} };
      if (isObj(a.machines)) for (const [m, v] of Object.entries(a.machines)) {
        if (!MACHINE.test(m) || !isObj(v)) continue;
        const mv = { settings: maskEnv(cleanSettings(v.settings)) };
        if (v.proxy != null) mv.proxy = maskProxy(cleanProxy(v.proxy, a.proxy || 'inherit'));
        aliases[id].machines[m] = mv;
      }
    }
    const machines = {};
    for (const [m, v] of Object.entries(st.machines || {})) if (MACHINE.test(m) && isObj(v) && ALIAS.test(str(v.default, 40))) machines[m] = { default: v.default };
    return { default: ids().includes(st.default) ? st.default : '', machines, aliases, backupDir };
  }

  // all aliases as this machine will run them (tokens included: it goes to that machine only)
  function forMachine(machine) {
    const aliases = {};
    for (const id of ids()) {
      const r = resolveOne(st.aliases[id], machine);
      if (isObj(r.settings) && Object.keys(r.settings).length) aliases[id] = { label: r.label || id, proxy: r.proxy, settings: r.settings };
    }
    return { machine, default: defaultFor(machine) || '', aliases };
  }
  // the launch selector needs names only; an alias with nothing to run on this machine is not offered
  function publicFor(machine) {
    const aliases = [];
    for (const id of ids()) {
      const r = resolveOne(st.aliases[id], machine);
      if (!isObj(r.settings) || !Object.keys(r.settings).length) continue;
      aliases.push({ id, label: str(st.aliases[id].label, 60) || id });
    }
    const def = defaultFor(machine);
    return { default: def && aliases.some((a) => a.id === def) ? def : '', aliases };
  }
  function defaultFor(machine) {
    const m = isObj(st.machines) && isObj(st.machines[machine]) ? st.machines[machine].default : '';
    if (ALIAS.test(str(m, 40)) && st.aliases[m]) return m;
    if (ALIAS.test(str(st.default, 40)) && st.aliases[st.default]) return st.default;
    return ids()[0] || '';
  }
  function resolve(id, machine) {
    if (!ALIAS.test(String(id || '')) || !st.aliases[id]) return null;
    const r = resolveOne(st.aliases[id], machine);
    return { id, label: r.label || id, proxy: r.proxy, settings: r.settings };
  }

  // the whole config back from the control panel (secrets are UNCHANGED unless replaced)
  function set(d) {
    if (!isObj(d) || !isObj(d.aliases)) return { ok: false, msg: '配置格式不对' };
    const next = { default: '', machines: {}, aliases: {} };
    const aliasIds = Object.keys(d.aliases);
    if (aliasIds.length > MAX_ALIASES) return { ok: false, msg: '别名太多了' };
    for (const id of aliasIds) {
      if (!ALIAS.test(id)) return { ok: false, msg: `别名只能用字母、数字、点、下划线、横线：${id.slice(0, 40)}` };
      const a = d.aliases[id];
      if (!isObj(a)) return { ok: false, msg: `别名 ${id} 的配置不对` };
      const old = isObj(st.aliases[id]) ? st.aliases[id] : {};
      const shared = unmaskSettings(a.settings, old.settings);
      const proxy = a.proxy === UNCHANGED ? cleanProxy(old.proxy) : cleanProxy(a.proxy);
      const item = { label: str(a.label, 60) || id, proxy, settings: shared, machines: {} };
      if (isObj(a.machines)) {
        for (const [m, v] of Object.entries(a.machines)) {
          if (!MACHINE.test(m) || !isObj(v)) return { ok: false, msg: `机器名不对：${String(m).slice(0, 80)}` };
          const om = isObj(old.machines) && isObj(old.machines[m]) ? old.machines[m] : {};
          const mv = { settings: unmaskSettings(v.settings, om.settings) };
          if (v.proxy != null) mv.proxy = v.proxy === UNCHANGED ? cleanProxy(om.proxy || item.proxy) : cleanProxy(v.proxy, item.proxy);
          item.machines[m] = mv;
        }
      }
      next.aliases[id] = item;
    }
    if (d.default && ALIAS.test(String(d.default)) && next.aliases[d.default]) next.default = d.default;
    if (isObj(d.machines)) for (const [m, v] of Object.entries(d.machines)) {
      if (!MACHINE.test(m) || !isObj(v)) continue;
      const def = str(v.default, 40);
      if (ALIAS.test(def) && next.aliases[def]) next.machines[m] = { default: def };
    }
    if (JSON.stringify(next).length > MAX_FILE) return { ok: false, msg: '配置太大了' };
    st = next;
    save();
    audit('claude-apis-save', ids().join(',').slice(0, 300));
    onChange();
    return { ok: true, view: view() };
  }

  // what a machine's ~/.claude/settings.json contributes to a new alias: only the API-relevant part
  function importSettings({ machine, alias, label, proxy = 'inherit', scope = 'machine', settings }) {
    if (!MACHINE.test(String(machine || ''))) return { ok: false, msg: '机器名不对' };
    if (!ALIAS.test(String(alias || ''))) return { ok: false, msg: '别名只能用字母、数字、点、下划线、横线' };
    if (!PROXY.test(proxy)) return { ok: false, msg: '代理方式不对' };
    const clean = cleanSettings(settings);
    if (isObj(clean.env)) for (const k of Object.keys(clean.env)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete clean.env[k];
    const old = isObj(st.aliases[alias]) ? st.aliases[alias] : { label: alias, proxy: 'inherit', settings: {}, machines: {} };
    const item = { label: str(label, 60) || old.label || alias, proxy: scope === 'shared' ? proxy : (old.proxy || 'inherit'),
      settings: old.settings || {}, machines: isObj(old.machines) ? old.machines : {} };
    if (scope === 'shared') item.settings = mergeSettings(item.settings, clean);
    else item.machines = { ...item.machines, [machine]: { proxy, settings: mergeSettings((isObj(item.machines[machine]) && item.machines[machine].settings) || {}, clean) } };
    st.aliases[alias] = item;
    if (!isObj(st.machines)) st.machines = {};
    if (!isObj(st.machines[machine])) st.machines[machine] = {};
    if (!st.machines[machine].default) st.machines[machine].default = alias;
    save();
    audit('claude-apis-import', machine, alias, scope);
    onChange();
    return { ok: true, view: view() };
  }

  // a small JSON for the launch selector (no settings, no keys)
  function launchList(machine) { return publicFor(machine); }

  return { file, view, forMachine, publicFor, launchList, defaultFor, resolve, set, importSettings, ids };
}

module.exports = { createClaudeApis, ALIAS, MACHINE, UNCHANGED, SECRET, SECRET_VALUE, cleanSettings, mergeSettings, resolveOne };
