// 邮件提醒气泡: the NAS read a new mail and found something for you (a thing to do, a notice that matters, papers worth
// a look; remote/server/mail/triage.js). The dashboard agent passes it on (POST /control/mail) and Ame shows a small
// window next to her at once: what it is, what to do, by when; a click opens that mail in the Windose web desktop.
// Several waiting: the newest, with how many more. It goes away after 2 minutes; not seen to (no click, no ×): shown
// once more on the next key press. Tray option 邮件提醒气泡.
'use strict';
const path = require('path');

const W = 300, H = 150, SHOW_MS = 120e3, KEEP = 10;

// deps: { BrowserWindow, ipcMain, screen, anchor: () => Ame's window bounds, enabled: () => bool, dashboardUrl: () => string, openExternal(url) }
function createMailNotice({ BrowserWindow, ipcMain, screen, anchor, enabled, dashboardUrl, openExternal }) {
  let win = null, hideT = null, waiting = [], again = false, lastCheck = 0;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

  // an alert from the agent: { id, kind, summary, subject, todo, deadline, key }
  function add(d) {
    if (!d || typeof d.id !== 'string' || typeof d.key !== 'string') return false;
    if (waiting.some((x) => x.id === d.id)) return true;
    const a = { id: str(d.id, 40), key: str(d.key, 200), kind: ['action', 'notice', 'reading'].includes(d.kind) ? d.kind : 'notice',
      summary: str(d.summary, 120), subject: str(d.subject, 200), todo: str(d.todo, 120), deadline: /^\d{4}-\d{2}-\d{2}$/.test(d.deadline) ? d.deadline : '',
      picks: (Array.isArray(d.picks) ? d.picks : []).slice(0, 3).map((p) => str(p && p.title, 80)).filter(Boolean) };
    waiting = [a, ...waiting].slice(0, KEEP);
    if (enabled()) show();
    return true;
  }

  function place() {
    const a = anchor(); if (!a) return;
    const wa = screen.getDisplayMatching(a).workArea;
    const x = Math.max(wa.x, Math.min(a.x - W + Math.round(a.width * 0.25), wa.x + wa.width - W));
    const y = Math.max(wa.y, Math.min(a.y + Math.round(a.height * 0.45), wa.y + wa.height - H));
    win.setBounds({ x, y, width: W, height: H });
  }
  const payload = () => ({ ...waiting[0], more: waiting.length - 1 });
  function show() {
    if (!waiting.length) return;
    if (!win) {
      win = new BrowserWindow({ width: W, height: H, transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
        alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, 'mail-notice-preload.js') } });
      win.setAlwaysOnTop(true, 'floating');
      win.loadFile('mail-notice.html');
      win.on('closed', () => { win = null; });
      win.webContents.once('did-finish-load', () => { win.webContents.send('mail-notice', payload()); place(); win.showInactive(); });
    } else { win.webContents.send('mail-notice', payload()); place(); win.showInactive(); }
    clearTimeout(hideT);
    hideT = setTimeout(() => { hide(); again = true; }, SHOW_MS);               // not seen to: once more on the next key
  }
  function hide() { clearTimeout(hideT); if (win && win.isVisible()) win.hide(); }
  // seen to (clicked, or ×): no more of these
  function settle() { waiting = []; again = false; hide(); }

  function onKey() {
    const now = Date.now();
    if (now - lastCheck < 2000) return;
    lastCheck = now;
    if (again && waiting.length && enabled()) { again = false; show(); }
  }

  ipcMain.on('mail-notice-open', (e) => {
    if (!win || e.sender !== win.webContents || !waiting.length) return;
    const u = String(dashboardUrl() || '');
    if (/^https:\/\/\S+$/.test(u)) openExternal(u.replace(/\/?$/, '/') + '#mail=' + encodeURIComponent(waiting[0].key));
    settle();
  });
  ipcMain.on('mail-notice-close', (e) => { if (win && e.sender === win.webContents) settle(); });

  return { add, onKey, hide, waiting: () => waiting.slice() };
}

module.exports = { createMailNotice };
