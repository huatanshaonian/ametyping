// 画板's results: what the model made of one board, a window per board.
//   还原稿   the handwritten page 誊清 into type where it was written (board-sheet.js), with what the model was unsure of
//   文字档   the same page as Markdown (for searching, copying, giving to a model again)
//   设计稿   a designed page made from the 还原稿 when you ask for one (a line of wishes may go with it)
//   原稿     the picture the model was given, to compare
// Each can be saved: the two pages as HTML files that open anywhere, the text as .md. The model takes a minute or
// more; the window follows it (the server says `boards` when something changes; asked every few seconds meanwhile).
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import { restorePage, designPage, frameOf, download } from './board-page.js';

const TABS = [['restore', '还原稿'], ['md', '文字档'], ['design', '设计稿'], ['shot', '原稿']];
const WORK = { restore: '正在誊清这一页', design: '正在做设计稿' };
const wins = new Map();                            // board id -> { close, show(tab) }
const post = async (what, body) => { try { return await (await fetch('/api/boards/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return { ok: false, msg: '连不上服务器' }; } };

export function close(id) { if (wins.has(id)) wm.close('board-out:' + id); }
export function show(id, title, tab) {
  const w = wins.get(id);
  if (w) { wm.open({ id: 'board-out:' + id }); if (tab) w.show(tab); return; }
  const v = mount(id, title, tab || 'restore');
  wins.set(id, v);
  wm.open({ id: 'board-out:' + id, title: `${title} — AI 誊清`, icon: '/icons/paint-16.png', content: v.root, width: 860, height: 640, onClose: () => { v.destroy(); wins.delete(id); } });
}

function mount(id, title, first) {
  let o = { restore: null, design: null, job: null, error: null }, tab = first, shown = '', dead = false;
  const tabs = TABS.map(([k, text]) => h('button', { class: 'btn bo-tab', type: 'button', text, dataset: { tab: k }, onclick: () => { tab = k; draw(true); } }));
  const saveB = h('button', { class: 'btn', type: 'button', onclick: save });
  const copyB = h('button', { class: 'btn', type: 'button', text: '复制', title: '把文字档复制到剪贴板', onclick: async () => { try { await navigator.clipboard.writeText(o.restore.markdown); note('已复制'); } catch { note('复制失败', true); } } });
  const state = h('div', { class: 'bo-state' }), body = h('div', { class: 'bo-body' });
  const wish = h('input', { class: 'field bo-wish', maxlength: 300, placeholder: '对设计的要求（可不填），例如：深色、杂志风、适合打印成一页' });
  const designB = h('button', { class: 'btn go', type: 'button', onclick: design });
  const designBar = h('form', { class: 'bo-design', onsubmit: (e) => { e.preventDefault(); design(); } }, wish, designB);
  const root = h('div', { class: 'bo' }, h('div', { class: 'bo-bar' }, ...tabs, h('span', { class: 'bd-gap' }), copyB, saveB), state, body, designBar);
  let noteT = null, said = null;
  const note = (s, bad) => { said = { s, bad }; clearTimeout(noteT); noteT = setTimeout(() => { said = null; head(); }, 4000); head(); };

  // the line under the tabs: what the model is doing, what went wrong, what it was unsure of
  function head() {
    const kids = [];
    if (o.job) kids.push(h('span', { class: 'bo-work', text: `${WORK[o.job.kind]}…（${Math.max(0, Math.round((Date.now() - o.job.since) / 1000))} 秒）` }));
    else if (o.error) kids.push(h('span', { class: 'bad', text: `上一次${o.error.kind === 'design' ? '做设计稿' : '誊清'}没有成功：${o.error.msg}` }));
    if (said) kids.push(h('span', { class: said.bad ? 'bad' : '', text: said.s }));
    if (tab === 'restore' && o.restore && o.restore.unsure.length) kids.push(h('details', { class: 'bo-unsure' }, h('summary', { text: `AI 有 ${o.restore.unsure.length} 处拿不准（点开看，对照原稿核一下）` }), h('ul', {}, ...o.restore.unsure.map((u) => h('li', { text: u })))));
    if (tab === 'design' && o.design && o.design.note) kids.push(h('span', { class: 'bo-idea', text: '设计思路：' + o.design.note }));
    if (tab === 'design' && o.design && o.restore && o.design.from !== o.restore.at) kids.push(h('span', { class: 'bad', text: '这份设计稿是按上一版还原稿做的' }));
    state.replaceChildren(...kids);
    state.hidden = !kids.length;
  }
  const empty = (text) => h('div', { class: 'notice', text });
  // the tab's content; drawn again only when what it shows has changed (a page in a frame would lose its scroll place)
  async function draw(force) {
    for (const b of tabs) b.classList.toggle('sel', b.dataset.tab === tab);
    const r = o.restore, d = o.design;
    const key = tab + ':' + (tab === 'design' ? (d ? d.at : 0) : r ? r.at : 0) + ':' + (o.job ? o.job.kind : '');
    saveB.textContent = tab === 'md' ? '下载 .md' : tab === 'shot' ? '下载图片' : '导出 HTML';
    saveB.title = tab === 'md' ? '' : tab === 'shot' ? '' : '存成一个独立的 HTML 文件：公式和样式都在里面，离线也能打开、能打印';
    saveB.disabled = tab === 'design' ? !d : !r;
    copyB.hidden = tab !== 'md' || !r;
    designBar.hidden = tab !== 'design';
    designB.textContent = d ? '重新设计' : '生成设计稿';
    designB.disabled = wish.disabled = !r || !!o.job;
    head();
    if (key === shown && !force) return;
    shown = key;
    const waiting = (kind, text) => (o.job && o.job.kind === kind ? empty(WORK[kind] + '，一般要一两分钟。可以先回去接着画，好了这里会自己出现。') : empty(text));
    let el;
    if (tab === 'shot') el = r ? h('div', { class: 'bo-shot' }, h('img', { src: `/api/board/shot?id=${id}&t=${r.at}`, alt: '交给 AI 的原稿' })) : waiting('restore', '还没有交给 AI 的原稿。');
    else if (tab === 'design') el = d ? frameOf(await designPage(d.html, { title })) : waiting('design', r ? '还没有设计稿。还原稿只管把内容誊清、对齐；想要有层次、有配色的排版，在下面写上要求（可不写），点「生成设计稿」。' : '先在画板上点「交给 AI」誊清这一页，才能做设计稿。');
    else if (!r) el = waiting('restore', '这块画板还没有交给 AI。在画板窗口点「交给 AI」。');
    else if (tab === 'restore') el = frameOf(await restorePage(r));
    else {
      const { renderMd } = await import('./md.js');
      el = h('div', { class: 'md' });
      await renderMd(el, r.markdown, { machine: '', path: '', urls: [], openPath: () => {} });
      el = h('div', { class: 'bo-md' }, el);
    }
    if (shown === key && !dead) body.replaceChildren(el);
  }
  async function refresh() {
    let d = null; try { const r = await fetch('/api/board/out?id=' + id); if (r.ok) d = await r.json(); } catch {}
    if (!d || dead) return;
    const was = o.job;
    o = d;
    if (was && !o.job && !o.error) tab = was.kind;                  // done: show what was made
    draw(false);
  }
  async function design() {
    if (designB.disabled) return;
    designB.disabled = true;
    const r = await post('design', { id, note: wish.value.trim() });
    if (!r.ok) note(r.msg || '没能开始', true);
    refresh();
  }
  async function save() {
    const r = o.restore, d = o.design, name = (r && r.title) || title;
    saveB.disabled = true;
    try {
      if (tab === 'md') download(name + '.md', r.markdown, 'text/markdown;charset=utf-8');
      else if (tab === 'shot') download(name + '-原稿.png', await (await fetch('/api/board/shot?id=' + id)).blob(), 'image/png');
      else if (tab === 'design') download(name + '-设计稿.html', await designPage(d.html, { standalone: true, title: name }), 'text/html;charset=utf-8');
      else download(name + '-还原稿.html', await restorePage(r, { standalone: true }), 'text/html;charset=utf-8');
    } catch (e) { note('导出失败：' + e.message, true); }
    saveB.disabled = false;
  }

  const off = net.on('boards', refresh);
  const tick = setInterval(() => { if (o.job) { head(); if (Math.round((Date.now() - o.job.since) / 1000) % 4 === 0) refresh(); } }, 1000);
  refresh();
  draw(true);
  return { root, show(t) { tab = t; refresh(); draw(true); }, destroy() { dead = true; off(); clearInterval(tick); clearTimeout(noteT); } };
}
