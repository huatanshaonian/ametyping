const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onState: (fn) => ipcRenderer.on('bubble-state', (_e, d) => fn(d)),
  onHide: (fn) => ipcRenderer.on('bubble-hide', () => fn()),
  size: (h) => ipcRenderer.send('bubble-size', h),
  close: () => ipcRenderer.send('bubble-close'),
  gesture: (k) => ipcRenderer.send('bubble-gesture', k),
});
