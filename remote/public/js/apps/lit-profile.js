// 文献 › 画像: what the push and the cards are aimed at (server/literature/profile.js). The model drafts it from the
// Zotero library and the recent daily reports; the user corrects it and confirms. Most important: 当前问题 -- every
// pushed paper and every card is tied to one of them. The follow lists are one item per line.
// 文献 › 产出 (mountStats): what reading turned into over the last week / month.
import { h } from '../util.js';
import { get, post } from './lit-api.js';

const lines = (ta) => ta.value.split('\n').map((s) => s.trim()).filter(Boolean);

export function mount(el, ctx) {
  const st = h('span', { class: 'lit-st' });
  const draftBtn = h('button', { class: 'btn', type: 'button', text: '让 AI 起草', title: '读你的 Zotero 库和最近两周的日报，起草画像（几分钟）' });
  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存并确认' });
  const body = h('div', { class: 'lp' });
  el.append(h('div', { class: 'lit-sub' }, draftBtn, saveBtn, st), body);
  let p = null, qs = [];

  async function refresh() {
    const r = await get('/api/lit/profile');
    p = r && r.profile; const s = (r && r.state) || {};
    draftBtn.disabled = !!s.running;
    st.classList.toggle('bad', !!s.error);
    st.textContent = s.running ? '正在起草画像…（几分钟）' : s.error ? '起草失败：' + s.error : !p ? '还没有画像：点「让 AI 起草」' : p.confirmed ? '已确认（改了记得保存）' : '这是 AI 的草稿：看一遍、改一改，再点「保存并确认」';
    render();
  }
  const area = (v, rows = 4, ph = '') => { const t = h('textarea', { class: 'field', rows, placeholder: ph }); t.value = v || ''; return t; };
  let F = {};
  function render() {
    const f = (p && p.follow) || {};
    qs = ((p && p.questions) || []).map((q) => ({ ...q }));
    F = {
      summary: area(p && p.summary, 3, '你在研究什么（具体到物理问题和方法）'),
      topics: area(((p && p.topics) || []).map((t) => `${t.name}：${(t.keywords || []).join(', ')}`).join('\n'), 5, '主题：检索词, 检索词'),
      venues: area((f.venues || []).map((v) => `${v.name}${(v.issns || []).length ? ' | ' + v.issns.join(' ') : ''}${v.aiaa ? ' | aiaa:' + v.aiaa : ''}`).join('\n'), 5, '期刊名 | ISSN ISSN | aiaa:代码'),
      authors: area((f.authors || []).map((a) => `${a.name}${a.openalex ? ` | ${a.openalex} | ${a.inst || ''}${a.guess ? '（按姓名猜的，请核对）' : ''}` : ' | （没找到）'}`).join('\n'), 4, '作者名 | OpenAlex 编号（可空：从你库里这位作者带 DOI 的论文去查）'),
      keywords: area((f.keywords || []).join('\n'), 4, '英文检索式，一行一个'),
      arxiv: area((f.arxiv || []).join('\n'), 2, 'physics.plasm-ph'),
      ntrs: area((f.ntrs || []).join('\n'), 3, 'NASA 老报告检索式，周六推一篇'),
      seeds: area((f.seeds || []).map((s) => `${s.title}${s.doi ? ' | ' + s.doi : ''}${s.openalex ? ' | ' + s.openalex : ''}`).join('\n'), 4, '核心文献（追踪谁引用了它们）'),
    };
    const qBox = h('div', { class: 'lp-qs' });
    const drawQs = () => qBox.replaceChildren(...qs.map((q, i) => h('div', { class: 'lp-q' + (q.status === 'done' ? ' done' : '') },
      h('b', { text: 'Q' + (i + 1) }),
      (() => { const t = h('input', { class: 'field', value: q.text }); t.addEventListener('input', () => { q.text = t.value; }); return t; })(),
      h('button', { class: 'btn', type: 'button', text: q.status === 'done' ? '重新打开' : '解决了', title: '解决了的问题不再用来挑文献', onclick: () => { q.status = q.status === 'done' ? 'open' : 'done'; drawQs(); } }),
      h('button', { class: 'btn no', type: 'button', text: '删', onclick: () => { qs.splice(i, 1); drawQs(); } }),
      q.why ? h('small', { text: q.why }) : null)),
    h('button', { class: 'btn', type: 'button', text: '＋ 加一个问题', onclick: () => { qs.push({ text: '', status: 'open', mine: true }); drawQs(); } }));
    drawQs();
    const row = (label, el2, tip) => h('div', { class: 'lp-row' }, h('label', { text: label }), el2, tip ? h('small', { text: tip }) : null);
    body.replaceChildren(
      row('研究方向', F.summary),
      h('div', { class: 'lp-row' }, h('label', { text: '当前问题' }), h('div', {}, h('small', { text: '最重要的部分：每篇推送和每张卡片都挂到这里的某个问题上。写成你自己会说的具体问题。' }), qBox)),
      row('主题', F.topics, '一行一个：主题名：检索词, 检索词'),
      row('跟踪的期刊', F.venues, 'ISSN 从你的库里自动找；AIAA 期刊会另外读它的目录 RSS'),
      row('跟踪的作者', F.authors),
      row('检索式', F.keywords, '每天在 OpenAlex 里检索前 4 条'),
      row('arXiv 分类', F.arxiv),
      row('NTRS 检索', F.ntrs, '周六从 NASA 技术报告库挑一篇老报告'),
      row('核心文献', F.seeds, '追踪「谁引用了它们」'));
  }
  async function save() {
    const venue = (l) => { const [name, issns = '', aiaa = ''] = l.split('|').map((s) => s.trim()); return { name, issns: issns.split(/\s+/).filter(Boolean), aiaa: aiaa.replace(/^aiaa:/, '') }; };
    const old = (p && p.follow && p.follow.seeds) || [];
    const d = {
      summary: F.summary.value, confirm: true,
      questions: qs.filter((q) => String(q.text || '').trim()),
      topics: lines(F.topics).map((l) => { const [name, kw = ''] = l.split(/[:：]/); return { name: name.trim(), keywords: kw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }; }),
      follow: { venues: lines(F.venues).map(venue), authors: lines(F.authors).map((l) => {
        const [name, id = ''] = l.split('|').map((s) => s.trim());
        const o = ((p && p.follow && p.follow.authors) || []).find((a) => a.name === name && a.openalex === id) || {};
        return { ...o, name, openalex: /^A\d+$/.test(id) ? id : '' };
      }),
        keywords: lines(F.keywords), arxiv: lines(F.arxiv), ntrs: lines(F.ntrs),
        seeds: lines(F.seeds).map((l) => { const [title, doi = '', id = ''] = l.split('|').map((s) => s.trim()); const o = old.find((s) => s.title === title) || {}; return { ...o, title, doi: doi || o.doi || '', openalex: id || o.openalex || '' }; }) },
    };
    saveBtn.disabled = true; st.textContent = '保存中（会顺便去 OpenAlex 查作者和文献的编号）…';
    const r = await post('/api/lit/profile/save', d);
    saveBtn.disabled = false;
    if (r.ok) { st.textContent = '已保存并确认'; refresh(); } else st.textContent = r.msg || '没保存上';
  }
  draftBtn.addEventListener('click', async () => {
    if (p && p.confirmed && !confirm('重新起草会按现在的文献库和日报更新画像（你自己写的问题会保留）。继续？')) return;
    const r = await post('/api/lit/profile/draft', {}); if (r.ok) { st.textContent = '正在起草画像…（几分钟）'; draftBtn.disabled = true; poll(); }
  });
  saveBtn.addEventListener('click', save);
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
