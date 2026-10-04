// 重要计划: the list (js/todos.js) as a small panel always on the desktop, and as a window (start menu; on phones the
// desktop is covered by full-screen windows). Tick to finish, × to delete, click the text to edit it, add at the
// bottom with an optional due date. Items the morning report found done show why.
import { h, prefs } from '../util.js';
import * as wm from '../wm.js';
import { confirmBox } from '../dialog.js';
import * as todos from '../todos.js';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

function mount({ widget = false } = {}) {
  const listEl = h('ul', { class: 'td-list' });
  const doneEl = h('ul', { class: 'td-list td-done', hidden: true });
  const doneBtn = h('button', { class: 'td-more', type: 'button' });
  const text = h('input', { class: 'field td-in', placeholder: '加一条重要计划…', maxlength: 300 });
  const due = h('input', { class: 'field td-due', type: 'date', title: '截止日期（可不填）' });
  const form = h('form', { class: 'td-add', autocomplete: 'off' }, text, due);
  const count = h('span', { class: 'td-n' });
  const fold = h('button', { class: 'td-fold', type: 'button', title: '收起 / 展开' });
  const body = h('div', { class: 'td-body' }, listEl, doneBtn, doneEl, form);
  const root = h('div', { class: 'tdl' + (widget ? ' widget' : '') },
    widget ? h('div', { class: 'td-head' }, h('img', { src: '/icons/sched_task-16.png', alt: '' }), h('b', { text: '重要计划' }), count, fold) : null, body);
  let collapsed = widget && prefs.get('todo.collapsed', false);

  function item(t) {
    const cls = t.done ? '' : t.due && t.due < today() ? ' late' : t.due === today() ? ' soon' : '';
    const label = h('span', { class: 'td-t', text: t.text, title: t.done ? '' : '点击修改' });
    const li = h('li', { class: 'td-i' + cls + (t.done ? ' done' : '') },
      h('input', { type: 'checkbox', checked: t.done, title: t.done ? '标回未完成' : '完成', onchange: (e) => todos.update(t.id, { done: e.target.checked }) }),
      h('div', { class: 'td-c' }, label,
        h('small', { text: [t.project, t.due ? md(t.due) + ' 截止' : '', t.done && t.doneBy && t.doneBy.startsWith('report:') ? `日报 ${md(t.doneBy.slice(7))} 判定完成` : ''].filter(Boolean).join(' · ') }),
        t.done && t.evidence ? h('small', { class: 'td-ev', text: t.evidence }) : null),
      h('button', { class: 'td-x', type: 'button', title: '删除', text: '×', onclick: async () => { if (await confirmBox(`删除「${t.text}」？`, { title: '删除待办', ok: '删除', danger: true })) todos.remove(t.id); } }));
    if (!t.done) label.addEventListener('click', () => {
      const ed = h('input', { class: 'field td-ed', value: t.text, maxlength: 300 });
      const end = (keep) => { if (keep && ed.value.trim() && ed.value.trim() !== t.text) todos.update(t.id, { text: ed.value.trim() }); else render(todos.list()); };
      ed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) end(true); if (e.key === 'Escape') end(false); });
      ed.addEventListener('blur', () => end(true));
      label.replaceWith(ed); ed.focus(); ed.select();
    });
    return li;
  }

  function render(items) {
    const open = items.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created);
    const done = items.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt).slice(0, 20);
    listEl.replaceChildren(...(open.length ? open.map(item) : [h('li', { class: 'td-empty', text: widget ? '没有重要计划。日报里「没做完的」点 ☆ 可以加进来。' : '没有重要计划。' })]));
    doneEl.replaceChildren(...done.map(item));
    doneBtn.hidden = !done.length;
    doneBtn.textContent = (doneEl.hidden ? '▸' : '▾') + ` 已完成（${items.filter((t) => t.done).length}）`;
    count.textContent = open.length ? `（${open.length}）` : '';
    root.classList.toggle('collapsed', collapsed);
    fold.textContent = collapsed ? '＋' : '－';
  }
  doneBtn.addEventListener('click', () => { doneEl.hidden = !doneEl.hidden; render(todos.list()); });
  fold.addEventListener('click', () => { collapsed = !collapsed; prefs.set('todo.collapsed', collapsed); render(todos.list()); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    const r = await todos.add(text.value.trim(), { due: due.value || '' });
    if (r.ok) { text.value = ''; due.value = ''; }
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const off = todos.subscribe(render);
  return { root, destroy: off };
}

// the panel on the desktop (under the windows, above the wallpaper)
export function initWidget(desktop) {
  const w = mount({ widget: true });
  w.root.id = 'todowidget';
  desktop.append(w.root);
  todos.load();
}

let win = null;
export function open() {
  if (win) { wm.open({ id: 'todo' }); return; }
  win = mount();
  wm.open({ id: 'todo', title: '重要计划', icon: '/icons/sched_task-16.png', content: win.root, width: 420, height: 460,
    onClose: () => { win.destroy(); win = null; } });
  todos.load();
}
