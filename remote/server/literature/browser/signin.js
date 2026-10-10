// Signing in to a publisher (IEEE Xplore, AIP) through the user's institution (federated login), in the browser's own
// profile: the tab is sent to the publisher's "sign in through <institution>" address (sites.js); when the
// institution's session is still good that comes straight back signed in. Otherwise its login page shows, and:
//   - the account's name (settings "ieeeAccount", an e-mail address -- never a password) is typed into the form;
//   - the browser's password manager puts the password it has saved for that name beside it (which of several saved
//     logins the browser filled by itself cannot be read: the page is not told until someone acts on the form);
//   - 登录 is pressed, once.
// Anything else on the form (a captcha box, a code by SMS), a password the browser does not fill, the institution asking
// whether the user's details may be handed to this publisher (asked once per publisher: theirs to answer), or a page
// that does not come back signed in: it stops there and says so. The password is never read, typed or stored by this module.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in a frame of the login page. -> { form, user: {x,y}, button: {x,y}, extra: [names of other boxes] }
const FORM = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const mid = (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const all = [...document.querySelectorAll('input')].filter(vis);
  const p = all.find((e) => e.type === 'password');
  if (!p) return { form: false };
  const u = all.find((e) => ['text', 'email', 'tel', ''].includes(e.type));
  const b = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')].filter(vis).find((e) => /^(登\\s*录|Log ?in|Sign ?in)$/i.test((e.innerText || e.value || '').trim()));
  const extra = all.filter((e) => !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio'].includes(e.type) && e !== u).map((e) => e.name || e.id || e.placeholder || e.type);
  return { form: true, user: u ? mid(u) : null, button: b ? mid(b) : null, extra };
})()`;
// -> { user (what the account box holds), filled (the browser put a saved password in) }
const FILLED = `(() => {
  const all = [...document.querySelectorAll('input')].filter((e) => e.getBoundingClientRect().width > 0);
  const p = all.find((e) => e.type === 'password'), u = all.find((e) => ['text', 'email', 'tel', ''].includes(e.type));
  let filled = false; try { filled = !!p && p.matches(':autofill'); } catch (e) {}
  return { user: u ? u.value : '', filled: filled && p.value.length > 0 };
})()`;

// the institution's "Information Release" page (Shibboleth's consent to hand the user's attributes to the publisher)
const CONSENT = `!!document.querySelector('[name="_eventId_proceed"]')`;
const CONSENT_WHY = '机构那边要你先同意把身份信息交给这家出版商（Information Release）：到网页桌面的浏览器里走一次机构登录，点同意并选「以后不再询问」';

// signIn(c, sid, { account, url, home }) -> { ok: true, asked } | { ok: false, why }
//   url: the publisher's address that starts the sign-in; home: the publisher's host it comes back to
//   asked: the login page showed (false: the institution's session was still good)
async function signIn(c, sid, { account, url, home, waitMs = 45e3, sleepFn = sleep }) {
  const hostNow = () => c.evaluate(sid, 'location.host').catch(() => '');
  // The address that starts the sign-in is the publisher's own, and so is the page the tab was on (which may still be
  // loading): "on the publisher's site" says nothing by itself. Back means: the tab has loaded a page of the
  // institution's -- it always does, also when its session is still good -- and after that one of the publisher's.
  // (Seen on AIP: taken as back after 3 s on the old page, the sign-in, which takes 11 s, was cut short by the next
  // step.) The pages the tab loads are followed; c is closed by the caller.
  let came = '', away = false;
  const atHome = (url) => { try { const u = new URL(url); return u.host === home || u.host.endsWith('.' + home); } catch { return true; } };
  c.on((d) => { if (d.sessionId === sid && d.method === 'Page.frameNavigated' && !d.params.frame.parentId) { came = d.params.frame.url; if (!atHome(came)) away = true; } });
  const back = () => away && atHome(came);
  const consent = () => c.evaluate(sid, CONSENT).catch(() => false);
  await c.send('Page.navigate', { url }, sid);

  // the frame holding the login form (the page itself, or a frame in it) and where that frame sits in the tab
  async function findForm() {
    const tree = (await c.send('Page.getFrameTree', {}, sid)).frameTree;
    const frames = [{ id: tree.frame.id, top: true }, ...(tree.childFrames || []).map((f) => ({ id: f.frame.id }))];
    for (const f of frames) {
      try {
        const w = await c.send('Page.createIsolatedWorld', { frameId: f.id }, sid);
        const form = await c.evaluate(sid, FORM, w.executionContextId);
        if (!form || !form.form) continue;
        let off = { x: 0, y: 0 };
        if (!f.top) {
          const owner = await c.send('DOM.getFrameOwner', { frameId: f.id }, sid);
          const box = (await c.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, sid)).model.content;
          off = { x: box[0], y: box[1] };
        }
        return { form, off, ctx: w.executionContextId };
      } catch {}
    }
    return null;
  }
  let found = null;
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await sleepFn(1500);
    const h = await hostNow();
    if (back()) return { ok: true, asked: false };
    if (h && await consent()) return { ok: false, why: CONSENT_WHY };
    // (the form is there before it is ready: its button reads 检查中… for a moment, and only then 登录)
    if (h) { found = await findForm(); if (found && found.form.user && found.form.button) break; }
  }
  if (!found) return { ok: false, why: '机构登录的页面没有出现登录表单' };
  const { form, off, ctx } = found;
  if (form.extra.length) return { ok: false, why: '登录页除了账号和密码还要填别的（验证码？），要你自己登录一次' };
  if (!form.user || !form.button) return { ok: false, why: '登录页的样子和预想的不一样（找不到账号框或登录按钮）' };

  const click = async (p) => { const q = { x: p.x + off.x, y: p.y + off.y, button: 'left', clickCount: 1 };
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x, y: q.y }, sid);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...q }, sid);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...q }, sid); };
  const key = async (k, code, vk, modifiers = 0) => { for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }, sid); };
  await click(form.user); await sleepFn(400);
  await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8); await sleepFn(300);
  for (const ch of account) { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch }, sid); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid); await sleepFn(35); }
  await sleepFn(1500);
  let st = await c.evaluate(sid, FILLED, ctx);
  if (!st.filled) { await key('Tab', 'Tab', 9); await sleepFn(1500); st = await c.evaluate(sid, FILLED, ctx); }
  if (st.user !== account) return { ok: false, why: '账号没能填进登录页' };
  if (!st.filled) return { ok: false, why: `浏览器里没有存「${account}」的密码（在网页桌面的 Chromium 里登录一次并保存密码）` };
  await click(form.button);
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await sleepFn(1500);
    if (back()) return { ok: true, asked: true };
    if (await consent()) return { ok: false, why: CONSENT_WHY };
  }
  return { ok: false, why: '点了登录但没有回到出版商的网站（密码变了，或者登录页要验证）' };
}

module.exports = { signIn };
