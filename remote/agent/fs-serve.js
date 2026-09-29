// Answers the server's file requests for the dashboard's explorer (files.js does the access checks):
//   {t:'fs', rid, op:'roots'|'list'}      -> {t:'fs-res', rid, ok, ...}
//   {t:'fs', rid, op:'read', path}         -> {t:'fs-res', rid, ok, size, path}, then {t:'fs-chunk', rid, i, data(base64)}...,
//                                             then {t:'fs-end', rid}
//   {t:'fs-ack', rid, i}                   the server passed chunk i on: at most WINDOW chunks travel unacknowledged
//   {t:'fs-cancel', rid}                   stop reading
'use strict';
const CHUNK = 512 * 1024;
const WINDOW = 8;
const STALL_MS = 60e3;

function createFsServe(files, send) {
  const reads = new Map();                 // rid -> { stream, sent, acked, timer }

  function stop(rid) {
    const r = reads.get(rid); if (!r) return;
    reads.delete(rid); clearTimeout(r.timer);
    try { r.stream.destroy(); } catch {}
  }
  const fail = (rid, e) => send({ t: 'fs-res', rid, ok: false, msg: String(e && e.message || e || '失败').slice(0, 200) });

  async function read(rid, p) {
    let f;
    try { f = await files.open(p, CHUNK); } catch (e) { return fail(rid, e); }
    const r = { stream: f.stream, sent: 0, acked: -1, timer: null };
    reads.set(rid, r);
    const stall = () => { clearTimeout(r.timer); r.timer = setTimeout(() => stop(rid), STALL_MS); };   // nobody is taking it
    send({ t: 'fs-res', rid, ok: true, size: f.size, path: f.path });
    stall();
    f.stream.on('data', (buf) => {
      send({ t: 'fs-chunk', rid, i: r.sent++, data: buf.toString('base64') });
      if (r.sent - 1 - r.acked >= WINDOW) f.stream.pause();
    });
    f.stream.on('end', () => { if (reads.has(rid)) { send({ t: 'fs-end', rid }); stop(rid); } });
    f.stream.on('error', (e) => { if (reads.has(rid)) { fail(rid, e.code === 'EBUSY' || e.code === 'EPERM' ? '文件被占用或没有权限' : '读取失败'); stop(rid); } });
    r.ack = (i) => { r.acked = Math.max(r.acked, i); stall(); if (r.sent - 1 - r.acked < WINDOW && f.stream.isPaused()) f.stream.resume(); };
  }

  async function handle(d) {
    if (d.t === 'fs-ack') { const r = reads.get(d.rid); if (r && r.ack && Number.isInteger(d.i)) r.ack(d.i); return; }
    if (d.t === 'fs-cancel') return stop(d.rid);
    if (d.t !== 'fs' || typeof d.rid !== 'string') return;
    if (!files.enabled) return fail(d.rid, '这台电脑没开放文件浏览（agent.json 里设 "files"）');
    try {
      if (d.op === 'roots') send({ t: 'fs-res', rid: d.rid, ok: true, roots: await files.roots() });
      else if (d.op === 'list') send({ t: 'fs-res', rid: d.rid, ok: true, ...(await files.list(d.path)) });
      else if (d.op === 'read') await read(d.rid, d.path);
      else fail(d.rid, '无效请求');
    } catch (e) { fail(d.rid, e); }
  }
  const stopAll = () => { for (const rid of [...reads.keys()]) stop(rid); };
  return { handle, stopAll };
}

module.exports = { createFsServe };
