// The publishers the library access is known for, and what is read off a paper's page there: whether the page is a
// "are you human" check, and where the PDF is. Checked by hand on ScienceDirect, AIAA and IEEE Xplore; the others go
// by the usual marks (the citation_pdf_url of the page, a link that looks like the PDF) and may simply find nothing.
'use strict';

// "signin": the site takes the user's institution's sign-in (federated login); -> the address that starts it for the
// institution `idp` and comes back to `target` (IEEE has its own way in, AIP the plain Shibboleth one)
const enc = encodeURIComponent;
const SITES = [
  { id: 'sciencedirect', name: 'ScienceDirect', hosts: ['sciencedirect.com'], prefixes: ['10.1016'], ext: true },
  { id: 'ieee', name: 'IEEE Xplore', hosts: ['ieeexplore.ieee.org'], prefixes: ['10.1109'],
    signin: (idp, target) => `https://ieeexplore.ieee.org/servlet/wayf.jsp?entityId=${enc(idp)}&url=${enc(target)}` },
  { id: 'aiaa', name: 'AIAA', hosts: ['arc.aiaa.org'], prefixes: ['10.2514'], ext: true },
  { id: 'aip', name: 'AIP', hosts: ['pubs.aip.org'], prefixes: ['10.1063'], ext: true,
    // AIP counts one institution: reached through the library's proxy it is the library's, and a sign-in through
    // another institution adds nothing (seen: signed in as member@ucas.ac.cn, the page still says "Institute of
    // Mechanics CAS" and refuses the PDF; the same sign-in without the proxy: "Univ of Chinese Academy of Sci", the
    // PDF). So for that sign-in the extension is signed out first and AIP's own session forgotten ("fresh": its
    // cookies by the start of their names); the session then made is good with the proxy back on.
    fresh: ['_shibsession', 'AIPP_SessionId'],
    signin: (idp, target) => `https://pubs.aip.org/Shibboleth.sso/Login?entityID=${enc(idp)}&target=${enc(target)}` },
  { id: 'springer', name: 'Springer', hosts: ['link.springer.com'], prefixes: ['10.1007'], ext: true },
  { id: 'wiley', name: 'Wiley', hosts: ['onlinelibrary.wiley.com'], prefixes: ['10.1002', '10.1029'], ext: true },
  { id: 'iop', name: 'IOP', hosts: ['iopscience.iop.org'], prefixes: ['10.1088'], ext: true },
];
// The library's access extension (MyLOFT): the sites marked "ext" are only open while it is signed in -- it then sends
// them through the library's proxy. Signed out it leaves the proxy alone, and every one of them answers "no access"
// or with a check; so it is asked first (library.js). The page it is asked from is a plain file of the extension,
// where no script of its own runs (its popup page acts when opened: it opens the login page, saves the current tab).
// Its login is a token of 15 minutes that it renews itself; when a renewal is refused it signs itself out, while the
// MyLOFT website ("home") usually stays signed in -- and opening that hands the extension a fresh token (it listens
// for the site's cookie). Only when the site is signed out too (it shows "login") does the user have to sign in.
const ACCESS = { name: 'MyLOFT', page: 'chrome-extension://hljakogpibfgelmoegmajaeefcnefngd/manifest.json', home: 'https://app.myloft.xyz/', login: '/user/login' };
// Runs in that page: the extension signs itself out (its own "log out" message: token gone, proxy off; its website
// stays signed in, so opening that brings it back -- library.js: revive)
const ACCESS_OFF = `(chrome.runtime.sendMessage({ logoutFromOptions: true }).catch(() => {}), true)`;
// Runs in that page. -> { on } (it steers the proxy: signed in) | null (not the extension's page: cannot tell)
const ACCESS_ON = `(async () => {
  if (location.protocol !== 'chrome-extension:' || !self.chrome || !chrome.proxy) return null;
  const s = await chrome.proxy.settings.get({});
  return { on: s.levelOfControl === 'controlled_by_this_extension' && (s.value || {}).mode === 'pac_script' };
})()`;
const OTHER = { id: 'other', name: '其他网站', hosts: [], prefixes: [] };
// A DOI of the Chinese registry does not go to the paper but to a page listing where it is ("多重解析地址选择页面"):
// the first address listed there is followed. Runs in that page. -> the address | ''
const RESOLVERS = ['www.chndoi.org'];
const RESOLVED = `(() => { const a = [...document.querySelectorAll('ul li a[href]')].map((e) => e.href).find((h) => h.startsWith('http') && !h.includes(location.host)); return a || ''; })()`;

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

module.exports = { SITES, OTHER, ACCESS, ACCESS_ON, ACCESS_OFF, RESOLVERS, RESOLVED, byHost, byDoi, byId, LOOK };
