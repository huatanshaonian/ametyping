const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quotaNotice', {
  onAlert: fn => ipcRenderer.on('quota-notice', (_e, n) => fn(n)),
  close: () => ipcRenderer.send('quota-notice-close'), open: () => ipcRenderer.send('quota-notice-open'),
});
