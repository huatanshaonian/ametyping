// Taskbar: start button + 4-section cascading start menu (.mitem.has-sub + .msub), window dock buttons, and tray.
import { $, h, narrow } from './util.js';
import * as wm from './wm.js';
import * as net from './net.js';

const dock = $('#dock'), startBtn = $('#startbtn'), menu = $('#startmenu'), items = $('.items', menu);
const conn = $('#conn'), clock = $('#clock');

function closeAllSubs() {
  for (const w of items.querySelectorAll('.mitem.has-sub')) {
    w.classList.remove('open');
    const sub = $('.msub', w);
    if (sub) sub.hidden = true;
  }
}

function applyFallbackFlyout(wrap, sub) {
  // When components.css is merged, .msub already has its own position/display rules;
  // when running standalone before CSS merge, apply clean token-based flyout positioning.
  if (narrow()) {
    sub.style.cssText = 'padding-left:14px;border-top:1px dotted var(--edge);border-bottom:1px dotted var(--edge);background:var(--tint)';
    return;
  }
  const cs = getComputedStyle(sub);
  if (cs.position === 'static') {
    wrap.style.position = 'relative';
    sub.style.cssText = 'position:absolute;left:100%;bottom:-3px;min-width:196px;z-index:65;padding:3px 0;background:var(--body);border:2px solid var(--border);box-shadow:4px 4px 0 rgba(20,10,90,.35)';
  } else {
    sub.style.cssText = '';
  }
}

function openSubWrap(wrap) {
  for (const other of items.querySelectorAll('.mitem.has-sub')) {
    if (other !== wrap) {
      other.classList.remove('open');
      const oSub = $('.msub', other);
      if (oSub) oSub.hidden = true;
    }
  }
  const sub = $('.msub', wrap);
  if (!sub) return;
  wrap.classList.add('open');
  sub.hidden = false;
  applyFallbackFlyout(wrap, sub);
}

function buildLeaf(it) {
  return h('button', {
    class: 'smi mitem',
    type: 'button',
    disabled: !!it.disabled,
    title: it.hint || null,
    onclick: () => { closeMenu(); if (it.action) it.action(); },
  }, h('img', { src: it.icon, alt: '' }), h('span', { text: it.label }));
}

function buildMenuNode(it) {
  if (it === 'sep' || it === '-') return h('div', { class: 'smsep' });
  if (!Array.isArray(it.sub) || !it.sub.length) return buildLeaf(it);

  const sub = h('div', { class: 'msub', role: 'menu', hidden: true },
    ...it.sub.map((c) => (c === 'sep' || c === '-' ? h('div', { class: 'smsep' }) : buildLeaf(c)))
  );
  const arrow = h('span', { class: 'ar', style: 'margin-left:auto;font-size:10px;padding-left:6px', text: '▸' });
  const btn = h('button', {
    class: 'smi',
    type: 'button',
    disabled: !!it.disabled,
    title: it.hint || null,
  }, h('img', { src: it.icon, alt: '' }), h('span', { style: 'flex:1', text: it.label }), arrow);

  const wrap = h('div', { class: 'mitem has-sub' }, btn, sub);

  const onHoverOpen = () => {
    if (!narrow() && !it.disabled) openSubWrap(wrap);
  };
  wrap.addEventListener('mouseenter', onHoverOpen);
  wrap.addEventListener('pointerenter', onHoverOpen);
  wrap.addEventListener('mouseleave', () => {
    if (!narrow()) {
      wrap.classList.remove('open');
      sub.hidden = true;
    }
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const clickedArrow = e.target === arrow || arrow.contains(e.target);
    if (it.action && !narrow() && !clickedArrow) {
      closeMenu();
      it.action();
      return;
    }
    if (wrap.classList.contains('open')) {
      wrap.classList.remove('open');
      sub.hidden = true;
    } else {
      openSubWrap(wrap);
    }
  });
  return wrap;
}

// items: [{ icon, label, action, disabled, sub }] or 'sep'
export function setMenu(list) {
  items.replaceChildren(...list.map(buildMenuNode));
}

function closeMenu() {
  closeAllSubs();
  menu.hidden = true;
  startBtn.classList.remove('on');
}

startBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!menu.hidden) closeMenu();
  else {
    closeAllSubs();
    menu.hidden = false;
    startBtn.classList.add('on');
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && e.target !== startBtn && !startBtn.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// window buttons, kept in the order windows were opened
wm.onChange((list) => {
  const want = new Set(list.map((w) => w.id));
  for (const b of [...dock.children]) if (!want.has(b.dataset.id)) b.remove();
  for (const w of list) {
    let b = dock.querySelector(`[data-id="${CSS.escape(w.id)}"]`);
    if (!b) {
      b = h('button', { class: 'dockbtn', type: 'button', dataset: { id: w.id }, onclick: () => wm.toggle(w.id) }, h('img', { alt: '' }), h('span'));
      dock.append(b);
    }
    $('img', b).src = w.icon; $('span', b).textContent = w.title; b.title = w.title;
    b.classList.toggle('active', w.active); b.classList.toggle('min', w.minimized);
  }
});

net.on('status', (up) => { conn.textContent = up ? '已连接' : '重连中'; conn.classList.toggle('bad', !up); conn.title = up ? '已连接（点一下重新连接）' : '正在重连（点一下马上再试）'; });
// a click on it: connect again now (a connection that looks alive but brings nothing)
conn.setAttribute('role', 'button'); conn.tabIndex = 0;
const again = () => { conn.classList.add('busy'); setTimeout(() => conn.classList.remove('busy'), 900); net.reconnect(); };
conn.addEventListener('click', again);
conn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); again(); } });

function tick() { const d = new Date(); clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
tick(); setInterval(tick, 10e3);
