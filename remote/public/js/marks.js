// 糖糖看板's marks on sessions (hidden / pinned / starred) and its groups, as the server keeps them
// (remote/server/session-marks.js). A change on any device comes back as a `marks` message and reloads them.
import * as net from './net.js';

let data = { sessions: {}, groups: [] }, loaded = false;
const listeners = new Set();
const changed = () => { for (const fn of listeners) { try { fn(data); } catch (e) { console.error(e); } } };

export async function load() {
  try { const r = await fetch('/api/marks'); if (r.ok) { data = await r.json(); loaded = true; changed(); } } catch {}
  return data;
}
export const of = (key) => data.sessions[key] || {};
export const groups = () => data.groups;
export function subscribe(fn) { listeners.add(fn); fn(data); if (!loaded) load(); return () => listeners.delete(fn); }
net.on('marks', load);
net.on('open', load);                                 // (re)connected: catch up

async function post(what, body) {
  const r = await net.post('/api/marks/' + what, body);
  if (r.ok) await load();
  return r;
}
// set({ hidden | pinned | starred: bool, group: id or '' }) on one "machine|id"
export const set = (key, patch) => post('set', { key, ...patch });
export const addGroup = (name) => post('group', { op: 'add', name });
export const renameGroup = (id, name) => post('group', { op: 'rename', id, name });
export const removeGroup = (id) => post('group', { op: 'delete', id });
