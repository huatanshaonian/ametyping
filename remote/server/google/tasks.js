// Google Tasks for the connected account:
//   - due(from, to, skip): the tasks of every list due between two dates, for the calendar window (kept a minute);
//     the list 重要计划 are mirrored to (skip) is left out -- those are shown as the important items themselves
//   - the calls tasks-sync.js mirrors 重要计划 with: lists, all tasks of a list, create / patch / delete
// A task's due is a date only (Google drops the time); tasks ticked off in Google's apps come back "hidden", so every
// read asks for hidden ones too.
'use strict';

const BASE = 'https://tasks.googleapis.com/tasks/v1';
const CACHE_MS = 60e3;

const day = (due) => String(due || '').slice(0, 10);
const dueOf = (date) => (date ? date + 'T00:00:00.000Z' : null);

function createTasks({ account }) {
  const cache = new Map();                            // "from|to" -> { at, items }
  const api = (p, opts) => account.api(BASE + p, opts);

  async function paged(p, q = {}) {
    const items = [];
    let page = '';
    for (let n = 0; n < 20; n++) {
      const r = await api(p + '?' + new URLSearchParams({ maxResults: '100', ...q, ...(page ? { pageToken: page } : {}) }));
      items.push(...((r && r.items) || []));
      page = r && r.nextPageToken; if (!page) break;
    }
    return items;
  }
  const lists = () => paged('/users/@me/lists');
  const all = (list) => paged(`/lists/${encodeURIComponent(list)}/tasks`, { showCompleted: 'true', showHidden: 'true' });
  const createList = (title) => api('/users/@me/lists', { method: 'POST', json: { title } });
  const getList = (list) => api(`/users/@me/lists/${encodeURIComponent(list)}`);
  const create = (list, t) => api(`/lists/${encodeURIComponent(list)}/tasks`, { method: 'POST', json: t });
  const patch = (list, id, t) => api(`/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', json: t });
  const remove = (list, id) => api(`/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // [{ id, title, due, done, list }] due between two dates (YYYY-MM-DD, end exclusive); force: ask Google again
  async function due(from, to, skip, force) {
    const key = from + '|' + to, c = cache.get(key);
    if (!force && c && Date.now() - c.at < CACHE_MS) return c.items.filter((t) => t.listId !== skip);
    const items = [];
    const ls = (await lists()).filter((l) => l.id !== skip);                // (the lists side by side: each read goes through the proxy)
    await Promise.all(ls.map(async (l) => {
      const ts = await paged(`/lists/${encodeURIComponent(l.id)}/tasks`, { showCompleted: 'true', showHidden: 'true', dueMin: dueOf(from), dueMax: dueOf(to) });
      for (const t of ts) if (t.due && t.title && !t.deleted && day(t.due) >= from && day(t.due) < to) {
        items.push({ id: t.id, title: t.title, due: day(t.due), done: t.status === 'completed', list: l.title || '', listId: l.id });
      }
    }));
    cache.set(key, { at: Date.now(), items });
    return items.filter((t) => t.listId !== skip);
  }

  return { due, lists, all, createList, getList, create, patch, remove, clear: () => cache.clear(), day, dueOf };
}

module.exports = { createTasks };
