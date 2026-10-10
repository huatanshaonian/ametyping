// A PDF the user found themselves, for a paper of the library that has none (文献库 › 上传 PDF): the bytes come as the
// body of the request, are checked to be a PDF, and go to Zotero as the paper's attachment -- the same way as one the
// library access fetched (pdfqueue.js). For the few that no source gives: a journal not online, a report by mail.
'use strict';

const MAX_BYTES = 80 * 1024 * 1024;

// the body of a request as bytes (the server's own readBody makes a string of it); null when it is too large
function readBytes(req, cap) {
  return new Promise((resolve) => {
    if (+req.headers['content-length'] > cap) { req.resume(); return resolve(null); }
    const parts = []; let n = 0, over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > cap) { over = true; parts.length = 0; return; } parts.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function createUpload({ api, mirror, fulltext, pdfq, log = () => {}, maxBytes = MAX_BYTES }) {
  // take(req, key, name) -> { ok: true, bytes } | { ok: false, msg }
  async function take(req, key, name) {
    const buf = await readBytes(req, maxBytes);                // (read first, whatever comes of it: the browser is sending)
    const it = /^[A-Z0-9]{8}$/.test(key) ? mirror.item(key) : null;
    if (!it) return { ok: false, msg: '找不到这篇' };
    if (buf === null) return { ok: false, msg: `文件太大（最多 ${Math.round(maxBytes / 1048576)} MB）` };
    if (buf.length < 100 || buf.subarray(0, 1024).indexOf('%PDF-') < 0) return { ok: false, msg: '这个文件不是 PDF' };
    if (fulltext.hasPdf(key)) return { ok: false, msg: '这篇已经有 PDF 了' };
    if (!api.canWrite()) return { ok: false, msg: '要先授权写入 Zotero（文献窗口上方）' };
    const base = String(name || '').replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N} ._()-]+/gu, '_').trim().slice(0, 80) || (it.doi || 'paper').replace(/[^\w.-]+/g, '_').slice(0, 80);
    try {
      const att = await api.attachPdf(key, buf, { filename: base + '.pdf' });
      fulltext.remember(att, buf);
    } catch (e) { return { ok: false, msg: '交给 Zotero 时出错：' + e.message }; }
    pdfq.got(key, `手动上传，${(buf.length / 1048576).toFixed(1)} MB`);
    log(`文献：收到手动上传的 PDF「${String(it.title || '').slice(0, 40)}」（${(buf.length / 1048576).toFixed(1)} MB），已交给 Zotero`);
    await mirror.refresh(true).catch(() => {});
    return { ok: true, bytes: buf.length };
  }
  return { take };
}

module.exports = { createUpload };
