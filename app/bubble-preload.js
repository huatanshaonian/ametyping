const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onState: (fn) => ipcRenderer.on('bubble-state', (_e, d) => fn(d)),
  onHide: (fn) => ipcRenderer.on('bubble-hide', () => fn()),
  size: (h) => ipcRenderer.send('bubble-size', h),
  close: () => ipcRenderer.send('bubble-close'),
  decidePermission: (id, choice) => ipcRenderer.invoke('permission-decide', id, choice),
  gesture: (k) => ipcRenderer.send('bubble-gesture', k),
  // chat mode
  onChat: (fn) => ipcRenderer.on('chat-log', (_e, d) => fn(d)),
  select: (id) => ipcRenderer.send('chat-select', id),
  send: (id, text) => ipcRenderer.invoke('chat-send', id, text),
});
