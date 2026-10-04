// Right-click menus (long press on touch screens), Win98 style, with one level of submenus.
//   attach(el, (e) => items | null)   items: [{ label, onClick, check, disabled, sub: items }, '-', ...]
//   show(clientX, clientY, items)
import { h, zoom } from './util.js';

let menus = [];                                            // the open menu and its submenu
// a menu opened by a long press appears under the finger: some phones send a click when it lifts, which would pick the
// item there at once -- for a moment after such an opening, items do not react
let armedAt = 0;
const ARM_MS = 450;
const armed = () => Date.now() - armedAt >= ARM_MS;
const LONG_MS = 520;

export function close() { for (const m of menus) m.remove(); menus = []; }

// touch: opened by a finger (a long press, the ⋯ button): see armedAt
export function show(cx, cy, items, { touch = false } = {}) {
  close();
  armedAt = touch ? Date.now() : 0;
  const z = zoom();                                        // pointer px -> page px (the size setting zooms the page)
  open(items, cx / z, cy / z, 0);
}

function open(items, x, y, level, fromRight) {
  const el = h('div', { class: 'ctxm', role: 'menu' });
  for (const it of items) {
    if (it === '-') { el.append(h('div', { class: 'ctxsep' })); continue; }
    const b = h('button', { class: 'ctxi' + (it.sub ? ' has-sub' : ''), type: 'button', role: 'menuitem', disabled: !!it.disabled },
      h('span', { class: 'ck', text: it.check ? '✓' : '' }), h('span', { class: 'lb', text: it.label }), it.sub ? h('span', { class: 'ar', text: '▸' }) : null);
    b.addEventListener('mouseenter', () => b.focus({ preventScroll: true }));   // (the mouse and the keys mark the same item)
    if (it.sub) {
      const openSub = () => {
        if (b.classList.contains('open') || !armed()) return;
        for (const s of el.querySelectorAll('.ctxi.open')) s.classList.remove('open');
        menus.slice(level + 1).forEach((m) => m.remove()); menus = menus.slice(0, level + 1);
        b.classList.add('open');
        const r = b.getBoundingClientRect(), z = zoom();
        open(it.sub, r.right / z - 2, r.top / z - 3, level + 1, r.left / z + 2);
      };
      b.addEventListener('mouseenter', openSub);
      b.addEventListener('click', openSub);
    } else {
      b.addEventListener('mouseenter', () => {
        for (const s of el.querySelectorAll('.ctxi.open')) s.classList.remove('open');
        menus.slice(level + 1).forEach((m) => m.remove()); menus = menus.slice(0, level + 1);
      });
      b.addEventListener('click', () => { if (!armed()) return; close(); if (it.onClick) it.onClick(); });
    }
    el.append(b);
  }
  document.body.append(el);
  menus.push(el);
  // keep it on screen: flip left / up when it would run off the page
  const W = innerWidth / zoom(), H = innerHeight / zoom(), w = el.offsetWidth, hgt = el.offsetHeight;
  let left = x, top = y;
  if (left + w > W - 2) left = fromRight != null ? fromRight - w : W - w - 2;
  if (top + hgt > H - 2) top = Math.max(2, H - hgt - 2);
  el.style.left = Math.max(2, left) + 'px'; el.style.top = top + 'px';
  return el;
}

// right click, or a long press without moving on a touch screen; the click after a long press is swallowed
export function attach(el, itemsFor) {
  let timer = null, sx = 0, sy = 0, longAt = 0, touchAt = 0;
  const fire = (e, x, y, touch) => { const items = itemsFor(e); if (items && items.length) { show(x, y, items, { touch }); return true; } return false; };
  el.addEventListener('contextmenu', (e) => {
    if (Date.now() - longAt < 800) { e.preventDefault(); return; }
    // (a phone's own long-press menu event: it comes while the finger is down)
    const touch = Date.now() - touchAt < 1500;
    if (fire(e, e.clientX, e.clientY, touch)) { e.preventDefault(); if (touch) { longAt = Date.now(); clearTimeout(timer); timer = null; } }
  });
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; touchAt = Date.now();
    const target = e.target;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (fire({ target }, sx, sy, true)) longAt = Date.now(); }, LONG_MS);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (timer && Math.hypot(t.clientX - sx, t.clientY - sy) > 14) { clearTimeout(timer); timer = null; } }, { passive: true });
  el.addEventListener('touchcancel', () => { clearTimeout(timer); timer = null; }, { passive: true });
  el.addEventListener('touchend', (e) => { clearTimeout(timer); timer = null; if (Date.now() - longAt < 800) e.preventDefault(); });
  el.addEventListener('click', (e) => { if (Date.now() - longAt < 800) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// a click / tap anywhere else, Escape, or the window changing closes it
addEventListener('pointerdown', (e) => { if (menus.length && !menus.some((m) => m.contains(e.target))) close(); }, true);
// the keyboard, while a menu is open: ↑ ↓ choose, → or Enter opens a submenu, ← goes back, Enter / Space runs, Esc closes
addEventListener('keydown', (e) => {
  if (!menus.length) return;
  const menu = menus[menus.length - 1];
  const items = [...menu.querySelectorAll('.ctxi:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  const done = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Escape') { close(); done(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = items.length; if (!n) return done();
    items[at < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
    done();
  } else if ((e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') && at >= 0 && items[at].classList.contains('has-sub')) {
    items[at].click();                                   // opens it
    const sub = menus[menus.length - 1];
    if (sub !== menu) { const first = sub.querySelector('.ctxi:not(:disabled)'); if (first) first.focus(); }
    done();
  } else if (e.key === 'ArrowLeft' && menus.length > 1) {
    menus.pop().remove();
    const parent = menus[menus.length - 1], open = parent.querySelector('.ctxi.open');
    if (open) { open.classList.remove('open'); open.focus(); }
    done();
  } else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { items[at].click(); done(); }
}, true);
addEventListener('resize', close);
addEventListener('blur', close);
