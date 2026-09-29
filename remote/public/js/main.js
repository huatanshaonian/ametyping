// Desktop boot: connection, wallpaper, the current computer (network panel), desktop icons, start menu, and the
// dashboard window, the file explorer ("我的电脑"). Launching Claude from a folder comes in the next step.
import { h, icon, prefs } from './util.js';
import * as net from './net.js';
import * as wm from './wm.js';
import * as taskbar from './taskbar.js';
import * as desktop from './desktop.js';
import * as netpanel from './netpanel.js';
import * as wallpaper from './wallpaper.js';
import * as dashboard from './apps/dashboard.js';
import * as explorer from './apps/explorer.js';
import * as sounds from './apps/sounds.js';
import * as sound from './sound.js';
import './alerts.js';
import './volume.js';

let current = prefs.get('machine', null);          // the computer whose desktop is shown

const openDashboard = () => dashboard.open(current);
// the current computer's files; explain instead when it cannot be browsed
function openMyComputer() {
  const m = net.state.sessions.find((x) => x.machine === current);
  if (m && m.files) return explorer.open(current);
  const why = !m ? '还没有选中的电脑。' : !m.online ? '这台电脑现在离线。' : '这台电脑没开放文件浏览：在它的 agent.json 里加上 "files"（例如 { "roots": ["/home/你"] }）并重启 agent。';
  wm.open({ id: 'mycomputer-off', title: '我的电脑', icon: icon('computer_explorer', true), width: 420, height: 200,
    content: h('div', { class: 'notice' }, h('b', { text: current || '' }), h('br'), why) });
}

const APPS = [
  { id: 'dashboard', label: '糖糖看板', icon: '/asset/icon256.png', open: openDashboard },
  { id: 'mycomputer', label: '我的电脑', icon: icon('computer_explorer'), open: openMyComputer, hint: '浏览这台电脑的文件' },
  { id: 'display', label: '显示属性', icon: icon('display_properties'), open: wallpaper.openSettings },
];
desktop.setIcons(APPS);
taskbar.setMenu([
  ...APPS.map((a) => ({ icon: a.icon, label: a.label, action: a.open })),
  { icon: icon('network_normal_two_pcs'), label: '网上邻居', action: () => netpanel.toggle(true) },
  { icon: icon('mixer_sound'), label: '声音', action: sounds.open },
  'sep',
  { icon: icon('key_win'), label: '注销', action: logout },
]);

// 注销: the shut-down sound first (at most a few seconds), then log out
async function logout() {
  await Promise.race([sound.play('shutdown'), new Promise((r) => setTimeout(r, 4500))]);
  net.logout();
}

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
// just logged in (the login page leaves a mark): the start-up sound, once
try { if (sessionStorage.getItem('ame.fresh')) { sessionStorage.removeItem('ame.fresh'); sound.play('startup'); } } catch {}
