// The left column of the 计划 app: two views over every list (重要 = starred, 计划内 = with a due date), then the lists
// themselves with how many open plans each has, and 新建分类. Right-click (long press) a list to rename, move or delete
// it; double-click renames. The first list (重要计划) holds every plan without one and cannot be deleted.
import { h } from '../util.js';
import { askText, confirmBox, alertBox } from '../dialog.js';
import * as ctxmenu from '../ctxmenu.js';
import * as todos from '../todos.js';

export const VIEWS = [
  { id: ':star', name: '重要', mark: '★', has: (t) => !!t.star },
  { id: ':due', name: '计划内', mark: '▦', has: (t) => !!t.due },
];

async function rename(l) {
  const name = await askText({ title: '重命名分类', label: '新的名字：', value: l.name, max: 40 });
  if (!name || name === l.name) return;
  const r = await todos.changeList('rename', { id: l.id, name });
  if (!r.ok) alertBox(r.msg || '没能重命名', { bad: true });
}
async function remove(l, items) {
  const n = items.filter((t) => todos.listOf(t) === l.id).length;
  if (!(await confirmBox(`删除分类「${l.name}」${n ? `和其中的 ${n} 个计划` : ''}？`, { title: '删除分类', ok: '删除', danger: true }))) return false;
  const r = await todos.changeList('delete', { id: l.id });
  if (!r.ok) alertBox(r.msg || '没能删除', { bad: true });
  return r.ok;
}
export async function addList() {
  const name = await askText({ title: '新建分类', label: '分类的名字（例如：论文、实验、生活）：', max: 40 });
  if (!name) return null;
  const r = await todos.changeList('add', { name });
  if (!r.ok) { alertBox(r.msg || '没能新建', { bad: true }); return null; }
  return r.list.id;
}

// pick(id) shows a view or list; current: its id
export function side({ items, current, pick }) {
  const open = items.filter((t) => !t.done);
  const row = (id, mark, name, n, cls = '') => h('li', { class: 'tda-l' + cls + (id === current ? ' on' : ''), dataset: { id }, title: name, onclick: () => pick(id) },
    h('span', { class: 'tda-lm', text: mark }), h('span', { class: 'tda-ln', text: name }), h('span', { class: 'tda-lc', text: n ? String(n) : '' }));
  const lists = todos.allLists();
  const listRows = lists.map((l, i) => {
    const li = row(l.id, '☰', l.name, open.filter((t) => todos.listOf(t) === l.id).length, i === 0 ? ' main' : '');
    li.addEventListener('dblclick', () => rename(l));
    ctxmenu.attach(li, () => [
      { label: '重命名…', onClick: () => rename(l) },
      { label: '上移', disabled: i <= 1, onClick: () => todos.changeList('move', { id: l.id, to: i - 1 }) },
      { label: '下移', disabled: i === 0 || i === lists.length - 1, onClick: () => todos.changeList('move', { id: l.id, to: i + 1 }) },
      '-',
      { label: '删除分类…', disabled: i === 0, onClick: async () => { if (await remove(l, items) && current === l.id) pick(todos.MAIN); } },
    ]);
    return li;
  });
  return h('div', { class: 'tda-side' },
    h('ul', { class: 'tda-ls' }, ...VIEWS.map((v) => row(v.id, v.mark, v.name, open.filter(v.has).length, ' view'))),
    h('div', { class: 'tda-sep' }),
    h('ul', { class: 'tda-ls tda-lists' }, ...listRows),
    h('button', { type: 'button', class: 'tda-new', text: '＋ 新建分类', onclick: async () => { const id = await addList(); if (id) pick(id); } }));
}
