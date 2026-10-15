// Cards: one Markdown file per paper in the knowledge base (papers/<citekey>.md), written by the model and owned by the
// user. Two kinds: 速读卡 (quick: abstract + first pages) and 深读卡 (deep: the full text, claims with page numbers).
// The sections the model writes are tracked by a hash in the front matter ("ai"): when the user has changed them, a new
// version from the model becomes a proposal instead of overwriting; the user's own sections (我的理解, 我的笔记) and
// the annotations pulled from Zotero (我的批注) are carried over every time.
// A deep card shows the paper's key figures, each with what the model says of it (图表: the figures are cut out of the
// pages -- figures.js -- and kept beside the cards, figures/<citekey>/; Zotero's note gets the text without the pictures).
// A copy goes to Zotero as a child note of the paper (tag "Windose卡片"), when Zotero's write access was granted.
'use strict';
const path = require('path');
const { QUICK_SCHEMA, DEEP_SCHEMA, quickPrompt, deepPrompt } = require('./prompts/card');
const { pickPages, fitPages } = require('./fulltext');
const { formatRanges, parseRanges } = require('./vision');
const { flowMermaid } = require('./flow');

const NOTE_TAG = 'Windose卡片';
const USER_SECTIONS = new Set(['我的理解', '我的笔记']);
const AUTO_SECTIONS = new Set(['我的批注']);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };   // (local date)
const list = (a, f = (x) => x) => (a || []).filter(Boolean).map((x) => '- ' + f(x)).join('\n');

// the user's annotations / notes on an item as lines for the prompts and the card
function annotationLines(mirror, key) {
  const out = [];
  for (const a of mirror.annotationsOf(key)) {
    if (a.type === 'ink') { out.push(`（手写批注，第 ${a.page || '?'} 页${a.comment ? '：' + a.comment : ''}）`); continue; }
    const t = [a.text && `“${a.text.trim()}”`, a.comment && `— ${a.comment.trim()}`].filter(Boolean).join(' ');
    if (t) out.push(`${t}${a.page ? `（p.${a.page}）` : ''}`);
  }
  for (const n of mirror.childrenOf(key).notes) if (!n.tags.includes(NOTE_TAG) && n.text) out.push('笔记：' + n.text.slice(0, 800));
  return out;
}

// Markdown -> the little HTML a Zotero note needs
function noteHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inl = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[\[([^\]]+)\]\]/g, '$1');
  const out = []; let inList = false, fence = false;
  for (const line of md.split('\n')) {
    // (a flowchart: the note cannot draw it -- the method's text is there anyway)
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const li = /^\s*-\s+(\[[ x]\]\s+)?(.*)$/.exec(line);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${li[1] ? (li[1].includes('x') ? '☑ ' : '☐ ') : ''}${inl(li[2])}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(line)) continue;               // (a figure: the note has no pictures)
    const hd = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hd) out.push(`<h${hd[1].length}>${inl(hd[2])}</h${hd[1].length}>`);
    else if (/^>\s?/.test(line)) out.push(`<blockquote>${inl(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inl(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<div data-schema-version="9">${out.join('')}</div>`;
}

// ask: the quick cards' model (文献推送); askDeep: the deep cards' (文献深读); vision: the pages read as images (vision.js);
// myNotes(key): what the user wrote in 深读's 笔记 (notes.js), one line each -- the models read it with the annotations;
// digest: what a deep card reads of a report too long to give whole (digest.js; without it the start of every page)
function createCards({ kb, mirror, fulltext, profile, ask, askDeep = ask, api, vision = null, figures = null, digest = null, myNotes = () => [], writeNotes = true, log = () => {}, onChange = () => {} }) {
  const marks = (key) => [...annotationLines(mirror, key), ...myNotes(key)];
  const jobs = new Map();                              // item key -> { kind, running, error, at }
  let queue = Promise.resolve();

  // the card of an item: by the zotero key in its front matter (a renamed file is still found)
  function find(key) {
    const it = mirror.item(key);
    const direct = it && kb.read(`papers/${kb.fileName(it.citekey)}.md`);
    if (direct && direct.meta.zotero === key) return direct;
    return kb.list('papers').find((r) => r.meta.zotero === key) || null;
  }
  const others = (except) => kb.list('papers').filter((r) => r.meta.zotero !== except).map((r) => ({ citekey: path.basename(r.path, '.md'), title: r.meta.title || '' })).slice(0, 150);
  const qText = (n) => { const q = profile.openQuestions()[n - 1]; return q ? q.text : ''; };

  // 图表: the figures the model picked, each with its reading -- the picture, what it says, the caption as printed
  // shown: [{ fig: { id, page, label, caption }, title, reading, rel: its path in the knowledge base }]
  function figureSection(shown) {
    return shown.map((x) => {
      const name = [x.fig.label, x.title].filter(Boolean).join(' · ') || '图';
      return [`### ${name} [p.${x.fig.page}]`, `![${(x.fig.label || x.title || '图').replace(/[\[\]]/g, '')}](../${x.rel})`, x.reading, x.fig.caption ? `> 图题：${x.fig.caption}` : ''].filter(Boolean).join('\n\n');
    }).join('\n\n');
  }
  // the model's answer -> the card's sections (the ones the model owns)
  function aiSections(kind, a, item, shown = []) {
    const s = [];
    s.push({ title: '', text: `# ${item.title}\n\n> ${a.oneLine || ''}` });
    s.push({ title: '问题', text: a.problem || '' });
    if (kind === 'deep') s.push({ title: '科学问题', text: (a.science || []).filter((x) => x && String(x.question || '').trim()).map((x, i) => `${i + 1}. **问：** ${String(x.question).trim()}\n   **答：** ${String(x.answer || '').trim() || '（文中没有回答）'}`).join('\n') });
    // (the deep card's method begins with its flowchart)
    const chart = kind === 'deep' ? flowMermaid(a.flow) : '';
    s.push({ title: '方法', text: [chart, a.method || ''].filter(Boolean).join('\n\n') });
    if (kind === 'deep') s.push({ title: '关键假设', text: list(a.assumptions) });
    s.push({ title: '主要结果', text: list(a.results) });
    if (shown.length) s.push({ title: '图表', text: figureSection(shown) });
    s.push({ title: '与我的关系', text: (a.question > 0 && qText(a.question) ? `**Q${a.question}：${qText(a.question)}**\n\n` : '') + (a.relevance || '') });
    if (kind === 'deep') {
      s.push({ title: '可以采取的行动', text: list(a.actions, (x) => '[ ] ' + x) }, { title: '可复用的公式与数据', text: list(a.reusable) },
        { title: '疑点', text: list(a.doubts) }, { title: '值得追的文献', text: list(a.follow) });
      if (a.history) s.push({ title: '历史与后续', text: a.history });
      if ((a.relations || []).length) s.push({ title: '关系', text: list(a.relations, (r) => `${r.type} [[${r.citekey}]]${r.note ? '：' + r.note : ''}`) });
    } else s.push({ title: '值得深读吗', text: a.worth || '' });
    return s.filter((x) => x.text.trim());
  }
  const aiHash = (secs) => kb.hash(secs.filter((s) => !USER_SECTIONS.has(s.title) && !AUTO_SECTIONS.has(s.title)).map((s) => s.title + '\n' + s.text.trim()).join('\n\n'));

  // write (or propose) the card; returns { path, proposed }
  function store(item, kind, a, extra = {}) {
    const cur = find(item.key);
    const rel = cur ? cur.path : `papers/${kb.fileName(item.citekey)}.md`;
    // the figures the model picked (by their ids, the ones that exist), copied to the knowledge base under the card's name
    const picked = (extra.figs || []).length ? (a.figures || []).map((x) => ({ fig: extra.figs.find((g) => g.id === String(x.id || '').replace(/^\[?F:/, '').replace(/\]$/, '').trim()), title: String(x.title || '').trim().slice(0, 40), reading: String(x.reading || '').trim() }))
      .filter((x, i, all) => x.fig && x.reading && all.findIndex((y) => y.fig === x.fig) === i).slice(0, 8) : [];
    const put = figures && kind === 'deep' ? figures.publish(item.key, path.basename(rel, '.md'), picked.map((x) => x.fig.id)) : {};
    const shown = picked.map((x) => ({ ...x, rel: put[x.fig.id] })).filter((x) => x.rel);
    const secs = aiSections(kind, a, item, shown);
    const notes = annotationLines(mirror, item.key);
    if (notes.length) secs.push({ title: '我的批注', text: list(notes) });
    if (cur) for (const s of cur.sections) if (USER_SECTIONS.has(s.title) && s.text) secs.push(s);
    const meta = { title: item.title, zotero: item.key, citekey: path.basename(rel, '.md'), doi: item.doi || undefined, year: item.year || undefined, venue: item.venue || undefined,
      authors: item.creators.slice(0, 8), status: kind, question: a.question > 0 ? a.question : undefined, verified: false, pdf: extra.pdf, getpdf: extra.getPdf, vision: extra.vision, cover: shown.length ? shown[0].rel : undefined, figs: shown.length || undefined,
      starred: cur ? cur.meta.starred : undefined, updated: today(), ai: aiHash(secs) };
    const text = kb.stringify(meta, secs.map((s) => (s.title ? `## ${s.title}\n\n${s.text}` : s.text)).join('\n\n') + '\n');
    // the user changed what the model wrote last time: this version waits as a proposal
    if (cur && cur.meta.ai && aiHash(cur.sections) !== cur.meta.ai) {
      kb.propose({ path: rel, op: { type: 'replace-all', text: kb.parse(text).body }, reason: `新的${kind === 'deep' ? '深读' : '速读'}卡（你改过卡片，没有直接覆盖）`, source: 'card' });
      return { path: rel, proposed: true };
    }
    kb.write(rel, text, null, kind === 'deep' ? '深读卡' : '速读卡');
    kb.rebuildIndex();
    return { path: rel, proposed: false, text };
  }

  // the card as a child note in Zotero (updated in place); skipped without write access
  async function toZotero(item, text) {
    if (!writeNotes || !api.canWrite()) return false;
    const html = noteHtml(kb.parse(text).body);
    const ours = () => mirror.childrenOf(item.key).notes.find((n) => n.tags.includes(NOTE_TAG));
    try {
      const old = ours();
      if (!old) await api.createItems([{ itemType: 'note', parentItem: item.key, note: html, tags: [{ tag: NOTE_TAG }], relations: {} }]);
      else {
        try { await api.patchItem(old.key, old.version, { note: html }); }
        catch (e) {                                       // (the copy here was behind Zotero's: read it again, once)
          if (e.status !== 412) throw e;
          await mirror.refresh(true); const again = ours();
          if (again) await api.patchItem(again.key, again.version, { note: html });
        }
      }
      return true;
    } catch (e) { log('文献：卡片写回 Zotero 失败：' + e.message); return false; }
  }

  async function makeQuick(key) {
    const item = mirror.item(key); if (!item) throw new Error('Zotero 里找不到这篇');
    const ft = await fulltext.forItem(key);
    // (a scan's thin text still helps a little: whatever text there is goes along)
    const pages = ft.pages && ft.chars > 0 ? pickPages(ft.pages, profile.words(), 20000, ft.labels).slice(0, 6) : [];
    const a = await ask(quickPrompt(profile.get() || {}, item, pages, marks(key)), QUICK_SCHEMA);
    const r = store(item, 'quick', a, { pdf: !!ft.pages, getPdf: !ft.pages && a.getPdf && a.getPdf.worth ? (a.getPdf.why || '值得找全文') : undefined });
    if (r.text) toZotero(item, r.text);
    return { ...r, pdf: !!ft.pages, missing: ft.missing || '', getPdf: a.getPdf };
  }
  async function makeDeep(key) {
    const item = mirror.item(key); if (!item) throw new Error('Zotero 里找不到这篇');
    if (vision) await vision.prepare(key, { wait: true });       // a short paper: read whole as images first
    const ft = await fulltext.forItem(key);
    if (!ft.pages || !ft.pages.length) throw Object.assign(new Error(ft.missing === 'nofile' ? 'PDF 还没同步到群晖' : '没有可读的 PDF 正文'), { code: 'NOPDF' });
    if (ft.scanned) log(`文献：${key} 像是扫描件，正文很少，深读卡可能不准`);
    const cur = find(key);
    const mine = cur ? ((cur.sections.find((s) => s.title === '我的理解') || {}).text || '') : '';
    const vi = vision ? await vision.info(key) : null;
    const read = ft.vision && ft.vision.length ? formatRanges(ft.vision) : '';
    const long = !!(vi && vi.n && !vi.auto && (ft.vision || []).length < vi.n);
    const figs = figures ? await figures.ensure(key) : [];          // the paper's figures, cut out of its pages
    // the whole text, or for a report too long for that, the notes made of it part by part
    const body = digest ? await digest.forCard(item, ft) : { pages: fitPages(ft.pages, 90000, ft.labels) };
    const a = await askDeep(deepPrompt(profile.get() || {}, item, body.pages || [], marks(key), mine, others(key), { n: vi && vi.n, read, rest: !!(read && vi && ft.vision.length < vi.n), long, digest: body.digest }, figs), DEEP_SCHEMA);
    // a long paper with pages worth reading as images: the request waits for the user's approval
    // (only the pages not read yet: a card made again after some were read may name them again)
    const ask4 = long && a.vision && a.vision.worth ? parseRanges(String(a.vision.pages || '').trim() || 'x', vi.n).filter((p) => !(ft.vision || []).includes(p)) : [];
    if (ask4.length) vision.request(key, formatRanges(ask4), a.vision.why, 'model');
    const r = store(item, 'deep', a, { pdf: true, vision: read || undefined, figs });
    if (r.text) toZotero(item, r.text);
    return { ...r, pdf: true };
  }

  // one model job at a time; state per item for the window
  function run(key, kind) {
    const j = jobs.get(key);
    if (j && j.running) return { ok: false, msg: '这篇正在生成' };
    const job = { kind, running: true, error: '', at: Date.now() };
    jobs.set(key, job); onChange(key);
    queue = queue.then(() => (kind === 'deep' ? makeDeep(key) : makeQuick(key)))
      .then((r) => { job.result = { path: r.path, proposed: r.proposed, pdf: r.pdf, missing: r.missing || '', getPdf: r.getPdf || null }; },
        (e) => { job.error = e.message; job.code = e.code || ''; log(`文献：${kind === 'deep' ? '深读' : '速读'}卡失败 ${key}：${e.message}`); })
      .finally(() => { job.running = false; job.done = Date.now(); onChange(key); });
    return { ok: true, wait: queue };
  }
  const state = (key) => jobs.get(key) || null;
  // the user's own section (我的理解 / 我的笔记): written straight away (it is the user's text)
  function setOwn(key, section, text, base) {
    if (!USER_SECTIONS.has(section)) return { ok: false, msg: '只能直接改你自己的小节' };
    const item = mirror.item(key); if (!item) return { ok: false, msg: '找不到这篇' };
    let cur = find(key);
    if (!cur) {                                           // no card yet: a minimal one holding just this
      const meta = { title: item.title, zotero: key, citekey: item.citekey, doi: item.doi || undefined, year: item.year || undefined, status: 'none', updated: today(), ai: '' };
      kb.write(`papers/${kb.fileName(item.citekey)}.md`, kb.stringify(meta, `# ${item.title}\n`), '', '');
      cur = find(key);
    }
    if (base != null && base !== cur.hash) return { ok: false, conflict: true, msg: '卡片在别处被改过了，请刷新后再改' };
    const { meta, body } = kb.parse(cur.text);
    return kb.write(cur.path, kb.stringify({ ...meta, updated: today() }, kb.applyOp(body, { type: 'replace', section, text })), cur.hash, section === '我的理解' ? '写下理解' : '');
  }
  function setMeta(key, patch) {
    const cur = find(key); if (!cur) return { ok: false, msg: '还没有卡片' };
    const { meta, body } = kb.parse(cur.text);
    const next = { ...meta };
    for (const k of ['starred', 'verified']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    if (patch.verified === true && next.status === 'deep') next.status = 'reviewed';
    return kb.write(cur.path, kb.stringify(next, body), cur.hash, patch.verified ? '核对了卡片' : '');
  }
  // actions of a card ("- [ ] ..." under 可以采取的行动)
  function actions(key) {
    const cur = find(key); if (!cur) return [];
    const s = cur.sections.find((x) => x.title === '可以采取的行动');
    return s ? s.text.split('\n').map((l) => /^-\s+\[( |x)\]\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ done: m[1] === 'x', text: m[2].trim() })) : [];
  }
  // a card in brief: what it is of, how far it got, its one line and its first figure
  function briefOf(r) {
    const it = mirror.item(r.meta.zotero);
    return { key: r.meta.zotero, citekey: path.basename(r.path, '.md'), title: r.meta.title || (it && it.title) || '', status: r.meta.status, starred: !!r.meta.starred, verified: !!r.meta.verified,
      updated: r.meta.updated || '', year: r.meta.year || '', venue: r.meta.venue || '', authors: r.meta.authors || [], question: r.meta.question || 0,
      oneLine: ((/^>\s*(.+)$/m.exec(r.body) || [])[1] || '').trim(), cover: r.meta.cover || '', figs: r.meta.figs || 0, gone: !it };
  }
  const made = (r) => !!(r && r.meta.zotero && r.meta.status && r.meta.status !== 'none');
  // the card of one paper (今日卡片), or null; hash: of its text as it is now
  function brief(key) { const r = find(key); return made(r) ? { ...briefOf(r), hash: r.hash } : null; }
  // every card, for 卡片库
  function all() {
    return kb.list('papers').filter(made).map(briefOf).sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.title.localeCompare(b.title));
  }
  return { find, all, brief, run, state, setOwn, setMeta, actions, makeQuick, makeDeep, annotationLines: (k) => annotationLines(mirror, k), NOTE_TAG };
}

module.exports = { createCards, noteHtml, annotationLines, NOTE_TAG };
