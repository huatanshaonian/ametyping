// 记事本: notes kept on the NAS (remote/server/notes.js). The list on the left (newest first), the text on the right;
// saved about a second after you stop typing (and when the window closes). The first line is the title. When the note
// was changed on another device meanwhile, your text is kept as a separate 「冲突副本」. open(id) shows one note.
import { h } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';

let app = null;
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function open(id) {
  if (app) { wm.open({ id: 'notepad' }); if (typeof id === 'string') app.select(id); return; }
  app = mount(typeof id === 'string' ? id : null);
  wm.open({ id: 'notepad', title: '记事本', icon: '/icons/notepad-16.png', content: app.root, width: 760, height: 500,
    onClose: () => { app.destroy(); app = null; } });
}

function mount(first) {
  const listEl = h('div', { class: 'np-list' });
  const text = h('textarea', { class: 'np-text', spellcheck: false, placeholder: '第一行是标题。写完不用管，会自动保存。', disabled: true });
  const status = h('span', { class: 'np-st' });
  const back = h('button', { class: 'btn np-back', type: 'button', text: '‹ 列表', onclick: () => root.classList.remove('editing') });
  const newBtn = h('button', { class: 'btn', type: 'button', text: '新建' });
  const delBtn = h('button', { class: 'btn', type: 'button', text: '删除', disabled: true });
  const driveBtn = h('button', { class: 'btn', type: 'button', text: '转存到 Google 云端硬盘', disabled: true, title: '连上 Google 账户后可用' });
  const root = h('div', { class: 'notepad' }, h('div', { class: 'np-bar' }, back, newBtn, delBtn, driveBtn, status), h('div', { class: 'np-main' }, listEl, text));
  let items = [], cur = null, saveT = null, saving = false, dirty = false;      // cur: { id, updated } (id null = not saved yet)

  const say = (s, bad) => { status.textContent = s || ''; status.classList.toggle('bad', !!bad); };
  async function loadList() {
    try { items = (await (await fetch('/api/notes')).json()).items || []; } catch { return; }
    listEl.replaceChildren(...(items.length ? items.map((n) => h('div', { class: 'np-i' + (cur && cur.id === n.id ? ' sel' : ''), dataset: { id: n.id } },
      h('b', { text: n.title }), h('small', { text: when(n.updated) + (n.drive ? ' · 已转存' : '') }))) : [h('p', { class: 'np-empty', text: '还没有笔记。点「新建」。' })]));
    const e = cur && cur.id && items.find((n) => n.id === cur.id);
    if (e && e.updated > cur.updated && !dirty) select(cur.id, true);          // changed on another device: show it
  }
  async function select(id, quiet) {
    await flush();
    let n = null; try { const r = await fetch('/api/note?id=' + encodeURIComponent(id)); if (r.ok) n = await r.json(); } catch {}
    if (!n) return say('打不开这篇笔记', true);
    cur = { id: n.id, updated: n.updated }; dirty = false;
    text.disabled = false; text.value = n.text; delBtn.disabled = false; driveBtn.disabled = !window.__googleOk;
    root.classList.add('editing');
    for (const el of listEl.children) el.classList.toggle('sel', el.dataset.id === id);
    if (!quiet) { say(''); text.focus(); }
  }
  async function flush() {
    clearTimeout(saveT);
    if (!cur || !dirty || saving) return;
    saving = true; dirty = false;
    const body = { id: cur.id || undefined, text: text.value, base: cur.id ? cur.updated : undefined };
    let r = {}; try { r = await (await fetch('/api/notes/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch {}
    saving = false;
    if (!r.ok) { dirty = true; return say(r.msg || '保存失败，稍后会再试', true); }
    cur = { id: r.id, updated: r.updated };
    say(r.conflict ? '这篇在别处也改过：你的版本另存成了「冲突副本」' : '已保存 ' + when(r.updated).split(' ')[1], r.conflict);
    if (dirty) saveT = setTimeout(flush, 1000);                                   // typed on while it was saving
  }
  text.addEventListener('input', () => { dirty = true; say('…'); clearTimeout(saveT); saveT = setTimeout(flush, 1000); });
  text.addEventListener('blur', flush);
  listEl.addEventListener('click', (e) => { const it = e.target.closest('.np-i'); if (it) select(it.dataset.id); });
  newBtn.addEventListener('click', async () => {
    await flush();
    cur = { id: null, updated: 0 }; dirty = false;
    text.disabled = false; text.value = ''; delBtn.disabled = false; driveBtn.disabled = true;
    for (const el of listEl.children) el.classList.remove('sel');
    root.classList.add('editing'); say('新笔记'); text.focus();
  });
  delBtn.addEventListener('click', async () => {
    if (!cur) return;
    const title = (text.value.split('\n').find((l) => l.trim()) || '无标题').slice(0, 30);
    if (!confirm(`删除「${title}」？`)) return;
    clearTimeout(saveT); dirty = false;
    if (cur.id) await fetch('/api/notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cur.id }) });
    cur = null; text.value = ''; text.disabled = true; delBtn.disabled = driveBtn.disabled = true;
    root.classList.remove('editing'); say('已删除');
    loadList();
  });
  driveBtn.addEventListener('click', async () => {
    await flush();
    if (!cur || !cur.id) return;
    driveBtn.disabled = true; say('转存中…');
    let r = {}; try { r = await (await fetch('/api/google/drive-note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cur.id }) })).json(); } catch {}
    driveBtn.disabled = false;
    say(r.ok ? '已转存到 Google 云端硬盘' + (r.name ? `（${r.name}）` : '') : r.msg || '转存失败', !r.ok);
  });

  const off = net.on('notes', loadList);
  const ro = new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 520));
  ro.observe(root);
  loadList().then(() => { if (first) select(first); else if (items[0]) select(items[0].id, true); });
  return { root, select: (id) => select(id), destroy() { flush(); off(); ro.disconnect(); } };
}
