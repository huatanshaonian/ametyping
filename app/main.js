// Ame typing pet — main process.
// Global keyboard hook -> renderer. Only keycodes are forwarded; nothing is logged or stored.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { uIOhook } = require('uiohook-napi');
const bridge = require('./bridge');
const { createRemoteControl } = require('./remote-control');
const { createMorning } = require('./morning');
const { createMailNotice } = require('./mail-notice');
const { adoptRunning } = require('./session-adopt');
const { inTerminal } = require('./session-terminal');
const { lineage } = require('./running-sessions');
const transcript = require('./transcript');
const { createPermissions } = require('./permissions');
const { normalizeSession } = require('./session-source');

const VX = 190, ART_W = 1060;  // visible slice of the art space (see renderer.js)
const artH = () => (settings.legs === false ? 1080 : 1190);   // tray 显示腿部: the knees and stockings below the keyboard need 110 more
const SCALES = { 小: 0.28, 中: 0.36, 大: 0.46 };

let win, tray;
// dev: run a second copy next to the installed one (own settings + single-instance lock, own port)
if (process.env.AME_PROFILE) app.setPath('userData', process.env.AME_PROFILE);
const PORT = +process.env.AME_PORT || 3940;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// panelMode: 'popup' = progress log that pops up and hides again; 'chat' = always-on full conversation + reply box;
//            'off' = never pops up (e.g. when you follow everything on the Windose dashboard); still opens from the tray
// dashboardUrl: the Windose web desktop, opened by double-clicking Ame
// petSound: the panel's chime when a session needs you / finishes (off when the Windose page does the sounds)
// remoteControl: the dashboard may reply / answer permission cards through this pet (remote/agent needs "control": true too)
let settings = { scale: 0.36, x: null, y: null, clickThrough: false, debug: false, facing: 'her', panelMode: 'popup', remoteControl: false, dashboardUrl: 'https://win98.huatan.org', petSound: true, kangel: false };
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^﻿/, ''))); } catch {}
const save = () => { if (process.env.AME_DEMO_PANEL || process.env.AME_DEMO_PCHAN) return; try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch {} };

const cfg = () => ({ scale: settings.scale, debug: settings.debug, facing: settings.facing, kbTheme: settings.kbTheme || 'ngo', breakNag: settings.breakNag !== false, kangel: !!settings.kangel, legs: settings.legs !== false });

function winSize() {
  return { width: Math.round(ART_W * settings.scale), height: Math.round(artH() * settings.scale) };
}

function createWindow() {
  const { width, height } = winSize();
  const wa = screen.getPrimaryDisplay().workArea;
  const c0 = clampToScreen(settings.x ?? wa.x + wa.width - width - 24, settings.y ?? wa.y + wa.height - height, width, height);
  const x = c0.x, y = c0.y;
  win = new BrowserWindow({
    width, height, x, y,
    transparent: true, frame: false, resizable: false, thickFrame: false,
    hasShadow: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile('index.html');
  // renderer errors -> %APPDATA%/AmeTyping/renderer.log (kept small), for diagnosing blank / broken frames
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 2) return;
    try {
      const f = path.join(app.getPath('userData'), 'renderer.log');
      if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.unlinkSync(f);
      fs.appendFileSync(f, `${new Date().toISOString()} ${message} (${path.basename(source || '')}:${line})` + String.fromCharCode(10));
    } catch {}
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', cfg());
    sendPanel();
  });
  win.on('move', () => placeBubble());
  win.on('resize', () => placeBubble());
  win.on('moved', () => { const [px, py] = win.getPosition(); settings.x = px; settings.y = py; save(); });
  applyClickThrough();
}

// The window ignores the mouse by default (clicks fall through transparent areas); the renderer
// switches it on only while the cursor is over an opaque pixel. "鼠标穿透" keeps it off entirely.
function applyClickThrough() {
  if (win) win.setIgnoreMouseEvents(true, { forward: true });
}
ipcMain.on('hit', (_e, v) => {
  if (win && !settings.clickThrough) win.setIgnoreMouseEvents(!v, { forward: true });
});

// keep the whole window inside the work area of the display it is on
function clampToScreen(x, y, w, h) {
  const d = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  return { x: Math.round(Math.max(d.x, Math.min(d.x + d.width - w, x))), y: Math.round(Math.max(d.y, Math.min(d.y + d.height - h, y))) };
}

function setScale(s, commit = true) {
  settings.scale = s;
  const { width, height } = winSize();
  const b = win.getBounds();
  const c = clampToScreen(b.x, b.y, width, height);
  win.setBounds({ x: c.x, y: c.y, width, height });      // top-left stays put (unless it would leave the screen)
  win.webContents.send('config', cfg());
  if (commit) { save(); buildMenu(); }
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '大小', submenu: Object.entries(SCALES).map(([k, v]) => ({
      label: k, type: 'radio', checked: Math.abs(settings.scale - v) < 1e-3, click: () => setScale(v) })) },
    { label: '键盘朝向', submenu: [['her', '朝她（真实对坐）'], ['you', '朝你（布局和你的键盘一样）']].map(([v, l]) => ({
      label: l, type: 'radio', checked: settings.facing === v,
      click: () => { settings.facing = v; save(); win.webContents.send('config', cfg()); } })) },
    { label: '面板模式', submenu: [['popup', '弹出进度（有动静时弹出）'], ['chat', '常驻对话（完整对话 + 回复）'], ['pchan', 'P 酱（收成 P 酱，有动静它会跳，点它看面板）'], ['off', '关闭（不弹出面板）']].map(([v, l]) => ({
      label: l, type: 'radio', checked: settings.panelMode === v, click: () => setPanelMode(v) })) },
    { label: '键帽主题', submenu: [['ngo', 'NGO 主题'], ['default', '默认']].map(([v, l]) => ({
      label: l, type: 'radio', checked: (settings.kbTheme || 'ngo') === v,
      click: () => { settings.kbTheme = v; save(); win.webContents.send('config', cfg()); } })) },
    { label: '允许远程控制（看板回复 / 审批）', type: 'checkbox', checked: !!settings.remoteControl,
      click: (m) => { settings.remoteControl = m.checked; save(); } },
    { label: '提示音', type: 'checkbox', checked: settings.petSound !== false,
      click: (m) => { settings.petSound = m.checked; save(); pushBubble(null); } },
    { label: '早安日报（每天第一次打字时说昨天做了什么）', type: 'checkbox', checked: settings.morningBubble !== false,
      click: (m) => { settings.morningBubble = m.checked; save(); if (!m.checked) morning.hide(); } },
    { label: '邮件提醒气泡（要办的通知、推荐文献）', type: 'checkbox', checked: settings.mailBubble !== false,
      click: (m) => { settings.mailBubble = m.checked; save(); if (!m.checked) mailNotice.hide(); } },
    { label: '鼠标穿透', type: 'checkbox', checked: settings.clickThrough,
      click: (m) => { settings.clickThrough = m.checked; save(); applyClickThrough(); } },
    { label: '休息提醒', type: 'checkbox', checked: settings.breakNag !== false,
      click: (m) => { settings.breakNag = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '显示腿部（跪坐全身）', type: 'checkbox', checked: settings.legs !== false,
      click: (m) => { settings.legs = m.checked; setScale(settings.scale); } },   // the window grows / shrinks at the bottom
    { label: '天使模式（常驻）', type: 'checkbox', checked: !!settings.kangel,
      enabled: fs.existsSync(path.join(__dirname, 'assets', 'rig', 'kangel', 'kangel.js')),   // only when the art is installed
      click: (m) => { settings.kangel = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '调试信息', type: 'checkbox', checked: settings.debug,
      click: (m) => { settings.debug = m.checked; save(); win.webContents.send('config', cfg()); } },
    { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }).openAtLogin,
      enabled: app.isPackaged,                     // only the packaged exe registers itself
      // the portable exe unpacks to a temp folder each run: register the real .exe, not the temp copy
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath }) },
        { label: '回到右下角', click: () => {
      const wa = screen.getPrimaryDisplay().workArea, { width, height } = winSize();
      win.setPosition(wa.x + wa.width - width - 24, wa.y + wa.height - height); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

if (!process.env.AME_DEMO && !app.requestSingleInstanceLock()) app.quit();   // only one Ame at a time

app.whenReady().then(() => {
  createWindow();
  createBubble();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('糖糖敲键盘');
  buildMenu();
  if (chatMode()) {
    bridge.start();                          // warm up: the first hook event needs the process lookup fast
    bubbleWin.webContents.once('did-finish-load', () => { pushBubble(null); placeBubble(); bubbleWin.showInactive(); });
  }

  if (process.env.AME_DEMO) return runDemo(process.env.AME_DEMO);
  // Claude Code sessions already open (the pet was restarted, the computer woke up): on the list at once
  setTimeout(() => adoptRunning({ sessions, bridge, home: app.getPath('home'), isClaude: (n) => CLAUDE_EXE.test(n), isTerminal: (n) => TERM_HOSTS.test(n),
    onChange: () => pushBubble(null) }).catch((e) => console.error('adopt:', e.message)), 1500);
  uIOhook.on('keydown', (e) => { if (win) win.webContents.send('key', { code: e.keycode, down: true }); morning.onKey(); mailNotice.onKey(); });
  uIOhook.on('keyup', (e) => win && win.webContents.send('key', { code: e.keycode, down: false }));
  // any mouse release ends a drag / resize, even if the page never saw the pointerup
  uIOhook.on('mouseup', () => { endGesture(); endPanelResize(); });
  uIOhook.start();
});

// Self-test: replay scripted key presses and capture frames into AME_DEMO dir, then quit.
function runDemo(outDir) {
  if (process.env.AME_FACING) { settings.facing = process.env.AME_FACING; win.webContents.send('config', cfg()); }
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [['F', 33], ['J', 36], ['Esc', 1], ['Space', 57], ['Right', 57421], ['Enter', 28], ['Knob', 57392], ['Del', 3667]];
  const send = (code, down) => win.webContents.send('key', { code, down });
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(800);
    if (process.env.AME_DEMO_PANEL) {        // Claude panel: fake sessions, expanded / collapsed (via real clicks) / expanded -> panel_<n>.png (settings are not saved)
      const shot = async (n) => { await wait(500); fs.writeFileSync(path.join(outDir, `panel_${n}.png`), (await bubbleWin.webContents.capturePage()).toPNG()); console.log(n, JSON.stringify(bubbleWin.getBounds())); };
      const rect = (id) => bubbleWin.webContents.executeJavaScript(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
      const click = async ([x, y], n = 1) => { for (let i = 0; i < n; i++) { for (const type of ['mouseDown', 'mouseUp']) bubbleWin.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: i + 1 }); await wait(120); } };
      setPanelMode('popup');
      const ev = (session, project, type, text) => onClaudeEvent(type, { session, project, text });
      ev('a', 'ame-typing', 'message', '给进度面板加折叠按钮'); ev('a', 'ame-typing', 'reading', '读 main.js'); ev('a', 'ame-typing', 'thinking', '想想 placeBubble 怎么改');
      ev('b', 'medstat', 'message', '跑 Table 1'); ev('b', 'medstat', 'waiting', '要不要覆盖旧结果？');
      await shot('1_expanded');
      await click(await rect('fold')); await shot('2_collapsed_by_button');
      ev('a', 'ame-typing', 'reading', '读 bubble.js'); await shot('3_collapsed_new_activity');
      await click(await rect('fold')); await shot('4_expanded_by_button');
      await click(await rect('who'), 2); await shot('5_collapsed_by_dblclick');
      await click(await rect('who'), 2); await shot('6_expanded_by_dblclick');
      return app.quit();
    }
    if (process.env.AME_DEMO_PCHAN) {        // P-chan: sleep / idle / alert (+badge) / hover / click -> panel expands -> pchan_<n>.png (settings are not saved)
      const js = (s) => win.webContents.executeJavaScript(s);
      const shot = async (n, w = win) => { await wait(450); fs.writeFileSync(path.join(outDir, `pchan_${n}.png`), (await w.webContents.capturePage()).toPNG()); console.log(n, JSON.stringify(bubbleWin.getBounds()), bubbleWin.isVisible()); };
      const ev = (session, project, type, text) => onClaudeEvent(type, { session, project, text });
      await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12; pch.blinkAt = 1e12;');
      setScale(0.7, false); win.setPosition(20, 20); await wait(600);
      setPanelMode('pchan'); await shot('1_sleep');
      ev('a', 'ame-typing', 'message', 'demo one'); ev('a', 'ame-typing', 'reading', 'demo two');
      await wait(300); bubbleWin.webContents.send('bubble-collapsed', false); await wait(300); bubbleWin.webContents.send('bubble-collapsed', true); await wait(300);   // the panel has "looked" at session a
      await shot('2_idle');
      await js('pch.blinkAt = 1e12; pch.blinkUntil = now() + 3000;'); await wait(60); await shot('2b_blink');
      await js('pch.blinkAt = 1e12; pch.blinkUntil = 0;');
      ev('b', 'medstat', 'message', 'Table 1'); ev('b', 'medstat', 'waiting', 'overwrite?'); ev('a', 'ame-typing', 'thinking', 'more');
      await wait(400);
      for (const i of [0, 1, 2]) { await shot(`3_alert_${i}`); await wait(330); }
      const c = await js('(() => { const r = pchRect(); return [Math.round((r.x + r.w / 2 - VX) * scale), Math.round((r.y + r.h * 0.6) * scale), pchState(), panel.unread, panel.n]; })()');
      console.log('pchan click point', c);
      const mv = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      mv(c[0], c[1]); await wait(150); mv(c[0] + 1, c[1]); await wait(400); await shot('4_hover');
      for (const type of ['mouseDown', 'mouseUp']) { win.webContents.sendInputEvent({ type, x: c[0], y: c[1], button: 'left', clickCount: 1 }); await wait(100); }
      await wait(600);
      console.log('after click: folded', folded(), 'visible', bubbleWin.isVisible());
      await shot('5_expanded'); await shot('5_expanded_panel', bubbleWin);
      return app.quit();
    }
    if (process.env.AME_DEMO_DRAG) {         // drag self-test: start a drag, log cursor-vs-window offset while an outside script moves the cursor
      ipcMain.emit('gesture', null, 'drag-start');
      const log = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 2600) {
        const p = screen.getCursorScreenPoint(), b = win.getBounds();
        log.push([Date.now() - t0, p.x - b.x, p.y - b.y, b.width, b.height].join(' '));
        await wait(40);
      }
      ipcMain.emit('gesture', null, 'drag-end');
      fs.writeFileSync(path.join(outDir, 'drag.log'), log.join(String.fromCharCode(10)));
      return app.quit();
    }
    if (process.env.AME_DEMO_KB) {           // keyboard alone, large, both facings, no legends
      setScale(1);
      for (const f of ['her', 'you']) {
        settings.facing = f; win.webContents.send('config', cfg());
        await win.webContents.executeJavaScript('kbOnly = true; showLegends = false; kbCache = null;');
        await wait(900);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `kb_${f}.png`), img.toPNG());
      }
      settings.facing = 'her'; settings.scale = 0.36; save();
      return app.quit();
    }
    if (process.env.AME_DEMO_POP) {          // face-change pop: force a face sequence, capture frames right around every change -> pop_<n>_<face>_<i>.png
      const js = (s) => win.webContents.executeJavaScript(s), nl = String.fromCharCode(10), log = [];
      await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
      await wait(700);
      const seq = ['surprised', 'happy', 'teary', 'angry', 'sparkle', 'half', 'neutral', 'BLINK', 'happy', 'sleep', 'neutral'];
      const t0 = Date.now();
      for (let n = 0; n < seq.length; n++) {
        const f = seq[n];
        await js('window.__popU = -1;'); const pre = await win.webContents.capturePage(); fs.writeFileSync(path.join(outDir, `pop_${n}_${f}_pre.png`), pre.toPNG());
        if (f === 'BLINK') await js('mood.blinkAt = 0;');
        else if (f === 'sleep') await js('mood.tempUntil = 0; mood.lastKeyT = performance.now() - 300000; mood.blinkAt = 1e12;');
        else if (f === 'neutral') await js('mood.tempUntil = 0; mood.sleeping = false; mood.lastKeyT = performance.now(); mood.blinkAt = 1e12;');
        else await js(`mood.lastKeyT = performance.now(); setTemp('${f}', 60000); mood.blinkAt = 1e12;`);
        await wait(60);                        // frame the pop with the renderer's clock frozen at fixed phases u = i / 15 (capturePage is too slow for real time)
        for (let i = 0; i < 16; i++) {
          await js(`window.__popU = ${i / 15}`); await wait(110);
          const img = await win.webContents.capturePage();
          log.push(`${n} ${f} ${i} u=${(i / 15).toFixed(2)} ` + await js('[mood.face, mood.open, Math.round(facePop.t0)].join(" ")'));
          fs.writeFileSync(path.join(outDir, `pop_${n}_${f}_${String(i).padStart(2, '0')}.png`), img.toPNG());
        }
        await js('window.__popU = undefined;');
        if (f === 'BLINK') await js('mood.blinkAt = 1e12;');
        await wait(600);
      }
      fs.writeFileSync(path.join(outDir, 'pop_log.txt'), log.join(nl));
      return app.quit();
    }
    if (process.env.AME_DEMO_PAT) {          // stroke her head with a fake cursor, then a happy wiggle + a carry swing
      await win.webContents.executeJavaScript('mood.lastKeyT -= 10000; mood.blinkAt = 1e12; mouseFrozen = true;');
      for (let f = 0; f < 40; f++) {
        const x = 724 + Math.sin(f * 0.9) * 120;
        if (f < 26) await win.webContents.executeJavaScript(`mouse.x = ${x}; mouse.y = 250; mouse.seen = true; detectPat({ x: ${x}, y: 250 });`);
        else if (f === 26) await win.webContents.executeJavaScript('carry.vx = 380; carry.vy = -150;');
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `p_${String(f).padStart(2, '0')}.png`), img.toPNG());
        await wait(50);
      }
      return app.quit();
    }
    if (process.env.AME_DEMO_KANGEL_FACES) { // every face in KAngel form -> k_face_<k>.png
      const js = (s) => win.webContents.executeJavaScript(s);
      await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
      await js('KA.ready && setKForm(true, 0, true)'); await wait(800);
      for (const f of 'blink,half,focus,happy,annoyed,surprised,yandere,sleep,wink,smug,pout,teary,blush,angry,sparkle,dizzy,deadpan,sweat,yawn,sip,stretch'.split(',')) {
        await js(`mood.sleeping = false; mood.lastKeyT = performance.now(); setTemp('${f}', 60000); mood.blinkAt = 1e12;`); await wait(700);
        fs.writeFileSync(path.join(outDir, `k_face_${f}.png`), (await win.webContents.capturePage()).toPNG());
      }
      return app.quit();
    }
    if (process.env.AME_DEMO_KANGEL) {       // KAngel form: typed trigger, flash frames, faces + fallback, back, timed expiry, tray lock
      const js = (s) => win.webContents.executeJavaScript(s);
      const shot = async (name) => fs.writeFileSync(path.join(outDir, `k_${name}.png`), (await win.webContents.capturePage()).toPNG());
      const log = [], nl = String.fromCharCode(10);
      const st = () => js("[KA.ready, KA.on, mood.face, Math.round(now() - KA.flashT), !!RIG.gaze, !!RIG.frontHair, Object.keys(RIG.faces).length].join(' ')");
      const typeWord = async () => { for (const c of [37, 30, 49, 34, 18, 38]) { send(c, true); await wait(40); send(c, false); await wait(60); } };
      const flash = async (tag, n) => { for (let i = 0; i < n; i++) { await shot(`${tag}_${String(i).padStart(2, '0')}`); log.push(`${tag} ${i} ${await st()}`); await wait(25); } };
      await js('window.__noPersist = true; window.__fakeHour = 14; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12; window.__id0 = [img.head, img.torso, img.tailL, RIG.faces, RIG.gaze, RIG.frontHair, RIG.faceTop];');
      await wait(400); await shot('a_before'); log.push('before ' + await st());
      await typeWord(); await flash('b_flash', 14);
      await wait(1900); await shot('c_kangel'); log.push('settled ' + await st());
      for (const f of ['blink', 'happy', 'wink', 'surprised', 'annoyed', 'sleep', 'dizzy', 'sparkle', 'half']) {
        await js(`setTemp('${f}', 60000); mood.blinkAt = 1e12;`); await wait(250); await shot(`d_face_${f}`);
      }
      await js('mood.tempUntil = 0; mood.lastKeyT = performance.now();');
      await typeWord(); await flash('e_back', 10);
      await wait(1900); await shot('f_ame_after'); log.push('back ' + await st());
      log.push('ame identity ' + await js('[img.head, img.torso, img.tailL, RIG.faces, RIG.gaze, RIG.frontHair, RIG.faceTop].every((v, i) => v === window.__id0[i])'));
      await typeWord(); await wait(1500); log.push('typed again ' + await st());
      await js('KA.until = performance.now() + 200;'); await wait(1900); log.push('after timed expiry ' + await st()); await shot('g_expired');
      settings.kangel = true; win.webContents.send('config', cfg()); await wait(1500); log.push('lock on ' + await st());
      await typeWord(); await wait(1200); log.push('lock + typed ' + await st());
      settings.kangel = false; win.webContents.send('config', cfg()); await wait(1500); log.push('lock off ' + await st());
      fs.writeFileSync(path.join(outDir, 'k_log.txt'), log.join(nl));
      return app.quit();
    }
    if (process.env.AME_DEMO_TIME) {         // time-of-day / wellbeing: fake clock hour, work-session length, long absence
      const js = (s) => win.webContents.executeJavaScript(s);
      const shot = async (name) => fs.writeFileSync(path.join(outDir, `t_${name}.png`), (await win.webContents.capturePage()).toPNG());
      await js('window.__noPersist = true; mouseFrozen = true; mood.blinkAt = 1e12; act.next = 1e12;');
      await js('window.__fakeHour = 14; mood.lastKeyT = performance.now() - 10000;');   // control: daytime, 10 s idle
      await wait(500); await shot('day_idle');
      await js('window.__fakeHour = 1; mood.lastKeyT = performance.now() - 10000;');    // 01:00, idle > 5 s -> sleepy
      await wait(500); await shot('late_idle');
      await js('window.__fakeHour = 3; mood.lastKeyT = performance.now() - 10000;');    // 03:00 keeps the yandere face
      await wait(500); await shot('late3_idle');
      await js('window.__fakeHour = 1; mood.lastKeyT = performance.now() - 100000;');   // 01:00, idle 100 s -> asleep (90 s rule)
      await wait(500); await shot('late_sleep');
      await js('window.__fakeHour = undefined; mood.lastKeyT = performance.now(); mood.sleeping = false; mood.tempUntil = 0;');
      for (let i = 0; i < 6; i++) {            // every nag line: bubble layout check
        await js(`fakeSession(95); work.nextNag = 1e15; showNag(NAG_LINES[${i}]); nag.t0 = performance.now() - 300; mood.lastKeyT = performance.now();`);
        await wait(120); await shot(`nag_${i}`);
      }
      await js('mood.tempUntil = 0; nag.t0 = -1e9; fakeSession(89.9); work.nextNag = performance.now() + 500;');   // real trigger path
      await wait(1000); await shot('nag_auto');
      await js('nag.t0 = -1e9; mood.tempUntil = 0; mood.lastKeyT = performance.now() - 5000; lastActiveWall = Date.now() - 5 * 3600e3;');
      send(33, true); await wait(1000); await shot('welcome'); send(33, false);
      return app.quit();
    }
    if (process.env.AME_DEMO_ACT) {          // record one idle action frame by frame
      await win.webContents.executeJavaScript(`mood.lastKeyT -= 10000; mood.blinkAt = 1e12; act.kind = null; startAct('${process.env.AME_DEMO_ACT}');`);
      for (let f = 0; f < 34; f++) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `a_${String(f).padStart(2, '0')}.png`), img.toPNG());
        await wait(130);
      }
      return app.quit();
    }
    if (process.env.AME_DEMO_FACES) {        // capture each expression (forced via the renderer's setTemp)
      for (const f of process.env.AME_DEMO_FACES.split(',')) {
        const [gx, gy] = f.startsWith('gaze:') ? f.slice(5).split('/').map(Number) : [0, 0];
        const js = f.startsWith('act:') ? `mood.lastKeyT -= 10000; mood.blinkAt = 1e12; act.kind = null; startAct('${f.slice(4)}'); act.t0 -= 900;`
          : f === 'sleep' ? 'mood.lastKeyT -= 200000; mood.blinkAt = 1e12;'
          : f.startsWith('gaze:') ? `mood.lastKeyT -= 5000; mood.blinkAt = 1e12; mouse.seen = true; mouse.x = ${gx}; mouse.y = ${gy};`
          : `setTemp('${f}', 60000); mood.blinkAt = 1e12;`;
        await win.webContents.executeJavaScript(js);
        await wait(900);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `face_${f.replace(/[:/]/g, '_')}.png`), img.toPNG());
        await win.webContents.executeJavaScript('mood.tempUntil = 0; mood.sleeping = false; mood.lastKeyT = performance.now(); act.kind = null;');
      }
      return app.quit();
    }
    if (process.env.AME_DEMO_SEQ) {           // typing burst recorded as frames for a gif
      // tokens: "33" tap, "29+" hold down, "29-" release
      const seq = process.env.AME_DEMO_SEQ.split(',');
      let i = 0, f = 0;
      const typer = setInterval(() => {
        if (i >= seq.length) return clearInterval(typer);
        const tok = seq[i++], c = parseInt(tok, 10);
        if (tok.endsWith('+')) send(c, true);
        else if (tok.endsWith('-')) send(c, false);
        else { send(c, true); setTimeout(() => send(c, false), 60); }
      }, 140);
      const until = Date.now() + seq.length * 140 + 1200;
      const log = [];
      while (Date.now() < until) {
        log.push(await win.webContents.executeJavaScript(
          "[Math.round(handCenter('L')), Math.round(handCenter('R')), hands.L.state, hands.R.state, lastKey || '-', mood.face, Math.round(fhair.x)].join(' ')"));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `f_${String(f++).padStart(3, '0')}.png`), img.toPNG());
        await wait(45);
      }
      fs.writeFileSync(path.join(outDir, 'hands.log'), log.join('\n'));
      return app.quit();
    }
    for (const [name, code] of shots) {
      send(code, true);
      await wait(70);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(outDir, `demo_${name}.png`), img.toPNG());
      await wait(40); send(code, false); await wait(700);
    }
    app.quit();
  });
}

ipcMain.on('set-scale', (_e, s, commit) => { if (win) setScale(s, commit); });

// Claude Code events (via ../hook-relay.js): POST http://127.0.0.1:3940/event/<type>  body {text, project}
// Ame reacts (renderer) and a progress bubble above her head shows the line (Codex-pet style).
const http = require('http');
const crypto = require('crypto');
// Claude panel under Ame: session list (left) + selected session log (right); resizable, size remembered
// each mode remembers its own size (the chat needs more room than the progress log)
const chatMode = () => settings.panelMode === 'chat';
const sizeKeys = () => (chatMode() ? ['chatW', 'chatH', 680, 460] : ['panelW', 'panelH', 600, 280]);
let bubW, bubH;
function loadPanelSize() { const [kw, kh, dw, dh] = sizeKeys(); bubW = settings[kw] || dw; bubH = settings[kh] || dh; }
loadPanelSize();
// 'pchan' mode: the panel stays folded away and P-chan (drawn in Ame's window) stands in for it;
// clicking P-chan opens the panel for a look (panelPeek) until it is closed or auto-hides again
const pchanMode = () => settings.panelMode === 'pchan';
if (settings.panelCollapsed) { if (settings.panelMode === 'popup') settings.panelMode = 'pchan'; delete settings.panelCollapsed; }   // upstream's old fold flag
let panelPeek = false;
const folded = () => pchanMode() && !panelPeek;
let bubbleWin = null;
function setPanelMode(v) {
  settings.panelMode = v; save(); buildMenu();
  loadPanelSize();
  if (chatMode()) bridge.start();
  panelPeek = false; sendFolded();
  pushBubble(null);
  if (chatMode()) { placeBubble(); bubbleWin.showInactive(); }
  else if (v === 'off' || v === 'pchan') hideBubble();
  else if (bubbleWin.isVisible()) placeBubble();
}
// the Windose web desktop in the default browser (https only: the address comes from settings.json)
function openDashboard() {
  const u = String(settings.dashboardUrl || '');
  if (/^https:\/\/\S+$/.test(u)) shell.openExternal(u);
}
ipcMain.on('open-dashboard', (e) => { if (win && e.sender === win.webContents) openDashboard(); });
function createBubble() {
  bubbleWin = new BrowserWindow({
    width: bubW, height: bubH, transparent: true, frame: false, resizable: false, thickFrame: false,
    hasShadow: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    // focusable (a focusable:false window on Windows stops getting mouse input after a click or two);
    // it is only ever shown with showInactive(), so it never steals focus unless you click it
    webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), backgroundThrottling: false },
  });
  bubbleWin.setAlwaysOnTop(true, 'floating');
  bubbleWin.loadFile('bubble.html');
  bubbleWin.webContents.on('did-finish-load', () => pushBubble(null));
  bubbleWin.on('focus', keepAmeOnTop);     // clicking the panel must not lift it above Ame
  bubbleWin.webContents.on('did-finish-load', () => sendFolded());
  bubbleWin.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level < 1) return;
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'), `${new Date().toISOString()} [panel] ${message} (${path.basename(source || '')}:${line})` + String.fromCharCode(10)); } catch {}
  });
}
function hideBubble() {
  if (bubbleWin && bubbleWin.isVisible()) bubbleWin.hide();
  if (panelPeek) { panelPeek = false; sendFolded(); }             // P-chan mode: the look is over, P-chan is back
}
ipcMain.on('bubble-close', () => hideBubble());
// the panel page and P-chan mirror the folded state (the panel counts unread differently while folded)
function sendFolded() {
  if (bubbleWin) bubbleWin.webContents.send('bubble-collapsed', folded());
  sendPanel();
}
// "−" button / title double-click: fold the panel into P-chan (switches to P-chan mode, or ends the look in it)
ipcMain.on('bubble-collapse', (_e, v) => {
  if (!v) expandPanel();
  else if (!pchanMode()) setPanelMode('pchan');
  else hideBubble();
});
// expand + show the panel (P-chan click); with no sessions there is nothing to show (except the chat panel)
function expandPanel() {
  if ((!sessions.size && !chatMode()) || !bubbleWin) return;
  if (pchanMode()) { panelPeek = true; sendFolded(); }
  pushBubble(null); placeBubble(); bubbleWin.showInactive(); keepAmeOnTop();
}
ipcMain.on('panel-expand', () => expandPanel());
// P-chan (drawn by Ame's renderer while the panel is collapsed) mirrors the panel: unread count comes from the panel page
let panelUnread = 0;
ipcMain.on('bubble-unread', (_e, n) => { panelUnread = n | 0; sendPanel(); });
function sendPanel() {
  if (!win || win.isDestroyed()) return;
  const all = [...sessions.values()];
  win.webContents.send('panel', { collapsed: folded(), unread: all.length ? panelUnread : 0, waiting: all.some((s) => s.state === 'waiting'), n: all.length });
}
// The panel hangs under Ame. Horizontally it can slide on its own (settings.panelDX = offset of its centre
// from Ame's centre), but never further than edge-to-edge: its right edge can reach Ame's left edge and
// its left edge can reach Ame's right edge. Pulling past that drags Ame along. Vertically the same idea
// (settings.panelDY = offset of its top from the "hanging just under the keyboard" spot): it can slide up
// behind Ame until its bottom edge meets hers, and hangs no lower than just under the keyboard.
const maxPanelDX = (b) => bubW / 2 + b.width / 2;
const minPanelDY = () => 6 - bubH;
const clampDY = (dy) => Math.max(minPanelDY(), Math.min(0, dy || 0));
function placeBubble() {
  if (!bubbleWin || !win || win.isDestroyed()) return;
  const b = win.getBounds(), wa = screen.getDisplayMatching(b).workArea;
  const m = maxPanelDX(b);
  settings.panelDX = Math.max(-m, Math.min(m, settings.panelDX || 0));
  settings.panelDY = clampDY(settings.panelDY);
  const hang = b.y + b.height - 6;                              // just under the keyboard
  let x = Math.round(b.x + b.width / 2 - bubW / 2 + settings.panelDX);
  let y = hang + settings.panelDY;
  if (y + bubH > wa.y + wa.height) y = wa.y + wa.height - bubH;  // no room: overlap Ame like a VN textbox
  x = Math.max(wa.x, Math.min(wa.x + wa.width - bubW, x));
  y = Math.max(wa.y, y);
  settings.panelDX = x + bubW / 2 - (b.x + b.width / 2);         // store where it really is (screen edge may push it)
  settings.panelDY = clampDY(y - hang);
  bubbleWin.setBounds({ x, y: Math.round(y), width: bubW, height: bubH });
  keepAmeOnTop();
}
// Ame's window always stays above the panel
function keepAmeOnTop() { if (win && !win.isDestroyed() && bubbleWin && bubbleWin.isVisible()) win.moveTop(); }
// resize grip (bottom-right of the panel): the main process follows the real cursor, like dragging Ame
let panelGest = null, panelTimer = null;
ipcMain.on('bubble-gesture', (_e, kind) => {
  if (!bubbleWin) return;
  if (kind === 'resize-start') {
    const p = screen.getCursorScreenPoint();
    panelGest = { x0: p.x, y0: p.y, w0: bubW, h0: bubH };
    clearInterval(panelTimer);
    panelTimer = setInterval(() => {
      const c = screen.getCursorScreenPoint();
      const w = Math.max(380, Math.min(1400, panelGest.w0 + c.x - panelGest.x0));
      const h = Math.max(180, Math.min(1000, panelGest.h0 + c.y - panelGest.y0));
      if (w !== bubW || h !== bubH) { bubW = w; bubH = h; placeBubble(); }
    }, 16);
  } else if (kind === 'resize-end') endPanelResize();
  else if (kind === 'drag-start') {
    const p = screen.getCursorScreenPoint(), wb = win.getBounds();
    panelGest = { drag: true, x0: p.x, y0: p.y, dx0: settings.panelDX || 0, dy0: clampDY(settings.panelDY), px: wb.x, py: wb.y, w: wb.width, h: wb.height };
    clearInterval(panelTimer);
    panelTimer = setInterval(() => {
      const c = screen.getCursorScreenPoint(), g = panelGest;
      const m = maxPanelDX({ width: g.w });
      const want = g.dx0 + (c.x - g.x0), wantY = g.dy0 + (c.y - g.y0);
      const dx = Math.max(-m, Math.min(m, want)), dy = clampDY(wantY);
      const pull = want - dx, pullY = wantY - dy;               // past the limits: Ame comes along
      const pos = clampToScreen(g.px + pull, g.py + pullY, g.w, g.h);
      settings.panelDX = dx; settings.panelDY = dy;
      const wb = win.getBounds();
      if (pos.x !== wb.x || pos.y !== wb.y) win.setBounds({ x: pos.x, y: pos.y, width: g.w, height: g.h });
      else placeBubble();
    }, 8);
  } else if (kind === 'drag-end') endPanelResize();
});
function endPanelResize() {
  if (!panelGest) return;
  const wasDrag = panelGest.drag;
  clearInterval(panelTimer); panelGest = null;
  if (wasDrag) { const [x, y] = win.getPosition(); settings.x = x; settings.y = y; save(); return; }
  const [kw, kh] = sizeKeys(); settings[kw] = bubW; settings[kh] = bubH; save();
}
ipcMain.on('bubble-size', (_e, h) => {
  void h;                                                        // the panel has a user-chosen size now
});
// ---- multiple Claude Code sessions ----
// Every session is tracked separately (id from the hook payload). The dialogue box lists all live
// sessions; Ame's own reaction is computed across them: she is only "done & happy" when no session
// is still working, and waves whenever any session needs you.
const sessions = new Map();     // id -> { id, project, state, lines[], steps, t0, last, transcript, cwd, claudePid, terminal }
const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const STALE_WORK_MS = 10 * 60e3, WAIT_SHOW_MS = 10 * 60e3, AUTOHIDE_MS = 25e3;
const KEEP_MS = +process.env.AME_KEEP_MS || 20 * 60e3;            // (tests shorten it)
const ALIVE_CHECK_MS = +process.env.AME_ALIVE_CHECK_MS || 30 * 60e3;   // a long-quiet session's process: looked at this often
const CHAT_KEEP_MS = 12 * 3600e3;                                 // chat mode keeps ended sessions around (to resume them)
let hideTimer = null;

function sessionLabel(s) {
  if (s.title) return s.title;                                    // the conversation's name in the Claude app
  const same = [...sessions.values()].filter((o) => o.provider === s.provider && o.project === s.project && !o.title);
  const base = s.project || (s.provider === 'codex' ? 'Codex' : 'Claude');
  return same.length > 1 ? `${base} #${String(s.rawSession || s.id).slice(0, 4)}` : base;
}
// A card answered (here, on the dashboard or in the terminal) puts the session back to work. Left "waiting" with
// 需要确认 as its last line, the panel would take the vanished card for a timed-out one ("请到终端里回答") and the
// reply box would stay blocked until the next hook event. Only a real timeout keeps that hint: the terminal still asks.
const PERM_END = { decided: (e) => (e.choice === 'allow' ? '已允许' : e.choice === 'always' ? '已总是允许' : '已拒绝'), closed: () => '已在终端处理', advanced: () => '已在终端处理' };
const permissions = createPermissions((sid, end) => {
  const s = sessions.get(sid), say = end && PERM_END[end.why];
  if (say && s && s.state === 'waiting' && !permissions.list(sid).length) onClaudeEvent('thinking', { session: sid, text: `${say(end)}：${end.tool}` });
  else pushBubble(null);
});
ipcMain.handle('permission-decide', (e, id, choice) => {
  if (!bubbleWin || e.sender !== bubbleWin.webContents) return { ok: false };
  return { ok: permissions.decide(id, choice) };
});
app.on('before-quit', () => permissions.clear());
// how a reply typed in the panel reaches this session
// Background sessions and the terminals parked on them (running-sessions.js lineage): a parked terminal is the
// background session's window, so it is not listed; the background one is marked. Looked up at most every 3 s.
let lineageAt = 0, lineageNow = { bg: new Set(), parked: new Set() };
function sessionLineage() {
  if (Date.now() - lineageAt > 3000) {
    lineageAt = Date.now();
    try { lineageNow = lineage(app.getPath('home'), (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }); } catch {}
  }
  return lineageNow;
}
const listed = () => { const { parked } = sessionLineage(); return [...sessions.values()].filter((s) => !parked.has(s.id)); };
function replyVia(s) {
  if (s.provider === 'codex') return 'codex';
  if (s.state === 'ended') return 'resume';
  if (s.headless) return 'busy';
  if (s.claudePid && s.terminal) return 'terminal';
  return s.claudePid ? 'none' : 'unknown';
}
function pushBubble(changedId) {
  if (!bubbleWin) return;
  const list = listed().sort((x, y) => x.born - y.born).map((s) => ({   // stable order: cards never jump
    id: s.id, label: sessionLabel(s), project: s.project, state: s.state, lines: s.lines, steps: s.steps, t0: s.t0, last: s.last, bg: sessionLineage().bg.has(s.id),
    provider: s.provider, via: replyVia(s), permissions: permissions.list(s.id),
  }));
  sendPanel();
  if (!list.length && !chatMode()) { hideBubble(); return; }
  bubbleWin.webContents.send('bubble-state', { sessions: list, changedId, mode: settings.panelMode, sound: settings.petSound !== false });
  if (changedId && settings.panelMode !== 'off') {   // new activity: show the panel (unless panels are off; P-chan mode: only P-chan reacts)
    placeBubble();
    if (!folded() && !bubbleWin.isVisible()) bubbleWin.showInactive();
    keepAmeOnTop();
  }
  // popup mode: auto-hide once nothing is working or waiting (unless the mouse is on the panel)
  clearTimeout(hideTimer);
  if (!chatMode() && !list.some((s) => WORKING.has(s.state) || s.state === 'waiting' || s.permissions.length)) {
    hideTimer = setTimeout(function check() {
      const c = screen.getCursorScreenPoint(), bb = bubbleWin.getBounds();
      const over = c.x >= bb.x && c.x < bb.x + bb.width && c.y >= bb.y && c.y < bb.y + bb.height;
      if (over) hideTimer = setTimeout(check, 3000); else hideBubble();
    }, AUTOHIDE_MS);
  }
}
const anyWorking = (exceptId) => [...sessions.values()].some((s) => s.id !== exceptId && WORKING.has(s.state));

// Which process is this session, and does it sit in a terminal? The hook sends its parent pid; walk up to
// the Claude Code process (claude.exe, or node/bun for an npm install) and look at what started it: a shell
// or terminal = an interactive session we can type into; an IDE / the desktop app = no console to use; Claude Code
// itself = a background session in its own pseudo-terminal, usable all the same (session-terminal.js).
const CLAUDE_EXE = /^(claude|node|bun)\.exe$/i;
const TERM_HOSTS = /^(pwsh|powershell|cmd|bash|sh|zsh|fish|nu|elvish|xonsh|WindowsTerminal|OpenConsole|conhost|explorer|wezterm-gui|alacritty|mintty|Tabby|Hyper|ConEmu64|ConEmuC64|ConEmu|ConEmuC|wsl|wslhost|tmux)\.exe$/i;
async function locateSession(s, pid) {
  if (!s || s.provider === 'codex') return;
  if (!pid || s.fromPid === pid) return;
  const chain = await bridge.ancestors(pid);
  const i = chain.findIndex((p) => CLAUDE_EXE.test(p.name));
  if (i < 0) return;                                               // not found: try again on the next event
  s.fromPid = pid;
  s.claudePid = chain[i].pid;
  const parent = chain[i + 1];
  s.headless = !!parent && parent.pid === process.pid;           // a `claude -p --resume` we started ourselves
  s.terminal = await inTerminal({ parent, pid: s.claudePid, isTermHost: (n) => TERM_HOSTS.test(n), screen: (p) => bridge.screen(p) });
  pushBubble(null);                                                // the reply box may have become usable
}
async function procAlive(pid) {
  if (!pid) return false;
  const c = await bridge.ancestors(pid);
  return !!c.length && CLAUDE_EXE.test(c[0].name);                // same pid, still a Claude process (not a reused pid)
}

function onClaudeEvent(type, d) {
  const id = d.session || 'unknown', t = Date.now();
  if (type === 'quit') {
    const q = sessions.get(id);
    if (chatMode() && q) { q.state = 'ended'; q.claudePid = null; q.headless = false; q.fromPid = null; q.last = t; }   // kept: can be resumed
    else sessions.delete(id);
    if (![...sessions.values()].some((s) => WORKING.has(s.state))) win.webContents.send('claude', 'idle');
    return pushBubble(null);
  }
  let s = sessions.get(id);
  if (!s) { s = { id, provider: d.provider || 'claude', rawSession: d.rawSession || id, project: '', state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t }; sessions.set(id, s); }
  s.dormant = false;                                             // activity again: the usual quiet timer starts over
  if (d.project) s.project = String(d.project).slice(0, 40);
  if (d.title) s.title = String(d.title).slice(0, 60);
  if (d.transcript) s.transcript = String(d.transcript);
  if (d.cwd) s.cwd = String(d.cwd);
  if (type === 'idle') { s.last = t; if (s.state === 'ended') s.state = 'idle'; return pushBubble(null); }   // SessionStart
  if (type === 'message' || s.state === 'done') { s.steps = 0; s.t0 = t; if (type === 'message' && s.lines.length) s.lines.push({ sep: true, t }); }
  if (type === 'thinking' || type === 'reading') s.steps++;
  s.state = type; s.last = t;
  const text = d.text ? String(d.text).slice(0, 300) : '';
  const lastLine = s.lines[s.lines.length - 1];
  if (text && !(lastLine && lastLine.text === text)) s.lines.push({ text, t, type });
  s.lines = s.lines.slice(-60);
  // Ame's reaction across all sessions
  if (type === 'done') win.webContents.send('claude', anyWorking(id) ? 'done-partial' : 'done');
  else if (type === 'waiting') win.webContents.send('claude', 'waiting');
  else win.webContents.send('claude', type === 'paused' ? (anyWorking(id) ? 'thinking' : 'idle') : type);
  if (text || type === 'done') pushBubble(id);
}

// expire stale states and drop long-inactive sessions from the list
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const t = Date.now(); let changed = false;
  for (const [id, s] of sessions) {
    if (WORKING.has(s.state) && t - s.last > STALE_WORK_MS) { s.state = 'idle'; changed = true; }
    if (s.state === 'waiting' && t - s.last > WAIT_SHOW_MS) { s.state = 'idle'; changed = true; }
    if (t - s.last > (chatMode() ? CHAT_KEEP_MS : KEEP_MS) && !s.dormant && !s.checking) {
      // long quiet: gone from the list only when its Claude process is gone too. One still open in its terminal stays
      // an active session (here and on the dashboard, where it can still be replied to); its process is looked at
      // every 30 minutes from then on (a reply meanwhile to one that has ended goes the claude -p --resume way)
      if (!s.claudePid) { sessions.delete(id); chats.delete(id); changed = true; continue; }
      s.checking = true;
      procAlive(s.claudePid).then((alive) => {
        s.checking = false;
        if (sessions.get(id) !== s) return;
        if (alive) { s.dormant = true; s.aliveAt = Date.now(); } else { sessions.delete(id); chats.delete(id); }
        pushBubble(null);
      });
    }
    if (s.dormant && s.claudePid && !s.checking && t - (s.aliveAt || 0) > ALIVE_CHECK_MS) {   // a dormant one: gone when its process ends
      s.checking = true; s.aliveAt = t;
      procAlive(s.claudePid).then((alive) => { s.checking = false; if (!alive && sessions.get(id) === s) { sessions.delete(id); chats.delete(id); pushBubble(null); } });
    }
  }
  if (changed) {
    if (![...sessions.values()].some((s) => WORKING.has(s.state))) win.webContents.send('claude', 'idle');
    pushBubble(null);
  }
}, 5000);

// ---- control API for the remote agent (../remote/agent/agent.js): the same two actions as the panel,
// reply to a session and answer a permission card. Guarded by a random token written to
// ~/.ametyping/control-token-<port> (this user only). The custom header also keeps web pages out: a
// cross-origin request carrying it needs a CORS preflight, which is never answered; any Origin is refused.
const CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');
const controlTokenFile = path.join(app.getPath('home'), '.ametyping', `control-token-${PORT}`);
function writeControlToken() {
  try {
    fs.mkdirSync(path.dirname(controlTokenFile), { recursive: true });
    fs.writeFileSync(controlTokenFile, CONTROL_TOKEN, { mode: 0o600 });
  } catch (e) { console.error('control token: ' + e.message); }
}
app.on('will-quit', () => { try { if (fs.readFileSync(controlTokenFile, 'utf8') === CONTROL_TOKEN) fs.unlinkSync(controlTokenFile); } catch {} });
function controlOk(req) {
  const t = Buffer.from(String(req.headers['x-ame-control'] || ''));
  return !req.headers.origin && t.length === CONTROL_TOKEN.length && crypto.timingSafeEqual(t, Buffer.from(CONTROL_TOKEN));
}
function controlState() {
  return listed().sort((x, y) => x.born - y.born).map((s) => ({
    id: s.id, label: sessionLabel(s), project: s.project, provider: s.provider, state: s.state, via: replyVia(s), bg: sessionLineage().bg.has(s.id),
    t0: s.t0, last: s.last, lines: s.lines.filter((l) => !l.sep).slice(-8),
    perms: permissions.list(s.id).map((p) => ({ id: p.id, provider: p.provider, tool: p.tool, cwd: p.cwd, subagent: p.subagent, always: p.always,
      input: JSON.stringify(p.input || {}, null, 2).slice(0, 8000) })),
  }));
}
async function onControl(req, res, body) {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!controlOk(req)) return out(403, { ok: false });
  if (req.method === 'GET' && req.url === '/control/state') return out(200, { control: !!settings.remoteControl, sessions: controlState() });
  let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
  // the NAS wrote a daily report: a note for the morning bubble (information only -- not remote control)
  if (req.method === 'POST' && req.url === '/control/report') return out(200, { ok: morning.setNote(d) });
  // ... and a new mail that needs you: a bubble at once (information only, too)
  if (req.method === 'POST' && req.url === '/control/mail') return out(200, { ok: mailNotice.add(d) });
  if (!settings.remoteControl) return out(200, { ok: false, msg: '糖糖菜单里没勾「允许远程控制」' });
  if (req.method === 'POST' && req.url === '/control/send') {
    const text = typeof d.text === 'string' ? d.text : '';
    if (typeof d.id !== 'string' || !text.trim() || text.length > 8000) return out(400, { ok: false, msg: '内容为空或太长' });
    return out(200, await chatSend(d.id, text));
  }
  if (req.method === 'POST' && req.url === '/control/key') {
    if (typeof d.id !== 'string' || typeof d.key !== 'string') return out(400, { ok: false, msg: '无效请求' });
    return out(200, await chatKey(d.id, d.key, d.screen === true));
  }
  if (req.method === 'POST' && req.url === '/control/screen') {
    if (typeof d.id !== 'string') return out(400, { ok: false, msg: '无效请求' });
    return out(200, await chatScreen(d.id));
  }
  if (req.method === 'POST' && req.url === '/control/launch') {
    if (typeof d.cwd !== 'string' || !d.cwd || (d.prompt != null && typeof d.prompt !== 'string')) return out(400, { ok: false, msg: '无效请求' });
    return out(200, await launch(d.cwd, d.prompt || ''));
  }
  if (req.method === 'POST' && req.url === '/control/decide') {
    if (typeof d.session !== 'string' || !permissions.list(d.session).some((p) => p.id === d.id)) return out(200, { ok: false, msg: '这个确认已经结束了' });
    return out(200, permissions.decide(d.id, d.choice) ? { ok: true } : { ok: false, msg: '请求已结束' });
  }
  return out(404, { ok: false });
}

http.createServer((req, res) => {
  const m = req.method === 'POST' && /^\/event\/([a-z]+)$/.exec(req.url);
  const permission = req.method === 'POST' && req.url === '/permission';
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > (permission ? 2e6 : 20000)) req.destroy(); });
  req.on('end', async () => {
    if (req.url.startsWith('/control/')) return onControl(req, res, body).catch(() => { try { res.writeHead(500); res.end('{}'); } catch {} });
    let d = {}; try { d = JSON.parse(body || '{}'); } catch {}
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
    d = normalizeSession(d);
    if (permission) {
      if (!win || win.isDestroyed() || !bubbleWin || bubbleWin.isDestroyed()) { res.end('{}'); return; }
      if (typeof d.session !== 'string' || !d.session || typeof d.tool !== 'string' || !d.tool) {
        res.writeHead(400); res.end('{}'); return;
      }
      permissions.add(d, res);
      onClaudeEvent('waiting', { ...d, text: `需要确认：${d.tool}` });
      pushBubble(d.session);
      if (d.pid) locateSession(sessions.get(d.session), d.pid).catch(() => {});
      return;
    }
    if (m) permissions.advance(d);
    // the hook waits for this answer, so its parent process is still alive while we look it up
    // (matters when the hook runs through a shell that exits right after it)
    if (m && d.pid && win && !win.isDestroyed()) {
      const id = d.session || 'unknown';
      let s = sessions.get(id);
      if (!s) { onClaudeEvent('idle', { ...d, session: id }); s = sessions.get(id); }
      if (s) await Promise.race([locateSession(s, d.pid).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    }
    res.writeHead(m ? 200 : 404); res.end();
    if (!m || !win || win.isDestroyed()) return;
    onClaudeEvent(m[1], d);
  });
}).on('error', () => {}).listen(PORT, '127.0.0.1', writeControlToken);

// ---- chat mode: full conversation + replies ----
const chats = new Map();        // id -> transcript cache (see transcript.js)
let chatSel = null;
function findTranscript(id) {
  const root = path.join(app.getPath('home'), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; }
  } catch {}
  return null;
}
function pushChat(force) {
  const s = chatSel && sessions.get(chatSel);
  if (!s || !chatMode() || !bubbleWin || !bubbleWin.isVisible()) return;
  if (s.provider === 'codex') {
    if (force || s.chatPushed !== s.last) {
      s.chatPushed = s.last;
      bubbleWin.webContents.send('chat-log', { id: s.id, msgs: [
        { role: 'sys', text: 'Codex 实时进度 · 继续对话请回到 Codex', t: s.born },
        ...s.lines.filter((l) => !l.sep).map((l) => ({ role: 'sys', text: l.text, t: l.t })),
      ] });
    }
    return;
  }
  if (!s.transcript) s.transcript = findTranscript(s.id);
  if (!s.transcript) return;
  let c = chats.get(s.id);
  if (!c || c.file !== s.transcript) { c = { file: s.transcript }; chats.set(s.id, c); }
  let changed = false;
  try { changed = transcript.poll(c); } catch (e) { console.error('transcript: ' + e.message); }
  if (c.title && !s.title) { s.title = String(c.title).slice(0, 60); pushBubble(null); }
  if ((changed || force) && c.msgs) bubbleWin.webContents.send('chat-log', { id: s.id, msgs: c.msgs.slice(-200) });
}
setInterval(() => pushChat(false), 1000);
ipcMain.on('chat-select', (_e, id) => { chatSel = id; pushChat(true); });

// replies and navigation keys into a session's terminal (or a background resume): remote-control.js
const morning = createMorning({ app, BrowserWindow, ipcMain, screen, anchor: () => (win && !win.isDestroyed() ? win.getBounds() : null),
  enabled: () => settings.morningBubble !== false, dashboardUrl: () => settings.dashboardUrl, openExternal: (u) => shell.openExternal(u) });
const mailNotice = createMailNotice({ BrowserWindow, ipcMain, screen, anchor: () => (win && !win.isDestroyed() ? win.getBounds() : null),
  enabled: () => settings.mailBubble !== false, dashboardUrl: () => settings.dashboardUrl, openExternal: (u) => shell.openExternal(u) });
const { chatSend, chatKey, chatScreen, launch } = createRemoteControl({ sessions, permissions, bridge, procAlive, pushBubble, home: () => app.getPath('home') });
ipcMain.handle('chat-send', (_e, id, text) => (String(text || '').trim() ? chatSend(id, String(text)) : { ok: false, msg: '' }));

// drag / resize run entirely in the main process: a timer reads the real cursor every 8 ms.
// (Relying on renderer mousemove fails: while the window follows the cursor the pointer barely moves
// relative to the window, Chromium stops sending moves, and the window lags / slides behind.)
let gest = null, gestTimer = null;
function stepGesture() {
  if (!win || !gest) return;
  const p = screen.getCursorScreenPoint();
  if (gest.kind === 'drag') {
    const c = clampToScreen(p.x - gest.dx, p.y - gest.dy, gest.w, gest.h);
    if (c.x !== gest.lx || c.y !== gest.ly) {
      win.webContents.send('winmove', c.x - gest.lx, c.y - gest.ly);   // lets the tails swing while carried
      gest.lx = c.x; gest.ly = c.y;
      // the panel keeps its place horizontally until Ame would come off it (edge to edge), then it follows
      if (bubbleWin && bubbleWin.isVisible()) {
        const cx = c.x + gest.w / 2, m = maxPanelDX({ width: gest.w });
        if (gest.panelCX == null) { const pb = bubbleWin.getBounds(); gest.panelCX = pb.x + pb.width / 2; }
        gest.panelCX = Math.max(cx - m, Math.min(cx + m, gest.panelCX));   // pulled along only past edge-to-edge
        settings.panelDX = gest.panelCX - cx;
        const hang = c.y + gest.h - 6;                                      // same rule vertically
        if (gest.panelTY == null) gest.panelTY = bubbleWin.getBounds().y;
        gest.panelTY = Math.max(hang + minPanelDY(), Math.min(hang, gest.panelTY));
        settings.panelDY = gest.panelTY - hang;
      }
      win.setBounds({ x: c.x, y: c.y, width: gest.w, height: gest.h });   // size locked: no DPI rounding creep
    }
  } else {
    const s = Math.max(0.16, Math.min(0.9, (gest.w + p.x - gest.x0) / ART_W));
    if (Math.abs(s - settings.scale) > 0.002) setScale(s, false);
  }
}
function endGesture() {
  if (!gest) return;
  clearInterval(gestTimer); gestTimer = null;
  const kind = gest.kind; gest = null;
  if (kind === 'drag') { const [x, y] = win.getPosition(); settings.x = x; settings.y = y; save(); }
  else setScale(settings.scale, true);
}
ipcMain.on('gesture', (_e, kind) => {
  if (!win) return;
  if (kind === 'drag-start' || kind === 'resize-start') {
    endGesture();
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const sz = winSize();                    // canonical size from the scale, never the (DPI-rounded) current one
    gest = { kind: kind === 'drag-start' ? 'drag' : 'resize', dx: p.x - b.x, dy: p.y - b.y, x0: p.x, w: sz.width, h: sz.height, lx: b.x, ly: b.y };
    gestTimer = setInterval(stepGesture, 8);
  } else if (kind === 'drag-end' || kind === 'resize-end') endGesture();
});

// cursor position for her gaze, in art-space units relative to the window (polled, no mouse hook)
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  win.webContents.send('mouse', { x: (p.x - b.x) / settings.scale + VX, y: (p.y - b.y) / settings.scale });
}, 50);

ipcMain.on('drag-by', (_e, dx, dy) => {
  if (!win) return;
  const b = win.getBounds();
  const c = clampToScreen(b.x + dx, b.y + dy, b.width, b.height);
  win.setPosition(c.x, c.y);
});

app.on('will-quit', () => { try { uIOhook.stop(); } catch {} bridge.stop(); });
app.on('window-all-closed', () => app.quit());
