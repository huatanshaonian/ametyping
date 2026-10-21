// File access on a remote computer through its agent (read-only): list roots and folders, read a file in chunks.
// Each needs a code entered within the hour: asked for here when the server says so, then sent again.
import * as net from './net.js';
import { stepUp } from './fs-retry.js';

const pending = new Map();                // rid -> handler(message)
let n = 0;
net.on('fs', (d) => { const f = pending.get(d.rid); if (f) f(d); });
// a lost connection ends every request
net.on('status', (up) => { if (!up) for (const f of [...pending.values()]) f({ t: 'fs-res', ok: false, msg: '连接断了' }); });

function request(machine, op, path, more = {}) {
  return new Promise((resolve) => {
    const rid = 'f' + (++n) + '-' + Date.now().toString(36), open = { t: 'fs', rid, machine, op, path, ...more };
    const done = (d) => { pending.delete(rid); resolve(d.ok ? d : { ok: false, msg: d.msg || '失败' }); };
    pending.set(rid, (d) => { if (!stepUp(d, open, () => pending.has(rid), done)) done(d); });
    net.send(open);
  });
}
export const roots = (machine) => request(machine, 'roots');
export const list = (machine, path) => request(machine, 'list', path);
// where a path named in a session's conversation is (agent/locate.js): -> { ok, found: [{ path, how }] } | { ok:false, msg }
export const locate = (machine, path, session, at) => request(machine, 'locate', path, { session, at });

// read a whole file: { promise -> { ok, blob, size, path } | { ok:false, msg }, cancel() }; onProgress(received, size)
// A download straight to disk (download-disk.js) passes { dl: true, from, start(info), sink(bytes) } instead: no
// 100 MB limit, starting at byte from; start({ size, mtime, from }) when the agent has opened it (from: where it really
// starts -- 0 from an agent that cannot resume), sink(bytes) for each piece in turn, nothing kept here; both may be
// async (taken one after another) and throw to stop. Then the promise gives { ok, size: bytes received }.
export function read(machine, path, onProgress, type = '', { dl = false, from = 0, start = null, sink = null } = {}) {
  const rid = 'r' + (++n) + '-' + Date.now().toString(36);
  const parts = [];
  let size = 0, got = 0, done, chain = Promise.resolve();
  const promise = new Promise((resolve) => { done = resolve; });
  // (to disk: over only once what came has been written, however it ends -- a resumed read starts after it; a write
  // that failed is the reason, local: true)
  const finish = (r) => {
    if (!pending.has(rid)) return;
    pending.delete(rid);
    if (!sink) return done(r);
    chain.then(() => done(r), (e) => done({ ok: false, msg: (e && e.message) || '写入失败', local: true }));
  };
  const then = (fn) => {
    chain = chain.then(fn);
    chain.catch(() => { if (pending.has(rid)) { net.send({ t: 'fs-cancel', rid }); finish({ ok: false }); } });
  };
  const open = { t: 'fs', rid, machine, op: 'read', path, ...(dl ? { dl: true } : {}), ...(from > 0 ? { from } : {}) };
  pending.set(rid, (d) => {
    if (stepUp(d, open, () => pending.has(rid), finish)) return;
    if (d.t === 'fs-res') {
      if (!d.ok) return finish({ ok: false, msg: d.msg || '读取失败' });
      size = d.size; onProgress && onProgress(0, size);
      if (start) then(() => start({ size: d.size, mtime: d.mtime, from: d.from || 0 }));
    } else if (d.t === 'fs-chunk') {
      const bin = atob(d.data), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      got += buf.length;
      if (sink) then(() => sink(buf)); else parts.push(buf);
      onProgress && onProgress(got, size);
    } else if (d.t === 'fs-end') finish(sink ? { ok: true, size: got, path } : { ok: true, blob: new Blob(parts, { type }), size: got, path });
  });
  net.send(open);
  return { promise, cancel: () => { if (pending.has(rid)) { net.send({ t: 'fs-cancel', rid }); finish({ ok: false, msg: '已取消' }); } } };
}
