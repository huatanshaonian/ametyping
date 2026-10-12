// 摘要对照 and the push's waiting list, with stand-ins for everything around them (no server):
//   translate.js -- pairs only when the sentences given back are the abstract's own; Chinese abstracts left alone; a
//                   failure is not asked again at once
//   feed.js      -- the good papers a day has no room for wait for good, and compete with the next day's finds by
//                   score; one place a day is for the ones found lately; a pick left alone goes back among them
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
  const mk = (title) => paper({ source: 'openalex', sid: title, title, abstract: 'About ' + title, date: new Date(clock).toISOString().slice(0, 10) });
  const feed = createFeed({ dir: T, cfg: { daily: 2, oldDaily: 0 }, now: () => clock,
    mirror: { findDoi: () => null, findTitle: () => null, collectionByName: () => null },
    profile: { get: () => ({ follow: { venues: [{ issns: ['1'] }] } }), words: () => [], openQuestions: () => [] },
    sources: { openalex: { byIssn: async () => found, byAuthors: async () => [], citing: async () => [], search: async () => [], byDoi: async () => null } },
    ask: async (prompt) => ({ items: [...prompt.matchAll(/^### (C\d+)\n题目：(.*)$/gm)].map((m) => ({ ref: m[1], score: +(/score (\d+)/.exec(m[2]) || [0, 0])[1], question: 0, why: 'w', fun: false })) }),
    cards: { find: () => null, annotationLines: () => [] } });
  const titles = (s) => feed.entries().filter((e) => e.status === s).map((e) => e.paper.title).sort();
  const skipAll = () => { for (const e of feed.entries().filter((x) => x.status === 'new')) feed.decide(e.id, 'skipped'); };
  clock = day(0); found = ['alpha score 9', 'bravo score 8', 'charlie score 8', 'delta score 7', 'echo score 7', 'foxtrot score 7', 'golf score 7', 'hotel score 3'].map(mk);
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
  ok('one place is for what was found lately: the new 6 is shown beside the best of the old 7s, the other 7 still waits', titles('new').join() === 'foxtrot score 7,kilo score 6' && titles('spare').join() === 'golf score 7' &&
    feed.entries().find((e) => e.paper.title === 'kilo score 6').fresh && !feed.entries().find((e) => e.paper.title === 'foxtrot score 7').fresh, [titles('new'), titles('spare')]);
  clock = day(70); found = [];
  await feed.run();
  const back = feed.pool().filter((e) => e.lapsed).map((e) => e.paper.title).sort();
  ok('months later nothing has lapsed: the one waiting is shown; the two shown and left alone are back among the candidates, not to be pushed again', titles('new').join() === 'golf score 7' && back.join() === 'foxtrot score 7,kilo score 6', [titles('new'), back]);
  clock = day(71);
  const r6 = await feed.run();
  ok('the day after: nothing pushed a second time', r6.picked === 0 && feed.pool().length === 2, r6);
  const pr = feed.promote(feed.pool()[0].id);
  ok('taken into today by hand: shown again as of today, no longer marked', pr && pr.status === 'new' && pr.date === '2026-12-22' && !pr.lapsed && feed.pool().length === 1, pr);

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
