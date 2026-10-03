// Wallpaper: a few built-in pictures, one image of your own (kept in this browser's IndexedDB, never uploaded),
// and pictures the server downloaded from a URL (shared by every device). The choice is per browser.
import { $, h, prefs } from './util.js';
import * as sound from './sound.js';
import * as theme from './theme.js';

const desktop = $('#desktop');
// All from NEEDY GIRL OVERDOSE (as in amedesktop): the boot screen, and fan art the game shows on its ego-search
// screen -- named after the artist's handle, keep them credited. "たて" is portrait (@eight_illust): in 适应 mode the
// side colours sampled from its edges fill the rest instead of plain bars.
const BUILTIN = [
  { id: 'pc', name: 'ぴんく', url: '/wall/pc_wallpaper.png', color: '#f7e1fb', pos: 'center top' },
  { id: 'boot', name: 'Windose20', url: '/wall/windose20.webp', color: '#7a5aa8' },
  { id: 'soda', name: '@sleep_soda_', url: '/wall/illust_sleep_soda.webp', color: '#8e8a99' },
  { id: 'inaba', name: '@bike_inaba', url: '/wall/illust_bike_inaba.webp', color: '#fdf6dc' },
  { id: 'usagi', name: '@kusari_usagi', url: '/wall/illust_kusari_usagi.webp', color: '#6f6a66' },
  { id: 'mashiro', name: '@ma_shiro0268', url: '/wall/illust_mashiro.webp', color: '#d9d6ec' },
  { id: 'haru', name: '@haru000000man', url: '/wall/illust_haru.webp', color: '#f4eee3' },
  { id: 'furagumi', name: '@furagumi1112', url: '/wall/illust_furagumi.webp', color: '#f4b8d2' },
  { id: 'tate', name: 'たて（@eight_illust）', url: '/wall/tate_eight_illust.png', color: '#3a262a',
    sides: ['#d3a1a1 8%,#865e66 25%,#915355 42%,#5b2323 58%,#3a262a 75%,#877d7d 92%',
      '#a25051 8%,#808f7f 25%,#6f9075 42%,#657264 58%,#3e383b 75%,#733a3a 92%'] },
  { id: 'plain', name: '纯色', url: null, color: '#f7e1fb' },
  { id: 'teal', name: 'Windows 青色', url: null, color: '#008080' },
];
// how the picture covers the desktop (like Win98's 显示属性): 填充 is the default -- no bars, the edges are cropped
export const MODES = [['fill', '填充'], ['fit', '适应'], ['stretch', '拉伸'], ['center', '居中'], ['tile', '平铺']];
function css(w, mode) {
  if (!w.url) return w.color;
  const u = `url("${w.url}")`;
  switch (mode) {
    case 'fit': return w.sides
      ? `${u} center / contain no-repeat, linear-gradient(180deg, ${w.sides[0]}) left center / 50.5% 100% no-repeat, ${w.color} linear-gradient(180deg, ${w.sides[1]}) right center / 50.5% 100% no-repeat`
      : `${w.color} ${u} center / contain no-repeat`;
    case 'stretch': return `${w.color} ${u} center / 100% 100% no-repeat`;
    case 'center': return `${w.color} ${u} center / auto no-repeat`;
    case 'tile': return `${w.color} ${u} left top / auto repeat`;
    default: return `${w.color} ${u} ${w.pos || 'center'} / cover no-repeat`;
  }
}
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
  if (customUrl) out.push({ id: 'custom', name: '我的图片', url: customUrl, color: '#222' });
  for (const s of server) out.push({ id: 'srv:' + s.name, name: s.name.replace(/^(\d{4})(\d{2})(\d{2})-.*/, '网络 $2-$3'), url: s.url, color: '#241640', server: s.name });
  return out;
}
export function apply() {
  const id = prefs.get('wall', 'pc');
  const w = catalog().find((x) => x.id === id) || BUILTIN[0];
  desktop.style.background = css(w, prefs.get('wallMode', 'fill'));
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
// 显示属性 lives in 控制面板 (apps/control.js): this opens it there
export function openSettings() { import('./apps/control.js').then((c) => c.open('display')); }

// the 显示属性 page itself, for 控制面板: { root }
export function settingsPanel() {
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
    h('div', { class: 'th', style: `background:${css(w, 'fill')}` }),
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
  const mode = h('select', { class: 'field', title: '显示方式' },
    ...MODES.map(([v, l]) => h('option', { value: v, text: l, selected: prefs.get('wallMode', 'fill') === v })));
  mode.addEventListener('change', () => { prefs.set('wallMode', mode.value); apply(); });
  const content = h('div', {},
    h('div', { class: 'wallbar', style: 'border-top:0;border-bottom:1px dotted var(--edge)' },
      h('span', { text: '配色方案：' }), theme.picker(() => { apply(); render(); }),
      h('span', { text: '界面大小：' }), theme.scalePicker(), h('span', { text: '显示方式：' }), mode,
      h('span', { style: 'font-size:12px;opacity:.65', text: '填充：铺满不留边（裁掉多余部分）；适应：完整显示' })),
    grid,
    h('div', { class: 'wallbar' }, url, fetchBtn, h('button', { class: 'btn', type: 'button', text: '本地图片…', onclick: () => file.click() }), file),
    msg);
  return { root: content };
}
