// Relays the file explorer between a browser and a machine's agent. Nothing is stored: every chunk of a file is
// passed straight on. The agent keeps at most a few chunks in flight and the server acknowledges a chunk only once
// the browser's socket has drained, so a slow phone never makes the server hold a whole file.
// Every request needs a code entered within the hour, as acting on a machine does (else {ok:false, need:'totp'}).
//   browser -> {t:'fs', rid, machine, op:'roots'|'list'|'read', path, dl?, from?}, {t:'fs-cancel', rid}
//   agent   -> {t:'fs-res'|'fs-chunk'|'fs-end', rid, ...}   (the server's rid; answered to the asking browser only)
//   browser -> {t:'fs', rid, machine, op:'locate', path, session, at}   where a path named in a conversation is
// Uploads, to a machine whose agent allows them (agent/fs-upload.js), the other way round: the browser keeps a few
// pieces in flight and sends the next as the agent says it has written one, so here too nothing piles up.
//   browser -> {t:'fs', rid, machine, op:'up-open', path, name, size, mtime, overwrite}, {t:'fs-up', rid, off, data},
//              {t:'fs-up-end', rid, crc}, {t:'fs-cancel', rid, drop}
//   agent   -> {t:'fs-res', rid, ok, have}, {t:'fs-up-ack', rid, have}, {t:'fs-up-done', rid, ok, ...}
'use strict';
const crypto = require('crypto');

const OPS = new Set(['roots', 'list', 'read', 'up-open', 'locate']);
const IDLE_MS = 60e3;                     // a request the agent stopped answering
const DRAIN = 4 * 1024 * 1024;            // browser socket backlog before chunks are held back
const MAX_READS = 4;                      // files one browser reads at a time
const MAX_UPS = 2;                        // ... and uploads

// fresh(c): that browser's login entered a code lately
function createFsRelay({ machines, audit, fresh }) {
  const reqs = new Map();                 // srid -> { c, crid, machine, op, last }

  const toBrowser = (r, o) => { try { r.c.ws.send(JSON.stringify({ ...o, rid: r.crid })); } catch {} };
  const agentSock = (name) => { const m = machines.get(name); return m && m.online && m.sockets && m.sockets.size ? [...m.sockets].pop() : null; };
  const toAgent = (name, o) => { const s = agentSock(name); if (!s) return false; try { s.send(JSON.stringify(o)); return true; } catch { return false; } };
  function end(srid, err) {
    const r = reqs.get(srid); if (!r) return;
    reqs.delete(srid);
    if (err) toBrowser(r, { t: 'fs-res', ok: false, msg: err });
  }

  function fromBrowser(c, d) {
    if (d.t === 'fs-cancel') {
      for (const [srid, r] of reqs) if (r.c === c && r.crid === d.rid) { toAgent(r.machine, { t: 'fs-cancel', rid: srid, ...(d.drop === true ? { drop: true } : {}) }); reqs.delete(srid); }
      return;
    }
    // the pieces of an upload, and its end: on to the agent under the server's rid
    if (d.t === 'fs-up' || d.t === 'fs-up-end') {
      for (const [srid, r] of reqs) {
        if (r.c !== c || r.crid !== d.rid || r.op !== 'up-open') continue;
        r.last = Date.now();
        if (d.t === 'fs-up' && Number.isSafeInteger(d.off) && typeof d.data === 'string') toAgent(r.machine, { t: 'fs-up', rid: srid, off: d.off, data: d.data });
        else if (d.t === 'fs-up-end') toAgent(r.machine, { t: 'fs-up-end', rid: srid, ...(Number.isInteger(d.crc) ? { crc: d.crc } : {}) });
      }
      return;
    }
    const reply = (msg, need) => { try { c.ws.send(JSON.stringify({ t: 'fs-res', rid: d.rid, ok: false, msg, need })); } catch {} };
    if (!OPS.has(d.op) || typeof d.machine !== 'string' || (d.op !== 'roots' && (typeof d.path !== 'string' || d.path.length > 4096))) return reply('无效请求');
    if (d.op === 'up-open' && (typeof d.name !== 'string' || !d.name || d.name.length > 255 || !Number.isSafeInteger(d.size) || d.size < 0)) return reply('无效请求');
    const m = machines.get(d.machine);
    if (!m || !agentSock(d.machine)) return reply('这台电脑不在线');
    if (!m.files) return reply('这台电脑没开放文件浏览');
    if (d.op === 'up-open' && !m.upload) return reply('这台电脑没开放上传');
    // like acting on a machine, its files need a code entered within the hour (auth.FRESH_MS): asked for and the same
    // request sent again (nothing of it is kept here). Checked as each one starts: one already going runs on.
    if (!fresh(c)) return reply('需要再输一次验证码', 'totp');
    const mine = (op) => [...reqs.values()].filter((r) => r.c === c && r.op === op).length;
    if (d.op === 'read' && mine('read') >= MAX_READS) return reply('同时打开的文件太多，稍后再试');
    if (d.op === 'up-open' && mine('up-open') >= MAX_UPS) return reply('同时上传的文件太多，稍后再试');
    const srid = crypto.randomBytes(12).toString('hex');
    reqs.set(srid, { c, crid: d.rid, machine: d.machine, op: d.op, last: Date.now() });
    if (d.op === 'read') audit('fs-read', c.ip, d.machine, d.path.slice(0, 300));
    if (d.op === 'up-open') audit('fs-upload', c.ip, d.machine, (d.path + ' ← ' + d.name).slice(0, 300), d.size);
    // (a read may be a download to disk, dl, and carry on from a byte, from: the agent checks and says back where)
    const more = d.op === 'read' ? { ...(d.dl === true ? { dl: true } : {}), ...(Number.isSafeInteger(d.from) && d.from > 0 ? { from: d.from } : {}) }
      : d.op === 'up-open' ? { name: d.name, size: d.size, mtime: Number.isFinite(d.mtime) ? d.mtime : 0, overwrite: d.overwrite === true }
      : d.op === 'locate' ? { session: typeof d.session === 'string' && /^(codex:|opencode:)?[\w-]{1,80}$/.test(d.session) ? d.session : undefined, at: Number.isFinite(d.at) ? d.at : undefined } : {};
    if (!toAgent(d.machine, { t: 'fs', rid: srid, op: d.op, path: d.path, ...more })) end(srid, '发送失败');
  }

  function fromAgent(m, d) {
    const r = reqs.get(d.rid);
    if (!r || r.machine !== m.name) return;
    r.last = Date.now();
    const { rid, ...rest } = d;
    toBrowser(r, rest);
    if (d.t === 'fs-res' && (!d.ok || (r.op !== 'read' && r.op !== 'up-open'))) return end(d.rid);
    if (d.t === 'fs-end' || d.t === 'fs-up-done') return end(d.rid);
    if (d.t === 'fs-chunk') {
      // acknowledge once the browser has taken it in (flow control back to the agent)
      const ack = () => {
        if (!reqs.has(d.rid)) return;
        if (r.c.ws.bufferedAmount > DRAIN) return setTimeout(ack, 50);
        toAgent(r.machine, { t: 'fs-ack', rid: d.rid, i: d.i });
      };
      ack();
    }
  }

  // a browser went away: stop whatever it was reading (an upload's part stays on the machine, to be carried on)
  function dropClient(c) {
    for (const [srid, r] of reqs) if (r.c === c) { toAgent(r.machine, { t: 'fs-cancel', rid: srid }); reqs.delete(srid); }
  }
  // a machine went away: its requests fail
  function dropMachine(name) { for (const [srid, r] of reqs) if (r.machine === name) end(srid, '这台电脑断开了'); }

  setInterval(() => {
    const now = Date.now();
    for (const [srid, r] of reqs) if (now - r.last > IDLE_MS) { toAgent(r.machine, { t: 'fs-cancel', rid: srid }); end(srid, '那台电脑没有回应'); }
  }, 10e3).unref();

  return { fromBrowser, fromAgent, dropClient, dropMachine };
}

module.exports = { createFsRelay };
