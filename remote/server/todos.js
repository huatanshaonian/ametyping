// 重要计划 / 待办: the things worth keeping track of. They come from a daily report's loose ends you starred
// ("设为重要") or are typed in on the desktop widget; each morning's report checks the open ones against the day's
// conversations and ticks off what got done (summary/generate.js). Loose ends you did not star stay in their day's
// report only.
//   <dataDir>/todos.json   [{ id, text, project, due, created, from: { date } | null, lit: { key, page } | undefined, done, doneAt, doneBy, evidence }]
//                          + list?, star?, steps?: [{ id, text, done }]
// (lit: put in from a note on a paper in 文献 › 深读 -- the paper's Zotero key and the page, to open it there again)
// Plans are sorted into lists (todo-lists.js; no "list" = the first one, so plans from before lists and those put in
// from elsewhere need no change), may be starred (重要), and may have numbered steps (todo-steps.js).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createTodoLists, MAIN } = require('./todo-lists');
const steps = require('./todo-steps');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 500;

function createTodos({ dataDir, onChange = () => {}, audit = () => {} }) {
  const file = path.join(dataDir, 'todos.json');
  let items = []; try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const lists = createTodoLists({ dataDir, onChange });
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(items), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); onChange(); };
  const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

  const list = () => items;
  const open = () => items.filter((t) => !t.done);

  function add(d) {
    const text = str(d.text, 300);
    if (!text) return { ok: false, msg: '内容是空的' };
    const from = d.from && DAY.test(d.from.date) ? { date: d.from.date } : null;
    // the same loose end starred twice is one item
    if (from && items.some((t) => t.from && t.from.date === from.date && t.text === text)) return { ok: true, dup: true };
    if (items.length >= MAX) items = items.filter((t) => !t.done || Date.now() - (t.doneAt || 0) < 90 * 86400e3);
    const t = { id: crypto.randomBytes(6).toString('hex'), text, project: str(d.project, 60), due: DAY.test(d.due) ? d.due : '', created: Date.now(), from, done: false };
    if (typeof d.list === 'string' && d.list !== MAIN && lists.has(d.list)) t.list = d.list;
    if (d.star === true) t.star = true;
    const st = steps.initial(d.steps); if (st.length) t.steps = st;
    if (d.lit && /^[A-Z0-9]{8}$/.test(d.lit.key)) t.lit = { key: d.lit.key, page: Math.max(0, Math.min(100000, Math.round(+d.lit.page || 0))) };
    items.push(t); save();
    return { ok: true, item: t };
  }
  function update(d) {
    const t = items.find((x) => x.id === d.id);
    if (!t) return { ok: false, msg: '找不到这一条' };
    if (typeof d.text === 'string' && str(d.text, 300)) t.text = str(d.text, 300);
    if (typeof d.due === 'string') t.due = DAY.test(d.due) ? d.due : '';
    if (typeof d.list === 'string' && (d.list === MAIN || lists.has(d.list))) { if (d.list === MAIN) delete t.list; else t.list = d.list; }
    if (typeof d.star === 'boolean') { if (d.star) t.star = true; else delete t.star; }
    if (typeof d.done === 'boolean' && d.done !== t.done) Object.assign(t, d.done ? { done: true, doneAt: Date.now(), doneBy: 'user' } : { done: false, doneAt: 0, doneBy: '', evidence: '' });
    save();
    return { ok: true, item: t };
  }
  function remove(id) { const n = items.length; items = items.filter((t) => t.id !== id); if (items.length !== n) save(); return { ok: items.length !== n }; }
  // a step under a plan: { id, op, sid, text, done, to, at }
  function step(d) {
    const t = items.find((x) => x.id === d.id);
    if (!t) return { ok: false, msg: '找不到这个计划' };
    const r = steps.change(t, d);
    if (r.ok) save();
    return r;
  }
  // the lists; deleting one deletes its plans
  function changeList(d) {
    return lists.change(d, (id) => { const n = items.length; items = items.filter((t) => t.list !== id); if (items.length !== n) save(); return n - items.length; });
  }
  // the morning report found it done
  function complete(id, date, evidence) {
    const t = items.find((x) => x.id === id && !x.done);
    if (!t) return false;
    Object.assign(t, { done: true, doneAt: Date.now(), doneBy: 'report:' + date, evidence: str(evidence, 200) });
    save();
    return true;
  }

  // the web API (same-origin POSTs are checked by server.js); true when handled
  async function handle(req, res, p, ip, json, readBody) {
    if (req.method === 'GET' && p === '/api/todos') { json(res, 200, { items, lists: lists.all() }); return true; }
    const m = /^\/api\/todos\/(add|update|delete|step|list)$/.exec(p);
    if (req.method !== 'POST' || !m) return false;
    let d = {}; try { d = JSON.parse(await readBody(req)); } catch {}
    if (!d || typeof d !== 'object') d = {};
    const r = m[1] === 'add' ? add(d) : m[1] === 'update' ? update(d) : m[1] === 'step' ? step(d) : m[1] === 'list' ? changeList(d) : remove(String(d.id || ''));
    if (r.ok) audit('todo-' + p.split('/').pop(), ip);
    json(res, 200, r);
    return true;
  }
  return { list, open, add, update, remove, complete, step, lists: () => lists.all(), changeList, handle };
}

module.exports = { createTodos };
