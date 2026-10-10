// 文献 › 画像: which way of finding brings the papers worth reading -- the last pushes' runs added up (server/literature/
// feed.js keeps, per run, how many each source found and how many of them were good enough). It sits above the follow
// lists, where a source that never brings anything is taken out.
import { h } from '../util.js';
import { get } from './lit-api.js';

export function yieldBox() {
  const el = h('details', { class: 'lf-yield', hidden: true });
  async function refresh() {
    const f = await get('/api/lit/feed');
    const runs = ((f && f.status && f.status.runs) || []).filter((r) => !r.error && r.sources);
    const found = {}, good = {};
    for (const r of runs) { for (const [k, n] of Object.entries(r.sources || {})) found[k] = (found[k] || 0) + n; for (const [k, n] of Object.entries(r.good || {})) good[k] = (good[k] || 0) + n; }
    const keys = Object.keys(found).sort((a, b) => (good[b] || 0) - (good[a] || 0) || found[b] - found[a]);
    el.hidden = !keys.length;
    el.replaceChildren(h('summary', { text: `各来源的收获（最近 ${runs.length} 次推送）` }),
      h('div', { class: 'lf-tip', text: '抓到多少篇 / 其中够格（6 分以上）的有几篇。长期没有够格的来源，可以在下面的关注列表里调整。' }),
      ...keys.map((k) => h('div', { class: 'lf-y' }, h('b', { text: k }), h('span', { text: `抓到 ${found[k]} 篇` }), h('span', { class: good[k] ? 'ok' : '', text: `够格 ${good[k] || 0}` }))));
  }
  return { el, refresh };
}
