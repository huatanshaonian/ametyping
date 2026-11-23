// 一键配置 (server/fleet): this computer's coding agents pointed at the Magpie gateway with this computer's own gateway
// key -- what the server sends as "agent-config" { gateway, key?, models, targets } is written here:
//   claude    ~/.claude/settings.json      env ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (+ the opus/sonnet/haiku/fable
//                                          model names when given); ANTHROPIC_API_KEY taken out (it would win)
//   codex     $CODEX_HOME/config.toml       model_provider = "magpie" and a [model_providers.magpie] table
//   opencode  ~/.config/opencode            the key in .secrets/magpie-nas.key (what the template's apiKey reads), the
//                                          gateway in providers.magpie; a missing opencode.json gets the template
// Only these keys are changed; everything else in the files stays. Each file is copied to
// ~/.ametyping/config-backups first. The key itself is kept in ~/.ametyping/magpie-key.json (0600): the server keeps
// only its id, so a later "agent-config" without a key uses this one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch {} }
}
const tomlStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const HEADER = /^\s*\[\[?\s*([A-Za-z0-9_."' -]+?)\s*\]\]?\s*(#.*)?$/;

// config.toml with magpie as the provider: the top-level model_provider / model lines set (or added before the first
// table), any [model_providers.magpie...] table replaced by ours at the end. Comments and other tables stay as they are.
function codexToml(text, { gateway, key, model }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false, firstTable = -1;
  for (const l of lines) {
    const h = HEADER.exec(l);
    if (h) {
      const name = h[1].replace(/["' ]/g, '');
      skipping = name === 'model_providers.magpie' || name.startsWith('model_providers.magpie.');
      if (skipping) { while (out.length && /^\s*#\s*AmeTyping/.test(out[out.length - 1])) out.pop(); continue; }
      if (firstTable < 0) firstTable = out.length;
    }
    if (!skipping) out.push(l);
  }
  if (firstTable < 0) firstTable = out.length;
  const top = out.slice(0, firstTable), rest = out.slice(firstTable);
  const set = (k, v) => {
    const i = top.findIndex((l) => new RegExp('^\\s*' + k + '\\s*=').test(l));
    const line = `${k} = ${tomlStr(v)}`;
    if (i >= 0) top[i] = line; else { let j = top.length; while (j > 0 && !top[j - 1].trim()) j--; top.splice(j, 0, line); }
  };
  set('model_provider', 'magpie');
  if (model) set('model', model);
  const base = gateway.replace(/\/+$/, '');
  const table = ['# AmeTyping 一键配置：Magpie 网关（这台电脑自己的网关密钥）', '[model_providers.magpie]', 'name = "magpie"',
    `base_url = ${tomlStr(base + '/v1')}`, `model_catalog_url = ${tomlStr(base + '/v1/codex/models')}`,
    `experimental_bearer_token = ${tomlStr(key)}`, 'wire_api = "responses"', 'supports_websockets = false'];
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  const body = [...top, ...(top.length && top[top.length - 1].trim() ? [''] : []), ...rest, ...(rest.length ? [''] : []), ...table].join('\n');
  return body.replace(/^\n+/, '') + '\n';
}

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

  function claude({ gateway, secret, models = {} }) {
    const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
    let j = {};
    if (fs.existsSync(file)) {
      try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('settings.json 不是有效的 JSON，没有改动'); }
      if (!object(j)) throw new Error('settings.json 的格式不对，没有改动');
    }
    const e = object(j.env) ? { ...j.env } : {};
    e.ANTHROPIC_BASE_URL = gateway.replace(/\/+$/, '').replace(/\/v1$/, '');
    e.ANTHROPIC_AUTH_TOKEN = secret;
    delete e.ANTHROPIC_API_KEY;
    for (const [k, name] of [['opus', 'OPUS'], ['sonnet', 'SONNET'], ['haiku', 'HAIKU'], ['fable', 'FABLE']])
      if (typeof models[k] === 'string' && models[k]) e[`ANTHROPIC_DEFAULT_${name}_MODEL`] = models[k];
    const b = backup(file, 'claude-settings');
    atomic(file, JSON.stringify({ ...j, env: e }, null, 2) + '\n');
    return { file, backup: b };
  }
  function codex({ gateway, secret, models = {} }) {
    const dir = env.CODEX_HOME || path.join(home, '.codex'), file = path.join(dir, 'config.toml');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const b = backup(file, 'codex-config');
    atomic(file, codexToml(old, { gateway, key: secret, model: models.codex }));
    return { file, backup: b };
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
  const WRITERS = { claude, codex, opencode };

  // d: { gateway, key?: { id, name, secret }, models, targets: [...], template?: opencode.json for a computer without one } -> { ok, key: { id, name }, results: [...] }
  function apply(d) {
    let gateway;
    try { const u = new URL(String(d.gateway || '')); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw 0; gateway = u.href.replace(/\/+$/, ''); }
    catch { return { ok: false, msg: '网关地址不对' }; }
    let key = storedKey();
    if (d.key) {
      if (typeof d.key.secret !== 'string' || d.key.secret.length < 8 || d.key.secret.length > 400 || /[\s"'\\]/.test(d.key.secret)) return { ok: false, msg: '服务器发来的密钥格式不对' };
      key = { id: String(d.key.id || '').slice(0, 80), name: String(d.key.name || '').slice(0, 120), secret: d.key.secret, at: new Date().toISOString() };
      atomic(keyFile, JSON.stringify(key, null, 2));
    }
    if (!key) return { ok: false, msg: '这台电脑还没有 Magpie 密钥', needKey: true };
    const results = [];
    for (const t of Array.isArray(d.targets) ? d.targets : []) {
      if (!WRITERS[t]) { results.push({ target: t, ok: false, msg: '不支持' }); continue; }
      try { results.push({ target: t, ok: true, ...WRITERS[t]({ gateway, secret: key.secret, models: object(d.models) ? d.models : {}, template: object(d.template) ? d.template : null }) }); }
      catch (e) { results.push({ target: t, ok: false, msg: e.message }); }
    }
    return { ok: results.every((r) => r.ok), key: { id: key.id, name: key.name }, results };
  }

  return { apply, keyInfo };
}

module.exports = { createAgentConfig, codexToml };
