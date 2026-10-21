// A file from this device uploaded into a folder on a remote computer (我的电脑's 上传; agent/fs-upload.js writes
// it). Read from the disk here a piece at a time (File.slice: never the whole file in memory), so any size goes.
// WINDOW pieces travel unacknowledged; each acknowledgement -- the agent has written that much -- lets the next one go.
// The CRC-32 of everything sent goes with the end, and the agent checks the file it got against it.
// Cut off halfway (the page's socket, the agent): it waits for the connection and carries on where the agent says its
// part file ends -- the CRC of that much is read again from the file here. The same file uploaded again later (same
// name and size into the same folder) carries on the same way.
import * as net from './net.js';
import { crc32 } from './apps/zip.js';
import { CUT, WAIT, online, pause, stepUp } from './fs-retry.js';

const CHUNK = 256 * 1024;                 // (base64 of it under the server's 512 KB a message)
const WINDOW = 8;
const pending = new Map();                // rid -> handler(message)
let n = 0;
net.on('fs', (d) => { const f = pending.get(d.rid); if (f) f(d); });
net.on('status', (up) => { if (!up) for (const f of [...pending.values()]) f({ t: 'fs-res', ok: false, msg: '连接断了' }); });

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function crcOf(file, len, gone) {
  let crc = 0;
  for (let off = 0; off < len && !gone(); off += 4 * CHUNK) crc = crc32(new Uint8Array(await file.slice(off, Math.min(len, off + 4 * CHUNK)).arrayBuffer()), crc);
  return crc;
}

// one go at it: -> { ok, path } | { ok:false, msg, exists?, local? }
function attempt(machine, dir, file, overwrite, progress, isStopped, onRid) {
  return new Promise((resolve) => {
    const rid = 'u' + (++n) + '-' + Date.now().toString(36);
    let opened = false, ending = false, busy = false, sent = 0, acked = 0, crc = 0;
    const finish = (r) => { if (!pending.has(rid)) return; pending.delete(rid); resolve(r); };
    onRid(rid, () => finish({ ok: false, msg: '已取消' }));
    async function pump() {
      if (busy) return;
      busy = true;
      try {
        while (pending.has(rid) && !isStopped() && sent < file.size && sent - acked < WINDOW * CHUNK) {
          const off = sent, buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
          if (!pending.has(rid)) return;
          crc = crc32(buf, crc); sent += buf.length;
          net.send({ t: 'fs-up', rid, off, data: b64(buf) });       // ("t" first: the server knows a piece by its start)
        }
        if (pending.has(rid) && !ending && acked === file.size) { ending = true; progress(file.size, file.size, true); net.send({ t: 'fs-up-end', rid, crc }); }
      } catch (e) {
        net.send({ t: 'fs-cancel', rid });
        finish({ ok: false, msg: '读不了这台设备上的文件（' + ((e && e.message) || e) + '）', local: true });
      } finally { busy = false; }
    }
    const open = { t: 'fs', rid, machine, op: 'up-open', path: dir, name: file.name, size: file.size, mtime: file.lastModified, overwrite };
    pending.set(rid, async (d) => {
      if (stepUp(d, open, () => pending.has(rid) && !isStopped(), finish)) return;
      if (d.t === 'fs-res') {
        if (!d.ok) return finish({ ok: false, msg: d.msg || '上传失败', exists: d.exists === true });
        if (opened) return;
        opened = true;
        const have = d.have || 0;
        if (have) { progress(have, file.size, false); crc = await crcOf(file, have, () => !pending.has(rid)); }
        sent = acked = have;
        progress(have, file.size, false);
        pump();
      } else if (d.t === 'fs-up-ack') {
        if (d.checking) return progress(file.size, file.size, true);
        acked = Math.max(acked, d.have || 0);
        progress(acked, file.size, false);
        pump();
      } else if (d.t === 'fs-up-done') finish(d.ok ? { ok: true, path: d.path } : { ok: false, msg: d.msg || '上传失败' });
    });
    net.send(open);
  });
}

// progress(bytes there, size, checking: the agent is checking the whole); waiting(text) while it waits to carry on.
// -> { promise -> { ok, path } | { ok:false, msg, exists? }, cancel (what came is thrown away) }
export function upload(machine, dir, file, { overwrite = false, progress = () => {}, waiting = () => {} } = {}) {
  let stopped = false, cur = null;
  const isStopped = () => stopped;
  async function run() {
    for (let tries = 0; ; tries++) {
      const r = await attempt(machine, dir, file, overwrite, progress, isStopped, (rid, stop) => { cur = { rid, stop }; });
      cur = null;
      if (stopped) return { ok: false, msg: '已取消' };
      if (r.ok || r.local || r.exists || !CUT.test(r.msg || '') || tries >= WAIT.length) return r;
      waiting(`${r.msg}，等连上后接着上传…`);
      await online(isStopped);
      await pause(WAIT[tries], isStopped);
      if (stopped) return { ok: false, msg: '已取消' };
    }
  }
  return { promise: run(), cancel: () => { stopped = true; if (cur) { net.send({ t: 'fs-cancel', rid: cur.rid, drop: true }); cur.stop(); } } };
}
