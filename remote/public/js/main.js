// Desktop boot: connection, wallpaper, the current computer (network panel), desktop icons, start menu, and the
// dashboard window. The file explorer ("我的电脑") and launching Claude come in later steps.
import { h, icon, prefs } from './util.js';
import * as net from './net.js';
import * as wm from './wm.js';
import * as taskbar from './taskbar.js';
import * as desktop from './desktop.js';
import * as netpanel from './netpanel.js';
import * as wallpaper from './wallpaper.js';
import * as dashboard from './apps/dashboard.js';

let current = prefs.get('machine', null);          // the computer whose desktop is shown

const openDashboard = () => dashboard.open(current);
function openMyComputer() {
  wm.open({ id: 'mycomputer', title: '我的电脑', icon: icon('computer_explorer', true), width: 420, height: 220,
    content: h('div', { class: 'notice' }, h('b', { text: current || '（没有选中的电脑）' }), h('br'),
      '浏览这台电脑的文件会在下一步加入：文件夹、Markdown（连同里面的图片）、图片和文本预览。') });
}

const APPS = [
  { id: 'dashboard', label: '糖糖看板', icon: '/asset/icon256.png', open: openDashboard },
  { id: 'mycomputer', label: '我的电脑', icon: icon('computer_explorer'), open: openMyComputer, hint: '文件浏览（下一步加入）' },
  { id: 'display', label: '显示属性', icon: icon('display_properties'), open: wallpaper.openSettings },
];
desktop.setIcons(APPS);
taskbar.setMenu([
  ...APPS.map((a) => ({ icon: a.icon, label: a.label, action: a.open })),
  { icon: icon('network_normal_two_pcs'), label: '网上邻居', action: () => netpanel.toggle(true) },
  'sep',
  { icon: icon('key_win'), label: '注销', action: net.logout },
]);

function selectMachine(name) {
  current = name; prefs.set('machine', name);
  render();
  dashboard.setCurrent(name);
}
netpanel.init(selectMachine);

function render() {
  const machines = net.state.sessions;
  if (!machines.find((m) => m.machine === current)) {
    const pick = machines.find((m) => m.online) || machines[0];
    current = pick ? pick.machine : null;
  }
  netpanel.render(machines, current);
  const m = machines.find((x) => x.machine === current);
  if (!m) return desktop.setMark('', '没有电脑');
  const c = netpanel.summary(m);
  desktop.setMark(m.machine, m.online ? `在线 · ${c.live} 个会话${c.working ? ` · ${c.working} 个进行中` : ''}${c.perms ? ` · ${c.perms} 个待确认` : ''}` : '离线');
}
net.on('sessions', render);

wallpaper.init();
net.connect();
openDashboard();
