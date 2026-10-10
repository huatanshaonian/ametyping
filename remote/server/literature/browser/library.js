// 图书馆通道: a paper's PDF through the access the user has as a member of their institution, in the browser where
// they are signed in to it (the Chromium of the Zotero container's web desktop: the library's access extension, the
// publishers' own sign-ins). The browser does the asking -- with its cookies, through the proxy the extension set --
// and this module only steers it over the DevTools port (settings "browserPort"; 0 = off):
//   0. a publisher that is only open through the library's extension: the extension is asked whether it is signed in;
//   1. a new tab goes to the paper (https://doi.org/<doi>) and is read where it lands (sites.js);
//   2. IEEE Xplore without access: signed in through the institution once (signin.js), when an account is set;
//   3. the tab goes to the PDF, and the answer's body is taken as it arrives.
// It stops, and says what it needs, when the page asks for a person ("are you a robot": the user answers it in the
// web desktop -- it is never answered here; the tab is left open for that), when a sign-in is needed that it cannot
// do, or when the page offers no PDF (not subscribed). One paper at a time (pdfqueue.js paces them).
'use strict';
const { connect } = require('./cdp');
const { byHost, byDoi, LOOK, ACCESS, ACCESS_ON } = require('./sites');
const { signIn } = require('./signin');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BYTES = 80 * 1024 * 1024;

// an error the queue understands: need 'browser' | 'verify' | 'signin' (waits for the user), final (no use trying again)
function stop(msg, o = {}) { return Object.assign(new Error(msg), o); }

function createLibrary({ port = () => 0, account = () => '', idp = () => '', doiBase = 'https://doi.org/', ieeeBase = 'https://ieeexplore.ieee.org', ieeeHome = 'ieeexplore.ieee.org',
  access = ACCESS, reviveMs = 40e3, loadMs = 45e3, pdfMs = 6 * 60e3, quietMs = 25e3, checkMs = 3000, settleMs = 2500, stepMs = 1500, log = () => {} } = {}) {
  let busy = false;
  const left = new Map();                                    // site -> the tab left open on its check (closed when the site is next asked)
  const enabled = () => +port() > 0;

  async function ping() {
    if (!enabled()) return { ok: false, msg: '没有开启（调试端口是 0）' };
    try { const c = await connect(+port()); const v = c.version; c.close(); return { ok: true, msg: '浏览器在线：' + v }; }
    catch (e) { return { ok: false, msg: '连不上浏览器：' + e.message }; }
  }

  // the tab has arrived somewhere (not the DOI resolver any more) and finished loading
  async function landed(c, sid) {
    let last = null;
    for (const until = Date.now() + loadMs; Date.now() < until;) {
      await sleep(stepMs);
      try { last = await c.evaluate(sid, '({ host: location.host, ready: document.readyState, url: location.href })'); } catch { continue; }
      if (last.ready === 'complete' && last.host && !/(^|\.)doi\.org$/.test(last.host) && !/^(about|chrome)/.test(last.url)) { await sleep(settleMs); return true; }
    }
    return !!(last && last.host && !/(^|\.)doi\.org$/.test(last.host));
  }
  // a check that the browser passes by itself takes a few seconds: look again before calling it one for the user
  async function look(c, sid) {
    let v = await c.evaluate(sid, LOOK);
    for (let i = 0; v.challenge && i < 4; i++) { await sleep(checkMs); v = await c.evaluate(sid, LOOK).catch(() => v); }
    return v;
  }

  // is the library's extension signed in? Asked on a page of its own, in the paper's tab before it goes anywhere.
  // -> true | false | null (no such page: the extension is not there or another one is used -- not judged)
  async function extensionOn(c, sid) {
    if (!access || !access.page) return null;
    c.send('Page.navigate', { url: access.page }, sid).catch(() => {});
    for (let i = 0; i < 4; i++) {
      await sleep(Math.min(stepMs, 1000));
      const r = await c.evaluate(sid, ACCESS_ON).catch(() => null);
      if (r) return !!r.on;
    }
    return null;
  }
  // signed out: its website is opened, which signs the extension in again while the site itself still is. -> true | false
  async function revive(c, sid) {
    if (!access.home) return false;
    c.send('Page.navigate', { url: access.home }, sid).catch(() => {});
    for (const until = Date.now() + reviveMs; Date.now() < until;) {
      await sleep(stepMs);
      const at = await c.evaluate(sid, 'location.href').catch(() => '');
      if (access.login && at.includes(access.login)) return false;         // the site wants a login too: the user's
      if (at.startsWith(access.home) && (await sleep(settleMs), true)) {
        if (await extensionOn(c, sid)) return true;
        c.send('Page.navigate', { url: access.home }, sid).catch(() => {});
      }
    }
    return false;
  }

  // the tab goes to the PDF; its body is taken off the answer. -> { buf } | { html: true } (it ended on a page)
  function capture(c, sid, mainFrame, url, referrer) {
    return new Promise((resolve) => {
      let done = false, seen = false, hopped = false, lastHtml = Date.now();
      const finish = (r) => { if (done) return; done = true; clearTimeout(t); clearInterval(watch); off(); resolve(r); };
      const t = setTimeout(() => finish({ err: seen ? 'PDF 下到一半超时了' : '等 PDF 超时了' }), pdfMs);
      // no PDF on the way and nothing new for a while (a slow server is given its time): it ended on a page -- no
      // access, or a check
      const watch = setInterval(() => { if (!seen && Date.now() - lastHtml > quietMs) finish({ html: true }); }, Math.min(2000, quietMs));
      const off = c.on(async (d) => {
        if (d.method !== 'Fetch.requestPaused' || d.sessionId !== sid) return;
        const p = d.params, type = ((p.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
        const isPdf = p.responseStatusCode === 200 && /pdf|octet-stream/i.test(type);
        if (!isPdf) { lastHtml = Date.now(); c.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {}); return; }
        if (p.frameId !== mainFrame && !hopped) {
          // a PDF shown in a frame of a viewer page: asked for again as the page itself, where its body can be taken
          hopped = true; lastHtml = Date.now();
          await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }, sid).catch(() => {});
          c.send('Page.navigate', { url: p.request.url, referrer: url }, sid).catch(() => {});
          return;
        }
        seen = true;
        try {
          const { stream } = await c.send('Fetch.takeResponseBodyAsStream', { requestId: p.requestId }, sid);
          const parts = []; let n = 0;
          for (;;) {
            const r = await c.send('IO.read', { handle: stream, size: 1 << 20 }, sid, 120e3);
            const b = Buffer.from(r.data, r.base64Encoded ? 'base64' : 'utf8'); parts.push(b); n += b.length;
            if (n > MAX_BYTES) { finish({ err: 'PDF 太大（超过 80 MB）' }); break; }
            if (r.eof) break;
          }
          c.send('IO.close', { handle: stream }, sid).catch(() => {});
          finish({ buf: Buffer.concat(parts), url: p.request.url });
        } catch (e) { finish({ err: e.message }); }
      });
      // (the answer to Page.navigate only comes when the PDF is through -- minutes for a large one on a slow line --
      // so it is not waited for: what happens is seen in the paused requests)
      c.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sid)
        .then(() => { c.send('Page.navigate', { url, referrer }, sid, pdfMs).catch(() => {}); }, (e) => finish({ err: e.message }));
    });
  }

  // fetch({ doi, url, title }) -> { buf, url, site: { id, name } }; throws stop(...)
  async function fetch(p) {
    if (!enabled()) throw stop('图书馆通道没有开启', { need: 'browser' });
    if (busy) throw stop('浏览器正忙');
    const start = p.doi ? doiBase + String(p.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : p.url;
    if (!start || !/^https?:\/\//.test(start)) throw stop('这篇没有 DOI 也没有网址', { final: true });
    busy = true;
    let c = null, targetId = '', keep = '';
    try {
      try { c = await connect(+port()); } catch (e) { throw stop('连不上网页桌面里的浏览器：' + e.message, { need: 'browser' }); }
      ({ targetId } = await c.send('Target.createTarget', { url: 'about:blank' }));
      const sid = await c.attach(targetId);
      await c.send('Page.enable', {}, sid);
      const mainFrame = (await c.send('Page.getFrameTree', {}, sid)).frameTree.frame.id;
      if (byDoi(p.doi).ext && (await extensionOn(c, sid)) === false) {
        log(`文献：${access.name} 掉线了，打开它的网站让它重新连上`);
        if (await revive(c, sid)) log(`文献：${access.name} 重新连上了`);
        else throw stop(`${access.name} 掉线了：到网页桌面的浏览器里点 ${access.name} 的图标重新登录（登录好了会自己接着下）`, { need: 'browser', site: { id: byDoi(p.doi).id, name: byDoi(p.doi).name } });
      }
      await c.send('Page.navigate', { url: start }, sid);
      if (!(await landed(c, sid))) throw stop('论文的页面打不开（DOI 没有跳转，或网站没有回应）');
      let v = await look(c, sid);
      const site = byHost(v.host), at = { site: { id: site.id, name: site.name === '其他网站' ? v.host : site.name } };
      if (left.has(site.id)) { await c.send('Target.closeTarget', { targetId: left.get(site.id) }).catch(() => {}); left.delete(site.id); }
      const check = () => { keep = site.id; return stop(`${at.site.name} 要先做一次人机验证：到网页桌面的浏览器里点一下`, { need: 'verify', ...at, page: v.url }); };
      if (v.challenge) throw check();

      // IEEE: not recognised as the institution -> through the institution's sign-in, once (its page writes who the
      // access is from a little after it has loaded: looked at a few more times first)
      for (let i = 0; site.signin && v.access === false && i < 4; i++) { await sleep(checkMs); v = await c.evaluate(sid, LOOK).catch(() => v); }
      if (site.signin && v.access === false && account() && idp()) {
        const page = v.url;
        log(`文献：${site.name} 没有登录，走机构登录（${account()}）`);
        const r = await signIn(c, sid, { account: account(), idp: idp(), target: page, home: ieeeHome, base: ieeeBase, waitMs: loadMs, sleepFn: (ms) => sleep(Math.min(ms, stepMs)) });
        if (!r.ok) throw stop(`${site.name} 的机构登录没有成功：${r.why}`, { need: 'signin', ...at });
        log(`文献：${site.name} 机构登录成功${r.asked ? '' : '（机构那边的登录还有效）'}`);
        await landed(c, sid);
        v = await look(c, sid);
        if (v.challenge) throw check();
      }
      if (!v.pdf) throw stop(`${at.site.name} 的页面上没有 PDF 入口（多半是没有订购这篇）`, { final: true, ...at });

      const r = await capture(c, sid, mainFrame, v.pdf, v.url);
      await c.send('Fetch.disable', {}, sid).catch(() => {});
      if (r.err) throw stop(r.err, at);
      if (r.html) {
        v = await look(c, sid).catch(() => v);
        if (v.challenge) throw check();
        throw stop(site.signin && !account() ? `${at.site.name} 没有给出 PDF：没有登录机构账号（在设置里填上机构登录的账号，或在网页桌面里登录一次）` : `${at.site.name} 没有给出 PDF（没有权限，多半是没有订购这篇）`,
          site.signin && !account() ? { need: 'signin', ...at } : { final: true, ...at });
      }
      if (r.buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw stop(`${at.site.name} 给的不是 PDF`, { final: true, ...at });
      return { buf: r.buf, url: r.url, ...at };
    } finally {
      if (c) {
        if (targetId && keep) left.set(keep, targetId);
        else if (targetId) await c.send('Target.closeTarget', { targetId }).catch(() => {});
        c.close();
      }
      busy = false;
    }
  }

  return { enabled, ping, fetch, busy: () => busy };
}

module.exports = { createLibrary };
