// 控制面板 › 文献: what the user sets for the literature module without touching config.json -- the API keys
// (Semantic Scholar, OpenAlex), the contact address sent to Crossref / OpenAlex / Unpaywall, and the daily push.
//   <dataDir>/literature/settings.json  (0600)  { keys: { s2, openalex }, mailto, daily, at, minScore, searchesPerDay,
//                                                 reviewCollection, inboxCollection, surveyCollection, s2Recommend, oldDaily,
//                                                 visionMaxPages, browserPort, pdfGapSec, pdfPerDay, ieeeAccount, ieeeIdp }
// What is set here wins over config.json's "literature"; what is not set falls back to it. Changes apply at once (the
// sources read the keys on every call; the push reads its numbers on every run). Keys never go back to the page whole:
// only whether one is set and its last four characters.
'use strict';
const fs = require('fs');
const path = require('path');

const MAIL = /^[^\s@<>()"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const KEY = /^[\x21-\x7e]{8,200}$/;
const NUM = { daily: [0, 5], minScore: [1, 10], searchesPerDay: [1, 10], oldDaily: [0, 3], visionMaxPages: [0, 200], browserPort: [0, 65535], pdfGapSec: [20, 3600], pdfPerDay: [0, 200] };
// IEEE's institutional sign-in for members of CAS institutes / UCAS (中国科技云通行证)
const IDP = 'https://passport.escience.cn/idp/shibboleth';

function createSettings({ dir, cfg = {} }) {
  const file = path.join(dir, 'settings.json');
  let st = { keys: {} };
  try { st = { keys: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const listeners = new Set();

  // the value in effect: set here, else config.json's, else the default
  const keyOf = (k) => st.keys[k] || (k === 's2' ? cfg.s2Key || cfg.semanticScholarKey : k === 'openalex' ? cfg.openalexKey : '') || '';
  const mailto = () => st.mailto != null ? st.mailto : cfg.mailto || '';
  function feed() {
    const pick = (k, d) => (st[k] != null && st[k] !== '' ? st[k] : cfg[k] != null ? cfg[k] : d);
    return { daily: +pick('daily', 2), oldDaily: +pick('oldDaily', 1), at: String(pick('at', '07:30')), minScore: +pick('minScore', 6), searchesPerDay: +pick('searchesPerDay', 4),
      reviewCollection: String(pick('reviewCollection', '气动隐身')), inboxCollection: String(pick('inboxCollection', '每日文献')), surveyCollection: String(pick('surveyCollection', '调研工作')), s2Recommend: pick('s2Recommend', true) !== false,
      visionMaxPages: +pick('visionMaxPages', 30),
      // 图书馆通道 (browser/library.js): the DevTools port of the browser signed in to the library (0 = off)
      browserPort: +pick('browserPort', 0), pdfGapSec: +pick('pdfGapSec', 90), pdfPerDay: +pick('pdfPerDay', 30), ieeeAccount: String(pick('ieeeAccount', '')), ieeeIdp: String(pick('ieeeIdp', IDP)) };
  }
  // what the page shows: whether a key is set (and its end), never the key
  function view() {
    const k = (name) => { const v = keyOf(name); return { set: !!v, tail: v ? v.slice(-4) : '', fromConfig: !!v && !st.keys[name] }; };
    return { keys: { s2: k('s2'), openalex: k('openalex') }, mailto: mailto(), ...feed() };
  }
  // d: { keys?: { s2?: string | null, openalex?: string | null } (null / '' clears), mailto?, daily?, at?, minScore?, ... }
  function set(d) {
    const errs = [];
    if (d.keys && typeof d.keys === 'object') for (const name of ['s2', 'openalex']) {
      if (!(name in d.keys)) continue;
      const v = d.keys[name] == null ? '' : String(d.keys[name]).trim();
      if (!v) delete st.keys[name];
      else if (KEY.test(v)) st.keys[name] = v; else errs.push(`${name === 's2' ? 'Semantic Scholar' : 'OpenAlex'} 的 key 格式不对`);
    }
    if (typeof d.mailto === 'string') { const m = d.mailto.trim(); if (!m || MAIL.test(m)) st.mailto = m; else errs.push('联系邮箱格式不对'); }
    for (const [k, [lo, hi]] of Object.entries(NUM)) if (d[k] != null && d[k] !== '') { const n = Math.round(+d[k]); if (n >= lo && n <= hi) st[k] = n; else errs.push(`${k} 要在 ${lo}～${hi} 之间`); }
    if (typeof d.at === 'string') { if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(d.at.trim())) st.at = d.at.trim(); else errs.push('推送时间要写成 07:30 这样'); }
    for (const k of ['reviewCollection', 'inboxCollection', 'surveyCollection']) if (typeof d[k] === 'string' && d[k].trim()) st[k] = d[k].trim().slice(0, 60);
    if (typeof d.s2Recommend === 'boolean') st.s2Recommend = d.s2Recommend;
    if (typeof d.ieeeAccount === 'string') { const m = d.ieeeAccount.trim(); if (!m || MAIL.test(m)) st.ieeeAccount = m; else errs.push('IEEE 机构登录的账号要写成邮箱'); }
    if (typeof d.ieeeIdp === 'string') { const u = d.ieeeIdp.trim(); if (!u) delete st.ieeeIdp; else if (/^https:\/\/[\w.-]+\/[\w.\/-]*$/.test(u) && u.length < 200) st.ieeeIdp = u; else errs.push('机构登录的地址格式不对'); }
    save();
    for (const fn of listeners) try { fn(); } catch {}
    return errs.length ? { ok: false, msg: errs.join('；'), ...view() } : { ok: true, ...view() };
  }
  return { keyOf, mailto, feed, view, set, onChange: (fn) => listeners.add(fn) };
}

module.exports = { createSettings };
