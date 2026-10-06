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
import * as computers from './apps/computers.js';
import * as reports from './apps/reports.js';
import * as todo from './apps/todo.js';
import * as notepad from './apps/notepad.js';
import * as calendar from './apps/calendar.js';
import * as google from './apps/google.js';
import * as mail from './apps/mail.js';
import * as literature from './apps/literature.js';
import * as control from './apps/control.js';
import * as sound from './sound.js';
import * as push from './push.js';
import * as shade from './shade.js';
import * as backnav from './backnav.js';
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
  { id: 'reports', label: '工作日报', icon: icon('history'), open: reports.open, hint: '每天早上自动总结前一天做了什么' },
  { id: 'notepad', label: '记事本', icon: icon('notepad'), open: notepad.open, hint: '存在群晖上的笔记' },
  { id: 'calendar', label: '日历', icon: icon('calendar'), open: calendar.open, hint: '每天的日报、到期的重要计划、Google 日历' },
  { id: 'mail', label: '邮件', icon: icon('outlook_express'), open: () => mail.open(), hint: '邮箱的信收在群晖上：列表、全文、附件名' },
  { id: 'literature', label: '文献', icon: icon('help_book_big'), open: () => literature.open(), hint: '每日文献推送、卡片、深读和知识库（连着群晖上的 Zotero）' },
  { id: 'control', label: '控制面板', icon: icon('directory_control_panel'), open: () => control.open(), hint: '显示、声音、电脑、Google、邮箱、AI 模型等所有设置' },
];
desktop.setIcons(APPS);
taskbar.setMenu([
  ...APPS.map((a) => ({ icon: a.icon, label: a.label, action: a.open })),
  { icon: icon('sched_task'), label: '重要计划', action: todo.open },
  { icon: icon('network_normal_two_pcs'), label: '网上邻居', action: () => netpanel.toggle(true) },
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
// 我的电脑's computer list: as picking it here, then its 我的电脑
explorer.setSwitch((name) => { selectMachine(name); openMyComputer(); });
document.getElementById('addpc').addEventListener('click', (e) => { e.stopPropagation(); computers.open(); });

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
todo.initWidget(document.getElementById('desktop'));        // 重要计划, pinned to the desktop
// a phone's back gesture: each window on screen is a level; back puts the one in front away (to the taskbar)
wm.onChange((list) => backnav.level('windows', list.filter((w) => !w.minimized).length));
backnav.step(() => { const l = wm.list().filter((w) => !w.minimized); const w = l.find((x) => x.active) || l[l.length - 1]; if (!w) return false; wm.minimize(w.id); return true; }, 0);
shade.start();                                   // 色调 / 夜灯: in force now, looked at again as the day goes
net.connect();
openDashboard();
// #report=<date | week-date | draft>: opened from the pet's morning bubble -- show that report (then forget the link)
{
  const m = /^#report=(draft|week-\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$/.exec(location.hash);
  if (m) { reports.open(m[1]); history.replaceState(null, '', location.pathname); }
  // #mail=<key>: from a mail alert (Google Calendar, 糖糖's bubble) -- that message
  const ml = /^#mail=([\w%:.-]+)$/.exec(location.hash);
  if (ml) { mail.open(decodeURIComponent(ml[1])); history.replaceState(null, '', location.pathname); }
  // #lit: the day's papers (糖糖's morning bubble)
  if (location.hash === '#lit') { literature.open('feed'); history.replaceState(null, '', location.pathname); }
  // back from Google's consent screen (google/index.js handleCallback)
  const g = /^#google=(ok|fail)$/.exec(location.hash);
  if (g) { google.open(g[1] === 'ok' ? '已连接 Google。' : '没能连接 Google，请再试一次。'); history.replaceState(null, '', location.pathname); }
}
// the installable app and phone notifications (js/push.js); a notification's link opens that session / message
push.start();
push.route({ s: (machine, id) => dashboard.openSession(machine, id), mail: (key) => mail.open(key) });
// just logged in (the login page leaves a mark): the start-up sound, once
try { if (sessionStorage.getItem('ame.fresh')) { sessionStorage.removeItem('ame.fresh'); sound.play('startup'); } } catch {}
