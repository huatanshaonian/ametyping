// Zotero's files as its WebDAV sync keeps them on the NAS (literature config "webdavDir", e.g. /volume1/zotero): one
// <KEY>.zip per attachment holding the file, and <KEY>.prop with its modification time and MD5. Read only -- the files
// belong to Zotero's sync; this never writes there. The zip is read here (central directory + inflate) so nothing has
// to be installed; the MD5 in the .prop is checked against what comes out (a file still being uploaded is refused).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const KEY = /^[A-Z0-9]{8}$/;
const MAX = 200 * 1024 * 1024;

// the entries of a zip Buffer: [{ name, method, csize, size, offset }]
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是 zip 文件');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), offset = buf.readUInt32LE(p + 42);
    const raw = buf.slice(p + 46, p + 46 + nl);
    out.push({ name: (flags & 0x800 ? raw.toString('utf8') : raw.toString('utf8')), method, csize, size, offset });
    p += 46 + nl + xl + cl;
  }
  return out;
}
function extract(buf, e) {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('zip 条目损坏');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.slice(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX });
  throw new Error('不支持的压缩方式 ' + e.method);
}

function createWebdav({ dir }) {
  const zipOf = (key) => path.join(dir, key + '.zip');
  function prop(key) {
    try { const s = fs.readFileSync(path.join(dir, key + '.prop'), 'utf8');
      return { mtime: +((/<mtime>(\d+)<\/mtime>/.exec(s) || [])[1] || 0), md5: (/<hash>([0-9a-f]{32})<\/hash>/.exec(s) || [])[1] || '' }; } catch { return null; }
  }
  const has = (key) => !!dir && KEY.test(key) && fs.existsSync(zipOf(key));
  // the attachment's file -> { name, buf, md5 } (the file named `want` in the zip, else its first PDF, else its largest file)
  function read(key, want = '') {
    if (!dir || !KEY.test(key)) throw new Error('无效的附件');
    let st; try { st = fs.statSync(zipOf(key)); } catch { throw Object.assign(new Error('WebDAV 里还没有这个附件的文件'), { code: 'ENOFILE' }); }
    if (st.size > MAX) throw new Error('文件太大');
    const zip = fs.readFileSync(zipOf(key));
    const es = entries(zip).filter((e) => !e.name.endsWith('/'));
    const e = es.find((x) => x.name === want) || es.find((x) => /\.pdf$/i.test(x.name)) || es.sort((a, b) => b.size - a.size)[0];
    if (!e) throw new Error('附件压缩包是空的');
    const buf = extract(zip, e);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const p = prop(key);
    if (p && p.md5 && p.md5 !== md5 && es.length === 1) throw Object.assign(new Error('文件和 Zotero 记录的校验值不一致（可能还在同步）'), { code: 'EMD5' });
    return { name: path.basename(e.name), buf, md5: p && p.md5 ? p.md5 : md5, mtime: p ? p.mtime : st.mtimeMs };
  }
  return { has, read, prop, configured: () => !!dir && fs.existsSync(dir) };
}

module.exports = { createWebdav, entries, extract };
