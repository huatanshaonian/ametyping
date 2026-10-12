// 摘要对照 and the push's waiting list, with stand-ins for everything around them (no server):
//   translate.js -- pairs only when the sentences given back are the abstract's own; Chinese abstracts left alone; a
//                   failure is not asked again at once
//   feed.js      -- the good papers a day has no room for wait for good, and compete with the next day's finds by
//                   score; one place a day is for the ones published lately; a pick left alone goes back among them;
//                   what is found and not scored waits its turn; searches without a date go a page further each time
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTranslate } = require('../server/literature/translate');
const { createFeed } = require('../server/literature/feed');
const { paper } = require('../server/literature/sources/normalize');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-unit-'));

(async () => {
  // ---- translate ----
  const A = 'We measure the electron density of the plasma sheath. The RCS drops by 10 dB at X band.';
  const B = 'A second abstract about hypersonic wake scattering, which the model garbles when it copies.';
  const ZH = '本文测量了再入等离子体鞘套的电子密度分布，并给出了 X 波段雷达散射截面的变化规律，结果表明下降约 10 dB。';
  const calls = []; let broken = false;
  const ask = async (prompt) => {
    calls.push(prompt);
    if (broken) throw new Error('model down');
    return { items: [...prompt.matchAll(/^### (T\d+)\n(.*)$/gm)].map((m) => ({ ref: m[1], segs: m[2].split(/(?<=\.)\s+/).map((s) => ({ src: m[2] === B ? s.replace('garbles', 'changes') : s, zh: '译' + s.length })) })) };
  };
  let clock = Date.parse('2026-10-12T08:00:00');
  const tr = createTranslate({ dir: T, ask, now: () => clock });
  await tr.want([A, B, ZH, 'short', A]);
  ok('one call for the two foreign abstracts (the Chinese one, the short one and the repeat left out)', calls.length === 1 && /### T1\n/.test(calls[0]) && /### T2\n/.test(calls[0]) && !/### T3/.test(calls[0]), calls);
  ok('sentences as the abstract has them: pairs', JSON.stringify(tr.get(A)) === JSON.stringify([['We measure the electron density of the plasma sheath.', '译53'], ['The RCS drops by 10 dB at X band.', '译33']]), tr.get(A));
  ok('sentences the model changed: the whole abstract beside the whole translation', tr.get(B) && tr.get(B).length === 1 && tr.get(B)[0][0] === B && tr.get(B)[0][1].startsWith('译'), tr.get(B));
  await tr.want([A, B]);
  ok('translated once: not asked again, and kept on disk', calls.length === 1 && createTranslate({ dir: T, ask }).get(A).length === 2);
  broken = true;
  const C = 'A third abstract, asked for while the model is not answering at all, long enough to count.';
  await tr.want([C]); await tr.want([C]);
  ok('a failure: nothing shown, not asked again at once', tr.get(C) === null && calls.length === 2);
  broken = false;
  ok('asked for by the user: tried again', !!(await tr.one(C)) && calls.length === 3);

  // ---- the push's waiting list ----
  const day = (n) => Date.parse('2026-10-12T08:00:00') + n * 86400e3;       // (a Monday)
  let found = [];
  const mk = (title) => paper({ source: 'openalex', sid: title, title, abstract: 'About ' + title, date: /old/.test(title) ? '2011-05-01' : new Date(clock).toISOString().slice(0, 10) });
  const asked = [];                                            // the searches: [words, from, page]
  let deepHits = () => [];
  const read = [];                                             // the journal read: from which day
  const feed = createFeed({ dir: T, cfg: { daily: 2, oldDaily: 0 }, now: () => clock,
    mirror: { findDoi: () => null, findTitle: () => null, collectionByName: () => null },
    profile: { get: () => ({ follow: { venues: [{ issns: ['1'] }], keywords: ['plasma sheath'] } }), words: () => [], openQuestions: () => [] },
    gapMs: 0, sources: { crossref: { created: async (issns, from) => { read.push(from); return found; } }, openalex: { byAuthors: async () => [], citing: async () => [], search: async (w, from, page) => { asked.push([w, from, page || 1]); return from ? [] : deepHits(page || 1); }, byDoi: async () => null } },
    ask: async (prompt) => ({ items: [...prompt.matchAll(/^### (C\d+)\n题目：(.*)$/gm)].map((m) => ({ ref: m[1], score: +(/score (\d+)/.exec(m[2]) || [0, 0])[1], question: 0, why: 'w', fun: false })) }),
    cards: { find: () => null, annotationLines: () => [] } });
  const titles = (s) => feed.entries().filter((e) => e.status === s).map((e) => e.paper.title).sort();
  const skipAll = () => { for (const e of feed.entries().filter((x) => x.status === 'new')) feed.decide(e.id, 'skipped'); };
  clock = day(0); found = ['alpha score 9', 'bravo score 8', 'charlie score 8', 'delta score 7', 'echo score 7', 'foxtrot old score 7', 'golf old score 7', 'hotel score 3'].map(mk);
  const r1 = await feed.run();
  ok('a day with seven good papers: the two best shown, the other five wait (none thrown away), the poor one gone', titles('new').join() === 'alpha score 9,bravo score 8' && titles('spare').length === 5 && r1.picked === 2 && r1.waiting === 5 && !r1.held, [titles('new'), titles('spare'), r1]);
  skipAll();
  clock = day(1); found = ['india score 8', 'juliet score 5'].map(mk);
  const r2 = await feed.run();
  ok('the next day finds one good paper: it and the best of the ones waiting are shown', titles('new').join() === 'charlie score 8,india score 8' && feed.pool().length === 4 && feed.list().every((e) => e.status !== 'spare'), titles('new'));
  ok('the run says how many came from earlier days; the one from before keeps the day it was found', r2.picked === 2 && r2.held === 1 && r2.waiting === 4 && feed.entries().some((e) => e.status === 'new' && e.found === '2026-10-12' && e.date === '2026-10-13'), r2);
  skipAll();
  clock = day(2); found = [];
  const r3 = await feed.run();
  ok('a day that finds nothing: two more from the ones waiting', r3.picked === 2 && r3.held === 2 && r3.ranked === 0 && titles('new').join() === 'delta score 7,echo score 7' && titles('spare').length === 2, r3);
  skipAll();
  clock = day(14); found = ['kilo score 6'].map(mk);
  await feed.run();
  ok('one place is for what was published lately: the new 6 is shown beside the best of the 7s of 2011, the other 7 still waits', titles('new').join() === 'foxtrot old score 7,kilo score 6' && titles('spare').join() === 'golf old score 7' &&
    feed.entries().find((e) => e.paper.title === 'kilo score 6').fresh && !feed.entries().find((e) => e.paper.title === 'foxtrot old score 7').fresh, [titles('new'), titles('spare')]);
  clock = day(70); found = [];
  await feed.run();
  const back = feed.pool().filter((e) => e.lapsed).map((e) => e.paper.title).sort();
  ok('months later nothing has lapsed: the one waiting is shown; the two shown and left alone are back among the candidates, not to be pushed again', titles('new').join() === 'golf old score 7' && back.join() === 'foxtrot old score 7,kilo score 6', [titles('new'), back]);
  clock = day(71);
  const r6 = await feed.run();
  ok('the day after: nothing pushed a second time', r6.picked === 0 && feed.pool().length === 2, r6);
  const pr = feed.promote(feed.pool()[0].id);
  ok('taken into today by hand: shown again as of today, no longer marked', pr && pr.status === 'new' && pr.date === '2026-12-22' && !pr.lapsed && feed.pool().length === 1, pr);

  // ---- searches without a date; what is found and not scored ----
  const deep = asked.filter((a) => !a[1]), dated = asked.filter((a) => a[1]);
  ok('each search is asked twice a run: what came out since the last run, and of any year', dated.length === deep.length && deep.length >= 6 && deep.every((a) => a[0] === 'plasma sheath'), [dated.length, deep.length]);
  ok('the one without a date: back to page 1 as long as a page comes back short', deep.every((a) => a[2] === 1), deep.map((a) => a[2]));
  skipAll();
  const page = (p) => Array.from({ length: 25 }, (_, i) => mk('old paper p' + p + ' n' + String(i).padStart(2, '0') + ' score 2'));
  deepHits = (p) => page(p);
  clock = day(72); asked.length = 0;
  const r7 = await feed.run();
  clock = day(73);
  const r8 = await feed.run();
  ok('full pages: a page further the next day', asked.filter((a) => !a[1]).map((a) => a[2]).join() === '1,2', asked);
  ok('papers of any year are candidates now (2011 here), counted under their own way of finding', r7.sources['检索式（不限年份）'] === 25 && r7.ranked === 25 && r8.ranked === 25, [r7, r8]);
  deepHits = (p) => [...page(p), ...Array.from({ length: 20 }, (_, i) => mk('old extra p' + p + ' n' + i + ' score 2'))];
  clock = day(74);
  const r9 = await feed.run();
  ok('more found than a day scores (30): the rest waits, not lost', r9.found === 45 && r9.ranked === 30 && r9.unscored === 15 && feed.status().unscored === 15, r9);
  deepHits = () => [];
  clock = day(77);                                             // (the Monday: Saturdays are for old reports)
  const r10 = await feed.run();
  ok('the next day finds nothing new: the ones waiting are scored then', r10.found === 0 && r10.ranked === 15 && r10.unscored === 0, r10);

  // ---- a table of contents once; a phrase's own "since"; the order of scoring ----
  skipAll();
  const toc = ['toc one score 2', 'toc two score 2', 'toc three score 2'].map(mk);
  clock = day(78); found = toc; asked.length = 0;
  const r11 = await feed.run();
  clock = day(79); found = [...toc, mk('toc four score 2')];
  const r12 = await feed.run();
  ok('a journal\'s table of contents: each article taken the day it first shows, not again', r11.sources['期刊目录'] === 3 && r11.found === 3 && r11.toc === 3 && r12.sources['期刊目录'] === 1 && r12.found === 1 && r12.ranked === 1, [r11.sources, r12.sources]);
  ok('the journal is read from where it was last read (two days of overlap); the first time: two weeks back', read[0] === '2026-09-28' && read[read.length - 1] === '2026-12-27', [read[0], read[read.length - 1]]);
  clock = day(84); asked.length = 0;
  await feed.run();
  ok('a phrase\'s "since" goes back to the day it was last asked (two days before), not only to the last run', asked.filter((a) => a[1]).map((a) => a[1]).join() === '2026-12-28', asked);
  const many = [...Array.from({ length: 34 }, (_, i) => mk('A study of something else no ' + i + ' score 2')), mk('Reentry sheath attenuation score 2'), mk('Plasma instabilities score 2')];
  let order = [];
  const f2 = createFeed({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lit-unit2-')), cfg: { daily: 2, oldDaily: 0 }, now: () => clock,
    mirror: { findDoi: () => null, findTitle: () => null, collectionByName: () => null },
    profile: { get: () => ({ follow: { keywords: ['sheath'] } }), words: () => ['reentry plasma sheath', 'study of scattering'], openQuestions: () => [] },
    gapMs: 0, sources: { openalex: { byAuthors: async () => [], citing: async () => [], search: async (w, from) => (from ? many : []), byDoi: async () => null } },
    ask: async (prompt) => { order = [...prompt.matchAll(/^题目：(.*)$/gm)].map((m) => m[1]); return { items: [] }; },
    cards: { find: () => null, annotationLines: () => [] } });
  await f2.run();
  ok('which are scored first: a word of a phrase in the title counts (no phrase is there whole), a word nearly every title has counts little', order.length === 30 && order.slice(0, 2).sort().join() === 'Plasma instabilities score 2,Reentry sheath attenuation score 2' && order[0] === 'Reentry sheath attenuation score 2', order.slice(0, 4));

  // ---- a journal's contents are all read, beside the searches' share ----
  const issue = Array.from({ length: 100 }, (_, i) => mk('issue article ' + String(i).padStart(3, '0') + ' score 2'));
  deepHits = () => Array.from({ length: 25 }, (_, i) => mk('search hit ' + i + ' score 2'));
  clock = day(85); found = issue;
  const r16 = await feed.run();
  ok('a whole issue at once (100 articles): 90 of them scored that day beside the searches\' finds, the other 10 wait', r16.sources['期刊目录'] === 100 && r16.toc === 90 && r16.ranked === 90 + 25 && r16.unscored === 10, r16);
  deepHits = () => []; found = [];
  clock = day(86);
  const r17 = await feed.run();
  ok('the next day: the 10 left of the issue', r17.toc === 10 && r17.ranked === 10 && r17.unscored === 0, r17);

  // ---- the model fails: what was found is kept ----
  let down = true;
  const f3 = createFeed({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lit-unit3-')), cfg: { daily: 2, oldDaily: 0 }, now: () => clock,
    mirror: { findDoi: () => null, findTitle: () => null, collectionByName: () => null },
    profile: { get: () => ({ follow: { venues: [{ issns: ['1'] }] } }), words: () => [], openQuestions: () => [] },
    gapMs: 0, sources: { crossref: { created: async () => toc } },
    ask: async (prompt) => { if (down) throw new Error('model down'); return { items: [...prompt.matchAll(/^### (C\d+)$/gm)].map((m) => ({ ref: m[1], score: 7, question: 0, why: 'w', fun: false })) }; },
    cards: { find: () => null, annotationLines: () => [] } });
  const e1 = await f3.run().catch((e) => e.message);
  down = false;
  const r13 = await f3.run();
  ok('the scoring fails: the table of contents taken that day is not lost -- scored at the next run', e1 === 'model down' && r13.found === 0 && r13.ranked === 3 && r13.picked === 2, [e1, r13]);

  // ---- Semantic Scholar on its own clock ----
  let s2busy = true; const s2asked = [];
  const s2 = { enabled: () => true, search: async (k, y, n, off) => { s2asked.push([k, off]); if (s2busy) throw Object.assign(new Error('busy'), { status: 429 }); return [mk('s2 paper for ' + k + ' off ' + off + ' score 7')]; }, recommend: async () => [] };
  clock = Date.parse('2026-10-12T08:00:00');
  const f4 = createFeed({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lit-unit4-')), cfg: { daily: 2, oldDaily: 0 }, now: () => clock,
    mirror: { findDoi: () => null, findTitle: () => null, collectionByName: () => null },
    profile: { get: () => ({ follow: { keywords: ['alpha waves', 'beta waves', 'gamma waves'] } }), words: () => [], openQuestions: () => [] },
    sources: { s2 }, ask: async (prompt) => ({ items: [...prompt.matchAll(/^### (C\d+)$/gm)].map((m) => ({ ref: m[1], score: 7, question: 0, why: 'w', fun: false })) }),
    cards: { find: () => null, annotationLines: () => [] } });
  const r14 = await f4.run();
  ok('Semantic Scholar busy at the push: the push goes on without it and says so; asked once, not the second query too', r14.found === 0 && /Semantic Scholar/.test(r14.errors.join()) && s2asked.length === 1, [r14, s2asked]);
  clock += 3600e3; await f4.tick();
  ok('an hour later: not yet tried again', s2asked.length === 1, s2asked);
  clock += 2.1 * 3600e3; await f4.tick();
  ok('three hours later: tried again, still busy', s2asked.length === 2 && f4.status().unscored === 0, s2asked);
  s2busy = false; clock += 3.1 * 3600e3; await f4.tick();
  ok('later it answers: both of the day\'s queries asked, what they brought waits to be scored', s2asked.length === 4 && f4.status().unscored === 2, [s2asked, f4.status().unscored]);
  clock += 3.1 * 3600e3; await f4.tick();
  ok('answered once: not asked again that day', s2asked.length === 4, s2asked);
  clock = Date.parse('2026-10-13T08:00:00');
  const r15 = await f4.run();
  ok('the next push scores them, counted under their way of finding; that day\'s own queries are asked too', r15.ranked === 3 && r15.picked === 2 && r15.sources['S2 检索'] === 4 && s2asked.length === 6, [r15, s2asked.length]);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
