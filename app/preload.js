const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onKey: (fn) => ipcRenderer.on('key', (_e, k) => fn(k)),
  onConfig: (fn) => ipcRenderer.on('config', (_e, c) => fn(c)),
  dragBy: (dx, dy) => ipcRenderer.send('drag-by', dx, dy),
  setScale: (s, commit) => ipcRenderer.send('set-scale', s, commit),
  onMouse: (fn) => ipcRenderer.on('mouse', (_e, m) => fn(m)),
  setHit: (v) => ipcRenderer.send('hit', v),
  setShape: (rects) => ipcRenderer.send('shape', rects),
  gesture: (kind) => ipcRenderer.send('gesture', kind),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  onClaude: (fn) => ipcRenderer.on('claude', (_e, t) => fn(t)),
  onPanel: (fn) => ipcRenderer.on('panel', (_e, s) => fn(s)),
  panelExpand: () => ipcRenderer.send('panel-expand'),
  onWinMove: (fn) => ipcRenderer.on('winmove', (_e, dx, dy) => fn(dx, dy)),
});
