// 计划的分类 (the lists of 重要计划, like Microsoft To Do's lists). The first one, "main", always exists and cannot be
// deleted: every plan without a list belongs to it -- which is every plan written before lists existed, and every one
// put in from elsewhere (a report's ☆, a mail alert, a note on a paper, Google Tasks). Order is the user's.
//   <dataDir>/todo-lists.json   [{ id, name }]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAIN = 'main';
const MAX = 50;

function createTodoLists({ dataDir, onChange = () => {} }) {
  const file = path.join(dataDir, 'todo-lists.json');
  let lists = []; try { lists = JSON.parse(fs.readFileSync(file, 'utf8')).filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string'); } catch {}
  if (!lists.some((l) => l.id === MAIN)) lists.unshift({ id: MAIN, name: '重要计划' });
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(lists), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); onChange(); };
  const name = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '');

  const all = () => lists;
  const has = (id) => lists.some((l) => l.id === id);

  // { op: add | rename | delete | move, id, name, to }; drop(id) removes the plans of a deleted list
  function change(d, drop) {
    const n = name(d.name);
    if (d.op === 'add') {
      if (!n) return { ok: false, msg: '分类名是空的' };
      if (lists.length >= MAX) return { ok: false, msg: `分类最多 ${MAX} 个` };
      if (lists.some((l) => l.name === n)) return { ok: false, msg: '已经有这个分类了' };
      const l = { id: crypto.randomBytes(5).toString('hex'), name: n };
      lists.push(l); save();
      return { ok: true, list: l };
    }
    const l = lists.find((x) => x.id === d.id);
    if (!l) return { ok: false, msg: '找不到这个分类' };
    if (d.op === 'rename') {
      if (!n) return { ok: false, msg: '分类名是空的' };
      if (lists.some((x) => x !== l && x.name === n)) return { ok: false, msg: '已经有这个分类了' };
      l.name = n; save();
      return { ok: true, list: l };
    }
    if (d.op === 'delete') {
      if (l.id === MAIN) return { ok: false, msg: '这个分类不能删除' };
      lists = lists.filter((x) => x !== l); save();
      return { ok: true, removed: drop(l.id) };
    }
    if (d.op === 'move') {
      const to = Math.max(1, Math.min(lists.length - 1, Math.round(+d.to)));      // (main stays first)
      if (l.id === MAIN || !Number.isFinite(to)) return { ok: false, msg: '不能移动' };
      lists = lists.filter((x) => x !== l); lists.splice(to, 0, l); save();
      return { ok: true };
    }
    return { ok: false, msg: '不认识的操作' };
  }
  return { all, has, change, MAIN };
}

module.exports = { createTodoLists, MAIN };
