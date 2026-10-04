// 画像: what the push and every card are aimed at. The user writes the research's main line (主线) and the questions
// being worked on (most important first); the model then reads the whole Zotero library with that line as the frame
// (prompts/profile.js) and fills in the rest in detail -- the line's branches (what each covers, how well the library
// covers it, its representative papers, its search phrases), questions the user may have missed (suggestions, nothing
// more), and what to follow so every branch is watched, the thin ones above all. The user edits and confirms.
// The follow lists are made concrete here: journals -> ISSNs (from the library; a journal the library lacks: from
// OpenAlex), AIAA journals -> their RSS codes, authors -> OpenAlex ids (through a paper of theirs in the library),
// key papers -> OpenAlex ids (for "who cites them").
//   <dataDir>/literature/profile.json  { line, questions, suggestions, topics: [{ name, desc, coverage, keywords, papers }],
//                                         follow: { venues, authors, keywords, arxiv, ntrs, seeds }, confirmed, filledAt }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FILL_SCHEMA, fillPrompt } = require('./prompts/profile');

// AIAA ARC's table-of-contents feeds, by journal name (lower case)
const AIAA = { 'aiaa journal': 'aiaaj', 'journal of spacecraft and rockets': 'jsr', 'journal of aircraft': 'ja', 'journal of thermophysics and heat transfer': 'jtht',
  'journal of propulsion and power': 'jpp', 'journal of guidance, control, and dynamics': 'jgcd', 'journal of aerospace information systems': 'jais' };
const COVERAGE = ['充足', '一般', '较少'];
const id = () => crypto.randomBytes(4).toString('hex');
const uniq = (a) => [...new Set(a.map((s) => String(s).trim()).filter(Boolean))];
const unquote = (s) => String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

function createProfile({ dir, mirror, ask, openalex = null, reports = () => null, log = () => {} }) {
  const file = path.join(dir, 'profile.json');
  let p = null; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const blank = () => ({ line: '', questions: [], suggestions: [], topics: [], follow: { venues: [], authors: [], keywords: [], arxiv: [], ntrs: [], seeds: [] } });
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

  // 按主线调研补全: the model fills everything below the line (what the user changed there before is replaced)
  function fill() {
    if (job && job.running) return { ok: false, msg: '正在按主线补全' };
    if (!p || !String(p.line || '').trim()) return { ok: false, msg: '先写下研究主线并保存' };
    if (!mirror.items().length) return { ok: false, msg: '还没有读到 Zotero 文献库' };
    job = { running: true, started: Date.now() };
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
    if (typeof d.line === 'string') p.line = d.line.slice(0, 6000);
    if (Array.isArray(d.questions)) p.questions = d.questions.slice(0, 15).map((q) => ({ id: q.id || id(), text: String(q.text || '').trim().slice(0, 300), why: String(q.why || '').slice(0, 300),
      status: q.status === 'done' ? 'done' : 'open' })).filter((q) => q.text);
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
  const state = () => ({ running: !!(job && job.running), error: job && !job.running ? job.error || '' : '' });
  // the words that say what the user cares about (for picking pages, review, prefiltering)
  const words = () => p ? uniq([...(p.topics || []).flatMap((t) => t.keywords || []), ...((p.follow || {}).keywords || [])]) : [];
  const openQuestions = () => (p && p.questions || []).filter((q) => q.status !== 'done');
  return { get, fill, update, state, words, openQuestions, library };
}

module.exports = { createProfile, AIAA };
