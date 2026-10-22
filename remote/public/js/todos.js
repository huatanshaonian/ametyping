// 重要计划 on the page: the list the server keeps (remote/server/todos.js), shared by the desktop widget, its window
// and the report view's ☆. Every change on any device comes back as a `todos` message and reloads the list.
import * as net from './net.js';

// Plans are sorted into lists (分类; "main" holds every plan without one), may be starred, and may have numbered steps.
let items = [], lists = [{ id: 'main', name: '重要计划' }];
const listeners = new Set();
const changed = () => { for (const fn of listeners) { try { fn(items); } catch (e) { console.error(e); } } };

export async function load() {
  try {
    const r = await fetch('/api/todos');
    if (r.ok) { const d = await r.json(); items = d.items || []; if (Array.isArray(d.lists) && d.lists.length) lists = d.lists; changed(); }
  } catch {}
  return items;
}
export const list = () => items;
export const allLists = () => lists;
export const MAIN = 'main';
export const listOf = (t) => (t.list && lists.some((l) => l.id === t.list) ? t.list : MAIN);
export const listName = (id) => (lists.find((l) => l.id === id) || lists[0]).name;
// "2/4": steps done of all, or ''
export const progress = (t) => (t.steps && t.steps.length ? `${t.steps.filter((s) => s.done).length}/${t.steps.length}` : '');
export function subscribe(fn) { listeners.add(fn); fn(items); return () => listeners.delete(fn); }
net.on('todos', load);
net.on('open', load);                                 // (re)connected: catch up

async function post(what, body) {
  try {
    const r = await fetch('/api/todos/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    await load();
    return d;
  } catch { return { ok: false, msg: '请求失败' }; }
}
export const add = (text, extra = {}) => post('add', { text, ...extra });
export const update = (id, patch) => post('update', { id, ...patch });
export const remove = (id) => post('delete', { id });
// steps: op add { text, at } | update { sid, text?, done? } | delete { sid } | move { sid, to }
export const step = (id, op, more = {}) => post('step', { id, op, ...more });
// lists: op add { name } | rename { id, name } | delete { id } | move { id, to }
export const changeList = (op, more = {}) => post('list', { op, ...more });
// a report's loose end already starred?
export const starred = (date, text) => items.some((t) => t.from && t.from.date === date && t.text === text);
