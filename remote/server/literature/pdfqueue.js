// The queue of papers whose PDF is to come through the library access (browser/library.js): the papers the user
// kept and the survey's, when no open-access copy was found. Paced like a person: one at a time, a pause between two
// (settings "pdfGapSec", default 90 s, plus a little at random), no more than "pdfPerDay" (30) a day.
//   <dataDir>/literature/pdf-queue.json  { items: { <zotero key>: { key, doi, url, title, site, state, why, at, tries, added } },
//                                          blocks: { <site id>: { need, msg, name, page, at } }, day, count }
// An item is waiting -> done (the PDF is in Zotero) | failed (the page offers none: not subscribed; 重试 puts it back).
// What needs the user stops a whole site, not just one paper -- a check that asks for a person ("verify"), a sign-in
// that could not be done ("signin") -- until they say 继续; the papers of other sites go on. A browser that is not
// there pauses everything and is tried again every few minutes. Nothing is retried on its own after a refusal.
'use strict';
const fs = require('fs');
const path = require('path');
const { byDoi, byId } = require('./browser/sites');

const KEEP_DONE_MS = 14 * 86400e3;
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function createPdfQueue({ dir, cfg = () => ({}), library, api, mirror, fulltext, log = () => {}, onChange = () => {}, now = () => Date.now(), tickMs = 5000 }) {
  const file = path.join(dir, 'pdf-queue.json');
  let st = { items: {}, blocks: {}, day: '', count: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  let running = '', nextAt = 0, timer = null, browser = '';
  const C = () => cfg() || {};
  const gapMs = () => Math.max(0.05, +C().pdfGapSec || 90) * 1000, perDay = () => (C().pdfPerDay != null ? +C().pdfPerDay : 30);
  const today = () => { const d = ymd(now()); if (st.day !== d) { st.day = d; st.count = 0; } return st.count; };
  const changed = () => { save(); onChange(); };

  // add(key, { doi, url, title }, { front }): a paper without a PDF; -> the item, or null (off, has one, nothing to go by)
  function add(key, p, { front = false, quiet = false } = {}) {
    if (!library.enabled() || !key || !(p.doi || p.url) || fulltext.hasPdf(key)) return null;
    const old = st.items[key];
    if (old && (old.state === 'waiting' || old.state === 'done')) return old;
    st.items[key] = { key, doi: p.doi || '', url: p.doi ? '' : p.url || '', title: String(p.title || '').slice(0, 200), site: byDoi(p.doi).id, state: 'waiting', why: '', tries: 0, added: front ? 0 : now(), at: now() };
    if (!quiet) changed();
    return st.items[key];
  }
  // every paper of the given collections without a PDF (the user's own request)
  function fill(collectionKeys) {
    let n = 0;
    for (const ck of collectionKeys) for (const it of mirror.inCollection(ck)) {
      if (!it.doi || fulltext.hasPdf(it.key) || (st.items[it.key] && st.items[it.key].state !== 'failed')) continue;
      delete st.items[it.key];
      if (add(it.key, { doi: it.doi, title: it.title }, { quiet: true })) n++;
    }
    if (n) changed();
    return n;
  }
  function retry(key) {
    const it = st.items[key];
    if (!it || it.state === 'done') return { ok: false, msg: '这篇不在等下载' };
    Object.assign(it, { state: 'waiting', why: '', tries: 0, at: now() }); nextAt = 0; changed();
    return { ok: true };
  }
  function drop(key) { if (!st.items[key] || running === key) return { ok: false }; delete st.items[key]; changed(); return { ok: true }; }
  // the paper got its PDF another way (the user uploaded one): nothing left to fetch. While it is being fetched this
  // very moment the fetch is left to end, and what it ends with is put right by settle().
  function got(key, why) { const it = st.items[key]; if (!it || running === key) return; Object.assign(it, { state: 'done', why, at: now() }); changed(); }
  // whatever the queue says of a paper, one that has a PDF is done (uploaded while it was being fetched, or added in
  // Zotero itself). -> whether anything changed
  function settle() {
    let n = 0;
    for (const it of Object.values(st.items)) if (it.state !== 'done' && it.key !== running && fulltext.hasPdf(it.key)) { Object.assign(it, { state: 'done', why: '已经有 PDF 了', at: now() }); n++; }
    if (n) save();
    return n > 0;
  }
  // the user did what a site waited for (answered its check, signed in)
  function resume(site) {
    if (site) delete st.blocks[site]; else st.blocks = {};
    browser = ''; nextAt = 0; changed();
    return { ok: true };
  }

  const next = () => Object.values(st.items).filter((it) => it.state === 'waiting' && !st.blocks[it.site]).sort((a, b) => a.added - b.added)[0] || null;

  async function one(it) {
    running = it.key; it.at = now(); onChange();
    try {
      if (fulltext.hasPdf(it.key)) { Object.assign(it, { state: 'done', why: '已经有 PDF 了' }); return; }
      if (!api.canWrite()) { browser = '要先授权写入 Zotero（文献 › 推送页上方）'; nextAt = now() + 5 * 60e3; return; }
      st.count = today() + 1;
      const got = await library.fetch({ doi: it.doi, url: it.url, title: it.title });
      it.site = got.site.id;
      const name = ((it.doi || 'paper').replace(/[^\w.-]+/g, '_')).slice(0, 80) + '.pdf';
      const att = await api.attachPdf(it.key, got.buf, { filename: name, url: it.doi ? 'https://doi.org/' + it.doi : it.url });
      fulltext.remember(att, got.buf);
      Object.assign(it, { state: 'done', why: `${got.site.name}，${(got.buf.length / 1048576).toFixed(1)} MB`, at: now() });
      log(`文献：通过图书馆通道拿到了「${it.title.slice(0, 40)}」的 PDF（${got.site.name}，${(got.buf.length / 1048576).toFixed(1)} MB）`);
      await mirror.refresh(true).catch(() => {});
    } catch (e) {
      if (e.site) it.site = e.site.id;
      if (e.need === 'browser') { st.count = Math.max(0, st.count - 1); browser = e.message; nextAt = now() + 5 * 60e3; log('文献：图书馆通道暂停：' + e.message); return; }
      if (e.need === 'verify' || e.need === 'signin') {
        const site = e.site || { id: it.site, name: byId(it.site).name };
        st.blocks[site.id] = { need: e.need, msg: e.message, name: site.name, page: e.page || '', at: now() };
        it.why = e.message;
        log(`文献：图书馆通道在 ${site.name} 停下了：${e.message}`);
        return;
      }
      it.tries++;
      if (e.final || it.tries >= 2) { it.state = 'failed'; it.why = e.message; log(`文献：图书馆通道没拿到「${it.title.slice(0, 40)}」：${e.message}`); }
      else { it.why = e.message + '（稍后再试一次）'; it.added = now(); }
    } finally {
      running = ''; it.at = now();
      settle();
      for (const [k, x] of Object.entries(st.items)) if (x.state === 'done' && now() - x.at > KEEP_DONE_MS) delete st.items[k];
      changed();
    }
  }
  async function tick() {
    if (running || !library.enabled() || now() < nextAt) return;
    const it = next();
    if (!it) return;
    if (perDay() >= 0 && today() >= perDay()) return;
    browser = '';
    await one(it);
    if (now() >= nextAt) nextAt = now() + gapMs() + Math.floor(Math.random() * Math.min(30e3, gapMs() / 3));
  }
  const start = () => { if (!timer) { timer = setInterval(() => tick().catch((e) => log('文献：图书馆通道出错：' + e.message)), tickMs); if (timer.unref) timer.unref(); } };
  const stop = () => { clearInterval(timer); timer = null; };

  // what the page shows
  function status() {
    settle();
    const items = Object.values(st.items).sort((a, b) => (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) || b.at - a.at);
    const n = (s) => items.filter((x) => x.state === s).length;
    const lim = perDay() >= 0 && today() >= perDay() && n('waiting') > 0;
    return { enabled: library.enabled(), running, waiting: n('waiting'), failed: n('failed'), done: n('done'), today: today(), perDay: perDay(), limit: lim,
      browser, nextAt: n('waiting') && !running ? nextAt : 0,
      blocks: Object.entries(st.blocks).map(([site, b]) => ({ site, ...b, waiting: items.filter((x) => x.state === 'waiting' && x.site === site).length })),
      items: items.slice(0, 80).map((x) => ({ key: x.key, title: x.title, doi: x.doi, site: byId(x.site).name, state: x.key === running ? 'running' : x.state, why: x.why, at: x.at })) };
  }
  // one line for a paper's own page: where its PDF stands
  function note(key) {
    const it = st.items[key];
    if (!it || fulltext.hasPdf(key)) return '';
    if (it.state === 'done') return '';
    if (it.state === 'failed') return '图书馆通道没拿到：' + it.why;
    const b = st.blocks[it.site];
    return b ? '图书馆通道：' + b.msg : key === running ? '正在通过图书馆通道下载…' : browser ? '图书馆通道暂停：' + browser : '排队通过图书馆通道下载';
  }
  return { add, fill, retry, drop, got, resume, status, note, tick, start, stop, has: (key) => !!st.items[key] };
}

module.exports = { createPdfQueue };
