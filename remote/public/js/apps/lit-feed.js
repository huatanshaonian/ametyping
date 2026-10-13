// 文献 › 今日, in two parts (server/literature/feed.js, intake.js):
//   今日入库  the day's new papers to decide on -- why each matters to which question, the abstract, 收下 (into Zotero's
//             每日文献, then its PDF and its card: shown here until the card is there) or 跳过. The good papers a day
//             had no room for wait in the 候选 tab (lit-pool.js).
//   今日卡片  what there is to read: the cards of the papers kept (the deep card with its figures once the PDF is
//             there, opened in place; 读完了 puts one away), and the reviews of the user's own papers -- questions to
//             answer from memory first (the answers go into the card's 我的笔记), then 对照原文 in the reader.
import { h } from '../util.js';
import { get, post, authors, STATUS } from './lit-api.js';
import { abstractBody } from './lit-abstract.js';
import { renderMd, figUrl } from './lit-md.js';

const STAGE = { pdf: '找 PDF…', waiting: '等 PDF…', card: '生成卡片…', ready: '卡片好了', 'needs-pdf': '没有 PDF', error: '出错了' };
const isDeep = (c) => !!c && /deep|reviewed/.test(c.status);

export function mount(el, ctx) {
  const runBtn = h('button', { class: 'btn', type: 'button', text: '现在推送', title: '马上按画像找一次新文献（平时每个工作日早上自动）' });
  const st = h('span', { class: 'lit-st' });
  const segs = { inbox: h('button', { class: 'lit-tab lf-seg', type: 'button', dataset: { view: 'inbox' }, onclick: () => pick('inbox') }), cards: h('button', { class: 'lit-tab lf-seg', type: 'button', dataset: { view: 'cards' }, onclick: () => pick('cards') }) };
  const list = h('div', { class: 'lf-list' });
  const asks = h('div', { class: 'lf-sec lf-vision', hidden: true });     // 读图 requests waiting for approval
  el.append(h('div', { class: 'lit-sub' }, h('span', { class: 'lf-segs' }, segs.inbox, segs.cards), runBtn, st), asks, list);
  let questions = [], items = [], canWrite = true, pool = 0, view = '';
  const openAbs = new Set();                                   // abstracts left open (a refresh keeps them so)
  const openCards = new Set();                                 // cards opened in place
  const tiles = new Map();                                     // entry id -> { sig, el }: a card as drawn (kept while nothing of it changed)
  const pick = (v) => { view = v; render(); list.scrollTop = 0; };

  async function refresh() {
    const [f, p, va] = await Promise.all([get('/api/lit/feed'), get('/api/lit/profile'), get('/api/lit/vision/pending')]);
    const reqs = (va && va.items) || [];
    asks.hidden = !reqs.length;
    asks.replaceChildren(h('h3', { text: `等你批准读图（${reqs.length}）` }), ...reqs.map((r) => h('div', { class: 'lf-va' },
      h('span', { text: `${r.title}：第 ${r.ranges} 页${r.why ? ' — ' + r.why : ''}` }), h('button', { class: 'btn', type: 'button', text: '去看看', onclick: () => ctx.openItem(r.key) }))));
    if (!f) { list.replaceChildren(h('p', { class: 'lit-empty', text: '读不到推送。' })); return; }
    items = f.items || []; canWrite = f.canWrite; pool = (f.status || {}).pool || 0;
    questions = ((p && p.profile && p.profile.questions) || []).filter((q) => q.status !== 'done' && q.status !== 'shelved');
    const s = f.status || {}, last = (s.runs || []).slice(-1)[0];
    st.classList.toggle('bad', !!(last && last.error));
    st.textContent = s.running ? '正在找今天的文献…' : !p || !p.profile ? '还没有兴趣画像：先到「画像」生成并确认' : last ? (last.error ? `上次推送失败：${last.error}` : `上次：${last.date}，候选 ${last.found} 篇，推了 ${last.picked} 篇新文献${last.held ? `（${last.held} 篇是前几天留下的）` : ''}、${last.reviews || 0} 篇复习${(last.errors || []).length ? '（部分来源出错）' : ''}`) : '还没推送过';
    runBtn.disabled = !!s.running;
    if (s.unscored) st.textContent += ` · 还有 ${s.unscored} 篇找到了没打分`;
    if (s.archive && s.archive.queue) st.textContent += ` · 老报告还有 ${s.archive.queue} 篇在排队`;
    if (s.dtic && s.dtic.up) st.textContent += ' · DTIC 的公共检索恢复了（告诉 Claude 接上）';
    render();
  }
  function render() {
    const n = new Date(), today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const paper = (e) => e.kind !== 'review';
    const open = items.filter((e) => paper(e) && e.status === 'new');
    const making = items.filter((e) => e.status === 'kept' && !e.card);          // kept, its card not there yet
    const toRead = items.filter((e) => e.status === 'kept' && e.card && !e.readAt).sort((a, b) => ((b.intake || {}).at || 0) - ((a.intake || {}).at || 0));
    const reviews = items.filter((e) => !paper(e) && e.status === 'new');
    const read = items.filter((e) => e.status === 'kept' && e.card && e.readAt).sort((a, b) => b.readAt - a.readAt);
    const passed = items.filter((e) => paper(e) && ['skipped', 'expired'].includes(e.status));
    const reviewed = items.filter((e) => !paper(e) && e.status !== 'new');
    // (the first time: where there is something to do)
    if (!view) view = !open.length && !making.length && (toRead.length || reviews.length) ? 'cards' : 'inbox';
    segs.inbox.textContent = `今日入库${open.length ? `（${open.length}）` : ''}`;
    segs.cards.textContent = `今日卡片${toRead.length + reviews.length ? `（${toRead.length + reviews.length}）` : ''}`;
    for (const [k, b] of Object.entries(segs)) b.classList.toggle('on', k === view);
    const sec = (title, arr, draw = (e) => card(e)) => (arr.length ? h('div', { class: 'lf-sec' }, h('h3', { text: title }), ...arr.map(draw)) : null);
    const more = (title, arr, draw) => (arr.length ? h('details', { class: 'lf-more' }, h('summary', { text: `${title}（${arr.length}）` }), ...arr.slice(0, 30).map(draw)) : null);
    for (const id of tiles.keys()) if (!toRead.some((e) => e.id === id)) tiles.delete(id);
    list.replaceChildren(...(view === 'inbox' ? [
      !open.length && !making.length ? h('p', { class: 'lit-empty', text: '今天没有待看的新文献。宁缺毋滥——没有足够相关的新文献时，会从「气动隐身」里挑旧文献复习（在「今日卡片」里）。' }) : null,
      sec('待看：收下还是跳过', open.sort((a, b) => (b.date === today) - (a.date === today) || b.created - a.created)),
      sec('收下了，正在准备卡片', making),
      toRead.length ? h('div', { class: 'lf-pool' }, h('span', { text: `${toRead.length} 张卡片做好了，等你读。` }), h('button', { class: 'btn', type: 'button', text: '去今日卡片', onclick: () => pick('cards') })) : null,
      pool ? h('div', { class: 'lf-pool' }, h('span', { text: `还有 ${pool} 篇够分的候选在等：每天和新找到的一起按分数排，一直留着。` }), h('button', { class: 'btn', type: 'button', text: '去候选里看', onclick: () => ctx.show('pool') })) : null,
      more('跳过的', passed, (e) => card(e, { past: true })),
    ] : [
      !toRead.length && !reviews.length ? h('p', { class: 'lit-empty', text: making.length ? `${making.length} 篇收下的文献正在准备卡片，做好了会出现在这里。` : '没有待读的卡片。在「今日入库」里收下一篇，拿到 PDF 后会自动做带图的深读卡，做好了出现在这里。' }) : null,
      sec('待读的卡片', toRead, tile),
      sec('复习', reviews),
      more('读过的', read, (e) => readCard(e, { past: true })),
      more('复习过的', reviewed, (e) => card(e, { past: true })),
    ]).filter(Boolean));
  }
  const qOf = (e) => (e.qText ? { text: e.qText } : e.question > 0 ? questions[e.question - 1] : null);

  // a paper to decide on, a kept one whose card is being made, or a review
  function card(e, { past } = {}) {
    const p = e.paper || {};
    const q = qOf(e);
    const kind = e.kind === 'review' ? (e.mode === 'recall' ? ['复习', 'rv'] : ['补读', 'cu']) : e.old ? ['老报告', 'old'] : e.fun ? ['有趣', 'fun'] : e.fresh ? ['近期发表', 'new'] : e.found ? ['候选', 'new'] : ['新文献', 'new'];
    const head = h('div', { class: 'lf-h' }, h('i', { class: 'tag ' + kind[1], text: kind[0] }),
      q ? h('i', { class: 'tag q', text: 'Q' + e.question, title: q.text }) : null,
      e.score ? h('small', { class: 'lf-score', text: `${e.score}/10`, title: '和你当前问题的相关度（模型打分）' }) : null,
      p.url ? h('a', { class: 'lf-t', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('b', { class: 'lf-t', text: p.title }));
    const meta = h('div', { class: 'lf-m', text: [e.old ? (p.source === 'dtic' ? 'DTIC' : 'NTRS') : '', authors(p.authors), p.venue, p.year || (p.date || '').slice(0, 4), p.number, (e.paper && e.paper.sources || []).length > 1 ? `来自 ${e.paper.sources.join('、')}` : ''].filter(Boolean).join(' · ') });
    const why = e.why ? h('div', { class: 'lf-why' }, q ? h('b', { text: `Q${e.question}：${q.text}` }) : null, h('span', { text: e.why })) : null;
    const abs = p.abstract ? h('details', { class: 'lf-abs', open: openAbs.has(e.id), ontoggle: (ev) => { if (ev.target.open) openAbs.add(e.id); else openAbs.delete(e.id); } },
      h('summary', { text: e.tr ? '摘要（中文对照）' : '摘要' }), abstractBody(p.abstract, e.tr)) : h('div', { class: 'lf-m', text: '（没有摘要）' });
    const acts = h('div', { class: 'gbtns' });
    const note = h('div', { class: 'lf-note' });
    if (e.kind === 'review') reviewBody(e, acts, note);
    else if (e.status === 'new') {
      acts.append(h('button', { class: 'btn go', type: 'button', text: '收下', title: '放进 Zotero 的「每日文献」，然后找 PDF、做深读卡（做好了在「今日卡片」里）', onclick: async (ev) => {
        ev.target.disabled = true;
        const r = await post('/api/lit/feed/keep', { id: e.id });
        if (!r.ok) { note.textContent = r.need === 'authorize' ? '需要先授权写入 Zotero：点窗口右上角的「授权写入 Zotero」。' : r.msg || '没能收下'; ev.target.disabled = false; return; }
        refresh();
      } }), h('button', { class: 'btn', type: 'button', text: '跳过', onclick: async () => { await post('/api/lit/feed/skip', { id: e.id }); refresh(); } }));
      if (!canWrite) note.textContent = '收下前要先授权写入 Zotero（右上角）。';
    } else if (e.status === 'kept') {
      const s = e.intake || {};
      note.append(h('b', { text: STAGE[s.stage] || '' }), s.msg ? ' ' + s.msg : '');
      if (e.folder) note.append(h('div', { class: 'lf-tip', title: e.folderWhy || '', text: `已归入 Zotero：每日文献 / ${e.folder}` }));
      if (e.zkey) acts.append(h('button', { class: 'btn', type: 'button', text: '在文献库里看', onclick: () => ctx.openItem(e.zkey) }));
    } else if (past) note.textContent = { skipped: '跳过了', done: '复习过了', expired: '过期了（7 天没复习，以后还会轮到）' }[e.status] || '';
    return h('div', { class: 'lf-i k-' + kind[1] + (past ? ' past' : '') }, head, meta, why, e.kind === 'review' ? null : abs, note, acts.childNodes.length ? acts : null);
  }

  // a card to read, drawn once and kept until something of it changes (an opened card is not drawn again by every refresh)
  function tile(e) {
    const sig = JSON.stringify([e.card, e.intake, e.job, e.folder, e.question, e.qText, questions.length]);
    const old = tiles.get(e.id);
    if (old && old.sig === sig) return old.el;
    const elx = readCard(e);
    tiles.set(e.id, { sig, el: elx });
    return elx;
  }
  // the card of a kept paper: its first figure, its one line, and the whole card opened in place
  function readCard(e, { past } = {}) {
    const c = e.card, p = e.paper || {}, s = e.intake || {}, deep = isDeep(c), key = e.zkey;
    const q = qOf(e);
    const full = h('div', { class: 'md lf-full', hidden: true });
    let loaded = false;
    const show = async (on) => {
      full.hidden = !on; tog.textContent = on ? '收起' : '展开卡片';
      if (on) openCards.add(e.id); else openCards.delete(e.id);
      if (!on || loaded) return;
      loaded = true;
      const d = await get('/api/lit/item?key=' + encodeURIComponent(key));
      if (!d || !d.card) { loaded = false; full.textContent = '读不到这张卡片。'; return; }
      await renderMd(full, d.card.text, { onLink: (k) => ctx.openCitekey(k), onPage: (n) => ctx.openReader(key, n) });
      const h1 = full.querySelector('h1'); if (h1) h1.remove();              // (the title is above already)
    };
    const tog = h('button', { class: 'btn go', type: 'button', text: '展开卡片', title: '在这里读整张卡片（图、解读、结果、与你的问题的关系）', onclick: () => show(full.hidden) });
    const star = h('button', { class: 'btn', type: 'button', text: c.starred ? '★ 已星标' : '☆ 星标', title: '星标 = 值得细读原文', onclick: async () => { await post('/api/lit/card/meta', { key, starred: !c.starred }); refresh(); } });
    const done = h('button', { class: 'btn', type: 'button', text: past ? '放回待读' : '读完了', title: past ? '' : '从待读里收起来（卡片一直在卡片库和文献库里）', onclick: async () => { openCards.delete(e.id); await post('/api/lit/feed/read', { id: e.id, undo: !!past }); refresh(); } });
    const state = e.job || s.stage === 'card' ? `正在${e.job === 'quick' ? '做速读卡' : '做深读卡'}，做好后这里会换成新的…`
      : deep ? '' : s.stage === 'needs-pdf' ? `这是按摘要做的速读卡：还没有 PDF。${s.msg || ''} 拿到 PDF（图书馆通道，或你自己拖进 Zotero）后会自动换成带图的深读卡。`
        : s.stage === 'error' ? `出错了：${s.msg || ''}` : '这是速读卡（没能按全文做深读卡，可以在文献库里再试）。';
    const body = h('div', { class: 'lf-cb' },
      h('div', { class: 'lf-h' }, h('i', { class: 'tag ' + (deep ? 'rv' : 'new'), text: STATUS[c.status] || c.status }),
        q ? h('i', { class: 'tag q', text: 'Q' + e.question, title: q.text }) : null,
        c.figs ? h('small', { class: 'lf-score', text: `${c.figs} 张图` }) : null,
        p.url ? h('a', { class: 'lf-t', href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }) : h('b', { class: 'lf-t', text: p.title })),
      h('div', { class: 'lf-m', text: [authors(p.authors), p.venue, p.year || (p.date || '').slice(0, 4), e.folder ? `每日文献 / ${e.folder}` : ''].filter(Boolean).join(' · ') }),
      c.oneLine ? h('div', { class: 'lf-one', text: c.oneLine }) : null,
      q ? h('div', { class: 'lf-tip', text: `Q${e.question}：${q.text}` }) : null,
      state ? h('div', { class: 'lf-tip', text: state }) : null,
      h('div', { class: 'gbtns' }, tog, h('button', { class: 'btn', type: 'button', text: '读原文', title: '打开深读窗口：PDF 和这张卡片并排', onclick: () => ctx.openReader(key) }),
        h('button', { class: 'btn', type: 'button', text: '在文献库里看', onclick: () => ctx.openItem(key) }), star, done));
    const cover = c.cover ? h('button', { class: 'lf-cover', type: 'button', title: '展开卡片', onclick: () => show(full.hidden) }, h('img', { src: figUrl(c.cover), loading: 'lazy', alt: '' })) : null;
    const elx = h('div', { class: 'lf-i lf-c k-' + (deep ? 'rv' : 'new') + (past ? ' past' : '') }, h('div', { class: 'lf-ct' }, cover, body), full);
    if (openCards.has(e.id) && !past) show(true);
    return elx;
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
  return { refresh, show: pick, onLit: (w) => { if (w === 'feed' || w.startsWith('vision:') || w.startsWith('card:')) refresh(); } };
}
