// Manage each computer's own cc-environments files; keys are never stored in the NAS alias registry.
import { h, prefs } from '../util.js';
import * as net from '../net.js';

export function panel() {
  const root = h('div', { class: 'aim capi' });
  const note = h('p', { class: 'gnote' });
  const machine = h('select', { class: 'field', title: '管理哪台电脑的启动入口' });
  const refresh = h('button', { class: 'btn', text: '刷新电脑配置', type: 'button' });
  const add = h('button', { class: 'btn', text: '新增启动入口', type: 'button' });
  const paths = h('p', { class: 'ghint' });
  const rows = h('div', { class: 'capi-list' });
  const id = h('input', { class: 'field', placeholder: 'deepseek 或 nebula', spellcheck: 'false' });
  const url = h('input', { class: 'field', placeholder: 'API 地址', spellcheck: 'false' });
  const model = h('input', { class: 'field', placeholder: '默认模型', spellcheck: 'false' });
  const key = h('input', { class: 'field', type: 'password', placeholder: 'API Key', autocomplete: 'new-password' });
  const network = h('select', { class: 'field' }, h('option', { value: 'direct', text: '直连' }), h('option', { value: 'proxy', text: '使用这台电脑的代理' }));
  const proxy = h('input', { class: 'field', placeholder: '代理地址，例如 http://127.0.0.1:10808', spellcheck: 'false' });
  const save = h('button', { class: 'btn go', text: '保存到这台电脑', type: 'submit' });
  const cancel = h('button', { class: 'btn', text: '取消', type: 'button' });
  const form = h('form', { class: 'capi-editor', hidden: true },
    h('label', {}, '启动命令 claude-', id), h('label', {}, 'API 地址', url), h('label', {}, '默认模型', model),
    h('label', {}, '密钥（已有密钥留空保留）', key), h('label', {}, '网络', network), proxy, h('div', { class: 'capi-btns' }, save, cancel));
  let view = null, seq = 0, dead = false;
  const message = (s, bad = false) => { note.textContent = s; note.className = 'gnote' + (bad ? ' bad' : ''); };
  const proxyVisible = () => { proxy.hidden = network.value !== 'proxy'; };
  network.addEventListener('change', proxyVisible);
  function edit(p) {
    form.hidden = false; id.disabled = !!p;
    id.value = p ? p.id : 'deepseek';
    url.value = p ? p.baseUrl : 'https://api.deepseek.com/anthropic';
    model.value = p ? p.model : 'deepseek-flash[1m]';
    key.value = ''; key.placeholder = p && p.hasCredential ? '已设置，留空保留' : '请输入 API Key';
    network.value = p ? p.network : 'direct'; proxy.value = p ? p.proxy : '';
    proxyVisible(); message('');
  }
  id.addEventListener('change', () => {
    if (id.value === 'nebula') { url.value = 'https://img-api.apinebula.ai'; model.value = 'opus'; network.value = 'proxy'; }
    else if (id.value === 'deepseek') { url.value = 'https://api.deepseek.com/anthropic'; model.value = 'deepseek-flash[1m]'; network.value = 'direct'; }
    proxyVisible();
  });
  function draw() {
    const known = view.known || [], selected = view.machine;
    machine.replaceChildren(...known.map(m => h('option', { value: m.name,
      text: m.name + (!m.online ? '（离线）' : !m.profilesReady ? '（需更新 agent）' : '') })));
    machine.value = selected;
    const writable = view.online && view.ready;
    refresh.disabled = !writable; add.disabled = !writable; save.disabled = !writable;
    paths.textContent = view.root ? 'API 配置：' + view.root + '；共享设置与历史：' + view.sharedDirectory : '';
    rows.replaceChildren(...(view.profiles.length ? view.profiles.map(p => {
      const editButton = h('button', { class: 'btn', text: '编辑', type: 'button', disabled: !writable, onclick: () => edit(p) });
      return h('div', { class: 'capi-row' },
        h('div', {}, h('b', { text: p.command }), h('small', { text: p.file })),
        h('div', { class: 'capi-kv' }, h('span', { text: p.baseUrl === '__UNCHANGED__' ? '接口地址已隐藏' : p.baseUrl }),
          h('small', { text: p.model + ' · ' + (p.network === 'direct' ? '直连' : '本机代理') })),
        h('div', {}, h('span', { class: 'capi-token' + (p.hasCredential ? '' : ' bad'), text: p.hasCredential ? '密钥已设置' : '密钥未设置' }), editButton));
    }) : [h('p', { class: 'ghint', text: writable ? '这台电脑还没有启动入口，可以新增 nebula、deepseek。' :
      view.online ? '请更新并重启这台电脑的 agent，再刷新。' : '电脑离线，连接后可查看和管理配置。' })]));
  }
  async function load(name = '') {
    const current = ++seq;
    try {
      const v = await (await fetch('/api/claude-apis' + (name ? '?machine=' + encodeURIComponent(name) : ''))).json();
      if (dead || current !== seq) return;
      const preferred = name || prefs.get('claude.profile.machine', '') ||
        ((v.known || []).find(m => m.name !== 'nas' && m.online && m.profilesReady) || {}).name || v.machine;
      if (!name && preferred && preferred !== v.machine && (v.known || []).some(m => m.name === preferred)) return load(preferred);
      view = { ...v, profiles: Array.isArray(v.profiles) ? v.profiles : [] }; draw(); form.hidden = true;
      if (!v.ready && v.online) message('这台电脑的 agent 需要更新或重启，配置文件仍保存在该电脑上。', true);
    } catch { if (!dead && current === seq) message('无法读取看板，请刷新连接后再试。', true); }
  }
  machine.addEventListener('change', () => { prefs.set('claude.profile.machine', machine.value); message(''); load(machine.value); });
  refresh.addEventListener('click', async () => {
    const selected = machine.value; refresh.disabled = true; message('正在读取 ' + selected + ' 的本地配置…');
    const r = await net.post('/api/claude-apis/refresh', { machine: selected });
    if (dead || selected !== machine.value) return;
    refresh.disabled = false;
    if (!r.ok) return message(r.msg || '读取失败', true);
    await load(selected); message('已读取该电脑的 cc-environments 配置');
  });
  add.addEventListener('click', () => edit(null));
  cancel.addEventListener('click', () => { form.hidden = true; key.value = ''; });
  form.addEventListener('submit', async e => {
    e.preventDefault(); const selected = machine.value; save.disabled = true; message('正在保存到 ' + selected + '…');
    const r = await net.post('/api/claude-apis/save', { machine: selected, profile: {
      id: id.value.trim(), baseUrl: url.value.trim(), model: model.value.trim(), key: key.value,
      network: network.value, proxy: proxy.value.trim(),
    } });
    key.value = '';
    if (dead || selected !== machine.value) return;
    save.disabled = false;
    if (!r.ok) return message(r.msg || '保存失败', true);
    await load(selected); message('已保存到这台电脑；下次从对应入口启动时生效');
  });
  root.append(h('p', { class: 'ghint', text: '选择电脑，再管理它的 claude-nebula、claude-deepseek 等入口。各入口共享通用设置、审批规则、hooks、插件、skills、记忆和对话历史，只切换 API、默认模型和网络。' }),
    h('div', { class: 'capi-form' }, machine, refresh, add), note, paths, rows, form,
    h('p', { class: 'ghint', text: 'API 配置和密钥保存在所选电脑的 cc-environments 中，修改前自动备份。已有的统一启动器会保留；启动目录跟随所选项目。换入口可恢复同一份历史，请勿同时打开同一会话。' }));
  load();
  return { root, destroy() { dead = true; seq++; key.value = ''; } };
}
