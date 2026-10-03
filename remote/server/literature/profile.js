// 画像: what the user researches, the questions being worked on now, and what to follow. Drafted by the model from the
// Zotero library + the last two weeks of daily reports (prompts/profile.js), then edited and confirmed by the user;
// the feed and every card use it. The follow lists are made concrete here: journals -> their ISSNs (from the library),
// AIAA journals -> their RSS codes, authors -> OpenAlex ids, key papers -> OpenAlex ids (for "who cites them").
//   <dataDir>/literature/profile.json
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROFILE_SCHEMA, profilePrompt } = require('./prompts/profile');

// AIAA ARC's table-of-contents feeds, by journal name (lower case)
const AIAA = { 'aiaa journal': 'aiaaj', 'journal of spacecraft and rockets': 'jsr', 'journal of aircraft': 'ja', 'journal of thermophysics and heat transfer': 'jtht',
  'journal of propulsion and power': 'jpp', 'journal of guidance, control, and dynamics': 'jgcd', 'journal of aerospace information systems': 'jais' };
const id = () => crypto.randomBytes(4).toString('hex');
const uniq = (a) => [...new Set(a.map((s) => String(s).trim()).filter(Boolean))];

function createProfile({ dir, mirror, ask, openalex = null, reports = () => null, log = () => {} }) {
  const file = path.join(dir, 'profile.json');
  let p = null; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const save = () => { p.updated = Date.now(); fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 1)); fs.renameSync(file + '.tmp', file); };
  let job = null;

  // the library as the model is shown it: counts, then items (annotated / recently added first; at most 300 with text)
  function library() {
    const items = mirror.items();
    const cname = new Map(mirror.collections().map((c) => [c.key, c.name]));
    const count = (pick) => { const m = new Map(); for (const it of items) for (const x of pick(it)) if (x) m.set(x, (m.get(x) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
    const rows = items.map((it) => ({ ...it, notes: mirror.annotationCount(it.key) + mirror.childrenOf(it.key).notes.length })).sort((a, b) => (!!b.notes - !!a.notes) || b.added - a.added);
    return {
      venues: count((it) => [it.venue]), authors: count((it) => it.creators.slice(0, 3)), collections: count((it) => it.collections.map((c) => cname.get(c))),
      items: rows.slice(0, 400).map((it, i) => ({ key: it.key, title: it.title, venue: it.venue, year: it.year, collections: it.collections.map((c) => cname.get(c)).filter(Boolean),
        notes: it.notes, abstract: i < 300 ? it.abstract : '' })),
    };
  }
  function recentWork(days = 14) {
    const R = reports(); if (!R) return [];
    const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    return (R.list() || []).filter((x) => x.date >= since).slice(-days).map((x) => { const r = R.get(x.date) || {}; return { date: x.date, headline: r.headline || '', projects: (r.projects || []).filter((q) => q.category !== 'chore').map((q) => ({ name: q.name, summary: q.summary })) }; });
  }

  // the model's draft -> the stored shape (journals resolved to ISSNs from the library itself)
  function shape(d, old) {
    const items = mirror.items();
    const venues = uniq(d.venues || []).slice(0, 12).map((name) => {
      const issns = uniq(items.filter((it) => it.venue.toLowerCase() === name.toLowerCase()).flatMap((it) => it.issns || (it.issn ? [it.issn] : []))).slice(0, 3);
      return { name, issns, aiaa: AIAA[name.toLowerCase()] || '' };
    });
    const seeds = uniq(d.seeds || []).map((k) => mirror.item(k)).filter(Boolean).slice(0, 10).map((it) => ({ key: it.key, title: it.title, doi: it.doi, openalex: '' }));
    const keepQ = (old && old.questions || []).filter((q) => q.mine);              // questions the user wrote stay
    return {
      summary: String(d.summary || '').trim(), topics: (d.topics || []).slice(0, 10).map((t) => ({ name: String(t.name || '').trim(), keywords: uniq(t.keywords || []).slice(0, 10) })),
      questions: [...keepQ, ...(d.questions || []).slice(0, 8).map((q) => ({ id: id(), text: String(q.text || '').trim(), why: String(q.why || '').trim(), status: 'open' }))].filter((q) => q.text),
      follow: { venues, authors: uniq(d.authors || []).slice(0, 12).map((name) => ({ name, openalex: '' })), keywords: uniq(d.keywords || []).slice(0, 15),
        arxiv: uniq(d.arxiv || []).filter((c) => /^[a-z-]+(\.[A-Za-z-]+)?$/.test(c)).slice(0, 6), ntrs: uniq(d.ntrs || []).slice(0, 10), seeds },
      confirmed: false, draftAt: Date.now(),
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

  function draft() {
    if (job && job.running) return { ok: false, msg: '正在生成画像' };
    if (!mirror.items().length) return { ok: false, msg: '还没有读到 Zotero 文献库' };
    job = { running: true, started: Date.now() };
    (async () => {
      const d = await ask(profilePrompt(library(), recentWork(), p && p.confirmed ? p : null), PROFILE_SCHEMA);
      const next = shape(d, p);
      await resolve(next);
      p = { ...(p || {}), ...next };
      save();
      log('文献：兴趣画像已生成（待确认）');
    })().catch((e) => { job.error = e.message; log('文献：生成画像失败：' + e.message); }).finally(() => { job.running = false; });
    return { ok: true };
  }
  // the user's edits: any of summary, topics, questions, follow; confirm: true marks it confirmed
  async function update(d) {
    if (!p) p = { summary: '', topics: [], questions: [], follow: { venues: [], authors: [], keywords: [], arxiv: [], ntrs: [], seeds: [] } };
    if (typeof d.summary === 'string') p.summary = d.summary.slice(0, 2000);
    if (Array.isArray(d.topics)) p.topics = d.topics.slice(0, 12).map((t) => ({ name: String(t.name || '').slice(0, 60), keywords: uniq(t.keywords || []).slice(0, 12) })).filter((t) => t.name);
    if (Array.isArray(d.questions)) p.questions = d.questions.slice(0, 12).map((q) => ({ id: q.id || id(), text: String(q.text || '').slice(0, 300), why: String(q.why || '').slice(0, 300),
      status: q.status === 'done' ? 'done' : 'open', mine: !!q.mine || !(p.questions || []).some((x) => x.id === q.id && x.text === q.text) })).filter((q) => q.text);
    if (d.follow && typeof d.follow === 'object') {
      const f = d.follow, old = p.follow || {};
      p.follow = {
        venues: Array.isArray(f.venues) ? f.venues.slice(0, 20).map((v) => ({ name: String(v.name || '').slice(0, 120), issns: uniq(v.issns || []).filter((x) => /^\d{4}-\d{3}[\dXx]$/.test(x)).slice(0, 4), aiaa: String(v.aiaa || AIAA[String(v.name || '').toLowerCase()] || '').slice(0, 10) })).filter((v) => v.name) : old.venues || [],
        authors: Array.isArray(f.authors) ? f.authors.slice(0, 20).map((a) => { const id = /^A\d+$/.test(a.openalex || '') ? a.openalex : '';
          return { name: String(a.name || '').slice(0, 80), openalex: id, inst: id ? String(a.inst || '').slice(0, 120) : '', guess: !!id && !!a.guess }; }).filter((a) => a.name) : old.authors || [],
        keywords: Array.isArray(f.keywords) ? uniq(f.keywords).slice(0, 20) : old.keywords || [],
        arxiv: Array.isArray(f.arxiv) ? uniq(f.arxiv).slice(0, 8) : old.arxiv || [],
        ntrs: Array.isArray(f.ntrs) ? uniq(f.ntrs).slice(0, 12) : old.ntrs || [],
        seeds: Array.isArray(f.seeds) ? f.seeds.slice(0, 12).map((s) => ({ key: s.key || '', title: String(s.title || '').slice(0, 300), doi: s.doi || '', openalex: /^W\d+$/.test(s.openalex || '') ? s.openalex : '' })) : old.seeds || [],
      };
      await resolve(p);
    }
    if (d.confirm) p.confirmed = true;
    save();
    return { ok: true, profile: p };
  }
  const get = () => p;
  const state = () => ({ running: !!(job && job.running), error: job && !job.running ? job.error || '' : '' });
  // the words that say what the user cares about (for picking pages, review, prefiltering)
  const words = () => p ? uniq([...(p.topics || []).flatMap((t) => t.keywords), ...((p.follow || {}).keywords || [])]) : [];
  const openQuestions = () => (p && p.questions || []).filter((q) => q.status !== 'done');
  return { get, draft, update, state, words, openQuestions, library };
}

module.exports = { createProfile, AIAA };
