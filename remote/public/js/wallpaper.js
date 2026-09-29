// Wallpaper: a few built-in pictures, one image of your own (kept in this browser's IndexedDB, never uploaded),
// and pictures the server downloaded from a URL (shared by every device). The choice is per browser.
import { $, h, prefs } from './util.js';
import * as wm from './wm.js';
import * as sound from './sound.js';

const desktop = $('#desktop');
// All from NEEDY GIRL OVERDOSE (as in amedesktop): the boot screen, and fan art the game shows on its ego-search
// screen -- named after the artist's handle, keep them credited. "たて" is portrait (@eight_illust): shown at full
// height with the side colours sampled from its edges filling the rest.
const cover = (color, url, pos = 'center') => `${color} url("${url}") ${pos} / cover no-repeat`;
const TATE_L = '#d3a1a1 8%,#865e66 25%,#915355 42%,#5b2323 58%,#3a262a 75%,#877d7d 92%';
const TATE_R = '#a25051 8%,#808f7f 25%,#6f9075 42%,#657264 58%,#3e383b 75%,#733a3a 92%';
const BUILTIN = [
  { id: 'pc', name: 'ぴんく', css: cover('#f7e1fb', '/wall/pc_wallpaper.png', 'center top') },
  { id: 'boot', name: 'Windose20', css: cover('#7a5aa8', '/wall/windose20.webp') },
  { id: 'soda', name: '@sleep_soda_', css: cover('#8e8a99', '/wall/illust_sleep_soda.webp') },
  { id: 'inaba', name: '@bike_inaba', css: cover('#fdf6dc', '/wall/illust_bike_inaba.webp') },
  { id: 'usagi', name: '@kusari_usagi', css: cover('#6f6a66', '/wall/illust_kusari_usagi.webp') },
  { id: 'mashiro', name: '@ma_shiro0268', css: cover('#d9d6ec', '/wall/illust_mashiro.webp') },
  { id: 'haru', name: '@haru000000man', css: cover('#f4eee3', '/wall/illust_haru.webp') },
  { id: 'furagumi', name: '@furagumi1112', css: cover('#f4b8d2', '/wall/illust_furagumi.webp') },
  { id: 'tate', name: 'たて（@eight_illust）', css: `url("/wall/tate_eight_illust.png") center / auto 100% no-repeat, linear-gradient(180deg, ${TATE_L}) left center / 50.5% 100% no-repeat, #3a262a linear-gradient(180deg, ${TATE_R}) right center / 50.5% 100% no-repeat` },
  { id: 'plain', name: '纯色', css: '#f7e1fb' },
];
let server = [];                           // [{ name, url }] downloaded by the server
let customUrl = null;                      // object URL of the local picture

// ---- the local picture in IndexedDB ----
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('ame-wallpaper', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('img', mode), req = fn(tx.objectStore('img'));
    tx.oncomplete = () => resolve(req && req.result); tx.onerror = () => reject(tx.error);
  });
}
async function loadCustom() {
  try { const blob = await idb('readonly', (s) => s.get('custom')); if (blob) { if (customUrl) URL.revokeObjectURL(customUrl); customUrl = URL.createObjectURL(blob); } } catch {}
}

function catalog() {
  const out = BUILTIN.slice();
  if (customUrl) out.push({ id: 'custom', name: '我的图片', css: cover('#222', customUrl) });
  for (const s of server) out.push({ id: 'srv:' + s.name, name: s.name.replace(/^(\d{4})(\d{2})(\d{2})-.*/, '网络 $2-$3'), css: cover('#241640', s.url), server: s.name });
  return out;
}
export function apply() {
  const id = prefs.get('wall', 'pc');
  const w = catalog().find((x) => x.id === id) || BUILTIN[0];
  desktop.style.background = w.css;
}
async function refreshServer() {
  try { const r = await fetch('/api/walls'); if (r.ok) server = (await r.json()).items || []; } catch {}
}
export async function init() {
  apply();                                  // built-ins right away; the rest when known
  await Promise.all([loadCustom(), refreshServer()]);
  apply();
}

// ---- 显示属性 window ----
export function openSettings() {
  const grid = h('div', { class: 'walls' });
  const msg = h('div', { class: 'wallmsg' });
  const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };
  const url = h('input', { class: 'field', type: 'url', placeholder: 'https://… 图片网址，由服务器下载保存' });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const fetchBtn = h('button', { class: 'btn go', type: 'button', text: '下载' });

  function render() {
    const cur = prefs.get('wall', 'pc');
    grid.replaceChildren(...catalog().map((w) => h('div', { class: 'wall' + (w.id === cur ? ' sel' : ''), role: 'button', tabindex: 0, title: w.name,
      onclick: () => { prefs.set('wall', w.id); apply(); render(); } },
    h('div', { class: 'th', style: `background:${w.css}` }),
    h('div', { class: 'nm', text: w.name }),
    w.server ? h('button', { class: 'del', type: 'button', title: '从服务器删除', text: '×', onclick: (e) => { e.stopPropagation(); del(w); } }) : null)));
  }
  async function del(w) {
    if (!confirm(`从服务器删除这张壁纸？（所有设备都看不到它了）`)) return;
    const r = await fetch('/api/wall/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: w.server }) });
    if (r.ok) { sound.play('recycle'); if (prefs.get('wall') === w.id) prefs.set('wall', 'pc'); await refreshServer(); apply(); render(); say('已删除'); }
    else say('删除失败', true);
  }
  fetchBtn.addEventListener('click', async () => {
    if (!url.value.trim()) return;
    fetchBtn.disabled = true; say('服务器下载中…');
    let d = {};
    try { const r = await fetch('/api/wall/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value.trim() }) }); d = await r.json(); }
    catch { d = { ok: false, msg: '请求失败' }; }
    fetchBtn.disabled = false;
    if (!d.ok) return say(d.msg || '下载失败', true);
    url.value = ''; await refreshServer();
    prefs.set('wall', 'srv:' + d.name); apply(); render(); say('已下载并设为壁纸');
  });
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return say('请选择图片文件', true);
    try { await idb('readwrite', (s) => s.put(f, 'custom')); await loadCustom(); prefs.set('wall', 'custom'); apply(); render(); say('已设为壁纸（只保存在这个浏览器里）'); }
    catch { say('这个浏览器不能保存图片', true); }
  });

  render();
  const content = h('div', {},
    grid,
    h('div', { class: 'wallbar' }, url, fetchBtn, h('button', { class: 'btn', type: 'button', text: '本地图片…', onclick: () => file.click() }), file),
    msg);
  wm.open({ id: 'display', title: '显示属性', icon: '/icons/display_properties-16.png', content, width: 560, height: 420 });
}
