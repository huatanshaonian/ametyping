// 每日文献: each workday morning (literature config "at", default 07:30) at most `daily` papers (default 2) -- a cap, not
// a quota. New papers come from the follow lists of the profile (journals through OpenAlex / Crossref / AIAA's feeds,
// authors, papers citing the key papers, search words, arXiv categories) and from the papers the mail triage picked out
// of journal and ResearchGate mails; anything already in the library or shown before is dropped, the rest is prefiltered
// by the profile's words and scored by the model against the user's questions (prompts/feed.js). Fewer than `daily`
// worth it: the rest is filled with reviews from the user's own collection (config "reviewCollection", 气动隐身) --
// annotated papers as active recall, unread ones as catch-up. Old reports (NTRS, DTIC) come on their own, `oldDaily` a
// day (default 1, not counted in `daily`), from a queue filled a page at a time (archive.js); Saturdays: old reports only.
// Nothing is decided for the user: a pick waits for 收下 (into Zotero, intake.js) or 跳过; after 7 days it lapses.
//   <dataDir>/literature/feed.json  { items: { id: entry }, seen: { fingerprint: t }, reviewed: { key: t }, runs: [...] }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RANK_SCHEMA, REVIEW_SCHEMA, rankPrompt, reviewPrompt } = require('./prompts/feed');
const { fingerprint, paper } = require('./sources/normalize');
const { createArchive } = require('./archive');

const DAY_MS = 86400e3;
// n items of a list, a different stretch each day (day: days since the epoch), so every item comes round
function rotate(list, n, day) {
  if (list.length <= n) return list.slice();
  const at = (day * n) % list.length;
  return [...list.slice(at), ...list.slice(0, at)].slice(0, n);
}
const unquote = (s) => String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const ymd =(t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// likes(): { pos: [DOIs], neg: [DOIs] } beyond the push's own kept / skipped (the starred cards, the key papers)
function createFeed({ dir, cfg = {}, mirror, profile, sources, ask, cards, mail = () => null, likes = () => ({ pos: [], neg: [] }), log = () => {}, onChange = () => {}, now = () => Date.now() }) {
  const file = path.join(dir, 'feed.json');
  let st = { items: {}, seen: {}, reviewed: {}, runs: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
  // (cfg: an object, or a function giving the settings in effect now -- 控制面板 › 文献 changes them while running)
  const C = () => (typeof cfg === 'function' ? cfg() : cfg) || {};
  const daily = () => Math.max(0, Math.min(5, C().daily != null ? +C().daily : 2));
  const minScore = () => (C().minScore != null ? +C().minScore : 6);
  const atTime = () => String(C().at || '07:30').split(':').map(Number);
  let running = null, lastError = '', lastErrorAt = 0;
  const oldDaily = () => Math.max(0, Math.min(3, C().oldDaily != null ? +C().oldDaily : 1));

  const entries = () => Object.values(st.items);
  const pushedOn = (date) => entries().filter((e) => e.date === date && e.status !== 'spare');

  // ---- gathering ----
  // Each source's count goes into the run's log (which way brings the papers worth reading shows after a few days).
  // The search phrases are used a few a day in turn (all of them come round), without quotes -- a quoted phrase is an
  // exact-phrase search on OpenAlex, too narrow for finding; the model's scoring does the narrowing. arXiv's categories
  // are broad: only papers with one of the profile's phrases in their title or abstract.
  async function gather(since) {
    const prof = profile.get() || {}, f = prof.follow || {};
    const out = [], errors = [], counts = {};
    const tryIt = async (name, fn) => {
      try { const r = (await fn()) || []; for (const c of r) c.via = name; out.push(...r); counts[name] = (counts[name] || 0) + r.length; }
      catch (e) { errors.push(`${name}：${e.message}`); counts[name] = counts[name] || 0; }
    };
    const day = Math.floor(now() / DAY_MS);
    const issns = [...new Set((f.venues || []).flatMap((v) => v.issns || []))];
    const S = sources;
    if (S.openalex) {
      await tryIt('期刊', () => S.openalex.byIssn(issns, since));
      await tryIt('作者', () => S.openalex.byAuthors((f.authors || []).map((a) => a.openalex).filter(Boolean), since));
      await tryIt('引用核心文献', () => S.openalex.citing((f.seeds || []).map((s) => s.openalex).filter(Boolean), since));
      for (const k of rotate((f.keywords || []).map(unquote).filter(Boolean), C().searchesPerDay || 4, day)) await tryIt('检索式', () => S.openalex.search(k, since));
    }
    // Semantic Scholar (with a key): two of the phrases a day, and papers like the ones kept / starred, unlike the skipped
    if (S.s2 && S.s2.enabled()) {
      for (const k of rotate((f.keywords || []).map(unquote).filter(Boolean), 2, day + 1)) await tryIt('S2 检索', () => S.s2.search(k, +since.slice(0, 4), 10));
      if (C().s2Recommend !== false) {
        const L = taste();
        if (L.pos.length) await tryIt('相似推荐', () => S.s2.recommend(L.pos, L.neg, 30));
      }
    }
    if (S.crossref) for (const i of rotate(issns, 8, day)) await tryIt('Crossref', () => S.crossref.byIssn(i, since, 20));
    if (S.aiaa) for (const c of [...new Set((f.venues || []).map((v) => v.aiaa).filter(Boolean))]) await tryIt('AIAA 目录', () => S.aiaa.toc(c));
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
  // what the user liked and did not: kept / skipped picks (the last 4 months) and likes() (starred cards, key papers)
  function taste() {
    const recent = entries().filter((e) => e.kind === 'new' && e.paper && e.paper.doi && now() - (e.decidedAt || 0) < 120 * DAY_MS);
    const x = likes() || {};
    const pos = [...new Set([...recent.filter((e) => e.status === 'kept').map((e) => e.paper.doi), ...(x.pos || [])])].slice(0, 50);
    const neg = [...new Set([...recent.filter((e) => e.status === 'skipped').map((e) => e.paper.doi), ...(x.neg || [])])].filter((d) => !pos.includes(d)).slice(0, 50);
    return { pos, neg };
  }
  // drop what is in the library, was shown before, or is old; merge the same paper from several sources
  function dedupe(cands, maxAgeDays = 60) {
    const byId = new Map(), byFp = new Map();
    const oldest = ymd(now() - maxAgeDays * DAY_MS);
    for (const c of cands) {
      if (!c.title) continue;
      const fp = fingerprint(c);
      if (st.seen[fp] || (c.doi && mirror.findDoi(c.doi)) || mirror.findTitle(c.title)) continue;
      if (c.date && c.date < oldest && c.source !== 'mail' && c.type !== 'report') continue;
      const prev = byId.get(c.id) || byFp.get(fp);
      if (prev) { for (const k of ['abstract', 'pdf', 'doi', 'venue', 'date']) if (!prev[k] && c[k]) prev[k] = c[k]; prev.sources = [...new Set([...(prev.sources || [prev.source]), c.source])];
        prev.vias = [...new Set([...(prev.vias || []), c.via].filter(Boolean))]; continue; }
      const { via, ...rest } = c;
      const x = { ...rest, sources: [c.source], vias: via ? [via] : [] };
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
  // the profile's words in the title / abstract: the 30 most promising go to the model (followed authors / citing: always)
  function prefilter(list, n = 30) {
    const words = profile.words().map((w) => w.toLowerCase());
    const score = (c) => { const t = (c.title + ' ' + c.abstract).toLowerCase(); return words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0) + (c.abstract ? 0.5 : 0) + ((c.sources || []).length - 1); };
    return list.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.c);
  }
  function feedback() {
    const done = entries().filter((e) => e.kind === 'new' && e.decidedAt).sort((a, b) => b.decidedAt - a.decidedAt);
    return { kept: done.filter((e) => e.status === 'kept').slice(0, 10).map((e) => e.paper.title), skipped: done.filter((e) => e.status === 'skipped').slice(0, 10).map((e) => e.paper.title) };
  }
  // the question's own text kept with a pick (its number changes when questions are reordered, solved or removed)
  const qText = (n) => { const q = n > 0 ? profile.openQuestions()[n - 1] : null; return q ? q.text : ''; };
  async function rank(list) {
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
        const { cands, errors, counts } = await gather(since);
        log1.errors = errors; log1.found = cands.length; log1.sources = counts;
        let list = dedupe(cands);
        await enrich(list);
        list = prefilter(list);
        const ranked = await rank(list);
        log1.ranked = ranked.length;
        for (const r of ranked) st.seen[fingerprint(r.c)] = now();
        const good = ranked.filter((r) => r.score >= minScore());
        // per way of finding: how many of the good ones it brought (a paper found two ways counts for both)
        log1.good = {}; for (const r of good) for (const v of r.c.vias || []) log1.good[v] = (log1.good[v] || 0) + 1;
        for (const r of good.slice(0, want)) { add({ kind: 'new', date, paper: r.c, score: r.score, question: r.question, qText: qText(r.question), why: r.why, fun: r.fun }); log1.picked++; }
        // the next best few, kept aside (更多 shows them)
        for (const r of good.slice(want, want + 4)) add({ kind: 'new', date, paper: r.c, score: r.score, question: r.question, qText: qText(r.question), why: r.why, fun: r.fun, status: 'spare' });
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
  // seen fingerprints older than half a year are forgotten; picks not decided in 7 days lapse; old entries go
  function prune() {
    const t = now();
    for (const [fp, at] of Object.entries(st.seen)) if (t - at > 180 * DAY_MS) delete st.seen[fp];
    for (const e of entries()) {
      if ((e.status === 'new' || e.status === 'spare') && t - e.created > 7 * DAY_MS) e.status = 'expired';
      if (['expired', 'skipped'].includes(e.status) && t - e.created > 60 * DAY_MS) delete st.items[e.id];
    }
  }

  // ---- the user's choices ----
  function get(id) { return st.items[id] || null; }
  function decide(id, status, patch = {}) {
    const e = st.items[id]; if (!e) return null;
    Object.assign(e, patch, status ? { status, decidedAt: now() } : {});
    save(); onChange('feed');
    return e;
  }
  // what the window shows: today's (and still open) picks first, then the last two weeks
  function list() {
    const t = now();
    return entries().filter((e) => e.status !== 'expired' || t - e.created < 3 * DAY_MS).sort((a, b) => b.created - a.created).slice(0, 80);
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
  }
  let timer = null;
  function start(everyMs = 60e3) { prune(); timer = setInterval(() => { tick(); }, everyMs); timer.unref && timer.unref(); }
  const status = () => ({ running: !!running, lastError, runs: st.runs.slice(-7), next: due() ? 'now' : '', archive: archive.status(), dtic: st.dtic || null });

  return { run, tick, start, stop: () => timer && clearInterval(timer), list, get, decide, status, entries, markReviewed: (key) => { st.reviewed[key] = now(); save(); } };
}

module.exports = { createFeed, ymd, rotate, unquote };
