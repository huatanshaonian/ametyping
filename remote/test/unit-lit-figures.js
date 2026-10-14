// 图表 in the cards, with stand-ins for the model and the PDF (no server):
//   render/crop.mjs -- a box that is a little off, either way, is put right by the page itself
//   figures.js      -- the pages that carry a figure are shown to the model; its figures are cut out, once per file
//   cards.js        -- a deep card shows the figures the model picked, each with its reading; the pictures are kept
//                      beside the cards; the card's first figure is its cover in 卡片库; Zotero's note has no pictures
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createFigures, HAS_FIG } = require('../server/literature/figures');
const { createCards, noteHtml } = require('../server/literature/cards');
const { createKb } = require('../server/literature/kb');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-figs-'));
const CROP = path.join(__dirname, '..', 'server', 'literature', 'render', 'crop.mjs');

// a page 1000 x 1400: lines of "text" (grey bars), a figure at x 200..800, y 300..700 (a frame, a curve, an axis label
// below it at y 715..730), its caption at y 770
function drawPage(file) {
  const c = createCanvas(1000, 1400), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1000, 1400);
  g.fillStyle = '#333';
  for (let y = 100; y < 240; y += 28) g.fillRect(120, y, 760, 10);
  g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(200, 300, 600, 400);
  g.beginPath(); g.moveTo(210, 690); g.quadraticCurveTo(500, 320, 790, 400); g.stroke();
  g.fillRect(440, 715, 120, 15);                               // (the axis label)
  g.fillRect(150, 770, 700, 10); g.fillRect(150, 795, 500, 10);  // (the caption)
  for (let y = 880; y < 1300; y += 28) g.fillRect(120, y, 760, 10);
  fs.writeFileSync(file, c.toBuffer('image/png'));
}
const cropRun = (jobs) => { const spec = path.join(T, 'spec.json'); fs.writeFileSync(spec, JSON.stringify({ jobs })); return JSON.parse(execFileSync(process.execPath, [CROP, spec]).toString().trim().split('\n').pop()).files; };
const near = (a, b, tol = 0.012) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  // ---- cutting a figure out ----
  const page = path.join(T, 'p1.png'); drawPage(page);
  const want = [0.2, 300 / 1400, 0.8, 730 / 1400];             // the frame with the axis label under it
  const r = cropRun([
    { src: page, box: [0.25, 0.25, 0.75, 0.47], out: path.join(T, 'small.png') },      // cuts through the frame, misses the label
    { src: page, box: [0.14, 0.19, 0.86, 0.535], out: path.join(T, 'large.png') },     // white all around
    { src: page, box: [0.5, 0.5, 0.5, 0.5], out: path.join(T, 'none.png') }]);
  ok('a box that cuts through the figure: grown to the whole of it, the axis label beyond a little white included, the caption not', !r[0].error && near(r[0].box, [want[0] - 0.01, want[1] - 0.007, want[2] + 0.01, want[3] + 0.007]), r[0]);
  ok('a box too large: brought in to the figure -- the same cut', !r[1].error && near(r[1].box, r[0].box, 0.004), [r[0].box, r[1].box]);
  const img = await loadImage(fs.readFileSync(path.join(T, 'small.png')));
  ok('the cut is a picture of that size; a box of no size is an error, not a picture', img.width === r[0].w && img.width > 580 && img.width < 660 && !!r[2].error && !fs.existsSync(path.join(T, 'none.png')), [img.width, r[2]]);

  // ---- finding the figures of a paper ----
  ok('which pages carry a figure, by their text', HAS_FIG.test('as shown in Fig. 3, the') && HAS_FIG.test('Figure 12 compares') && HAS_FIG.test('如图 5 所示') && HAS_FIG.test('[图 2：电子密度剖面]') && !HAS_FIG.test('the configuration is fixed') && !HAS_FIG.test('Table 2 lists'));
  const kbDir = path.join(T, 'kb'); fs.mkdirSync(kbDir);
  const item = { key: 'AAAAAAA1', title: 'Backward scattering of a reentry vehicle', citekey: 'sun2018backward', creators: ['Sun, Wei'], year: 2018, venue: 'TAP', doi: '10.1/x', abstract: 'abs' };
  const mirror = { item: (k) => (k === item.key ? item : null), annotationsOf: () => [], childrenOf: () => ({ notes: [] }) };
  const texts = ['Introduction, no picture here.', 'The profile is shown in Fig. 1 for three altitudes.', 'Equations only.', 'Figure 2 compares the RCS; see also Fig. 3.'];
  const fulltext = { fileOf: () => ({ md5: 'abc123', buf: Buffer.from('%PDF-1.4 fake') }), forItem: async (k, o) => (o && o.raw ? { pages: ['', '', '', 'Figure 2 compares the RCS; see also Fig. 3.'] } : { pages: texts.slice(0, 3).concat('读图转写的一页，没有提到图'), chars: 400 }) };
  const asked = [];
  const renderFn = async (pdf, outDir, pages) => ({ n: 4, files: pages.map((p) => { const f = path.join(outDir, `p${p}.png`); drawPage(f); return { page: p, file: f, w: 1000, h: 1400 }; }) });
  const askFig = async (prompt, schema, o) => {
    asked.push({ prompt, images: o.images.length });
    return { figs: [{ page: 2, label: 'Fig. 1', x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.47, caption: 'Fig. 1  Electron density profiles.', desc: '横轴是高度，纵轴是电子密度。' },
      { page: 4, label: 'Fig. 2', x0: 0.14, y0: 0.19, x1: 0.86, y1: 0.535, caption: 'Fig. 2  RCS against frequency.', desc: '三条曲线。' },
      { page: 4, label: '', x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.51, caption: 'a speck', desc: '' }, { page: 9, label: 'Fig. 9', x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9, caption: 'not a page asked', desc: '' }] };
  };
  const logs = [];
  const figures = createFigures({ dir: T, kbDir, mirror, fulltext, ask: askFig, renderFn, log: (m) => logs.push(m) });
  const figs = await figures.ensure(item.key);
  ok('only the pages whose text speaks of a figure are shown to the model, in one question', asked.length === 1 && asked[0].images === 2 && /第 2、4 页/.test(asked[0].prompt), asked.map((a) => [a.images, a.prompt.slice(0, 60)]));
  ok('its figures are cut out and kept: two (the speck and the one on a page not asked are dropped), with page, label, caption, what is seen', figs.length === 2 && figs[0].id === 'p2-1' && figs[1].id === 'p4-1' && figs[1].label === 'Fig. 2' && /RCS/.test(figs[1].caption) && figs[0].w > 500 &&
    fs.existsSync(path.join(T, 'figures', 'abc123', 'p2-1.png')) && fs.existsSync(path.join(T, 'figures', 'abc123', 'p4-1.png')), figs);
  await figures.ensure(item.key);
  ok('once per file: not asked again', asked.length === 1);
  // page 3 read as an image since (a long report's page the user approved): its transcription speaks of a figure --
  // only that page is looked at, what was found before is kept
  const ft3 = { ...fulltext, forItem: async (k, o) => (o && o.raw ? { pages: ['', '', '', ''] } : { pages: [texts[0], texts[1], '读图转写：[图 3：碰撞频率随高度的变化]', texts[3]], chars: 400, vision: [3] }) };
  const asked3 = [];
  const figures3 = createFigures({ dir: T, kbDir, mirror, fulltext: ft3, renderFn, log: () => {},
    ask: async (prompt, schema, o) => { asked3.push({ prompt, images: o.images.length }); return { figs: [{ page: 3, label: 'Fig. 3', x0: 0.14, y0: 0.19, x1: 0.86, y1: 0.535, caption: 'Fig. 3  Collision frequency.', desc: '一条曲线。' }] }; } });
  const figs3 = await figures3.ensure(item.key);
  ok('a page read as an image since, speaking of a figure: only it is looked at; the figures before are kept, the new one among them', asked3.length === 1 && asked3[0].images === 1 && /第 3 页/.test(asked3[0].prompt) &&
    figs3.map((g) => g.id).join() === 'p2-1,p3-1,p4-1' && JSON.parse(fs.readFileSync(path.join(T, 'figures', 'abc123', 'index.json'), 'utf8')).pages.join() === '2,3,4', [asked3, figs3.map((g) => g.id)]);
  await figures3.ensure(item.key);
  ok('and not again', asked3.length === 1);

  // ---- the deep card ----
  const kb = createKb({ dir: kbDir });
  let deepPrompt = '';
  const askDeep = async (prompt) => { deepPrompt = prompt; return { oneLine: '用实测剖面算了再入体的后向散射', problem: '问题', method: '方法', assumptions: ['假设'], results: ['结果 [p.2]'], relevance: '相关', question: 0, actions: ['做点什么'], reusable: [], doubts: [], follow: [], history: '',
    relations: [], vision: { worth: false, pages: '', why: '' },
    figures: [{ id: 'p4-1', title: 'RCS 随频率的变化', reading: '三条曲线对应三个高度，X 波段下降约 10 dB。' }, { id: '[F:p2-1]', title: '电子密度剖面', reading: '峰值在 60 km 附近。' }, { id: 'p7-1', title: '不存在的图', reading: 'x' }, { id: 'p4-1', title: '重复', reading: 'y' }] }; };
  const cards = createCards({ kb, mirror, fulltext, profile: { get: () => ({}), words: () => [], openQuestions: () => [] }, ask: askDeep, askDeep, api: { canWrite: () => false }, figures });
  const made = await cards.makeDeep(item.key);
  const card = kb.read(made.path);
  ok('the model is told of the figures (their ids, pages, captions, what is seen) and asked to pick and read them', /\[F:p2-1\] Fig\. 1，第 2 页/.test(deepPrompt) && /Electron density profiles/.test(deepPrompt) && /横轴是高度/.test(deepPrompt) && /最多 8 张/.test(deepPrompt), deepPrompt.slice(-900));
  const sec = (card.sections.find((s) => s.title === '图表') || {}).text || '';
  ok('图表: each figure picked, in the model\'s order -- a heading with its page, the picture, the reading, the caption; the one that does not exist and the repeat left out', sec.split('### ').length === 3 &&
    /^### Fig\. 2 · RCS 随频率的变化 \[p\.4\]\n\n!\[Fig\. 2\]\(\.\.\/figures\/sun2018backward\/p4-1\.png\)\n\n三条曲线对应三个高度/.test(sec) && /> 图题：Fig\. 2 {2}RCS against frequency\.|> 图题：Fig\. 2 RCS against frequency\./.test(sec) && sec.indexOf('p4-1') < sec.indexOf('p2-1'), sec);
  ok('the pictures are in the knowledge base beside the cards; the card says how many and which is its cover', fs.existsSync(path.join(kbDir, 'figures', 'sun2018backward', 'p4-1.png')) && fs.existsSync(path.join(kbDir, 'figures', 'sun2018backward', 'p2-1.png')) &&
    card.meta.figs === 2 && card.meta.cover === 'figures/sun2018backward/p4-1.png', card.meta);
  ok('a picture is served by its path there, and nothing else is', !!figures.file('figures/sun2018backward/p4-1.png') && !figures.file('figures/../papers/sun2018backward.md') && !figures.file('papers/sun2018backward.md') && !figures.file('figures/sun2018backward/p4-9.png'));
  const all = cards.all();
  ok('卡片库: the card with its one line, its kind, its cover and the number of its figures', all.length === 1 && all[0].key === item.key && all[0].status === 'deep' && /实测剖面/.test(all[0].oneLine) && all[0].cover === card.meta.cover && all[0].figs === 2 && !all[0].gone, all);
  const html = noteHtml(card.body);
  ok('Zotero\'s note: the readings without the pictures', /<h3>Fig\. 2 · RCS 随频率的变化/.test(html) && /三条曲线对应三个高度/.test(html) && !/!\[|figures\//.test(html), html.slice(0, 600));
  // a card made again with other figures: the old pictures go
  const askAgain = async () => ({ oneLine: '又做了一次', problem: 'p', method: 'm', assumptions: [], results: ['r'], relevance: 'x', question: 0, actions: [], reusable: [], doubts: [], follow: [], history: '', relations: [], vision: { worth: false, pages: '', why: '' }, figures: [{ id: 'p2-1', title: '只留这张', reading: '解读。' }] });
  const cards2 = createCards({ kb, mirror, fulltext, profile: { get: () => ({}), words: () => [], openQuestions: () => [] }, ask: askAgain, askDeep: askAgain, api: { canWrite: () => false }, figures });
  await cards2.makeDeep(item.key);
  ok('made again with other figures: the pictures no longer shown are gone from the knowledge base', fs.existsSync(path.join(kbDir, 'figures', 'sun2018backward', 'p2-1.png')) && !fs.existsSync(path.join(kbDir, 'figures', 'sun2018backward', 'p4-1.png')) && kb.read(made.path).meta.figs === 1);
  // a paper without a PDF, or the model failing: a card without figures, no error
  const figs0 = createFigures({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lit-figs0-')), kbDir, mirror, fulltext, ask: async () => { throw new Error('model down'); }, renderFn, log: () => {} });
  ok('the model fails while looking for figures: none, and no error for the card (tried again next time)', (await figs0.ensure(item.key)).length === 0 && (await figs0.ensure(item.key)).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
