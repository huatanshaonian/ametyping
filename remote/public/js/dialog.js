// A small modal asking for one line of text (a group's name...): resolves the trimmed text, or null when cancelled.
import { h } from './util.js';

export function askText({ title, label = '', value = '', max = 40 }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', maxlength: max, value });
    const done = (v) => { wrap.remove(); resolve(v); };
    const form = h('form', { class: 'dlgbox', autocomplete: 'off' },
      h('div', { class: 'dlgt', text: title }),
      h('div', { class: 'dlgb' },
        label ? h('p', { text: label }) : null,
        input,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => done(null) }),
          h('button', { class: 'btn go', type: 'submit', text: '确定' }))));
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); if (v) done(v); else input.focus(); });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    const wrap = h('div', { class: 'dlg' }, form);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(null); });
    document.body.append(wrap);
    input.focus(); input.select();
  });
}
