// 画板's gallery: every board as a card (a small picture of what is drawn on it, its name, when it was last drawn
// on), newest first, with one card to start a new board. The pictures are drawn here from each board's strokes, only
// for the cards that come into view, and kept until that board changes.
import { h } from '../util.js';
import { bounds, extent, picture } from './board-ink.js';

const SIDE = 520, PAD = 24;                        // the picture's longer side in canvas pixels; the margin, in board units
const pad = (n) => String(n).padStart(2, '0');
function when(t) {
  const d = new Date(t), now = new Date();
  const day = d.toDateString() === now.toDateString() ? '今天' : `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-'}${d.getMonth() + 1}-${d.getDate()}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// { onOpen(id), onNew() } -> { el, show(items, currentId) }
export function createGallery({ onOpen, onNew }) {
  const el = h('div', { class: 'bd-gal' });
  const made = new Map();                          // id -> { updated, canvas | null (nothing drawn) }
  let seen = null;

  async function draw(card, b) {
    const box = card.querySelector('.bg-pic');
    let m = made.get(b.id);
    if (!m || m.updated !== b.updated) {
      let doc = null; try { const r = await fetch('/api/board?id=' + encodeURIComponent(b.id)); if (r.ok) doc = (await r.json()).doc; } catch {}
      if (!doc) return;
      const strokes = (doc.strokes || []).map((s) => { const x = { t: s.t, c: s.c, w: s.w, p: s.p }; x.bb = bounds(x); return x; });
      const e = extent(strokes);
      m = { updated: b.updated, canvas: e ? picture(strokes, [e[0] - PAD, e[1] - PAD, e[2] + PAD, e[3] + PAD], SIDE) : null };
      made.set(b.id, m);
    }
    if (!box.isConnected) return;
    box.replaceChildren(m.canvas || h('span', { class: 'bg-none', text: '空白' }));
  }

  function show(items, current) {
    if (seen) seen.disconnect();
    seen = new IntersectionObserver((list) => {
      for (const x of list) if (x.isIntersecting) { seen.unobserve(x.target); draw(x.target, x.target.board); }
    }, { root: el, rootMargin: '200px' });
    for (const id of made.keys()) if (!items.some((b) => b.id === id)) made.delete(id);
    const cards = items.map((b) => {
      const card = h('button', { class: 'bg-card' + (b.id === current ? ' sel' : ''), type: 'button', title: '打开这块画板', dataset: { id: b.id }, onclick: () => onOpen(b.id) },
        h('div', { class: 'bg-pic' }),
        h('div', { class: 'bg-name', text: b.title }),
        h('div', { class: 'bg-info', text: `${when(b.updated)} · ${b.strokes || 0} 笔` }));
      card.board = b;
      seen.observe(card);
      return card;
    });
    el.replaceChildren(
      h('button', { class: 'bg-card bg-new', type: 'button', title: '新建一块画板', onclick: onNew }, h('div', { class: 'bg-pic' }, h('span', { class: 'bg-plus', text: '＋' })), h('div', { class: 'bg-name', text: '新画板' }), h('div', { class: 'bg-info', text: ' ' })),
      ...cards);
  }
  return { el, show, destroy() { if (seen) seen.disconnect(); } };
}
