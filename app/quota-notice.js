'use strict';
const fs = require('fs'), path = require('path');
const { cleanNotice } = require('../remote/agent/quota-notices');
function createQuotaNotice({ app, BrowserWindow, ipcMain, screen, anchor, dashboardUrl, openExternal }) {
  const file = path.join(app.getPath('userData'), 'quota-notice-seen.json');
  let seen = {}, queue = [], showing = null, win = null, timer;
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); seen = s.seen || {}; queue = (s.pending || []).filter(n => cleanNotice(n)); } catch {}
  const persist = () => {
    seen = Object.fromEntries(Object.entries(seen).filter(([, t]) => t > Date.now()));
    const pending = [...(showing && !seen[showing.id] ? [showing] : []), ...queue].filter(n => cleanNotice(n));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ seen, pending })); fs.renameSync(file + '.tmp', file);
  };
  function next() {
    clearTimeout(timer); if (win && !win.isDestroyed()) win.destroy(); win = null;
    showing = null;
    const n = queue.shift(); if (!n) return;
    if (!cleanNotice(n)) return next();
    const a = anchor();
    if (!a) { queue.unshift(n); timer = setTimeout(next, 10000); return; }
    showing = n;
    const wa = screen.getDisplayMatching(a).workArea, width = 300, height = 138;
    win = new BrowserWindow({ width, height, x: Math.max(wa.x, Math.min(a.x - width, wa.x + wa.width - width)), y: Math.max(wa.y, Math.min(a.y, wa.y + wa.height - height)),
      transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'quota-notice-preload.js'), contextIsolation: true, nodeIntegration: false } });
    const current = win;
    current.loadFile(path.join(__dirname, 'quota-notice.html'));
    current.webContents.once('did-finish-load', () => {
      if (current.isDestroyed() || win !== current) return;
      current.webContents.send('quota-notice', n); current.showInactive();
      seen[n.id] = n.expiresAt; try { persist(); } catch {}
      timer = setTimeout(next, 60000);
    });
  }
  ipcMain.on('quota-notice-close', e => { if (win && e.sender === win.webContents) next(); });
  ipcMain.on('quota-notice-open', e => {
    if (!win || e.sender !== win.webContents) return;
    const u = String(dashboardUrl() || '');
    if (/^https:\/\/\S+$/.test(u)) openExternal(u.replace(/\/?$/, '/') + '#magpie');
    next();
  });
  app.whenReady().then(() => { if (queue.length) next(); });
  return { add(input) {
    const n = cleanNotice(input); if (!n) return false;
    if (seen[n.id] || showing?.id === n.id || queue.some(x => x.id === n.id)) return true;
    // Durable acceptance allows the agent to acknowledge, even before the bubble paints.
    queue.push(n); try { persist(); } catch { queue = queue.filter(x => x.id !== n.id); return false; }
    if (!win && app.isReady()) next(); return true;
  } };
}
module.exports = { createQuotaNotice };
