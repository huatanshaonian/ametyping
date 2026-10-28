// Claude Code API (控制面板): the named APIs a machine launches Claude Code with. One alias is the same everywhere;
// a machine variant overrides what that machine needs (another key, direct instead of its proxy). The server keeps
// the keys and never sends them here: they show as __UNCHANGED__ in the JSON. Replacing the placeholder with a new
// value changes the key; leaving it alone keeps the old one. A new machine only needs its own JSON imported from its
// ~/.claude/settings.json -- no SSH, no per-machine code.
import { h } from '../util.js';
import * as net from '../net.js';

const UNCHANGED = '__UNCHANGED__';
const SECRET = /TOKEN|KEY|SECRET|PASSWORD|AUTH|HEADER|CREDENTIAL|COOKIE/i;
const PROXY_LABEL = { direct: '直连', inherit: '沿用本机代理' };
const aliasOk = (id) => /^[A-Za-z0-9._-]{1,40}$/.test(String(id || ''));

const emptyAlias = (id) => ({ label: id, proxy: 'direct', settings: { env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' } }, machines: {} });
const settingsText = (a) => JSON.stringify(a && a.settings ? a.settings : {}, null, 2);
const proxyText = (p) => (p === '__UNCHANGED__' ? '（已隐藏）' : (PROXY_LABEL[p] || (/^https?:\/\//.test(p || '') ? p : '沿用本机代理')));

export function panel() {
  const root = h('div', { class: 'aim' });
  const msg = h('p', { class: 'gnote' });
  const aliasesEl = h('div', { class: 'capi-list' });
  const defaultsEl = h('div', { class: 'capi-defaults' });
  const importMachine = h('select', { class: 'field' });
  const importAlias = h('input', { class: 'field', type: 'text', placeholder: '别名，如 deepseek', spellcheck: 'false' });
  const importLabel = h('input', { class: 'field', type: 'text', placeholder: '显示名（可不填）' });
  const importProxy = h('select', { class: 'field' }, h('option', { value: 'direct', text: '直连' }), h('option', { value: 'inherit', text: '沿用本机代理' }));
  const importScope = h('select', { class: 'field' }, h('option', { value: 'machine', text: '只给这台机器' }), h('option', { value: 'shared', text: '所有机器共用' }));
  const importBtn = h('button', { class: 'btn go', type: 'button', text: '从本机 settings.json 导入' });
  const backupBtn = h('button', { class: 'btn', type: 'button', text: '先备份本机 json' });
  const backupHint = h('p', { class: 'ghint' });
  const raw = h('textarea', { class: 'field capi-raw', spellcheck: 'false' });
  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存全部' });
  const reloadBtn = h('button', { class: 'btn', type: 'button', text: '重新读取' });
  const addBtn = h('button', { class: 'btn', type: 'button', text: '新增别名模板' });
  let view = null;
  const known = () => (view && Array.isArray(view.known) ? view.known : []);
  const aliasIds = () => Object.keys((view && view.aliases) || {});

  function note(text, bad) { msg.textContent = text; msg.className = 'gnote' + (bad ? ' bad' : ''); }
  function payload() {
    try { return JSON.parse(raw.value); } catch (e) { note('JSON 语法错误：' + e.message, true); return null; }
  }
  // the editor text after a change made by a button (keep whatever is in the textarea first)
  function setConfig(c) { raw.value = JSON.stringify(c, null, 2); draw(c); }

  function draw(c) {
    const aliases = c && c.aliases && typeof c.aliases === 'object' ? c.aliases : {};
    const rows = Object.keys(aliases).map((id) => {
      const a = aliases[id] || {};
      const env = (a.settings && a.settings.env) || {};
      const hasKeyInEnv = (e) => Object.entries(e || {}).some(([k, v]) => (SECRET.test(k) || v === '__UNCHANGED__') && v);
      const token = hasKeyInEnv(env) || Object.values(a.machines && typeof a.machines === 'object' ? a.machines : {})
        .some((v) => hasKeyInEnv(v && v.settings && v.settings.env));
      const url = env.ANTHROPIC_BASE_URL === '__UNCHANGED__' ? '（地址已隐藏）' : (env.ANTHROPIC_BASE_URL || '');
      const variants = a.machines && typeof a.machines === 'object' ? Object.keys(a.machines) : [];
      return h('div', { class: 'capi-row' },
        h('div', {}, h('b', { text: 'claude-' + id }), h('small', { text: ' ' + (a.label || id) + (variants.length ? ` · 变体：${variants.join('、')}` : '') })),
        h('div', { class: 'capi-kv' }, h('span', { text: url || '（没填 base URL）' }), h('small', { text: '代理：' + proxyText(a.proxy) })),
        h('div', { class: 'capi-token' + (token ? '' : ' bad'), text: token ? '密钥已设置' : '密钥未设置' }));
    });
    aliasesEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ghint', text: '还没有别名。用下面的导入，或在 JSON 里新增一个。' })]));

    const defs = h('div', {});
    const machines = [...new Set([...known().map((m) => m.name), ...Object.keys(c.machines || {})])].sort();
    for (const m of machines) {
      const cur = (c.machines && c.machines[m] && c.machines[m].default) || '';
      const sel = h('select', { class: 'field' }, h('option', { value: '', text: '（跟随全局 / 第一个）' }),
        ...Object.keys(aliases).map((id) => h('option', { value: id, text: 'claude-' + id })));
      sel.value = cur;
      sel.addEventListener('change', () => {
        const p = payload(); if (!p) return;
        p.machines = p.machines && typeof p.machines === 'object' ? p.machines : {};
        p.machines[m] = p.machines[m] && typeof p.machines[m] === 'object' ? p.machines[m] : {};
        if (sel.value) p.machines[m].default = sel.value; else delete p.machines[m].default;
        setConfig(p);
      });
      const online = known().find((x) => x.name === m);
      defs.append(h('div', { class: 'capi-def' }, h('b', { text: m }), h('small', { text: online && online.online ? '在线' : '离线' }), sel));
    }
    defaultsEl.replaceChildren(...(machines.length ? [defs] : [h('p', { class: 'ghint', text: '还没有机器连上来。' })]));

    const ms = known().filter((m) => m.name !== 'nas');
    importMachine.replaceChildren(...(ms.length ? ms.map((m) => h('option', { value: m.name, text: m.name + (m.online ? '' : '（离线）') })) : [h('option', { value: '', text: '没有在线的机器' })]));
    importMachine.disabled = !ms.length;
    importBtn.disabled = !ms.length;
    backupBtn.disabled = !ms.length;
  }

  async function load() {
    note('读取中…');
    let v;
    try { v = await (await fetch('/api/claude-apis')).json(); } catch { note('读不到设置', true); return; }
    view = v;
    const c = { default: v.default || '', machines: v.machines || {}, aliases: v.aliases || {} };
    raw.value = JSON.stringify(c, null, 2);
    draw(c);
    backupHint.textContent = v.backupDir ? `群晖总配置每次保存前自动备份到 ${v.backupDir}（保留 20 份和 1 份原始副本）。` : '';
    note('');
  }

  backupBtn.addEventListener('click', async () => {
    const machine = importMachine.value;
    if (!machine) return note('没有在线的机器', true);
    note('正在备份 ' + machine + ' 的本机 json…');
    const r = await net.post('/api/claude-apis/backup', { machine });
    if (!r.ok) return note(r.msg || '备份失败', true);
    note(`已备份 ${machine}：${(r.files || []).join('、') || '（没有找到 settings.json，稍后再试）'}`);
  });

  importBtn.addEventListener('click', async () => {
    const machine = importMachine.value, alias = importAlias.value.trim();
    if (!machine) return note('没有在线的机器', true);
    if (!aliasOk(alias)) return note('别名只能用字母、数字、点、下划线、横线', true);
    note('正在读取 ' + machine + ' 的本机 settings.json…');
    const r = await net.post('/api/claude-apis/import', { machine, alias, label: importLabel.value.trim(), proxy: importProxy.value, scope: importScope.value });
    if (!r.ok) return note(r.msg || '导入失败', true);
    view = r.view;
    const c = { default: view.default || '', machines: view.machines || {}, aliases: view.aliases || {} };
    raw.value = JSON.stringify(c, null, 2); draw(c);
    note(`已从 ${machine} 导入 ${alias}（密钥留在群晖，不回显）`);
  });

  addBtn.addEventListener('click', () => {
    const p = payload(); if (!p) return;
    let n = 1, id = 'new';
    while (p.aliases && p.aliases[id]) id = 'new' + (++n);
    p.aliases = p.aliases && typeof p.aliases === 'object' ? p.aliases : {};
    p.aliases[id] = emptyAlias(id);
    setConfig(p);
    note(`已加 ${id}，填好环境变量后保存`);
  });

  saveBtn.addEventListener('click', async () => {
    const p = payload(); if (!p) return;
    note('保存中…');
    const r = await net.post('/api/claude-apis/set', p);
    if (!r.ok) return note(r.msg || '保存失败', true);
    view = r.view;
    const c = { default: view.default || '', machines: view.machines || {}, aliases: view.aliases || {} };
    raw.value = JSON.stringify(c, null, 2); draw(c);
    note('已保存；在线机器会马上同步，终端别名也会重新生成');
  });
  reloadBtn.addEventListener('click', load);

  root.append(
    h('p', { class: 'ghint', text: '每个别名是一套 API（base URL + key + 代理方式），启动栏里显示为 claude-deepseek、claude-nebula 这样的选项。共享部分写在 aliases.<别名>.settings；某台机器不同就写在 aliases.<别名>.machines.<机器名>，合并时覆盖共享部分。机器自己的 ~/.claude/settings.json 仍是基础，hooks、权限、模型不动。' }),
    h('p', { class: 'ghint', text: '密钥在 JSON 里显示为 __UNCHANGED__：保留就沿用原 key，直接改成新值就是换 key；列表只显示“已设置”。' }),
    msg,
    h('h4', { class: 'aim-h', text: '别名' }), aliasesEl,
    h('h4', { class: 'aim-h', text: '从某台机器的本机 settings.json 导入' }),
    h('p', { class: 'ghint', text: '读取那台机器的 ~/.claude/settings.json，只取 env / model / effort 这些 API 相关字段；key 直接留在群晖，不回到浏览器。只给这台机器就选「只给这台机器」；要让所有机器都用这套 API，选「所有机器共用」。导入前会自动把本机 settings.json / settings.local.json 备份到那台机器的 ~/.ametyping/backups/；也可以先点旁边的备份。' }),
    h('div', { class: 'capi-form' }, importMachine, importAlias, importLabel, importProxy, importScope, backupBtn, importBtn),
    h('h4', { class: 'aim-h', text: '每台机器默认用哪个别名' }),
    h('p', { class: 'ghint', text: '群晖 AI 任务用哪个别名，在「AI 模型」页的模型下拉里选 claude-<别名> · 模型。' }), defaultsEl,
    h('h4', { class: 'aim-h', text: '配置 JSON（可逐台改变体）' }), backupHint,
    h('div', { class: 'capi-btns' }, addBtn, saveBtn, reloadBtn), raw,
    h('p', { class: 'ghint', text: '代理方式：direct 直连（deepseek）；inherit 沿用那台机器自己的代理（Windows 的 10808、dell97 的 v2rayN、群晖的 egress）；也可以直接写 http(s):// 地址。' }),
  );
  load();
  return { root, destroy() {} };
}
