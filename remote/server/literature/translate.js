// 摘要对照: the abstracts of the day's picks (and, when asked, of a paper of the library) in Chinese, sentence by
// sentence beside the original. Kept by the text itself (a hash), so the same abstract is translated once wherever it
// shows. A few at a time in one call, in the background; a failure is left alone for some hours.
//   <dataDir>/literature/translations.json  { done: { id: { segs: [[src, zh], ...], at } }, failed: { id: t } }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TRANSLATE_SCHEMA, translatePrompt } = require('./prompts/translate');

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const bare = (s) => String(s || '').replace(/\s+/g, '');
const idOf = (text) => crypto.createHash('sha1').update(norm(text)).digest('hex').slice(0, 20);
// worth translating: long enough to be an abstract, and not Chinese already
function foreign(text) {
  const s = norm(text);
  return s.length >= 40 && (s.match(/[一-鿿]/g) || []).length / s.length < 0.3;
}

function createTranslate({ dir, ask, field = () => '', log = () => {}, onChange = () => {}, now = () => Date.now(), batch = 6, retryMs = 6 * 3600e3, maxChars = 6000 }) {
  const file = path.join(dir, 'translations.json');
  let st = { done: {}, failed: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
  const waiting = new Map();                                   // id -> text
  let running = null;

  // the pairs of a text translated before: [[src, zh], ...], or null
  const get = (text) => (text && st.done[idOf(text)] || {}).segs || null;

  // the model's sentences are the abstract's own (nothing changed, nothing left out): pairs; otherwise the whole
  // abstract beside the whole translation
  function pairs(text, segs) {
    const list = (Array.isArray(segs) ? segs : []).map((s) => [norm(s && s.src), norm(s && s.zh)]).filter((s) => s[0] || s[1]);
    const zh = list.map((s) => s[1]).filter(Boolean);
    if (!zh.length) return null;
    return list.every((s) => s[0] && s[1]) && bare(list.map((s) => s[0]).join('')) === bare(text) ? list : [[norm(text), zh.join('')]];
  }
  async function loop() {
    while (waiting.size) {
      const part = [...waiting].slice(0, batch).map(([id, text], i) => ({ id, text, ref: 'T' + (i + 1) }));
      for (const p of part) waiting.delete(p.id);
      let by = new Map();
      try {
        const a = await ask(translatePrompt(part.map((p) => ({ ref: p.ref, text: p.text })), norm(field()).slice(0, 300)), TRANSLATE_SCHEMA);
        by = new Map(((a && a.items) || []).map((x) => [String(x.ref).replace(/[^\dT]/gi, '').toUpperCase(), x.segs]));
      } catch (e) { log('文献：摘要翻译失败：' + e.message); }
      for (const p of part) {
        const segs = pairs(p.text, by.get(p.ref));
        if (segs) { st.done[p.id] = { segs, at: now() }; delete st.failed[p.id]; } else st.failed[p.id] = now();
      }
      save(); onChange();
    }
  }
  // texts to translate in the background (the ones not done, not Chinese, not just failed); force: try a failed one again
  function want(texts, { force = false } = {}) {
    for (const t of texts || []) {
      if (!foreign(t)) continue;
      const id = idOf(t);
      if (st.done[id] || waiting.has(id) || (!force && now() - (st.failed[id] || 0) < retryMs)) continue;
      waiting.set(id, norm(t).slice(0, maxChars));
    }
    if (waiting.size && !running) running = loop().catch((e) => log('文献：摘要翻译出错：' + e.message)).finally(() => { running = null; });
    return running || Promise.resolve();
  }
  // one text, now: its pairs, or null when it could not be translated
  async function one(text) {
    if (!get(text)) { await want([text], { force: true }); if (running) await running; }
    return get(text);
  }
  return { get, want, one, foreign, busy: () => !!running };
}

module.exports = { createTranslate, foreign };
