// Local HTTP proxy (CONNECT only) on 127.0.0.1:1057 in front of the ssh -D SOCKS5 tunnel to aws1 (127.0.0.1:1058).
// Some clients (Codex's HTTP stack) fail against OpenSSH's SOCKS server directly; an HTTP proxy is also what the
// PC's v2rayN offers, so every user of the NAS's way out speaks one protocol. Run by egress.sh.
'use strict';
const net = require('net');

const LISTEN = Number(process.env.AME_EGRESS_HTTP_PORT || 1057);
const SOCKS = Number(process.env.AME_EGRESS_SOCKS_PORT || 1058);
const PORTS = new Set([443, 80]);
const HANDSHAKE_TIMEOUT_MS = Number(process.env.AME_EGRESS_HANDSHAKE_MS || 15000);

// read exactly n bytes from a socket (buffering what arrives early; rejects on close/error/timeout)
function reader(sock, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  let buf = Buffer.alloc(0), want = null, dead = null;
  const fail = (err) => {
    if (dead) return;
    dead = err || new Error('socket closed');
    if (want) { const w = want; want = null; w.reject(dead); }
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  const onEnd = () => fail(new Error('socket ended'));
  const onClose = () => fail(new Error('socket closed'));
  const onError = (e) => fail(e || new Error('socket error'));
  const onTimeout = () => { fail(new Error('handshake timeout')); sock.destroy(); };
  sock.on('data', onData);
  sock.once('end', onEnd);
  sock.once('close', onClose);
  sock.once('error', onError);
  if (timeoutMs > 0) sock.setTimeout(timeoutMs, onTimeout);
  function pump() {
    if (want && buf.length >= want.n) { const w = want; want = null; const out = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(out); }
  }
  return {
    read: (n) => new Promise((resolve, reject) => {
      if (buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); return resolve(out); }
      if (dead) return reject(dead);
      want = { n, resolve, reject };
    }),
    rest: () => {
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('close', onClose);
      sock.off('error', onError);
      sock.off('timeout', onTimeout);
      sock.setTimeout(0);
      return buf;
    },
  };
}

// open host:port through the SOCKS5 server, resolving the name on the far side
async function socksConnect(host, port) {
  const s = net.connect(SOCKS, '127.0.0.1');
  try {
    s.setTimeout(HANDSHAKE_TIMEOUT_MS);
    await new Promise((ok, fail) => {
      const done = (fn, arg) => { s.off('connect', onConn); s.off('error', onErr); s.off('timeout', onTo); fn(arg); };
      const onConn = () => done(ok);
      const onErr = (e) => done(fail, e);
      const onTo = () => done(fail, new Error('socks connect timeout'));
      s.once('connect', onConn);
      s.once('error', onErr);
      s.once('timeout', onTo);
    });
    const r = reader(s, HANDSHAKE_TIMEOUT_MS);
    s.write(Buffer.from([5, 1, 0]));
    const hello = await r.read(2);
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error('socks: no acceptable auth');
    const name = Buffer.from(host);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const head = await r.read(4);
    if (head[1] !== 0) throw new Error('socks: connect failed (' + head[1] + ')');
    const alen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await r.read(1))[0];
    await r.read(alen + 2);
    return { sock: s, early: r.rest() };
  } catch (e) {
    s.destroy();
    throw e;
  }
}

const server = net.createServer((c) => {
  const r = reader(c, HANDSHAKE_TIMEOUT_MS);
  let line = Buffer.alloc(0);
  (async () => {
    // request head up to the blank line (small; refuse anything large)
    while (!line.includes('\r\n\r\n')) { line = Buffer.concat([line, await r.read(1)]); if (line.length > 8192) throw new Error('head too large'); }
    const m = /^CONNECT ([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d+) HTTP\/1\.[01]\r\n/.exec(line.toString('latin1'));
    if (!m) { c.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); return; }
    const host = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2]);
    if (!PORTS.has(port)) { c.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    let up;
    try { up = await socksConnect(host, port); }
    catch (e) {
      console.error(`[http-socks] 502 ${host}:${port}: ${(e && (e.code || e.message)) || e}`);
      c.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const pending = r.rest();
    if (c.destroyed) { up.sock.destroy(); return; }
    c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (up.early.length) c.write(up.early);
    if (pending.length) up.sock.write(pending);
    c.pipe(up.sock).pipe(c);
    up.sock.on('error', () => c.destroy());
    up.sock.on('close', () => c.destroy());
    c.on('error', () => up.sock.destroy());
    c.on('close', () => up.sock.destroy());
  })().catch(() => c.destroy());
  c.on('error', () => {});
});
server.listen(LISTEN, '127.0.0.1');
