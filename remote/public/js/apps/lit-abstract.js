// An abstract as the 文献 window shows it: as it is, or -- once translated (server/literature/translate.js) -- each
// sentence beside its Chinese. tr: [[src, zh], ...] or null.
import { h } from '../util.js';

export function abstractBody(text, tr) {
  if (!tr || !tr.length) return h('p', { text });
  return h('div', { class: 'lit-tr' }, ...tr.map(([src, zh]) => h('div', {}, h('span', { text: src }), h('span', { class: 'zh', lang: 'zh', text: zh }))));
}
