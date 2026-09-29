// 重要计划 on the page: the list the server keeps (remote/server/todos.js), shared by the desktop widget, its window
// and the report view's ☆. Every change on any device comes back as a `todos` message and reloads the list.
import * as net from './net.js';

let items = [];
const listeners = new Set();
const changed = () => { for (const fn of listeners) { try { fn(items); } catch (e) { console.error(e); } } };

export async function load() {
  try { const r = await fetch('/api/todos'); if (r.ok) { items = (await r.json()).items || []; changed(); } } catch {}
  return items;
}
export const list = () => items;
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
// a report's loose end already starred?
export const starred = (date, text) => items.some((t) => t.from && t.from.date === date && t.text === text);
