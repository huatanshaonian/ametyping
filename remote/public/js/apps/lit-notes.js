// 深读 › 笔记: the column beside the reading where the user keeps their own notes on the paper (server/literature/notes.js).
// A note is typed (Markdown, $LaTeX$) or written by hand on a small 画板 (board-surface.js: a pen with pressure, a mouse,
// fingers), or both; it remembers the page the PDF was at and the passage selected in it then (the page is a link back).
// A note by hand can be 认字 (read into type by the model); any note can go into 重要计划 (a todo that opens the paper
// at that page again). 改 puts a note back into the box below to be changed.
import { h, hhmm } from '../util.js';
import { get, post, onLit } from './lit-api.js';
import { renderMd } from './lit-md.js';
import { createSurface } from './board-surface.js';
import { TOOLS } from './board-ink.js';
import { icon as ico } from './board-icons.js';
import { confirmBox } from '../dialog.js';
import * as todos from '../todos.js';

const COLORS = ['#222222', '#d93025', '#1a73e8', '#188038'];
const day = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(t)}`; };

// curPage(): the page the PDF shows; selected(): the text selected in the PDF ('' when none); goto(n): show page n
export function notesPanel(key, { curPage, selected, goto }) {
  let items = [], reading = new Set(), mode = 'text', editing = null, sel = '', dropSel = false, busy = false;
  const count = h('span', { class: 'ln-n' });
  const modeBtn = (m, text, title) => h('button', { class: 'lit-tab', type: 'button', text, title, dataset: { m }, onclick: () => setMode(m) });
  const modes = [modeBtn('text', '打字', '打字记一条（Markdown，公式写 $…$）'), modeBtn('ink', '手写', '用笔、鼠标或手指写一条')];
  const listEl = h('div', { class: 'ln-list' });

  // ---- the box for a new note (or the one being changed) ----
  const ta = h('textarea', { class: 'field lr-in ln-ta', rows: 4 });
  const surface = createSurface({ onInk: () => buttons(), onUi: () => {} });
  const ink = { pencil: { c: COLORS[0] }, marker: { c: '#ffd400' } };
  let tool = 'pencil';
  const toolB = (t, title) => h('button', { class: 'btn bd-ib', type: 'button', title, 'aria-label': title, dataset: { tool: t }, onclick: () => setTool(t) }, ico(t));
  const tools = [toolB('pencil', '铅笔'), toolB('marker', '荧光笔'), toolB('eraser', '橡皮：碰到的一整笔擦掉')];
  const swatches = COLORS.map((c) => h('button', { class: 'bd-sw', type: 'button', title: c, dataset: { c }, style: `background:${c}`, onclick: () => { ink[tool === 'marker' ? 'marker' : 'pencil'].c = c; if (tool === 'eraser') setTool('pencil'); surface.setColor(c); buttons(); } }));
  const undoB = h('button', { class: 'btn bd-ib', type: 'button', title: '撤销（Ctrl + Z）', onclick: () => { surface.undo(); buttons(); } }, ico('undo'));
  const clearB = h('button', { class: 'btn bd-ib', type: 'button', title: '清空（能撤销）', onclick: () => { surface.clear(); buttons(); } }, ico('clear'));
  const pad = h('div', { class: 'ln-pad', hidden: true }, h('div', { class: 'ln-tools' }, ...tools, h('span', { class: 'bd-gap' }), ...swatches, h('span', { class: 'bd-gap' }), undoB, clearB), surface.el);
  const selNote = h('div', { class: 'lr-sel ln-sel' });
  const saveB = h('button', { class: 'btn go', type: 'button', text: '记下', onclick: () => save() });
  const cancelB = h('button', { class: 'btn', type: 'button', text: '不改了', hidden: true, onclick: () => reset() });
  const msg = h('small', { class: 'lit-st' });
  const box = h('div', { class: 'ln-new' }, selNote, pad, ta, h('div', { class: 'gbtns' }, saveB, cancelB, msg));
  const el = h('div', { class: 'ln' }, h('div', { class: 'lit-bar ln-head' }, h('b', { text: '笔记' }), count, h('span', { class: 'ln-gap' }), ...modes), listEl, box);

  function setTool(t) {
    tool = t; surface.setTool(t);
    if (t !== 'eraser') surface.setColor(ink[t].c);
    for (const b of tools) b.classList.toggle('sel', b.dataset.tool === t);
    buttons();
  }
  function buttons() {
    const c = tool === 'marker' ? ink.marker.c : ink.pencil.c;
    for (const s of swatches) s.classList.toggle('sel', tool !== 'eraser' && s.dataset.c === c);
    undoB.disabled = !surface.canUndo(); clearB.disabled = !surface.count();
  }
  function setMode(m) {
    mode = m; pad.hidden = m !== 'ink';
    for (const b of modes) b.classList.toggle('on', b.dataset.m === m);
    ta.rows = m === 'ink' ? 2 : 4;
    ta.placeholder = m === 'ink' ? '配一句文字（可不填）' : '记一条：想法、疑问、要验证的、要和仿真对比的……（Markdown，公式写 $…$；Ctrl+Enter 记下）';
  }
  // the passage selected in the PDF goes with the note (× leaves it out)
  function showSel() {
    const s = dropSel ? '' : sel;
    const page = editing ? editing.page : curPage();
    selNote.replaceChildren(s ? h('span', { text: `会带上选中的：${s.slice(0, 60)}${s.length > 60 ? '…' : ''}` }) : h('span', { text: page ? `记在第 ${page} 页（在 PDF 里选中一段，会一起记下）` : '在 PDF 里选中一段，会和笔记一起记下' }),
      ...(s ? [h('button', { class: 'ln-x', type: 'button', text: '×', title: '不带这段', onclick: () => { dropSel = true; showSel(); } })] : []));
  }
  const onSel = () => { if (editing) return; const s = selected(); if (s && s !== sel) { sel = s; dropSel = false; showSel(); } };
  document.addEventListener('selectionchange', onSel);
  ta.addEventListener('focus', showSel);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
  pad.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); surface.undo(); buttons(); } });

  function reset() {
    editing = null; ta.value = ''; sel = ''; dropSel = false; surface.load({ strokes: [] });
    saveB.textContent = '记下'; cancelB.hidden = true; msg.textContent = '';
    buttons(); showSel(); render();
  }
  async function save() {
    if (busy) return;
    // (what is on the pad is kept even when switched to typing: 清空 takes it off)
    const text = ta.value.trim(), strokes = surface.count(), was = editing;
    if (!text && !strokes) { msg.textContent = '还没写东西'; return; }
    const body = { key, text, page: editing ? editing.page : curPage(), sel: dropSel ? '' : sel };
    if (editing) body.id = editing.id;
    if (strokes) {
      surface.unpick();
      const p = surface.picture(1400);
      body.ink = surface.doc(); body.png = p.canvas.toDataURL('image/png');
    }
    busy = true; saveB.disabled = true; msg.textContent = '保存中…';
    const r = await post('/api/lit/notes/save', body);
    busy = false; saveB.disabled = false;
    if (!r || !r.ok) { msg.textContent = (r && r.msg) || '没存上'; return; }
    reset();
    await load();
    if (!was) listEl.scrollTop = listEl.scrollHeight;
  }
  function edit(n) {
    editing = n; ta.value = n.text || ''; sel = n.sel || ''; dropSel = false;
    setMode(n.img ? 'ink' : 'text');
    surface.load(n.ink || { strokes: [] });
    saveB.textContent = '改好了'; cancelB.hidden = false; msg.textContent = '';
    buttons(); showSel(); render();
    (n.img ? surface.el : ta).focus({ preventScroll: true });
  }

  // ---- the notes ----
  function todoState(n) {
    if (!n.todo) return null;
    const t = todos.list().find((x) => x.id === n.todo);
    return t ? (t.done ? '✓ 待办已完成' : '✓ 已在重要计划') : null;
  }
  function note(n) {
    const md = (text) => { const d = h('div', { class: 'md lr-md' }); renderMd(d, text, { onPage: goto }); return d; };
    const rd = reading.has(n.id), td = todoState(n);
    const act = (text, title, fn, extra = {}) => h('button', { class: 'btn', type: 'button', text, title, onclick: fn, ...extra });
    return h('div', { class: 'ln-i' + (editing && editing.id === n.id ? ' on' : ''), dataset: { id: n.id } },
      h('div', { class: 'ln-meta' },
        n.page ? h('button', { class: 'ln-pg', type: 'button', text: 'p.' + n.page, title: '跳到第 ' + n.page + ' 页', onclick: () => goto(n.page) }) : null,
        h('small', { text: day(n.updated || n.at) }), td ? h('small', { class: 'ln-td', text: td }) : null),
      n.sel ? h('blockquote', { class: 'ln-q', text: n.sel.length > 240 ? n.sel.slice(0, 240) + '…' : n.sel }) : null,
      n.img ? h('img', { class: 'ln-img', src: `/api/lit/notes/img?key=${key}&id=${n.id}&v=${n.updated || n.at}`, alt: '手写笔记', width: n.w, height: n.h }) : null,
      n.img && n.ocr ? h('div', { class: 'ln-ocr' }, h('small', { text: '认字：' }), md(n.ocr)) : null,
      n.text ? md(n.text) : null,
      h('div', { class: 'gbtns ln-acts' },
        act('改', '放回下面的框里修改', () => edit(n)),
        n.img && !n.ocr ? act(rd ? '认字中…' : '认字', '让 AI 把手写的内容转成文字（公式转成 LaTeX）', async () => { const r = await post('/api/lit/notes/read', { key, id: n.id }); if (!r.ok) flash(n.id, r.msg); }, { disabled: rd }) : null,
        td ? null : act(rd ? '认字中…' : '列入待办', '加进「重要计划」：记着这篇和这一页，从待办里能直接打开回来' + (n.img && !n.text && !n.ocr ? '（手写的会先认字）' : ''), async (e) => {
          e.target.disabled = true; e.target.textContent = '加入中…';
          const r = await post('/api/lit/notes/todo', { key, id: n.id });
          if (!r.ok) { flash(n.id, r.msg); e.target.disabled = false; e.target.textContent = '列入待办'; } else { await todos.load(); load(); }
        }, { disabled: rd }),
        act('删', '删掉这条笔记', async () => { if (await confirmBox('删掉这条笔记？', { title: '删除笔记', ok: '删除', danger: true })) { await post('/api/lit/notes/delete', { key, id: n.id }); if (editing && editing.id === n.id) reset(); else load(); } }),
        h('small', { class: 'lit-st ln-msg' })));
  }
  function flash(id, text) { const m = listEl.querySelector(`.ln-i[data-id="${id}"] .ln-msg`); if (m) { m.textContent = text || '没成功'; m.classList.add('bad'); } }
  function render() {
    const top = listEl.scrollTop;
    count.textContent = items.length ? `（${items.length}）` : '';
    listEl.replaceChildren(...(items.length ? [...items].sort((a, b) => a.at - b.at).map(note)
      : [h('p', { class: 'lit-empty', text: '读的时候随手记：没看懂的、想验证的、和自己课题有关的。每条会记下当时在第几页；在 PDF 里先选中一段再记，会带上那段原文。可以打字，也可以切到「手写」用笔写；写好的一条能「列入待办」。笔记也会存进知识库，重做深读卡时会参考。' })]));
    listEl.scrollTop = top;
  }
  async function load() {
    const d = await get('/api/lit/notes?key=' + encodeURIComponent(key));
    if (!d) return;
    items = d.items || []; reading = new Set(d.reading || []);
    render();
  }

  const off = onLit((w) => { if (w === 'notes:' + key) load(); });
  const offTodos = todos.subscribe(() => { if (items.some((n) => n.todo)) render(); });
  setMode('text'); setTool('pencil');                 // (the page shown is asked for once the reader is built: load's then)
  load().then(() => { showSel(); listEl.scrollTop = listEl.scrollHeight; });
  return {
    el,
    focus() { (mode === 'ink' ? surface.el : ta).focus({ preventScroll: true }); },
    destroy() { off(); offTodos(); document.removeEventListener('selectionchange', onSel); surface.destroy(); },
  };
}
