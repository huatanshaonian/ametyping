// 重要计划 on the desktop: the open plans of every list (js/todos.js) as a small panel pinned to the top-right corner.
// Tick to finish, × to delete, click the text to edit it, add at the bottom (into the first list) with an optional
// due date. A plan with steps shows how many are done (2/4); that, or the panel's title, opens the 计划 app
// (todo-app.js: lists, steps), which is also what the start menu and the desktop icon open -- and on phones, where the
// panel is hidden. Items the morning report found done show why. One put in from a note on a paper (文献 › 深读 ›
// 笔记) opens that paper at its page again.
import { h, prefs } from '../util.js';
import { confirmBox } from '../dialog.js';
import * as todos from '../todos.js';
import { today, md } from './todo-plan.js';

const openApp = (plan) => import('./todo-app.js').then((m) => m.open({ plan }));
export const open = () => openApp();

function mount() {
  const listEl = h('ul', { class: 'td-list' });
  const doneEl = h('ul', { class: 'td-list td-done', hidden: true });
  const doneBtn = h('button', { class: 'td-more', type: 'button' });
  const text = h('input', { class: 'field td-in', placeholder: '加一条重要计划…', maxlength: 300 });
  const due = h('input', { class: 'field td-due', type: 'date', title: '截止日期（可不填）' });
  const form = h('form', { class: 'td-add', autocomplete: 'off' }, text, due);
  const count = h('span', { class: 'td-n' });
  const fold = h('button', { class: 'td-fold', type: 'button', title: '收起 / 展开' });
  const body = h('div', { class: 'td-body' }, listEl, doneBtn, doneEl, form);
  const name = h('b', { class: 'td-name', text: '重要计划', title: '打开「计划」：分类、具体条目', onclick: () => openApp() });
  const root = h('div', { class: 'tdl widget' },
    h('div', { class: 'td-head' }, h('img', { src: '/icons/sched_task-16.png', alt: '', onclick: () => openApp() }), name, count, fold), body);
  let collapsed = prefs.get('todo.collapsed', false);

  function item(t) {
    const cls = t.done ? '' : t.due && t.due < today() ? ' late' : t.due === today() ? ' soon' : '';
    const label = h('span', { class: 'td-t', text: t.text, title: t.done ? '' : '点击修改' });
    const prog = todos.progress(t);
    const list = todos.listOf(t) === todos.MAIN ? '' : todos.listName(todos.listOf(t));
    const li = h('li', { class: 'td-i' + cls + (t.done ? ' done' : '') },
      h('input', { type: 'checkbox', checked: t.done, title: t.done ? '标回未完成' : '完成', onchange: (e) => todos.update(t.id, { done: e.target.checked }) }),
      h('div', { class: 'td-c' }, label,
        h('small', {},
          prog ? h('button', { class: 'td-prog', type: 'button', text: `☰ ${prog}`, title: '具体条目完成了几条：点开看', onclick: () => openApp(t.id) }) : null,
          [list, t.project, t.due ? md(t.due) + ' 截止' : '', t.done && t.doneBy && t.doneBy.startsWith('report:') ? `日报 ${md(t.doneBy.slice(7))} 判定完成` : ''].filter(Boolean).join(' · ')),
        t.done && t.evidence ? h('small', { class: 'td-ev', text: t.evidence }) : null,
        t.lit ? h('button', { class: 'td-lit', type: 'button', text: '打开文献' + (t.lit.page ? ` p.${t.lit.page}` : ''), title: '在深读里打开这篇' + (t.lit.page ? `，翻到第 ${t.lit.page} 页` : ''),
          onclick: () => import('./lit-reader.js').then((m) => m.openReader(t.lit.key, t.lit.page || undefined)) }) : null),
      h('button', { class: 'td-x', type: 'button', title: '删除', text: '×', onclick: async () => {
        if (await confirmBox(`删除「${t.text}」${t.steps && t.steps.length ? `和它的 ${t.steps.length} 条具体条目` : ''}？`, { title: '删除待办', ok: '删除', danger: true })) todos.remove(t.id);
      } }));
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
    // (starred first, then by due date)
    const open = items.filter((t) => !t.done).sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created);
    const done = items.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt).slice(0, 20);
    listEl.replaceChildren(...(open.length ? open.map(item) : [h('li', { class: 'td-empty', text: '没有重要计划。日报里「没做完的」点 ☆ 可以加进来。' })]));
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
  todos.subscribe(render);
  return root;
}

// the panel on the desktop (under the windows, above the wallpaper)
export function initWidget(desktop) {
  const w = mount();
  w.id = 'todowidget';
  desktop.append(w);
  todos.load();
}
