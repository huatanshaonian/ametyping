// 图表: a paper's figures cut out of its pages, for the cards. The pages that carry a figure (by their text: "Fig. 3",
// "图 5", or the "[图 n：…]" lines of the pages read as images; a scan without text: every page) are drawn
// (render/pages.mjs) and shown to the model a few at a time (the litVision job), which says where each figure is, gives
// its caption and what can be seen in it (prompts/figures.js); the figures are then cut out (render/crop.mjs). Done
// once per file content -- and again for the pages read as images since (a long report's pages the user approved),
// on those pages only:
//   <dataDir>/literature/figures/<md5>/index.json   { n, at, figs: [{ id: "p4-1", page, label, caption, desc, w, h }] }
//   <dataDir>/literature/figures/<md5>/<id>.png
// The ones a card shows are copied into the knowledge base (figures/<citekey>/<id>.png, beside papers/ -- Obsidian
// shows them from the card's Markdown: ![…](../figures/<citekey>/<id>.png)).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { render } = require('./vision');
const { FIG_SCHEMA, figuresPrompt } = require('./prompts/figures');

const CROP = path.join(__dirname, 'render', 'crop.mjs');
const BATCH = 4, PARALLEL = 2, MAX_PAGES = 40, MAX_FIGS = 60;
const HAS_FIG = /\b(?:Fig(?:ure|s)?\.?|FIG(?:URE)?\.?)\s*\d|图\s*\d|\[图\s/;
const REL = /^figures\/[\p{L}\p{N}_.-]{1,120}\/p\d{1,4}-\d{1,2}\.png$/u;

function crop(jobs, tmp) {
  return new Promise((resolve, reject) => {
    const spec = path.join(tmp, 'crop.json');
    fs.writeFileSync(spec, JSON.stringify({ jobs }));
    execFile(process.execPath, [CROP, spec], { timeout: 60e3 + jobs.length * 5e3, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, out, err) => {
      if (e) return reject(new Error('裁图失败：' + (String(err || '').trim().split('\n').filter(Boolean).pop() || e.message).slice(0, 200)));
      try { resolve(JSON.parse(String(out).trim().split('\n').pop()).files || []); } catch { reject(new Error('裁图失败：输出不对')); }
    });
  });
}

// ask(prompt, schema, { images }): the litVision job's model; kbDir: the knowledge base's folder
function createFigures({ dir, kbDir, mirror, fulltext, ask, log = () => {}, renderFn = render, cropFn = crop }) {
  const root = path.join(dir, 'figures');
  fs.mkdirSync(root, { recursive: true });
  const dirOf = (md5) => path.join(root, md5);
  const load = (md5) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(md5), 'index.json'), 'utf8')); } catch { return null; } };
  const running = new Map();                           // md5 -> promise

  // only: the pages to look at (else the ones that speak of a figure); prev: what was found before, kept
  async function find(key, f, only = null, prev = null) {
    const it = mirror.item(key);
    // (the text as the cards read it -- with the pages read as images in their place -- and the PDF's own text layer:
    // a figure is spoken of in either)
    const ft = await fulltext.forItem(key), raw = await fulltext.forItem(key, { raw: true }).catch(() => ({}));
    const own = raw && raw.pages && !raw.labels ? raw.pages : [];
    const texts = (ft.pages || []).map((t, i) => (t || '') + '\n' + (own[i] || ''));
    // (an old report's OCR pieces are not the PDF's pages: their numbers say nothing about where a figure is)
    const aligned = texts.length && !ft.labels;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-figs-'));
    const out = dirOf(f.md5);
    try {
      const pdf = path.join(tmp, 'doc.pdf');
      fs.writeFileSync(pdf, f.buf);
      const n = (await renderFn(pdf, tmp, [])).n;
      let pages = only ? only.filter((p) => p >= 1 && p <= n) : aligned ? texts.map((t, i) => (HAS_FIG.test(t || '') ? i + 1 : 0)).filter((p) => p && p <= n) : [];
      if (!only && !pages.length && (!aligned || ft.scanned)) pages = Array.from({ length: n }, (_, i) => i + 1);
      pages = pages.slice(0, MAX_PAGES);
      const found = [];
      const batches = []; for (let i = 0; i < pages.length; i += BATCH) batches.push(pages.slice(i, i + BATCH));
      fs.mkdirSync(out, { recursive: true });
      const one = async (batch) => {
        const bdir = fs.mkdtempSync(path.join(tmp, 'b'));
        const r = await renderFn(pdf, bdir, batch);
        const a = await ask(figuresPrompt(it, batch), FIG_SCHEMA, { images: r.files.map((x) => x.file) });
        const per = new Map();
        const jobs = [];
        for (const g of Array.isArray(a && a.figs) ? a.figs : []) {
          const src = r.files.find((x) => x.page === g.page);
          const box = [g.x0, g.y0, g.x1, g.y1].map(Number);
          if (!src || box.some((v) => !(v >= 0 && v <= 1)) || box[2] - box[0] < 0.05 || box[3] - box[1] < 0.03) continue;
          const k = (per.get(g.page) || 0) + 1; per.set(g.page, k);
          if (k > 8) continue;
          const id = `p${g.page}-${k}`;
          jobs.push({ src: src.file, box, out: path.join(out, id + '.png'), maxWidth: 1400,
            fig: { id, page: g.page, label: String(g.label || '').trim().slice(0, 40), caption: String(g.caption || '').replace(/\s+/g, ' ').trim().slice(0, 1200), desc: String(g.desc || '').trim().slice(0, 1500) } });
        }
        if (!jobs.length) return;
        const done = await cropFn(jobs.map(({ fig, ...j }) => j), bdir);
        for (const j of jobs) { const d = done.find((x) => x.out === j.out); if (d && !d.error) found.push({ ...j.fig, w: d.w, h: d.h }); }
      };
      let next = 0, failed = 0;
      const worker = async () => { while (next < batches.length) { const b = batches[next++]; try { await one(b); } catch (e) { failed++; log(`文献：${key} 第 ${b.join('、')} 页找图失败：${e.message}`); } } };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
      // (every batch failed: nothing is kept, so that the next card tries again)
      if (batches.length && failed === batches.length) throw new Error('找图的模型调用都失败了');
      const figs = [...((prev && prev.figs) || []), ...found].sort((a, b) => a.page - b.page || a.id.localeCompare(b.id)).slice(0, MAX_FIGS);
      const v = { n, at: Date.now(), pages: [...new Set([...((prev && prev.pages) || []), ...pages])].sort((a, b) => a - b), figs };
      fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(v));
      log(prev ? `文献：${key} 在新读图的 ${pages.length} 页上又找到 ${found.length} 张图` : `文献：${key} 找到 ${figs.length} 张图（看了 ${pages.length} 页）`);
      return v;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // the paper's figures: [{ id, page, label, caption, desc, w, h }] ([] without a PDF). Never throws.
  async function ensure(key) {
    try {
      const f = fulltext.fileOf(key);
      if (f.missing) return [];
      const got = load(f.md5);
      let more = null;
      if (got) {
        // pages read as images since that speak of a figure, not looked at yet
        const ft = await fulltext.forItem(key);
        more = (ft.vision || []).filter((p) => !(got.pages || []).includes(p) && HAS_FIG.test((ft.pages || [])[ft.labels ? ft.labels.indexOf(p) : p - 1] || ''));
        if (!more.length) return got.figs || [];
      }
      if (!running.has(f.md5)) running.set(f.md5, find(key, f, more, more && got).finally(() => running.delete(f.md5)));
      return (await running.get(f.md5)).figs || [];
    } catch (e) { log(`文献：${key} 提取图表失败：${e.message}`); return []; }
  }

  // the figures a card shows, into the knowledge base (the card's old ones are replaced): -> { id: 'figures/<name>/<id>.png' }
  function publish(key, name, ids) {
    const out = {};
    const f = fulltext.fileOf(key);
    if (f.missing || !/^[\p{L}\p{N}_.-]{1,120}$/u.test(name)) return out;
    const to = path.join(kbDir, 'figures', name);
    try {
      fs.rmSync(to, { recursive: true, force: true });
      if (!ids.length) return out;
      fs.mkdirSync(to, { recursive: true });
      for (const id of ids) {
        if (!/^p\d{1,4}-\d{1,2}$/.test(id)) continue;
        try { fs.copyFileSync(path.join(dirOf(f.md5), id + '.png'), path.join(to, id + '.png')); out[id] = `figures/${name}/${id}.png`; } catch {}
      }
    } catch (e) { log(`文献：图片没能放进知识库：${e.message}`); }
    return out;
  }
  // a figure of the knowledge base by its path there (what the window asks for), or null
  function file(rel) {
    if (!REL.test(String(rel || ''))) return null;
    try { return fs.readFileSync(path.join(kbDir, rel)); } catch { return null; }
  }
  return { ensure, publish, file };
}

module.exports = { createFigures, HAS_FIG };
