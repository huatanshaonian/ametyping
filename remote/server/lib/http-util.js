// Shared HTTP body readers, proxy CONNECT tunnel, and input sanitizers for remote/server.
'use strict';
const net = require('net');
const tls = require('tls');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function cleanStr(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function normalizeStrArray(arr, maxLen = 40, itemMax = 300) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const s = cleanStr(x, itemMax);
    if (s && !out.includes(s)) {
      out.push(s);
      if (out.length >= maxLen) break;
    }
  }
  return out;
}

// Reads a UTF-8 request body up to `cap` bytes without multi-byte chunk-boundary corruption
// or hung Promises when clients disconnect early or exceed `cap`.
function readBody(req, cap = 65536, { overValue = '' } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let over = Number(req.headers && req.headers['content-length']) > cap;
    let settled = false;
    const hardCap = Math.max(cap * 4, 1024 * 1024);
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      bytes += buf.length;
      if (bytes > cap) {
        over = true;
        chunks.length = 0;
        if (bytes > hardCap) {
          finish(overValue);
          setImmediate(() => { try { req.destroy(); } catch {} });
        }
        return;
      }
      if (!over) chunks.push(buf);
    });
    req.on('end', () => finish(over ? overValue : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(''));
    req.on('close', () => finish(over ? overValue : ''));
  });
}

async function readJsonBody(req, cap = 65536, fallback = {}) {
  const raw = await readBody(req, cap, { overValue: '' });
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Reads a binary request body up to `cap` bytes; returns null when oversize, empty Buffer on abort/error.
function readBytes(req, cap) {
  return new Promise((resolve) => {
    const hardCap = Math.max(cap + 4 * 1024 * 1024, cap * 2);
    const parts = [];
    let bytes = 0;
    let over = Number(req.headers && req.headers['content-length']) > cap;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    if (over) req.resume();
    req.on('data', (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length;
      if (over) {
        if (bytes > hardCap) {
          finish(null);
          setImmediate(() => { try { req.destroy(); } catch {} });
        }
        return;
      }
      if (bytes > cap) {
        over = true;
        parts.length = 0;
        return;
      }
      parts.push(buf);
    });
    req.on('end', () => finish(over ? null : Buffer.concat(parts)));
    req.on('error', () => finish(Buffer.alloc(0)));
    req.on('close', () => finish(over ? null : Buffer.alloc(0)));
  });
}

// HTTP CONNECT proxy -> TLS socket tunnel with EOF/close guard and header size cap.
function connectTunnel(proxyUrl, host, port = 443, { timeoutMs = 20000, timeoutMsg = '代理连接超时' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxyUrl); } catch { return reject(new Error('代理地址无效')); }
    const s = net.connect(Number(u.port || 80), u.hostname);
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      s.destroy();
      reject(e);
    };
    const onClose = () => fail(new Error('代理连接提前关闭'));
    s.setTimeout(timeoutMs, () => fail(new Error(timeoutMsg)));
    s.once('error', fail);
    s.once('close', onClose);
    s.once('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (head.length > 16384 && !head.includes('\r\n\r\n')) {
        return fail(new Error('代理响应头过大'));
      }
      if (!head.includes('\r\n\r\n')) return;
      s.removeListener('data', onData);
      s.removeListener('error', fail);
      s.removeListener('close', onClose);
      s.setTimeout(0);
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
        return fail(new Error('代理拒绝了连接：' + head.split('\r\n')[0]));
      }
      done = true;
      resolve(tls.connect({ socket: s, servername: host }));
    };
    s.on('data', onData);
  });
}

// Validates a "data:image/png;base64,..." payload and extracts dimensions from the IHDR header.
function parsePngDataUrl(dataUrl, { maxBytes = 8e6, minDim = 16, maxDim = 8000 } = {}) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 33 || buf.length > maxBytes || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w >= minDim && h >= minDim && w <= maxDim && h <= maxDim ? { buf, w, h } : null;
}

module.exports = {
  cleanStr,
  normalizeStrArray,
  readBody,
  readJsonBody,
  readBytes,
  connectTunnel,
  parsePngDataUrl,
};
