// 每日文献: each workday morning (literature config "at", default 07:30) at most `daily` papers (default 2) -- a cap, not
// a quota. New papers come from the follow lists of the profile (the followed journals' tables of contents,
// authors, papers citing the key papers, search words, arXiv categories) and from the papers the mail triage picked out
// of journal and ResearchGate mails; anything already in the library or shown before is dropped, the rest is prefiltered
// by the profile's words and scored by the model against the user's questions (prompts/feed.js) -- `rankPerDay` (30)
// of them a day; the others wait their turn (feed-inbox.json), so nothing found is lost and nothing is fetched twice
// for nothing. The search is not only for what is new: besides what came out since the last run (journals, feeds,
// arXiv, and each search / author / citing query), the searches, the followed authors and the papers citing the key
// ones are also asked without a date, a page further each time ("cursors"), while the waiting list has room. A search
// phrase is used every few days: its "since" is the day it was last asked ("asked"), not the day of the last run.
// The followed journals are read like their tables of contents: every article newly registered at Crossref (and in
// AIAA's own feed of the current issue) is taken once, the day it first shows ("toc"), and scored by the model whatever
// its words -- TOC_PER_DAY a day, beside the `rankPerDay` of the searches. The three Chinese journals no index lists
// are read from their own websites (sources/cnjournals.js). An article of the contents that has no abstract (IEEE,
// Elsevier, the Chinese ones) waits up to HOLD_MS for it to be read off its page (absjob.js), while that is on
// (`holdAbstracts`); after that it is scored by its title. Fewer than `daily`
// worth it: the rest is filled with reviews from the user's own collection (config "reviewCollection", 气动隐身) --
// annotated papers as active recall, unread ones as catch-up. Old reports (NTRS, DTIC) come on their own, `oldDaily` a
// day (default 1, not counted in `daily`), from a queue filled a page at a time (archive.js); Saturdays: old reports only.
// The good ones a day has no room for are never thrown away: they wait (status "spare", the 候选 tab) and compete with
// the next days' finds by score -- a day that finds little shows what earlier days left. One of the day's places goes
// to the best of the ones found lately (FRESH_DAYS), so that what waits does not keep the new out.
// Nothing is decided for the user: a pick waits for 收下 (into Zotero, intake.js) or 跳过; one left alone for 7 days
// goes back among the candidates ("lapsed": there to be found, not pushed a second time).
//   <dataDir>/literature/feed.json  { items: { id: entry }, seen: { fingerprint: t }, reviewed: { key: t }, runs: [...],
//                                     cursors: { query: next page }, asked: { phrase: 'YYYY-MM-DD' }, toc: { fingerprint: t },
//                                     tocAt: { issn: 'YYYY-MM-DD' (the journal last read) },
//                                     s2: (s2job.js) }
//   <dataDir>/literature/feed-inbox.json  { fingerprint: candidate }   found, not scored yet
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RANK_SCHEMA, REVIEW_SCHEMA, rankPrompt, reviewPrompt } = require('./prompts/feed');
const { fingerprint, paper, clean } = require('./sources/normalize');
const { createArchive } = require('./archive');
const { createS2Job } = require('./s2job');

const DAY_MS = 86400e3;
const FRESH_DAYS = 90;                                         // "published lately": one place a day is for these
const INBOX_MAX = 400;                                         // candidates waiting to be scored (the most promising)
const PER_CALL = 30;                                           // papers scored in one call of the model
const LAST_PAGE = 40;
const TOC_PER_DAY = 90;                                        // articles of the journals' contents scored a day
const HOLD_MS = 36 * 3600e3;                                   // how long an article waits for its abstract
const TOC_FIRST_DAYS = 14;                                     // how far back a journal is read the first time
// (words of a search phrase that say nothing about its subject)
const STOP = new Set('with from that this based using method methods model models modeling analysis study approach design high order problem problems'.split(' '));                                          // how deep a query without a date is followed
// n items of a list, a different stretch each day (day: days since the epoch), so every item comes round
function rotate(list, n, day) {
  if (list.length <= n) return list.slice();
  const at = (day * n) % list.length;
  return [...list.slice(at), ...list.slice(0, at)].slice(0, n);
}
const unquote = (s) => String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const ymd =(t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// likes(): { pos: [DOIs], neg: [DOIs] } beyond the push's own kept / skipped (the starred cards, the key papers)
function createFeed({ dir, cfg = {}, mirror, profile, sources, ask, cards, mail = () => null, likes = () => ({ pos: [], neg: [] }), log = () => {}, onChange = () => {}, now = () => Date.now(), gapMs = 1500, holdAbstracts = () => false }) {
  const file = path.join(dir, 'feed.json');
  let st = { items: {}, seen: {}, reviewed: {}, runs: [], cursors: {}, asked: {}, toc: {}, tocAt: {}, s2: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const inboxFile = path.join(dir, 'feed-inbox.json');
  let inbox = {};
  try { inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')) || {}; } catch {}
  const saveInbox = () => { fs.writeFileSync(inboxFile + '.tmp', JSON.stringify(inbox)); fs.renameSync(inboxFile + '.tmp', inboxFile); };
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
  // (cfg: an object, or a function giving the settings in effect now -- 控制面板 › 文献 changes them while running)
  const C = () => (typeof cfg === 'function' ? cfg() : cfg) || {};
  const daily = () => Math.max(0, Math.min(5, C().daily != null ? +C().daily : 2));
  const minScore = () => (C().minScore != null ? +C().minScore : 6);
  const rankN = () => Math.max(10, Math.min(120, +C().rankPerDay || 30));
  const atTime = () => String(C().at || '07:30').split(':').map(Number);
  let running = null, lastError = '', lastErrorAt = 0;
  const oldDaily = () => Math.max(0, Math.min(3, C().oldDaily != null ? +C().oldDaily : 1));

  const entries = () => Object.values(st.items);
  const pushedOn = (date) => entries().filter((e) => e.date === date && e.status !== 'spare');

  // a query without a date, a page further than the last time it was asked (back to the first after the last)
  const turn = async (id, per, fn) => { const p = st.cursors[id] || 1; const r = (await fn(p)) || []; st.cursors[id] = r.length < per || p >= LAST_PAGE ? 1 : p + 1; return r; };

  // ---- gathering ----
  // Each source's count goes into the run's log (which way brings the papers worth reading shows after a few days).
  // The search phrases are used a few a day in turn (all of them come round), without quotes -- a quoted phrase is an
  // exact-phrase search on OpenAlex, too narrow for finding; the model's scoring does the narrowing. arXiv's categories
  // are broad: only papers with one of the profile's phrases in their title or abstract.
  // deep: also without a date -- each such query a page further than the last time (back to the first after the last)
  async function gather(since, deep = false) {
    const prof = profile.get() || {}, f = prof.follow || {};
    const out = [], errors = [], counts = {};
    const tryIt = async (name, fn) => {
      try { const r = (await fn()) || []; for (const c of r) c.via = name; out.push(...r); counts[name] = (counts[name] || 0) + r.length; }
      catch (e) { errors.push(`${name}：${e.message}`); counts[name] = counts[name] || 0; }
    };
    // a table of contents: gathered apart (the same article from Crossref and from AIAA's feed is one), then only the
    // articles not taken before go on -- marked "toc": all of them are scored
    const tocs = [];
    const tryToc = async (name, fn) => {
      try { const r = (await fn()) || []; for (const c of r) c.via = name; tocs.push(...r.filter((c) => c.title)); counts[name] = counts[name] || 0; return true; }
      catch (e) { errors.push(`${name}：${e.message}`); counts[name] = counts[name] || 0; return false; }
    };
    const day = Math.floor(now() / DAY_MS);
    const words = (f.keywords || []).map(unquote).filter(Boolean);
    // a phrase's own "since": two days before it was last asked (the first time: a month back)
    const sinceOf = (k) => { const d = st.asked[k] ? ymd(Math.min(now() - 3 * DAY_MS, Date.parse(st.asked[k]) - 2 * DAY_MS)) : ymd(now() - 30 * DAY_MS); return d < since ? d : since; };
    const S = sources;
    if (S.openalex) {
      const authors = (f.authors || []).map((a) => a.openalex).filter(Boolean), seeds = (f.seeds || []).map((s) => s.openalex).filter(Boolean);
      await tryIt('作者', () => S.openalex.byAuthors(authors, since));
      await tryIt('引用核心文献', () => S.openalex.citing(seeds, since));
      for (const k of rotate(words, C().searchesPerDay || 4, day)) await tryIt('检索式', async () => { const r = await S.openalex.search(k, sinceOf(k)); st.asked[k] = ymd(now()); return r; });
      if (deep) {
        if (authors.length) await tryIt('作者（往年）', () => turn('oa:authors:' + authors.join(), 40, (p) => S.openalex.byAuthors(authors, null, p)));
        if (seeds.length) await tryIt('引用核心文献（往年）', () => turn('oa:citing:' + seeds.join(), 40, (p) => S.openalex.citing(seeds, null, p)));
        for (const k of rotate(words, C().searchesPerDay || 4, day)) await tryIt('检索式（不限年份）', () => turn('oa:search:' + k, 25, (p) => S.openalex.search(k, null, p)));
      }
    }
    // (Semantic Scholar: on its own clock -- s2Tasks below)
    // the followed journals, each read from where it was last read (two days of overlap; the first time: two weeks)
    if (S.crossref) for (const v of (f.venues || []).filter((x) => (x.issns || []).length)) {
      const id = v.issns[0], from = ymd(st.tocAt[id] ? Date.parse(st.tocAt[id]) - 2 * DAY_MS : now() - TOC_FIRST_DAYS * DAY_MS);
      if (await tryToc('期刊目录', () => S.crossref.created(v.issns, from))) st.tocAt[id] = ymd(now());
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));           // (Crossref answers nothing when asked in a burst)
    }
    if (S.aiaa) for (const c of [...new Set((f.venues || []).map((v) => v.aiaa).filter(Boolean))]) await tryToc('AIAA 目录', () => S.aiaa.toc(c));
    if (S.cn) for (const j of [...new Set((f.venues || []).map((v) => S.cn.of(v)).filter(Boolean))]) await tryToc('中文期刊目录', () => S.cn.toc(j));
    const fresh = new Map();
    for (const c of tocs) { const fp = fingerprint(c); if (st.toc[fp]) continue; fresh.set(fp, [...(fresh.get(fp) || []), c]); }
    for (const [fp, same] of fresh) { st.toc[fp] = now(); for (const c of same) { c.toc = true; c.found = now(); out.push(c); counts[c.via]++; } }
    if (S.arxiv && (f.arxiv || []).length) {
      const phrases = [...new Set([...(prof.topics || []).flatMap((t) => t.keywords || []), ...(f.keywords || [])].map(unquote).filter((w) => w.length > 2))];
      if (phrases.length) await tryIt('arXiv', () => S.arxiv.recent(f.arxiv, rotate(phrases, 15, day), 60));
    }
    // the papers the mail triage picked (titles and links only): looked up on OpenAlex by title
    const M = mail();
    if (M && M.triage) {
      const picks = M.triage.alerts().filter((a) => a.kind === 'reading' && now() - (a.at || 0) < 7 * DAY_MS).flatMap((a) => a.picks || []).slice(0, 8);
      for (const p of picks) out.push({ ...paper({ source: 'mail', sid: fingerprint(p), title: p.title, url: p.url, abstract: '', venue: '邮件推荐' }), via: '邮件推荐' });
      counts['邮件推荐'] = picks.length;
    }
    return { cands: out, errors, counts };
  }
  // Semantic Scholar's day: two of the phrases (of any year, a page further each time), and papers like the ones kept /
  // starred, unlike the skipped. Tried at the push and every few hours until each answered (s2job.js); what they bring
  // waits in the inbox for the next scoring.
  function s2Tasks() {
    const f = (profile.get() || {}).follow || {}, day = Math.floor(now() / DAY_MS);
    const t = rotate((f.keywords || []).map(unquote).filter(Boolean), 2, day + 1).map((k) => ({ id: 's:' + k, name: 'S2 检索', run: () => turn('s2:search:' + k, 10, (p) => sources.s2.search(k, 0, 10, (p - 1) * 10)) }));
    if (C().s2Recommend !== false) { const L = taste(); if (L.pos.length) t.push({ id: 'rec', name: '相似推荐', run: () => sources.s2.recommend(L.pos, L.neg, 30) }); }
    return t;
  }
  const s2job = createS2Job({ s2: sources.s2, state: () => st.s2, save: () => save(), tasks: s2Tasks, log, now, gapMs: (C().s2RetryHours || 3) * 3600e3,
    add: (name, list) => { for (const c of list) c.via = name; inbox = Object.fromEntries(dedupe([...Object.values(inbox), ...list]).map((c) => [fingerprint(c), c])); saveInbox(); } });
  // what the user liked and did not: kept / skipped picks (the last 4 months) and likes() (starred cards, key papers)
  function taste() {
    const recent = entries().filter((e) => e.kind === 'new' && e.paper && e.paper.doi && now() - (e.decidedAt || 0) < 120 * DAY_MS);
    const x = likes() || {};
    const pos = [...new Set([...recent.filter((e) => e.status === 'kept').map((e) => e.paper.doi), ...(x.pos || [])])].slice(0, 50);
    const neg = [...new Set([...recent.filter((e) => e.status === 'skipped').map((e) => e.paper.doi), ...(x.neg || [])])].filter((d) => !pos.includes(d)).slice(0, 50);
    return { pos, neg };
  }
  // drop what is in the library or was shown before; merge the same paper from several sources (a candidate that
  // waited comes with the sources and ways it had)
  function dedupe(cands) {
    const byId = new Map(), byFp = new Map();
    for (const c of cands) {
      if (!c.title) continue;
      const fp = fingerprint(c);
      if (st.seen[fp] || (c.doi && mirror.findDoi(c.doi)) || mirror.findTitle(c.title)) continue;
      const prev = byId.get(c.id) || byFp.get(fp);
      if (prev) { for (const k of ['abstract', 'pdf', 'doi', 'venue', 'date', 'toc', 'found', 'absTried']) if (!prev[k] && c[k]) prev[k] = c[k]; prev.sources = [...new Set([...(prev.sources || [prev.source]), ...(c.sources || [c.source])])];
        prev.vias = [...new Set([...(prev.vias || []), ...(c.vias || []), c.via].filter(Boolean))]; continue; }
      const { via, ...rest } = c;
      const x = { ...rest, sources: c.sources || [c.source], vias: c.vias || (via ? [via] : []) };
      byId.set(c.id, x); byFp.set(fp, x);
    }
    return [...byId.values()];
  }
  // fill in missing abstracts (AIAA feeds, Crossref without one, mail picks) from OpenAlex
  async function enrich(list, max = 15) {
    if (!sources.openalex) return;
    let n = 0;
    for (const c of list) {
      if (c.abstract || n >= max) continue;
      n++;
      try {
        const w = c.doi ? await sources.openalex.byDoi(c.doi) : (await sources.openalex.search(c.title, '1900-01-01'))[0];
        if (w && (c.doi || fingerprint(w) === fingerprint(c))) { for (const k of ['abstract', 'pdf', 'doi', 'venue', 'date', 'year']) if (!c[k] && w[k]) c[k] = w[k]; if (!c.authors.length) c.authors = w.authors; }
      } catch {}
    }
  }
  // The most promising first (the first `rankPerDay` go to the model): by the profile's phrases in the title and
  // abstract -- a whole phrase counts most, and each of its words counts too, the more the fewer candidates have it
  // ("waverider" tells more than "model"). Whole phrases alone hardly ever match a title word for word.
  function prefilter(list, n = list.length) {
    const phrases = profile.words().map((w) => w.toLowerCase()).filter(Boolean);
    const terms = [...new Set(phrases.flatMap((p) => p.split(/[^a-z0-9\u4e00-\u9fff]+/)).filter((w) => (/[\u4e00-\u9fff]/.test(w) ? w.length >= 2 : w.length >= 4) && !STOP.has(w)))];
    const texts = new Map(list.map((c) => [c, (c.title + ' ' + (c.abstract || '')).toLowerCase()]));
    const has = (t, w) => (/[\u4e00-\u9fff]/.test(w) ? t.includes(w) : new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t));
    const weight = new Map(terms.map((w) => { let df = 0; for (const t of texts.values()) if (has(t, w)) df++; return [w, df ? Math.log(1 + list.length / df) : 0]; }));
    const score = (c) => { const t = texts.get(c); return phrases.reduce((s, p) => s + (t.includes(p) ? 3 : 0), 0) + terms.reduce((s, w) => s + (weight.get(w) && has(t, w) ? weight.get(w) : 0), 0) + (c.abstract ? 0.5 : 0) + ((c.sources || []).length - 1); };
    return list.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.c);
  }
  function feedback() {
    const done = entries().filter((e) => e.kind === 'new' && e.decidedAt).sort((a, b) => b.decidedAt - a.decidedAt);
    return { kept: done.filter((e) => e.status === 'kept').slice(0, 10).map((e) => e.paper.title), skipped: done.filter((e) => e.status === 'skipped').slice(0, 10).map((e) => e.paper.title) };
  }
  // the question's own text kept with a pick (its number changes when questions are reordered, solved or removed)
  const qText = (n) => { const q = n > 0 ? profile.openQuestions()[n - 1] : null; return q ? q.text : ''; };
  async function rank(all) {
    const out = [];
    for (let i = 0; i < all.length; i += PER_CALL) out.push(...await rankSome(all.slice(i, i + PER_CALL)));
    return out.sort((a, b) => b.score - a.score);
  }
  async function rankSome(list) {
    if (!list.length) return [];
    const refs = list.map((c, i) => ({ ref: 'C' + (i + 1), c }));
    const a = await ask(rankPrompt(profile.get() || {}, refs.map(({ ref, c }) => ({ ref, title: c.title, venue: c.venue, year: c.year, abstract: c.abstract, source: c.source })), feedback()), RANK_SCHEMA);
    const by = new Map((a.items || []).map((x) => [String(x.ref).replace(/[^\dC]/gi, '').toUpperCase(), x]));
    return refs.map(({ ref, c }) => { const x = by.get(ref) || {}; return { c, score: +x.score || 0, question: +x.question || 0, why: String(x.why || '').slice(0, 200), fun: !!x.fun }; })
      .sort((a, b) => b.score - a.score);
  }

  // ---- reviews from the user's own collection ----
  // (and the papers of 调研工作 -- the ones the questions rest on -- that have no card yet: those first)
  function reviewPool() {
    const col = mirror.collectionByName(C().reviewCollection || '气动隐身'), sv = mirror.collectionByName(C().surveyCollection || '调研工作');
    if (!col && !sv) return [];
    const survey = new Set(sv ? mirror.inCollection(sv.key).filter((it) => { const c = cards.find(it.key); return !c || c.meta.status === 'none'; }).map((it) => it.key) : []);
    const pool = new Map([...(col ? mirror.inCollection(col.key) : []), ...(sv ? mirror.inCollection(sv.key).filter((it) => survey.has(it.key)) : [])].map((it) => [it.key, it]));
    const pending = new Set(entries().filter((e) => e.kind === 'review' && e.status === 'new').map((e) => e.key));
    const words = profile.words().map((w) => w.toLowerCase());
    return [...pool.values()].filter((it) => !pending.has(it.key) && now() - (st.reviewed[it.key] || 0) > 90 * DAY_MS).map((it) => {
      const notes = mirror.annotationCount(it.key);
      const t = (it.title + ' ' + it.abstract).toLowerCase();
      const rel = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
      // (a little day-to-day variety: a stable hash of the key and the date)
      const jitter = parseInt(crypto.createHash('md5').update(it.key + ymd(now())).digest('hex').slice(0, 4), 16) / 65536;
      return { it, notes, survey: survey.has(it.key), s: (survey.has(it.key) ? 4 : 0) + (notes ? 2 : 0) + Math.min(rel, 4) * 0.5 + jitter * 1.5 };
    }).sort((a, b) => b.s - a.s);
  }
  async function reviewEntry(it, survey = false) {
    const card = cards.find(it.key);
    const notes = cards.annotationLines(it.key);
    let r = { why: '', recall: [] };
    try { r = await ask(reviewPrompt(profile.get() || {}, it, notes, card ? card.body : ''), REVIEW_SCHEMA); } catch (e) { log('文献：复习题生成失败：' + e.message); }
    return { kind: 'review', mode: notes.length ? 'recall' : 'catchup', key: it.key, paper: { title: it.title, authors: it.creators, venue: it.venue, year: it.year, abstract: it.abstract, doi: it.doi },
      survey: survey || undefined, why: r.why || (survey ? '梳理问题时调研到的文献，还没读过' : notes.length ? '你批注过这篇，很久没回顾了' : '收藏了还没读过'), recall: (r.recall || []).slice(0, 3), notes: notes.length };
  }

  // ---- the daily run ----
  function add(e) {
    const id = crypto.randomBytes(5).toString('hex');
    st.items[id] = { id, status: 'new', created: now(), ...e };
    return st.items[id];
  }
  // the old reports' queue (NTRS / DTIC), scored the same way and remembering the same "shown before"
  const archive = createArchive({ dir, sources, profile, mirror, rank: (l) => rank(l), seen: (fp) => !!st.seen[fp], see: (fp) => { st.seen[fp] = now(); }, minScore, log, now });
  async function oldReports(date, n, log1) {
    if (n <= 0 || !((profile.get() || {}).follow || {}).ntrs || !(profile.get().follow.ntrs || []).length) return;
    for (const x of await archive.take(n, log1)) {
      add({ kind: 'new', date, paper: x.paper, score: x.score, question: x.question, qText: qText(x.question), why: x.why, fun: x.fun, old: true });
      log1.old = (log1.old || 0) + 1;
    }
  }
  async function run({ date = ymd(now()), manual = false } = {}) {
    if (running) return running;
    running = (async () => {
      const already = pushedOn(date).filter((e) => !e.old).length, oldAlready = pushedOn(date).filter((e) => e.old).length;
      const want = Math.max(0, daily() - already);
      const dow = new Date(now()).getDay();
      const log1 = { date, at: now(), manual, found: 0, ranked: 0, picked: 0, reviews: 0, errors: [] };
      if (!profile.get()) throw new Error('还没有兴趣画像：先在「画像」里生成并确认');
      if (dow === 6 && !manual) {                            // Saturday: old reports only
        await oldReports(date, Math.max(1, oldDaily()) - oldAlready, log1);
      } else {
       if (want > 0) {
        const last = st.runs.filter((r) => !r.error).map((r) => r.date).sort().pop();
        const since = ymd(Math.min(now() - 3 * DAY_MS, last ? Date.parse(last) - 2 * DAY_MS : now() - 14 * DAY_MS));
        // (the ones found before and not scored yet come first into the count: a full waiting list is not dug deeper)
        const deep = Object.values(inbox).filter((c) => !c.toc).length < 2 * rankN();
        await s2job.tick(date, true);                          // (into the inbox; busy: tried again in a few hours)
        const { cands, errors, counts } = await gather(since, deep);
        const viaS2 = s2job.take();
        for (const [k, n] of Object.entries(viaS2)) counts[k] = (counts[k] || 0) + n;
        if (s2job.pending()) errors.push(`Semantic Scholar：${s2job.pending()}（过几个小时自动再试，查到的留给下次打分）`);
        log1.errors = errors; log1.found = cands.length + Object.values(viaS2).reduce((a, b) => a + b, 0); log1.sources = counts;
        const all = dedupe([...Object.values(inbox), ...cands]);
        // the journals' contents: every article is scored (the oldest waiting first), whatever its words; the searches'
        // finds: the most promising `rankPerDay`
        const toc = all.filter((c) => c.toc);
        await enrich(toc.filter((c) => !c.asked), TOC_PER_DAY);
        for (const c of toc) c.asked = true;                     // (OpenAlex is asked for an abstract once)
        // (an article without an abstract waits for it to be read off its page, a day and a half at most)
        const ready = (c) => !!c.abstract || !!c.absTried || !holdAbstracts() || now() - (c.found || 0) > HOLD_MS;
        const tocNow = toc.filter(ready).slice(0, TOC_PER_DAY), tocWait = toc.filter((c) => !tocNow.includes(c));
        const rest = all.filter((c) => !c.toc);
        await enrich(rest);
        const list = prefilter(rest), wait = [...tocWait, ...list.slice(rankN(), rankN() + INBOX_MAX)];
        const keep = (cs) => { inbox = Object.fromEntries(cs.map((c) => [fingerprint(c), c])); saveInbox(); };
        // (all of them wait first: when the scoring fails, what was found -- a table of contents is not taken twice --
        // is still there the next time)
        keep([...tocNow, ...list.slice(0, rankN()), ...wait]);
        const ranked = await rank([...tocNow, ...list.slice(0, rankN())]);
        log1.ranked = ranked.length; log1.toc = tocNow.length;
        for (const r of ranked) st.seen[fingerprint(r.c)] = now();
        keep(wait);
        log1.unscored = wait.length;
        const good = ranked.filter((r) => r.score >= minScore());
        // per way of finding: how many of the good ones it brought (a paper found two ways counts for both)
        log1.good = {}; for (const r of good) for (const v of r.c.vias || []) log1.good[v] = (log1.good[v] || 0) + 1;
        // today's good ones join the ones earlier days left; the best of them all are the day's picks, the rest waits
        const fresh = new Set(good.map((r) => add({ kind: 'new', date, paper: r.c, score: r.score, question: r.question, qText: qText(r.question), why: r.why, fun: r.fun, status: 'spare' }).id));
        const pool = entries().filter((e) => e.kind === 'new' && !e.old && !e.lapsed && e.status === 'spare').sort((a, b) => b.score - a.score || b.created - a.created);
        const picks = [], lately = pool.find((e) => { const t = Date.parse(e.paper.date || ''); return t && now() - t < FRESH_DAYS * DAY_MS; });
        if (lately && !pushedOn(date).some((e) => e.fresh)) { lately.fresh = true; picks.push(lately); }
        for (const e of pool) if (picks.length < want && !picks.includes(e)) picks.push(e);
        for (const e of picks.slice(0, want)) {
          if (!fresh.has(e.id)) { e.found = e.found || e.date; log1.held = (log1.held || 0) + 1; }
          Object.assign(e, { status: 'new', date, created: now() }); log1.picked++;
        }
        log1.waiting = Math.max(0, pool.length - want);
        let room = want - log1.picked;
        for (const x of reviewPool().slice(0, room)) { add({ date, ...(await reviewEntry(x.it, x.survey)) }); st.reviewed[x.it.key] = now(); log1.reviews++; room--; }
       }
        await oldReports(date, oldDaily() - oldAlready, log1);
      }
      st.runs = [...st.runs, log1].slice(-60);
      prune(); save(); onChange('feed');
      log(`文献：今日推送 ${log1.picked} 篇新文献、${log1.old || 0} 篇老报告、${log1.reviews} 篇复习（候选 ${log1.found}，评分 ${log1.ranked}）${log1.errors.length ? '；来源出错：' + log1.errors.join('；') : ''}`);
      return log1;
    })().catch((e) => { lastError = e.message; lastErrorAt = now(); st.runs = [...st.runs, { date, at: now(), manual, error: e.message }].slice(-60); save(); onChange('feed'); log('文献：推送失败：' + e.message); throw e; })
      .finally(() => { running = null; });
    return running;
  }
  // seen fingerprints older than half a year are forgotten; a paper shown and not decided in 7 days goes back among
  // the candidates (a review lapses: it comes round again by itself); what the user skipped goes after two months
  function prune() {
    const t = now();
    for (const [fp, at] of Object.entries(st.seen)) if (t - at > 180 * DAY_MS) delete st.seen[fp];
    for (const [fp, at] of Object.entries(st.toc)) if (t - at > 400 * DAY_MS) delete st.toc[fp];
    for (const e of entries()) {
      const paper = e.kind === 'new' && !e.zkey;
      if (e.status === 'new' && t - e.created > 7 * DAY_MS) Object.assign(e, paper ? { status: 'spare', lapsed: true } : { status: 'expired' });
      if (e.status === 'expired' && paper) Object.assign(e, { status: 'spare', lapsed: true });     // (lapsed under the old rule)
      if (['expired', 'skipped'].includes(e.status) && t - e.created > 60 * DAY_MS) delete st.items[e.id];
    }
  }

  // ---- abstracts read off the articles' pages (absjob.js) ----
  // a candidate waiting without an abstract that was not tried yet: the journals' contents first; skip(c): not this one
  function wantAbstract(skip = () => false) {
    const xs = Object.values(inbox).filter((c) => !c.abstract && !c.absTried && (c.doi || c.url) && !skip(c));
    return xs.find((c) => c.toc) || xs[0] || null;
  }
  // what its page gave ('' = none): either way it is not asked again
  function gotAbstract(c0, abs) {
    const c = inbox[fingerprint(c0)]; if (!c) return;
    if (abs) c.abstract = clean(abs);
    c.absTried = now(); saveInbox();
  }

  // ---- the user's choices ----
  function get(id) { return st.items[id] || null; }
  function decide(id, status, patch = {}) {
    const e = st.items[id]; if (!e) return null;
    Object.assign(e, patch, status ? { status, decidedAt: now() } : {});
    save(); onChange('feed');
    return e;
  }
  // what 今日 shows: the picks still open first, then the latest of the rest; pool(): every candidate waiting, best first
  function list() {
    const t = now();
    return entries().filter((e) => e.status !== 'spare' && (e.status !== 'expired' || t - e.created < 3 * DAY_MS)).sort((a, b) => (b.status === 'new') - (a.status === 'new') || b.created - a.created).slice(0, 120);
  }
  const pool = () => entries().filter((e) => e.status === 'spare').sort((a, b) => b.score - a.score || b.created - a.created);
  // a candidate into today's picks, by the user's hand
  function promote(id) {
    const e = st.items[id]; if (!e || e.status !== 'spare') return null;
    Object.assign(e, { status: 'new', found: e.found || e.date, date: ymd(now()), created: now() }); delete e.lapsed;
    save(); onChange('feed');
    return e;
  }

  // ---- the schedule: workdays (and Saturday's report) after "at"; a failure is retried after 30 minutes, 3 times a day ----
  function due(t = now()) {
    const d = new Date(t), date = ymd(t), dow = d.getDay();
    if (dow === 0 || C().enabled === false) return null;
    const [hh, mm] = atTime();
    const at = new Date(t); at.setHours(hh || 0, mm || 0, 0, 0);
    if (t < at.getTime()) return null;
    const runs = st.runs.filter((r) => r.date === date && !r.manual);
    if (runs.some((r) => !r.error) || runs.length >= 3) return null;
    if (lastError && t - lastErrorAt < 30 * 60e3) return null;
    return date;
  }
  async function tick() {
    if (sources.dtic && now() - (st.dtic && st.dtic.at || 0) > 7 * DAY_MS) { st.dtic = { at: now(), up: await sources.dtic.publicSearchUp() }; save(); if (st.dtic.up) log('文献：DTIC 的公共检索恢复了'); }
    const d = due(); if (d && !running) await run({ date: d }).catch(() => {});
    // Semantic Scholar's queries of the day that have not answered yet: again when the gap has passed
    if (!running && C().enabled !== false && profile.get()) await s2job.tick(ymd(now()));
  }
  let timer = null;
  function start(everyMs = 60e3) { prune(); timer = setInterval(() => { tick(); }, everyMs); timer.unref && timer.unref(); }
  const status = () => ({ running: !!running, lastError, runs: st.runs.slice(-7), next: due() ? 'now' : '', archive: archive.status(), dtic: st.dtic || null, unscored: Object.keys(inbox).length, pool: entries().filter((e) => e.status === 'spare').length });

  return { run, tick, start, stop: () => timer && clearInterval(timer), list, pool, promote, get, decide, wantAbstract, gotAbstract, status, entries, markReviewed: (key) => { st.reviewed[key] = now(); save(); } };
}

module.exports = { createFeed, ymd, rotate, unquote };
