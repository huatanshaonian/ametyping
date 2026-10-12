// Abstracts the indexes do not have (IEEE and Elsevier deposit none at Crossref; the Chinese journals' sites list
// titles only): read off the article's own page in the browser of the library access (browser/library.js: abstract),
// for the candidates waiting to be scored (feed.js: wantAbstract / gotAbstract) -- the journals' contents first. An
// abstract is public; the browser is used because the publishers answer a plain request with a script to run.
// Paced like a reader: one page at a time, a pause between two, a cap a day; the PDF queue goes first (the browser does
// one thing at a time). A page that asks for a person is never answered: that publisher is left alone until tomorrow,
// and its articles are scored by their titles when they have waited long enough (feed.js).
'use strict';
const { byDoi } = require('./browser/sites');

const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function createAbsJob({ feed, library, idle = () => true, log = () => {}, now = () => Date.now(), tickMs = 5000, gapMs = 8000, perDay = 200 }) {
  let timer = null, running = false, nextAt = 0, day = '', count = 0, got = 0;
  const off = new Map();                                       // publisher -> the day it asked for a person
  const siteOf = (c) => (c.doi ? byDoi(c.doi).id : '') || (() => { try { return new URL(c.url).host; } catch { return ''; } })();

  async function tick() {
    if (running || !library.enabled() || library.busy() || !idle() || now() < nextAt) return;
    const today = ymd(now());
    if (day !== today) { day = today; count = 0; got = 0; }
    if (count >= perDay) return;
    const c = feed.wantAbstract((x) => off.get(siteOf(x)) === today);
    if (!c) return;
    running = true; count++;
    try {
      const r = await library.abstract({ doi: c.doi, url: c.url });
      feed.gotAbstract(c, r.abs);
      if (r.abs) got++;
    } catch (e) {
      if (e.need === 'browser') { count--; nextAt = now() + 5 * 60e3; return; }
      if (e.need === 'verify') { off.set((e.site && e.site.id) || siteOf(c), today); log(`文献：${(e.site && e.site.name) || '出版社'} 要做人机验证，今天不再去它那里读摘要（不影响别的；这些文章过一天按题目打分）`); return; }
      if (/正忙/.test(e.message)) { count--; return; }
      feed.gotAbstract(c, '');                                 // (the page did not open, or shows none: not asked again)
    } finally {
      running = false;
      if (now() >= nextAt) nextAt = now() + gapMs + Math.floor(Math.random() * gapMs / 2);
    }
  }
  const start = () => { if (!timer) { timer = setInterval(() => tick().catch((e) => log('文献：读摘要出错：' + e.message)), tickMs); if (timer.unref) timer.unref(); } };
  const stop = () => { clearInterval(timer); timer = null; };
  return { tick, start, stop, status: () => ({ day, tried: count, got, off: [...off].filter(([, d]) => d === ymd(now())).map(([s]) => s) }) };
}

module.exports = { createAbsJob };
