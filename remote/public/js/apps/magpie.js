import { h, icon, prefs } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
let inst;
const number = (v, digits = 0) => typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '未知';
const when = v => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '未知';
const duration = ms => {
  const hours = Math.ceil(ms / 3600000);
  return hours >= 24 ? `${Math.floor(hours / 24)} 天${hours % 24 ? ' ' + hours % 24 + ' 小时' : ''}` : ms >= 3600000 ? `${hours} 小时` : `${Math.ceil(ms / 60000)} 分钟`;
};
const providers = { kiro: 'Kiro', devin: 'Devin', antigravity: 'AGY', deepseek: 'DeepSeek', gcp: 'GCP' };
export function open() {
  if (inst) return wm.restore('magpie');
  inst = mount();
  wm.open({ id: 'magpie', title: 'Magpie 用量', icon: icon('chart1', true), width: 1060, height: 720, content: inst.root,
    onClose() { inst.destroy(); inst = null; } });
}
function mount() {
  let period = 'today', filter = '', dead = false, loading = false;
  const root = h('div', { class: 'magpie-monitor' }), body = h('div', { class: 'mp-body' }), status = h('span', { class: 'mp-status' });
  const select = h('select', { class: 'field', 'aria-label': '统计时段' }, ...[['today', '今日'], ['7d', '近 7 天'], ['30d', '近 30 天']].map(([value, text]) => h('option', { value, text })));
  const search = h('input', { class: 'field', placeholder: '筛选来源 / 套餐 / 账号', 'aria-label': '筛选账号' });
  const refresh = h('button', { class: 'btn', text: '刷新', onclick: () => load() });
  const website = h('button', { class: 'btn', type: 'button', text: 'Magpie 网页', title: '在新标签页打开 Magpie 控制程序',
    onclick: () => window.open('https://magpie.huatan.org/', '_blank', 'noopener,noreferrer') });
  const tools = h('div', { class: 'mp-tools' }, select, search, website, refresh);
  status.setAttribute('role', 'status');
  root.append(tools, body, h('footer', { class: 'mp-statusbar' }, status));
  select.addEventListener('change', () => { period = select.value; load(); });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); if (last) render(last); });
  let last;
  function stat(label, value) { return h('div', { class: 'mp-stat' }, h('small', { text: label }), h('strong', { text: value })); }
  function windowRow(w) {
    const known = typeof w.remaining === 'number', pct = known ? Math.min(100, Math.max(0, w.remaining)) : null;
    const meter = h('div', { class: 'mp-meter' + (known && pct <= 15 ? ' mp-low' : '') + (!known ? ' mp-unknown' : ''), role: 'meter', 'aria-label': w.name + '剩余额度', ...(known ? { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 } : {}) }, h('span', { style: `width:${pct ?? 0}%` }));
    const left = w.resetsAt ? Date.parse(w.resetsAt) - Date.now() : null;
    const reset = left === null ? '重置时间未知' : left <= 0 ? '已到重置时间，等待来源更新' : `${duration(left)}后重置`;
    return h('div', { class: 'mp-window' }, h('div', { class: 'mp-window-head' }, h('b', { text: w.name }), h('strong', { text: w.unlimited ? '不限额' : known ? `剩余 ${number(w.remaining, 2)}%` : '额度未知' })),
      meter, h('div', { class: 'mp-window-meta' }, typeof w.amount === 'number' ? `已用 ${number(w.amount, 2)} / ${number(w.limit, 2)} ${w.unit}` : typeof w.used === 'number' ? `已用 ${number(w.used, 2)}%` : '使用量未知', h('span', { text: reset, title: '来源重置时间：' + when(w.resetsAt) })),
      h('small', { text: w.resetsAt ? '重置于 ' + when(w.resetsAt) : '' }));
  }
  function account(q, stale) {
    const old = !q.readAt || Date.now() - Date.parse(q.readAt) > 20 * 60000;
    const u = q.usage;
    return h('article', { class: 'mp-account' }, h('header', {}, h('div', {}, h('h3', { text: q.plan || q.name || providers[q.provider] || q.provider }), h('span', { text: `${providers[q.provider] || q.provider} · ${q.account}` })),
      h('span', { class: 'mp-badge ' + (q.status === 'error' || q.status === 'partial' || stale || old ? 'mp-warn' : ''), text: q.quotaStatus === 'unread' ? '上游尚未读取' : q.status === 'partial' ? '上游额度不可读' : q.status === 'error' ? '来源读取失败' : stale || old ? '来源数据待更新' : q.status === 'unknown' ? '额度未提供' : '已读取' })),
      ...q.windows.map(windowRow),
      ...(q.connectionLimits?.length ? [h('p', { class: 'mp-muted', text: q.quotaStatus === 'unread' ? '远端 Magpie 尚未读取上游订阅额度。' : !q.windows.length ? '远端上游订阅额度暂不可读。' : '' }),
        ...q.connectionLimits.map(c => h('div', { class: 'mp-window mp-connection' }, h('b', { text: '连接 Key 限额' }),
          ...c.windows.map(w => h('div', { text: w.unlimited ? '未设置调用限额' : `${w.name} · 剩余 ${number(w.remaining, 2)}%` })),
          h('small', { text: '此处仅表示本连接的限额，不代表上游订阅额度无限。' }), h('br'), h('small', { text: '连接限额读取：' + when(c.readAt) }))) ] : []),
      ...(q.balance ? [h('p', { text: '余额：' + number(q.balance.amount, 2) + ' ' + q.balance.currency })] : []),
      !q.windows.length && !q.balance && !q.connectionLimits?.length ? h('p', { class: 'mp-muted', text: '此来源未提供可读取的额度窗口' }) : '',
      h('div', { class: 'mp-account-usage' }, u ? h('details', {}, h('summary', { text: `调用 ${number(u.calls)} · 输出 ${number(u.output)} · 估算 ${typeof u.cost === 'number' ? '$' + number(u.cost, 4) : '未知'}` }),
        ...[['errors', '错误'], ['input', '输入 tokens'], ['output', '输出 tokens'], ['cache_read', '缓存读取 tokens'], ['cache_write', '缓存写入 tokens'], ['cache_unknown', '缓存情况未知 tokens'], ['cache_unknown_calls', '缓存情况未知调用'], ['reasoning', '推理 tokens'], ['unpriced', '未定价调用']].map(([k, label]) => h('div', { text: label + '：' + number(u[k]) }))) : '该账号的时段调用统计未提供或无法精确匹配'),
      h('footer', { text: `额度读取：${when(q.readAt)}${q.lastServedAt ? ' · 最近调用：' + when(q.lastServedAt) : ''}${q.remote ? ' · 来自远程 Magpie' : ''}` }));
  }
  function render(s) {
    status.textContent = s.enabled ? `后台每 5 分钟采集 · 最近采集 ${when(s.quotaAt)}` : '尚未启用 Magpie';
    const rows = s.accounts.filter(q => `${q.provider} ${providers[q.provider] || ''} ${q.plan} ${q.name} ${q.account}`.toLowerCase().includes(filter));
    const t = s.totals || {};
    body.replaceChildren(
      h('div', { class: 'mp-summary' }, stat('账号 / 来源', number(s.accounts.length)), stat('调用', number(t.calls)), stat('输入 / 输出 tokens', `${number(t.input)} / ${number(t.output)}`), stat('费用估算', typeof t.cost === 'number' ? '$' + number(t.cost, 4) : '未知')),
      h('p', { class: 'mp-muted', text: `调用统计自 ${when(s.since)} 起，覆盖 NAS Magpie 的全部客户端。费用按模型单价估算；缓存缺失表示未知。额度来自上游，可能延迟。` }),
      ...Object.entries(s.errors || {}).map(([k, message]) => h('p', { class: 'mp-error', text: `${k}：${message}` })),
      h('div', { class: 'mp-grid' }, ...rows.map(q => account(q, s.stale))),
      !rows.length ? h('p', { class: 'mp-muted', text: s.enabled ? '没有匹配的账号数据' : '请在群晖服务端启用 Magpie 连接' }) : '',
      h('details', {}, h('summary', { text: `可用模型（${s.models.length}）` }), h('div', { class: 'mp-models' }, ...s.models.map(m => h('code', { text: m.id })))));
  }
  async function load() {
    if (loading || dead) return; loading = true; refresh.disabled = true;
    try { const s = await readStatus(period); if (!dead) { last = s; render(s); } }
    catch { if (!dead) status.textContent = '状态暂不可读，请稍后刷新'; }
    finally { loading = false; refresh.disabled = false; }
  }
  const off = net.on('magpie', load), timer = setInterval(load, 60000); load();
  return { root, destroy() { dead = true; off(); clearInterval(timer); } };
}

// Share in-flight/cache reads between the desktop widget and the full window.
const snapshots = new Map();
async function readStatus(period = 'today') {
  const old = snapshots.get(period);
  if (old && Date.now() - old.at < 1000) return old.promise;
  const promise = fetch('/api/magpie/status?period=' + period).then(res => { if (!res.ok) throw Error('unavailable'); return res.json(); });
  const entry = { at: Date.now(), promise }; snapshots.set(period, entry);
  try { return await promise; } catch (e) { if (snapshots.get(period) === entry) snapshots.delete(period); throw e; }
}
const shortWindow = name => /7\s*days/i.test(name) ? '周' : /5\s*hours/i.test(name) ? '5h' : /1\s*day/i.test(name) ? '日' : /credits/i.test(name) ? '' : name;
function brief(q) {
  if (q.status === 'error') return '读取失败';
  if (!q.windows.length && q.connectionLimits?.length) return q.connectionLimits.every(c => c.windows.length && c.windows.every(w => w.unlimited)) ? '上游未知 / Key 未设限' : '上游未知 / Key 有限额';
  if (q.balance) return `${number(q.balance.amount, 2)} ${q.balance.currency}`;
  const claude = q.windows.filter(w => /claude/i.test(w.name));
  const windows = claude.length ? claude : q.windows;
  return windows.slice(0, 2).map(w => w.unlimited ? '不限额' : `${shortWindow(w.name)}${typeof w.remaining === 'number' ? number(w.remaining, 1) + '%' : '未知'}`).join(' / ') || '额度未知';
}
export function initWidget(desktop) {
  if (document.getElementById('magpiewidget')) return;
  let collapsed = prefs.get('magpie.collapsed', false), loading = false, dead = false;
  const rows = h('div', { class: 'mpw-rows' }), status = h('small', { class: 'mpw-status', text: '正在读取…', role: 'status' });
  const title = h('button', { class: 'mpw-title', type: 'button', text: 'Magpie 用量', title: '打开完整用量面板', onclick: open });
  const fold = h('button', { class: 'mpw-fold', type: 'button', title: '收起 / 展开', 'aria-label': '收起或展开 Magpie 用量' });
  const root = h('section', { id: 'magpiewidget', class: 'mp-widget', 'aria-label': 'Magpie 用量摘要' },
    h('div', { class: 'mpw-head' }, h('img', { src: icon('chart1', true), alt: '' }), title, fold),
    h('div', { class: 'mpw-body' }, rows, status));
  function folding() { root.classList.toggle('collapsed', collapsed); fold.textContent = collapsed ? '＋' : '－'; fold.setAttribute('aria-expanded', String(!collapsed)); }
  fold.addEventListener('click', () => { collapsed = !collapsed; prefs.set('magpie.collapsed', collapsed); folding(); });
  async function load() {
    if (loading || dead) return; loading = true;
    try {
      const s = await readStatus(); if (dead) return;
      rows.replaceChildren(...s.accounts.map(q => {
        const stale = s.stale || !q.readAt || Date.now() - Date.parse(q.readAt) > 20 * 60000;
        const resets = q.windows.map(w => Date.parse(w.resetsAt)).filter(t => Number.isFinite(t) && t > Date.now()).sort((a, b) => a - b);
        const reset = resets.length ? `${duration(resets[0] - Date.now())}后重置` : '';
        return h('button', { class: 'mpw-row' + (q.status === 'error' ? ' mpw-error' : ''), type: 'button', title: `${q.account} · ${when(q.readAt)}`, onclick: open },
          h('span', { class: 'mpw-name', text: q.provider === 'antigravity' && q.windows.some(w => /claude/i.test(w.name)) ? 'AGY Claude' : q.plan || providers[q.provider] || q.name || q.provider }),
          h('b', { class: 'mpw-value', text: brief(q) }),
          h('small', { text: [stale ? '来源待更新' : '', reset].filter(Boolean).join(' · ') || (q.status === 'error' ? '详情见完整面板' : q.windows.length ? '重置时间未知' : '') }));
      }));
      const errors = s.accounts.filter(q => q.status === 'error').length;
      status.textContent = s.enabled ? `剩余额度摘要 · 今日 ${number(s.totals?.calls)} 次调用${errors ? ` · ${errors} 个来源异常` : ''}` : '尚未启用 Magpie';
      if (!s.accounts.length) rows.append(h('div', { class: 'mpw-empty', text: '暂无账号数据' }));
    } catch { if (!dead) status.textContent = '用量暂不可读'; }
    finally { loading = false; }
  }
  folding(); desktop.append(root); load();
  const off = net.on('magpie', load), timer = setInterval(load, 60000);
  return { destroy() { dead = true; clearInterval(timer); off(); root.remove(); } };
}
