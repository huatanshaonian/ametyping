// 长报告: what a deep card is written from. A paper of up to LIMIT (counted as below) goes to the model whole. A longer
// one is cut, at page boundaries, into parts of about PART each; every part is turned into detailed notes by the model
// (prompts/digest.js) with the page just before and just after it along for context -- so that a derivation or a table
// running over a page break is not cut -- and the deep card is written from all the parts' notes in order.
// Size is counted in Latin characters: a CJK character counts as CJK_W of them (it costs about that much more of the
// model's input), so the limits mean about the same amount of input for a Chinese report as for an English one.
// The notes are kept per part, by the hash of the part's text (with the pages read as images in their place): a deep
// card made again does not ask for them again, and only a part whose text changed -- pages of it read as images since
// -- is summed up again.
//   <dataDir>/literature/digest/<md5>.json   { parts: { <hash>: { from, to, notes, at } } }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIGEST_SCHEMA, digestPrompt } = require('./prompts/digest');

const LIMIT = 250000, PART = 100000, CJK_W = 3, PARALLEL = 2;
const CJK = /[　-鿿가-힯豈-﫿＀-￯]/g;
const size = (s) => { s = String(s || ''); return s.length + (s.match(CJK) || []).length * (CJK_W - 1); };

// pages -> [[first index, last index], ...]: consecutive pages up to `part` each (a page bigger than that on its own)
function split(pages, part = PART) {
  const out = [];
  let a = 0, used = 0;
  pages.forEach((t, i) => {
    const s = size(t);
    if (i > a && used + s > part) { out.push([a, i - 1]); a = i; used = 0; }
    used += s;
  });
  if (pages.length) out.push([a, pages.length - 1]);
  return out;
}

// ask(prompt, schema): the model the parts are summed up with
function createDigest({ dir, ask, log = () => {}, limit = LIMIT, part = PART }) {
  const ddir = path.join(dir, 'digest');
  fs.mkdirSync(ddir, { recursive: true });
  const fileOf = (md5) => path.join(ddir, md5 + '.json');
  const load = (md5) => { try { return { parts: {}, ...JSON.parse(fs.readFileSync(fileOf(md5), 'utf8')) }; } catch { return { parts: {} }; } };
  const running = new Map();                           // `${md5}/${hash}` -> promise of the notes

  // what the deep card reads: { pages } (the whole text) or { digest: [{ from, to, notes }] } (the parts' notes)
  async function forCard(it, ft) {
    const pages = ft.pages || [], label = (i) => (ft.labels ? ft.labels[i] : i + 1);
    const whole = () => ({ pages: pages.map((text, i) => ({ page: label(i), text })) });
    if (pages.reduce((n, t) => n + size(t), 0) <= limit) return whole();
    const parts = split(pages, part), md5 = ft.md5 || 'nomd5';
    const one = async ([a, b], k) => {
      const own = pages.slice(a, b + 1).map((text, j) => ({ page: label(a + j), text }));
      const before = a > 0 ? { page: label(a - 1), text: pages[a - 1] } : null, after = b + 1 < pages.length ? { page: label(b + 1), text: pages[b + 1] } : null;
      const hash = crypto.createHash('sha1').update(JSON.stringify([own, before, after])).digest('hex').slice(0, 16);
      const got = load(md5).parts[hash];
      if (got) return got;
      const id = md5 + '/' + hash;
      if (!running.has(id)) running.set(id, (async () => {
        const r = await ask(digestPrompt(it, { i: k + 1, of: parts.length, from: label(a), to: label(b) }, ft.visionN || pages.length, own, before, after), DIGEST_SCHEMA);
        const notes = String((r && r.notes) || '').trim();
        if (!notes) throw new Error(`第 ${label(a)}～${label(b)} 页没有总结出来`);
        const v = load(md5);
        v.parts[hash] = { from: label(a), to: label(b), notes, at: Date.now() };
        fs.writeFileSync(fileOf(md5) + '.tmp', JSON.stringify(v)); fs.renameSync(fileOf(md5) + '.tmp', fileOf(md5));
        return v.parts[hash];
      })().finally(() => running.delete(id)));
      return running.get(id);
    };
    const out = new Array(parts.length);
    let next = 0;
    const worker = async () => { while (next < parts.length) { const k = next++; out[k] = await one(parts[k], k); } };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, parts.length) }, worker));
    log(`文献：${it.key} 太长（${pages.length} 页），按 ${parts.length} 段总结后写深读卡`);
    return { digest: out.map(({ from, to, notes }) => ({ from, to, notes })) };
  }

  return { forCard };
}

module.exports = { createDigest, split, size, LIMIT, PART };
