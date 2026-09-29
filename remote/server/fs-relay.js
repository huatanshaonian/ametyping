// Relays the file explorer between a browser and a machine's agent. Nothing is stored: every chunk of a file is
// passed straight on. The agent keeps at most a few chunks in flight and the server acknowledges a chunk only once
// the browser's socket has drained, so a slow phone never makes the server hold a whole file.
//   browser -> {t:'fs', rid, machine, op:'roots'|'list'|'read', path}, {t:'fs-cancel', rid}
//   agent   -> {t:'fs-res'|'fs-chunk'|'fs-end', rid, ...}   (the server's rid; answered to the asking browser only)
'use strict';
const crypto = require('crypto');

const OPS = new Set(['roots', 'list', 'read']);
const IDLE_MS = 60e3;                     // a request the agent stopped answering
const DRAIN = 4 * 1024 * 1024;            // browser socket backlog before chunks are held back
const MAX_READS = 4;                      // files one browser reads at a time

function createFsRelay({ machines, audit }) {
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
      for (const [srid, r] of reqs) if (r.c === c && r.crid === d.rid) { toAgent(r.machine, { t: 'fs-cancel', rid: srid }); reqs.delete(srid); }
      return;
    }
    const reply = (msg) => { try { c.ws.send(JSON.stringify({ t: 'fs-res', rid: d.rid, ok: false, msg })); } catch {} };
    if (!OPS.has(d.op) || typeof d.machine !== 'string' || (d.op !== 'roots' && (typeof d.path !== 'string' || d.path.length > 4096))) return reply('无效请求');
    const m = machines.get(d.machine);
    if (!m || !agentSock(d.machine)) return reply('这台电脑不在线');
    if (!m.files) return reply('这台电脑没开放文件浏览');
    if (d.op === 'read' && [...reqs.values()].filter((r) => r.c === c && r.op === 'read').length >= MAX_READS) return reply('同时打开的文件太多，稍后再试');
    const srid = crypto.randomBytes(12).toString('hex');
    reqs.set(srid, { c, crid: d.rid, machine: d.machine, op: d.op, last: Date.now() });
    if (d.op === 'read') audit('fs-read', c.ip, d.machine, d.path.slice(0, 300));
    if (!toAgent(d.machine, { t: 'fs', rid: srid, op: d.op, path: d.path })) end(srid, '发送失败');
  }

  function fromAgent(m, d) {
    const r = reqs.get(d.rid);
    if (!r || r.machine !== m.name) return;
    r.last = Date.now();
    const { rid, ...rest } = d;
    toBrowser(r, rest);
    if (d.t === 'fs-res' && (!d.ok || r.op !== 'read')) return end(d.rid);
    if (d.t === 'fs-end') return end(d.rid);
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

  // a browser went away: stop whatever it was reading
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
