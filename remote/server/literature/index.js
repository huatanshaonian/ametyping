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
//   daily 2, at "07:30", minScore 6, reviewCollection "气动隐身", inboxCollection "每日文献", writeNotes true
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
const { createCrossref, createArxiv, createAiaa, createNtrs, createUnpaywall } = require('./sources/feeds');
const { createEgress } = require('../egress');
const { createStats } = require('./stats');

const KEY = /^[A-Z0-9]{8}$/;

function createLiterature({ dataDir, cfg = {}, proxies = [], ask, todos = null, reports = () => null, mail = () => null, log = console.log, audit = () => {}, onChange = () => {} }) {
  if (!cfg || cfg.enabled === false || !ask) return null;
  const dir = path.join(dataDir, 'literature');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const E = cfg.endpoints || {};                                     // (tests point the sources at fakes)
  const px = Array.isArray(cfg.proxies) ? cfg.proxies : proxies;
  const http = createHttp({ egress: px.length ? createEgress({ proxies: px, log }) : null, viaProxy: cfg.viaProxy || ['ntrs.nasa.gov'] });
  const changed = (what) => { try { onChange(what); } catch {} };

  const api = createLocalApi({ base: cfg.zotero || 'http://127.0.0.1:23119', http, dir, log });
  const kb = createKb({ dir: path.resolve(cfg.kbDir || path.join(dir, 'kb')), log, onChange: () => changed('kb') });
  let intake = null;
  const mirror = createMirror({ api, dir, log, everyMs: cfg.refreshMs != null ? +cfg.refreshMs : 60e3, onChange: () => { changed('library'); if (intake) intake.onLibrary().catch(() => {}); } });
  const webdav = createWebdav({ dir: cfg.webdavDir || '' });
  const fulltext = createFulltext({ dir, mirror, webdav, bin: cfg.pdftotext || 'pdftotext', http, ntrsBase: E.ntrs || undefined, log });
  const sources = {
    openalex: createOpenAlex({ http, base: E.openalex, key: cfg.openalexKey || '', mailto: cfg.mailto || '' }),
    crossref: createCrossref({ http, base: E.crossref, mailto: cfg.mailto || '' }),
    arxiv: createArxiv({ http, base: E.arxiv }), aiaa: createAiaa({ http, base: E.aiaa }), ntrs: createNtrs({ http, base: E.ntrs }),
  };
  for (const k of Object.keys(sources)) if (E[k] === false) delete sources[k];
  const unpaywall = createUnpaywall({ http, base: E.unpaywall, mailto: cfg.mailto || '' });
  const profile = createProfile({ dir, mirror, ask, openalex: sources.openalex, reports, log });
  const cards = createCards({ kb, mirror, fulltext, profile, ask, api, writeNotes: cfg.writeNotes !== false, log, onChange: (k) => changed('card:' + k) });
  const feed = createFeed({ dir, cfg, mirror, profile, sources, ask, cards, mail, log, onChange: () => changed('feed') });
  intake = createIntake({ cfg, api, mirror, fulltext, cards, feed, http, unpaywall, log, onChange: () => changed('feed') });
  const reader = createReader({ dir, kb, mirror, fulltext, cards, profile, ask, log, onChange: (k) => changed('read:' + k) });
  const stats = createStats({ kb, feed, todos });

  mirror.start();
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
  function itemDetail(key) {
    const it = mirror.item(key); if (!it) return null;
    const card = cards.find(key);
    const entry = feed.entries().find((e) => e.zkey === key || e.key === key) || null;
    return { ...itemOut(it), abstract: it.abstract, url: it.url, tags: it.tags, number: it.number,
      annotations: mirror.annotationsOf(key).map((a) => ({ type: a.type, text: a.text, comment: a.comment, page: a.page, color: a.color })),
      card: card ? { path: card.path, text: card.text, hash: card.hash, meta: card.meta } : null, job: cards.state(key), actions: cards.actions(key), entry,
      collectionNames: it.collections.map((c) => (mirror.collections().find((x) => x.key === c) || {}).name).filter(Boolean) };
  }
  // 糖糖's morning note / the desktop: what is waiting today
  function morning() {
    const open = feed.list().filter((e) => e.status === 'new');
    return { new: open.filter((e) => e.kind === 'new').length, review: open.filter((e) => e.kind === 'review').length, top: open.slice(0, 2).map((e) => String(e.paper.title).slice(0, 60)) };
  }

  // ---- web API ----
  async function handle(req, res, url, ip, json, readBody) {
    const p = url.pathname, G = req.method === 'GET', qs = (k) => String(url.searchParams.get(k) || '');
    if (G && p === '/api/lit') {
      json(res, 200, { zotero: { ...mirror.status(), canWrite: api.canWrite(), authorizing: api.authorizing(), authError }, webdav: webdav.configured(), kbDir: kb.dir,
        profile: { ...profile.state(), has: !!profile.get(), confirmed: !!(profile.get() || {}).confirmed }, feed: feed.status(), proposals: kb.proposals().length, morning: morning() });
      return true;
    }
    if (G && p === '/api/lit/collections') { json(res, 200, { items: mirror.collections() }); return true; }
    if (G && p === '/api/lit/library') { json(res, 200, { items: library({ col: qs('col'), q: qs('q').slice(0, 200), starred: qs('starred') === '1' }) }); return true; }
    if (G && p === '/api/lit/item') { const d = itemDetail(qs('key')); json(res, d ? 200 : 404, d || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/pdf') {
      const f = KEY.test(qs('key')) ? fulltext.pdfBytes(qs('key')) : null;
      if (!f) { json(res, 404, { error: '这篇还没有 PDF（或还没同步到群晖）' }); return true; }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': f.buf.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=600' });
      res.end(f.buf); audit('lit-pdf', ip, qs('key'));
      return true;
    }
    if (G && p === '/api/lit/profile') { json(res, 200, { profile: profile.get(), state: profile.state() }); return true; }
    if (G && p === '/api/lit/feed') { json(res, 200, { items: feed.list(), status: feed.status(), canWrite: api.canWrite() }); return true; }
    if (G && p === '/api/lit/read') { const k = qs('key'); json(res, KEY.test(k) ? 200 : 404, KEY.test(k) ? reader.state(k) : { error: 'not found' }); return true; }
    if (G && p === '/api/lit/kb') { const r = (() => { try { return kb.read(qs('path')); } catch { return null; } })(); json(res, r ? 200 : 404, r || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/kb/search') { json(res, 200, { items: kb.search(qs('q').slice(0, 200)) }); return true; }
    if (G && p === '/api/lit/topics') { json(res, 200, { items: reader.topics() }); return true; }
    if (G && p === '/api/lit/topic/state') { json(res, 200, { job: reader.topicState(qs('path')) }); return true; }
    if (G && p === '/api/lit/proposals') { json(res, 200, { items: kb.proposals().map((x) => ({ ...x, title: (kb.read(x.path) || { meta: {} }).meta.title || x.path })) }); return true; }
    if (G && p === '/api/lit/proposal') { const v = kb.preview(qs('id')); json(res, v ? 200 : 404, v || { error: 'not found' }); return true; }
    if (G && p === '/api/lit/stats') { json(res, 200, stats.range(Math.min(90, Math.max(1, +qs('days') || 7)))); return true; }
    if (req.method !== 'POST' || !p.startsWith('/api/lit/')) return false;

    let d = {}; try { d = JSON.parse(await readBody(req, 400000)); } catch {}
    const what = p.slice('/api/lit/'.length);
    const key = String(d.key || '');
    let r;
    if (what === 'zotero/authorize') {
      authError = '';
      api.authorize().then((x) => { authError = x.ok ? '' : x.msg; changed('zotero'); if (x.ok) audit('lit-authorize', ip); });
      r = { ok: true, msg: '请到 Zotero 的网页桌面里点「始终允许」' };
    } else if (what === 'zotero/refresh') { r = await mirror.refresh(true).then(() => ({ ok: true }), (e) => ({ ok: false, msg: e.message })); }
    else if (what === 'profile/draft') r = profile.draft();
    else if (what === 'profile/save') r = await profile.update(d);
    else if (what === 'feed/run') { feed.run({ manual: true }).catch(() => {}); r = { ok: true }; }
    else if (what === 'feed/keep') { r = await intake.keep(String(d.id || '')); if (r.ok) audit('lit-keep', ip); }
    else if (what === 'feed/skip') r = feed.decide(String(d.id || ''), 'skipped') ? { ok: true } : { ok: false, msg: '找不到这条' };
    else if (what === 'feed/promote') r = feed.decide(String(d.id || ''), null, { status: 'new' }) ? { ok: true } : { ok: false, msg: '找不到这条' };
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
    else if (what === 'card/meta') r = cards.setMeta(key, d);
    else if (what === 'card/own') r = cards.setOwn(key, String(d.section || ''), String(d.text || '').slice(0, 20000), d.base == null ? null : String(d.base));
    else if (what === 'kb/save') { try { r = kb.write(String(d.path || ''), String(d.text || '').slice(0, 300000), d.base == null ? null : String(d.base), '手动编辑'); } catch (e) { r = { ok: false, msg: e.message }; } }
    else if (what === 'action/todo') {
      const text = String(d.text || '').trim().slice(0, 280), it = mirror.item(key);
      r = !todos ? { ok: false, msg: '重要计划没有开启' } : !text ? { ok: false, msg: '内容是空的' } : todos.add({ text: it ? `${text}（${it.citekey}）` : text, project: '文献' });
      if (r.ok) r = { ok: true };
    }
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

  return { handle, morning, mirror, feed, cards, kb, profile, intake, reader, api, stop: () => { mirror.stop(); feed.stop(); } };
}

module.exports = { createLiterature };
