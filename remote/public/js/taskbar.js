// Taskbar: start button + menu, one button per open window, tray (network panel toggle on phones, connection, clock).
import { $, h } from './util.js';
import * as wm from './wm.js';
import * as net from './net.js';

const dock = $('#dock'), startBtn = $('#startbtn'), menu = $('#startmenu'), items = $('.items', menu);
const conn = $('#conn'), clock = $('#clock');

// items: [{ icon, label, action, disabled }] or 'sep'
export function setMenu(list) {
  items.replaceChildren(...list.map((it) => (it === 'sep' ? h('div', { class: 'smsep' })
    : h('button', { class: 'smi', type: 'button', disabled: !!it.disabled, title: it.hint || null,
      onclick: () => { closeMenu(); it.action(); } }, h('img', { src: it.icon, alt: '' }), h('span', { text: it.label })))));
}
function closeMenu() { menu.hidden = true; startBtn.classList.remove('on'); }
startBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; startBtn.classList.toggle('on', !menu.hidden); });
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== startBtn && !startBtn.contains(e.target)) closeMenu(); });
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
