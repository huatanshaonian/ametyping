// 一键配置 (server/fleet): this computer's coding agents set up for the NAS's Magpie gateway -- what the server sends as
// "agent-config" { gateway, key?, models, targets, proxy, template } is written here:
//   claude    ~/.claude/settings.json      env ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (+ the opus/sonnet/haiku/fable
//                                          model names when given); ANTHROPIC_API_KEY taken out (it would win). No proxy:
//                                          the gateway is on the LAN / Tailscale -- when the file has proxy variables of
//                                          its own, the gateway's host is added to NO_PROXY so it is reached directly
//   opencode  ~/.config/opencode            the key in .secrets/magpie-nas.key (what the template's apiKey reads), the
//                                          gateway in providers.magpie; a missing opencode.json gets the template
//   codex     ~/.ametyping/harness-net.json Codex keeps its own ChatGPT sign-in and goes abroad through this computer's
//                                          proxy: the proxy is recorded for it (harness.js), its config.toml untouched
// Only these keys are changed; everything else in the files stays. Each file is copied to
// ~/.ametyping/config-backups first. The key itself is kept in ~/.ametyping/magpie-key.json (0600): the server keeps
// only its id, so a later "agent-config" without a key uses this one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readNet, writeNet, PROXY_URL } = require('./harness');

const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch {} }
}
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
// NO_PROXY with host in it (a comma list; '*' already covers it)
function withBypass(list, host) {
  const items = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (items.includes('*') || items.some((s) => s.toLowerCase() === host.toLowerCase())) return items.join(',');
  return [...(items.length ? items : ['localhost', '127.0.0.1']), host].join(',');
}
// the targets that use the Magpie key
const KEYED = ['claude', 'opencode'];

function createAgentConfig({ home = os.homedir(), env = process.env } = {}) {
  const keyFile = path.join(home, '.ametyping', 'magpie-key.json');
  const backups = path.join(home, '.ametyping', 'config-backups');
  function backup(file, tag) {
    if (!fs.existsSync(file)) return '';
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    const b = path.join(backups, `${tag}-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(2).toString('hex')}${path.extname(file)}`);
    fs.copyFileSync(file, b); try { fs.chmodSync(b, 0o600); } catch {}
    return b;
  }
  const storedKey = () => { try { const k = JSON.parse(fs.readFileSync(keyFile, 'utf8')); return k && typeof k.secret === 'string' ? k : null; } catch { return null; } };
  // what the server may know: the id and name, never the secret
  const keyInfo = () => { const k = storedKey(); return k ? { id: k.id || '', name: k.name || '' } : null; };
  const net = () => readNet(home);

  function claude({ gateway, secret, models = {} }) {
    const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
    let j = {};
    if (fs.existsSync(file)) {
      try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('settings.json 不是有效的 JSON，没有改动'); }
      if (!object(j)) throw new Error('settings.json 的格式不对，没有改动');
    }
    const e = object(j.env) ? { ...j.env } : {};
    const base = gateway.replace(/\/+$/, '').replace(/\/v1$/, '');
    e.ANTHROPIC_BASE_URL = base;
    e.ANTHROPIC_AUTH_TOKEN = secret;
    delete e.ANTHROPIC_API_KEY;
    for (const [k, name] of [['opus', 'OPUS'], ['sonnet', 'SONNET'], ['haiku', 'HAIKU'], ['fable', 'FABLE']])
      if (typeof models[k] === 'string' && models[k]) e[`ANTHROPIC_DEFAULT_${name}_MODEL`] = models[k];
    let msg = '';
    if (PROXY_VARS.some((k) => e[k])) {
      const host = new URL(base).hostname;
      for (const k of ['NO_PROXY', 'no_proxy']) if (k === 'NO_PROXY' || e[k] !== undefined) e[k] = withBypass(e[k] || e.NO_PROXY, host);
      msg = `这里配了代理，网关 ${host} 已加进 NO_PROXY，直连`;
    }
    const b = backup(file, 'claude-settings');
    atomic(file, JSON.stringify({ ...j, env: e }, null, 2) + '\n');
    return { file, backup: b, msg };
  }
  function opencode({ gateway, secret, template }) {
    const dir = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
    const keyPath = path.join(dir, '.secrets', 'magpie-nas.key');
    atomic(keyPath, secret + '\n');
    const ref = '{file:' + keyPath.replace(/\\/g, '/') + '}';
    const base = gateway.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
    if (fs.existsSync(path.join(dir, 'opencode.jsonc')) && !fs.existsSync(path.join(dir, 'opencode.json')))
      return { file: keyPath, msg: '只写了密钥文件：这台电脑用的是 opencode.jsonc（带注释），请把其中 magpie 的 apiKey 改成 ' + ref };
    const file = path.join(dir, 'opencode.json');
    let j;
    if (fs.existsSync(file)) {
      try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('opencode.json 不是有效的 JSON，只写了密钥文件'); }
    } else if (object(template)) j = JSON.parse(JSON.stringify(template));
    else return { file: keyPath, msg: '只写了密钥文件：这台电脑还没有 opencode.json（到控制面板的 OpenCode 配置指南生成一份）' };
    const providers = object(j.providers) ? j.providers : (j.providers = {});
    const tpl = object(template) && object(template.providers) && template.providers.magpie;
    const mag = object(providers.magpie) ? providers.magpie : (providers.magpie = tpl ? JSON.parse(JSON.stringify(tpl)) : { name: 'Magpie', package: '@opencode/ai/providers/openai-compatible', models: {} });
    mag.settings = { ...(object(mag.settings) ? mag.settings : {}), baseURL: base, apiKey: ref };
    const b = backup(file, 'opencode');
    atomic(file, JSON.stringify(j, null, 2) + '\n');
    return { file, backup: b };
  }
  // Codex: its own sign-in, this computer's proxy (config.toml is not touched)
  // (proxy: set for this computer; else the one the agent found works here; else the panel's default)
  function codex({ proxy, fallback }) {
    const n = net(), via = proxy || n.detected || fallback;
    if (!via) throw new Error('这台电脑没有可用的代理（没设置，自动检测也没找到），Codex 没有改动');
    writeNet({ tools: [...new Set([...n.tools, 'codex'])], ...(proxy || (!n.detected && fallback) ? { proxy: proxy || fallback } : {}) }, home);
    return { file: path.join(home, '.ametyping', 'harness-net.json'),
      msg: `看板启动的 Codex 会话和安装、更新走 ${via}${proxy ? '' : n.detected && via === n.detected ? '（自动检测到的）' : '（默认代理）'}；自己在终端里开的 Codex 用终端的代理设置` };
  }
  const WRITERS = { claude, opencode, codex };

  // d: { gateway, key?: { id, name, secret }, models, targets: [...], proxy?, template?: opencode.json for a computer
  // without one } -> { ok, key: { id, name }, results: [...] }
  function apply(d) {
    const targets = (Array.isArray(d.targets) ? d.targets : []).map(String);
    let gateway = '';
    if (targets.some((t) => KEYED.includes(t))) {
      try { const u = new URL(String(d.gateway || '')); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw 0; gateway = u.href.replace(/\/+$/, ''); }
      catch { return { ok: false, msg: '网关地址不对' }; }
    }
    const proxy = typeof d.proxy === 'string' ? d.proxy.trim() : '';
    const fallback = typeof d.fallback === 'string' && PROXY_URL.test(d.fallback.trim()) ? d.fallback.trim() : '';
    if (proxy && !PROXY_URL.test(proxy)) return { ok: false, msg: '代理地址格式不对' };
    // the proxy is this computer's: kept for installs and updates even when Codex is not among the targets
    if (proxy && proxy !== net().proxy) writeNet({ ...net(), proxy }, home);
    let key = storedKey();
    if (d.key) {
      if (typeof d.key.secret !== 'string' || d.key.secret.length < 8 || d.key.secret.length > 400 || /[\s"'\\]/.test(d.key.secret)) return { ok: false, msg: '服务器发来的密钥格式不对' };
      key = { id: String(d.key.id || '').slice(0, 80), name: String(d.key.name || '').slice(0, 120), secret: d.key.secret, at: new Date().toISOString() };
      atomic(keyFile, JSON.stringify(key, null, 2));
    }
    if (!key && targets.some((t) => KEYED.includes(t))) return { ok: false, msg: '这台电脑还没有 Magpie 密钥', needKey: true };
    const results = [];
    for (const t of targets) {
      if (!WRITERS[t]) { results.push({ target: t, ok: false, msg: '不支持' }); continue; }
      try {
        results.push({ target: t, ok: true, ...WRITERS[t]({ gateway, secret: key && key.secret, proxy: proxy || net().proxy, fallback,
          models: object(d.models) ? d.models : {}, template: object(d.template) ? d.template : null }) });
      } catch (e) { results.push({ target: t, ok: false, msg: e.message }); }
    }
    return { ok: results.every((r) => r.ok), key: key ? { id: key.id, name: key.name } : null, results };
  }

  return { apply, keyInfo, net };
}

module.exports = { createAgentConfig, withBypass, KEYED };
