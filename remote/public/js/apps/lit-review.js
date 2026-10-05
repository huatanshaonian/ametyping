// 文献 › 回顾: the monthly / quarterly review (server/literature/review.js) and the questions' history (history.js).
//   - a review waiting: its summary, the progress on each question, the changes it proposes -- each to be accepted (the
//     wording can be changed first) or rejected -- what to do next; 应用 writes the accepted ones into the profile
//   - 问题演化: every question there ever was as a tree (what was split from, merged into what), each with its events
//   - the earlier reviews, as they were decided
import { h } from '../util.js';
import { get, post } from './lit-api.js';

const KIND = { month: '月度回顾', quarter: '季度回顾' };
const ST = { open: '在研', done: '已解决', shelved: '搁置', split: '已分叉', merged: '已合并', gone: '已删除' };
const BY = { user: '你', organize: '梳理', review: '回顾' };
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function mount(el) {
  const st = h('span', { class: 'lit-st' });
  const btn = (text, title, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', text, title, onclick });
  const start = async (kind) => { const r = await post('/api/lit/review/start', { kind }); if (!r.ok) st.textContent = r.msg || '没开始'; refresh(); };
  const mBtn = btn('月度回顾', '现在做一次轻量回顾：各问题的进展、问题的小调整（不动主线）', () => start('month'));
  const qBtn = btn('季度回顾', '现在做一次完整回顾：重新检索近一年的文献，问题和主线都可能调整', () => start('quarter'));
  const body = h('div', { class: 'lrv' });
  el.append(h('div', { class: 'lit-sub' }, mBtn, qBtn, st), body);
  let data = null, open = null, pt = null, shown = '';
  // what is being reworded (a change's text before it is accepted) survives the redraws
  const edits = new Map();
  const keep = (el, k, v) => { el.value = edits.has(k) ? edits.get(k) : v; el.addEventListener('input', () => edits.set(k, el.value)); return el; };

  async function refresh() {
    data = await get('/api/lit/reviews');
    if (!data) { body.replaceChildren(h('p', { class: 'lit-empty', text: '读不到回顾。' })); return; }
    const j = data.job, running = j && j.running;
    st.classList.toggle('bad', !!(j && j.error && !running));
    st.textContent = running ? `正在做${KIND[j.kind]}：${j.step}…（几分钟）` : j && j.error ? '回顾失败：' + j.error : !data.has ? '画像里还没有问题：先到「画像」写自述、梳理' : '每月 1 号自动做一次（每季度第一个月做完整的）；建议都要你审批后才生效';
    mBtn.disabled = qBtn.disabled = running || !data.has;
    clearTimeout(pt); if (running) pt = setTimeout(refresh, 4000);
    const draft = data.items.find((r) => r.status === 'draft');
    const want = shown && data.items.some((r) => r.id === shown) ? shown : draft ? draft.id : '';
    open = want ? await get('/api/lit/review?id=' + encodeURIComponent(want)) : null;
    render();
  }

  function render() {
    body.replaceChildren(...[
      open ? reviewBox(open) : h('p', { class: 'lit-empty', text: data.items.length ? '没有等你审批的回顾。' : '还没有做过回顾。到了月初会自动做，也可以点上面的按钮现在做一次。' }),
      graphBox(data.graph),
      data.items.length ? h('div', { class: 'lrv-sec' }, h('h3', { text: '历次回顾' }), ...data.items.map((r) => h('div', { class: 'lrv-past' + (open && open.id === r.id ? ' sel' : ''), onclick: () => { shown = r.id; refresh(); } },
        h('b', { text: KIND[r.kind] }), h('span', { text: ` ${r.from} ～ ${r.to}` }),
        h('small', { text: r.status === 'draft' ? ` · 等你审批（${r.changes} 条建议）` : r.status === 'discarded' ? ' · 放弃了' : ` · 采纳了 ${r.accepted}/${r.changes} 条` })))) : null,
    ].filter(Boolean));
  }

  // one review: a draft is decided here; a finished one is shown as it was decided
  function reviewBox(r) {
    const draft = r.status === 'draft';
    const qOf = (id) => r.qs.find((q) => q.id === id);
    const qLabel = (id) => { const q = qOf(id); return q ? h('span', { class: 'lrv-q' }, h('b', { text: q.ref + ' ' }), q.text) : h('span', { text: '（已不在）' }); };
    const decide = async (cid, decision, patch = {}) => { await post('/api/lit/review/decide', { id: r.id, cid, decision, ...patch }); open = await get('/api/lit/review?id=' + encodeURIComponent(r.id)); render(); };
    const verdict = (c, cid, patch) => (draft
      ? h('div', { class: 'gbtns' }, btn(c.decision === 'accepted' ? '✓ 已接受' : '接受', '应用时写进画像（上面的文字可以先改）', () => decide(cid, c.decision === 'accepted' ? '' : 'accepted', patch()), 'btn' + (c.decision === 'accepted' ? ' go' : '')),
        btn(c.decision === 'rejected' ? '✗ 不采纳' : '不采纳', '', () => decide(cid, c.decision === 'rejected' ? '' : 'rejected'), 'btn' + (c.decision === 'rejected' ? ' no' : '')))
      : h('div', { class: 'lit-st', text: c.decision === 'accepted' ? (c.skipped ? '接受了，但没能应用：' + c.skipped : '✓ 采纳了' + (c.edited ? '（改写过）' : '')) : '✗ 没采纳' }));
    const why = (c) => [h('div', { class: 'lrv-why' }, h('b', { text: '理由：' }), c.reason || ''), c.evidence ? h('div', { class: 'lrv-why' }, h('b', { text: '依据：' }), c.evidence) : null,
      (c.refs || []).length ? h('div', { class: 'lrv-why' }, h('b', { text: '文献：' }), ...c.refs.map((x) => (x.url || x.doi ? h('a', { href: x.url || 'https://doi.org/' + x.doi, target: '_blank', rel: 'noopener noreferrer', text: `${x.title}${x.year ? `（${x.year}）` : ''} ` }) : h('span', { text: x.title + ' ' })))) : null];

    const changes = r.changes.map((c) => {
      const text = c.type !== '分叉' && c.text ? keep(h('textarea', { class: 'field', rows: 2, disabled: !draft }), c.id, c.text) : null;
      const kids = c.type === '分叉' ? c.children.map((k, i) => ({ dim: k.dim, t: keep(h('input', { class: 'field', disabled: !draft }), c.id + ':' + i, k.text) })) : [];
      const patch = () => (c.type === '分叉' ? { children: kids.map((k) => ({ text: k.t.value, dim: k.dim })) } : text ? { text: text.value } : {});
      return h('div', { class: 'lrv-c' + (c.decision ? ' ' + c.decision : '') },
        h('div', { class: 'lrv-ch' }, h('i', { class: 'tag c', text: c.type }), ...(c.qids.length ? c.qids.map(qLabel) : [h('span', { class: 'lrv-q', text: `新问题${c.dim ? `（${c.dim}）` : ''}` })])),
        text ? h('div', { class: 'lrv-to' }, h('span', { text: '→' }), text) : null,
        kids.length ? h('div', { class: 'lrv-kids' }, ...kids.map((k) => h('div', { class: 'lrv-to' }, h('span', { text: '→' }), k.t, k.dim ? h('small', { text: k.dim }) : null))) : null,
        ...why(c), verdict(c, c.id, patch));
    });
    const line = r.line && r.line.change ? (() => {
      const t = keep(h('textarea', { class: 'field', rows: 8, disabled: !draft }), r.id + ':line', r.line.text);
      return h('div', { class: 'lrv-c' + (r.line.decision ? ' ' + r.line.decision : '') }, h('div', { class: 'lrv-ch' }, h('i', { class: 'tag c', text: '主线调整' })),
        h('details', {}, h('summary', { text: '现在的主线' }), h('p', { class: 'lrv-old', text: r.line.before || '' })), t, ...why(r.line), verdict(r.line, 'line', () => ({ text: t.value })));
    })() : null;
    const nAcc = r.changes.filter((c) => c.decision === 'accepted').length + (r.line && r.line.decision === 'accepted' ? 1 : 0);
    const nOpen = r.changes.filter((c) => !c.decision).length + (r.line && r.line.change && !r.line.decision ? 1 : 0);
    const msg = h('span', { class: 'lit-st' });
    return h('div', { class: 'lrv-sec lrv-r' },
      h('h3', { text: `${KIND[r.kind]} ${r.from} ～ ${r.to}${draft ? '（等你审批）' : r.status === 'discarded' ? '（放弃了）' : ''}` }),
      h('p', { class: 'lrv-sum', text: r.summary }),
      h('h4', { text: '各问题的进展' }),
      ...r.progress.map((x) => h('div', { class: 'lrv-p' }, h('i', { class: 'tag st-' + ({ 有进展: 'ok', 已解决: 'ok', 停滞: 'bad' }[x.state] || 'no'), text: x.state }), qLabel(x.qid),
        h('div', { class: 'lrv-why', text: x.note }), x.evidence ? h('div', { class: 'lrv-why' }, h('b', { text: '依据：' }), x.evidence) : null)),
      h('h4', { text: `建议的变动（${r.changes.length + (line ? 1 : 0)}）` }),
      !changes.length && !line ? h('p', { class: 'lit-empty', text: '这次没有建议变动。' }) : null, ...changes, line,
      (r.next || []).length ? h('h4', { text: '下一步建议' }) : null,
      ...(r.next || []).map((x) => h('div', { class: 'lb-act' }, h('span', { text: x }), btn('加入重要计划', '', async (e) => { const a = await post('/api/lit/action/todo', { text: x }); e.target.textContent = a.ok ? '已加入' : (a.msg || '没加上'); e.target.disabled = a.ok; }))),
      draft ? h('div', { class: 'gbtns lrv-end' },
        btn(nAcc ? `应用接受的 ${nAcc} 条` : '应用（没有接受的变动，只归档）', nOpen ? `还有 ${nOpen} 条没表态：应用后它们算没采纳` : '把接受的变动写进画像，这次回顾归档到知识库', async () => { const a = await post('/api/lit/review/apply', { id: r.id }); if (!a.ok) msg.textContent = a.msg || '没应用上'; else { shown = r.id; refresh(); } }, 'btn go'),
        btn('放弃这次回顾', '什么都不改', async () => { await post('/api/lit/review/discard', { id: r.id }); shown = ''; refresh(); }), nOpen ? h('span', { class: 'lit-st', text: `还有 ${nOpen} 条没表态` }) : null, msg) : null);
  }

  // 问题演化: the questions as a tree (split from / merged into), each with what happened to it
  function graphBox(g) {
    if (!g || !g.nodes.length) return null;
    const by = new Map(g.nodes.map((n) => [n.id, n])), drawn = new Set();
    const events = (n) => h('div', { class: 'lrv-ev' }, ...n.events.map((e) => h('div', {}, h('small', { text: `${day(e.at)} ${BY[e.by] || e.by}` }), h('b', { text: ' ' + e.type + ' ' }),
      e.before ? h('span', {}, h('s', { text: e.before }), ' → ' + e.text) : h('span', { text: e.type === '分叉' || e.type === '合并' || e.type === '搁置' || e.type === '解决' || e.type === '删除' ? '' : e.text }),
      e.reason ? h('div', { class: 'lrv-why', text: '理由：' + e.reason }) : null, e.evidence ? h('div', { class: 'lrv-why', text: '依据：' + e.evidence }) : null)));
    const node = (n) => {
      const again = drawn.has(n.id); drawn.add(n.id);
      const kids = again ? [] : n.to.map((id) => by.get(id)).filter(Boolean);
      return h('li', { class: 'lrv-n s-' + n.status }, h('details', {}, h('summary', {}, h('i', { class: 'tag s-' + n.status, text: ST[n.status] || n.status }), n.dim ? h('small', { text: n.dim + ' ' }) : null, h('span', { text: n.text }),
        n.from.length > 1 ? h('small', { text: `（由 ${n.from.length} 个问题合并）` }) : null, n.events.length > 1 ? h('small', { text: ` · ${n.events.length} 次变动` }) : null), events(n)),
        kids.length ? h('ul', {}, ...kids.map(node)) : null);
    };
    const roots = g.nodes.filter((n) => !n.from.length && n.status !== 'gone');
    const gone = g.nodes.filter((n) => n.status === 'gone').length;
    return h('div', { class: 'lrv-sec' }, h('h3', { text: '问题演化' }),
      h('p', { class: 'lf-tip', text: '每个问题的来历：点开看它的每次变动和理由。分叉出来的子问题缩进在下面。同一张图也在知识库的 reviews/问题演化.md 里（Obsidian 里是流程图）。' }),
      g.line.length ? h('details', { class: 'lrv-line' }, h('summary', { text: `研究主线（改过 ${g.line.length - 1} 次）` }), ...g.line.slice().reverse().map((e) => h('div', { class: 'lrv-ev' }, h('small', { text: `${day(e.at)} ${BY[e.by] || e.by}` }), e.reason ? h('div', { class: 'lrv-why', text: '理由：' + e.reason }) : null, h('p', { class: 'lrv-old', text: e.text })))) : null,
      h('ul', { class: 'lrv-tree' }, ...roots.map(node)),
      gone ? h('small', { class: 'lit-st', text: `另有 ${gone} 个已删除的问题没有显示` }) : null);
  }

  return { refresh, destroy() { clearTimeout(pt); }, onLit: (w) => { if (w === 'review') refresh(); } };
}
