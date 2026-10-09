// The publishers the library access is known for, and what is read off a paper's page there: whether the page is a
// "are you human" check, and where the PDF is. Checked by hand on ScienceDirect, AIAA and IEEE Xplore; the others go
// by the usual marks (the citation_pdf_url of the page, a link that looks like the PDF) and may simply find nothing.
'use strict';

const SITES = [
  { id: 'sciencedirect', name: 'ScienceDirect', hosts: ['sciencedirect.com'], prefixes: ['10.1016'] },
  { id: 'ieee', name: 'IEEE Xplore', hosts: ['ieeexplore.ieee.org'], prefixes: ['10.1109'], signin: true },
  { id: 'aiaa', name: 'AIAA', hosts: ['arc.aiaa.org'], prefixes: ['10.2514'] },
  { id: 'aip', name: 'AIP', hosts: ['pubs.aip.org'], prefixes: ['10.1063'] },
  { id: 'springer', name: 'Springer', hosts: ['link.springer.com'], prefixes: ['10.1007'] },
  { id: 'wiley', name: 'Wiley', hosts: ['onlinelibrary.wiley.com'], prefixes: ['10.1002', '10.1029'] },
  { id: 'iop', name: 'IOP', hosts: ['iopscience.iop.org'], prefixes: ['10.1088'] },
];
const OTHER = { id: 'other', name: '其他网站', hosts: [], prefixes: [] };

const byHost = (host) => SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || OTHER;
// before the DOI is followed: a guess from its prefix (a queue skips the sites that wait for the user)
const byDoi = (doi) => SITES.find((s) => s.prefixes.some((p) => String(doi || '').startsWith(p + '/'))) || OTHER;
const byId = (id) => SITES.find((s) => s.id === id) || OTHER;

// Runs in the page. -> { host, url, title, challenge, pdf, access }
//   challenge  the page asks whoever is there to prove they are a person (left to the user; never answered here)
//   pdf        the PDF's address ('' = the page offers none: not subscribed, or not signed in)
//   access     IEEE only: the page names the institution the access comes from
const LOOK = `(() => {
  const abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const host = location.host, text = document.body ? document.body.innerText.slice(0, 20000) : '';
  const challenge = /Are you a robot|Verify you are human|请验证您是真人|Checking your browser|unusual traffic/i.test(text.slice(0, 3000)) || /^(Just a moment|请稍候)/.test(document.title)
    || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, .g-recaptcha, .geetest_holder');
  const links = [...document.querySelectorAll('a[href]')].map((a) => abs(a.getAttribute('href'))).filter(Boolean);
  const meta = (document.querySelector('meta[name="citation_pdf_url"]') || {}).content || '';
  let pdf = '', access = null;
  if (/sciencedirect\\.com$/.test(host)) {
    const pii = (location.pathname.match(/\\/pii\\/([A-Z0-9]+)/i) || [])[1] || '';
    pdf = links.find((h) => /\\/pdfft/.test(h) && (!pii || h.includes(pii))) || '';
  } else if (/ieeexplore\\.ieee\\.org$/.test(host)) {
    const n = (location.pathname.match(/\\/document\\/(\\d+)/) || [])[1] || '';
    access = /Access provided by/i.test(text);
    pdf = n ? location.origin + '/stampPDF/getPDF.jsp?tp=&arnumber=' + n + '&ref=' : '';
  } else {
    const a = links.find((h) => /\\/doi\\/(pdf|epdf|pdfdirect)\\//.test(h)) || '';
    pdf = a ? a.replace('/doi/epdf/', '/doi/pdf/').replace(/[?#].*$/, '') : meta ? abs(meta) : (links.find((h) => /\\/article-pdf\\/|\\/content\\/pdf\\/.+\\.pdf|\\/pdf\\/[^?#]+\\.pdf(\\?|$)/.test(h)) || '');
    if (/onlinelibrary\\.wiley\\.com$/.test(host) && pdf) pdf = pdf.replace('/doi/pdf/', '/doi/pdfdirect/');
  }
  return { host, url: location.href, title: document.title, challenge, pdf, access };
})()`;

module.exports = { SITES, OTHER, byHost, byDoi, byId, LOOK };
