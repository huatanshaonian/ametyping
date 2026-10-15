// Waiting out a cut connection in the middle of a download or an upload (apps/download-disk.js, fs-upload.js): what
// counts as a cut, how long to wait before each new try, and waiting for the page's socket to be back.
import * as net from './net.js';

// what the connection or the agent going away says (fs.js, server/fs-relay.js): worth trying again
export const CUT = /连接断了|没有回应|断开了|不在线|发送失败|太多/;
export const WAIT = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000];   // ms before each new try

export const online = (isStopped) => new Promise((resolve) => {
  if (net.state.online) return resolve();
  const off = net.on('status', (up) => { if (up) { off(); clearInterval(t); resolve(); } });
  const t = setInterval(() => { if (isStopped()) { off(); clearInterval(t); resolve(); } }, 500);
});
export const pause = (ms, isStopped) => new Promise((resolve) => {
  const t0 = Date.now(), t = setInterval(() => { if (isStopped() || Date.now() - t0 >= ms) { clearInterval(t); resolve(); } }, 200);
});
