// A stand-in for the browser of the library access (server/literature/browser/): the DevTools port -- /json/version and
// a socket speaking just the commands library.js and signin.js use -- over a small model of the publishers:
//   10.1016/ok       ScienceDirect, a PDF link, the PDF
//   10.1016/check    ScienceDirect asking "are you a robot" until .passed is set
//   10.1016/none     ScienceDirect without a PDF link (not subscribed)
//   10.2514/denied   AIAA: a PDF link that answers with a page (no access)
//   10.3390/<x>      an open-access publisher whose PDF comes as a download, with no type written on the answer
//   10.16356/<x>     the Chinese DOI registry: a page listing where the paper is (that open-access publisher)
//   10.1063/<x>      AIP: the PDF only once signed in through the institution (.aipIn); the institution asks first
//                    whether the user's details may go to AIP while .consent is set
//   10.1109/<n>      IEEE Xplore: access only when signed in; its PDF comes inside a frame first
// The library's extension answers from its own page whether it steers the proxy (.extOn); opening its website signs it
// in again while the website itself is signed in (.webSession), and shows the login page otherwise.
// IEEE's institutional sign-in (wayf.jsp) comes straight back while .idpSession is set; otherwise a login page with its
// form in a frame, where the browser "fills in" the saved password only for the account .saved. What was typed, pressed,
// opened and closed is kept for the test (.typed, .logins, .opened, .closed, .log).
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const LOGIN_OFF = { x: 100, y: 50 }, USER_AT = { x: 30, y: 10 }, BUTTON_AT = { x: 40, y: 60 };

function createFakeBrowser({ pdf }) {
  const B = { passed: false, signedIn: false, idpSession: false, saved: 'me@mails.test', captchaBox: false, aipIn: false, consent: false, extOn: true, extAsked: 0, webSession: false, homeOpened: 0, typed: '', logins: 0, opened: 0, closed: 0, log: [], tabs: new Map() };
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ Browser: 'FakeChrome/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` })); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server });

  // where a tab is after going to `url`
  function go(tab, url) {
    if (/^chrome-extension:/.test(url)) { tab.url = url; B.extAsked++; return; }
    if (url.startsWith('https://app.myloft.xyz/')) { B.homeOpened++; if (B.webSession) B.extOn = true; tab.url = B.webSession ? 'https://app.myloft.xyz/browse/home' : 'https://app.myloft.xyz/user/login'; return; }
    B.log.push(url);
    tab.url = url; tab.login = false; tab.consent = false;
    let m;
    if ((m = url.match(/^https:\/\/doi\.org\/(10\.1016)\/(\w+)/))) tab.url = 'https://www.sciencedirect.com/science/article/pii/' + m[2].toUpperCase();
    else if (url.match(/^https:\/\/doi\.org\/10\.2514\//)) tab.url = 'https://arc.aiaa.org/doi/' + url.split('doi.org/')[1];
    else if ((m = url.match(/^https:\/\/doi\.org\/10\.1109\/(\d+)/))) tab.url = 'https://ieeexplore.ieee.org/document/' + m[1];
    else if (url.startsWith('https://doi.org/10.3390/')) tab.url = 'https://www.mdpi.com/' + url.split('10.3390/')[1];
    else if (url.startsWith('https://doi.org/10.16356/')) tab.url = 'https://www.chndoi.org/Resolution/Handler?doi=10.16356/' + url.split('10.16356/')[1];
    else if (url.startsWith('https://doi.org/10.1063/')) tab.url = 'https://pubs.aip.org/aip/' + url.split('10.1063/')[1];
    else if (/\/servlet\/wayf\.jsp/.test(url) || url.includes('/Shibboleth.sso/Login')) {
      const q = new URL(url).searchParams, target = q.get('url') || q.get('target'), sp = url.includes('Shibboleth.sso') ? 'aipIn' : 'signedIn';
      tab.idp = q.get('entityId') || q.get('entityID');
      if (B.idpSession && sp === 'aipIn' && B.consent) { tab.url = 'https://passport.test/idp/consent'; tab.consent = true; }
      else if (B.idpSession) { B[sp] = true; tab.url = target; }
      else { tab.url = 'https://passport.test/idp/login'; tab.login = true; tab.target = target; tab.sp = sp; B.typed = ''; }
    }
  }
  const host = (tab) => { try { return new URL(tab.url).host; } catch { return ''; } };
  function look(tab) {
    const h = host(tab), base = { host: h, url: tab.url, title: 'page', challenge: false, pdf: '', access: null };
    if (h === 'www.sciencedirect.com') {
      if (/CHECK$/.test(tab.url) && !B.passed) return { ...base, title: 'Just a moment', challenge: true };
      return { ...base, pdf: /NONE$/.test(tab.url) ? '' : tab.url + '/pdfft?pid=main.pdf' };
    }
    if (h === 'www.mdpi.com') return { ...base, pdf: tab.url + '/pdf' };
    if (h === 'pubs.aip.org') return { ...base, pdf: tab.url.replace('/aip/', '/aip/article-pdf/') + '.pdf' };
    if (h === 'arc.aiaa.org') return { ...base, pdf: tab.url.replace('/doi/', '/doi/pdf/') };
    if (h === 'ieeexplore.ieee.org') { const n = (tab.url.match(/document\/(\d+)/) || [])[1]; return { ...base, access: B.signedIn, pdf: n ? `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${n}&ref=` : '' }; }
    return base;
  }
  // what going to a PDF address answers with: 'pdf' | 'frame' (a viewer page, the PDF in a frame of it) | 'html'
  function pdfAnswer(tab, url) {
    if (/\/pdfft/.test(url)) return 'pdf';
    if (url.includes('/article-pdf/')) return B.aipIn ? 'pdf' : 'html';
    if (url.startsWith('https://www.mdpi.com/') && url.endsWith('/pdf')) return 'download';
    if (/getPDF\.jsp/.test(url)) return !B.signedIn ? 'html' : tab.framed ? 'pdf' : (tab.framed = true, 'frame');
    return 'html';
  }

  wss.on('connection', (ws) => {
    let n = 0;
    const emit = (sessionId, method, params) => ws.send(JSON.stringify({ sessionId, method, params }));
    ws.on('message', (raw) => {
      const d = JSON.parse(raw), tab = B.tabs.get(String(d.sessionId || '').slice(1)), p = d.params || {};
      const reply = (result) => ws.send(JSON.stringify({ id: d.id, result }));
      switch (d.method) {
        case 'Target.createTarget': { const id = 'T' + (++n) + Date.now().toString(36); B.tabs.set(id, { id, url: p.url, fetch: false }); B.opened++; return reply({ targetId: id }); }
        case 'Target.attachToTarget': return reply({ sessionId: 'S' + p.targetId });
        case 'Target.closeTarget': if (B.tabs.delete(p.targetId)) B.closed++; return reply({ success: true });
        case 'Page.getFrameTree': return reply({ frameTree: { frame: { id: 'main' }, childFrames: tab.login ? [{ frame: { id: 'loginframe' } }] : [] } });
        case 'Page.createIsolatedWorld': return reply({ executionContextId: p.frameId === 'loginframe' ? 7 : 1 });
        case 'DOM.getFrameOwner': return reply({ backendNodeId: 5 });
        case 'DOM.getBoxModel': return reply({ model: { content: [LOGIN_OFF.x, LOGIN_OFF.y, 0, 0, 0, 0, 0, 0] } });
        case 'Fetch.enable': tab.fetch = true; return reply({});
        case 'Fetch.disable': tab.fetch = false; return reply({});
        case 'Page.navigate': {
          reply({ frameId: 'main' });
          if (!tab.fetch) return go(tab, p.url);
          B.log.push(p.url);
          const a = pdfAnswer(tab, p.url);
          const paused = (frameId, type) => emit(d.sessionId, 'Fetch.requestPaused', { requestId: 'R' + Math.random(), frameId, request: { url: p.url }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }] });
          if (a === 'pdf') return paused('main', 'application/pdf');
          if (a === 'download') return emit(d.sessionId, 'Fetch.requestPaused', { requestId: 'R' + Math.random(), frameId: 'main', request: { url: p.url }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename="paper-v2.pdf"' }] });
          if (a === 'frame') { paused('main', 'text/html'); return setTimeout(() => paused('viewerframe', 'application/pdf'), 20); }
          tab.url = p.url; return paused('main', 'text/html');
        }
        case 'Fetch.takeResponseBodyAsStream': tab.sent = 0; return reply({ stream: 'st1' });
        case 'IO.read': { const part = pdf.subarray(tab.sent, tab.sent + 700); tab.sent += part.length; return reply({ data: part.toString('base64'), base64Encoded: true, eof: tab.sent >= pdf.length }); }
        case 'Input.dispatchKeyEvent':
          if (tab.login && p.type === 'keyDown' && p.text) B.typed += p.text;
          if (tab.login && p.type === 'rawKeyDown' && p.key === 'Backspace') B.typed = '';
          return reply({});
        case 'Input.dispatchMouseEvent':
          if (tab.login && p.type === 'mouseReleased' && p.x === BUTTON_AT.x + LOGIN_OFF.x && p.y === BUTTON_AT.y + LOGIN_OFF.y) {
            B.logins++;
            if (B.typed === B.saved) { B[tab.sp || 'signedIn'] = true; B.idpSession = true; tab.login = false; tab.url = tab.target; }
          }
          return reply({});
        case 'Runtime.evaluate': {
          const x = p.expression;
          let v;
          if (x.includes('_eventId_proceed')) v = !!tab.consent;
          else if (/chrome.proxy/.test(x)) v = /^chrome-extension:/.test(tab.url) ? { on: B.extOn } : null;
          else if (x === 'location.host') v = host(tab);
          else if (x === 'location.href') v = tab.url;
          else if (x.includes('ul li a[href]')) v = host(tab) === 'www.chndoi.org' ? 'https://www.mdpi.com/resolved-' + tab.url.split('10.16356/')[1] : '';
          else if (/document\.readyState/.test(x)) v = { host: host(tab), ready: 'complete', url: tab.url };
          else if (/citation_pdf_url/.test(x)) v = look(tab);
          else if (/:autofill/.test(x)) v = { user: B.typed, filled: B.typed === B.saved };
          else if (/form: true/.test(x)) v = tab.login && p.contextId === 7 ? { form: true, user: USER_AT, button: BUTTON_AT, extra: B.captchaBox ? ['captcha'] : [] } : { form: false };
          return reply({ result: { value: v } });
        }
        default: return reply({});
      }
    });
  });
  B.listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  B.close = () => { for (const c of wss.clients) c.terminate(); server.close(); };
  return B;
}

module.exports = { createFakeBrowser };
