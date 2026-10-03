// 文献 › 知识库: the Markdown folder of cards and topics (server/literature/kb.js; Obsidian can open the same folder).
//   待确认   the model's suggested changes (a new card over one the user edited, 沉淀 from a talk, a topic update):
//            the change line by line, 接受 / 改了再接受 / 不要. Nothing reaches the files before 接受.
//   专题     the user's own review pages: 从卡片更新 (proposed, not written), 相关工作段落 (\cite{citekey}, to copy)
//   搜索     every word in one card or topic
import { h } from '../util.js';
import { get, post } from './lit-api.js';
import { renderMd, lineDiff } from './lit-md.js';

export function mount(el, ctx) {
  const left = h('div', { class: 'lk-left' });
  const view = h('div', { class: 'lk-view' }, h('p', { class: 'lit-empty', text: '左边选一条修改建议或一个专题。' }));
  const back = h('button', { class: 'btn lb-back', type: 'button', text: '‹ 列表', onclick: () => el.classList.remove('viewing') });
  el.classList.add('lb');
  el.append(h('div', { class: 'lit-sub' }, back, h('span', { class: 'lit-st', text: '卡片和专题是群晖上的 Markdown 文件，Obsidian 打开同一个文件夹也能看、能改。' })), h('div', { class: 'lb-main' }, left, view));
  const q = h('input', { class: 'field', type: 'search', placeholder: '搜卡片和专题' });
  const newName = h('input', { class: 'field', placeholder: '新专题名，如：鞘套电子密度剖面' });
  let props = [], topics = [], hits = [], qT = null, curTopic = null;

  async function refresh() {
    const [p, t] = await Promise.all([get('/api/lit/proposals'), get('/api/lit/topics')]);
    props = (p && p.items) || []; topics = (t && t.items) || [];
    renderLeft();
  }
  function renderLeft() {
    const SRC = { card: '新卡片', distill: '沉淀', topic: '专题' };
    left.replaceChildren(
      h('h4', { text: `待确认的修改（${props.length}）` }),
      ...(props.length ? props.map((x) => h('div', { class: 'lb-i', onclick: () => showProposal(x.id) },
        h('div', { class: 'lb-t' }, h('i', { class: 'tag c', text: SRC[x.source] || '修改' }), h('span', { text: x.title })),
        h('div', { class: 'lb-m', text: x.reason || (x.op && x.op.section) || '' }))) : [h('p', { class: 'lit-empty', text: '没有。' })]),
      h('h4', { text: '专题' }),
      ...topics.map((t) => h('div', { class: 'lb-i' + (curTopic === t.path ? ' sel' : ''), onclick: () => showTopic(t.path) }, h('div', { class: 'lb-t', text: t.title }), h('div', { class: 'lb-m', text: t.updated ? '更新于 ' + t.updated : '' }))),
      h('div', { class: 'lk-new' }, newName, h('button', { class: 'btn', type: 'button', text: '新建', onclick: async () => {
        const r = await post('/api/lit/topic/create', { name: newName.value }); if (r.ok) { newName.value = ''; await refresh(); showTopic(r.path); } } })),
      h('h4', { text: '搜索' }), q,
      ...hits.map((x) => h('div', { class: 'lb-i', onclick: () => showFile(x.path) }, h('div', { class: 'lb-t', text: x.title }), h('div', { class: 'lb-m', text: x.snippet }))));
  }

  async function showProposal(id) {
    const v = await get('/api/lit/proposal?id=' + encodeURIComponent(id));
    if (!v) return refresh();
    // the changed lines with two lines around them; a skipped stretch shows as ⋯
    const all = lineDiff(v.before, v.after), diff = [];
    all.forEach((x, i) => {
      if (x.t === ' ' && !all.slice(Math.max(0, i - 2), i + 3).some((y) => y.t !== ' ')) { if (diff.length && diff[diff.length - 1].t !== '⋯') diff.push({ t: '⋯', line: '' }); return; }
      diff.push(x);
    });
    const ta = h('textarea', { class: 'field lb-edit', hidden: true, spellcheck: 'false' }); ta.value = v.after;
    const msg = h('span', { class: 'lit-st' });
    view.replaceChildren(h('div', { class: 'lb-head' },
      h('h3', { text: v.path }), h('div', { class: 'lf-m', text: v.reason }),
      v.changed ? h('div', { class: 'lb-tip', text: '提出这条建议之后，文件又被改过；下面是套用到现在内容上的结果。' }) : null,
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn go', type: 'button', text: '接受', onclick: async () => { const r = await post('/api/lit/proposal/accept', { id, ...(ta.hidden ? {} : { text: ta.value }) }); if (r.ok) { await refresh(); view.replaceChildren(h('p', { class: 'lit-empty', text: '已写入。' })); } else msg.textContent = r.msg || '没写进去'; } }),
        h('button', { class: 'btn', type: 'button', text: '改一改再接受', onclick: () => { ta.hidden = false; pre.hidden = true; } }),
        h('button', { class: 'btn no', type: 'button', text: '不要', onclick: async () => { await post('/api/lit/proposal/reject', { id }); await refresh(); view.replaceChildren(); } }), msg)),
    ta);
    const pre = h('pre', { class: 'lk-diff' }, ...diff.map((x) => h('div', { class: 'd' + (x.t === '+' ? ' add' : x.t === '-' ? ' del' : x.t === '⋯' ? ' gap' : ''), text: x.t === '⋯' ? '⋯' : (x.t === ' ' ? '  ' : x.t + ' ') + x.line })));
    view.append(pre);
    el.classList.add('viewing');
  }

  async function showTopic(path) {
    curTopic = path; renderLeft();
    const [r, s] = await Promise.all([get('/api/lit/kb?path=' + encodeURIComponent(path)), get('/api/lit/topic/state?path=' + encodeURIComponent(path))]);
    if (!r) return;
    const job = s && s.job;
    const box = h('div', { class: 'md' });
    const out = h('div', { class: 'lk-rel' });
    const msg = h('span', { class: 'lit-st', text: job && job.running ? '正在按卡片更新专题…' : job && job.error ? '上次更新失败：' + job.error : '' });
    view.replaceChildren(h('div', { class: 'lb-head' }, h('h3', { text: r.meta.title || path }),
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn go', type: 'button', text: '从卡片更新', title: '让 AI 按这个专题相关的卡片起草（放进待确认，不会直接覆盖）', onclick: async () => { const x = await post('/api/lit/topic/update', { path }); msg.textContent = x.ok ? '正在更新，好了会出现在「待确认的修改」里…' : x.msg; } }),
        h('button', { class: 'btn', type: 'button', text: '写相关工作段落', title: '学位论文 / 投稿用，带 \\cite{citekey}', onclick: async (e) => {
          e.target.disabled = true; out.replaceChildren(h('p', { class: 'lit-empty', text: '正在写…（一两分钟）' }));
          const x = await post('/api/lit/topic/related', { path }); e.target.disabled = false;
          if (!x.ok) { out.replaceChildren(h('p', { class: 'lit-empty', text: x.msg || '没写出来' })); return; }
          const ta = h('textarea', { class: 'field lb-edit', rows: 10 }); ta.value = x.paragraph;
          out.replaceChildren(h('h4', { text: '相关工作（草稿，复制去改）' }), ta, h('button', { class: 'btn', type: 'button', text: '复制', onclick: () => navigator.clipboard && navigator.clipboard.writeText(ta.value) }));
        } }),
        h('button', { class: 'btn', type: 'button', text: '编辑', onclick: () => edit(r, () => showTopic(path)) }), msg)), out, box);
    renderMd(box, r.text, { onLink: (k) => ctx.openCitekey(k) });
    el.classList.add('viewing');
  }
  async function showFile(path) {
    if (path.startsWith('topics/')) return showTopic(path);
    const r = await get('/api/lit/kb?path=' + encodeURIComponent(path)); if (!r) return;
    if (r.meta.zotero) return ctx.openItem(r.meta.zotero);
    const box = h('div', { class: 'md' }); view.replaceChildren(box); renderMd(box, r.text, { onLink: (k) => ctx.openCitekey(k) }); el.classList.add('viewing');
  }
  function edit(r, done) {
    const ta = h('textarea', { class: 'field lb-edit', spellcheck: 'false' }); ta.value = r.text;
    const msg = h('span', { class: 'lit-st' });
    view.replaceChildren(h('div', { class: 'lb-head' }, h('h3', { text: '编辑：' + r.path }), h('div', { class: 'gbtns' },
      h('button', { class: 'btn go', type: 'button', text: '保存', onclick: async () => { const x = await post('/api/lit/kb/save', { path: r.path, text: ta.value, base: r.hash }); if (x.ok) done(); else msg.textContent = x.msg || '没保存上'; } }),
      h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }), msg)), ta);
  }
  q.addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(async () => { const r = await get('/api/lit/kb/search?q=' + encodeURIComponent(q.value.trim())); hits = (r && r.items) || []; renderLeft(); q.focus(); }, 300); });
  return { refresh, onLit: (w) => { if (w === 'kb' || w === 'proposals') refresh(); } };
}
