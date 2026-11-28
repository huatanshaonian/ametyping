// Desktop boot: connection, wallpaper, 11 core desktop icons (+ optional extra icons), 4-section cascading start menu,
// network neighbourhood, sticky widgets, global #hash router, and the dashboard window.
import { h, icon, prefs } from './util.js';
import * as net from './net.js';
import * as wm from './wm.js';
import * as taskbar from './taskbar.js';
import * as desktop from './desktop.js';
import * as netpanel from './netpanel.js';
import * as wallpaper from './wallpaper.js';
import * as dashboard from './apps/dashboard.js';
import * as explorer from './apps/explorer.js';
import * as projects from './apps/projects.js';
import * as infra from './apps/infra.js';
import * as aiHub from './apps/ai-hub.js';
import * as magpie from './apps/magpie.js';
import * as reports from './apps/reports.js';
import * as todo from './apps/todo.js';
import * as approveWidget from './apps/approve-widget.js';
import * as notepad from './apps/notepad.js';
import * as officeApps from './apps/office-apps.js';
import * as board from './apps/board.js';
import * as calendar from './apps/calendar.js';
import * as mail from './apps/mail.js';
import * as literature from './apps/literature.js';
import * as knowledge from './apps/knowledge.js';
import * as control from './apps/control.js';
import { initDesktopClippy } from './apps/clippy.js';
import * as router from './router.js';
import * as sound from './sound.js';
import * as push from './push.js';
import * as shade from './shade.js';
import * as backnav from './backnav.js';
import './alerts.js';
import './volume.js';

let current = prefs.get('machine', null);          // the computer whose desktop is shown

const openDashboard = () => dashboard.open(current);
// the current computer's files; explain instead when it cannot be browsed
function openMyComputer(targetMachine = current) {
  const mach = targetMachine || current;
  const m = net.state.sessions.find((x) => x.machine === mach);
  if (m && m.files) return explorer.open(mach);
  const why = !m ? '还没有选中的电脑。' : !m.online ? '这台电脑现在离线。' : '这台电脑没开放文件浏览：在它的 agent.json 里加上 "files"（例如 { "roots": ["/home/你"] }）并重启 agent。';
  wm.open({ id: 'mycomputer-off', title: '我的电脑', icon: icon('computer_explorer', true), width: 420, height: 200,
    content: h('div', { class: 'notice' }, h('b', { text: mach || '' }), h('br'), why) });
}

// 11 curated core desktop icons (IA 4-A)
const CORE_APPS = [
  { id: 'dashboard', label: '糖糖看板', icon: '/asset/icon256.png', open: openDashboard, hint: '实时会话监控、审批与回复' },
  { id: 'projects', label: '项目管理', icon: icon('projects'), open: () => projects.open(), hint: '跨机协同拓扑、目标契约、目录结构树与大文件摆渡' },
  { id: 'infra', label: '设备与算力', icon: icon('network_three_pcs'), open: () => infra.open(), hint: '网络拓扑监控、Mini-Slurm 算力作业、Fleet 升级与设备令牌' },
  { id: 'magpie', label: 'AI 与额度', icon: icon('chip_ramdrive'), open: () => aiHub.open(), hint: 'Magpie 实时额度、全局模型池、Skill 与角色库、MCP 与客户端配置' },
  { id: 'literature', label: '文献', icon: icon('catalog'), open: () => literature.open(), hint: '每日文献推送、卡片、深读和知识库（连着群晖上的 Zotero）' },
  { id: 'knowledge', label: '记忆与存档', icon: icon('memory'), open: () => knowledge.open(), hint: '三层统一记忆、对齐与智能整理、完整会话归档与多电脑同步' },
  { id: 'reports', label: '工作日报', icon: icon('history'), open: () => reports.open(), hint: '每天早上自动总结前一天做了什么' },
  { id: 'calendar', label: '日历', icon: icon('calendar'), open: () => calendar.open(), hint: '每天的日报、到期的重要计划、Google 日历' },
  { id: 'mail', label: '邮件', icon: icon('outlook_express'), open: () => mail.open(), hint: '邮箱的信收在群晖上：列表、全文、附件名' },
  { id: 'mycomputer', label: '我的电脑', icon: icon('computer_explorer'), open: () => openMyComputer(), hint: '浏览这台电脑的文件' },
  { id: 'control', label: '控制面板', icon: icon('directory_control_panel'), open: () => control.open(), hint: '显示属性、声音、通知、Google 账户、邮箱与文献推送设置' },
];

const EXTRA_APP_DEFS = {
  todo: { id: 'todo', label: '重要计划', icon: icon('sched_task'), open: () => todo.open(), hint: '计划分类，每个计划下面一条条具体条目' },
  office: { id: 'office', label: 'Office 文档', icon: icon('directory_open_cool'), open: () => officeApps.open('office', () => current), hint: '新建或打开 Word / Excel / PowerPoint 在线文档' },
  notepad: { id: 'notepad', label: '记事本', icon: icon('notepad'), open: notepad.open, hint: '存在群晖上的笔记' },
  board: { id: 'board', label: '画板', icon: icon('paint'), open: board.open, hint: '手写、画图（支持笔的压感），交给 AI 誊清成整齐的页面' },
};

function syncDesktopIcons() {
  const extra = wallpaper.getExtraIcons();
  const list = [...CORE_APPS];
  for (const [key] of wallpaper.EXTRA_ICONS) {
    if (extra[key] && EXTRA_APP_DEFS[key]) list.push(EXTRA_APP_DEFS[key]);
  }
  desktop.setIcons(list);
}
syncDesktopIcons();
wallpaper.onExtraIconsChange(syncDesktopIcons);

// 注销: the shut-down sound first (at most a few seconds), then log out
async function logout() {
  await Promise.race([sound.play('shutdown'), new Promise((r) => setTimeout(r, 4500))]);
  net.logout();
}

// 4-section cascading Start Menu (IA 4-A.B)
taskbar.setMenu([
  // Section 1: 高频工作台
  { icon: '/asset/icon256.png', label: '糖糖看板', action: openDashboard },
  { icon: icon('projects'), label: '项目管理', action: () => projects.open() },
  { icon: icon('catalog'), label: '文献', action: () => literature.open() },
  { icon: icon('memory'), label: '记忆与存档', action: () => knowledge.open() },
  { icon: icon('history'), label: '工作日报', action: () => reports.open() },
  'sep',
  // Section 2: 算力与 AI 底座
  { icon: icon('chip_ramdrive'), label: 'AI 与额度', action: () => aiHub.open() },
  { icon: icon('network_three_pcs'), label: '设备与算力', action: () => infra.open() },
  { icon: icon('computer_explorer'), label: '我的电脑', action: () => openMyComputer() },
  { icon: icon('network_normal_two_pcs'), label: '网上邻居', action: () => netpanel.toggle(true) },
  'sep',
  // Section 3: 日常与办公级联菜单
  {
    icon: icon('calendar'),
    label: '日历与计划',
    sub: [
      { icon: icon('calendar'), label: '日历', action: () => calendar.open() },
      { icon: icon('sched_task'), label: '重要计划', action: () => todo.open() },
    ],
  },
  { icon: icon('outlook_express'), label: '邮件', action: () => mail.open() },
  {
    icon: icon('directory_open_cool'),
    label: '办公与附件',
    sub: [
      { icon: icon('directory_open_cool'), label: 'Office 文档', action: () => officeApps.open('office', () => current) },
      ...Object.entries(officeApps.APPS).map(([k, a]) => ({ icon: icon(k), label: a.label, action: () => officeApps.open(k, () => current), hint: a.hint })),
      'sep',
      { icon: icon('notepad'), label: '记事本', action: notepad.open },
      { icon: icon('paint'), label: '画板', action: board.open },
    ],
  },
  {
    icon: icon('directory_control_panel'),
    label: '控制面板',
    action: () => control.open(),
    sub: control.items().map((it) => ({ icon: icon(it.icon), label: it.label, action: () => control.open(it.id), hint: it.note })),
  },
  'sep',
  // Section 4: 注销
  { icon: icon('key_win'), label: '注销', action: logout },
]);

function selectMachine(name) {
  current = name; prefs.set('machine', name);
  render();
  dashboard.setCurrent(name);
}
netpanel.init(selectMachine, {
  openMyComputer: (mach) => openMyComputer(mach),
  openTopo: (mach) => infra.open({ tab: 'topo', node: mach }),
  openFleet: (mach) => infra.open({ tab: 'fleet', machine: mach }),
});
// 我的电脑's computer list: as picking it here, then its 我的电脑
explorer.setSwitch((name) => { selectMachine(name); openMyComputer(name); });
document.getElementById('addpc').addEventListener('click', (e) => { e.stopPropagation(); infra.open({ tab: 'agents' }); });

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
const widgets = h('div', { id: 'desktopwidgets' });
document.getElementById('desktop').append(widgets);
todo.initWidget(widgets);
magpie.initWidget(widgets);
approveWidget.initWidget(widgets);
initDesktopClippy();
// a phone's back gesture: each window on screen is a level; back puts the one in front away (to the taskbar)
wm.onChange((list) => backnav.level('windows', list.filter((w) => !w.minimized).length));
backnav.step(() => { const l = wm.list().filter((w) => !w.minimized); const w = l.find((x) => x.active) || l[l.length - 1]; if (!w) return false; wm.minimize(w.id); return true; }, 0);
shade.start();                                   // 色调 / 夜灯: in force now, looked at again as the day goes
net.connect();
openDashboard();
// Global #hash deep-link router + Service Worker push notification routing
router.init({ current: () => current, selectMachine });
push.start();
push.route((hash) => router.handleHash(hash));
// just logged in (the login page leaves a mark): the start-up sound, once
try { if (sessionStorage.getItem('ame.fresh')) { sessionStorage.removeItem('ame.fresh'); sound.play('startup'); } } catch {}
