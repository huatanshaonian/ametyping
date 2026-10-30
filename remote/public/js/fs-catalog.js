// NAS VFS catalog client: folder annotations (role tag, userNote, aiNote) and cached shallow directory trees.
// Kept in sync across browsers via the `fs-catalog` websocket broadcast.
import * as net from './net.js';

let items = [], tags = {}, byKey = new Map(), loaded = false;
const listeners = new Set();

function normKey(machine, p) {
  const m = String(machine || '').trim();
  let s = String(p || '').trim().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) s += '\\';
  const k = /^[A-Za-z]:/.test(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
  return `${m}|${k}`;
}

function notify() {
  for (const fn of listeners) {
    try { fn({ items, tags }); } catch (e) { console.error(e); }
  }
}

export async function load() {
  try {
    const r = await fetch('/api/fs-catalog');
    if (r.ok) {
      const d = await r.json();
      items = Array.isArray(d.items) ? d.items : [];
      tags = d.tags || {};
      byKey = new Map(items.map((x) => [normKey(x.machine, x.path), x]));
      loaded = true;
      notify();
    }
  } catch {}
  return { items, tags };
}

export const get = (machine, path) => byKey.get(normKey(machine, path)) || null;
export const list = (machine = '') => (machine ? items.filter((x) => x.machine === machine) : items);
export const tagMap = () => tags;

export function subscribe(fn) {
  listeners.add(fn);
  fn({ items, tags });
  if (!loaded) load();
  return () => listeners.delete(fn);
}

net.on('fs-catalog', load);
net.on('open', load);

export async function setNote({ machine, path, tag, userNote, aiNote }) {
  const r = await net.post('/api/fs-catalog/note', { machine, path, tag, userNote, aiNote });
  if (r.ok) await load();
  return r;
}

export async function syncTree(machine, path, depth = 3) {
  const r = await net.post('/api/fs-catalog/sync', { machine, path, depth });
  if (r.ok) await load();
  return r;
}
