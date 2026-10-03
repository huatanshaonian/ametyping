// A stand-in for Zotero 10's local API (http://127.0.0.1:<port>/api/) for the literature tests: a small library with
// collections, PDF attachments (their files written into a WebDAV folder as Zotero's sync would: <KEY>.zip + .prop) and
// annotations; /api/local/authorize hands out a key; writes need it and the Zotero-Server-ID; the upload flow
// (authorize -> upload -> register) puts the file into the WebDAV folder the way Zotero's sync would. Like the real one,
// it refuses a Host header without the port.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SERVER_ID = 'FAKESRV1';
const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
const newKey = () => Array.from({ length: 8 }, () => KEY_CHARS[crypto.randomInt(KEY_CHARS.length)]).join('');

// a zip with one deflated file (what Zotero's WebDAV sync writes)
function zipOne(name, buf) {
  const data = zlib.deflateRawSync(buf), nameB = Buffer.from(name, 'utf8');
  const crc = (() => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; })();
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(buf.length, 22); local.writeUInt16LE(nameB.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(buf.length, 24); central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(0, 42);
  const cdOff = 30 + nameB.length + data.length, cdLen = 46 + nameB.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdLen, 12); end.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, nameB, data, central, nameB, end]);
}
function toWebdav(dir, key, name, buf) {
  fs.writeFileSync(path.join(dir, key + '.zip'), zipOne(name, buf));
  fs.writeFileSync(path.join(dir, key + '.prop'), `<properties version="1"><mtime>${Date.now()}</mtime><hash>${crypto.createHash('md5').update(buf).digest('hex')}</hash></properties>`);
}

function createFakeZotero({ webdavDir, items = [], collections = [] }) {
  let version = 100;
  const objs = new Map();                              // key -> data
  const cols = new Map();
  let apiKey = '', denyAuthorize = false;
  const pending = new Map();
  const writes = [];                                   // what was written (for the checks)
  for (const c of collections) cols.set(c.key, { ...c, version });
  for (const d of items) objs.set(d.key, { version, dateAdded: new Date().toISOString(), dateModified: new Date().toISOString(), tags: [], collections: [], relations: {}, ...d });

  const send = (res, code, body, headers = {}) => {
    const b = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'Last-Modified-Version': String(version), 'Zotero-Server-ID': SERVER_ID, ...headers });
    res.end(b);
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (!/:\d+$/.test(String(req.headers.host || ''))) return send(res, 400, 'Bad request');
      if (req.method === 'POST' && p === '/api/local/authorize') {
        if (denyAuthorize) return send(res, 403, { denied: true });
        apiKey = crypto.randomBytes(16).toString('hex');
        return setTimeout(() => send(res, 200, { key: apiKey, remember: true }), 150);
      }
      if (req.method === 'POST' && p.startsWith('/api/local/uploads/')) {
        const up = pending.get(p.split('/').pop());
        if (!up) return send(res, 404, 'Unknown upload key');
        if (crypto.createHash('md5').update(body).digest('hex') !== up.md5) return send(res, 400, 'MD5 mismatch');
        up.buf = body; return send(res, 201, '');
      }
      const m = /^\/api\/users\/0\/(.*)$/.exec(p);
      if (!m) return send(res, 404, 'not found');
      const rest = m[1];
      if (req.method === 'GET') {
        if (rest === 'items/top') return send(res, 200, [...objs.values()].filter((d) => !d.parentItem && !['attachment', 'note', 'annotation'].includes(d.itemType)).slice(0, +u.searchParams.get('limit') || 1e9).map((d) => ({ key: d.key, version: d.version, data: d })));
        if (rest === 'items') return send(res, 200, [...objs.values()].map((d) => ({ key: d.key, version: d.version, data: d })));
        if (rest === 'collections') return send(res, 200, [...cols.values()].map((c) => ({ key: c.key, version: c.version, data: { key: c.key, name: c.name, parentCollection: c.parent || false } })));
        return send(res, 404, 'not found');
      }
      // writes
      if (req.headers['zotero-api-key'] !== apiKey || !apiKey) return send(res, 401, 'API key required');
      if (req.headers['zotero-server-id'] !== SERVER_ID) return send(res, 428, 'Zotero-Server-ID required');
      if (req.method === 'POST' && (rest === 'items' || rest === 'collections')) {
        const arr = JSON.parse(body.toString('utf8') || '[]');
        const successful = {};
        arr.forEach((o, i) => {
          version++;
          const key = newKey();
          if (rest === 'items') objs.set(key, { ...o, key, version, dateAdded: new Date().toISOString(), dateModified: new Date().toISOString(), tags: o.tags || [], collections: o.collections || [] });
          else cols.set(key, { key, name: o.name, parent: o.parentCollection || '', version });
          successful[i] = { key, version };
          writes.push({ kind: rest, key, data: o });
        });
        return send(res, 200, { successful, success: Object.fromEntries(Object.entries(successful).map(([i, s]) => [i, s.key])), unchanged: {}, failed: {} });
      }
      const fm = /^items\/([A-Z0-9]{8})\/file$/.exec(rest);
      if (req.method === 'POST' && fm) {
        const form = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
        const att = objs.get(fm[1]);
        if (!att) return send(res, 404, 'not found');
        if (form.upload) {
          const up = pending.get(form.upload);
          if (!up || !up.buf) return send(res, 400, 'File contents were not uploaded');
          version++; att.filename = up.filename; att.md5 = up.md5; att.version = version;
          toWebdav(webdavDir, att.key, up.filename, up.buf);             // (Zotero's sync)
          writes.push({ kind: 'file', key: att.key, size: up.buf.length });
          return send(res, 204, '');
        }
        if (req.headers['if-none-match'] !== '*') return send(res, 428, 'If-None-Match');
        const uk = crypto.randomBytes(8).toString('hex');
        pending.set(uk, { md5: form.md5, filename: form.filename });
        return send(res, 200, { url: `http://127.0.0.1:${server.address().port}/api/local/uploads/${uk}`, uploadKey: uk, prefix: '', suffix: '' });
      }
      const im = /^items\/([A-Z0-9]{8})$/.exec(rest);
      if (req.method === 'PATCH' && im) {
        const d = objs.get(im[1]); if (!d) return send(res, 404, 'not found');
        version++; Object.assign(d, JSON.parse(body.toString('utf8')), { version }); writes.push({ kind: 'patch', key: d.key });
        return send(res, 204, '');
      }
      return send(res, 405, 'Method not allowed');
    });
  });
  return {
    server, writes, objs, cols,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => server.close(),
    // the user dropping a PDF onto an item (in Zotero, then synced to WebDAV)
    addPdf(parent, name, buf) { version++; const key = newKey(); objs.set(key, { key, version, itemType: 'attachment', parentItem: parent, linkMode: 'imported_file', contentType: 'application/pdf', filename: name, tags: [] }); toWebdav(webdavDir, key, name, buf); return key; },
    bump() { version++; },
    deny(v) { denyAuthorize = v; },
  };
}

module.exports = { createFakeZotero, toWebdav, zipOne, SERVER_ID };
