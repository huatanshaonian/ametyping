// 文献: the literature module -- the daily push, cards, deep reading and the knowledge base, on top of the user's Zotero
// (the Zotero 10 running in the NAS's container: deploy/nas/zotero/). Settings are config.json "literature" (all
// optional except that the section must be there):
//   zotero           the local API (default http://127.0.0.1:23119)
//   webdavDir        Zotero's WebDAV folder on the NAS (e.g. /volume1/zotero): PDFs are read from there, never written
//   kbDir            the knowledge base folder (default <dataDir>/literature/kb; a shared folder lets Obsidian open it)
//   pdftotext        poppler's pdftotext (default "pdftotext")
//   proxies          HTTP proxies for the hosts in viaProxy (default: the summary's); viaProxy default ["ntrs.nasa.gov"]
//   mailto           a contact address for Crossref / OpenAlex / Unpaywall (Unpaywall needs one); empty = not sent
//   openalexKey      a free OpenAlex key (a larger daily budget)
//   browserPort      the DevTools port of the browser signed in to the library (图书馆通道; also in 控制面板 › 文献)
//   daily 2, at "07:30", minScore 6, reviewCollection "气动隐身", inboxCollection "每日文献", writeNotes true
//   downloadCollection "文献下载"  where papers asked for by DOI go (下载: downloads.js)
//   agentSocket      the local socket agents' MCP talks to (default <dataDir>/literature/agent.sock; false = none)
// Web API (all under /api/lit, the page's login applies; POSTs are same-origin): see handle() below.
'use strict';
const fs = require('fs');
const path = require('path');
const { createHttp } = require('./http');
const { createLocalApi } = require('./zotero/local-api');
const { createMirror } = require('./zotero/mirror');
const { createWebdav } = require('./zotero/webdav');
const { createFulltext } = require('./fulltext');
const { createKb } = require('./kb');
const { createProfile } = require('./profile');
const { createCards } = require('./cards');
const { createFeed, ymd } = require('./feed');
const { createIntake } = require('./intake');
const { createReader } = require('./reader');
const { createOpenAlex } = require('./sources/openalex');
const { createCrossref, createArxiv, createAiaa, createNtrs, createDtic, createUnpaywall } = require('./sources/feeds');
const { createEgress } = require('../egress');
const { createStats } = require('./stats');
const { createS2 } = require('./sources/s2');
const { createSettings } = require('./settings');
const { createVision } = require('./vision');
const { createFigures } = require('./figures');
const { createSurvey } = require('./survey');
const { createHistory } = require('./history');
const { createReview } = require('./review');
const { createLibrary } = require('./browser/library');
const { createUpload } = require('./upload');
const { createTranslate } = require('./translate');
const { createAbsJob } = require('./absjob');
const { createCnJournals } = require('./sources/cnjournals');
const { createPdfQueue } = require('./pdfqueue');
const { createNotes } = require('./notes');
const { createAnnots } = require('./annots');
const { createDigest } = require('./digest');
const { createDownloads, doisIn, pdfName } = require('./downloads');
const { createAgentSocket, defaultSocket, evidencePaper, DEFAULT_SCHEMA, KEY } = require('./agent-socket');
const { openKbStruct } = require('./kb-struct');
const { listSchemas, getSchema } = require('./evidence-schemas');
const { createEvidence } = require('./evidence');
const { createBenchmark } = require('./benchmark');
const { createStream } = require('./stream');

function createLiterature({ dataDir, cfg = {}, proxies = [], ask, todos = null, reports = () => null, mail = () => null, log = console.log, audit = () => {}, onChange = () => {}, embed = null }) {
  if (!cfg || cfg.enabled === false || !ask) return null;
  const dir = path.join(dataDir, 'literature');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const E = cfg.endpoints || {};                                     // (tests point the sources at fakes)
  const px = Array.isArray(cfg.proxies) ? cfg.proxies : proxies;
  const http = createHttp({ egress: px.length ? createEgress({ proxies: px, log }) : null, viaProxy: cfg.viaProxy || ['ntrs.nasa.gov', 'archive.org', 'dtic.mil'] });
  const changed = (what) => { try { onChange(what); } catch {} };
  // two jobs in 控制面板 › AI 模型, each with its own model / effort: the many small calls of the push, and the reading
  const askFeed = (p, s) => ask(p, s, 'litFeed'), askRead = (p, s) => ask(p, s, 'litRead');
  const askVision = (p, s, o) => ask(p, s, 'litVision', o);                         // (reading pages as images)

  const api = createLocalApi({ base: cfg.zotero || 'http://127.0.0.1:23119', http, dir, log });
  const kb = createKb({ dir: path.resolve(cfg.kbDir || path.join(dir, 'kb')), log, onChange: () => changed('kb') });
  let intake = null;
  let scheduleAutoEvidence = () => {};
  const mirror = createMirror({ api, dir, log, everyMs: cfg.refreshMs != null ? +cfg.refreshMs : 60e3, onChange: () => { changed('library'); if (intake) intake.onLibrary().catch(() => {});
    // (the library's vectors follow it: only the new and changed abstracts / notes are embedded)
    if (embed && embed.job && typeof embed.job.syncLitOnce === 'function') setImmediate(() => { Promise.resolve().then(() => embed.job.syncLitOnce()).catch(() => {}); });
    setImmediate(() => scheduleAutoEvidence()); } });
  const webdav = createWebdav({ dir: cfg.webdavDir || '' });
  const fulltext = createFulltext({ dir, mirror, webdav, bin: cfg.pdftotext || 'pdftotext', http, ntrsBase: E.ntrs || undefined, iaBase: E.dtic || undefined, log });
  const kbStruct = openKbStruct({ dir, log });
  const evidence = kbStruct && createEvidence({ kbStruct, mirror, fulltext, ask: askRead, log });
  const benchmark = kbStruct && createBenchmark({ kbStruct, dir, log });
  let paradigm = null;
  if (kbStruct) {
    try {
      const { createParadigm } = require('./paradigm');
      paradigm = createParadigm({ kbStruct, embed, mirror, ask: askRead, log });
    } catch (e) { log('文献：矛盾分析模块不可用：' + e.message); }
  }
  // Auto-incremental evidence extraction + throttled paradigm update when new/changed PDFs appear in Zotero
  if (cfg.autoEvidence !== false && evidence && kbStruct) {
    let autoRunning = false;
    let autoPending = false;
    const lastParadigmAt = new Map();
    const PARADIGM_COOLDOWN_MS = 30 * 60e3;
    const PLASMA_COLS = new Set(['等离子体RCS', '等离子体鞘套电磁散射']);
    const AERO_COLS = new Set(['气动隐身', '调研工作', '每日文献', '基础理论']);
    const runAutoOnce = async () => {
      if (autoRunning) { autoPending = true; return; }
      autoRunning = true;
      try {
        const plasmaKeys = new Set();
        const aeroKeys = new Set();
        for (const c of mirror.collections()) {
          if (PLASMA_COLS.has(c.name)) {
            for (const it of mirror.inCollection(c.key)) if (fulltext.hasPdf(it.key)) plasmaKeys.add(it.key);
          }
        }
        for (const c of mirror.collections()) {
          if (AERO_COLS.has(c.name)) {
            for (const it of mirror.inCollection(c.key)) if (!plasmaKeys.has(it.key) && fulltext.hasPdf(it.key)) aeroKeys.add(it.key);
          }
        }
        const pairs = [
          ['plasma_rcs_v1', [...plasmaKeys]],
          ['aero_stealth_v1', [...aeroKeys]],
        ];
        for (const [schemaId, keys] of pairs) {
          const existing = new Set((kbStruct.listEvidence(schemaId) || []).map((r) => r.zoteroKey));
          const todo = keys.filter((k) => !existing.has(k));
          if (!todo.length) continue;
          let added = 0;
          for (const k of todo.slice(0, 10)) {
            try {
              const r = await evidence.extractPaper(k, schemaId, { force: false });
              if (r && r.ok && !r.skipped) { added++; changed('evidence'); }
            } catch (e) { log(`文献自动证据抽取失败 ${k}：${e.message}`); }
          }
          if (added > 0 && paradigm && (Date.now() - (lastParadigmAt.get(schemaId) || 0) >= PARADIGM_COOLDOWN_MS)) {
            lastParadigmAt.set(schemaId, Date.now());
            try {
              await paradigm.analyzeContradictions(schemaId, { threshold: 0.68 });
              changed('evidence');
            } catch (e) { log(`文献自动矛盾更新失败 ${schemaId}：${e.message}`); }
          }
        }
      } catch (e) {
        log('文献自动增量抽取异常：' + e.message);
      } finally {
        autoRunning = false;
        if (autoPending) { autoPending = false; setImmediate(runAutoOnce); }
      }
    };
    scheduleAutoEvidence = () => { runAutoOnce().catch(() => {}); };
  }
  // 控制面板 › 文献: keys, the contact address and the push's numbers, read by the sources and the push as they run
  const settings = createSettings({ dir, cfg });
  // 读图: pages read as images take the place of the text layer's wherever the paper's text is used
  // (pages of a deep card's paper read as images on the user's approval -- the card asked for them: it is made again
  // with them, and the figures on them looked for)
  const vision = createVision({ dir, mirror, fulltext, ask: askVision, maxPages: () => settings.feed().visionMaxPages, log, onChange: (k) => changed('vision:' + k),
    onRead: (k, why) => { const c = why === 'approved' && cards.find(k); if (c && /deep|reviewed/.test(c.meta.status)) { log(`文献：${k} 批准的页读完了，重做深读卡`); cards.run(k, 'deep'); } } });
  fulltext.useOverlay(vision.apply);
  // 图表: the papers' figures, cut out of their pages for the deep cards
  const figures = createFigures({ dir, kbDir: kb.dir, mirror, fulltext, ask: askVision, log, ...(cfg.figuresOpts || {}) });
  const mailto = () => settings.mailto();
  const sources = {
    openalex: createOpenAlex({ http, base: E.openalex, key: () => settings.keyOf('openalex'), mailto }),
    crossref: createCrossref({ http, base: E.crossref, mailto }),
    s2: createS2({ http, base: E.s2, key: () => settings.keyOf('s2') }),
    arxiv: createArxiv({ http, base: E.arxiv }), aiaa: createAiaa({ http, base: E.aiaa }), ntrs: createNtrs({ http, base: E.ntrs }),
    dtic: createDtic({ http, base: E.dtic, dticBase: E.dticApps }),
    cn: E.cn === undefined ? createCnJournals({ http }) : E.cn && createCnJournals({ http, journals: E.cn }),
  };
  for (const k of Object.keys(sources)) if (E[k] === false) delete sources[k];
  const unpaywall = createUnpaywall({ http, base: E.unpaywall, mailto });
  // 问题演化: every change of the line and the questions, whoever made it
  const history = createHistory({ dir, onChange: () => changed('review') });
  const profile = createProfile({ dir, mirror, ask: askFeed, openalex: sources.openalex, s2: sources.s2 || null, reports, log,
    onEdit: (before, after, by) => { if (!history.count()) history.seed({ ...before, organizedAt: Date.now() }); history.track(before, after, by); } });
  // 笔记: what the user writes beside a paper in 深读 (typed or by hand), in the knowledge base beside its card
  // 批注: highlights / underlines / notes made on the 深读 PDF, kept in Zotero
  const annots = createAnnots({ api, mirror, log, onChange: (k) => changed('annots:' + k) });
  const notes = createNotes({ dir, kbDir: kb.dir, mirror, ask: askVision, todos, log, onChange: (k) => changed('notes:' + k),
    citekeyOf: (it) => { const c = cards.find(it.key); return c ? path.basename(c.path, '.md') : kb.fileName(it.citekey); } });
  // 长报告: a text too long for the deep card is summed up part by part first
  const digest = createDigest({ dir, ask: askFeed, log, ...(cfg.digestOpts || {}) });
  const cards = createCards({ kb, mirror, fulltext, profile, ask: askFeed, askDeep: askRead, api, vision, digest, figures: cfg.figures === false ? null : figures, myNotes: notes.lines, writeNotes: cfg.writeNotes !== false, log, onChange: (k) => changed('card:' + k), kbStruct, embed });
  const stream = kbStruct && createStream({ kbStruct, mirror, cards, fulltext, ask: askFeed, log });
  const conf = () => ({ ...cfg, ...settings.feed() });
  // the push's "like these": starred and checked cards, and the key papers (their DOIs)
  const likes = () => ({ pos: [...new Set([...kb.list('papers').filter((r) => (r.meta.starred || r.meta.verified) && r.meta.doi).map((r) => String(r.meta.doi)),
    ...(((profile.get() || {}).follow || {}).seeds || []).map((x) => x.doi).filter(Boolean)])], neg: [] });
  // 摘要对照: the abstracts of the picks waiting (today's and the ones kept aside) in Chinese, as soon as they are there
  const translate = createTranslate({ dir, ask: askFeed, field: () => (profile.get() || {}).line || '', log, onChange: () => changed('feed') });
  const wantFeed = () => { translate.want([...feed.list().filter((e) => e.kind === 'new' && e.status === 'new'), ...feed.pool()].map((e) => e.paper.abstract)); };
  let libAccess = null;
  let scheduleAutoKeep = () => {};
  const feed = createFeed({ dir, cfg: conf, mirror, profile, sources, ask: askFeed, cards, mail, likes, log, holdAbstracts: () => !!(libAccess && libAccess.enabled()), embed, kbStruct, paradigm, ...(cfg.feedOpts || {}), onChange: () => { changed('feed'); wantFeed(); setImmediate(() => scheduleAutoKeep()); } });
  // 图书馆通道: PDFs no open-access copy was found for, through the browser signed in to the user's library access
  libAccess = createLibrary({ port: () => conf().browserPort, account: () => conf().ieeeAccount, idp: () => conf().ieeeIdp, accessAccount: () => conf().myloftAccount, log, ...(cfg.browser || {}) });
  const pdfq = createPdfQueue({ dir, cfg: conf, library: libAccess, api, mirror, fulltext, log, onChange: () => changed('pdfq'), ...(cfg.pdfQueue || {}) });
  const upload = createUpload({ api, mirror, fulltext, pdfq, log });
  // abstracts the indexes lack, read off the articles' pages in that browser while the PDF queue has nothing to do
  const absjob = createAbsJob({ feed, library: libAccess, idle: () => !pdfq.status().running, log, ...(cfg.absJob || {}) });
  intake = createIntake({ cfg: conf, api, mirror, fulltext, cards, feed, http, unpaywall, ask: askFeed, profile, pdfq, log, onChange: () => changed('feed') });
  // Auto-keep high-score pushed papers into Zotero + PDF + deep card when config "autoKeepMinScore" > 0
  {
    let autoKeepRunning = false;
    let autoKeepPending = false;
    const runAutoKeep = async () => {
      const minScore = Number(conf().autoKeepMinScore || 0);
      if (!(minScore > 0) || !api.canWrite()) return;
      if (autoKeepRunning) { autoKeepPending = true; return; }
      autoKeepRunning = true;
      try {
        const todo = feed.list()
          .filter((e) => e.kind === 'new' && e.status === 'new' && !e.zkey && (+e.score || 0) >= minScore)
          .slice(0, 5);
        for (const e of todo) {
          try {
            const r = await intake.keep(e.id);
            if (r && r.ok) log(`文献：自动入库高分论文（${e.score}/10）「${String((e.paper && e.paper.title) || '').slice(0, 50)}」`);
          } catch (err) {
            log(`文献：自动入库失败 ${e.id}：${err.message}`);
          }
        }
      } finally {
        autoKeepRunning = false;
        if (autoKeepPending) { autoKeepPending = false; setImmediate(runAutoKeep); }
      }
    };
    scheduleAutoKeep = () => { runAutoKeep().catch(() => {}); };
  }
  // 下载: papers by DOI, from 文献库's box or an agent (the MCP, over a local socket only: agent-socket.js, mcp.js)
  const downloads = createDownloads({ dir, cfg: conf, api, mirror, fulltext, pdfq, fetchPdf: intake.fetchPdf, log, onChange: () => changed('downloads'),
    lookups: [sources.openalex && ((d) => sources.openalex.byDoi(d)), sources.crossref && ((d) => sources.crossref.byDoi(d))].filter(Boolean), ...(cfg.downloadsOpts || {}) });
  const agentSock = cfg.agentSocket === false ? null : createAgentSocket({ socket: cfg.agentSocket || defaultSocket(dir), downloads, log, audit,
    kb: { mirror, fulltext, kbStruct, evidence, paradigm, embed, librarySearch: libraryHybrid } });
  const reader = createReader({ dir, kb, mirror, fulltext, cards, profile, ask: askRead, vision, log, onChange: (k) => changed('read:' + k) });
  const survey = createSurvey({ cfg: conf, api, mirror, profile, openalex: sources.openalex, ask: askFeed, fetchPdf: intake.fetchPdf, fulltext, pdfq, log, onChange: () => changed('survey') });
  const stats = createStats({ kb, feed, todos });
  // 回顾: monthly / quarterly, proposing changes to the questions and the line for the user to approve
  const review = createReview({ dir, kb, profile, history, feed, reports, ask: (p, s) => ask(p, s, 'litReview'), survey, canWrite: () => api.canWrite(), auto: cfg.review !== false, log, onChange: () => changed('review') });
  if (cfg.review !== false) review.startTimer();

  mirror.start();
  intake.start();
  pdfq.start();
  downloads.start();
  if (agentSock) agentSock.start();
  absjob.start();
  if (cfg.feed !== false) feed.start();
  let authError = '';

  // ---- what the window shows ----
  function itemOut(it) {
    const card = cards.find(it.key);
    return { key: it.key, title: it.title, creators: it.creators.slice(0, 6), year: it.year, venue: it.venue, doi: it.doi, citekey: it.citekey, collections: it.collections,
      added: it.added, pdf: fulltext.hasPdf(it.key), notes: mirror.annotationCount(it.key), card: card ? { status: card.meta.status, starred: !!card.meta.starred, verified: !!card.meta.verified } : null };
  }
  function library({ col = '', q = '', n = 300, starred = false } = {}) {
    let list = col ? mirror.inCollection(col) : mirror.items();
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) list = list.filter((it) => { const t = [it.title, it.abstract, it.venue, it.creators.join(' '), it.citekey, it.tags.join(' ')].join(' ').toLowerCase(); return terms.every((w) => t.includes(w)); });
    let out = list.sort((a, b) => b.added - a.added).map(itemOut);
    if (starred) out = out.filter((x) => x.card && x.card.starred);
    return out.slice(0, n);
  }
  // With a query: the words' matches above fused (RRF, k=60) with the vector search over abstracts, notes and
  // annotations (embed/search.queryLit) -- a Chinese query finds the English papers, a paper is found by what was
  // noted on it. mode=keyword, no vector index, or the service offline: the words alone (semantic: off / unavailable).
  async function libraryHybrid({ col = '', q = '', n = 300, starred = false, mode = '' } = {}) {
    const kw = library({ col, q, n: Infinity, starred });
    if (!String(q || '').trim() || mode === 'keyword' || !embed || !embed.search || typeof embed.search.queryLit !== 'function') return { items: kw.slice(0, n), semantic: 'off' };
    let sem = null;
    try { sem = await embed.search.queryLit(q, { topK: 50 }); } catch (e) { sem = { ok: false, reason: e.message }; }
    if (!sem || !sem.ok) return { items: kw.slice(0, n), semantic: 'unavailable' };
    const allowed = new Map((col ? mirror.inCollection(col) : mirror.items()).map((it) => [it.key, it]));
    const semList = [];
    for (const x of sem.items || []) {
      const it = allowed.get(x.key); if (!it) continue;
      const o = itemOut(it);
      if (starred && !(o.card && o.card.starred)) continue;
      semList.push(o);
    }
    const fused = new Map();
    const add = (list) => list.forEach((o, i) => { const f = fused.get(o.key) || { o, s: 0 }; f.s += 1 / (60 + i + 1); fused.set(o.key, f); });
    add(kw); add(semList);
    return { items: [...fused.values()].sort((a, b) => b.s - a.s).slice(0, n).map((f) => f.o), semantic: 'ok' };
  }
  function itemDetail(key) {
    const it = mirror.item(key); if (!it) return null;
    const card = cards.find(key);
    const entry = feed.entries().find((e) => e.zkey === key || e.key === key) || null;
    return { ...itemOut(it), abstract: it.abstract, abstractTr: translate.get(it.abstract), abstractForeign: translate.foreign(it.abstract), url: it.url, tags: it.tags, number: it.number,
      annotations: mirror.annotationsOf(key).map((a) => ({ type: a.type, text: a.text, comment: a.comment, page: a.page, color: a.color })),
      card: card ? { path: card.path, text: card.text, hash: card.hash, meta: card.meta } : null, job: cards.state(key), actions: cards.actions(key), entry,
      pdfNote: pdfq.note(key), pdfVia: pdfq.status().enabled && !!it.doi,
      collectionNames: it.collections.map((c) => (mirror.collections().find((x) => x.key === c) || {}).name).filter(Boolean) };
  }
  // a pick as 今日 shows it: an open one with its abstract in Chinese, a kept one with its card in brief
  function feedOut(e) {
    if (e.kind !== 'new') return e;
    if (e.status === 'kept' && e.zkey) return { ...e, card: cards.brief(e.zkey), job: (cards.state(e.zkey) || {}).running ? cards.state(e.zkey).kind : '' };
    return { ...e, tr: translate.get(e.paper.abstract) };
  }
  // the profile as the window shows it: each branch's papers with their titles (keys mean nothing to the user)
  function profileOut() {
    const pr = profile.get(); if (!pr) return null;
    const brief = (k) => { const it = mirror.item(k); return it ? { key: k, title: it.title, year: it.year, citekey: it.citekey } : null; };
    return { ...pr, topics: (pr.topics || []).map((t) => ({ ...t, paperList: (t.papers || []).map(brief).filter(Boolean) })) };
  }
  // 糖糖's morning note / the desktop: what is waiting today
  function morning() {
    const open = feed.list().filter((e) => e.status === 'new');
    return { cards: feed.list().filter((e) => e.status === 'kept' && !e.readAt && e.zkey && cards.brief(e.zkey)).length, new: open.filter((e) => e.kind === 'new').length, review: open.filter((e) => e.kind === 'review').length, top: open.slice(0, 2).map((e) => String(e.paper.title).slice(0, 60)) };
  }

  // ---- web API ----
  async function handle(req, res, url, ip, json, readBody) {
    const p = url.pathname, G = req.method === 'GET', qs = (k) => String(url.searchParams.get(k) || '');
    if (G && p === '/api/lit') {
      json(res, 200, { zotero: { ...mirror.status(), canWrite: api.canWrite(), authorizing: api.authorizing(), authError }, webdav: webdav.configured(), kbDir: kb.dir,
        profile: { ...profile.state(), has: !!profile.get(), confirmed: !!(profile.get() || {}).confirmed }, feed: feed.status(), proposals: kb.proposals().length, morning: morning(),
        vision: vision.pending().length, reviews: review.drafts(), pdfq: (({ enabled, waiting, blocks, browser }) => ({ enabled, waiting, blocks: blocks.length, browser: !!browser }))(pdfq.status()) });
      return true;
    }
    if (G && p === '/api/lit/settings') { json(res, 200, { ...settings.view(), collections: mirror.collections().map((c) => c.name) }); return true; }
    if (G && p === '/api/lit/collections') { json(res, 200, { items: mirror.collections() }); return true; }
    if (G && p === '/api/lit/library') { json(res, 200, await libraryHybrid({ col: qs('col'), q: qs('q').slice(0, 200), starred: qs('starred') === '1', mode: qs('mode') })); return true; }
    // papers near this one by their abstracts' vectors (itself left out); no vector index: an empty list
    if (G && p === '/api/lit/similar') {
      const key = qs('key');
      if (!KEY.test(key) || !mirror.item(key)) { json(res, 404, { error: 'not found' }); return true; }
      if (!embed || typeof embed.similarLitItems !== 'function') { json(res, 200, { ok: true, semantic: 'off', items: [] }); return true; }
      const k = Math.max(1, Math.min(30, parseInt(qs('k'), 10) || 8));
      let near = [];
      try { near = await embed.similarLitItems(key, { topK: k }) || []; } catch (e) { log('文献：相似论文失败：' + e.message); }
      const items = near.filter((x) => x.key !== key).map((x) => { const it = mirror.item(x.key); return it ? { ...itemOut(it), score: Number((+x.score || 0).toFixed(4)) } : null; }).filter(Boolean);
      json(res, 200, { ok: true, semantic: 'ok', items });
      return true;
    }
    if (G && p === '/api/lit/item') { const d = itemDetail(qs('key')); json(res, d ? 200 : 404, d || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/pdf') {
      const f = KEY.test(qs('key')) ? fulltext.pdfBytes(qs('key')) : null;
      if (!f) { json(res, 404, { error: '这篇还没有 PDF（或还没同步到群晖）' }); return true; }
      // dl=1: saved as a file (下载), named the way Zotero names them -- "Wang 等 - 2026 - Title.pdf" -- since the stored
      // names are often the DOI or a report number, no use outside
      const dl = qs('dl') === '1';
      const name = dl ? pdfName(mirror.item(qs('key')), f.name) : f.name;
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': f.buf.length, 'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=600' });
      res.end(f.buf); audit('lit-pdf', ip, qs('key'));
      return true;
    }
    if (G && p === '/api/lit/cards') { json(res, 200, { items: cards.all() }); return true; }
    if (G && p === '/api/lit/fig') {
      const buf = figures.file(qs('p'));
      if (!buf) { json(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
      res.end(buf); return true;
    }
    if (G && p === '/api/lit/profile') { json(res, 200, { profile: profileOut(), state: profile.state(), survey: { ...survey.status(), canWrite: api.canWrite() } }); return true; }
    if (G && p === '/api/lit/feed') { wantFeed(); json(res, 200, { items: feed.list().map(feedOut), status: feed.status(), canWrite: api.canWrite() }); return true; }
    if (G && p === '/api/lit/feed/pool') { wantFeed(); json(res, 200, { items: feed.pool().map((e) => ({ ...e, tr: translate.get(e.paper.abstract) })), canWrite: api.canWrite() }); return true; }
    if (G && p === '/api/lit/read') { const k = qs('key'); json(res, KEY.test(k) ? 200 : 404, KEY.test(k) ? reader.state(k) : { error: 'not found' }); return true; }
    if (G && p === '/api/lit/kb') { const r = (() => { try { return kb.read(qs('path')); } catch { return null; } })(); json(res, r ? 200 : 404, r || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/kb/search') { json(res, 200, { items: kb.search(qs('q').slice(0, 200)) }); return true; }
    if (G && p === '/api/lit/evidence/schemas') { json(res, 200, { ok: true, schemas: listSchemas() }); return true; }
    if (G && p === '/api/lit/evidence') {
      if (!kbStruct) { json(res, 503, { ok: false, msg: '结构化知识库不可用' }); return true; }
      const schemaId = qs('schema') || DEFAULT_SCHEMA;
      const items = kbStruct.listEvidence(schemaId, { onlyVerified: qs('onlyVerified') === '1' }).map((item) => evidencePaper(item, mirror));
      json(res, 200, { ok: true, schema: getSchema(schemaId), items, stats: kbStruct.stats() });
      return true;
    }
    if (G && (p === '/api/lit/contradictions' || p === '/api/lit/matrix')) {
      if (!paradigm) { json(res, 503, { ok: false, msg: '矛盾分析模块不可用' }); return true; }
      const schemaId = qs('schema') || DEFAULT_SCHEMA;
      const result = p === '/api/lit/contradictions'
        ? { items: paradigm.listContradictions(schemaId) }
        : paradigm.buildMatrix(schemaId, { rowField: qs('row') || undefined, colField: qs('col') || undefined });
      json(res, 200, { ok: true, ...result });
      return true;
    }
    if (G && p === '/api/lit/benchmarks') {
      if (!benchmark) { json(res, 503, { ok: false, msg: '基准复算模块不可用' }); return true; }
      json(res, 200, { ok: true, items: benchmark.list({ status: qs('status') || null, zoteroKey: qs('key') || null }) });
      return true;
    }
    if (G && p === '/api/lit/stream') {
      if (!stream) { json(res, 503, { ok: false, msg: '速览流模块不可用' }); return true; }
      const r = stream.listStream({ teamId: qs('team'), tag: qs('tag'), q: qs('q').slice(0, 120), onlyCards: qs('onlyCards') === '1', limit: parseInt(qs('limit'), 10) || 80 });
      json(res, 200, { ok: true, ...r });
      return true;
    }
    if (G && p === '/api/lit/teams') {
      if (!stream) { json(res, 503, { ok: false, msg: '团队图谱模块不可用' }); return true; }
      json(res, 200, { ok: true, ...stream.teamGraph() });
      return true;
    }
    if (G && p === '/api/lit/team') {
      if (!stream) { json(res, 503, { ok: false, msg: '团队图谱模块不可用' }); return true; }
      const d = stream.teamDetail(qs('id'));
      json(res, d ? 200 : 404, d ? { ok: true, ...d } : { ok: false, msg: '找不到该团队' });
      return true;
    }
    if (G && p === '/api/lit/topics') { json(res, 200, { items: reader.topics() }); return true; }
    if (G && p === '/api/lit/topic/state') { json(res, 200, { job: reader.topicState(qs('path')) }); return true; }
    if (G && p === '/api/lit/proposals') { json(res, 200, { items: kb.proposals().map((x) => ({ ...x, title: (kb.read(x.path) || { meta: {} }).meta.title || x.path })) }); return true; }
    if (G && p === '/api/lit/proposal') { const v = kb.preview(qs('id')); json(res, v ? 200 : 404, v || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/vision') { const k = qs('key'); json(res, KEY.test(k) ? 200 : 404, KEY.test(k) ? await vision.info(k) : { error: 'not found' }); return true; }
    if (G && p === '/api/lit/vision/page') { const r = KEY.test(qs('key')) ? vision.page(qs('key'), Math.max(1, +qs('page') || 1)) : null; json(res, r ? 200 : 404, r || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/vision/pending') { json(res, 200, { items: vision.pending() }); return true; }
    if (G && p === '/api/lit/reviews') { history.seed(profile.get()); json(res, 200, { items: review.list(), job: review.state(), graph: history.graph(), has: !!(profile.get() && (profile.get().questions || []).length) }); return true; }
    if (G && p === '/api/lit/review') { const r = review.get(qs('id')); json(res, r ? 200 : 404, r || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/pdfq') { json(res, 200, pdfq.status()); return true; }
    if (G && p === '/api/lit/downloads') { json(res, 200, { items: downloads.list(), limits: downloads.limits() }); return true; }
    if (G && p === '/api/lit/stats') { json(res, 200, stats.range(Math.min(90, Math.max(1, +qs('days') || 7)))); return true; }
    if (p.startsWith('/api/lit/notes')) return notes.handle(req, res, url, json, readBody);
    if (p.startsWith('/api/lit/annots')) return annots.handle(req, res, url, json, readBody);
    if (req.method !== 'POST' || !p.startsWith('/api/lit/')) return false;

    // a PDF the user found themselves: the file is the body (upload.js)
    if (p === '/api/lit/pdf/upload') {
      const r = await upload.take(req, qs('key'), qs('name').slice(0, 200));
      if (r.ok) { audit('lit-upload', ip, qs('key')); changed('library'); changed('pdfq'); }
      json(res, 200, r); return true;
    }
    let d = {}; try { d = JSON.parse(await readBody(req, 400000)); } catch {}
    const what = p.slice('/api/lit/'.length);
    const key = String(d.key || '');
    let r;
    if (what === 'zotero/authorize') {
      authError = '';
      api.authorize().then((x) => { authError = x.ok ? '' : x.msg; changed('zotero'); if (x.ok) audit('lit-authorize', ip); });
      r = { ok: true, msg: '请到 Zotero 的网页桌面里点「始终允许」' };
    } else if (what === 'zotero/refresh') { r = await mirror.refresh(true).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message })); }
    else if (what === 'evidence/extract' || what === 'evidence/verify') {
      const schemaId = d.schemaId || DEFAULT_SCHEMA;
      if (!evidence) r = { ok: false, msg: '结构化知识库不可用' };
      else if (!KEY.test(key)) r = { ok: false, msg: 'Zotero 条目键无效' };
      else if (!getSchema(schemaId)) r = { ok: false, msg: '未知的证据表 Schema' };
      else if (what === 'evidence/extract') {
        try { r = await evidence.extractOne(key, { schemaId, force: d.force === true }); }
        catch (e) { r = { ok: false, msg: e.message }; }
      } else r = { ok: true, item: kbStruct.verifyEvidence({ zoteroKey: key, schemaId, fields: d.fields }) };
      if (r.ok) changed('evidence');
    }
    else if (what === 'contradictions/run' || what === 'contradictions/status') {
      if (!paradigm) r = { ok: false, msg: '矛盾分析模块不可用' };
      else {
        try {
          if (what === 'contradictions/run') r = await paradigm.analyzeContradictions(d.schemaId || DEFAULT_SCHEMA);
          else {
            const item = paradigm.updateContradictionStatus(d.id, d.status);
            r = item ? { ok: true, item } : { ok: false, msg: '找不到这条矛盾' };
          }
          if (r.ok) changed('contradictions');
        } catch (e) { r = { ok: false, msg: e.message }; }
      }
    }
    else if (what === 'settings') { r = settings.set(d); if (r.ok) changed('settings'); }
    else if (what === 'settings/test') {
      // is the key / the source reachable? one small request
      try {
        if (d.which === 's2') { await sources.s2.test(); r = { ok: true, msg: sources.s2.hasKey() ? 'Semantic Scholar：key 可用' : 'Semantic Scholar：没填 key，公共额度这次能用（但常常会忙）' }; }
        else { const w = await sources.openalex.search('radar cross section', '2024-01-01'); r = { ok: true, msg: `OpenAlex：可用（试查到 ${w.length} 篇）` }; }
      } catch (e) { r = { ok: false, msg: e.message }; }
    }
    else if (what === 'profile/organize') r = profile.organize();
    else if (what === 'profile/fill' || what === 'profile/draft') r = profile.fill();
    else if (what === 'profile/save') {
      r = await profile.update(d);
      // confirmed: the new papers the questions rest on go into 调研工作 (when Zotero may be written)
      if (r.ok && d.confirm && api.canWrite() && survey.waiting().length) survey.run();
    }
    else if (what === 'survey/import') r = survey.run();
    else if (what === 'review/start') r = review.start(d.kind);
    else if (what === 'review/decide') r = review.decide(String(d.id || ''), String(d.cid || ''), String(d.decision || ''), { text: d.text, children: d.children });
    else if (what === 'review/apply') r = review.apply(String(d.id || ''));
    else if (what === 'review/discard') r = review.discard(String(d.id || ''));
    else if (what === 'feed/run') { feed.run({ manual: true }).catch(() => {}); r = { ok: true }; }
    else if (what === 'feed/keep') { r = await intake.keep(String(d.id || '')); if (r.ok) audit('lit-keep', ip); }
    else if (what === 'feed/glance') r = feed.decide(String(d.id || ''), 'glanced') ? { ok: true } : { ok: false, msg: '找不到这条' };
    else if (what === 'feed/skip') r = feed.decide(String(d.id || ''), 'skipped') ? { ok: true } : { ok: false, msg: '找不到这条' };
    else if (what === 'teams/extract') {
      if (!stream) r = { ok: false, msg: '团队模块不可用' };
      else if (KEY.test(key)) { r = await stream.extractTeamsForPaper(key); if (r.ok) changed('stream'); }
      else {
        const lim = Math.max(1, Math.min(30, parseInt(d.limit, 10) || 10));
        const all = stream.listStream({ limit: 300 }).items.filter((x) => !x.teams.length).slice(0, lim);
        let ok = 0;
        for (const it of all) { const x = await stream.extractTeamsForPaper(it.key); if (x && x.ok) ok++; }
        if (ok) changed('stream');
        r = { ok: true, processed: all.length, extracted: ok };
      }
    }
    else if (what === 'feed/read') { const e = feed.get(String(d.id || '')); r = e && e.status === 'kept' ? (feed.decide(e.id, null, { readAt: d.undo ? 0 : Date.now() }), { ok: true }) : { ok: false, msg: '找不到这条' }; }
    else if (what === 'feed/promote') r = feed.promote(String(d.id || '')) ? { ok: true } : { ok: false, msg: '找不到这条' };
    else if (what === 'feed/review') {
      // the user's answers from memory go into the card's 我的笔记, dated (the recall becomes a note)
      const e = feed.get(String(d.id || ''));
      if (!e || e.kind !== 'review') r = { ok: false, msg: '找不到这条复习' };
      else {
        const answers = (Array.isArray(d.answers) ? d.answers : []).map((a) => String(a || '').trim()).slice(0, 5);
        if (answers.some(Boolean)) {
          const cur = cards.find(e.key);
          const prev = cur ? ((cur.sections.find((s) => s.title === '我的笔记') || {}).text || '') : '';
          const add = `**复习 ${ymd(Date.now())}**\n` + (e.recall || []).map((q, i) => `- ${q}\n  - ${answers[i] || '（没答）'}`).join('\n');
          cards.setOwn(e.key, '我的笔记', [prev, add].filter(Boolean).join('\n\n'));
        }
        feed.decide(e.id, 'done'); feed.markReviewed(e.key); r = { ok: true };
      }
    }
    else if (what === 'card') r = KEY.test(key) && mirror.item(key) ? (({ wait, ...x }) => x)(cards.run(key, d.kind === 'deep' ? 'deep' : 'quick')) : { ok: false, msg: '找不到这篇' };
    else if (what === 'translate') {
      // a library paper's abstract in Chinese, asked for in its page (waits for it)
      const it = KEY.test(key) ? mirror.item(key) : null;
      r = !it ? { ok: false, msg: '找不到这篇' } : !translate.foreign(it.abstract) ? { ok: false, msg: '没有可译的外文摘要' } : (await translate.one(it.abstract)) ? { ok: true } : { ok: false, msg: '没译出来，过会儿再试' };
    }
    else if (what === 'card/meta') r = cards.setMeta(key, d);
    else if (what === 'card/own') r = cards.setOwn(key, String(d.section || ''), String(d.text || '').slice(0, 20000), d.base == null ? null : String(d.base));
    else if (what === 'kb/save') { try { r = kb.write(String(d.path || ''), String(d.text || '').slice(0, 300000), d.base == null ? null : String(d.base), '手动编辑'); } catch (e) { r = { ok: false, msg: e.message }; } }
    else if (what === 'action/todo') {
      const text = String(d.text || '').trim().slice(0, 280), it = mirror.item(key);
      r = !todos ? { ok: false, msg: '重要计划没有开启' } : !text ? { ok: false, msg: '内容是空的' } : todos.add({ text: it ? `${text}（${it.citekey}）` : text, project: '文献' });
      if (r.ok) r = { ok: true };
    }
    else if (what === 'vision/start') {
      // read the paper as images: a short one whole; the pages given (the user's own choice) for any
      if (!KEY.test(key) || !mirror.item(key)) r = { ok: false, msg: '找不到这篇' };
      else if (typeof d.ranges === 'string' && d.ranges.trim()) r = await vision.approve(key, d.ranges);
      else { const vi = await vision.info(key); r = !vi.pdf ? { ok: false, msg: '没有可读的 PDF' } : vi.auto ? await vision.approve(key, '全部') : { ok: false, msg: `这篇有 ${vi.n} 页，超过整篇读图的上限（${vi.max} 页），请写上要读的页码` }; }
    }
    else if (what === 'vision/approve') r = KEY.test(key) ? await vision.approve(key, typeof d.ranges === 'string' ? d.ranges : null) : { ok: false, msg: '找不到这篇' };
    else if (what === 'vision/decline') r = vision.decline(key);
    // 图书馆通道: a paper of the library into the queue; every one without a PDF in 每日文献 and 调研工作; 继续 after the
    // user did what a site waited for
    else if (what === 'pdfq/add') { const it = KEY.test(key) ? mirror.item(key) : null; r = !it ? { ok: false, msg: '找不到这篇' } : !it.doi ? { ok: false, msg: '这篇没有 DOI' } : fulltext.hasPdf(key) ? { ok: false, msg: '已经有 PDF 了' }
      : !pdfq.status().enabled ? { ok: false, msg: '图书馆通道没有开启（控制面板 › 文献）' } : (pdfq.drop(key), pdfq.add(key, { doi: it.doi, title: it.title }, { front: true })) ? { ok: true } : { ok: false, msg: '没能排上' }; }
    else if (what === 'pdfq/fill') {
      const cols = [conf().inboxCollection, conf().surveyCollection].map((n) => mirror.collectionByName(n)).filter(Boolean).map((c) => c.key);
      r = !pdfq.status().enabled ? { ok: false, msg: '图书馆通道没有开启（控制面板 › 文献）' } : { ok: true, n: pdfq.fill(cols) };
    }
    // 下载: the DOIs in what was typed (several at once), a failed one tried again at once
    else if (what === 'download') {
      const list = typeof d.text === 'string' ? doisIn(d.text.slice(0, 20000)) : Array.isArray(d.dois) ? d.dois.map(String) : [];
      r = list.length ? downloads.submit(list, { by: 'windose', force: true }) : { ok: false, msg: '没找到 DOI（要像 10.1109/TAP.2020.1234567 这样）' };
    }
    else if (what === 'pdfq/continue') r = pdfq.resume(String(d.site || ''));
    else if (what === 'pdfq/retry') r = pdfq.retry(key);
    else if (what === 'pdfq/drop') r = pdfq.drop(key);
    else if (what === 'pdfq/test') r = await libAccess.ping();
    else if (what === 'understand') r = reader.understand(key, d.text);
    else if (what === 'chat') r = reader.chat(key, d.q, { sel: String(d.sel || '').slice(0, 4000), page: +d.page || 0 });
    else if (what === 'distill') r = reader.distill(key);
    else if (what === 'proposal/accept') r = kb.accept(String(d.id || ''), typeof d.text === 'string' ? d.text : undefined);
    else if (what === 'proposal/reject') r = kb.reject(String(d.id || ''));
    else if (what === 'topic/create') r = reader.createTopic(d.name, Array.isArray(d.keywords) ? d.keywords.map(String) : []);
    else if (what === 'topic/update') r = reader.updateTopic(String(d.path || ''));
    else if (what === 'topic/related') { try { r = { ok: true, ...(await reader.relatedWork(String(d.path || ''))) }; } catch (e) { r = { ok: false, msg: e.message }; } }
    else { json(res, 404, { ok: false }); return true; }
    if (r && r.ok && !/^(feed\/keep|zotero\/authorize)$/.test(what)) audit('lit-' + what.replace(/\//g, '-'), ip);
    json(res, 200, r || { ok: false });
    return true;
  }

  return { handle, morning, mirror, feed, cards, notes, kb, kbStruct, evidence, paradigm, benchmark, profile, intake, reader, api, vision, survey, review, history, pdfq, downloads,
    stop: () => { mirror.stop(); intake.stop(); feed.stop(); review.stop(); pdfq.stop(); absjob.stop(); downloads.stop(); if (agentSock) agentSock.stop(); if (kbStruct) kbStruct.close(); } };
}

module.exports = { createLiterature };
