const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morning', {
  onNote: (fn) => ipcRenderer.on('morning-note', (_e, d) => fn(d)),
  open: () => ipcRenderer.send('morning-open'),
  close: () => ipcRenderer.send('morning-close'),
});
