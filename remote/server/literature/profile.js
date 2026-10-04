// 画像: what the push and every card are aimed at. The user writes an account of the work (研究自述: what it is, where
// it is stuck, as unsystematic as it comes); the model sorts it into the research's main line (主线) and the questions
// in dimensions -- after looking up the library and the last years' literature (organize); the user corrects those;
// the model then reads the whole Zotero library with that line as the frame
// (prompts/profile.js) and fills in the rest in detail -- the line's branches (what each covers, how well the library
// covers it, its representative papers, its search phrases), questions the user may have missed (suggestions, nothing
// more), and what to follow so every branch is watched, the thin ones above all. The user edits and confirms.
// The follow lists are made concrete here: journals -> ISSNs (from the library; a journal the library lacks: from
// OpenAlex), AIAA journals -> their RSS codes, authors -> OpenAlex ids (through a paper of theirs in the library),
// key papers -> OpenAlex ids (for "who cites them").
//   <dataDir>/literature/profile.json  { story, line, questions, unclear, suggestions, topics: [{ name, desc, coverage, keywords, papers }],
//                                         follow: { venues, authors, keywords, arxiv, ntrs, seeds }, confirmed, filledAt }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FILL_SCHEMA, fillPrompt, PLAN_SCHEMA, planPrompt, QUESTIONS_SCHEMA, questionsPrompt, DIMS } = require('./prompts/profile');

// AIAA ARC's table-of-contents feeds, by journal name (lower case)
const AIAA = { 'aiaa journal': 'aiaaj', 'journal of spacecraft and rockets': 'jsr', 'journal of aircraft': 'ja', 'journal of thermophysics and heat transfer': 'jtht',
  'journal of propulsion and power': 'jpp', 'journal of guidance, control, and dynamics': 'jgcd', 'journal of aerospace information systems': 'jais' };
const COVERAGE = ['充足', '一般', '较少'];
const id = () => crypto.randomBytes(4).toString('hex');
const uniq = (a) => [...new Set(a.map((s) => String(s).trim()).filter(Boolean))];
const unquote = (s) => String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

// s2: Semantic Scholar (sources/s2.js), the second search engine when working out the questions (optional)
function createProfile({ dir, mirror, ask, openalex = null, s2 = null, reports = () => null, log = () => {} }) {
  const file = path.join(dir, 'profile.json');
  let p = null; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const blank = () => ({ story: '', line: '', questions: [], unclear: [], suggestions: [], topics: [], follow: { venues: [], authors: [], keywords: [], arxiv: [], ntrs: [], seeds: [] } });
  const save = () => { p.updated = Date.now(); fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 1)); fs.renameSync(file + '.tmp', file); };
  let job = null;

  // the whole library as the model is shown it: counts, then every item (annotated first, then the newest)
  function library() {
    const items = mirror.items();
    const cname = new Map(mirror.collections().map((c) => [c.key, c.name]));
    const count = (pick) => { const m = new Map(); for (const it of items) for (const x of pick(it)) if (x) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
    const rows = items.map((it) => ({ ...it, notes: mirror.annotationCount(it.key) + mirror.childrenOf(it.key).notes.length })).sort((a, b) => (!!b.notes - !!a.notes) || b.added - a.added);
    return {
      venues: count((it) => [it.venue]), authors: count((it) => it.creators.slice(0, 3)), collections: count((it) => it.collections.map((c) => cname.get(c))),
      items: rows.slice(0, 800).map((it) => ({ key: it.key, title: it.title, venue: it.venue, year: it.year, collections: it.collections.map((c) => cname.get(c)).filter(Boolean), notes: it.notes, abstract: it.abstract })),
    };
  }
  function recentWork(days = 14) {
    const R = reports(); if (!R) return [];
    const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    return (R.list() || []).filter((x) => x.date >= since).slice(-days).map((x) => { const r = R.get(x.date) || {}; return { date: x.date, headline: r.headline || '', projects: (r.projects || []).filter((q) => q.category !== 'chore').map((q) => ({ name: q.name, summary: q.summary })) }; });
  }

  // a journal's ISSNs: from the library's own items, else (a journal the library lacks) OpenAlex's record of it
  async function issnsOf(name) {
    const mine = uniq(mirror.items().filter((it) => it.venue.toLowerCase() === name.toLowerCase()).flatMap((it) => it.issns || (it.issn ? [it.issn] : []))).slice(0, 3);
    if (mine.length || !openalex || !openalex.source) return mine;
    try { const s = await openalex.source(name); return s ? s.issns.slice(0, 3) : []; } catch { return []; }
  }
  // an item key the model left in a sentence ("[RJAEWKDJ]") -> the paper's short title: the user reads titles, not keys
  function readable(s) {
    return String(s || '').replace(/\[?\b([A-Z0-9]{8})\b\]?/g, (m, k) => {
      const it = mirror.item(k); if (!it) return m;
      const t = it.title.length > 36 ? it.title.slice(0, 34) + '…' : it.title;
      return `《${t}》`;
    });
  }
  // the model's filling -> the stored shape (the line and the user's questions are not touched)
  async function shape(d) {
    for (const b of d.branches || []) b.desc = readable(b.desc);
    for (const q of d.suggestQuestions || []) { q.text = readable(q.text); q.why = readable(q.why); }
    const venues = [];
    for (const name of uniq([...(d.venues || []).slice(0, 12), ...(d.extraVenues || []).slice(0, 4)])) venues.push({ name, issns: await issnsOf(name), aiaa: AIAA[name.toLowerCase()] || '', extra: !(d.venues || []).includes(name) });
    const seeds = uniq(d.seeds || []).map((k) => mirror.item(k)).filter(Boolean).slice(0, 12).map((it) => ({ key: it.key, title: it.title, doi: it.doi, openalex: '' }));
    const mineQ = new Set((p.questions || []).map((q) => q.text.trim()));
    return {
      topics: (d.branches || []).slice(0, 12).map((t) => ({ name: String(t.name || '').trim().slice(0, 60), desc: String(t.desc || '').trim().slice(0, 800),
        coverage: COVERAGE.includes(t.coverage) ? t.coverage : '', keywords: uniq((t.keywords || []).map(unquote)).slice(0, 10),
        papers: uniq(t.papers || []).filter((k) => mirror.item(k)).slice(0, 8) })).filter((t) => t.name),
      suggestions: (d.suggestQuestions || []).slice(0, 6).map((q) => ({ id: id(), text: String(q.text || '').trim().slice(0, 300), why: String(q.why || '').trim().slice(0, 300) })).filter((q) => q.text && !mineQ.has(q.text)),
      follow: { venues, authors: uniq(d.authors || []).slice(0, 12).map((name) => ({ name, openalex: '' })), keywords: uniq((d.keywords || []).map(unquote)).slice(0, 20),
        arxiv: uniq(d.arxiv || []).filter((c) => /^[a-z-]+(\.[A-Za-z-]+)?$/.test(c)).slice(0, 6), ntrs: uniq((d.ntrs || []).map(unquote)).slice(0, 10), seeds },
      confirmed: false, filledAt: Date.now(),
    };
  }
  // OpenAlex ids for the authors and key papers (the user sees which were found). An author is found through a paper of
  // theirs in the library that has a DOI -- the author in the same place on OpenAlex's record -- not by the name alone
  // (common names, Chinese names above all, match strangers); only a name the library cannot place is searched, marked
  // as a guess.
  const last = (s) => String(s || '').split(',')[0].trim().toLowerCase().normalize('NFKD').replace(/[^\p{L}]/gu, '');
  async function authorFromLibrary(name) {
    const mine = mirror.items().filter((it) => it.doi && it.creators.includes(name)).slice(0, 3);
    for (const it of mine) {
      let w = null; try { w = await openalex.byDoi(it.doi); } catch {}
      const ids = (w && w.authorIds) || [];
      const i = it.creators.indexOf(name);
      const byPlace = ids.length === it.creators.length ? ids[i] : null;
      const byName = ids.find((a) => last(a.name.split(' ').pop()) === last(name) || last(a.name).includes(last(name)));
      const hit = byPlace || byName;
      if (hit && hit.id) return { openalex: hit.id, inst: hit.inst };
    }
    return null;
  }
  async function resolve(q) {
    if (!openalex) return;
    for (const a of q.follow.authors) {
      if (a.openalex) continue;
      try {
        const r = await authorFromLibrary(a.name);
        if (r) Object.assign(a, r, { guess: false });
        else if (!mirror.items().some((it) => it.creators.includes(a.name))) { const g = await openalex.authorId(a.name); if (g) Object.assign(a, { openalex: g.id, inst: g.inst, guess: true }); }
      } catch {}
    }
    for (const s of q.follow.seeds) if (!s.openalex && s.doi) { try { const w = await openalex.byDoi(s.doi); if (w) s.openalex = w.openalex; } catch {} }
  }

  // the library's papers about these words (title, abstract, tags, collection names; annotated ones count double)
  function libraryAbout(words, n = 45) {
    const ws = uniq(words.map((w) => w.toLowerCase())).filter((w) => w.length > 1);
    const cname = new Map(mirror.collections().map((c) => [c.key, c.name]));
    return mirror.items().map((it) => {
      const t = [it.title, it.abstract, it.tags.join(' '), it.collections.map((c) => cname.get(c)).join(' ')].join(' ').toLowerCase();
      const hits = ws.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
      const notes = mirror.annotationCount(it.key) + mirror.childrenOf(it.key).notes.length;
      return { it, notes, s: hits * (notes ? 2 : 1) };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.it.added - a.it.added).slice(0, n);
  }
  // the last years' literature for the searches, most relevant first -- OpenAlex, and Semantic Scholar beside it (its
  // relevance is often better; without a key it may be busy and is then left out) -- the library's own papers left out
  async function frontier(queries, years = 4, per = 7, max = 60) {
    const from = new Date().getFullYear() - years, seen = new Set(), out = [];
    const add = (r) => { for (const w of r) {
      const k = w.doi || w.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (!w.title || seen.has(k) || (w.doi && mirror.findDoi(w.doi)) || mirror.findTitle(w.title)) continue;
      seen.add(k); out.push(w);
    } };
    for (const q of queries.slice(0, 10)) {
      if (openalex && openalex.explore) { try { add(await openalex.explore(unquote(q), from, per)); } catch (e) { log('文献：梳理时 OpenAlex 检索失败：' + e.message); } }
    }
    if (s2) {
      for (const q of queries.slice(0, 6)) {
        try { add(await s2.search(unquote(q), from, 6)); } catch (e) { log('文献：梳理时 Semantic Scholar 检索失败：' + e.message); if (e.status === 429) break; }
      }
    }
    return out.slice(0, max);
  }
  // 梳理 -- research, not a summary of the account: (1) the account -> a first line and what to look up; (2) the
  // library's papers that matter + the last years' literature (OpenAlex); (3) the line again and the questions in
  // dimensions, each with what others asked and answered and the papers it rests on. Replaces the line and questions
  // there (the window asks first when they were edited).
  function organize() {
    if (job && job.running) return { ok: false, msg: '正在处理上一步' };
    if (!p || String(p.story || '').trim().length < 20) return { ok: false, msg: '先写下研究自述并保存（多写一点）' };
    job = { running: true, what: 'organize', step: '读自述', started: Date.now() };
    (async () => {
      const work = recentWork();
      const plan = await ask(planPrompt(p.story, work, library().collections), PLAN_SCHEMA);
      job.step = '翻文献库、检索近几年的文献';
      const lib = libraryAbout([...(plan.libWords || []), ...(plan.queries || []).flatMap((q) => unquote(q).split(' '))]).map((x, i) => ({ ref: 'L' + (i + 1), key: x.it.key, title: x.it.title, venue: x.it.venue, year: x.it.year, abstract: x.it.abstract, notes: x.notes }));
      const fresh = (await frontier(plan.queries || [])).map((w, i) => ({ ref: 'N' + (i + 1), ...w }));
      job.step = '归纳问题';
      const d = await ask(questionsPrompt(p.story, plan.line || '', lib, fresh, work), QUESTIONS_SCHEMA);
      const byRef = new Map([...lib.map((x) => [x.ref, { key: x.key, title: x.title, year: x.year }]), ...fresh.map((x) => [x.ref, { title: x.title, year: x.year, venue: x.venue, url: x.url, doi: x.doi }])]);
      // (a paper the model named by its list number in a sentence: its short title instead)
      const named = (t) => readable(t).replace(/\[?\b([LN]\d{1,3})\b\]?/g, (m, r) => { const x = byRef.get(r); return x ? `《${x.title.length > 36 ? x.title.slice(0, 34) + '…' : x.title}》` : m; });
      p.line = named(String(d.line || plan.line || '').trim()).slice(0, 6000);
      p.questions = (d.questions || []).slice(0, 16).map((q) => ({ id: id(), dim: DIMS.includes(q.dim) ? q.dim : '贴合工作', text: named(String(q.text || '').trim()).slice(0, 300),
        why: named(String(q.why || '').trim()).slice(0, 300), state: named(String(q.state || '').trim()).slice(0, 600),
        refs: uniq((q.refs || []).map((r) => String(r).replace(/[^LN\d]/gi, '').toUpperCase())).map((r) => byRef.get(r)).filter(Boolean).slice(0, 5), status: 'open' }))
        .filter((q) => q.text).sort((a, b) => DIMS.indexOf(a.dim) - DIMS.indexOf(b.dim));
      p.unclear = (d.unclear || []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
      p.organized = { at: Date.now(), library: lib.length, fresh: fresh.length };
      p.organizedAt = Date.now(); p.confirmed = false;
      save();
      log(`文献：研究自述已梳理（库内 ${lib.length} 篇、近几年 ${fresh.length} 篇文献为据；${p.questions.length} 个问题，待修改）`);
    })().catch((e) => { job.error = e.message; log('文献：梳理研究自述失败：' + e.message); }).finally(() => { job.running = false; });
    return { ok: true };
  }
  // 按主线调研补全: the model fills everything below the line (what the user changed there before is replaced)
  function fill() {
    if (job && job.running) return { ok: false, msg: '正在按主线补全' };
    if (!p || !String(p.line || '').trim()) return { ok: false, msg: '先梳理出研究主线（或自己写）并保存' };
    if (!mirror.items().length) return { ok: false, msg: '还没有读到 Zotero 文献库' };
    job = { running: true, what: 'fill', started: Date.now() };
    (async () => {
      const qs = (p.questions || []).filter((q) => q.status !== 'done').map((q) => q.text);
      const d = await ask(fillPrompt(p.line, qs, library(), recentWork()), FILL_SCHEMA);
      const next = await shape(d);
      await resolve(next);
      p = { ...p, ...next };
      save();
      log(`文献：已按主线补全画像（${next.topics.length} 个分支，${next.suggestions.length} 个建议的问题；待确认）`);
    })().catch((e) => { job.error = e.message; log('文献：按主线补全失败：' + e.message); }).finally(() => { job.running = false; });
    return { ok: true };
  }

  // the user's edits: any of line, questions (in order of importance), suggestions, topics, follow; confirm marks it confirmed
  async function update(d) {
    if (!p) p = blank();
    if (typeof d.story === 'string') p.story = d.story.slice(0, 30000);
    if (typeof d.line === 'string') p.line = d.line.slice(0, 6000);
    if (Array.isArray(d.unclear)) p.unclear = d.unclear.map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 6);
    if (Array.isArray(d.questions)) p.questions = d.questions.slice(0, 20).map((q) => ({ id: q.id || id(), dim: DIMS.includes(q.dim) ? q.dim : '', text: String(q.text || '').trim().slice(0, 300),
      why: String(q.why || '').slice(0, 300), state: String(q.state || '').slice(0, 600), status: q.status === 'done' ? 'done' : 'open',
      refs: (Array.isArray(q.refs) ? q.refs : []).slice(0, 6).map((r) => ({ key: /^[A-Z0-9]{8}$/.test(r.key || '') ? r.key : undefined, title: String(r.title || '').slice(0, 300), year: +r.year || undefined,
        venue: r.venue ? String(r.venue).slice(0, 120) : undefined, url: /^https?:\/\//.test(r.url || '') ? String(r.url).slice(0, 500) : undefined, doi: r.doi ? String(r.doi).slice(0, 200) : undefined })).filter((r) => r.title) })).filter((q) => q.text);
    if (Array.isArray(d.suggestions)) p.suggestions = d.suggestions.slice(0, 8).map((q) => ({ id: q.id || id(), text: String(q.text || '').slice(0, 300), why: String(q.why || '').slice(0, 300) })).filter((q) => q.text);
    if (Array.isArray(d.topics)) p.topics = d.topics.slice(0, 15).map((t) => ({ name: String(t.name || '').trim().slice(0, 60), desc: String(t.desc || '').slice(0, 800),
      coverage: COVERAGE.includes(t.coverage) ? t.coverage : '', keywords: uniq((t.keywords || []).map(unquote)).slice(0, 12),
      papers: uniq(t.papers || []).filter((k) => mirror.item(k)).slice(0, 10) })).filter((t) => t.name);
    if (d.follow && typeof d.follow === 'object') {
      const f = d.follow, old = p.follow || {};
      p.follow = {
        venues: Array.isArray(f.venues) ? f.venues.slice(0, 20).map((v) => ({ name: String(v.name || '').slice(0, 120), issns: uniq(v.issns || []).filter((x) => /^\d{4}-\d{3}[\dXx]$/.test(x)).slice(0, 4),
          aiaa: String(v.aiaa || AIAA[String(v.name || '').toLowerCase()] || '').slice(0, 10), extra: !!v.extra })).filter((v) => v.name) : old.venues || [],
        authors: Array.isArray(f.authors) ? f.authors.slice(0, 20).map((a) => { const aid = /^A\d+$/.test(a.openalex || '') ? a.openalex : '';
          return { name: String(a.name || '').slice(0, 80), openalex: aid, inst: aid ? String(a.inst || '').slice(0, 120) : '', guess: !!aid && !!a.guess }; }).filter((a) => a.name) : old.authors || [],
        keywords: Array.isArray(f.keywords) ? uniq(f.keywords.map(unquote)).slice(0, 24) : old.keywords || [],
        arxiv: Array.isArray(f.arxiv) ? uniq(f.arxiv).slice(0, 8) : old.arxiv || [],
        ntrs: Array.isArray(f.ntrs) ? uniq(f.ntrs.map(unquote)).slice(0, 12) : old.ntrs || [],
        seeds: Array.isArray(f.seeds) ? f.seeds.slice(0, 12).map((s) => ({ key: s.key || '', title: String(s.title || '').slice(0, 300), doi: s.doi || '', openalex: /^W\d+$/.test(s.openalex || '') ? s.openalex : '' })) : old.seeds || [],
      };
      // (a journal typed in without ISSNs: found the same way as the model's)
      for (const v of p.follow.venues) if (!v.issns.length) v.issns = await issnsOf(v.name);
      await resolve(p);
    }
    if (d.confirm) p.confirmed = true;
    save();
    return { ok: true, profile: p };
  }
  const get = () => p;
  const state = () => ({ running: !!(job && job.running), what: (job && job.what) || '', step: job && job.running ? job.step || '' : '', error: job && !job.running ? job.error || '' : '' });
  // the words that say what the user cares about (for picking pages, review, prefiltering)
  const words = () => p ? uniq([...(p.topics || []).flatMap((t) => t.keywords || []), ...((p.follow || {}).keywords || [])]) : [];
  const openQuestions = () => (p && p.questions || []).filter((q) => q.status !== 'done');
  return { get, organize, fill, update, state, words, openQuestions, library };
}

module.exports = { createProfile, AIAA };
