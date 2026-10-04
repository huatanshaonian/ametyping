// One shape for a paper found anywhere (OpenAlex, Crossref, arXiv, AIAA, NTRS, a mail's picks), and its Zotero item:
//   { id, source, doi, title, authors: ['Last, First'], venue, year, date: 'YYYY-MM-DD', abstract, url, pdf (an open-access
//     PDF when known), type: journalArticle | conferencePaper | preprint | report, number (report no.), arxiv, ntrs, issn }
// id: 'doi:<doi>' when there is one (the same paper from two sources is one), else '<source>:<their id>'.
'use strict';
const { normDoi, normTitle } = require('../zotero/mirror');

const clean = (s, n = 4000) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim().slice(0, n);
const ymd = (d) => { const t = Date.parse(d); if (!t) return ''; const x = new Date(t); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };

function paper(p) {
  const doi = normDoi(p.doi);
  const date = p.date ? ymd(p.date) || String(p.date).slice(0, 10) : '';
  const out = { source: p.source, doi, title: clean(p.title, 500), authors: (p.authors || []).map((a) => clean(a, 120)).filter(Boolean).slice(0, 30),
    venue: clean(p.venue, 200), year: +p.year || (date ? +date.slice(0, 4) : 0), date, abstract: clean(p.abstract), url: p.url || (doi ? 'https://doi.org/' + doi : ''),
    pdf: p.pdf || '', type: p.type || 'journalArticle', number: clean(p.number, 80), arxiv: p.arxiv || '', ntrs: p.ntrs || '', issn: p.issn || '' };
  out.id = doi ? 'doi:' + doi : `${p.source}:${p.sid || normTitle(out.title).slice(0, 60)}`;
  return out;
}
// a fingerprint against duplicates that come without a DOI (or with different ones): the title, letters only
const fingerprint = (p) => normTitle(p.title).slice(0, 80);

// "Last, First" from "First Last" (an author string as most feeds give it)
function lastFirst(name) {
  const s = String(name || '').trim();
  if (!s || s.includes(',')) return s;
  const parts = s.split(/\s+/);
  return parts.length < 2 ? s : `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

// the Zotero item for a paper (POST /items), filed in `collections`, tagged
function toZotero(p, { collections = [], tags = [] } = {}) {
  const creators = (p.authors || []).map((a) => { const [last, first] = String(a).split(/,\s*/); return first ? { creatorType: 'author', lastName: last, firstName: first } : { creatorType: 'author', name: last }; });
  const base = { title: p.title, creators, abstractNote: p.abstract || '', date: p.date || (p.year ? String(p.year) : ''), url: p.url || '', collections, tags: tags.map((tag) => ({ tag })), relations: {} };
  if (p.type === 'report') return { itemType: 'report', ...base, reportNumber: p.number || '', institution: p.venue || '', extra: p.ntrs ? `NTRS: ${p.ntrs}` : p.dtic ? `DTIC: ${p.dtic}` : '' };
  if (p.type === 'preprint') return { itemType: 'preprint', ...base, repository: p.venue || 'arXiv', archiveID: p.arxiv ? 'arXiv:' + p.arxiv : '', DOI: p.doi || '' };
  if (p.type === 'conferencePaper') return { itemType: 'conferencePaper', ...base, proceedingsTitle: p.venue || '', DOI: p.doi || '' };
  return { itemType: 'journalArticle', ...base, publicationTitle: p.venue || '', DOI: p.doi || '', ISSN: p.issn || '' };
}

module.exports = { paper, fingerprint, lastFirst, toZotero, clean, ymd };
