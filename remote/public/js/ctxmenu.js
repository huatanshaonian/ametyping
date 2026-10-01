// Right-click menus (long press on touch screens), Win98 style, with one level of submenus.
//   attach(el, (e) => items | null)   items: [{ label, onClick, check, disabled, sub: items }, '-', ...]
//   show(clientX, clientY, items)
import { h, zoom } from './util.js';

let menus = [];                                            // the open menu and its submenu
const LONG_MS = 520;

export function close() { for (const m of menus) m.remove(); menus = []; }

export function show(cx, cy, items) {
  close();
  const z = zoom();                                        // pointer px -> page px (the size setting zooms the page)
  open(items, cx / z, cy / z, 0);
}

function open(items, x, y, level, fromRight) {
  const el = h('div', { class: 'ctxm', role: 'menu' });
  for (const it of items) {
    if (it === '-') { el.append(h('div', { class: 'ctxsep' })); continue; }
    const b = h('button', { class: 'ctxi' + (it.sub ? ' has-sub' : ''), type: 'button', role: 'menuitem', disabled: !!it.disabled },
      h('span', { class: 'ck', text: it.check ? '✓' : '' }), h('span', { class: 'lb', text: it.label }), it.sub ? h('span', { class: 'ar', text: '▸' }) : null);
    if (it.sub) {
      const openSub = () => {
        if (b.classList.contains('open')) return;
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
      b.addEventListener('click', () => { close(); if (it.onClick) it.onClick(); });
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
  let timer = null, sx = 0, sy = 0, longAt = 0;
  const fire = (e, x, y) => { const items = itemsFor(e); if (items && items.length) { show(x, y, items); return true; } return false; };
  el.addEventListener('contextmenu', (e) => {
    if (Date.now() - longAt < 800) { e.preventDefault(); return; }
    if (fire(e, e.clientX, e.clientY)) e.preventDefault();
  });
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
    const target = e.target;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (fire({ target }, sx, sy)) longAt = Date.now(); }, LONG_MS);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (timer && Math.hypot(t.clientX - sx, t.clientY - sy) > 10) { clearTimeout(timer); timer = null; } }, { passive: true });
  el.addEventListener('touchend', (e) => { clearTimeout(timer); timer = null; if (Date.now() - longAt < 800) e.preventDefault(); });
  el.addEventListener('click', (e) => { if (Date.now() - longAt < 800) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// a click / tap anywhere else, Escape, or the window changing closes it
addEventListener('pointerdown', (e) => { if (menus.length && !menus.some((m) => m.contains(e.target))) close(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && menus.length) close(); });
addEventListener('resize', close);
addEventListener('blur', close);
