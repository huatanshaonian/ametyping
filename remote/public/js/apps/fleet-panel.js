// Skill 与协同 › 设备与 Harness (server/fleet): each computer's agent version against the bundle the last deploy put on
// the NAS, the update the server pushes over the agent's own connection (no SSH; a development checkout never), the
// coding agents ("harnesses") there -- installed, version, install / update, all at once -- and 一键配置: Claude Code
// and OpenCode pointed at Magpie with a gateway key of the computer's own, Codex given the computer's proxy.
import { h } from '../util.js';
import * as net from '../net.js';
import { askCode } from '../gate.js';

const short = (c) => (c ? c.slice(0, 7) : '—');
const ago = (t) => { const s = Date.parse(t); if (!s) return ''; const m = Math.round((Date.now() - s) / 60e3); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const STATUS = { running: '更新中', restarting: '重启中', ok: '已更新', failed: '失败', blocked: '没更新' };
const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' };
const TARGET_NOTE = { claude: 'Magpie 网关，局域网直连', opencode: 'Magpie 网关，局域网直连', codex: '保持 ChatGPT 登录，走这台电脑的代理' };
const MODEL_KEYS = [['opus', 'Claude opus'], ['sonnet', 'Claude sonnet'], ['haiku', 'Claude haiku'], ['fable', 'Claude fable']];
const PROXY_HINT = 'http://127.0.0.1:10808';

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
  root.append(h('p', { class: 'ghint', text: '每台电脑的 agent 连着看板服务器。部署（deploy.js）会把新版本更新包与 git bundle 放到 NAS 上，各电脑直接从 NAS 经 HTTP 拉取并精确切到部署版本，重启失败两分钟内自动回滚。标了 autoUpdate: false 或多工作树的开发目录永不自动更新；非开发机若本地改动文件导致无法拉取，会直接在此提示手动处理。编程 agent（harness）也在这里装和更新。' }), msg, body);
  let data = null, busy = false;
  const say = (t) => { msg.textContent = t || ''; };
  const act = async (path, body, doing) => {
    busy = true; say(doing);
    const r = await post(path, body);
    busy = false; say(r.msg || (r.ok ? '已开始' : '失败')); load();
    return r;
  };

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
  // the harnesses of one computer: version (against the newest), install / update, the last outcome
  const newest = (id) => ((data.releases && data.releases.latest && data.releases.latest[id]) || {}).version || '';
  const vplain = (s) => (String(s || '').match(/\d+\.\d+\.\d+/) || [''])[0];
  function harnessCell(m) {
    const v = m.version, list = v && v.harnesses;
    if (!list) return h('small', { text: v ? 'agent 版本旧，不上报' : '' });
    const can = data.control && m.online && v.control && !m.harnessBusy;
    const behind = new Set(m.behindHarness || []);
    return h('div', { class: 'fleet-hs' }, ...list.map((x) => {
      const r = m.harness[x.id];
      const btn = can ? h('button', { class: 'btn fleet-sm', type: 'button', text: x.installed ? (x.line === 'legacy' ? '迁移到 2.x' : '更新') : '安装', disabled: busy, onclick: () =>
        act('harness', { machine: m.name, id: x.id, action: x.installed ? 'update' : 'install' }, `${m.name}：${x.installed ? '更新' : '安装'} ${NAMES[x.id]}…`) }) : '';
      const last = r ? h('small', { class: r.status === 'failed' ? 'bad' : '', title: [...(r.notes || []), r.log || ''].filter(Boolean).join('\n'),
        text: ` ${r.status === 'running' ? '…' + r.msg : r.msg}${r.status !== 'running' ? '（' + ago(r.at) + '）' : ''}` }) : '';
      const ver = x.installed ? ` ${vplain(x.version) || x.version || '已装'}${x.method === 'npm' ? ' · npm' : ''}` : ' 没装';
      return h('div', { class: 'fleet-h' + (x.installed ? '' : ' off') }, h('b', { text: NAMES[x.id] || x.label }),
        h('small', { text: ver, title: x.path || '' }),
        behind.has(x.id) ? h('small', { class: 'bad', text: x.line === 'legacy' ? ' 旧的 1.x 线' : ` → ${newest(x.id)}` }) : '',
        btn, last,
        ...(r && r.status !== 'running' && r.notes && r.notes.length ? r.notes.map((n) => h('div', {}, h('small', { text: '· ' + n }))) : []));
    }), can && list.some((x) => x.installed) ? h('button', { class: 'btn fleet-sm', type: 'button', text: '全部更新', disabled: busy,
      onclick: () => act('harness', { machine: m.name, id: '*', action: 'update' }, `${m.name}：更新全部 harness…`) }) : '',
    data.control && v.control ? h('label', { class: 'fleet-off' }, h('input', { type: 'checkbox', checked: !m.harnessOff, disabled: busy,
      onchange: (e) => act('settings', { harnessOff: { machine: m.name, off: !e.target.checked } }, '保存中…') }), h('small', { text: ' 每天自动更新' })) : '',
    m.harnessBusy ? h('small', { text: '正在进行…' }) : '');
  }
  // the way out this computer uses for Codex and downloads, where it came from, and what the agent found
  const REACH = [['openai', 'OpenAI'], ['npm', 'npm'], ['github', 'GitHub'], ['claude', 'Claude 下载'], ['agy', 'agy 下载']];
  function netCell(m) {
    const v = m.version, e = m.effective || {}, n = v && v.net;
    const reach = (r) => REACH.map(([k, l]) => (r && r.reach && r.reach[k] ? '✓' : '✗') + l).join(' ');
    const detail = n ? [`直连：${reach(n.direct)}`, ...(n.routes || []).map((r) => `${r.url}（${r.source}）：${reach(r)} · ${r.ms} ms`), `检测于 ${ago(new Date(n.at).toISOString())}`].join('\n') : '';
    return h('div', {}, h('code', { text: e.proxy || (e.source ? '直连' : '—'), title: detail }),
      h('div', {}, h('small', { text: e.source || (v && v.harnesses ? '还没检测' : '') })),
      n && n.needProxy && !n.recommended ? h('div', {}, h('small', { class: 'bad', text: '没找到能到 OpenAI 的代理' })) : '',
      data.control && m.online && v && v.control ? h('button', { class: 'btn fleet-sm', type: 'button', text: '重新检测', disabled: busy,
        onclick: () => act('netprobe', { machine: m.name }, `${m.name}：检测网络…`) }) : '');
  }
  // the daily harness check: when, the last one, the newest versions and what changed
  function dailyBox() {
    const s = data.settings, d = s.daily || {}, rel = data.releases || {};
    const on = h('input', { type: 'checkbox', checked: !!d.on });
    const at = h('input', { type: 'time', value: d.at || '03:40' });
    const save = h('button', { class: 'btn', type: 'button', text: '保存', disabled: !data.control || busy,
      onclick: () => act('settings', { daily: { on: on.checked, at: at.value } }, '保存中…') });
    const now = h('button', { class: 'btn', type: 'button', text: data.checking ? '正在检查…' : '现在检查并更新', disabled: !data.control || busy || data.checking,
      onclick: () => act('check', {}, '开始检查…') });
    const latest = Object.entries(rel.latest || {}).map(([id, x]) => `${NAMES[id] || id} ${x.version}`).join(' · ');
    const hist = (rel.history || []).slice(0, 6).map((r) => h('li', {}, h('b', { text: `${r.label} ${r.to}` }), h('small', { text: ` ${ago(new Date(r.at).toISOString())}` }),
      ...(r.major || []).map((t) => h('div', {}, h('small', { class: 'fleet-major', text: '★ ' + t }))),
      ...(r.highlights || []).slice(0, 2).map((t) => h('div', {}, h('small', { text: '· ' + t })))));
    return h('div', { class: 'mcp-card' },
      h('div', { class: 'mcp-h' }, h('b', { text: '每天检查 harness 更新' })),
      h('p', { class: 'ghint', text: '每天在写日报之前查一次各 harness 的新版本，读更新日志（重大变化会写进日报），再让落后的电脑自动更新。Windows 上开着会话的那个 harness 当天跳过（文件在用，换不了）。' }),
      h('div', { class: 'fleet-row' }, h('label', {}, on, ' 每天'), at, save, now),
      h('p', {}, h('small', { text: data.daily ? `上次：${ago(new Date(data.daily.at).toISOString())} · ${data.daily.msg}` : '还没检查过' })),
      latest ? h('p', {}, h('small', { text: '最新版本：' + latest + (rel.checkedAt ? `（${ago(new Date(rel.checkedAt).toISOString())}查的）` : '') })) : '',
      rel.error ? h('p', {}, h('small', { class: 'bad', text: rel.error })) : '',
      hist.length ? h('ul', { class: 'fleet-rel' }, ...hist) : '');
  }
  function actions(m) {
    const out = [];
    if (data.control && m.version && m.version.auto && m.version.control && m.behind) {
      const blocked = m.run && m.run.status === 'blocked';
      out.push(h('button', { class: 'btn', type: 'button', text: blocked ? '强制更新' : '更新 agent', disabled: busy, onclick: async () => {
        if (blocked && !confirm(`${m.name} 上有文件被直接改过，强制更新会覆盖它们（旧文件留有备份）。继续？`)) return;
        act('update', { machine: m.name, force: blocked }, `正在更新 ${m.name}…`);
      } }));
    }
    if (data.control && m.online && m.version && m.version.control) out.push(h('button', { class: 'btn', type: 'button', text: '配置 agent', onclick: () => configure(m) }));
    return h('div', { class: 'fleet-act' }, ...out);
  }

  // 一键配置 of one computer
  const cfgBox = h('div');
  function configure(m) {
    const inst = new Map(((m.version && m.version.harnesses) || []).map((x) => [x.id, x.installed]));
    const checks = data.targets.map((t) => {
      const c = h('input', { type: 'checkbox', checked: true }); c.dataset.t = t;
      return h('label', {}, c, ' ' + (NAMES[t] || t), h('small', { text: `（${TARGET_NOTE[t] || ''}${inst.get(t) === false ? '；还没装，配置先写好，装上就能用' : ''}）` }));
    });
    const eff = m.effective || {};
    const proxy = h('input', { type: 'url', value: m.proxy || '', size: 30,
      placeholder: eff.proxy && !m.proxy ? `不填：${eff.proxy}（${eff.source}）` : data.settings.proxy ? '默认 ' + data.settings.proxy : PROXY_HINT });
    const reissue = h('input', { type: 'checkbox', checked: !(m.version.magpieKey && m.version.magpieKey.id) });
    const out = h('div');
    const go = h('button', { class: 'btn', type: 'button', text: '写入配置', onclick: async () => {
      const targets = checks.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.t);
      go.disabled = true; out.replaceChildren(h('small', { text: '正在写入…' }));
      const r = await post('configure', { machine: m.name, targets, reissue: reissue.checked, proxy: proxy.value.trim() });
      go.disabled = false;
      out.replaceChildren(
        h('p', { class: r.ok ? '' : 'bad', text: r.ok ? `完成。${r.key ? `密钥 ${r.key.name}（${r.key.issued ? '新发的' : '沿用这台电脑已有的'}）` : ''}` : (r.msg || '有的没写成') }),
        ...(r.results || []).map((x) => h('div', {}, h('b', { text: (NAMES[x.target] || x.target) + '：' }),
          h('small', { class: x.ok ? '' : 'bad', text: x.ok ? `${x.file}${x.backup ? '（原文件备份在 ' + x.backup + '）' : ''}${x.msg ? ' · ' + x.msg : ''}` : x.msg }))),
        h('p', { class: 'ghint', text: '改完后，已经开着的 Claude Code / Codex / OpenCode 要重开才会用新配置。' }));
      load();
    } });
    cfgBox.replaceChildren(h('div', { class: 'mcp-card' },
      h('div', { class: 'mcp-h' }, h('b', { text: '配置 ' + m.name }), h('small', { text: `网关 ${data.settings.gateway || '（未填）'}` })),
      h('div', { class: 'fleet-checks' }, ...checks),
      h('label', { class: 'fleet-row' }, h('span', { text: '这台电脑的代理' }), proxy),
      h('label', {}, reissue, m.version.magpieKey && m.version.magpieKey.id ? ` 重新发一把密钥（现在用的是 ${m.version.magpieKey.name || m.version.magpieKey.id}，旧的会失效）` : ' 给这台电脑发一把自己的 Magpie 密钥'),
      h('p', { class: 'ghint', text: '只改各配置文件里 Magpie 相关的几项，其余保持原样；每个文件改之前都会备份到这台电脑的 ~/.ametyping/config-backups。代理不填就用自动检测到的；填了就固定用这个，也用于在这台电脑上安装、更新 harness。' }),
      go, out));
    cfgBox.scrollIntoView({ block: 'nearest' });
  }

  function settingsBox() {
    const s = data.settings;
    const auto = h('input', { type: 'checkbox', checked: !!s.auto });
    const gw = h('input', { type: 'url', value: s.gateway || '', placeholder: 'https://你的网关域名', size: 34 });
    const px = h('input', { type: 'url', value: s.proxy || '', placeholder: PROXY_HINT, size: 34 });
    const list = h('datalist', { id: 'fleet-models' }, ...(data.models || []).map((m) => h('option', { value: m.id, label: m.name || m.id })));
    const inputs = MODEL_KEYS.map(([k, label]) => { const i = h('input', { type: 'text', value: (s.models || {})[k] || '', list: 'fleet-models', size: 34, placeholder: '不填就不改' }); i.dataset.k = k; return h('label', { class: 'fleet-row' }, h('span', { text: label }), i); });
    const save = h('button', { class: 'btn', type: 'button', text: '保存', disabled: !data.control, onclick: async () => {
      const models = {}; for (const l of inputs) { const i = l.querySelector('input'); if (i.value.trim()) models[i.dataset.k] = i.value.trim(); }
      save.disabled = true; const r = await post('settings', { auto: auto.checked, gateway: gw.value.trim(), proxy: px.value.trim(), models }); save.disabled = false;
      say(r.ok ? '已保存' : r.msg); load();
    } });
    const mag = data.magpie || {};
    return h('div', {},
      h('label', {}, auto, ' 部署后自动更新（每台电脑每个版本只自动试一次，失败的等你点「更新」）'),
      h('h4', { class: 'aim-h', text: '一键配置用的网关、代理和模型' }),
      h('label', { class: 'fleet-row' }, h('span', { text: '网关地址' }), gw),
      h('label', { class: 'fleet-row' }, h('span', { text: '默认代理' }), px),
      h('p', { class: 'ghint', text: '每台电脑用哪个代理（Codex，以及安装、更新时的下载）：在它的「配置 agent」里填了的就用它；没填就用它的 agent 自己检测到能通的（看「网络」一栏）；都没有才用这里的默认代理。' }),
      list, ...inputs, save,
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
      h('td', {}, versionCell(m)), h('td', {}, runCell(m)), h('td', {}, harnessCell(m)), h('td', {}, netCell(m)), h('td', {}, actions(m))));
    const anyHarness = data.machines.some((m) => m.online && m.version && m.version.control && (m.version.harnesses || []).some((x) => x.installed));
    body.replaceChildren(
      h('p', {}, h('b', { text: 'NAS 上的更新包：' }), b ? h('span', {}, h('code', { text: short(b.commit) }), h('small', { text: ` ${b.files} 个文件 · ${ago(b.at)}` }))
        : h('small', { text: '还没有（运行一次 node remote/deploy/deploy.js 就会放上去）' })),
      data.control && anyHarness ? h('p', {}, h('button', { class: 'btn', type: 'button', text: '所有电脑：更新全部 harness', disabled: busy,
        onclick: () => act('harness', { machine: '*', id: '*', action: 'update' }, '正在让所有电脑更新 harness…') }),
      h('small', { text: ' 每台电脑一个接一个地更新它装了的 Claude Code / Codex / OpenCode / Antigravity，电脑之间同时进行' })) : '',
      rows.length ? h('table', { class: 'mcp-t' }, h('thead', {}, h('tr', {}, h('th', { text: '电脑' }), h('th', { text: 'agent 版本' }), h('th', { text: '状态' }), h('th', { text: 'Harness' }), h('th', { text: '网络' }), h('th', { text: '' }))), h('tbody', {}, ...rows))
        : h('p', { class: 'ghint', text: '还没有电脑连上来。' }),
      cfgBox, dailyBox(), settingsBox());
    if (!data.control) say('服务器处于只读模式：只能看，不能更新或配置。');
  }
  const off = net.on('fleet', () => { if (!busy) load(); });
  load();
  return { root, show: load, destroy: off };
}
