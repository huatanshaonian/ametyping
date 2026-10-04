// 控制面板: every setting in one window, each item with the icon it always had -- 显示属性, 声音, 通知, 电脑, Google 账户,
// 邮箱, AI 模型. The list on the left, the chosen item on the right (a narrow window: the icons first, then the item
// with a way back). The items' old open() functions land here, so links elsewhere (the calendar's 「连接 Google」, the
// tray's warnings, 邮件's 设置) open the right page.
//   open(id?, arg?) -- arg goes to the item (Google's message after signing in)
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import { settingsPanel as displayPanel } from '../wallpaper.js';
import { panel as soundsPanel } from './sounds.js';
import { panel as computersPanel } from './computers.js';
import { panel as googlePanel } from './google.js';
import { panel as mailPanel } from './mail-accounts.js';
import { panel as aiPanel } from './ai-models.js';
import { panel as notifyPanel } from './notify.js';

const ITEMS = [
  { id: 'display', label: '显示属性', icon: 'display_properties', note: '壁纸、配色、界面大小', panel: displayPanel },
  { id: 'sounds', label: '声音', icon: 'mixer_sound', note: '系统音效、静音、手机振动', panel: soundsPanel },
  { id: 'notify', label: '通知', icon: 'msg_information', note: '手机通知、安装为应用', panel: notifyPanel },
  { id: 'computers', label: '电脑', icon: 'network_normal_two_pcs', note: '添加 / 移除连到这里的电脑', panel: computersPanel },
  { id: 'google', label: 'Google 账户', icon: 'key_win', note: '日历、任务、云端硬盘、提醒到手机', panel: googlePanel },
  { id: 'mail', label: '邮箱', icon: 'outlook_express', note: '收信的邮箱、签名、推荐文献按什么判断', panel: mailPanel },
  { id: 'ai', label: 'AI 模型', icon: 'chip_ramdrive', note: '每项工作用哪个模型、后备模型、Claude Code / Codex 更新', panel: aiPanel },
];
export const items = () => ITEMS.map(({ id, label, icon: ic, note }) => ({ id, label, icon: ic, note }));

let app = null;
export function open(id, arg) {
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
  let cur = null;                                       // { id, panel: { root, destroy?, show? } }

  nav.replaceChildren(...ITEMS.map((it) => h('button', { class: 'cp-item', type: 'button', dataset: { id: it.id }, title: it.note, onclick: () => show(it.id) },
    h('img', { src: icon(it.icon), alt: '' }), h('span', { class: 'cp-l', text: it.label }), h('small', { text: it.note }))));

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
    for (const b of nav.children) b.classList.toggle('sel', b.dataset.id === it.id);
    root.classList.add('picked');
    const w = wm.get('control'); if (w && w.handle) w.handle.setTitle('控制面板 - ' + it.label);
  }
  // the list of items (a wide window keeps one open beside it)
  function home() {
    root.classList.remove('picked');
    if (root.classList.contains('narrow')) { const w = wm.get('control'); if (w && w.handle) w.handle.setTitle('控制面板'); }
    if (!cur && !root.classList.contains('narrow')) show(ITEMS[0].id);
  }
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 600));
  ro.observe(root);
  return { root, show, home, destroy() { close(); ro.disconnect(); } };
}
