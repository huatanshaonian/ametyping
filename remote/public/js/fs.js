// File access on a remote computer through its agent (read-only): list roots and folders, read a file in chunks.
import * as net from './net.js';

const pending = new Map();                // rid -> handler(message)
let n = 0;
net.on('fs', (d) => { const f = pending.get(d.rid); if (f) f(d); });
// a lost connection ends every request
net.on('status', (up) => { if (!up) for (const f of [...pending.values()]) f({ t: 'fs-res', ok: false, msg: '连接断了' }); });

function request(machine, op, path) {
  return new Promise((resolve) => {
    const rid = 'f' + (++n) + '-' + Date.now().toString(36);
    pending.set(rid, (d) => { pending.delete(rid); resolve(d.ok ? d : { ok: false, msg: d.msg || '失败' }); });
    net.send({ t: 'fs', rid, machine, op, path });
  });
}
export const roots = (machine) => request(machine, 'roots');
export const list = (machine, path) => request(machine, 'list', path);

// read a whole file: { promise -> { ok, blob, size, path } | { ok:false, msg }, cancel() }; onProgress(received, size)
export function read(machine, path, onProgress, type = '') {
  const rid = 'r' + (++n) + '-' + Date.now().toString(36);
  const parts = [];
  let size = 0, got = 0, done;
  const promise = new Promise((resolve) => { done = resolve; });
  const finish = (r) => { pending.delete(rid); done(r); };
  pending.set(rid, (d) => {
    if (d.t === 'fs-res') {
      if (!d.ok) return finish({ ok: false, msg: d.msg || '读取失败' });
      size = d.size; onProgress && onProgress(0, size);
      if (size === 0) { /* the end message follows */ }
    } else if (d.t === 'fs-chunk') {
      const bin = atob(d.data), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      parts.push(buf); got += buf.length;
      onProgress && onProgress(got, size);
    } else if (d.t === 'fs-end') finish({ ok: true, blob: new Blob(parts, { type }), size: got, path });
  });
  net.send({ t: 'fs', rid, machine, op: 'read', path });
  return { promise, cancel: () => { if (pending.has(rid)) { net.send({ t: 'fs-cancel', rid }); finish({ ok: false, msg: '已取消' }); } } };
}
