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
  const M = () => (typeof mailto === 'function' ? mailto() : mailto) || '';
  return {
    async byIssn(issn, from, rows = 40) {
      const s = new URLSearchParams({ filter: `issn:${issn},from-pub-date:${from}`, sort: 'published', order: 'desc', rows: String(rows), ...(M() ? { mailto: M() } : {}) });
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
    // cats: ['physics.plasm-ph', ...]; phrases: optional -- only papers with one of them in the title or abstract
    async recent(cats, phrases = [], max = 40) {
      if (!cats.length) return [];
      await gap();
      const cat = cats.map((c) => `cat:${c}`).join(' OR ');
      const ps = (Array.isArray(phrases) ? phrases : [phrases]).map((p) => String(p).replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);
      const any = ps.map((p) => (/\s/.test(p) ? `ti:"${p}" OR abs:"${p}"` : `ti:${p} OR abs:${p}`)).join(' OR ');
      const query = any ? `(${cat}) AND (${any})` : cat;
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
    // one page of results (from: the offset), and how many there are in all
    async page(words, size = 10, from = 0) {
      const s = new URLSearchParams({ q: words, 'page.size': String(size), 'page.from': String(from) });
      const j = await http.json(`${base}/api/citations/search?${s}`);
      return { items: (j.results || []).filter((x) => x.distribution === 'PUBLIC' || !x.distribution).map(fromResult), total: +((j.stats || {}).total) || 0 };
    },
    async search(words, size = 25) { return (await this.page(words, size, 0)).items; },
  };
}

// DTIC's technical reports. DTIC's own public search is offline (since 2026-08; discover.dtic.mil says it will be back),
// and its report pages answer 403 from here; what can be searched is Internet Archive's copy of DTIC ("dticarchive",
// ~585k reports -- not all of them): title, date, abstract, authors and the issuing body (in its subject), the PDF and
// its OCR text. A report's PDF is tried at DTIC first (apps.dtic.mil, the official copy, when it answers), then at the
// Internet Archive. Through the proxy (archive.org and dtic.mil are not reachable directly from here).
function createDtic({ http, base = 'https://archive.org', dticBase = 'https://apps.dtic.mil' }) {
  const fromDoc = (d) => {
    const ad = String(d.identifier || '').replace(/^DTIC_/, '');
    const subj = (Array.isArray(d.subject) ? d.subject : String(d.subject || '').split(';')).map((s) => String(s).trim()).filter((s) => s && s !== 'DTIC Archive');
    // the subject list holds the authors ("Papa, Robert J"), the issuing body (CAPITALS), and the keywords ("*PLASMA SHEATHS")
    const authors = subj.filter((s) => /,/.test(s) && /[a-z]/.test(s) && !s.startsWith('*')).slice(0, 8);
    const org = subj.find((s) => !s.includes('*') && s === s.toUpperCase() && /[A-Z]{3}/.test(s) && s.split(' ').length > 2) || '';
    const p = paper({ source: 'dtic', sid: ad, title: String(d.title || '').replace(/^DTIC [A-Z0-9]+:\s*/, ''), authors, venue: org || 'DTIC', date: d.date || (d.year ? `${d.year}-01-01` : ''),
      abstract: d.description || '', url: `${base}/details/${d.identifier}`, pdf: `${base}/download/${d.identifier}/${d.identifier}.pdf`, type: 'report', number: ad });
    p.dtic = ad; p.dticPdf = `${dticBase}/sti/tr/pdf/${ad}.pdf`;
    return p;
  };
  return {
    // one page of the archive's DTIC reports matching the words (in the title, abstract or subjects), page: 1, 2, ...
    async page(words, size = 10, page = 1) {
      const w = String(words).replace(/["()]/g, ' ').trim();
      const q = `collection:(dticarchive) AND (title:(${w}) OR description:(${w}) OR subject:(${w}))`;
      const s = new URLSearchParams({ q, rows: String(size), page: String(page), output: 'json' });
      for (const f of ['identifier', 'title', 'date', 'year', 'description', 'subject']) s.append('fl[]', f);
      const j = await http.json(`${base}/advancedsearch.php?${s}`);
      const r = j.response || {};
      return { items: (r.docs || []).filter((d) => d.identifier).map(fromDoc), total: +r.numFound || 0 };
    },
    // is DTIC's own public search back? (its page says when it is offline)
    async publicSearchUp() {
      try { const r = await http.get('https://discover.dtic.mil/', { timeoutMs: 30e3 }); return r.status === 200 && !/Public Search is (temporarily )?offline/i.test(r.body.toString('utf8')); }
      catch { return false; }
    },
  };
}

function createUnpaywall({ http, base = 'https://api.unpaywall.org', mailto = '' }) {
  const M = () => (typeof mailto === 'function' ? mailto() : mailto) || '';
  return {
    enabled: () => !!M(),
    async pdfFor(doi) {
      if (!M() || !doi) return '';
      try { const j = await http.json(`${base}/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(M())}`);
        const l = j.best_oa_location || {}; return l.url_for_pdf || ''; } catch { return ''; }
    },
  };
}

module.exports = { createCrossref, createArxiv, createAiaa, createNtrs, createDtic, createUnpaywall };
