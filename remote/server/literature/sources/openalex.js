// OpenAlex (https://api.openalex.org): the main way new papers are found -- by journal (ISSN), by author, by what they
// cite (papers citing the user's key papers), or by search words -- with abstracts (stored as an inverted index) and
// open-access PDF links. A free key (literature config "openalexKey") raises the daily budget; "mailto" is sent only
// when the user has set one.
'use strict';
const { paper, lastFirst } = require('./normalize');

const TYPE = { article: 'journalArticle', 'proceedings-article': 'conferencePaper', preprint: 'preprint', report: 'report' };

function abstractOf(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, at] of Object.entries(inv)) for (const i of at) words[i] = w;
  return words.filter((w) => w != null).join(' ');
}
function fromWork(w) {
  const loc = w.primary_location || {}, src = loc.source || {}, oa = w.best_oa_location || {};
  return paper({ source: 'openalex', sid: String(w.id || '').split('/').pop(), doi: w.doi, title: w.title || w.display_name,
    authors: (w.authorships || []).map((a) => lastFirst(a.author && a.author.display_name)), venue: src.display_name || '', year: w.publication_year, date: w.publication_date,
    abstract: abstractOf(w.abstract_inverted_index), url: w.doi ? String(w.doi) : loc.landing_page_url || '', pdf: oa.pdf_url || '',
    type: TYPE[w.type] || 'journalArticle', issn: (src.issn_l || '') });
}

function createOpenAlex({ http, base = 'https://api.openalex.org', key = '', mailto = '' }) {
  const q = (params) => {
    const s = new URLSearchParams({ ...params, ...(key ? { api_key: key } : {}), ...(mailto ? { mailto } : {}) });
    return `${base}/works?${s}`;
  };
  async function works(filter, { search = '', perPage = 40, sort = 'publication_date:desc' } = {}) {
    const j = await http.json(q({ filter, ...(search ? { search } : {}), sort, per_page: String(perPage) }));
    return (j.results || []).map(fromWork);
  }
  const since = (d) => `from_publication_date:${d}`;
  return {
    // new papers in these journals (ISSNs) since a date
    byIssn: (issns, from) => (issns.length ? works(`primary_location.source.issn:${issns.slice(0, 50).join('|')},${since(from)}`) : []),
    // new papers by these authors (OpenAlex author ids A123...)
    byAuthors: (ids, from) => (ids.length ? works(`authorships.author.id:${ids.slice(0, 50).join('|')},${since(from)}`) : []),
    // new papers citing these works (OpenAlex ids W123...)
    citing: (ids, from) => (ids.length ? works(`cites:${ids.slice(0, 50).join('|')},${since(from)}`) : []),
    // a search, newest first
    search: (words, from) => works(since(from), { search: words, perPage: 25 }),
    // one work by DOI (to fill in an abstract / find its OpenAlex id), or null
    async byDoi(doi) {
      try { const s = new URLSearchParams({ ...(key ? { api_key: key } : {}), ...(mailto ? { mailto } : {}) }).toString();
        const w = await http.json(`${base}/works/doi:${encodeURIComponent(doi)}${s ? '?' + s : ''}`);
        return { ...fromWork(w), openalex: String(w.id || '').split('/').pop(),
          authorIds: (w.authorships || []).map((a) => ({ name: (a.author && a.author.display_name) || '', id: String((a.author && a.author.id) || '').split('/').pop(), inst: ((a.institutions || [])[0] || {}).display_name || '' })) }; }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
    // a journal by name -> { name, issns } (the best match with ISSNs), for a journal the library lacks
    async source(name) {
      const s = new URLSearchParams({ search: name, per_page: '5', ...(key ? { api_key: key } : {}), ...(mailto ? { mailto } : {}) });
      const j = await http.json(`${base}/sources?${s}`);
      const x = (j.results || []).find((r) => (r.issn || []).length || r.issn_l);
      return x ? { name: x.display_name, issns: [...new Set([x.issn_l, ...(x.issn || [])].filter(Boolean))] } : null;
    },
    // an author's id by name (the most cited match), for the follow list
    async authorId(name) {
      const s = new URLSearchParams({ search: name, per_page: '5', ...(key ? { api_key: key } : {}), ...(mailto ? { mailto } : {}) });
      const j = await http.json(`${base}/authors?${s}`);
      const a = (j.results || []).sort((x, y) => (y.cited_by_count || 0) - (x.cited_by_count || 0))[0];
      return a ? { id: String(a.id).split('/').pop(), name: a.display_name, works: a.works_count, inst: ((a.last_known_institutions || [])[0] || {}).display_name || '' } : null;
    },
  };
}

module.exports = { createOpenAlex, abstractOf, fromWork };
