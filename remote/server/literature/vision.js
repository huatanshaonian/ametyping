// 读图: a paper's pages read as images by the model (litVision in 控制面板 › AI 模型) instead of through the PDF's
// text layer, whose equations come out garbled and whose old scans have no text at all. Each page is drawn
// (render/pages.mjs, 1600 px wide), a few pages a question, and written back as Markdown with LaTeX; the transcription
// is kept per file content and takes that page's place wherever the paper's text is used (fulltext.useOverlay).
//   <dataDir>/literature/vision/<md5>.json      { n: pages in the PDF, pages: { "<page>": { md, at } } }
//   <dataDir>/literature/vision-requests.json   { <item key>: { pages, ranges, why, by, at } }
// A paper of up to visionMaxPages pages (控制面板 › 文献, default 30) is read whole the first time it is read deeply
// (a deep card waits for it; a question in the reader starts it and goes on with what is there). A longer one is read
// from its text; when the deep card's model finds pages worth reading as images, it asks (a request), and only the
// pages the user approves -- all of them or a part -- are read.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { VISION_SCHEMA, visionPrompt, UNSURE } = require('./prompts/vision');

const RENDER = path.join(__dirname, 'render', 'pages.mjs');
const BATCH = 4, PARALLEL = 2, WIDTH = 1600, MAX_ASK = 300;

// pdf -> { n, files: [{ page, file }] } (pages [] = only count them)
function render(pdf, outDir, pages, width = WIDTH) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RENDER, pdf, outDir, String(width), pages.length ? pages.join(',') : 'count'],
      { timeout: 60e3 + pages.length * 30e3, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, out, err) => {
        if (e) return reject(new Error('渲染 PDF 页面失败：' + (String(err || '').trim().split('\n').filter(Boolean).pop() || e.message).slice(0, 200)));
        try { resolve(JSON.parse(String(out).trim().split('\n').pop())); } catch { reject(new Error('渲染 PDF 页面失败：输出不对')); }
      });
  });
}

// "3-8, 15，20～22" -> [3..8, 15, 20, 21, 22] within 1..n ("全部" / "all" / '' -> every page)
function parseRanges(s, n) {
  s = String(s || '').trim();
  if (!s || /^(全部|所有|all)$/i.test(s)) return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[,，、;；\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–—～~到至]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let p = Math.max(1, a); p <= Math.min(n, b); p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}
// [3,4,5,8] -> "3-5, 8"
function formatRanges(pages) {
  const ps = [...new Set(pages)].sort((a, b) => a - b), out = [];
  for (let i = 0; i < ps.length; i++) {
    let j = i; while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    out.push(j > i ? `${ps[i]}-${ps[j]}` : String(ps[i])); i = j;
  }
  return out.join(', ');
}

// ask(prompt, schema, { images }): the litVision job's model; maxPages(): the page limit for reading a paper whole
function createVision({ dir, mirror, fulltext, ask, maxPages = () => 30, log = () => {}, onChange = () => {} }) {
  const vdir = path.join(dir, 'vision');
  fs.mkdirSync(vdir, { recursive: true });
  const fileOf = (md5) => path.join(vdir, md5 + '.json');
  const load = (md5) => { try { return { n: 0, pages: {}, ...JSON.parse(fs.readFileSync(fileOf(md5), 'utf8')) }; } catch { return { n: 0, pages: {} }; } };
  const save = (md5, v) => { fs.writeFileSync(fileOf(md5) + '.tmp', JSON.stringify(v)); fs.renameSync(fileOf(md5) + '.tmp', fileOf(md5)); };
  const reqFile = path.join(dir, 'vision-requests.json');
  let requests = {};
  try { requests = JSON.parse(fs.readFileSync(reqFile, 'utf8')); } catch {}
  const saveReq = () => { fs.writeFileSync(reqFile + '.tmp', JSON.stringify(requests)); fs.renameSync(reqFile + '.tmp', reqFile); };
  const jobs = new Map();                              // item key -> { running, total, done, why, error, at, wait }
  const changed = (key) => { try { onChange(key); } catch {} };

  // the PDF's page count, counted once per file
  const counting = new Map();
  async function counted(f) {
    const v = load(f.md5);
    if (v.n) return v;
    if (!counting.has(f.md5)) counting.set(f.md5, (async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-vision-'));
      try { fs.writeFileSync(path.join(tmp, 'doc.pdf'), f.buf); const r = await render(path.join(tmp, 'doc.pdf'), tmp, []); const v2 = load(f.md5); v2.n = r.n; save(f.md5, v2); }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); counting.delete(f.md5); }
    })());
    await counting.get(f.md5);
    return load(f.md5);
  }
  const donePages = (v) => Object.keys(v.pages).map(Number).sort((a, b) => a - b);
  const jobOut = (key) => { const j = jobs.get(key); return j ? { running: j.running, total: j.total, done: j.done, why: j.why, error: j.error, at: j.at } : null; };

  // what the window shows for one paper
  async function info(key) {
    const f = fulltext.fileOf(key);
    if (f.missing) return { pdf: false, missing: f.missing, job: jobOut(key), request: requests[key] || null };
    let v;
    try { v = await counted(f); } catch (e) { return { pdf: true, error: e.message, job: jobOut(key), request: requests[key] || null }; }
    const done = donePages(v), max = maxPages();
    const unsure = done.reduce((n, p) => n + (v.pages[p].md.split(UNSURE).length - 1), 0);
    return { pdf: true, n: v.n, done: done.length, ranges: formatRanges(done), unsure, max, auto: max > 0 && v.n <= max, job: jobOut(key), request: requests[key] || null };
  }

  // one page's transcription, to check against the page itself ('' when it was not read)
  function page(key, n) {
    const f = fulltext.fileOf(key);
    if (f.missing) return null;
    const p = load(f.md5).pages[n];
    return { page: n, md: p ? p.md : '', at: p ? p.at : 0 };
  }

  // read `pages` of the paper as images (those not read yet); one run per paper at a time
  function run(key, pages, why) {
    const cur = jobs.get(key);
    if (cur && cur.running) return { ok: false, msg: '这篇正在读图', wait: cur.wait };
    const it = mirror.item(key);
    if (!it) return { ok: false, msg: '找不到这篇' };
    const job = { running: true, total: 0, done: 0, why, error: '', at: Date.now() };
    jobs.set(key, job); changed(key);
    job.wait = (async () => {
      const f = fulltext.fileOf(key);
      if (f.missing) throw new Error(f.missing === 'nofile' ? 'PDF 还没同步到群晖' : '没有可读的 PDF');
      const v = await counted(f);
      const want = [...new Set(pages)].filter((p) => p >= 1 && p <= v.n && !v.pages[p]).sort((a, b) => a - b).slice(0, MAX_ASK);
      job.total = want.length; changed(key);
      if (!want.length) return;
      // the PDF's own text of each page, for checking spelling (not an old report's OCR: its pages are not the PDF's)
      const raw = await fulltext.forItem(key, { raw: true });
      const hints = raw.pages && !raw.from ? raw.pages : [];
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-vision-'));
      const pdf = path.join(tmp, 'doc.pdf');
      fs.writeFileSync(pdf, f.buf);
      const batches = []; for (let i = 0; i < want.length; i += BATCH) batches.push(want.slice(i, i + BATCH));
      const failed = [];
      try {
        const one = async (batch) => {
          const bdir = fs.mkdtempSync(path.join(tmp, 'b'));
          try {
            const r = await render(pdf, bdir, batch);
            const a = await ask(visionPrompt(it, batch.map((p) => ({ page: p, hint: hints[p - 1] || '' }))), VISION_SCHEMA, { images: r.files.map((x) => x.file) });
            const got = Array.isArray(a && a.pages) ? a.pages.filter((x) => x && typeof x.md === 'string' && x.md.trim()) : [];
            // (the page numbers as asked; an answer numbered 1, 2, ... instead is taken in order)
            const byNo = got.every((x) => batch.includes(x.page)) ? got : got.length === batch.length ? got.map((x, i) => ({ ...x, page: batch[i] })) : [];
            const v2 = load(f.md5);
            for (const x of byNo) v2.pages[x.page] = { md: x.md.trim(), at: Date.now() };
            save(f.md5, v2);
            const miss = batch.filter((p) => !byNo.some((x) => x.page === p));
            failed.push(...miss);
            job.done += batch.length - miss.length; changed(key);
          } finally { fs.rmSync(bdir, { recursive: true, force: true }); }
        };
        let next = 0;
        const worker = async () => { while (next < batches.length) await one(batches[next++]); };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      if (failed.length) job.error = `第 ${formatRanges(failed)} 页没读出来`;
      log(`文献：${key} 读图 ${job.done}/${job.total} 页${failed.length ? '（' + job.error + '）' : ''}`);
    })().catch((e) => { job.error = e.message; log(`文献：${key} 读图失败：${e.message}`); })
      .finally(() => { job.running = false; changed(key); });
    return { ok: true, wait: job.wait };
  }

  // before reading a paper deeply: a short one is read whole as images (wait: the deep card waits for it; a question
  // goes on with what is there). Never throws: without images the text is used.
  async function prepare(key, { wait = false } = {}) {
    try {
      const j = jobs.get(key);
      if (j && j.running) { if (wait) await j.wait; return; }
      if (j && j.error && Date.now() - j.at < 10 * 60e3) return;           // failed lately: not again on every question
      const f = fulltext.fileOf(key);
      if (f.missing) return;
      const v = await counted(f), max = maxPages();
      if (!(max > 0 && v.n <= max)) return;
      const missing = Array.from({ length: v.n }, (_, i) => i + 1).filter((p) => !v.pages[p]);
      if (!missing.length) return;
      const r = run(key, missing, 'auto');
      if (wait && r.wait) await r.wait;
    } catch (e) { log(`文献：${key} 读图准备失败：${e.message}`); }
  }

  // a long paper: the model asks to read some pages as images; the user approves them (or a part), or declines
  function request(key, ranges, why, by = 'model') {
    const it = mirror.item(key);
    if (!it) return { ok: false, msg: '找不到这篇' };
    const pages = parseRanges(ranges, 100000);
    if (!pages.length) return { ok: false, msg: '页码看不懂' };
    requests[key] = { pages, ranges: formatRanges(pages), why: String(why || '').slice(0, 500), by, at: Date.now() };
    saveReq(); changed(key);
    return { ok: true };
  }
  async function approve(key, ranges) {
    const f = fulltext.fileOf(key);
    if (f.missing) return { ok: false, msg: '没有可读的 PDF' };
    let v; try { v = await counted(f); } catch (e) { return { ok: false, msg: e.message }; }
    const pages = parseRanges(ranges != null && String(ranges).trim() ? ranges : (requests[key] || {}).ranges, v.n);
    if (!pages.length) return { ok: false, msg: '页码看不懂（写成 3-8, 15 这样）' };
    if (pages.length > MAX_ASK) return { ok: false, msg: `一次最多读 ${MAX_ASK} 页` };
    if (requests[key]) { delete requests[key]; saveReq(); }
    const r = run(key, pages, 'approved');
    return r.ok ? { ok: true, pages: pages.length } : { ok: false, msg: r.msg };
  }
  function decline(key) { if (requests[key]) { delete requests[key]; saveReq(); changed(key); } return { ok: true }; }
  const pending = () => Object.entries(requests).map(([key, r]) => ({ key, title: (mirror.item(key) || {}).title || key, ...r })).sort((a, b) => b.at - a.at);

  // the paper's text with the pages read as images in their place (fulltext.useOverlay). An old report's OCR text,
  // whose pieces are not the PDF's pages, keeps its pieces (labelled OCR1, OCR2, ...) after the pages read.
  function apply(doc) {
    if (!doc || !doc.md5 || !Array.isArray(doc.pages)) return doc;
    const v = load(doc.md5), got = donePages(v);
    if (!got.length) return doc;
    const n = v.n || doc.pages.length;
    const aligned = !doc.from || doc.pages.length === n;
    let pages, labels = null;
    if (aligned || got.length >= n) pages = Array.from({ length: Math.max(n, aligned ? doc.pages.length : 0) }, (_, i) => (v.pages[i + 1] ? v.pages[i + 1].md : aligned ? doc.pages[i] || '' : ''));
    else { pages = [...got.map((p) => v.pages[p].md), ...doc.pages]; labels = [...got, ...doc.pages.map((_, i) => 'OCR' + (i + 1))]; }
    const chars = pages.reduce((s, t) => s + t.length, 0);
    return { ...doc, pages, labels, chars, scanned: doc.scanned && got.length < n && chars / pages.length < 200, vision: got, visionN: n };
  }

  return { info, page, run, prepare, request, approve, decline, pending, apply, state: jobOut };
}

module.exports = { createVision, parseRanges, formatRanges, render };
