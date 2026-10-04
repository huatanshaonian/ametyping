// 文献 › 今日: the day's picks (server/literature/feed.js). A new paper: why it matters to which question, the abstract,
// 收下 (into Zotero's 每日文献, then its PDF and card -- intake.js shows how far it got) or 跳过. A review: questions to
// answer from memory first (the answers go into the card's 我的笔记), then 对照原文 in the reader. 更多候选: the next
// best papers of the day, for a day with time to spare.
import { h } from '../util.js';
import { get, post, authors } from './lit-api.js';

const STAGE = { pdf: '找 PDF…', waiting: '等 PDF…', card: '生成速读卡…', ready: '速读卡好了', 'needs-pdf': '没有 PDF', error: '出错了' };

export function mount(el, ctx) {
  const runBtn = h('button', { class: 'btn', type: 'button', text: '现在推送', title: '马上按画像找一次新文献（平时每个工作日早上自动）' });
  const st = h('span', { class: 'lit-st' });
  const list = h('div', { class: 'lf-list' });
  // which way of finding brings the papers worth reading: the last week's runs added up
  const yieldEl = h('details', { class: 'lf-yield', hidden: true });
  el.append(h('div', { class: 'lit-sub' }, runBtn, st), yieldEl, list);
  function showYield(runs) {
    const found = {}, good = {};
    for (const r of runs) { for (const [k, n] of Object.entries(r.sources || {})) found[k] = (found[k] || 0) + n; for (const [k, n] of Object.entries(r.good || {})) good[k] = (good[k] || 0) + n; }
    const keys = Object.keys(found).sort((a, b) => (good[b] || 0) - (good[a] || 0) || found[b] - found[a]);
    yieldEl.hidden = !keys.length;
    yieldEl.replaceChildren(h('summary', { text: `各来源的收获（最近 ${runs.length} 次推送）` }),
      h('div', { class: 'lf-tip', text: '抓到多少篇 / 其中够格（6 分以上）的有几篇。长期没有够格的来源，可以在「画像」里调整。' }),
      ...keys.map((k) => h('div', { class: 'lf-y' }, h('b', { text: k }), h('span', { text: `抓到 ${found[k]} 篇` }), h('span', { class: good[k] ? 'ok' : '', text: `够格 ${good[k] || 0}` }))));
  }
  let questions = [], items = [], canWrite = true, showSpare = false;

  async function refresh() {
    const [f, p] = await Promise.all([get('/api/lit/feed'), get('/api/lit/profile')]);
    if (!f) { list.replaceChildren(h('p', { class: 'lit-empty', text: '读不到推送。' })); return; }
    items = f.items || []; canWrite = f.canWrite;
    questions = ((p && p.profile && p.profile.questions) || []).filter((q) => q.status !== 'done');
    const s = f.status || {}, last = (s.runs || []).slice(-1)[0];
    st.classList.toggle('bad', !!(last && last.error));
    st.textContent = s.running ? '正在找今天的文献…' : !p || !p.profile ? '还没有兴趣画像：先到「画像」生成并确认' : last ? (last.error ? `上次推送失败：${last.error}` : `上次：${last.date}，候选 ${last.found} 篇，推了 ${last.picked} 篇新文献、${last.reviews || 0} 篇复习${(last.errors || []).length ? '（部分来源出错）' : ''}`) : '还没推送过';
    runBtn.disabled = !!s.running;
    showYield((s.runs || []).filter((r) => !r.error && r.sources));
    render();
  }
  function render() {
    const n = new Date(), today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const open = items.filter((e) => e.status === 'new');
    const spare = items.filter((e) => e.status === 'spare');
    const kept = items.filter((e) => e.status === 'kept');
    const past = items.filter((e) => ['skipped', 'done', 'expired'].includes(e.status));
    const sec = (title, arr, opts = {}) => (arr.length ? h('div', { class: 'lf-sec' }, h('h3', { text: title }), ...arr.map((e) => card(e, opts))) : null);
    list.replaceChildren(...[
      !open.length && !kept.length ? h('p', { class: 'lit-empty', text: '今天没有待看的文献。宁缺毋滥——没有足够相关的新文献时，会从「气动隐身」里挑旧文献复习。' }) : null,
      sec('待看', open.sort((a, b) => (b.date === today) - (a.date === today) || b.created - a.created)),
      sec('收下的', kept.slice(0, 12)),
      spare.length ? h('details', { class: 'lf-more', open: showSpare, ontoggle: (e) => { showSpare = e.target.open; } }, h('summary', { text: `更多候选（${spare.length}）` }), ...spare.map((e) => card(e, { spare: true }))) : null,
      past.length ? h('details', { class: 'lf-more' }, h('summary', { text: `看过的（${past.length}）` }), ...past.slice(0, 30).map((e) => card(e, { past: true }))) : null].filter(Boolean));
  }

  function card(e, { spare, past } = {}) {
    const p = e.paper || {};
    const q = e.question > 0 ? questions[e.question - 1] : null;
    const kind = e.kind === 'review' ? (e.mode === 'recall' ? ['复习', 'rv'] : ['补读', 'cu']) : e.old ? ['老报告', 'old'] : e.fun ? ['有趣', 'fun'] : ['新文献', 'new'];
    const head = h('div', { class: 'lf-h' }, h('i', { class: 'tag ' + kind[1], text: kind[0] }),
      q ? h('i', { class: 'tag q', text: 'Q' + e.question, title: q.text }) : null,
      e.score ? h('small', { class: 'lf-score', text: `${e.score}/10`, title: '和你当前问题的相关度（模型打分）' }) : null,
      p.url ? h('a', { class: 'lf-t', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('b', { class: 'lf-t', text: p.title }));
    const meta = h('div', { class: 'lf-m', text: [authors(p.authors), p.venue, p.year || (p.date || '').slice(0, 4), p.number, (e.paper && e.paper.sources || []).length > 1 ? `来自 ${e.paper.sources.join('、')}` : ''].filter(Boolean).join(' · ') });
    const why = e.why ? h('div', { class: 'lf-why' }, q ? h('b', { text: `Q${e.question}：${q.text}` }) : null, h('span', { text: e.why })) : null;
    const abs = p.abstract ? h('details', { class: 'lf-abs' }, h('summary', { text: '摘要' }), h('p', { text: p.abstract })) : h('div', { class: 'lf-m', text: '（没有摘要）' });
    const acts = h('div', { class: 'gbtns' });
    const note = h('div', { class: 'lf-note' });
    if (e.kind === 'review') reviewBody(e, acts, note);
    else if (e.status === 'new' || spare) {
      if (spare) acts.append(h('button', { class: 'btn', type: 'button', text: '放进今天的', onclick: async () => { await post('/api/lit/feed/promote', { id: e.id }); refresh(); } }));
      else {
        acts.append(h('button', { class: 'btn go', type: 'button', text: '收下', title: '放进 Zotero 的「每日文献」，然后找 PDF、生成速读卡', onclick: async (ev) => {
          ev.target.disabled = true;
          const r = await post('/api/lit/feed/keep', { id: e.id });
          if (!r.ok) { note.textContent = r.need === 'authorize' ? '需要先授权写入 Zotero：点窗口右上角的「授权写入 Zotero」。' : r.msg || '没能收下'; ev.target.disabled = false; return; }
          refresh();
        } }), h('button', { class: 'btn', type: 'button', text: '跳过', onclick: async () => { await post('/api/lit/feed/skip', { id: e.id }); refresh(); } }));
        if (!canWrite) note.textContent = '收下前要先授权写入 Zotero（右上角）。';
      }
    } else if (e.status === 'kept') {
      const s = e.intake || {};
      note.append(h('b', { text: STAGE[s.stage] || '' }), s.msg ? ' ' + s.msg : '');
      if (s.stage === 'needs-pdf') note.append(h('div', { class: 'lf-tip', text: '拿到 PDF 后拖进 Zotero 里这篇下面就行，系统发现后会按全文重新生成速读卡。' }));
      if (e.zkey) acts.append(h('button', { class: 'btn', type: 'button', text: '看卡片', onclick: () => ctx.openItem(e.zkey) }),
        h('button', { class: 'btn', type: 'button', text: '深读', onclick: () => ctx.openReader(e.zkey) }));
    } else if (past) note.textContent = { skipped: '跳过了', done: '复习过了', expired: '过期了（7 天没处理）' }[e.status] || '';
    return h('div', { class: 'lf-i k-' + kind[1] + (past ? ' past' : '') }, head, meta, why, e.kind === 'review' ? null : abs, note, acts.childNodes.length ? acts : null);
  }

  // a review: the recall questions with room for answers; the card and the reader one click away
  function reviewBody(e, acts, note) {
    if (e.status !== 'new') { note.textContent = '复习过了'; return; }
    const boxes = (e.recall || []).map((q) => { const t = h('textarea', { class: 'field lf-ans', rows: 2, placeholder: '凭记忆先答，再对照原文（可以不答）' }); return { q, t }; });
    if (boxes.length) note.append(h('div', { class: 'lf-tip', text: e.mode === 'recall' ? `你在这篇上做过 ${e.notes} 条批注。先回忆：` : '还没读过的收藏，带着这几个问题去读：' }),
      ...boxes.map(({ q, t }) => h('div', { class: 'lf-q' }, h('b', { text: q }), t)));
    acts.append(h('button', { class: 'btn', type: 'button', text: '对照原文', onclick: () => ctx.openReader(e.key) }),
      h('button', { class: 'btn', type: 'button', text: '看卡片', onclick: () => ctx.openItem(e.key) }),
      h('button', { class: 'btn go', type: 'button', text: '完成复习', title: '答案会记进这篇卡片的「我的笔记」', onclick: async () => { await post('/api/lit/feed/review', { id: e.id, answers: boxes.map((b) => b.t.value) }); refresh(); } }));
  }

  runBtn.addEventListener('click', async () => { runBtn.disabled = true; st.textContent = '正在找今天的文献…（几分钟）'; await post('/api/lit/feed/run', {}); });
  return { refresh, onLit: (w) => { if (w === 'feed') refresh(); } };
}
