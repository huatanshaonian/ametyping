// The desktop of the current computer: its icons (click selects, double-click opens; a tap opens on touch screens)
// and the name / state of the computer in the corner.
import { $, h } from './util.js';

const box = $('#icons'), mark = $('#mark');
const touch = matchMedia('(pointer: coarse)').matches;

// icons: [{ id, label, icon, open, disabled, hint }]
export function setIcons(icons) {
  box.replaceChildren(...icons.map((it) => {
    const el = h('button', { class: 'dicon' + (it.disabled ? ' off' : ''), type: 'button', role: 'listitem', title: it.hint || it.label, dataset: { id: it.id } },
      h('img', { src: it.icon, alt: '' }), h('span', { text: it.label }));
    el.addEventListener('click', (e) => { e.stopPropagation(); select(el); if (touch) it.open(); });
    el.addEventListener('dblclick', () => it.open());
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') it.open(); });
    return el;
  }));
}
function select(el) { for (const x of box.children) x.classList.toggle('sel', x === el); }
$('#desktop').addEventListener('click', () => select(null));

export function setMark(name, sub) {
  mark.replaceChildren(h('b', { text: name || '' }), h('small', { text: sub || '' }));
}
