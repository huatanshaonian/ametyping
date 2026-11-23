// 控制面板 › 设备更新 (server/fleet): each computer's agent version against the bundle the last deploy put on the NAS,
// the update the server pushes over the agent's own connection (no SSH; a development checkout never), and 一键配置:
// Claude Code / Codex / OpenCode on a computer pointed at Magpie with a gateway key of its own.
import { h } from '../util.js';
import * as net from '../net.js';
import { askCode } from '../gate.js';

const short = (c) => (c ? c.slice(0, 7) : '—');
const ago = (t) => { const s = Date.parse(t); if (!s) return ''; const m = Math.round((Date.now() - s) / 60e3); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const STATUS = { running: '更新中', restarting: '重启中', ok: '已更新', failed: '失败', blocked: '没更新' };
const TARGET_NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const MODEL_KEYS = [['opus', 'Claude opus'], ['sonnet', 'Claude sonnet'], ['haiku', 'Claude haiku'], ['fable', 'Claude fable'], ['codex', 'Codex 默认模型']];

async function post(path, body) {
  let r = await net.post('/api/fleet/' + path, body);
  if (r && !r.ok && r.need === 'totp') {
    if (!(await askCode())) return { ok: false, msg: '已取消' };
    r = await net.post('/api/fleet/' + path, body);
  }
  return r || { ok: false, msg: '服务器没有回答' };
}

export function panel() {
  const root = h('div', { class: 'mcp fleet' });
  const msg = h('p', { class: 'gnote', 'aria-live': 'polite' });
  const body = h('div');
  root.append(h('p', { class: 'ghint', text: '每台电脑的 agent 连着看板服务器。部署（deploy.js）把新版本的 agent 文件放到 NAS 上，服务器经这条连接推给各电脑并让它重启；新版本两分钟内没连回来就自动退回旧版本。开发用的目录（多个工作树、不在 main、有没提交的改动）永远不会被自动更新。' }), msg, body);
  let data = null, busy = false;
  const say = (t) => { msg.textContent = t || ''; };

  function versionCell(m) {
    const v = m.version;
    if (!v) return h('small', { text: m.online ? 'agent 版本旧，不会上报（用 deploy.js --ssh-agents 更新一次）' : '没有上报过' });
    const bits = [h('code', { text: short(v.commit) }), h('small', { text: ` ${v.mode === 'git' ? 'git' : '文件'} · ${v.platform || ''}` })];
    if (!v.auto) bits.push(h('div', {}, h('small', { class: 'bad', text: v.why || '不自动更新' })));
    if (v.last && !v.last.ok) bits.push(h('div', {}, h('small', { class: 'bad', text: '上次：' + v.last.msg })));
    return h('div', {}, ...bits);
  }
  function runCell(m) {
    const r = m.run;
    const head = !data.bundle ? '' : !m.version ? '' : !m.behind ? '最新' : m.version.auto && m.version.control ? '待更新' : '落后';
    if (!r || r.commit !== (data.bundle && data.bundle.commit)) return h('small', { text: head });
    return h('div', {}, h('small', { class: r.status === 'failed' || r.status === 'blocked' ? 'bad' : '', text: `${STATUS[r.status] || r.status}：${r.msg || ''}` }),
      ...(r.notes || []).map((n) => h('div', {}, h('small', { text: '· ' + n }))), h('div', {}, h('small', { text: ago(r.at) })));
  }
  function actions(m) {
    const out = [];
    if (data.control && m.version && m.version.auto && m.version.control && m.behind) {
      const blocked = m.run && m.run.status === 'blocked';
      out.push(h('button', { class: 'btn', type: 'button', text: blocked ? '强制更新' : '更新', disabled: busy, onclick: async () => {
        if (blocked && !confirm(`${m.name} 上有文件被直接改过，强制更新会覆盖它们（旧文件留有备份）。继续？`)) return;
        busy = true; say(`正在更新 ${m.name}…`);
        const r = await post('update', { machine: m.name, force: blocked });
        busy = false; say(r.msg || (r.ok ? '已开始' : '失败')); load();
      } }));
    }
    if (data.control && m.online && m.version && m.version.control) out.push(h('button', { class: 'btn', type: 'button', text: '配置 agent', onclick: () => configure(m) }));
    return h('div', { class: 'fleet-act' }, ...out);
  }

  // 一键配置 of one computer
  const cfgBox = h('div');
  function configure(m) {
    const checks = data.targets.map((t) => { const c = h('input', { type: 'checkbox', checked: true }); c.dataset.t = t; return h('label', {}, c, ' ' + (TARGET_NAMES[t] || t)); });
    const reissue = h('input', { type: 'checkbox', checked: !(m.version.magpieKey && m.version.magpieKey.id) });
    const out = h('div');
    const go = h('button', { class: 'btn', type: 'button', text: '写入配置', onclick: async () => {
      const targets = checks.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.t);
      go.disabled = true; out.replaceChildren(h('small', { text: '正在写入…' }));
      const r = await post('configure', { machine: m.name, targets, reissue: reissue.checked });
      go.disabled = false;
      out.replaceChildren(
        h('p', { class: r.ok ? '' : 'bad', text: r.ok ? `完成。${r.key ? `密钥 ${r.key.name}（${r.key.issued ? '新发的' : '沿用这台电脑已有的'}）` : ''}` : (r.msg || '有的没写成') }),
        ...(r.results || []).map((x) => h('div', {}, h('b', { text: (TARGET_NAMES[x.target] || x.target) + '：' }),
          h('small', { class: x.ok ? '' : 'bad', text: x.ok ? `${x.file}${x.backup ? '（原文件备份在 ' + x.backup + '）' : ''}${x.msg ? ' · ' + x.msg : ''}` : x.msg }))),
        h('p', { class: 'ghint', text: '改完后，已经开着的 Claude Code / Codex / OpenCode 要重开才会用新配置。' }));
      load();
    } });
    cfgBox.replaceChildren(h('div', { class: 'mcp-card' },
      h('div', { class: 'mcp-h' }, h('b', { text: '配置 ' + m.name }), h('small', { text: `网关 ${data.settings.gateway || '（未填）'}` })),
      h('div', { class: 'fleet-checks' }, ...checks),
      h('label', {}, reissue, m.version.magpieKey && m.version.magpieKey.id ? ` 重新发一把密钥（现在用的是 ${m.version.magpieKey.name || m.version.magpieKey.id}，旧的会失效）` : ' 给这台电脑发一把自己的 Magpie 密钥'),
      h('p', { class: 'ghint', text: '只改各配置文件里 Magpie 相关的几项，其余保持原样；每个文件改之前都会备份到这台电脑的 ~/.ametyping/config-backups。' }),
      go, out));
    cfgBox.scrollIntoView({ block: 'nearest' });
  }

  function settingsBox() {
    const s = data.settings;
    const auto = h('input', { type: 'checkbox', checked: !!s.auto });
    const gw = h('input', { type: 'url', value: s.gateway || '', placeholder: 'https://你的网关域名', size: 34 });
    const list = h('datalist', { id: 'fleet-models' }, ...(data.models || []).map((m) => h('option', { value: m.id, label: m.name || m.id })));
    const inputs = MODEL_KEYS.map(([k, label]) => { const i = h('input', { type: 'text', value: (s.models || {})[k] || '', list: 'fleet-models', size: 34, placeholder: '不填就不改' }); i.dataset.k = k; return h('label', { class: 'fleet-row' }, h('span', { text: label }), i); });
    const save = h('button', { class: 'btn', type: 'button', text: '保存', disabled: !data.control, onclick: async () => {
      const models = {}; for (const l of inputs) { const i = l.querySelector('input'); if (i.value.trim()) models[i.dataset.k] = i.value.trim(); }
      save.disabled = true; const r = await post('settings', { auto: auto.checked, gateway: gw.value.trim(), models }); save.disabled = false;
      say(r.ok ? '已保存' : r.msg); load();
    } });
    const mag = data.magpie || {};
    return h('div', {},
      h('label', {}, auto, ' 部署后自动更新（每台电脑每个版本只自动试一次，失败的等你点「更新」）'),
      h('h4', { class: 'aim-h', text: '一键配置用的网关和模型' }),
      h('label', { class: 'fleet-row' }, h('span', { text: '网关地址' }), gw), list, ...inputs, save,
      h('p', { class: mag.ok ? 'ghint' : 'ghint bad', text: mag.ok ? 'Magpie 管理密钥已配置：配置一台电脑时自动给它发一把自己的网关密钥（名字是 windose-电脑名）。'
        : '自动发密钥还不能用：' + (mag.msg || '') }),
      mag.ok ? '' : h('pre', { text: '# 在 NAS 上（Magpie 要是有管理接口的新版本）\nsudo docker exec magpie magpie gateway-key add "Windose 管理"   # 记下打印出来的 id 和密钥\nsudo docker exec magpie magpie gateway-key admin <id> local\n# 把密钥存进文件（chmod 600），在看板 config.json 里加：\n#   "magpie": { "baseURL": "http://127.0.0.1:3425/v1", "adminKeyFile": "/path/to/magpie-admin.key" }\n# 然后重启看板服务器' }));
  }

  async function load() {
    try { data = await (await fetch('/api/fleet')).json(); } catch { data = null; }
    if (!data || !data.machines) { say('读不到设备信息（看板服务器版本太旧？）'); return; }
    const b = data.bundle;
    const rows = data.machines.map((m) => h('tr', {},
      h('td', {}, h('b', { text: m.name }), h('small', { text: m.online ? ' 在线' : ' 离线' })),
      h('td', {}, versionCell(m)), h('td', {}, runCell(m)), h('td', {}, actions(m))));
    body.replaceChildren(
      h('p', {}, h('b', { text: 'NAS 上的更新包：' }), b ? h('span', {}, h('code', { text: short(b.commit) }), h('small', { text: ` ${b.files} 个文件 · ${ago(b.at)}` }))
        : h('small', { text: '还没有（运行一次 node remote/deploy/deploy.js 就会放上去）' })),
      rows.length ? h('table', { class: 'mcp-t' }, h('thead', {}, h('tr', {}, h('th', { text: '电脑' }), h('th', { text: '版本' }), h('th', { text: '状态' }), h('th', { text: '' }))), h('tbody', {}, ...rows))
        : h('p', { class: 'ghint', text: '还没有电脑连上来。' }),
      cfgBox, settingsBox());
    if (!data.control) say('服务器处于只读模式：只能看，不能更新或配置。');
  }
  const off = net.on('fleet', () => { if (!busy) load(); });
  load();
  return { root, show: load, destroy: off };
}
