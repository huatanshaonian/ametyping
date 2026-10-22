// 计划: the important plans as an app of their own, after Microsoft To Do -- lists on the left (todo-side.js), the
// chosen list's plans on the right, each opening to its numbered steps (todo-plan.js); add a plan at the bottom.
// The same data as the desktop panel (todo.js) and everything else that puts plans in (js/todos.js).
import { h, prefs } from '../util.js';
import * as wm from '../wm.js';
import * as todos from '../todos.js';
import { side, VIEWS } from './todo-side.js';
import { planRow } from './todo-plan.js';

let app = null;

function mount() {
  let current = prefs.get('todo.view', todos.MAIN);
  let showDone = false, editing = 0, stale = false, focusKey = '';
  const open = new Set();
  const sideEl = h('div', { class: 'tda-sidebox' });
  const title = h('div', { class: 'tda-title' });
  const listEl = h('ul', { class: 'tda-plans' });
  const doneBtn = h('button', { class: 'td-more', type: 'button' });
  const doneEl = h('ul', { class: 'tda-plans tda-done' });
  const text = h('input', { class: 'field tda-in', placeholder: '添加计划…', maxlength: 300, dataset: { fk: 'add' } });
  const due = h('input', { class: 'field tda-due', type: 'date', title: '截止日期（可不填）' });
  const form = h('form', { class: 'tda-add', autocomplete: 'off' }, text, due, h('button', { class: 'btn', type: 'submit', text: '添加' }));
  const scroll = h('div', { class: 'tda-scroll' }, listEl, doneBtn, doneEl);
  const root = h('div', { class: 'tda' }, sideEl, h('div', { class: 'tda-main' }, title, scroll, form));

  const view = () => VIEWS.find((v) => v.id === current);
  const ctx = {
    open,
    get showList() { return !!view(); },
    rerender: () => render(),
    editing: (on) => { editing += on ? 1 : -1; if (!editing && stale) { stale = false; render(); } },
    setFocus: (k) => { focusKey = k; },
  };
  const pick = (id) => { current = id; prefs.set('todo.view', id); render(); };

  function render() {
    if (editing) { stale = true; return; }
    // a change from anywhere redraws everything: what is typed in the step boxes, and which one has the focus, stay
    const typed = new Map([...root.querySelectorAll('.tda-sin[data-fk]')].map((el) => [el.dataset.fk, el.value]));
    const act = document.activeElement && root.contains(document.activeElement) && document.activeElement.dataset.fk;
    if (!focusKey && act) focusKey = act;
    const items = todos.list();
    if (!VIEWS.some((v) => v.id === current) && !todos.allLists().some((l) => l.id === current)) current = todos.MAIN;
    const v = view();
    const mine = items.filter((t) => (v ? v.has(t) : todos.listOf(t) === current));
    const openP = mine.filter((t) => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created);
    const doneP = mine.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    sideEl.replaceChildren(side({ items, current, pick }));
    title.replaceChildren(h('b', { text: v ? v.name : todos.listName(current) }), h('span', { text: openP.length ? ` ${openP.length} 个未完成` : '' }));
    listEl.replaceChildren(...(openP.length ? openP.map((t) => planRow(t, ctx))
      : [h('li', { class: 'td-empty', text: v ? (v.id === ':star' ? '点计划右边的 ☆ 标为重要，就会出现在这里。' : '设了截止日期的计划会出现在这里。') : '这个分类还没有计划，在下面添加。' })]));
    doneBtn.hidden = !doneP.length;
    doneBtn.textContent = (showDone ? '▾' : '▸') + ` 已完成（${doneP.length}）`;
    doneEl.hidden = !showDone;
    doneEl.replaceChildren(...(showDone ? doneP.slice(0, 50).map((t) => planRow(t, ctx)) : []));
    for (const el of root.querySelectorAll('.tda-sin[data-fk]')) if (typed.get(el.dataset.fk)) el.value = typed.get(el.dataset.fk);
    // after adding a step or a plan, the box typed in again
    if (focusKey) { const el = root.querySelector(`[data-fk="${focusKey}"]`); focusKey = ''; if (el && document.activeElement !== el) el.focus(); }
  }
  doneBtn.addEventListener('click', () => { showDone = !showDone; render(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = text.value.trim();
    if (!v) return;
    const extra = { due: due.value || '' };
    if (current === ':star') extra.star = true;
    else if (!view()) extra.list = current;
    focusKey = 'add';
    const r = await todos.add(v, extra);
    if (r.ok) { text.value = ''; due.value = ''; if (r.item) { open.add(r.item.id); render(); } }
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const off = todos.subscribe(() => render());
  // a plan to show: its list, opened, scrolled to
  const show = (id) => {
    const t = todos.list().find((x) => x.id === id);
    if (!t) return;
    if (!(view() && view().has(t)) && todos.listOf(t) !== current) current = todos.listOf(t);
    open.add(id); if (t.done) showDone = true;
    render();
    const el = root.querySelector(`.tda-p[data-id="${id}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  };
  return { root, show, destroy: off };
}

// open the app; plan: the id of one plan to show opened
export function open({ plan } = {}) {
  if (!app) {
    app = mount();
    wm.open({ id: 'todo', title: '重要计划', icon: '/icons/sched_task-16.png', content: app.root, width: 760, height: 520,
      onClose: () => { app.destroy(); app = null; } });
    todos.load();
  } else wm.open({ id: 'todo' });
  if (plan) app.show(plan);
}
