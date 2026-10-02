const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailNotice', {
  onAlert: (fn) => ipcRenderer.on('mail-notice', (_e, d) => fn(d)),
  open: () => ipcRenderer.send('mail-notice-open'),
  close: () => ipcRenderer.send('mail-notice-close'),
});
