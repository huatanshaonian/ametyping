// A paper's text, page by page, for the cards and the deep reading: the PDF from Zotero's WebDAV folder (webdav.js) run
// through pdftotext (poppler; on the NAS at /usr/bin/pdftotext -- literature config "pdftotext" to point elsewhere).
// Kept per file content: <dataDir>/literature/text/<md5>.json { pages: [text], chars, scanned }. A scan without a text
// layer comes out (almost) empty: `scanned` says so, and the card is then made from the abstract and the user's notes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function pdftotext(bin, buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `ame-lit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmp, buf);
    execFile(bin, ['-enc', 'UTF-8', '-eol', 'unix', tmp, '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 120e3, windowsHide: true }, (e, out) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (e) return reject(new Error(e.code === 'ENOENT' ? `找不到 ${bin}（需要 poppler 的 pdftotext）` : 'pdftotext 失败：' + String(e.message).slice(0, 160)));
      resolve(String(out));
    });
  });
}

// http / ntrsBase: for a scanned NASA report, NTRS's own OCR text (through the proxy, like the rest of NTRS)
function createFulltext({ dir, mirror, webdav, bin = 'pdftotext', http = null, ntrsBase = 'https://ntrs.nasa.gov', iaBase = 'https://archive.org', log = () => {} }) {
  const tdir = path.join(dir, 'text');
  fs.mkdirSync(tdir, { recursive: true });
  const inflight = new Map();

  async function fromBuffer(buf, md5) {
    const f = path.join(tdir, md5 + '.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (inflight.has(md5)) return inflight.get(md5);
    const p = (async () => {
      const raw = await pdftotext(bin, buf);
      const pages = raw.split('\f').map((s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      while (pages.length && !pages[pages.length - 1]) pages.pop();
      const chars = pages.reduce((n, s) => n + s.length, 0);
      const doc = { pages, chars, scanned: pages.length > 0 && chars / pages.length < 200 };
      fs.writeFileSync(f, JSON.stringify(doc));
      return doc;
    })().finally(() => inflight.delete(md5));
    inflight.set(md5, p);
    return p;
  }

  // PDFs this module just gave Zotero (intake.js): read from here until Zotero's sync has put them on WebDAV
  const recent = new Map();                            // attachment key -> { buf, md5, at }
  function remember(attKey, buf) {
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    recent.set(attKey, { buf, md5, at: Date.now() });
    for (const [k, v] of recent) if (Date.now() - v.at > 3600e3) recent.delete(k);
  }

  // the item's PDF text, or { missing: why } -- 'nopdf' (no PDF attachment), 'nofile' (not synced to WebDAV yet),
  // 'linked' (only a link to the PDF), or an error
  async function forItem(key) {
    const att = mirror.pdfOf(key);
    if (!att) return { missing: 'nopdf' };
    if (att.linkMode === 'linked_url' || att.linkMode === 'linked_file') return { missing: 'linked', attachment: att };
    let file;
    try { file = webdav.read(att.key, att.filename); }
    catch (e) {
      const r = recent.get(att.key);
      if (r) file = { buf: r.buf, md5: r.md5 };
      else return { missing: e.code === 'ENOFILE' ? 'nofile' : 'error', error: e.message, attachment: att };
    }
    let doc;
    try { doc = { ...(await fromBuffer(file.buf, file.md5)), attachment: att, md5: file.md5 }; }
    catch (e) { log('文献：抽全文失败 ' + key + '：' + e.message); return { missing: 'error', error: e.message, attachment: att }; }
    // an old NASA scan without a text layer: NTRS's own OCR text of the report instead
    const it = mirror.item(key);
    if (doc.scanned && it && it.ntrs) { const t = await ocrText(`${ntrsBase}/api/citations/${it.ntrs}/downloads/${it.ntrs}.txt`, file.md5 + '-ntrs', 'NTRS ' + it.ntrs).catch(() => null); if (t) return { ...t, attachment: att, md5: file.md5, from: 'ntrs' }; }
    if (doc.scanned && it && it.dtic) { const t = await ocrText(`${iaBase}/download/DTIC_${it.dtic}/DTIC_${it.dtic}_djvu.txt`, file.md5 + '-dtic', 'DTIC ' + it.dtic).catch(() => null); if (t) return { ...t, attachment: att, md5: file.md5, from: 'dtic' }; }
    return doc;
  }
  // an old report's OCR text (NTRS's own, the Internet Archive's for DTIC), cut into pages (form feeds when it has them,
  // else ~3000 characters), kept like a PDF's
  async function ocrText(url, cacheKey, what) {
    if (!http) return null;
    const f = path.join(tdir, cacheKey + '.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    const r = await http.get(url, { timeoutMs: 60e3 });
    if (r.status !== 200) return null;
    const raw = r.body.toString('utf8').replace(/\r/g, '');
    let pages = raw.includes('\f') ? raw.split('\f') : raw.match(/[\s\S]{1,3000}(?=\s|$)/g) || [];
    pages = pages.map((s) => s.replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean);
    if (!pages.length) return null;
    const doc = { pages, chars: pages.reduce((n, s) => n + s.length, 0), scanned: false, ocr: what };
    fs.writeFileSync(f, JSON.stringify(doc));
    log(`文献：扫描版报告 ${what} 改用现成的 OCR 文本`);
    return doc;
  }
  const hasPdf = (key) => { const a = mirror.pdfOf(key); return !!(a && (a.linkMode === 'imported_file' || a.linkMode === 'imported_url') && (webdav.has(a.key) || recent.has(a.key))); };
  // the PDF's bytes for the reader window
  function pdfBytes(key) {
    const a = mirror.pdfOf(key);
    if (!a || !(a.linkMode === 'imported_file' || a.linkMode === 'imported_url')) return null;
    try { return { name: a.filename || 'paper.pdf', buf: webdav.read(a.key, a.filename).buf }; }
    catch { const r = recent.get(a.key); return r ? { name: a.filename || 'paper.pdf', buf: r.buf } : null; }
  }
  return { forItem, fromBuffer, hasPdf, remember, pdfBytes };
}

// the pages most about `words` (case-insensitive counts), in page order, within `budget` characters; always the first page
function pickPages(pages, words, budget = 60000) {
  const ws = [...new Set(words.map((w) => String(w).toLowerCase()).filter((w) => w.length > 1))];
  const scored = pages.map((t, i) => {
    const low = t.toLowerCase();
    let s = 0; for (const w of ws) { let at = low.indexOf(w); while (at >= 0) { s++; at = low.indexOf(w, at + w.length); } }
    return { i, s: s / Math.sqrt(1 + t.length / 3000), len: t.length };
  });
  const pick = new Set([0]); let used = (pages[0] || '').length;
  for (const p of scored.slice(1).sort((a, b) => b.s - a.s)) { if (used + p.len > budget) continue; pick.add(p.i); used += p.len; }
  return [...pick].sort((a, b) => a - b).map((i) => ({ page: i + 1, text: pages[i] }));
}
// the whole text if it fits, else the start of each page in turn (a long report keeps every page's opening)
function fitPages(pages, budget = 90000) {
  const total = pages.reduce((n, s) => n + s.length, 0);
  if (total <= budget) return pages.map((text, i) => ({ page: i + 1, text }));
  const per = Math.max(400, Math.floor(budget / pages.length));
  return pages.map((t, i) => ({ page: i + 1, text: t.length > per ? t.slice(0, per) + ' …' : t }));
}

module.exports = { createFulltext, pickPages, fitPages, pdftotext };
