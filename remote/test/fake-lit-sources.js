// Stand-ins for the paper sources in the literature tests, all on one local server (the module's "endpoints" point at
// them): OpenAlex (/oa), Crossref (/cr), arXiv (/arxiv), AIAA's RSS (/aiaa), NTRS (/ntrs), and open-access PDFs (/pdf).
// Today's papers: two about plasma sheaths (one with an open PDF, one paywalled), one already in the library (dropped),
// one about something else (scored low), the same paper again from AIAA's feed (merged), an unrelated arXiv preprint.
'use strict';
const http = require('http');
const { makePdf } = require('./make-pdf');

const today = new Date().toISOString().slice(0, 10);
const inv = (text) => { const o = {}; text.split(' ').forEach((w, i) => { (o[w] = o[w] || []).push(i); }); return o; };
function work(id, doi, title, abs, pdf) {
  return { id: 'https://openalex.org/' + id, doi: 'https://doi.org/' + doi, title, publication_year: +today.slice(0, 4), publication_date: today, type: 'article',
    authorships: [{ author: { id: 'https://openalex.org/A123', display_name: 'Wei Sun' } }, { author: { id: 'https://openalex.org/A456', display_name: 'Anna Lee' } }], abstract_inverted_index: abs ? inv(abs) : null,
    primary_location: { source: { display_name: 'IEEE Transactions on Antennas and Propagation', issn_l: '0018-926X' }, landing_page_url: 'https://example.org/' + id },
    best_oa_location: pdf ? { pdf_url: pdf } : null };
}

function createFakeSources() {
  let port = 0;
  const hits = [];
  const W = () => ({
    open: work('W1', '10.2514/1.new1', 'Electron density profiles of the RAM C-II plasma sheath', 'We measure the electron density of the plasma sheath during reentry', `http://127.0.0.1:${port}/pdf/new1.pdf`),
    closed: work('W4', '10.1109/x.closed', 'Plasma sheath communication blackout measurements', 'Blackout of telemetry in the plasma sheath was measured', null),
    dup: work('W2', '10.2514/1.exist', 'Plasma sheath blackout mitigation by magnetic window', 'Already in the library', null),
    other: work('W3', '10.1000/stocks', 'Deep learning for stock prices', 'Stocks', null),
    seed: work('W9', '10.1109/tap.2018.1', 'Backward scattering of a reentry vehicle in plasma sheath', 'The key paper', null),     // (the library's key paper)
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    hits.push(p + u.search);
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const xml = (s) => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(s); };
    const w = W();
    if (p === '/oa/works') {
      const f = u.searchParams.get('filter') || '';
      if (f.includes('primary_location.source.issn')) return json({ results: [w.open, w.dup, w.other] });
      if (f.includes('cites:')) return json({ results: [w.closed] });
      return json({ results: [] });
    }
    if (p.startsWith('/oa/works/doi:')) {
      const doi = decodeURIComponent(p.slice('/oa/works/doi:'.length));
      const hit = Object.values(w).find((x) => x.doi.endsWith(doi));
      if (!hit) { res.writeHead(404); return res.end('{}'); }
      return json(hit);
    }
    if (p === '/oa/sources') return json({ results: [{ display_name: 'Radio Science', issn_l: '0048-6604', issn: ['0048-6604', '1944-799X'] }] });
    if (p === '/oa/authors') return json({ results: [{ id: 'https://openalex.org/A123', display_name: 'Wei Sun', cited_by_count: 9, works_count: 3, last_known_institutions: [{ display_name: 'CAS' }] }] });
    if (p === '/cr/works') return json({ message: { items: [] } });
    if (p === '/arxiv/api/query') return xml(`<feed><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>Graph neural networks for traffic</title><summary>Traffic</summary><published>${today}T00:00:00Z</published><author><name>Ann Other</name></author></entry></feed>`);
    if (p === '/aiaa/action/showFeed') return xml(`<rdf:RDF><channel><title>AIAA Journal: Table of Contents</title></channel><item rdf:about="x"><title>Electron density profiles of the RAM C-II plasma sheath</title><link>https://arc.aiaa.org/doi/10.2514/1.new1</link><dc:creator>Sun, Wei</dc:creator><dc:date>${today}</dc:date><prism:doi>10.2514/1.new1</prism:doi></item></rdf:RDF>`);
    if (p === '/ntrs/api/citations/search') return json({ results: [{ id: 19700001, title: 'Reentry plasma attenuation measurements on RAM C', abstract: 'RAM C flight plasma sheath', distribution: 'PUBLIC', center: { name: 'Langley Research Center' },
      publications: [{ publicationDate: '1970-01-01T00:00:00Z' }], authorAffiliations: [{ meta: { author: { name: 'Grantham, W. L.' } } }], otherReportNumbers: ['NASA-TN-D-1234'], downloads: [] }] });
    if (p === '/ntrs/api/citations/19700001/downloads/19700001.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('NTRS OCR PAGE ONE plasma attenuation at 9.21 GHzNTRS OCR PAGE TWO electron density 1e12'); }
    if (p === '/pdf/new1.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(makePdf(['RAM C-II electron density profile of the plasma sheath', 'Collision frequency model and RCS reduction'])); }
    res.writeHead(404); res.end('not found');
  });
  return { server, hits, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(port); })), close: () => server.close() };
}

module.exports = { createFakeSources };
