// 早安日报: when the NAS has written a new daily report (the dashboard agent passes a short note on:
// POST /control/report), the first key you press after it arrives makes Ame show a small window next to her --
// what yesterday was about, how many things are still open, the weekly report on Mondays. A click opens the report
// in the Windose web desktop. Each note is shown once (remembered across restarts); tray option 早安日报.
'use strict';
const fs = require('fs');
const path = require('path');

const W = 300, H = 170, SHOW_MS = 45e3;

// deps: { app, BrowserWindow, ipcMain, screen, anchor: () => Ame's window bounds, enabled: () => bool,
//         dashboardUrl: () => string, openExternal(url) }
function createMorning({ app, BrowserWindow, ipcMain, screen, anchor, enabled, dashboardUrl, openExternal }) {
  const file = path.join(app.getPath('userData'), 'morning.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}   // { note, shown }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st)); } catch {} };
  const keyOf = (n) => n ? n.date + (n.week ? '|' + n.week.start : '') : '';
  let win = null, hideT = null, lastCheck = 0;

  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  // a note from the agent: { date, headline, projects: [name], open: n, chores: n, week?: { start, end, headline } }
  function setNote(d) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return false;
    const note = { date: d.date, headline: str(d.headline, 200), projects: (Array.isArray(d.projects) ? d.projects : []).slice(0, 6).map((x) => str(x, 40)),
      open: +d.open || 0, done: +d.done || 0, chores: +d.chores || 0 };
    if (d.week && /^\d{4}-\d{2}-\d{2}$/.test(d.week.start)) note.week = { start: d.week.start, end: str(d.week.end, 10), headline: str(d.week.headline, 200) };
    if (keyOf(note) === keyOf(st.note)) return true;
    st.note = note; save();
    return true;
  }

  function place() {
    const a = anchor(); if (!a) return;
    const wa = screen.getDisplayMatching(a).workArea;
    const x = Math.max(wa.x, Math.min(a.x - W + Math.round(a.width * 0.25), wa.x + wa.width - W));
    const y = Math.max(wa.y, Math.min(a.y + Math.round(a.height * 0.1), wa.y + wa.height - H));
    win.setBounds({ x, y, width: W, height: H });
  }
  function show() {
    if (!win) {
      win = new BrowserWindow({ width: W, height: H, transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
        alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, 'morning-preload.js') } });
      win.setAlwaysOnTop(true, 'floating');
      win.loadFile('morning.html');
      win.on('closed', () => { win = null; });
      win.webContents.once('did-finish-load', () => { win.webContents.send('morning-note', st.note); place(); win.showInactive(); });
    } else { win.webContents.send('morning-note', st.note); place(); win.showInactive(); }
    clearTimeout(hideT); hideT = setTimeout(hide, SHOW_MS);
  }
  function hide() { clearTimeout(hideT); if (win && win.isVisible()) win.hide(); }

  // every key press: the first one after a new note shows it
  function onKey() {
    const now = Date.now();
    if (now - lastCheck < 2000) return;
    lastCheck = now;
    if (!enabled() || !st.note || keyOf(st.note) === st.shown) return;
    st.shown = keyOf(st.note); save();
    show();
  }

  ipcMain.on('morning-open', (e) => {
    if (!win || e.sender !== win.webContents) return;
    const u = String(dashboardUrl() || '');
    if (/^https:\/\/\S+$/.test(u) && st.note) openExternal(u.replace(/\/?$/, '/') + '#report=' + st.note.date);
    hide();
  });
  ipcMain.on('morning-close', (e) => { if (win && e.sender === win.webContents) hide(); });

  return { setNote, onKey, show, hide, note: () => st.note };
}

module.exports = { createMorning };
