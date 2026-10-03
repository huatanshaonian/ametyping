// The installable app and phone notifications, on the page side:
//   - registers the service worker (/sw.js): what notifications arrive through, and what lets Chrome install the site
//   - turns notifications on / off for this browser (a Web Push subscription kept by the server: server/push/)
//   - tells the server while this page is on screen (that device then gets no notifications: it shows it already)
//   - keeps Chrome's "install" offer for 控制面板 → 通知
//   - opens what a notification points at (#s=<machine|session>, #mail=<key>): on load, and when a tapped
//     notification hands this window its link
import * as net from './net.js';

const handlers = { s: null, mail: null };          // set by main.js: what to open for a session / a message
let reg = null, installOffer = null, sub = null;
const listeners = new Set();
const changed = () => { for (const fn of listeners) { try { fn(); } catch {} } };

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const canInstall = () => !!installOffer;
export const subscription = () => sub;
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// the device as people call it: 安卓 Chrome, iPhone Safari, Windows Edge...
export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? '安卓' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '设备';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return `${os} ${br}${installed() ? '（应用）' : ''}`;
}

const keyBytes = (b64u) => { const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function post(what, body) {
  try { const r = await fetch('/api/push/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return await r.json(); }
  catch { return { ok: false, msg: '请求失败' }; }
}
export async function info() { try { const r = await fetch('/api/push'); return r.ok ? await r.json() : null; } catch { return null; } }
// the server's id for this browser's subscription (sha256 of its endpoint, as server/push/index.js)
export async function myId() {
  if (!sub) return null;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function enable() {
  if (!supported()) return { ok: false, msg: '这个浏览器不支持网页通知（iPhone 要先「添加到主屏幕」，从主屏幕打开）' };
  if (!reg) reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
  if (!reg) return { ok: false, msg: '后台脚本没装上' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, msg: perm === 'denied' ? '通知被浏览器拦住了：到浏览器的网站设置里允许通知' : '没有允许通知' };
  const i = await info();
  if (!i) return { ok: false, msg: '连不上服务器' };
  try { sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(i.key) }); }
  catch (e) { return { ok: false, msg: '订阅失败：' + e.message }; }
  const r = await post('subscribe', { sub: sub.toJSON(), name: deviceName() });
  changed(); here();
  return r;
}
export async function disable() {
  const id = await myId();
  if (id) await post('remove', { id });
  try { if (sub) await sub.unsubscribe(); } catch {}
  sub = null; changed();
  return { ok: true };
}
export const update = (id, patch) => post('update', { id, ...patch });
export const remove = (id) => post('remove', { id });
export const test = (id) => post('test', { id });
export async function install() {
  if (!installOffer) return false;
  installOffer.prompt();
  const r = await installOffer.userChoice.catch(() => null);
  installOffer = null; changed();
  return !!(r && r.outcome === 'accepted');
}

// on screen or not: said when it changes and every 20 s while on screen
function here() {
  if (!sub) return;
  net.send({ t: 'push-here', endpoint: sub.endpoint, on: document.visibilityState === 'visible' && document.hasFocus() });
}

// what a link points at
export function route(handlersIn) { Object.assign(handlers, handlersIn); openHash(location.hash); }
function openHash(hash) {
  const m = /^#(s|mail)=(.+)$/.exec(hash || '');
  if (!m) return;
  const v = decodeURIComponent(m[2]);
  history.replaceState(null, '', location.pathname);              // (a reload does not open it again)
  if (m[1] === 's' && handlers.s) { const i = v.indexOf('|'); if (i > 0) handlers.s(v.slice(0, i), v.slice(i + 1)); }
  if (m[1] === 'mail' && handlers.mail) handlers.mail(v);
}

export async function start() {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installOffer = e; changed(); });
  addEventListener('appinstalled', () => { installOffer = null; changed(); });
  addEventListener('hashchange', () => openHash(location.hash));
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.t === 'open') openHash(new URL(e.data.url).hash); });
  reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
  if (reg && 'PushManager' in window) { try { sub = await reg.pushManager.getSubscription(); } catch {} }
  changed();
  document.addEventListener('visibilitychange', here);
  addEventListener('focus', here); addEventListener('blur', here);
  net.on('open', here);
  setInterval(() => { if (document.visibilityState === 'visible') here(); }, 20e3);
}
