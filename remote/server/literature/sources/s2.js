// Semantic Scholar (https://api.semanticscholar.org): a second search engine next to OpenAlex -- good at relevance --
// and recommendations: papers like the ones the user kept / starred and unlike the ones skipped. With a key (控制面板 › 文献)
// one request a second; without one the shared public pool -- often busy (429): asked more slowly, a 429 waited out and
// tried again twice, then given up for this time (the push goes on without it).
'use strict';
const { paper, lastFirst } = require('./normalize');

const FIELDS = 'title,abstract,year,venue,publicationDate,externalIds,authors,url,openAccessPdf,citationCount,publicationTypes';
const TYPE = { JournalArticle: 'journalArticle', Conference: 'conferencePaper', Review: 'journalArticle' };

function fromS2(x) {
  const ids = x.externalIds || {};
  const t = (x.publicationTypes || []).map((k) => TYPE[k]).find(Boolean) || (ids.ArXiv ? 'preprint' : 'journalArticle');
  return { ...paper({ source: 's2', sid: x.paperId, doi: ids.DOI || '', arxiv: ids.ArXiv || '', title: x.title, authors: (x.authors || []).map((a) => lastFirst(a.name)),
    venue: x.venue || (ids.ArXiv ? 'arXiv' : ''), year: x.year, date: x.publicationDate || (x.year ? `${x.year}-01-01` : ''), abstract: x.abstract || '',
    url: ids.DOI ? 'https://doi.org/' + ids.DOI : x.url || '', pdf: (x.openAccessPdf && x.openAccessPdf.url) || '', type: t }), cited: x.citationCount || 0 };
}

// key: the API key, or a function giving it (it can change in the settings)
function createS2({ http, base = 'https://api.semanticscholar.org', key = '' }) {
  const K = () => (typeof key === 'function' ? key() : key) || '';
  let last = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gap = async () => { const w = last + (K() ? 1100 : 3500) - Date.now(); if (w > 0) await sleep(w); last = Date.now(); };
  async function call(path, opts = {}) {
    let r;
    for (let i = 0; ; i++) {
      await gap();
      r = await http.request(base + path, { method: opts.body ? 'POST' : 'GET', headers: { ...(K() ? { 'x-api-key': K() } : {}), Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : null, timeoutMs: 30e3 });
      if (r.status !== 429 || i >= 2) break;
      await sleep((K() ? 3000 : 6000) * (i + 1));                        // (busy: wait, then once or twice more)
    }
    if (r.status === 403 || r.status === 401) throw Object.assign(new Error('Semantic Scholar 不认这个 key'), { status: r.status });
    if (r.status === 429) throw Object.assign(new Error(K() ? 'Semantic Scholar 请求太频繁' : 'Semantic Scholar 的公共额度正忙（填了 key 会稳定）'), { status: 429 });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Semantic Scholar 返回 ${r.status}`), { status: r.status });
    return JSON.parse(r.body.toString('utf8'));
  }
  return {
    enabled: () => true,
    hasKey: () => !!K(),
    // the literature on a subject since a year, most relevant first
    async search(words, fromYear = 0, n = 8) {
      const s = new URLSearchParams({ query: words, limit: String(n), fields: FIELDS, ...(fromYear ? { year: `${fromYear}-` } : {}) });
      const j = await call(`/graph/v1/paper/search?${s}`);
      return (j.data || []).filter((x) => x.title).map(fromS2);
    },
    // papers like the positives (DOIs) and unlike the negatives: the DOIs are turned into Semantic Scholar ids first
    async recommend(posDois, negDois = [], n = 30) {
      const ids = async (dois) => {
        if (!dois.length) return [];
        const r = await call('/graph/v1/paper/batch?fields=paperId', { body: { ids: dois.slice(0, 100).map((d) => 'DOI:' + d) } });
        return (r || []).filter(Boolean).map((x) => x.paperId).filter(Boolean);
      };
      const pos = await ids(posDois); if (!pos.length) return [];
      const neg = await ids(negDois);
      const j = await call(`/recommendations/v1/papers?fields=${FIELDS}&limit=${n}`, { body: { positivePaperIds: pos.slice(0, 50), negativePaperIds: neg.slice(0, 50) } });
      return (j.recommendedPapers || []).filter((x) => x.title).map(fromS2);
    },
    // is the key good? (a tiny search)
    async test() { await call('/graph/v1/paper/search?query=radar+cross+section&limit=1&fields=title'); return true; },
  };
}

module.exports = { createS2, fromS2 };
