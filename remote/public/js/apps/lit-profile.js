// 文献 › 画像: what the push and the cards are aimed at (server/literature/profile.js), in three steps:
//   1. the user writes the research's main line (主线) and the questions being worked on (most important first)
//   2. 按主线调研补全: the model reads the whole Zotero library with the line as the frame and fills in the rest -- the
//      line's branches (what each covers, how well the library covers it, its representative papers, search phrases),
//      questions the user may have missed (only suggestions: 采纳 / 不要), what to follow
//   3. the user corrects any of it and confirms (保存并确认)
// Papers are shown by their titles; the follow lists are one item per line.
// 文献 › 产出 (mountStats): what reading turned into over the last week / month.
import { h } from '../util.js';
import { get, post } from './lit-api.js';

const lines = (ta) => ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
const COVER = { 充足: 'ok', 一般: '', 较少: 'thin' };

export function mount(el, ctx) {
  const st = h('span', { class: 'lit-st' });
  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存并确认' });
  const body = h('div', { class: 'lp' });
  el.append(h('div', { class: 'lit-sub' }, saveBtn, st), body);
  let p = null, qs = [], sugs = [], topics = [], running = false, F = {};

  async function refresh() {
    const r = await get('/api/lit/profile');
    p = r && r.profile; const s = (r && r.state) || {};
    running = !!s.running;
    st.classList.toggle('bad', !!s.error);
    st.textContent = running ? '正在按主线调研你的文献库、补全下面的内容…（几分钟）' : s.error ? '补全失败：' + s.error
      : !p || !p.line ? '先写研究主线' : p.confirmed ? '已确认（改了记得保存）' : p.filledAt ? 'AI 已按主线补全：看一遍、改一改，再点「保存并确认」' : '主线写好后，点「按主线调研补全」';
    render();
    if (running) poll();
  }
  const area = (v, rows = 4, ph = '') => { const t = h('textarea', { class: 'field', rows, placeholder: ph }); t.value = v || ''; return t; };

  function render() {
    const f = (p && p.follow) || {};
    qs = ((p && p.questions) || []).map((q) => ({ ...q }));
    sugs = ((p && p.suggestions) || []).map((q) => ({ ...q }));
    topics = ((p && p.topics) || []).map((t) => ({ ...t, keywords: [...(t.keywords || [])], papers: [...(t.papers || [])], paperList: [...(t.paperList || [])] }));
    F = {
      line: area(p && p.line, 9, '用自己的话写博士课题的整体：总目标是什么、分成哪几条线（比如：气动外形与隐身的协同设计、等离子体鞘套的电磁散射、RCS 的高效计算与验证……）、它们之间怎么衔接、最后要做出什么。\n写得粗一点没关系，AI 会照着它去你的文献库里调研，把下面的分支、检索词、期刊、作者补全。'),
      venues: area((f.venues || []).map((v) => `${v.name}${v.extra ? '（库外）' : ''}${(v.issns || []).length ? ' | ' + v.issns.join(' ') : ''}${v.aiaa ? ' | aiaa:' + v.aiaa : ''}`).join('\n'), 5, '期刊名 | ISSN ISSN | aiaa:代码（ISSN 可空：会从库里或 OpenAlex 查）'),
      authors: area((f.authors || []).map((a) => `${a.name}${a.openalex ? ` | ${a.openalex} | ${a.inst || ''}${a.guess ? '（按姓名猜的，请核对）' : ''}` : ' | （没找到）'}`).join('\n'), 4, '作者名 | OpenAlex 编号（可空：从你库里这位作者带 DOI 的论文去查）'),
      keywords: area((f.keywords || []).join('\n'), 5, '英文检索式，一行一个（每天轮流用几条）'),
      arxiv: area((f.arxiv || []).join('\n'), 2, 'physics.plasm-ph'),
      ntrs: area((f.ntrs || []).join('\n'), 3, 'NASA 老报告检索式，周六推一篇'),
      seeds: area((f.seeds || []).map((s) => `${s.title}${s.doi ? ' | ' + s.doi : ''}${s.openalex ? ' | ' + s.openalex : ''}`).join('\n'), 4, '核心文献（追踪「谁引用了它们」）'),
    };
    if (p && !p.line && p.summary) F.line.placeholder = '（之前 AI 从文献库归纳的方向，仅供参考：' + p.summary + '）\n\n' + F.line.placeholder;

    // questions, most important first
    const qBox = h('div', { class: 'lp-qs' });
    const drawQs = () => qBox.replaceChildren(...qs.map((q, i) => h('div', { class: 'lp-q' + (q.status === 'done' ? ' done' : '') },
      h('b', { text: 'Q' + (i + 1) }),
      (() => { const t = h('input', { class: 'field', value: q.text, placeholder: '一个你现在要解决的具体问题' }); t.addEventListener('input', () => { q.text = t.value; }); return t; })(),
      h('span', { class: 'lp-qb' },
        h('button', { class: 'btn', type: 'button', text: '↑', title: '更重要', disabled: i === 0, onclick: () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; drawQs(); } }),
        h('button', { class: 'btn', type: 'button', text: q.status === 'done' ? '重新打开' : '解决了', title: '解决了的问题不再用来挑文献', onclick: () => { q.status = q.status === 'done' ? 'open' : 'done'; drawQs(); } }),
        h('button', { class: 'btn no', type: 'button', text: '删', onclick: () => { qs.splice(i, 1); drawQs(); } })),
      q.why ? h('small', { text: q.why }) : null)),
    h('button', { class: 'btn', type: 'button', text: '＋ 加一个问题', onclick: () => { qs.push({ text: '', status: 'open' }); drawQs(); setTimeout(() => { const ins = qBox.querySelectorAll('input'); if (ins.length) ins[ins.length - 1].focus(); }, 0); } }));
    drawQs();
    // the model's suggested questions: taken in (to the end of the list) or dropped
    const sBox = h('div', { class: 'lp-sugs' });
    const drawSugs = () => sBox.replaceChildren(...(sugs.length ? [h('div', { class: 'lp-st', text: 'AI 觉得你可能还该关心的问题（采纳了才算）：' }),
      ...sugs.map((q, i) => h('div', { class: 'lp-sug' }, h('span', { text: q.text }), q.why ? h('small', { text: q.why }) : null,
        h('span', { class: 'lp-qb' },
          h('button', { class: 'btn', type: 'button', text: '采纳', onclick: () => { qs.push({ text: q.text, why: q.why, status: 'open' }); sugs.splice(i, 1); drawQs(); drawSugs(); } }),
          h('button', { class: 'btn no', type: 'button', text: '不要', onclick: () => { sugs.splice(i, 1); drawSugs(); } }))))] : []));
    drawSugs();

    const fillBtn = h('button', { class: 'btn go', type: 'button', text: running ? '正在调研…' : p && p.filledAt ? '按主线重新调研补全' : '按主线调研补全', disabled: running,
      title: '保存主线和问题，然后让 AI 以主线为准读一遍整个文献库，补全下面的分支、期刊、作者、检索式（几分钟）', onclick: fill });

    // the branches (topics): name, how well the library covers it, what it is, search words, its papers in the library
    const tBox = h('div', { class: 'lp-ts' });
    const drawTopics = () => tBox.replaceChildren(...topics.map((t, i) => {
      const name = h('input', { class: 'field lp-tn', value: t.name }); name.addEventListener('input', () => { t.name = name.value; });
      const desc = area(t.desc, 3, '这个分支做什么、关键问题、库里讲到哪、还缺什么'); desc.addEventListener('input', () => { t.desc = desc.value; });
      const kw = h('input', { class: 'field', value: (t.keywords || []).join(', '), placeholder: '英文检索词，逗号分开' }); kw.addEventListener('input', () => { t.keywords = kw.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); });
      return h('div', { class: 'lp-t' },
        h('div', { class: 'lp-th' }, name, t.coverage ? h('i', { class: 'tag cov ' + (COVER[t.coverage] || ''), text: '库里' + t.coverage, title: '你的文献库对这个分支的覆盖程度：较少的分支，推送会多留意' }) : null,
          h('button', { class: 'btn no', type: 'button', text: '删', onclick: () => { topics.splice(i, 1); drawTopics(); } })),
        desc, kw,
        (t.paperList || []).length ? h('ul', { class: 'lp-papers' }, ...t.paperList.map((x) => h('li', {},
          h('a', { href: '#', text: x.title, title: '在文献库里打开', onclick: (e) => { e.preventDefault(); ctx.openItem(x.key); } }), x.year ? h('small', { text: ` ${x.year}` }) : null))) : null);
    }), h('button', { class: 'btn', type: 'button', text: '＋ 加一个分支', onclick: () => { topics.push({ name: '新分支', desc: '', keywords: [], papers: [], paperList: [] }); drawTopics(); } }));
    drawTopics();

    const row = (label, el2, tip) => h('div', { class: 'lp-row' }, h('label', { text: label }), el2, tip ? h('small', { text: tip }) : null);
    body.replaceChildren(...[
      h('h3', { class: 'lp-step', text: '① 你来写：研究主线和问题' }),
      row('研究主线', F.line, '画像以它为准。AI 不会改写它，只会照着它去补全下面的内容。'),
      h('div', { class: 'lp-row' }, h('label', { text: '当前问题' }), h('div', {}, h('small', { text: '越靠前越重要（↑ 调整）。每篇推送和每张卡片都会挂到其中一个问题上。' }), qBox, sBox)),
      h('h3', { class: 'lp-step' }, '② AI 按主线调研你的文献库，补全下面的内容 ', fillBtn),
      p && p.filledAt ? null : h('p', { class: 'lit-empty', text: '写好主线后点上面的按钮。AI 会把主线拆成若干分支，标出你的文献库对每个分支的覆盖程度，挑出代表文献，再定下要跟的期刊、作者和检索式——文献少的分支，正是以后推送要补的。' }),
      h('h3', { class: 'lp-step', text: '③ 你来改：分支和要跟的东西（改完点上面的「保存并确认」）' }),
      row('研究分支', tBox),
      row('跟踪的期刊', F.venues, '「库外」= 你库里还没有、AI 为覆盖少的分支建议的期刊；AIAA 期刊另外读它的目录 RSS'),
      row('跟踪的作者', F.authors),
      row('检索式', F.keywords, '每天在 OpenAlex 里轮流检索几条；也用来筛 arXiv'),
      row('arXiv 分类', F.arxiv),
      row('NTRS 检索', F.ntrs, '周六从 NASA 技术报告库挑一篇老报告'),
      row('核心文献', F.seeds, '追踪「谁引用了它们」')].filter(Boolean));
  }

  function collect() {
    const venue = (l) => { const [n, issns = '', aiaa = ''] = l.split('|').map((s) => s.trim()); const name = n.replace(/（库外）$/, ''); return { name, issns: issns.split(/\s+/).filter(Boolean), aiaa: aiaa.replace(/^aiaa:/, ''), extra: /（库外）$/.test(n) }; };
    const old = (p && p.follow) || {};
    return {
      line: F.line.value, questions: qs.filter((q) => String(q.text || '').trim()), suggestions: sugs,
      topics: topics.map((t) => ({ name: t.name, desc: t.desc, coverage: t.coverage, keywords: t.keywords, papers: t.papers })),
      follow: { venues: lines(F.venues).map(venue),
        authors: lines(F.authors).map((l) => { const [name, aid = ''] = l.split('|').map((s) => s.trim()); const o = (old.authors || []).find((a) => a.name === name && a.openalex === aid) || {}; return { ...o, name, openalex: /^A\d+$/.test(aid) ? aid : '' }; }),
        keywords: lines(F.keywords), arxiv: lines(F.arxiv), ntrs: lines(F.ntrs),
        seeds: lines(F.seeds).map((l) => { const [title, doi = '', sid = ''] = l.split('|').map((s) => s.trim()); const o = (old.seeds || []).find((s) => s.title === title) || {}; return { ...o, title, doi: doi || o.doi || '', openalex: sid || o.openalex || '' }; }) },
    };
  }
  async function save(confirmIt) {
    saveBtn.disabled = true; st.textContent = '保存中（会顺便去查期刊的 ISSN、作者和文献的 OpenAlex 编号）…';
    const r = await post('/api/lit/profile/save', { ...collect(), confirm: !!confirmIt });
    saveBtn.disabled = false;
    if (!r.ok) { st.textContent = r.msg || '没保存上'; return false; }
    return true;
  }
  async function fill() {
    if (!F.line.value.trim()) { st.textContent = '先写研究主线'; F.line.focus(); return; }
    if (p && p.filledAt && !confirm('重新调研会按现在的主线和问题，重写下面的分支、期刊、作者、检索式（你在下面改过的会被替换；主线和问题不动）。继续？')) return;
    if (!(await save(false))) return;
    const r = await post('/api/lit/profile/fill', {});
    if (r.ok) { running = true; st.textContent = '正在按主线调研你的文献库、补全下面的内容…（几分钟）'; poll(); render(); } else st.textContent = r.msg || '没开始';
  }
  saveBtn.addEventListener('click', async () => { if (await save(true)) { st.textContent = '已保存并确认'; refresh(); } });
  let pt = null;
  function poll() { clearTimeout(pt); pt = setTimeout(async () => { const r = await get('/api/lit/profile'); if (r && r.state && r.state.running) return poll(); refresh(); }, 4000); }
  return { refresh, destroy() { clearTimeout(pt); } };
}

export function mountStats(el) {
  const sel = h('select', { class: 'field' }, h('option', { value: '7', text: '最近 7 天' }), h('option', { value: '30', text: '最近 30 天' }));
  const body = h('div', { class: 'lp' });
  el.append(h('div', { class: 'lit-sub' }, sel), body);
  async function refresh() {
    const s = await get('/api/lit/stats?days=' + sel.value);
    if (!s) return;
    const row = (k, v, tip) => h('div', { class: 'ls-r' }, h('b', { text: String(v) }), h('span', { text: k }), tip ? h('small', { text: tip }) : null);
    body.replaceChildren(h('div', { class: 'ls-v', text: s.verdict }),
      h('h4', { text: '产出' }),
      row('张卡片核对过（对照了原文）', s.cards.verified), row('次读前写下自己的理解', s.understanding), row('条对话结论沉淀进卡片 / 专题', s.kept),
      row('个阅读行动进了重要计划', s.actions.added), row('个阅读行动做完了', s.actions.done), row('次专题更新', s.topics),
      h('h4', { text: '阅读' }),
      row('篇推送', s.feed.pushed), row('篇收下', s.feed.kept), row('篇跳过', s.feed.skipped, '跳过的会让以后的推荐更严格'), row('篇复习', s.feed.reviewed),
      row('张速读卡', s.cards.quick), row('张深读卡', s.cards.deep));
  }
  sel.addEventListener('change', refresh);
  return { refresh };
}
