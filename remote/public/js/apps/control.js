// 控制面板（纯净 6 项系统与个人偏好）：显示属性、声音、通知、Google 账户、邮箱、文献推送设置。
// 已迁移模块 100% 兼容旧 ID 精准转发至「设备与算力」(infra.js)、「AI 与额度」(ai-hub.js) 与「研究档案与记忆」(knowledge.js)。
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import { settingsPanel as displayPanel } from '../wallpaper.js';
import { panel as soundsPanel } from './sounds.js';
import { panel as googlePanel } from './google.js';
import { panel as mailPanel } from './mail-accounts.js';
import { panel as notifyPanel } from './notify.js';
import { panel as litPanel } from './lit-settings.js';
import { open as openKnowledge } from './knowledge.js';
import * as infra from './infra.js';
import * as aiHub from './ai-hub.js';
import * as backnav from '../backnav.js';

const ITEMS = [
  { id: 'display', label: '显示属性', icon: 'display_properties', note: '壁纸、配色、界面大小、桌面额外图标', panel: displayPanel },
  { id: 'sounds', label: '声音', icon: 'mixer_sound', note: '系统音效、静音、手机振动', panel: soundsPanel },
  { id: 'notify', label: '通知', icon: 'msg_information', note: '手机通知、安装为应用', panel: notifyPanel },
  { id: 'google', label: 'Google 账户', icon: 'key_world', note: '日历、任务、云端硬盘、提醒到手机', panel: googlePanel },
  { id: 'mail', label: '邮箱', icon: 'outlook_express', note: '收信的邮箱、签名、推荐文献按什么判断', panel: mailPanel },
  { id: 'literature', label: '文献推送设置', icon: 'catalog', note: '文献来源的 key、联系邮箱、每日推送', panel: litPanel },
];
export const items = () => ITEMS.map(({ id, label, icon: ic, note }) => ({ id, label, icon: ic, note }));

let app = null;
export function open(id, arg) {
  if (id === 'computers') return infra.open({ tab: 'agents' });
  if (id === 'fleet') return infra.open({ tab: 'fleet' });
  if (id === 'ai') return aiHub.open({ tab: 'models', sec: arg });
  if (id === 'skills') {
    if (arg === 'machines') return infra.open({ tab: 'compute' });
    if (arg === 'fleet') return infra.open({ tab: 'fleet' });
    if (arg === 'pools') return aiHub.open({ tab: 'models' });
    return aiHub.open({ tab: 'skills', sub: arg || 'skills' });
  }
  if (id === 'mcp') return aiHub.open({ tab: 'mcp' });
  if (id === 'opencode') return aiHub.open({ tab: 'clients', sec: 'opencode' });
  if (id === 'apis') return aiHub.open({ tab: 'clients', sec: 'apis' });
  if (id === 'knowledge') return openKnowledge(arg);

  if (!app) {
    app = mount();
    wm.open({ id: 'control', title: '控制面板', icon: icon('directory_control_panel', true), content: app.root, width: 820, height: 600,
      onClose: () => { app.destroy(); app = null; } });
  } else wm.open({ id: 'control' });
  if (id) app.show(id, arg); else app.home();
}

function mount() {
  const nav = h('div', { class: 'cp-nav' });
  const pane = h('div', { class: 'cp-pane' });
  const back = h('button', { class: 'btn cp-back', type: 'button', text: '‹ 控制面板', onclick: () => home() });
  const title = h('b', { class: 'cp-title' });
  const root = h('div', { class: 'cp' }, nav, h('div', { class: 'cp-main' }, h('div', { class: 'cp-head' }, back, title), pane));
  backnav.pane(root, 'picked', () => back.click());
  let cur = null;

  const itemBtns = ITEMS.map((it) => h('button', { class: 'cp-item', type: 'button', dataset: { id: it.id }, title: it.note, onclick: () => show(it.id) },
    h('img', { src: icon(it.icon), alt: '' }), h('span', { class: 'cp-l', text: it.label }), h('small', { text: it.note })));

  const hubLinks = h('div', { class: 'cp-hub-links', style: 'margin-top:auto;padding:8px 6px;border-top:1px solid var(--edge);font-size:11.5px;display:flex;flex-direction:column;gap:4px' },
    h('small', { class: 'ghint', style: 'margin:0', text: '硬件与 AI 配置已收口至独立中心：' }),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('button', { class: 'btn', type: 'button', style: 'font-size:11px;padding:1px 6px', text: '↗ 设备与算力', onclick: () => infra.open() }),
      h('button', { class: 'btn', type: 'button', style: 'font-size:11px;padding:1px 6px', text: '↗ AI 与额度', onclick: () => aiHub.open() })
    )
  );

  nav.replaceChildren(...itemBtns, hubLinks);

  function close() { if (cur && cur.panel.destroy) try { cur.panel.destroy(); } catch {} cur = null; }
  function show(id, arg) {
    const it = ITEMS.find((x) => x.id === id) || ITEMS[0];
    if (cur && cur.id === it.id) { if (cur.panel.show) cur.panel.show(arg); root.classList.add('picked'); return; }
    close();
    const panel = it.panel(arg) || {};
    cur = { id: it.id, panel };
    pane.replaceChildren(panel.root || h('p', { text: '（空）' }));
    pane.scrollTop = 0;
    title.textContent = it.label;
    for (const b of itemBtns) b.classList.toggle('sel', b.dataset.id === it.id);
    root.classList.add('picked');
    const w = wm.get('control'); if (w && w.handle) w.handle.setTitle('控制面板 - ' + it.label);
  }
  function home() {
    root.classList.remove('picked');
    if (root.classList.contains('narrow')) { const w = wm.get('control'); if (w && w.handle) w.handle.setTitle('控制面板'); }
    if (!cur && !root.classList.contains('narrow')) show(ITEMS[0].id);
  }
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 600));
  ro.observe(root);
  return { root, show, home, destroy() { close(); ro.disconnect(); } };
}
