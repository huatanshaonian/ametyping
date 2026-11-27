// Ame typing pet — main process orchestrator.
// Global keyboard hook -> renderer. Only keycodes are forwarded; nothing is logged or stored.
'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { uIOhook } = require('uiohook-napi');
const bridge = require('./bridge');
const { createMorning } = require('./morning');
const { createMailNotice } = require('./mail-notice');
const { createQuotaNotice } = require('./quota-notice');
const { adoptRunning } = require('./session-adopt');
const { CLAUDE_EXE, TERM_HOSTS } = require('./session-locate');
const { update } = require('./update');
const { createPanelAndGestures } = require('./main-gestures');
const { createSessionRuntime } = require('./main-sessions');
const { createDemoRunner } = require('./main-demo');

const VX = 190, ART_W = 1060;
const artH = () => (settings.legs === false ? 1080 : 1190);
const SCALES = { 小: 0.28, 中: 0.36, 大: 0.46 };

let win = null, tray = null;
if (process.env.AME_PROFILE) app.setPath('userData', process.env.AME_PROFILE);
const PORT = +process.env.AME_PORT || 3940;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const settings = {
  scale: 0.36, x: null, y: null, clickThrough: false, debug: false,
  facing: 'her', panelMode: 'popup', remoteControl: false,
  dashboardUrl: 'https://win98.huatan.org', petSound: true, kangel: false,
};
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, ''))); } catch {}
const save = () => {
  if (process.env.AME_DEMO_PANEL || process.env.AME_DEMO_PCHAN) return;
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch {}
};

const cfg = () => ({
  scale: settings.scale,
  debug: settings.debug,
  facing: settings.facing,
  kbTheme: settings.kbTheme || 'ngo',
  breakNag: settings.breakNag !== false,
  kangel: !!settings.kangel,
  legs: settings.legs !== false,
  touchMode: !!settings.touchMode,
});

function winSize() {
  return { width: Math.round(ART_W * settings.scale), height: Math.round(artH() * settings.scale) };
}

let runtime = null;
let morning = null, mailNotice = null, quotaNotice = null;

const ui = createPanelAndGestures({
  app,
  BrowserWindow,
  ipcMain,
  screen,
  settings,
  save,
  ART_W,
  winSize,
  setScale: (s, commit) => setScale(s, commit),
  buildMenu: () => buildMenu(),
  bridge,
  getWin: () => win,
  getSessions: () => (runtime ? runtime.sessions : new Map()),
  onPushBubble: (id) => runtime && runtime.pushBubble(id),
});

runtime = createSessionRuntime({
  app,
  ipcMain,
  screen,
  port: PORT,
  settings,
  bridge,
  getWin: () => win,
  getBubbleWin: ui.getBubbleWin,
  chatMode: ui.chatMode,
  folded: ui.folded,
  placeBubble: ui.placeBubble,
  hideBubble: ui.hideBubble,
  sendPanel: ui.sendPanel,
  keepAmeOnTop: ui.keepAmeOnTop,
  morning: () => morning,
  mailNotice: () => mailNotice,
  quotaNotice: () => quotaNotice,
});

morning = createMorning({
  app, BrowserWindow, ipcMain, screen,
  anchor: () => (win && !win.isDestroyed() ? win.getBounds() : null),
  enabled: () => settings.morningBubble !== false,
  dashboardUrl: () => settings.dashboardUrl,
  openExternal: (u) => shell.openExternal(u),
});
mailNotice = createMailNotice({
  BrowserWindow, ipcMain, screen,
  anchor: () => (win && !win.isDestroyed() ? win.getBounds() : null),
  enabled: () => settings.mailBubble !== false,
  dashboardUrl: () => settings.dashboardUrl,
  openExternal: (u) => shell.openExternal(u),
});
quotaNotice = createQuotaNotice({
  app, BrowserWindow, ipcMain, screen,
  anchor: () => (win && !win.isDestroyed() ? win.getBounds() : null),
  dashboardUrl: () => settings.dashboardUrl,
  openExternal: (u) => shell.openExternal(u),
});

const touchOn = () => !!settings.touchMode && !settings.clickThrough;
function applyClickThrough() {
  if (!win) return;
  if (touchOn()) win.setIgnoreMouseEvents(false);
  else { win.setShape([]); win.setIgnoreMouseEvents(true, { forward: true }); }
}

ipcMain.on('hit', (_e, v) => {
  if (win && !settings.clickThrough && !touchOn()) win.setIgnoreMouseEvents(!v, { forward: true });
});
ipcMain.on('shape', (e, rects) => {
  if (!win || e.sender !== win.webContents) return;
  const ok = touchOn() && Array.isArray(rects) && rects.length <= 800 && rects.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite));
  win.setShape(ok ? rects.map(([x, y, width, height]) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })) : []);
});

function setScale(s, commit = true) {
  settings.scale = s;
  if (!win || win.isDestroyed()) return;
  const { width, height } = winSize();
  const b = win.getBounds();
  const c = ui.clampToScreen(b.x, b.y, width, height);
  win.setBounds({ x: c.x, y: c.y, width, height });
  win.webContents.send('config', cfg());
  if (commit) { save(); buildMenu(); }
}
ipcMain.on('set-scale', (_e, s, commit) => { if (win) setScale(s, commit); });

function openDashboard() {
  const u = String(settings.dashboardUrl || '');
  if (/^https:\/\/\S+$/.test(u)) shell.openExternal(u);
}
ipcMain.on('open-dashboard', (e) => { if (win && e.sender === win.webContents) openDashboard(); });

function createWindow() {
  const { width, height } = winSize();
  const wa = screen.getPrimaryDisplay().workArea;
  const c0 = ui.clampToScreen(settings.x ?? wa.x + wa.width - width - 24, settings.y ?? wa.y + wa.height - height, width, height);
  win = new BrowserWindow({
    width, height, x: c0.x, y: c0.y,
    transparent: true, frame: false, resizable: false, thickFrame: false,
    hasShadow: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile('index.html');
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 2) return;
    try {
      const f = path.join(app.getPath('userData'), 'renderer.log');
      if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.unlinkSync(f);
      fs.appendFileSync(f, `${new Date().toISOString()} ${message} (${path.basename(source || '')}:${line})\n`);
    } catch {}
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', cfg());
    ui.sendPanel();
  });
  win.on('move', () => ui.placeBubble());
  win.on('resize', () => ui.placeBubble());
  win.on('moved', () => { const [px, py] = win.getPosition(); settings.x = px; settings.y = py; save(); });
  applyClickThrough();
}

let updating = false;
async function runUpdate() {
  if (updating) return;
  updating = true; buildMenu(); tray.setToolTip('糖糖敲键盘 · 正在更新…');
  let r;
  try { r = await update(path.resolve(__dirname, '..')); } catch (e) { r = { ok: false, msg: '更新出错', detail: String((e && e.message) || e) }; }
  updating = false; buildMenu(); tray.setToolTip('糖糖敲键盘');
  if (!r.ok || !r.changed) {
    return void dialog.showMessageBox({ type: r.ok ? 'info' : 'warning', title: '糖糖 · 检查更新', message: r.msg, detail: r.detail || '', buttons: ['好'] });
  }
  await dialog.showMessageBox({ type: 'info', title: '糖糖 · 检查更新', message: r.msg + '，现在重启糖糖', detail: (r.detail ? r.detail + '\n\n' : '') + '（正在等你确认的权限卡片会回到终端里问）', buttons: ['重启'] });
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '大小', submenu: Object.entries(SCALES).map(([k, v]) => ({
      label: k, type: 'radio', checked: Math.abs(settings.scale - v) < 1e-3, click: () => setScale(v) })) },
    { label: '键盘朝向', submenu: [['her', '朝她（真实对坐）'], ['you', '朝你（布局和你的键盘一样）']].map(([v, l]) => ({
      label: l, type: 'radio', checked: settings.facing === v,
      click: () => { settings.facing = v; save(); win.webContents.send('config', cfg()); } })) },
    { label: '面板模式', submenu: [['popup', '弹出进度（有动静时弹出）'], ['chat', '常驻对话（完整对话 + 回复）'], ['pchan', 'P 酱（收成 P 酱，有动静它会跳，点它看面板）'], ['off', '关闭（不弹出面板）']].map(([v, l]) => ({
      label: l, type: 'radio', checked: settings.panelMode === v, click: () => ui.setPanelMode(v) })) },
    { label: '键帽主题', submenu: [['ngo', 'NGO 主题'], ['default', '默认']].map(([v, l]) => ({
      label: l, type: 'radio', checked: (settings.kbTheme || 'ngo') === v,
      click: () => { settings.kbTheme = v; save(); win.webContents.send('config', cfg()); } })) },
    { label: '允许远程控制（看板回复 / 审批）', type: 'checkbox', checked: !!settings.remoteControl,
      click: (m) => { settings.remoteControl = m.checked; save(); } },
    { label: '提示音', type: 'checkbox', checked: settings.petSound !== false,
      click: (m) => { settings.petSound = m.checked; save(); runtime.pushBubble(null); } },
    { label: '早安日报（每天第一次打字时说昨天做了什么）', type: 'checkbox', checked: settings.morningBubble !== false,
      click: (m) => { settings.morningBubble = m.checked; save(); if (!m.checked) morning.hide(); } },
    { label: '邮件提醒气泡（要办的通知、推荐文献）', type: 'checkbox', checked: settings.mailBubble !== false,
      click: (m) => { settings.mailBubble = m.checked; save(); if (!m.checked) mailNotice.hide(); } },
    { label: '鼠标穿透', type: 'checkbox', checked: settings.clickThrough,
      click: (m) => { settings.clickThrough = m.checked; save(); applyClickThrough(); } },
    { label: '触屏模式（手指能直接拖她、点她）', type: 'checkbox', checked: !!settings.touchMode,
      click: (m) => { settings.touchMode = m.checked; save(); applyClickThrough(); win.webContents.send('config', cfg()); } },
    { label: '休息提醒', type: 'checkbox', checked: settings.breakNag !== false,
      click: (m) => { settings.breakNag = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '显示腿部（跪坐全身）', type: 'checkbox', checked: settings.legs !== false,
      click: (m) => { settings.legs = m.checked; setScale(settings.scale); } },
    { label: '天使模式（常驻）', type: 'checkbox', checked: !!settings.kangel,
      enabled: fs.existsSync(path.join(__dirname, 'assets', 'rig', 'kangel', 'kangel.js')),
      click: (m) => { settings.kangel = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '调试信息', type: 'checkbox', checked: settings.debug,
      click: (m) => { settings.debug = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }).openAtLogin,
      enabled: app.isPackaged,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }) },
    { label: '回到右下角', click: () => {
      const wa = screen.getPrimaryDisplay().workArea, { width, height } = winSize();
      win.setPosition(wa.x + wa.width - width - 24, wa.y + wa.height - height); } },
    { type: 'separator' },
    { label: updating ? '正在更新…' : '检查更新（拉取最新代码并重启）', enabled: !app.isPackaged && !updating, click: runUpdate },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

const runDemo = createDemoRunner({
  app,
  screen,
  ipcMain,
  getWin: () => win,
  getBubbleWin: ui.getBubbleWin,
  settings,
  cfg,
  VX,
  setScale,
  setPanelMode: ui.setPanelMode,
  onClaudeEvent: runtime.onClaudeEvent,
  folded: ui.folded,
  save,
});

if (!process.env.AME_DEMO && !app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  createWindow();
  const bubbleWin = ui.createBubble();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('糖糖敲键盘');
  buildMenu();
  if (ui.chatMode()) {
    bridge.start();
    bubbleWin.webContents.once('did-finish-load', () => {
      runtime.pushBubble(null);
      ui.placeBubble();
      bubbleWin.showInactive();
    });
  }

  if (process.env.AME_DEMO) return runDemo(process.env.AME_DEMO);
  setTimeout(() => adoptRunning({
    sessions: runtime.sessions,
    bridge,
    home: app.getPath('home'),
    isClaude: (n) => CLAUDE_EXE.test(n),
    isTerminal: (n) => TERM_HOSTS.test(n),
    onChange: () => runtime.pushBubble(null),
  }).catch((e) => console.error('adopt:', e.message)), 1500);

  uIOhook.on('keydown', (e) => { if (win) win.webContents.send('key', { code: e.keycode, down: true }); morning.onKey(); mailNotice.onKey(); });
  uIOhook.on('keyup', (e) => win && win.webContents.send('key', { code: e.keycode, down: false }));
  uIOhook.on('mouseup', () => { if (!ui.isTouchGestureActive()) ui.endGesture(); ui.endPanelResize(); });
  uIOhook.start();
});

// Cursor position for her gaze, in art-space units relative to the window
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  win.webContents.send('mouse', { x: (p.x - b.x) / settings.scale + VX, y: (p.y - b.y) / settings.scale });
}, 50);

app.on('will-quit', () => { try { uIOhook.stop(); } catch {} bridge.stop(); });
app.on('window-all-closed', () => app.quit());
