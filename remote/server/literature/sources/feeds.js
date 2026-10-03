// The other places new papers come from:
//   Crossref   by journal ISSN, the quickest to list a new paper (abstracts for some publishers)
//   arXiv      by category (+ optional words), through its API (Atom); at most one request every 3 seconds
//   AIAA ARC   a journal's table-of-contents RSS (no abstracts -- OpenAlex fills them in later)
//   NTRS       NASA's technical reports, by search words (through the proxy: NTRS refuses mainland addresses);
//              most come with a public PDF and a ready-made text file
//   Unpaywall  an open-access PDF for a DOI (needs an e-mail address: only when "mailto" is set)
'use strict';
const { paper, lastFirst, clean } = require('./normalize');

const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function createCrossref({ http, base = 'https://api.crossref.org', mailto = '' }) {
  return {
    async byIssn(issn, from, rows = 40) {
      const s = new URLSearchParams({ filter: `issn:${issn},from-pub-date:${from}`, sort: 'published', order: 'desc', rows: String(rows), ...(mailto ? { mailto } : {}) });
      const j = await http.json(`${base}/works?${s}`);
      return ((j.message && j.message.items) || []).map((w) => {
        const dp = ((w.published || w['published-online'] || w['published-print'] || w.issued || {})['date-parts'] || [[]])[0];
        return paper({ source: 'crossref', doi: w.DOI, title: (w.title || [])[0], authors: (w.author || []).map((a) => [a.family, a.given].filter(Boolean).join(', ')),
          venue: (w['container-title'] || [])[0], year: dp[0], date: dp[0] ? `${dp[0]}-${String(dp[1] || 1).padStart(2, '0')}-${String(dp[2] || 1).padStart(2, '0')}` : '',
          abstract: w.abstract || '', type: w.type === 'proceedings-article' ? 'conferencePaper' : 'journalArticle', issn });
      });
    },
  };
}

function createArxiv({ http, base = 'https://export.arxiv.org' }) {
  let last = 0;
  const gap = async () => { const w = last + 3100 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); last = Date.now(); };
  return {
    // cats: ['physics.plasm-ph', ...]; words: optional, all must be in the abstract or title
    async recent(cats, words = '', max = 40) {
      if (!cats.length) return [];
      await gap();
      const cat = cats.map((c) => `cat:${c}`).join(' OR ');
      const w = String(words || '').trim();
      const query = w ? `(${cat}) AND (${w.split(/\s+/).map((x) => `all:${x}`).join(' AND ')})` : cat;
      const s = new URLSearchParams({ search_query: query, sortBy: 'submittedDate', sortOrder: 'descending', max_results: String(max) });
      const r = await http.get(`${base}/api/query?${s}`);
      if (r.status !== 200) throw new Error('arXiv 返回 ' + r.status);
      return r.body.toString('utf8').split('<entry>').slice(1).map((e) => {
        const id = (tag(e, 'id').split('/abs/')[1] || '').replace(/v\d+$/, '');
        return paper({ source: 'arxiv', sid: id, arxiv: id, doi: tag(e, 'arxiv:doi'), title: decode(tag(e, 'title')), authors: tags(e, 'name').map((n) => lastFirst(decode(n))),
          venue: 'arXiv', date: tag(e, 'published'), abstract: decode(tag(e, 'summary')), url: `https://arxiv.org/abs/${id}`, pdf: `https://arxiv.org/pdf/${id}`, type: 'preprint' });
      }).filter((p) => p.arxiv);
    },
  };
}

// AIAA journals by their code: aiaaj (AIAA Journal), jsr (Spacecraft and Rockets), ja (Aircraft), jtht (Thermophysics and
// Heat Transfer), jgcd, jpp, jais ...
function createAiaa({ http, base = 'https://arc.aiaa.org' }) {
  return {
    async toc(code) {
      const r = await http.get(`${base}/action/showFeed?type=etoc&feed=rss&jc=${encodeURIComponent(code)}`);
      if (r.status !== 200) throw new Error(`AIAA ${code} 返回 ${r.status}`);
      const xml = r.body.toString('utf8');
      const journal = decode(tag(tag(xml, 'channel'), 'title')).replace(/^.*?:\s*/, '') || code;
      return xml.split(/<item[\s>]/).slice(1).map((e) => {
        const doi = decode(tag(e, 'prism:doi') || tag(e, 'dc:identifier')).replace(/^doi:/i, '');
        return paper({ source: 'aiaa', doi, title: decode(tag(e, 'title')), authors: tags(e, 'dc:creator').map((n) => lastFirst(decode(n))), venue: journal,
          date: tag(e, 'dc:date') || tag(e, 'prism:coverDate'), abstract: clean(decode(tag(e, 'description'))).length > 200 ? decode(tag(e, 'description')) : '', url: decode(tag(e, 'link')) });
      }).filter((p) => p.title);
    },
  };
}

function createNtrs({ http, base = 'https://ntrs.nasa.gov' }) {
  const fromResult = (x) => {
    const dl = (x.downloads || []).find((d) => d.links && d.links.pdf) || {};
    const date = ((x.publications || [])[0] || {}).publicationDate || x.submittedDate || '';
    const num = (x.otherReportNumbers || []).find((s) => !/^Report Number:/.test(s)) || '';
    const p = paper({ source: 'ntrs', sid: String(x.id), ntrs: String(x.id), title: x.title, authors: (x.authorAffiliations || []).map((a) => a.meta && a.meta.author && a.meta.author.name).filter(Boolean),
      venue: (x.center && x.center.name) || 'NASA', date, abstract: x.abstract || '', url: `${base}/citations/${x.id}`, type: 'report', number: num,
      pdf: dl.links && dl.links.pdf ? base + dl.links.pdf : '' });
    // (NTRS's own text of the report: an old scan's OCR, used when no better text is there)
    if (dl.links && dl.links.fulltext) p.ntrsText = base + dl.links.fulltext;
    return p;
  };
  return {
    async search(words, size = 25) {
      const s = new URLSearchParams({ q: words, 'page.size': String(size) });
      const j = await http.json(`${base}/api/citations/search?${s}`);
      return (j.results || []).filter((x) => x.distribution === 'PUBLIC' || !x.distribution).map(fromResult);
    },
  };
}

function createUnpaywall({ http, base = 'https://api.unpaywall.org', mailto = '' }) {
  return {
    enabled: () => !!mailto,
    async pdfFor(doi) {
      if (!mailto || !doi) return '';
      try { const j = await http.json(`${base}/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mailto)}`);
        const l = j.best_oa_location || {}; return l.url_for_pdf || ''; } catch { return ''; }
    },
  };
}

module.exports = { createCrossref, createArxiv, createAiaa, createNtrs, createUnpaywall };
