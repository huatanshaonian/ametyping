// 重要计划 <-> a Google Tasks list of their own ("Windose 重要计划"), both ways:
//   - an open item is added to the list; text, due date and done / not done follow the item
//   - ticked off, edited or deleted in Google's apps: the same happens to the item in Windose
//   - a task added to that list in Google becomes a new item
// What each side looked like at the last sync is kept (<dataDir>/google-tasks.json), so a change is told from what
// stayed; when both sides changed the same thing, Windose wins. Runs a few seconds after a change in Windose, every
// 10 minutes for changes made in Google, and when the calendar window asks for the month again. Tasks in other lists
// are only shown in the calendar.
'use strict';
const fs = require('fs');
const path = require('path');

const LIST_TITLE = 'Windose 重要计划';
const EVERY_MS = 10 * 60e3;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

function createTasksSync({ dataDir, account, tasks, todos, log = () => {} }) {
  const file = path.join(dataDir, 'google-tasks.json');
  let st = { list: '', map: {} };                     // map: todo id -> { task, text, due, done } as last synced
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const on = () => { const s = account.status(); return s.connected && s.tasks && account.has('tasks'); };

  const wOf = (t) => ({ text: norm(t.text), due: t.due || '', done: !!t.done });
  const gOf = (t) => ({ text: norm(t.title), due: tasks.day(t.due), done: t.status === 'completed' });
  const same = (a, b) => a.text === b.text && a.due === b.due && a.done === b.done;
  const body = (m) => ({ title: m.text, due: tasks.dueOf(m.due), status: m.done ? 'completed' : 'needsAction', ...(m.done ? {} : { completed: null }) });
  const notes = (t) => [t.project ? '项目：' + t.project : '', t.from ? `来自 ${t.from.date} 的日报` : '', '与 Windose「重要计划」同步'].filter(Boolean).join('\n');

  // changes this sync makes to 重要计划 must not schedule another sync (todos' onChange -> kick)
  let applying = false;
  const apply = (fn) => { applying = true; try { return fn(); } finally { applying = false; } };

  async function sync() {
    let list = st.list, remote = null;
    if (list) try { remote = await tasks.all(list); } catch (e) { if (e.status !== 404) throw e; }
    if (!remote) {                                    // first time, or the list was deleted / another account
      const found = (await tasks.lists()).find((l) => l.title === LIST_TITLE);
      list = found ? found.id : (await tasks.createList(LIST_TITLE)).id;
      st = { ...st, list, map: {} }; save();
      remote = found ? await tasks.all(list) : [];
    }
    const byId = new Map(remote.filter((t) => !t.deleted).map((t) => [t.id, t]));
    const todoById = new Map(todos.list().map((t) => [t.id, t]));

    // 1. the linked pairs
    for (const [tid, snap] of Object.entries(st.map)) {
      const todo = todoById.get(tid), task = byId.get(snap.task);
      if (!todo) {                                    // deleted in Windose
        if (task) await tasks.remove(list, task.id).catch((e) => { if (e.status !== 404) throw e; });
        delete st.map[tid]; byId.delete(snap.task); save(); continue;
      }
      if (!task) { apply(() => todos.remove(tid)); delete st.map[tid]; save(); continue; }   // deleted in Google
      const g = gOf(task), w = wOf(todo), m = { text: snap.text, due: snap.due, done: snap.done };
      for (const k of ['text', 'due', 'done']) { if (g[k] !== snap[k]) m[k] = g[k]; if (w[k] !== snap[k]) m[k] = w[k]; }
      if (!m.text) m.text = w.text;                   // a title emptied in Google: keep the item's
      if (!same(m, w)) apply(() => todos.update({ id: tid, text: m.text, due: m.due, done: m.done }));
      if (!same(m, g)) await tasks.patch(list, task.id, body(m));
      st.map[tid] = { task: task.id, ...m };
      byId.delete(task.id);
    }

    // 2. tasks in the list not linked yet: added in Google -> a new item (an open item with the same text is that one)
    const linked = new Set(Object.keys(st.map));
    for (const task of byId.values()) {
      const g = gOf(task);
      if (!g.text) continue;
      let todo = todos.list().find((t) => !linked.has(t.id) && norm(t.text) === g.text);
      if (!todo) {
        if (g.done) continue;                         // something finished long ago: not worth a new item
        const r = apply(() => todos.add({ text: g.text, due: g.due }));
        todo = r && r.item; if (!todo) continue;
      }
      const w = wOf(todo), m = { text: w.text, due: w.due || g.due, done: w.done || g.done };
      if (!same(m, w)) apply(() => todos.update({ id: todo.id, due: m.due, done: m.done }));
      if (!same(m, g)) await tasks.patch(list, task.id, body(m));
      st.map[todo.id] = { task: task.id, ...m }; linked.add(todo.id); save();
    }

    // 3. open items not in Google yet
    for (const todo of todos.list()) {
      if (linked.has(todo.id) || todo.done) continue;
      const w = wOf(todo);
      const t = await tasks.create(list, { ...body(w), notes: notes(todo) });
      st.map[todo.id] = { task: t.id, ...w }; save();      // one at a time: a failure halfway does not add it twice
    }
  }

  let running = null, again = false, timer = null;
  async function run() {
    if (!on()) return;
    if (running) { again = true; return running; }
    running = (async () => {
      try { await sync(); st.last = Date.now(); delete st.error; }
      catch (e) { st.error = e.message; log('Google 任务同步失败：' + e.message); }
      save();
    })();
    try { await running; } finally { running = null; }
    if (again) { again = false; return run(); }
  }
  // a change in Windose: sync a few seconds later (several changes in a row are one sync)
  function kick(delay = 3000) {
    if (applying || !on()) return;
    clearTimeout(timer); timer = setTimeout(run, delay);
  }
  const every = setInterval(run, EVERY_MS); every.unref();
  const first = setTimeout(run, 30e3); first.unref();

  const status = () => ({ list: LIST_TITLE, last: st.last || 0, error: st.error || '' });
  return { run, kick, status, listId: () => st.list, stop() { clearInterval(every); clearTimeout(first); clearTimeout(timer); } };
}

module.exports = { createTasksSync, LIST_TITLE };
