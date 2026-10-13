// 文献 › 卡片库: every card made so far (server/literature/cards.js: all) as a wall of cards -- the paper's first figure
// on top when the card has figures, its title, the card's one line, how far it got (速读 / 深读 / 已核对), ★. Filtered
// by kind and by words; a click opens the card where it lives (文献库, that paper).
import { h } from '../util.js';
import { get, authors, STATUS } from './lit-api.js';
import { figUrl } from './lit-md.js';

const KINDS = [['', '全部'], ['deep', '深读卡'], ['quick', '速读卡'], ['starred', '★ 星标'], ['figs', '有图的']];

export function mount(el, ctx) {
  const q = h('input', { class: 'field', type: 'search', placeholder: '在卡片里找：题目、作者、期刊、一句话总结' });
  const kind = h('select', { class: 'field' }, ...KINDS.map(([v, text]) => h('option', { value: v, text })));
  kind.style.flex = '0 0 auto';
  const st = h('span', { class: 'lit-st' });
  const grid = h('div', { class: 'lc-grid' });
  el.append(h('div', { class: 'lit-sub lp-bar' }, q, kind, st), grid);
  let items = [];

  async function refresh() {
    const r = await get('/api/lit/cards');
    if (!r) { grid.replaceChildren(h('p', { class: 'lit-empty', text: '读不到卡片。' })); return; }
    items = r.items || [];
    render();
  }
  function render() {
    const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean), k = kind.value;
    const deep = (c) => /deep|reviewed/.test(c.status);
    let hit = items.filter((c) => (k === 'deep' ? deep(c) : k === 'quick' ? c.status === 'quick' : k === 'starred' ? c.starred : k === 'figs' ? c.figs > 0 : true));
    if (terms.length) hit = hit.filter((c) => { const t = [c.title, (c.authors || []).join(' '), c.venue, c.oneLine, c.citekey].join(' ').toLowerCase(); return terms.every((w) => t.includes(w)); });
    st.textContent = hit.length === items.length ? `${items.length} 张` : `${hit.length} / ${items.length} 张`;
    grid.replaceChildren(...(hit.length ? hit.map(card) : [h('p', { class: 'lit-empty', text: items.length ? '没有符合的卡片。' : '还没有卡片。收下一篇文献，拿到 PDF 后会自动做带图的深读卡（没有 PDF 时先按摘要做速读卡）。' })]));
  }
  function card(c) {
    const deep = /deep|reviewed/.test(c.status);
    return h('button', { class: 'lc-i' + (c.gone ? ' gone' : ''), type: 'button', title: c.gone ? 'Zotero 里已经没有这篇了（卡片还在知识库里）' : '打开这张卡片', onclick: () => { if (!c.gone) ctx.openItem(c.key); } },
      c.cover ? h('div', { class: 'lc-cover' }, h('img', { src: figUrl(c.cover), loading: 'lazy', alt: '' })) : h('div', { class: 'lc-cover none', text: deep ? '这张深读卡没有图（重做深读卡会带上图）' : '速读卡（没有图）' }),
      h('div', { class: 'lc-b' },
        h('div', { class: 'lc-t', text: c.title }),
        c.oneLine ? h('div', { class: 'lc-one', text: c.oneLine }) : null,
        h('div', { class: 'lc-m' },
          h('i', { class: 'tag ' + (deep ? 'rv' : 'new'), text: STATUS[c.status] || c.status }),
          c.starred ? h('span', { text: '★' }) : null, c.verified ? h('span', { text: '✓ 已核对' }) : null,
          c.question ? h('i', { class: 'tag q', text: 'Q' + c.question }) : null,
          c.figs ? h('span', { text: `${c.figs} 张图` }) : null,
          h('span', { text: [authors(c.authors), c.year].filter(Boolean).join(' · ') }), h('span', { text: c.updated }))));
  }
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 150); });
  kind.addEventListener('change', render);
  return { refresh, onLit: (w) => { if (w === 'kb' || w.startsWith('card:')) refresh(); } };
}
