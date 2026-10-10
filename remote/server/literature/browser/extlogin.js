// Signing in to the website of the library's access extension (MyLOFT), when both the extension and its website have
// lost their login -- in the browser's own profile, as signin.js does for a publisher:
//   - the account's name (settings "myloftAccount", an e-mail address -- never a password) is typed into the page;
//   - 继续 is pressed, and the page shows its password box, which the browser's password manager fills with the
//     password it has saved for that name;
//   - 登录 is pressed, once.
// Anything else to fill in (a captcha), no password filled, or a page that stays on the login: it stops there and
// says so. The password is never read, typed or stored by this module. Once the website is signed in, the extension
// takes its login from it (library.js: revive).
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the login page. -> { mail: { at, value } | null, pass: { filled } | null, next: at | null, login: at | null, extra: [names] }
const FORM = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const mid = (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const all = [...document.querySelectorAll('input')].filter(vis);
  const m = all.find((e) => e.type === 'email') || all.find((e) => e.type === 'text'), p = all.find((e) => e.type === 'password');
  const btn = (words) => { const b = [...document.querySelectorAll('button, input[type=submit]')].filter(vis).find((e) => words.includes((e.innerText || e.value || '').trim()) && !e.disabled); return b ? mid(b) : null; };
  let filled = false; try { filled = !!p && p.matches(':autofill') && p.value.length > 0; } catch (e) {}
  return { mail: m ? { at: mid(m), value: m.value } : null, pass: p ? { filled } : null, next: btn(['继续', 'Continue', 'Next']), login: btn(['登录', 'Login', 'Log in', 'Sign in']),
    extra: all.filter((e) => e !== m && e !== p && !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(e.type)).map((e) => e.name || e.id || e.placeholder || e.type) };
})()`;

// siteLogin(c, sid, { account, loginPath }) on a tab showing the login page -> { ok: true } | { ok: false, why }
async function siteLogin(c, sid, { account, loginPath = '/user/login', waitMs = 30e3, sleepFn = sleep }) {
  const form = () => c.evaluate(sid, FORM).catch(() => ({}));
  const click = async (p) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid); };
  const key = async (k, code, vk, modifiers = 0) => { for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }, sid); };
  let f = await form();
  if (!f.mail) return { ok: false, why: '登录页的样子和预想的不一样（找不到填邮箱的地方）' };
  await click(f.mail.at); await sleepFn(400);
  await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8); await sleepFn(300);
  for (const ch of account) { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch }, sid); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid); await sleepFn(35); }
  await sleepFn(1200);
  f = await form();
  if (!f.mail || f.mail.value !== account) return { ok: false, why: '账号没能填进登录页' };
  if (!f.pass) {
    if (!f.next) return { ok: false, why: '登录页的样子和预想的不一样（填了邮箱之后没有「继续」）' };
    await click(f.next);
    for (const until = Date.now() + waitMs; Date.now() < until && !f.pass;) { await sleepFn(1000); f = await form(); }
  }
  // (the browser fills the box a moment after it appears)
  for (let i = 0; f.pass && !f.pass.filled && i < 4; i++) { await sleepFn(1000); f = await form(); }
  if (!f.pass) return { ok: false, why: '点了「继续」之后没有出现填密码的地方（账号不对？）' };
  if (f.extra && f.extra.length) return { ok: false, why: '登录页除了账号和密码还要填别的（验证码？），要你自己登录一次' };
  if (!f.pass.filled) return { ok: false, why: `浏览器里没有存「${account}」的密码（在网页桌面的 Chromium 里登录一次并保存密码）` };
  if (!f.login) return { ok: false, why: '登录页的样子和预想的不一样（找不到登录按钮）' };
  await click(f.login);
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await sleepFn(1500);
    const at = await c.evaluate(sid, 'location.href').catch(() => '');
    if (at && !at.includes(loginPath)) return { ok: true };
  }
  return { ok: false, why: '点了登录但还停在登录页（密码变了，或者要验证）' };
}

module.exports = { siteLogin };
