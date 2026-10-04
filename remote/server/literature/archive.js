// 老报告: NASA's and DTIC's technical reports (NTRS; DTIC through the Internet Archive's copy), pushed from a queue.
// A page (10 reports) is pulled for one of the profile's short searches, scored by the model like the new papers, and
// the good ones wait in the queue, best first; each day takes from the queue, and only an empty queue pulls the next page
// -- of the same search until it runs out, then the next search, NTRS and DTIC in turn. A search that has run out rests
// for two months. Changed searches (a new profile) start from their first page.
//   <dataDir>/literature/archive.json  { cursors: { "<source>|<search>": { next, done, at } }, queue: [pick], turn }
'use strict';
const fs = require('fs');
const path = require('path');
const { fingerprint } = require('./sources/normalize');

const PAGE = 10, REST_MS = 60 * 86400e3, MAX_PULLS = 4;

// rank(list) -> [{ c, score, question, why, fun }] (the feed's own scoring); seen(fp) / see(fp): shown before
function createArchive({ dir, sources, profile, mirror, rank, seen, see, minScore = () => 6, log = () => {}, now = () => Date.now() }) {
  const file = path.join(dir, 'archive.json');
  let st = { cursors: {}, queue: [], turn: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
  const srcs = () => ['ntrs', 'dtic'].filter((s) => sources[s]);
  const searches = () => ((profile.get() || {}).follow || {}).ntrs || [];

  // the next (source, search) with pages left, in turn
  function nextCursor() {
    const qs = searches(), ss = srcs(), all = [];
    for (const q of qs) for (const s of ss) all.push(`${s}|${q}`);
    if (!all.length) return null;
    for (let i = 0; i < all.length; i++) {
      const id = all[(st.turn + i) % all.length];
      const c = st.cursors[id] || (st.cursors[id] = { next: 0, done: false, at: 0 });
      if (c.done && now() - c.at > REST_MS) Object.assign(c, { next: 0, done: false });   // (rested: from the start again)
      if (!c.done) { st.turn = (st.turn + i + 1) % all.length; return id; }
    }
    return null;
  }
  // one page for a cursor -> the reports not shown before and not in the library
  async function pull(id) {
    const [src, q] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)];
    const c = st.cursors[id];
    const r = src === 'ntrs' ? await sources.ntrs.page(q, PAGE, c.next) : await sources.dtic.page(q, PAGE, c.next + 1);
    c.next += src === 'ntrs' ? PAGE : 1;
    c.at = now();
    if (!r.items.length || (src === 'ntrs' ? c.next >= r.total : c.next * PAGE >= r.total)) c.done = true;
    const inQueue = new Set(st.queue.map((x) => fingerprint(x.paper)));
    return r.items.filter((p) => p.title && !seen(fingerprint(p)) && !inQueue.has(fingerprint(p)) && !mirror.findTitle(p.title) && !(p.doi && mirror.findDoi(p.doi)))
      .map((p) => ({ ...p, via: src === 'ntrs' ? 'NTRS' : 'DTIC', query: q }));
  }

  // up to n reports for today: from the queue; an empty queue pulls pages (a few at most) until something good turns up
  async function take(n, log1 = { errors: [] }) {
    let pulls = 0;
    while (st.queue.length < n && pulls < MAX_PULLS) {
      const id = nextCursor(); if (!id) break;
      pulls++;
      let list = [];
      try { list = await pull(id); } catch (e) { log1.errors.push(`${id.split('|')[0].toUpperCase()}：${e.message}`); continue; }
      if (!list.length) continue;
      const ranked = await rank(list);
      for (const r of ranked) see(fingerprint(r.c));
      const good = ranked.filter((r) => r.score >= Math.max(5, minScore() - 1));
      st.queue.push(...good.map((r) => ({ paper: r.c, score: r.score, question: r.question, why: r.why, fun: r.fun, at: now() })));
      st.queue.sort((a, b) => b.score - a.score);
      log1.archivePulled = (log1.archivePulled || 0) + list.length;
      log(`文献：老报告 ${id.replace('|', '「')}」第 ${st.cursors[id].next} 页：${list.length} 篇，够格 ${good.length} 篇进队列（队列现有 ${st.queue.length}）`);
    }
    const out = st.queue.splice(0, n);
    save();
    return out;
  }
  const status = () => ({ queue: st.queue.length, top: st.queue.slice(0, 3).map((x) => x.paper.title), cursors: Object.entries(st.cursors).map(([id, c]) => ({ id, next: c.next, done: c.done })) });
  return { take, status };
}

module.exports = { createArchive };
