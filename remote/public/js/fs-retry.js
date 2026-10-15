// Waiting out a cut connection in the middle of a download or an upload (apps/download-disk.js, fs-upload.js): what
// counts as a cut, how long to wait before each new try, and waiting for the page's socket to be back. And the code
// asked for again before any file request (fs.js, fs-upload.js).
import * as net from './net.js';
import { askCode } from './gate.js';

// A remote computer's files need a code entered within the hour (server/fs-relay.js); a request turned away for it
// ({ need: 'totp' }) asks for the code and sends the same request again -- true when it did. live(): still wanted
// (cut off or cancelled meanwhile: nothing sent); a cancelled code ends it with fail({ msg: '已取消' }).
export function stepUp(d, open, live, fail) {
  if (d.t !== 'fs-res' || d.ok || d.need !== 'totp') return false;
  askCode().then((ok) => { if (!live()) return; if (ok) net.send(open); else fail({ ok: false, msg: '已取消' }); });
  return true;
}

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
