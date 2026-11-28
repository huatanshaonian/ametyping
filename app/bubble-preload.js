const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onState: (fn) => ipcRenderer.on('bubble-state', (_e, d) => fn(d)),
  onHide: (fn) => ipcRenderer.on('bubble-hide', () => fn()),
  onShade: (fn) => ipcRenderer.on('bubble-shade', (_e, shade) => fn(shade)),
  size: (h) => ipcRenderer.send('bubble-size', h),
  close: () => ipcRenderer.send('bubble-close'),
  decidePermission: (id, choice, extra) => ipcRenderer.invoke('permission-decide', id, choice, extra),
  collapse: (v) => ipcRenderer.send('bubble-collapse', v),
  onCollapsed: (fn) => ipcRenderer.on('bubble-collapsed', (_e, v) => fn(v)),
  unread: (n) => ipcRenderer.send('bubble-unread', n),
  gesture: (k) => ipcRenderer.send('bubble-gesture', k),
  openExternal: (hash) => ipcRenderer.send('bubble-open-web', hash),
  openSession: (id) => ipcRenderer.send('bubble-open-session', id),
  openTopo: (projectId, nodeId) => ipcRenderer.send('bubble-open-topo', projectId, nodeId),
  // chat mode
  onChat: (fn) => ipcRenderer.on('chat-log', (_e, d) => fn(d)),
  select: (id) => ipcRenderer.send('chat-select', id),
  send: (id, text) => ipcRenderer.invoke('chat-send', id, text),
});
