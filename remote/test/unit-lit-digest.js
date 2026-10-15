// 长报告 (digest.js), with a stand-in for the model (no server):
//   a paper within the limit goes whole; a longer one is cut at page boundaries into parts, each summed up with the page
//   just before and after it along (marked 衔接用), and the deep card reads the parts' notes in order; a CJK character
//   counts three times; the notes are kept: made again, nothing is asked, and a part whose page changed (read as an
//   image since) is the only one summed up again; the deep card's prompt says it reads notes, not the text
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDigest, split, size } = require('../server/literature/digest');
const { deepPrompt } = require('../server/literature/prompts/card');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600)); } };
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-digest-'));

(async () => {
  ok('size: a CJK character counts three Latin ones', size('abc') === 3 && size('鞘套') === 6 && size('a鞘') === 4);
  ok('split at page boundaries, each part up to the size (a page too big for one is a part of its own)',
    JSON.stringify(split(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(150), 'e'.repeat(10)], 100)) === '[[0,1],[2,2],[3,3],[4,4]]', split(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(150), 'e'.repeat(10)], 100));

  const asked = [];
  const ask = async (prompt) => { asked.push(prompt); const m = /这是第 (\d+) 段：第 (\d+)～(\d+) 页/.exec(prompt); return { notes: `第 ${m[1]} 段的笔记：式 $E=mc^2$ [p.${m[2]}]` }; };
  const d = createDigest({ dir: T, ask, limit: 1000, part: 400 });
  const it = { key: 'AAAAAAA1', title: 'A long report', year: '1963' };

  const short = await d.forCard(it, { md5: 'm1', pages: ['p one', 'p two'] });
  ok('within the limit: the whole text, every page with its number, nothing asked', !short.digest && short.pages.length === 2 && short.pages[1].page === 2 && short.pages[1].text === 'p two' && !asked.length, short);

  const pages = Array.from({ length: 10 }, (_, i) => `page ${i + 1} ` + 'x'.repeat(140));       // 150 each: 1500 in all
  const long = await d.forCard(it, { md5: 'm2', pages });
  ok('over the limit: parts of up to 400 (two pages each), each summed up, in order', long.digest && long.digest.length === 5 && asked.length === 5 &&
    long.digest.map((x) => `${x.from}-${x.to}`).join() === '1-2,3-4,5-6,7-8,9-10' && /^第 1 段的笔记/.test(long.digest[0].notes) && /^第 5 段的笔记/.test(long.digest[4].notes), long.digest);
  const p2 = asked.find((p) => /这是第 2 段/.test(p));
  ok('a part goes with the page before and after it, marked 衔接用, its own pages under their numbers', /共 10 页/.test(p2) && /衔接用：上一段的最后一页\n\[p\.2\]\npage 2 /.test(p2) &&
    /衔接用：下一段的第一页\n\[p\.5\]\npage 5 /.test(p2) && /### 第 3～4 页\n\[p\.3\]\npage 3 /.test(p2) && /不要为它们单独写笔记/.test(p2), p2.slice(0, 900));
  const p1 = asked.find((p) => /这是第 1 段/.test(p)), p5 = asked.find((p) => /这是第 5 段/.test(p));
  ok('the first part has nothing before it, the last nothing after', !/上一段/.test(p1) && /下一段的第一页\n\[p\.3\]/.test(p1) && /上一段的最后一页\n\[p\.8\]/.test(p5) && !/下一段/.test(p5));
  ok('the formulas, numbers and figures are asked to be kept, every point with its page', /公式照原文写成 LaTeX/.test(p1) && /不要省略数字/.test(p1) && /\[p\.N\]/.test(p1));

  asked.length = 0;
  const again = await d.forCard(it, { md5: 'm2', pages });
  ok('made again: the notes are kept, nothing asked', again.digest.length === 5 && !asked.length);
  const changed = pages.slice(); changed[5] = 'page 6 read as an image ' + 'y'.repeat(120);
  const after = await d.forCard(it, { md5: 'm2', pages: changed });
  ok('page 6 changed (read as an image): only the part that holds it (5-6) and the one that has it alongside (7-8) are summed up again', asked.length === 2 &&
    asked.map((p) => /这是第 (\d) 段/.exec(p)[1]).sort().join() === '3,4' && after.digest.length === 5, asked.map((p) => /这是第 (\d) 段/.exec(p)[1]));

  const cjk = await createDigest({ dir: T, ask, limit: 1000, part: 400 }).forCard(it, { md5: 'm3', pages: ['鞘'.repeat(200), '套'.repeat(200)] });
  ok('Chinese counts more: 400 characters are over a limit of 1000', !!cjk.digest && cjk.digest.length === 2, cjk);

  let failing = false;
  const bad = createDigest({ dir: T, ask: async () => (failing ? { notes: '' } : { notes: 'x' }), limit: 100, part: 100 });
  failing = true;
  let err = '';
  try { await bad.forCard(it, { md5: 'm4', pages: ['a'.repeat(90), 'b'.repeat(90)] }); } catch (e) { err = e.message; }
  ok('a part that comes back empty fails the card (and is not kept)', /没有总结出来/.test(err) && !fs.readFileSync(path.join(T, 'digest', 'm4.json'), { flag: 'a+' }).length, err);

  const prompt = deepPrompt({}, { title: 'A long report', creators: [] }, [], [], '', [], { n: 10, digest: long.digest }, []);
  ok('the deep card reads the notes in order, told it has notes not the text, to keep to them', /分成 5 段，每段先整理成了详细的阅读笔记/.test(prompt) && /### 第 1～2 页的笔记\n第 1 段的笔记/.test(prompt) &&
    prompt.indexOf('第 1～2 页的笔记') < prompt.indexOf('第 9～10 页的笔记') && !/正文（标了页码）/.test(prompt) && /只依据上面的笔记/.test(prompt));
  const whole = deepPrompt({}, { title: 'A short one', creators: [] }, short.pages, [], '', [], {}, []);
  ok('a paper given whole: its pages as before', /正文（标了页码）：\n\[p\.1\]\np one/.test(whole) && !/阅读笔记/.test(whole));

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
