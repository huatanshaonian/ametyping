// 画板: boards you write and draw on by hand (a pen with pressure, a mouse, fingers), kept on the NAS
// (remote/server/board). The toolbar: which board, the tools (铅笔 / 荧光笔 / 橡皮 / 移动 / 框选), colour and width,
// undo, the view; 「交给 AI」 sends the board -- or the part framed with 框选 -- as a picture to be 誊清 (board-out.js
// shows what comes back). Saved about a second after the last stroke and when the window closes; a board changed on
// another device meanwhile is kept as a separate 「冲突副本」.
import { h, icon, prefs } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import { askText, confirmBox } from '../dialog.js';
import { createSurface } from './board-surface.js';
import { TOOLS } from './board-ink.js';
import { download } from './board-page.js';
import * as out from './board-out.js';

const COLORS = ['#222222', '#d93025', '#1a73e8', '#188038', '#f29900', '#8e24aa', '#ffd400'];
const TOOL_LIST = [['pencil', '铅笔', '压感决定深浅'], ['marker', '荧光笔', '盖在字上，字还看得见'], ['eraser', '橡皮', '碰到的一整笔擦掉'],
  ['hand', '移动', '拖动画布（也可以用两根手指、鼠标中键 / 右键、滚轮）'], ['frame', '框选', '框出要交给 AI 的部分（不框就是整块画板）']];
const RANGE = { pencil: [1, 8, 0.2], marker: [8, 40, 1] };
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const post = async (what, body) => { try { return await (await fetch('/api/boards/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return { ok: false, msg: '连不上服务器' }; } };

let app = null;
export function open() {
  if (app) { wm.open({ id: 'board' }); return; }
  app = mount();
  wm.open({ id: 'board', title: '画板', icon: icon('paint', true), content: app.root, width: 1000, height: 660, onClose: () => { app.destroy(); app = null; } });
}

function mount() {
  const ink = { pencil: { c: COLORS[0], w: TOOLS.pencil.w }, marker: { c: COLORS[6], w: TOOLS.marker.w }, ...prefs.get('board.ink', {}) };
  let items = [], cur = { id: null, updated: 0, title: '' }, dirty = false, saving = null, saveT = null, hasAi = true;
  let penTool = 'pencil';                          // the drawing tool whose colour and width the toolbar shows
  const surface = createSurface({ onInk: () => { dirty = true; say('…'); clearTimeout(saveT); saveT = setTimeout(flush, 1200); buttons(); }, onUi: buttons });
  for (const t of ['pencil', 'marker']) surface.setWidth(t, ink[t].w);
  surface.setColor(ink.pencil.c);

  const pick = h('select', { class: 'bd-pick', title: '换一块画板' });
  const btn = (text, title, fn, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', text, title, onclick: fn });
  const tools = TOOL_LIST.map(([id, text, title]) => h('button', { class: 'btn bd-tool', type: 'button', text, title, dataset: { tool: id }, onclick: () => setTool(id) }));
  const swatches = COLORS.map((c) => h('button', { class: 'bd-sw', type: 'button', title: c, dataset: { c }, style: `background:${c}`, onclick: () => setColor(c) }));
  const width = h('input', { class: 'bd-width', type: 'range', title: '粗细' });
  const undoB = btn('撤销', 'Ctrl + Z', () => surface.undo()), redoB = btn('重做', 'Ctrl + Y', () => surface.redo());
  const clearB = btn('清空', '擦掉整块画板（可以撤销）', () => surface.clear());
  const zoomB = btn('100%', '点一下：把画的内容放回窗口中间', () => surface.fit(), 'bd-zoom');
  const fingerB = btn('手指画', '', () => { surface.setFinger(!surface.fingerDraws()); buttons(); });
  const pngB = btn('导出图片', '把画板（或框选的部分）存成 PNG', exportPng);
  const aiB = btn('交给 AI', '', toAi, 'go'), outB = btn('看结果', 'AI 誊清的页面、文字档和设计稿', () => { if (cur.id) out.show(cur.id, cur.title); });
  const status = h('span', { class: 'bd-st' });
  const root = h('div', { class: 'board' },
    h('div', { class: 'bd-bar' }, pick, btn('新建', '一块新的画板', newBoard), btn('改名', '', rename), btn('删除', '', remove), h('span', { class: 'bd-gap' }),
      aiB, outB, pngB, status),
    h('div', { class: 'bd-bar' }, ...tools, h('span', { class: 'bd-gap' }), ...swatches, width, h('span', { class: 'bd-gap' }),
      undoB, redoB, clearB, h('span', { class: 'bd-gap' }), btn('－', '缩小', () => surface.zoomBy(1 / 1.25)), zoomB, btn('＋', '放大', () => surface.zoomBy(1.25)), fingerB),
    surface.el);

  const say = (s, bad) => { status.textContent = s || ''; status.classList.toggle('bad', !!bad); };
  function buttons() {
    undoB.disabled = !surface.canUndo(); redoB.disabled = !surface.canRedo(); clearB.disabled = !surface.count();
    zoomB.textContent = Math.round(surface.scale() * 100) + '%';
    const f = surface.fingerDraws();
    fingerB.classList.toggle('sel', f);
    fingerB.title = f ? '现在一根手指也能画。点一下：手指只用来拖动画布（用笔写字时手掌不会误画）' : '现在手指只拖动画布、不会画（两根手指缩放）。点一下：一根手指也能画';
    aiB.disabled = !hasAi || !surface.count();
    aiB.title = !hasAi ? '服务器上没有开启工作日报，没有模型可以用' : surface.framed() ? '把框选的部分交给 AI 誊清' : '把整块画板交给 AI 誊清：认出文字和公式，整理成整齐的页面和文字档';
    aiB.textContent = surface.framed() ? '把框选的交给 AI' : '交给 AI';
    outB.disabled = !cur.id;
  }
  function setTool(t) {
    surface.setTool(t);
    if (TOOLS[t]) { penTool = t; surface.setColor(ink[t].c); }
    for (const b of tools) b.classList.toggle('sel', b.dataset.tool === t);
    for (const s of swatches) s.classList.toggle('sel', s.dataset.c === ink[penTool].c);
    const [min, max, step] = RANGE[penTool];
    Object.assign(width, { min, max, step, value: ink[penTool].w });
  }
  // a colour is for the drawing tool in hand (an eraser in hand: for the pencil, which is picked up)
  function setColor(c) {
    if (!TOOLS[surface.tool()]) setTool(penTool);
    ink[penTool].c = c; surface.setColor(c); prefs.set('board.ink', ink);
    for (const s of swatches) s.classList.toggle('sel', s.dataset.c === c);
  }
  width.addEventListener('input', () => { ink[penTool].w = +width.value; surface.setWidth(penTool, +width.value); prefs.set('board.ink', ink); });

  // ---------- boards ----------
  function fill() {
    const list = cur.id ? items : [{ id: '', title: cur.title + '（还没保存）' }, ...items];
    pick.replaceChildren(...list.map((b) => h('option', { value: b.id, text: b.title, selected: b.id === (cur.id || '') })));
  }
  async function loadList() {
    let d = null; try { d = await (await fetch('/api/boards')).json(); } catch { return; }
    items = d.items || []; hasAi = d.ai !== false;
    fill(); buttons();
    const e = cur.id && items.find((b) => b.id === cur.id);
    if (cur.id && !e && !dirty) return newBoard();                              // deleted on another device
    if (e && e.updated > cur.updated && !dirty && !saving) select(cur.id, true);   // drawn on from another device
  }
  async function select(id, quiet) {
    await flush();
    let b = null; try { const r = await fetch('/api/board?id=' + encodeURIComponent(id)); if (r.ok) b = await r.json(); } catch {}
    if (!b) return say('打不开这块画板', true);
    cur = { id: b.id, updated: b.updated, title: b.title }; dirty = false;
    surface.load(b.doc);
    fill(); buttons(); if (!quiet) say('');
  }
  async function newBoard() {
    await flush();
    cur = { id: null, updated: 0, title: '画板 ' + stamp() }; dirty = false;
    surface.load({ strokes: [] });
    fill(); buttons(); say('新画板：画上第一笔就会保存');
  }
  // one save at a time; strokes drawn while it is on its way go with the next
  function flush() {
    clearTimeout(saveT);
    if (saving) return saving.then(flush);
    if (!dirty) return Promise.resolve();
    dirty = false;
    saving = post('save', { id: cur.id || undefined, title: cur.title, doc: surface.doc(), base: cur.id ? cur.updated : undefined }).then((r) => {
      saving = null;
      if (!r.ok) { dirty = true; say(r.msg || '保存失败，稍后会再试', true); saveT = setTimeout(flush, 5000); return; }
      cur = { id: r.id, updated: r.updated, title: r.title };
      say(r.conflict ? '这块画板在别处也改过：你的版本另存成了「冲突副本」' : '已保存', r.conflict);
      buttons();
      if (dirty) saveT = setTimeout(flush, 1200);
    });
    return saving;
  }
  async function rename() {
    const v = await askText({ title: '画板改名', label: '名字', value: cur.title, max: 40 });
    if (!v || !v.trim() || v.trim() === cur.title) return;
    if (!cur.id) { cur.title = v.trim(); fill(); return; }
    const r = await post('rename', { id: cur.id, title: v.trim() });
    if (r.ok) { cur.title = r.title; loadList(); } else say(r.msg || '改名失败', true);
  }
  async function remove() {
    if (!(await confirmBox(`删除「${cur.title}」？AI 誊清的结果也会一起删掉。`, { title: '删除画板', ok: '删除', danger: true }))) return;
    clearTimeout(saveT); dirty = false;
    if (saving) await saving;
    const id = cur.id;
    if (id) { await post('delete', { id }); out.close(id); }
    cur = { id: null, updated: 0, title: '' };
    await loadList();
    if (items[0]) select(items[0].id); else newBoard();
  }
  pick.addEventListener('change', () => { if (pick.value) select(pick.value); });

  // ---------- out of the board ----------
  async function toAi() {
    const p = surface.picture(2000);
    if (!p) return say(surface.framed() ? '框选的地方没有笔迹' : '画板还是空的', true);
    aiB.disabled = true; say('正在把画板交给 AI…');
    await flush();
    if (!cur.id) { buttons(); return say('画板还没保存上，稍后再试', true); }
    const r = await post('read', { id: cur.id, png: p.canvas.toDataURL('image/png') });
    buttons();
    if (!r.ok) return say(r.msg || '没能交给 AI', true);
    say('AI 正在誊清，一般要一两分钟');
    out.show(cur.id, cur.title, 'restore');
  }
  function exportPng() {
    const p = surface.picture(4000);
    if (!p) return say('画板还是空的', true);
    p.canvas.toBlob((b) => { if (b) download((cur.title || '画板') + '.png', b, 'image/png'); }, 'image/png');
  }

  root.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) surface.undo(); else if (k === 'y' || (k === 'z' && e.shiftKey)) surface.redo(); else return;
    e.preventDefault();
  });
  const off = net.on('boards', loadList);
  setTool('pencil'); buttons();
  loadList().then(() => { if (items[0]) select(items[0].id, true); else newBoard(); });
  return { root, destroy() { flush(); off(); surface.destroy(); } };
}
