// Files uploaded from the dashboard's explorer into a folder here (files.js decides where they may go):
//   {t:'fs', rid, op:'up-open', path: folder, name, size, mtime, overwrite}
//        -> {t:'fs-res', rid, ok, have, path}   have: bytes already here from an upload of the same file that was cut
//           off (it carries on from there); {ok:false, exists:true} when there is a file of that name and no overwrite
//   {t:'fs-up', rid, off, data(base64)}     the next piece, at byte off -> {t:'fs-up-ack', rid, have} once written
//   {t:'fs-up-end', rid, crc}               all sent -> the CRC-32 of the whole file checked, then it takes its name:
//                                              {t:'fs-up-done', rid, ok, path}
//   {t:'fs-cancel', rid, drop}              stop; drop: and throw away what came (else it stays, to be carried on)
// Until it is whole it is written beside the target as ".<name>.<size>.ame-upload", so nothing half-written ever has the
// name, and the same file uploaded again finds it. Pieces come one after another; the browser keeps a few in flight.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const IDLE_MS = 10 * 60e3;               // nothing heard for this long: closed (what came stays)
const MAX = 512 * 1024;                   // bytes in one piece at most

// CRC-32 of a file (zlib's own where there is one: Node 22.2+)
let TABLE = null;
function crcOf(buf, crc) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  if (!TABLE) { TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; } }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function fileCrc(p, tick) {
  let crc = 0, n = 0;
  for await (const buf of fs.createReadStream(p, { highWaterMark: 1024 * 1024 })) { crc = crcOf(buf, crc); if (++n % 64 === 0) tick(); }
  return crc >>> 0;
}

function createFsUpload(files, send) {
  const ups = new Map();                  // rid -> { fh, part, final, size, mtime, next, have, q, timer }
  const fail = (rid, e, more = {}) => send({ t: 'fs-res', rid, ok: false, msg: String(e && e.message || e || '失败').slice(0, 200), ...more });
  const done = (rid, ok, msg, p) => send({ t: 'fs-up-done', rid, ok, ...(msg ? { msg } : {}), ...(p ? { path: p } : {}) });

  async function close(rid, drop = false) {
    const u = ups.get(rid); if (!u) return;
    ups.delete(rid); clearTimeout(u.timer);
    try { await u.q; } catch {}
    try { await u.fh.close(); } catch {}
    if (drop) { try { await fsp.unlink(u.part); } catch {} }
  }
  const idle = (rid, u) => { clearTimeout(u.timer); u.timer = setTimeout(() => close(rid), IDLE_MS); };

  async function open(d) {
    const size = d.size, mtime = d.mtime;
    if (!Number.isSafeInteger(size) || size < 0) return fail(d.rid, '无效请求');
    let t;
    try { t = await files.target(d.path, d.name); } catch (e) { return fail(d.rid, e); }
    if (t.exists && d.overwrite !== true) return fail(d.rid, '那里已经有同名的文件', { exists: true });
    const part = path.join(t.dir, `.${d.name}.${size}.ame-upload`);
    let have = 0;
    try { const st = await fsp.stat(part); have = st.size <= size ? st.size : 0; } catch {}
    // (room for the rest, where the system can tell)
    try { if (fsp.statfs) { const s = await fsp.statfs(t.dir); if (s.bavail * s.bsize < size - have) return fail(d.rid, '那台电脑的磁盘空间不够'); } } catch {}
    let fh;
    try { fh = await fsp.open(part, have ? 'r+' : 'w'); await fh.truncate(have); }
    catch (e) { return fail(d.rid, e.code === 'EACCES' || e.code === 'EPERM' ? '没有权限写这个文件夹' : '写不了这个文件夹'); }
    const u = { fh, part, final: t.path, size, mtime, overwrite: d.overwrite === true, next: have, have, q: Promise.resolve(), timer: null };
    ups.set(d.rid, u); idle(d.rid, u);
    send({ t: 'fs-res', rid: d.rid, ok: true, have, path: t.path });
  }

  function piece(d) {
    const u = ups.get(d.rid); if (!u) return;
    const buf = typeof d.data === 'string' ? Buffer.from(d.data, 'base64') : null;
    if (!buf || d.off !== u.next || buf.length > MAX || u.next + buf.length > u.size) { done(d.rid, false, '上传的数据乱了，请重试'); return close(d.rid); }
    const at = u.next; u.next += buf.length;
    idle(d.rid, u);
    u.q = u.q.then(() => u.fh.write(buf, 0, buf.length, at)).then(() => {
      u.have = at + buf.length;
      send({ t: 'fs-up-ack', rid: d.rid, have: u.have });
    }, (e) => { if (ups.has(d.rid)) { done(d.rid, false, e.code === 'ENOSPC' ? '那台电脑的磁盘满了' : '写入失败'); close(d.rid); } throw e; });
    u.q.catch(() => {});
  }

  async function end(d) {
    const u = ups.get(d.rid); if (!u) return;
    clearTimeout(u.timer);
    try { await u.q; } catch { return; }
    if (u.have !== u.size) { done(d.rid, false, '文件没有传完'); return close(d.rid); }
    ups.delete(d.rid);
    try {
      await u.fh.sync(); await u.fh.close();
      // (the check can take a while for a large file: the server hears from here meanwhile, or it gives up waiting)
      const crc = await fileCrc(u.part, () => send({ t: 'fs-up-ack', rid: d.rid, have: u.have, checking: true }));
      if (Number.isInteger(d.crc) && crc !== d.crc >>> 0) { await fsp.unlink(u.part).catch(() => {}); return done(d.rid, false, '校验不一致，文件在路上出了错，请重新上传'); }
      let there = false; try { await fsp.stat(u.final); there = true; } catch {}
      if (there && !u.overwrite) return done(d.rid, false, '上传期间那里出现了同名的文件，没有覆盖（已传的内容留着，可再上传一次选覆盖）');
      await fsp.rename(u.part, u.final);
      if (Number.isFinite(u.mtime) && u.mtime > 0) await fsp.utimes(u.final, new Date(), new Date(u.mtime)).catch(() => {});
      done(d.rid, true, '', u.final);
    } catch (e) { done(d.rid, false, e.code === 'EBUSY' || e.code === 'EPERM' ? '同名文件正被占用，替换不了' : '保存失败'); }
  }

  function handle(d) {
    if (d.t === 'fs' && d.op === 'up-open') return open(d).catch((e) => fail(d.rid, e));
    if (d.t === 'fs-up') return piece(d);
    if (d.t === 'fs-up-end') return end(d);
    if (d.t === 'fs-cancel') return close(d.rid, d.drop === true);
  }
  const stopAll = () => { for (const rid of [...ups.keys()]) close(rid); };
  return { handle, stopAll };
}

module.exports = { createFsUpload };
