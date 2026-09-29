// Window manager for the desktop: the game's window frame, drag by the title bar, resize from the corner,
// minimize / maximize / close, focus order. Windows live in #windows (the area left of the network panel and
// above the taskbar). On narrow screens every window is maximized. Ported from amedesktop's launcher.
import { $, h, narrow } from './util.js';

const layer = $('#windows');
const ICONS_W = 108;                     // new windows open right of the desktop icon column
const wins = new Map();                  // id -> { id, el, body, title, icon, minimized, maxed, prev, onClose }
let zTop = 10, activeId = null;
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); fn(list()); }
function changed() { const l = list(); for (const fn of listeners) fn(l); }
export function list() {
  return [...wins.values()].map((w) => ({ id: w.id, title: w.title, icon: w.icon, minimized: w.minimized, active: w.id === activeId && !w.minimized }));
}
export const has = (id) => wins.has(id);
export const get = (id) => wins.get(id);

const area = () => ({ w: layer.clientWidth, h: layer.clientHeight });
function clamp(w) {
  if (w.maxed) return;
  const a = area(), el = w.el;
  const width = Math.min(el.offsetWidth, a.w), height = Math.min(el.offsetHeight, a.h);
  if (width !== el.offsetWidth) el.style.width = width + 'px';
  if (height !== el.offsetHeight) el.style.height = height + 'px';
  el.style.left = Math.max(0, Math.min(el.offsetLeft, a.w - width)) + 'px';
  el.style.top = Math.max(0, Math.min(el.offsetTop, a.h - height)) + 'px';
}

// open (or bring back) a window; returns its record { id, el, body, setTitle, close, focus }
export function open({ id, title, icon, content, width = 640, height = 440, onClose }) {
  if (wins.has(id)) { restore(id); return wins.get(id).handle; }
  const body = h('div', { class: 'content' });
  if (content) body.append(content);
  const el = h('div', { class: 'win' },
    h('div', { class: 'titlebar' }, h('img', { src: icon, alt: '' }), h('div', { class: 'title', text: title })),
    h('div', { class: 'tbtns' },
      h('button', { class: 'tbtn', type: 'button', title: '最小化', text: '–', onclick: (e) => { e.stopPropagation(); minimize(id); } }),
      h('button', { class: 'tbtn', type: 'button', title: '最大化', text: '□', onclick: (e) => { e.stopPropagation(); toggleMax(id); } }),
      h('button', { class: 'tbtn close', type: 'button', title: '关闭', text: '×', onclick: (e) => { e.stopPropagation(); close(id); } })),
    body, h('div', { class: 'resize', dataset: { dir: 'se' } }),
    ...['n', 's', 'e', 'w', 'ne', 'nw', 'sw'].map((d) => h('div', { class: 'rz rz-' + d, dataset: { dir: d } })));
  const a = area(), n = wins.size % 6;
  const width2 = Math.min(width, a.w - 12), height2 = Math.min(height, a.h - 12);
  Object.assign(el.style, { width: width2 + 'px', height: height2 + 'px',
    left: Math.max(0, Math.min(ICONS_W + n * 26, a.w - width2)) + 'px', top: Math.max(0, Math.min(16 + n * 22, a.h - height2)) + 'px' });
  layer.append(el);
  const w = { id, el, body, title, icon, minimized: false, maxed: false, prev: null, onClose };
  w.handle = { id, el, body, setTitle: (t) => { w.title = t; $('.title', el).textContent = t; changed(); }, close: () => close(id), focus: () => focus(id) };
  wins.set(id, w);
  $('.titlebar', el).addEventListener('dblclick', () => toggleMax(id));
  el.addEventListener('pointerdown', () => focus(id));
  dragMove($('.titlebar', el), w);
  for (const g of el.querySelectorAll('[data-dir]')) dragResize(g, w, g.dataset.dir);
  if (narrow()) maximize(w);
  focus(id);
  return w.handle;
}

export function focus(id) {
  const w = wins.get(id); if (!w) return;
  activeId = id;
  for (const x of wins.values()) x.el.classList.toggle('inactive', x.id !== id);
  w.el.style.zIndex = ++zTop;
  changed();
}
export function minimize(id) {
  const w = wins.get(id); if (!w) return;
  w.minimized = true; w.el.classList.add('minimized');
  if (activeId === id) activeId = null;
  changed();
}
export function restore(id) {
  const w = wins.get(id); if (!w) return;
  w.minimized = false; w.el.classList.remove('minimized');
  focus(id);
}
function maximize(w) {
  w.el.style.transform = '';
  w.prev = { left: w.el.style.left, top: w.el.style.top, width: w.el.style.width, height: w.el.style.height };
  w.el.classList.add('max'); w.maxed = true;
  Object.assign(w.el.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
}
export function toggleMax(id) {
  const w = wins.get(id); if (!w) return;
  if (!w.maxed) maximize(w);
  else if (!narrow()) { w.el.classList.remove('max'); w.maxed = false; Object.assign(w.el.style, w.prev); clamp(w); }
  focus(id);
}
export function close(id) {
  const w = wins.get(id); if (!w) return;
  wins.delete(id);
  w.el.remove();
  if (activeId === id) activeId = null;
  try { w.onClose && w.onClose(); } catch (e) { console.error(e); }
  changed();
}
// taskbar button: minimized -> show; in front -> minimize; behind -> bring to front
export function toggle(id) {
  const w = wins.get(id); if (!w) return;
  if (w.minimized) restore(id);
  else if (activeId === id) minimize(id);
  else focus(id);
}

// drag by the title bar: move with translate3d inside rAF, settle into left/top on release
function dragMove(handle, w) {
  let sx = 0, sy = 0, ox = 0, oy = 0, nx = 0, ny = 0, ow = 0, oh = 0, drag = false, raf = 0;
  const paint = () => { raf = 0; if (drag) w.el.style.transform = `translate3d(${nx - ox}px,${ny - oy}px,0)`; };
  handle.addEventListener('pointerdown', (e) => {
    if (w.maxed || e.button !== 0 || e.target.closest('.tbtn')) return;
    drag = true; handle.style.cursor = 'grabbing';
    sx = e.clientX; sy = e.clientY; ox = nx = w.el.offsetLeft; oy = ny = w.el.offsetTop; ow = w.el.offsetWidth; oh = w.el.offsetHeight;
    w.el.style.willChange = 'transform';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const a = area();
    nx = Math.max(-ow + 60, Math.min(a.w - 60, ox + e.clientX - sx));      // keep a grip of the title bar on screen
    ny = Math.max(0, Math.min(a.h - 30, oy + e.clientY - sy));
    if (!raf) raf = requestAnimationFrame(paint);
  });
  const end = () => {
    if (!drag) return;
    drag = false; handle.style.cursor = '';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    Object.assign(w.el.style, { transform: '', willChange: '', left: nx + 'px', top: ny + 'px' });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
// resize from any edge or corner (dir: n s e w ne nw se sw), like a real window; the opposite side stays put
const MIN_W = 240, MIN_H = 160;
function dragResize(handle, w, dir) {
  let sx = 0, sy = 0, o = null, n = null, rz = false, raf = 0;
  const paint = () => { raf = 0; if (rz) apply(); };
  const apply = () => Object.assign(w.el.style, { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' });
  handle.addEventListener('pointerdown', (e) => {
    if (w.maxed || e.button !== 0) return;
    e.stopPropagation(); rz = true;
    sx = e.clientX; sy = e.clientY;
    o = { x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight }; n = { ...o };
    handle.setPointerCapture(e.pointerId); focus(w.id);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!rz) return;
    const a = area(), dx = e.clientX - sx, dy = e.clientY - sy;
    if (dir.includes('e')) n.w = Math.min(a.w - o.x, Math.max(MIN_W, o.w + dx));
    if (dir.includes('s')) n.h = Math.min(a.h - o.y, Math.max(MIN_H, o.h + dy));
    if (dir.includes('w')) { const x = Math.min(o.x + o.w - MIN_W, Math.max(0, o.x + dx)); n.x = x; n.w = o.x + o.w - x; }
    if (dir.includes('n')) { const y = Math.min(o.y + o.h - MIN_H, Math.max(0, o.y + dy)); n.y = y; n.h = o.y + o.h - y; }
    if (!raf) raf = requestAnimationFrame(paint);
  });
  const end = () => {
    if (!rz) return;
    rz = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    apply();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// the screen changed size (rotation, window resize): keep windows inside; narrow screens maximize everything
let resizeT = null;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { for (const w of wins.values()) { if (narrow() && !w.maxed) maximize(w); else clamp(w); } }, 120);
});
