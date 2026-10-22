// One plan in the 计划 app (todo-app.js): tick, ☆ (重要), its text (click to edit), a line of what else it has (list,
// due date, steps done, where it came from), and when opened its numbered steps -- each ticked, edited, moved up or
// down, deleted -- with a box to add the next, and the plan's due date, list and 删除.
//   ctx: { open: Set of opened plan ids, showList, rerender, editing(on), focusKey, setFocus(key) }
import { h } from '../util.js';
import { confirmBox } from '../dialog.js';
import * as todos from '../todos.js';

export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

// text that turns into an input on click; save(text) when changed
function editable(cls, text, save, ctx, { max = 300, title = '点击修改', fk } = {}) {
  const el = h('span', { class: cls, text, title });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const ed = h('input', { class: 'field tda-ed', value: text, maxlength: max });
    let over = false;
    const end = (keep) => {
      if (over) return; over = true; ctx.editing(false);
      const v = ed.value.trim();
      if (keep && v && v !== text) save(v); else ctx.rerender();
    };
    ed.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !k.isComposing) end(true); if (k.key === 'Escape') end(false); });
    ed.addEventListener('blur', () => end(true));
    ed.addEventListener('click', (k) => k.stopPropagation());
    ctx.editing(true);
    el.replaceWith(ed); ed.focus(); ed.select();
  });
  if (fk) el.dataset.fk = fk;
  return el;
}

function stepRow(t, s, i, n, ctx) {
  const move = (to) => todos.step(t.id, 'move', { sid: s.id, to });
  return h('li', { class: 'tda-s' + (s.done ? ' done' : '') },
    h('input', { type: 'checkbox', checked: s.done, title: s.done ? '标回未完成' : '完成这一条', onchange: (e) => todos.step(t.id, 'update', { sid: s.id, done: e.target.checked }) }),
    h('span', { class: 'tda-sn', text: `${i + 1}.` }),
    editable('tda-st', s.text, (v) => todos.step(t.id, 'update', { sid: s.id, text: v }), ctx, { max: 200 }),
    h('span', { class: 'tda-sb' },
      h('button', { type: 'button', class: 'tda-ib', text: '↑', title: '上移', disabled: i === 0, onclick: () => move(i - 1) }),
      h('button', { type: 'button', class: 'tda-ib', text: '↓', title: '下移', disabled: i === n - 1, onclick: () => move(i + 1) }),
      h('button', { type: 'button', class: 'tda-ib tda-x', text: '×', title: '删除这一条', onclick: () => todos.step(t.id, 'delete', { sid: s.id }) })));
}

// the opened part: steps, add a step, due date, list, delete
function details(t, ctx) {
  const steps = t.steps || [];
  const fk = 'step:' + t.id;
  const input = h('input', { class: 'field tda-sin', placeholder: `添加第 ${steps.length + 1} 条…`, maxlength: 200, dataset: { fk } });
  const add = h('form', { class: 'tda-sadd', autocomplete: 'off' }, h('span', { class: 'tda-sn', text: '＋' }), input);
  add.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    ctx.setFocus(fk);
    input.value = '';
    await todos.step(t.id, 'add', { text: v });
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add.requestSubmit(); } });
  const due = h('input', { class: 'field tda-due', type: 'date', value: t.due || '', title: '截止日期' });
  due.addEventListener('change', () => todos.update(t.id, { due: due.value || '' }));
  const lists = todos.allLists();
  const sel = h('select', { class: 'field tda-mv', title: '移到别的分类' }, ...lists.map((l) => h('option', { value: l.id, text: l.name, selected: l.id === todos.listOf(t) })));
  sel.addEventListener('change', () => todos.update(t.id, { list: sel.value }));
  return h('div', { class: 'tda-d' },
    h('ol', { class: 'tda-steps' }, ...steps.map((s, i) => stepRow(t, s, i, steps.length, ctx))),
    t.done ? null : add,
    h('div', { class: 'tda-dl' },
      h('label', { text: '截止 ' }, due),
      h('label', { text: '分类 ' }, sel),
      h('button', { type: 'button', class: 'btn tda-del', text: '删除计划', onclick: async () => {
        if (await confirmBox(`删除「${t.text}」${steps.length ? `和它的 ${steps.length} 条具体条目` : ''}？`, { title: '删除计划', ok: '删除', danger: true })) todos.remove(t.id);
      } })));
}

export function planRow(t, ctx) {
  const opened = ctx.open.has(t.id);
  const cls = t.done ? ' done' : t.due && t.due < today() ? ' late' : t.due === today() ? ' soon' : '';
  const prog = todos.progress(t);
  const meta = [
    ctx.showList ? todos.listName(todos.listOf(t)) : '',
    t.project,
    t.due ? md(t.due) + ' 截止' : '',
    t.done && t.doneBy && t.doneBy.startsWith('report:') ? `日报 ${md(t.doneBy.slice(7))} 判定完成` : '',
  ].filter(Boolean);
  const toggle = () => { if (opened) ctx.open.delete(t.id); else ctx.open.add(t.id); ctx.rerender(); };
  const head = h('div', { class: 'tda-ph' },
    h('button', { type: 'button', class: 'tda-ar', text: opened ? '▾' : '▸', title: opened ? '收起' : '展开具体条目', onclick: toggle }),
    h('input', { type: 'checkbox', checked: t.done, title: t.done ? '标回未完成' : '完成', onchange: (e) => todos.update(t.id, { done: e.target.checked }) }),
    h('div', { class: 'tda-pc' },
      t.done ? h('span', { class: 'tda-pt', text: t.text }) : editable('tda-pt', t.text, (v) => todos.update(t.id, { text: v }), ctx),
      meta.length || prog ? h('small', { class: 'tda-pm' }, prog ? h('b', { class: 'tda-prog', text: `☰ ${prog}`, title: '具体条目完成了几条' }) : null, meta.join(' · ')) : null,
      t.done && t.evidence ? h('small', { class: 'tda-ev', text: t.evidence }) : null,
      t.lit ? h('button', { class: 'td-lit', type: 'button', text: '打开文献' + (t.lit.page ? ` p.${t.lit.page}` : ''),
        onclick: () => import('./lit-reader.js').then((m) => m.openReader(t.lit.key, t.lit.page || undefined)) }) : null),
    h('button', { type: 'button', class: 'tda-star' + (t.star ? ' on' : ''), text: t.star ? '★' : '☆', title: t.star ? '取消重要' : '标为重要',
      onclick: () => todos.update(t.id, { star: !t.star }) }));
  // a click on the row's empty space opens / closes it
  head.addEventListener('click', (e) => { if (e.target === head || e.target.classList.contains('tda-pc') || e.target.classList.contains('tda-pm')) toggle(); });
  return h('li', { class: 'tda-p' + cls + (opened ? ' open' : ''), dataset: { id: t.id } }, head, opened ? details(t, ctx) : null);
}
