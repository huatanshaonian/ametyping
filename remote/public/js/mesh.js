// AmeMesh client store: collaborative projects, session topology nodes & edges, workspace grants, and file transfer handoffs.
// Subscribes to the server's `mesh` websocket broadcast and provides step-up TOTP retry for remote actions.
import * as net from './net.js';
import { askCode } from './gate.js';

let projects = [], loaded = false;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(projects); } catch (e) { console.error(e); }
  }
}

export async function load() {
  try {
    const r = await fetch('/api/mesh/projects');
    if (r.ok) {
      const d = await r.json();
      projects = Array.isArray(d.projects) ? d.projects : [];
      loaded = true;
      notify();
    }
  } catch {}
  return projects;
}

export const list = () => projects;
export const get = (id) => projects.find((p) => p.id === id) || null;
export const byGroup = (groupId) => projects.find((p) => p.groupId === groupId) || null;

// Find if a session key ("machine|sessionId") is part of any project topology
export function nodeOfKey(key) {
  for (const p of projects) {
    for (const n of p.nodes || []) {
      if (n.key === key) return { project: p, node: n };
    }
  }
  return null;
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(projects);
  if (!loaded) load();
  return () => listeners.delete(fn);
}

net.on('mesh', load);
net.on('sessions', load);
net.on('open', load);

async function post(path, body) {
  let r = await net.post('/api/mesh/' + path, body);
  if (!r.ok && r.need === 'totp') {
    if (!(await askCode())) return { ok: false, msg: '已取消' };
    r = await net.post('/api/mesh/' + path, body);
  }
  if (r.ok) await load();
  return r;
}

export const saveProject = (d) => post('project', d);
export const deleteProject = (id) => post('project', { op: 'delete', id });
export const upsertNode = (projectId, d) => post('node', { projectId, ...d });
export const removeNode = (projectId, nodeId) => post('node', { op: 'delete', projectId, nodeId });
export const addEdge = (projectId, from, to, type = 'cowork') => post('edge', { projectId, from, to, type });
export const removeEdge = (projectId, from, to) => post('edge', { op: 'delete', projectId, from, to });
export const spawnWorker = (d) => post('spawn', d);
export const sendMessage = (d) => post('send', d);
export const reportResult = (d) => post('report', d);
export const flushInbox = (projectId, nodeId) => post('flush', { projectId, nodeId });
export const requestTransfer = (d) => post('transfer', d);
export const confirmTransfer = (projectId, transferId, opts = {}) => post('transfer-confirm', { projectId, transferId, ...opts });
