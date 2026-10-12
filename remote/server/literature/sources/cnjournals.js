// The Chinese journals that neither Crossref nor OpenAlex lists (their DOIs are registered in China): the current
// contents as their own websites show them -- public pages, no sign-in. CNKI is not asked: it answers a first visit
// with a puzzle to solve. A journal is known by its ISSN or its name; its page is read for the links that carry a DOI
// and a title (the same on the three sites, whatever their markup), so a change of layout does little harm.
'use strict';
const { paper } = require('./normalize');

const JOURNALS = [
  { name: '航空学报', issn: '1000-6893', url: 'https://hkxb.buaa.edu.cn/CN/1000-6893/current.shtml' },
  { name: '空气动力学学报', issn: '0258-1825', url: 'http://kqdlxxb.xml-journal.net/cn/article/current' },
  { name: '电波科学学报', issn: '1005-0388', url: 'http://www.cjors.cn/' },           // (its front page: online first and the current issue)
];

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function decode(buf) {
  const t = buf.toString('utf8');
  if (!/charset=["']?gb/i.test(t.slice(0, 3000))) return t;
  try { return new TextDecoder('gb18030').decode(buf); } catch { return t; }
}
// the articles of a contents page: [{ doi, title, url }] -- the first link of each DOI whose text is a title (not the
// DOI itself, not "摘要" / "PDF" / "HTML全文")
function articles(html, base) {
  const seen = new Map();
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']*?(10\.\d{4,5}\/[^"'?#\s]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = strip(m[3]), doi = m[2];
    if (title.length < 6 || /^10\.\d/.test(title) || /^(摘要|HTML|PDF|全文|Abstract)/i.test(title) || seen.has(doi)) continue;
    let url = ''; try { url = new URL(m[1].split('#')[0], base).href; } catch {}
    if (/(^|\.)doi\.org$/.test((() => { try { return new URL(url).host; } catch { return ''; } })())) url = '';
    seen.set(doi, { doi, title, url });
  }
  return [...seen.values()];
}

function createCnJournals({ http, journals = JOURNALS }) {
  // the journal of a followed venue ({ name, issns }), or null
  const of = (v) => journals.find((j) => (v.issns || []).includes(j.issn) || String(v.name || '').trim() === j.name) || null;
  async function toc(j) {
    const r = await http.get(j.url);
    if (r.status !== 200) throw new Error(`${j.name} 的网站返回 ${r.status}`);
    const list = articles(decode(r.body), j.url);
    if (!list.length) throw new Error(`${j.name} 的目录页上没有读到文章（网站可能改版了）`);
    return list.map((a) => paper({ source: 'cn', doi: a.doi, title: a.title, venue: j.name, url: a.url || undefined, issn: j.issn }));
  }
  return { of, toc };
}

module.exports = { createCnJournals, articles, JOURNALS };
