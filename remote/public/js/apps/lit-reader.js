// 深读: one paper, the PDF on the left (pdfview.js; select text to ask about it, [p.N] in answers jumps there), and on
// the right:
//   理解  write what you understood / want from it first; the model compares it with the paper (what is right, what
//         was missed) and asks one question back -- reading as practice, not outsourcing
//   对话  questions about the paper, answered from its pages; 沉淀到卡片 turns what the talk found into proposed card
//         additions (知识库 › 待确认)
//   卡片  the card; 深读卡 from the full text
// server/literature/reader.js; answers arrive by the server's 'lit' event (read:<key>).
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import { get, post, onLit, readerId } from './lit-api.js';
import { renderMd } from './lit-md.js';
import { visionBox } from './lit-vision.js';

export function openReader(key, page) {
  const id = readerId(key);
  if (wm.has(id)) { wm.open({ id }); if (page && readers.get(key)) readers.get(key).goto(page); return; }
  const r = mountReader(key, page);
  readers.set(key, r);
  wm.open({ id, title: '深读', icon: icon('help_book_big', true), content: r.root, width: 1100, height: 700, onClose: () => { r.destroy(); readers.delete(key); } });
  r.setTitle = (t) => { const w = wm.get(id); if (w) w.handle.setTitle('深读：' + t); };
}
const readers = new Map();

function mountReader(key, firstPage) {
  const pdfBox = h('div', { class: 'pdf-wrap lr-pdf' }, h('div', { class: 'vnote', text: '读取 PDF…' }));
  const tabs = ['理解', '对话', '卡片'].map((t) => h('button', { class: 'lit-tab', type: 'button', text: t, dataset: { t } }));
  const pane = h('div', { class: 'lr-pane' });
  const swap = h('button', { class: 'btn lr-swap', type: 'button', text: '看 PDF / 看对话' });
  // 读图: how much has been read as images, a request to approve, the transcription of the page shown
  const vbox = visionBox(key, { curPage: () => +((pdfBox.querySelector('.pdf-no') || {}).value || 0) });
  const side = h('div', { class: 'lr-side' }, h('div', { class: 'lit-bar' }, ...tabs, swap), vbox.el, pane);
  const root = h('div', { class: 'lr' }, pdfBox, side);
  let item = null, st = { turns: [] }, tab = '理解', pdf = null, destroyed = false;
  const drafts = { chat: '', mine: null };                // (what is being typed survives a refresh)

  const goto = (n) => { const no = pdfBox.querySelector('.pdf-no'); if (!no) return; no.value = n; no.dispatchEvent(new Event('change')); root.classList.remove('side'); };
  const curPage = () => +((pdfBox.querySelector('.pdf-no') || {}).value || 0);
  const selected = () => { const s = document.getSelection(); return s && s.rangeCount && pdfBox.contains(s.anchorNode) ? s.toString().trim() : ''; };

  async function loadPdf() {
    try {
      const res = await fetch('/api/lit/pdf?key=' + encodeURIComponent(key));
      if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch {} pdfBox.replaceChildren(h('div', { class: 'notice' }, m || '没有 PDF。', h('br'), '拿到 PDF 后拖进 Zotero 里这篇下面，同步过来就能在这里读。', item && item.abstract ? h('p', { class: 'lr-abs', text: item.abstract }) : null)); return; }
      const { renderPdf } = await import('./pdfview.js');
      if (destroyed) return;
      pdf = await renderPdf(pdfBox, await res.arrayBuffer());
      if (firstPage) setTimeout(() => goto(firstPage), 400);
    } catch (e) { pdfBox.replaceChildren(h('div', { class: 'notice', text: 'PDF 打不开：' + (e.message || e) })); }
  }
  async function load() {
    const [d, s] = await Promise.all([get('/api/lit/item?key=' + encodeURIComponent(key)), get('/api/lit/read?key=' + encodeURIComponent(key))]);
    item = d; st = s || { turns: [] };
    if (item && readers.get(key) && readers.get(key).setTitle) readers.get(key).setTitle(item.title);
    render();
  }
  function show(t) { tab = t; for (const b of tabs) b.classList.toggle('on', b.dataset.t === t); render(); }
  const busy = () => st.job && st.job.running;
  const md = (text) => { const el = h('div', { class: 'md lr-md' }); renderMd(el, text, { onPage: goto }); return el; };

  function render() {
    if (pane._off) { pane._off(); pane._off = null; }
    if (!item) { pane.replaceChildren(h('p', { class: 'lit-empty', text: '读取中…' })); return; }
    if (tab === '理解') return renderMine();
    if (tab === '对话') return renderChat();
    return renderCard();
  }
  function mineText() {
    const t = item.card ? item.card.text : '';
    const m = /^##\s+我的理解\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(t);
    return m ? m[1].trim() : '';
  }
  function renderMine() {
    const ta = h('textarea', { class: 'field lr-in', rows: 7, placeholder: '先用自己的话写：这篇在解决什么问题？方法的关键是什么？你想从里面拿到什么（数据、方法、对比）？\n写得粗糙也没关系——写完再让 AI 对照原文指出哪里对、哪里漏了。' });
    ta.value = drafts.mine != null ? drafts.mine : (st.feedback && st.feedback.mine) || mineText();
    ta.addEventListener('input', () => { drafts.mine = ta.value; });
    const fb = st.feedback;
    pane.replaceChildren(h('div', { class: 'lr-sec' },
      h('p', { class: 'lr-tip', text: '先自己想，再看 AI 的。这一步是在练读文献，不是把读文献交出去。' }), ta,
      h('div', { class: 'gbtns' }, h('button', { class: 'btn go', type: 'button', text: busy() && st.job.what === 'feedback' ? '对照中…' : '写好了，对照原文', disabled: busy(), onclick: async () => {
        const r = await post('/api/lit/understand', { key, text: ta.value }); if (r.ok) { drafts.mine = null; st.job = { running: true, what: 'feedback' }; render(); } } })),
      st.job && st.job.error && st.job.what === 'feedback' ? h('p', { class: 'lit-empty bad', text: st.job.error }) : null,
      fb ? h('div', { class: 'lr-fb' }, h('h4', { text: 'AI 的对照' }), md(fb.feedback),
        (fb.missed || []).length ? h('div', {}, h('b', { text: '你可能漏了：' }), h('ul', {}, ...fb.missed.map((x) => h('li', {}, md(x))))) : null,
        fb.askBack ? h('div', { class: 'lr-ask' }, h('b', { text: '反问：' }), md(fb.askBack), h('button', { class: 'btn', type: 'button', text: '去对话里回答', onclick: () => { show('对话'); const i = pane.querySelector('.lr-q'); if (i) { i.value = '关于「' + fb.askBack.slice(0, 60) + '」，我的回答是：'; i.focus(); } } })) : null) : null));
  }
  function renderChat() {
    const list = h('div', { class: 'lr-chat' });
    for (const t of st.turns || []) {
      list.append(...[h('div', { class: 'lr-me' }, t.sel ? h('blockquote', { text: t.sel.slice(0, 300) + (t.sel.length > 300 ? '…' : '') }) : null, h('span', { text: t.q })), h('div', { class: 'lr-ai' }, md(t.a)),
        t.askBack ? h('div', { class: 'lr-ask' }, h('b', { text: '反问：' }), md(t.askBack)) : null].filter(Boolean));
    }
    if (busy() && st.job.what === 'chat') list.append(h('div', { class: 'lr-ai lit-empty', text: '在读原文、组织回答…（一般半分钟到两分钟；还在读图的页先用文字层）' }));
    if (st.job && st.job.error && st.job.what === 'chat') list.append(h('div', { class: 'lit-empty bad', text: '没回答出来：' + st.job.error }));
    if (!(st.turns || []).length && !busy()) list.append(h('p', { class: 'lit-empty', text: '问什么都行：某个推导怎么来的、假设在你的条件下成不成立、和你的仿真怎么对比。在左边 PDF 里选中文字再问，会带上那段原文。' }));
    const q = h('textarea', { class: 'field lr-in lr-q', rows: 3, placeholder: '你的问题（Ctrl+Enter 发送）' });
    q.value = drafts.chat; q.addEventListener('input', () => { drafts.chat = q.value; });
    const selNote = h('div', { class: 'lr-sel' });
    const refreshSel = () => { const s = selected(); selNote.textContent = s ? `会带上选中的：${s.slice(0, 80)}${s.length > 80 ? '…' : ''}` : `（当前第 ${curPage() || '?'} 页；可以在 PDF 里选中一段再问）`; };
    q.addEventListener('focus', refreshSel);
    let lastSel = '';
    document.addEventListener('selectionchange', onSel);
    function onSel() { const s = selected(); if (s) { lastSel = s; refreshSel(); } }
    const send = async () => {
      const text = q.value.trim(); if (!text || busy()) return;
      const r = await post('/api/lit/chat', { key, q: text, sel: selected() || lastSel, page: curPage() });
      if (r.ok) { q.value = ''; drafts.chat = ''; lastSel = ''; st.job = { running: true, what: 'chat' }; st.turns = [...(st.turns || [])]; render(); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    const distilled = st.lastDistill ? `上次沉淀了 ${st.lastDistill.n} 条` : '';
    pane.replaceChildren(list, h('div', { class: 'lr-box' }, selNote, q, h('div', { class: 'gbtns' },
      h('button', { class: 'btn go', type: 'button', text: '问', disabled: busy(), onclick: send }),
      h('button', { class: 'btn', type: 'button', text: busy() && st.job.what === 'distill' ? '沉淀中…' : '沉淀到卡片', title: '把对话里值得留下的结论整理成对卡片的修改建议（在「知识库」里确认）', disabled: busy(),
        onclick: async () => { const r = await post('/api/lit/distill', { key }); if (r.ok) { st.job = { running: true, what: 'distill' }; render(); } } }),
      h('small', { class: 'lit-st', text: distilled }))));
    pane._off = () => document.removeEventListener('selectionchange', onSel);
    list.scrollTop = list.scrollHeight;
    refreshSel();
  }
  function renderCard() {
    const c = item.card;
    const msg = h('span', { class: 'lit-st', text: item.job && item.job.running ? `正在生成${item.job.kind === 'deep' ? '深读' : '速读'}卡…` : item.job && item.job.error ? '上次失败：' + item.job.error : '' });
    pane.replaceChildren(h('div', { class: 'gbtns' },
      h('button', { class: 'btn go', type: 'button', text: c && /deep|reviewed/.test(c.meta.status) ? '重做深读卡' : '生成深读卡', title: '按全文写（会参考你写下的理解和批注）', disabled: item.job && item.job.running,
        onclick: async () => { const r = await post('/api/lit/card', { key, kind: 'deep' }); msg.textContent = r.ok ? '正在生成深读卡…（一两分钟）' : r.msg; } }),
      c && c.meta.status !== 'none' ? h('button', { class: 'btn', type: 'button', text: c.meta.verified ? '✓ 已核对' : '核对过了', onclick: async () => { await post('/api/lit/card/meta', { key, verified: !c.meta.verified }); load(); } }) : null, msg),
    c ? md(c.text) : h('p', { class: 'lit-empty', text: '还没有卡片。读完、聊完之后生成深读卡，它会参考你写下的理解。' }));
  }

  for (const b of tabs) b.addEventListener('click', () => { if (pane._off) pane._off(); show(b.dataset.t); });
  swap.addEventListener('click', () => root.classList.toggle('side'));
  const off = onLit((w) => { if (w === 'read:' + key || w === 'card:' + key || (w === 'kb' && tab === '卡片')) load(); });
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 760));
  ro.observe(root);
  load().then(() => { show(mineText() || (st.feedback) ? '对话' : '理解'); loadPdf(); });
  return { root, goto, destroy() { destroyed = true; off(); vbox.destroy(); ro.disconnect(); if (pane._off) pane._off(); if (pdf) pdf.destroy(); } };
}
