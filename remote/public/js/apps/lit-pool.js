// 文献 › 候选: every paper the push scored as worth reading that no day has had room for yet (server/literature/feed.js,
// status "spare") -- kept for good, to look through: searched, sorted by score / when found / when published. One can
// be taken (收下), put among today's picks, or thrown out (不要了). The daily push takes from here by itself.
import { h } from '../util.js';
import { get, post, authors } from './lit-api.js';
import { abstractBody } from './lit-abstract.js';

const SORTS = { score: ['按分数', (a, b) => b.score - a.score || b.created - a.created], found: ['最近找到的', (a, b) => b.created - a.created],
  date: ['最近发表的', (a, b) => String(b.paper.date || b.paper.year || '').localeCompare(String(a.paper.date || a.paper.year || ''))] };
const SHOWN = 100;

export function mount(el, ctx) {
  const q = h('input', { class: 'field', type: 'search', placeholder: '在候选里找：题目、作者、期刊、摘要、推荐理由' });
  const sort = h('select', { class: 'field' }, ...Object.entries(SORTS).map(([id, [label]]) => h('option', { value: id, text: label })));
  sort.style.flex = '0 0 auto';
  const st = h('span', { class: 'lit-st' });
  const list = h('div', { class: 'lf-list' });
  el.append(h('div', { class: 'lit-sub lp-bar' }, q, sort, st), list);
  let items = [], canWrite = true, all = false;
  const openAbs = new Set();

  async function refresh() {
    const f = await get('/api/lit/feed/pool');
    if (!f) { list.replaceChildren(h('p', { class: 'lit-empty', text: '读不到候选。' })); return; }
    items = f.items || []; canWrite = f.canWrite;
    render();
  }
  function render() {
    const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const text = (e) => [e.paper.title, (e.paper.authors || []).join(' '), e.paper.venue, e.paper.abstract, e.why, e.qText, (e.tr || []).map((s) => s[1]).join('')].join(' ').toLowerCase();
    const hit = (terms.length ? items.filter((e) => { const t = text(e); return terms.every((w) => t.includes(w)); }) : items.slice()).sort(SORTS[sort.value][1]);
    st.textContent = terms.length ? `${hit.length} / ${items.length} 篇` : `${items.length} 篇`;
    const shown = all ? hit : hit.slice(0, SHOWN);
    list.replaceChildren(...[
      !items.length ? h('p', { class: 'lit-empty', text: '现在没有候选。每天推送时打分够高、但当天没排上的文献会留在这里，一直留着。' }) : !hit.length ? h('p', { class: 'lit-empty', text: '没有符合的。' }) : null,
      ...shown.map(card),
      hit.length > shown.length ? h('button', { class: 'btn', type: 'button', text: `再显示 ${hit.length - shown.length} 篇`, onclick: () => { all = true; render(); } }) : null].filter(Boolean));
  }
  function card(e) {
    const p = e.paper || {};
    const head = h('div', { class: 'lf-h' },
      e.old ? h('i', { class: 'tag old', text: '老报告' }) : e.fun ? h('i', { class: 'tag fun', text: '有趣' }) : null,
      e.lapsed ? h('i', { class: 'tag cu', text: '推过', title: '推送过，7 天没处理，回到了候选里；不会再自动推一次' }) : null,
      e.question > 0 ? h('i', { class: 'tag q', text: 'Q' + e.question, title: e.qText || '' }) : null,
      e.score ? h('small', { class: 'lf-score', text: `${e.score}/10`, title: '和你当前问题的相关度（模型按题目和摘要打分）' }) : null,
      p.url ? h('a', { class: 'lf-t', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('b', { class: 'lf-t', text: p.title }));
    const meta = h('div', { class: 'lf-m', text: [authors(p.authors), p.venue, p.date || p.year, p.number, `${e.found || e.date} 找到`].filter(Boolean).join(' · ') });
    const why = e.why ? h('div', { class: 'lf-why' }, e.qText ? h('b', { text: `Q${e.question}：${e.qText}` }) : null, h('span', { text: e.why })) : null;
    const abs = p.abstract ? h('details', { class: 'lf-abs', open: openAbs.has(e.id), ontoggle: (ev) => { if (ev.target.open) openAbs.add(e.id); else openAbs.delete(e.id); } },
      h('summary', { text: e.tr ? '摘要（中文对照）' : '摘要' }), abstractBody(p.abstract, e.tr)) : h('div', { class: 'lf-m', text: '（没有摘要）' });
    const note = h('div', { class: 'lf-note' });
    const act = (text, title, cls, fn) => h('button', { class: cls, type: 'button', text, title, onclick: async (ev) => {
      ev.target.disabled = true;
      const r = await fn();
      if (r && r.ok) { items = items.filter((x) => x.id !== e.id); render(); }
      else { ev.target.disabled = false; note.textContent = r && r.need === 'authorize' ? '需要先授权写入 Zotero：点窗口右上角的「授权写入 Zotero」。' : (r && r.msg) || '没成'; }
    } });
    const acts = h('div', { class: 'gbtns' },
      act('收下', canWrite ? '放进 Zotero 的「每日文献」，然后找 PDF、生成速读卡（进度在「今日」的「收下的」里）' : '收下前要先授权写入 Zotero（右上角）', 'btn go', () => post('/api/lit/feed/keep', { id: e.id })),
      act('放进今天的', '放到「今日」的待看里，不占明天的名额', 'btn', () => post('/api/lit/feed/promote', { id: e.id })),
      act('不要了', '从候选里拿掉（以后不会再推这篇）', 'btn', () => post('/api/lit/feed/skip', { id: e.id })));
    return h('div', { class: 'lf-i k-new' }, head, meta, why, abs, note, acts);
  }

  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { all = false; render(); }, 150); });
  sort.addEventListener('change', () => { all = false; render(); });
  return { refresh, onLit: (w) => { if (w === 'feed') refresh(); } };
}
