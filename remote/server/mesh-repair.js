// AmeMesh topology repair: role/alias normalization shared by bind/spawn entry points, plus an idempotent
// load-time repair pass over persisted projects (mesh-projects.json). Never deletes nodes or edges.
'use strict';
const crypto = require('crypto');

const BUILTIN_ROLES = ['master', 'worker', 'verifier', 'peer'];
const EDGE_TYPES = ['master-worker', 'cowork', 'handoff'];

// Infer a builtin role from a free-form string by prefix (e.g. "worker-m3-clippy" -> worker); default worker
function inferRole(s) {
  const low = String(s || '').trim().toLowerCase();
  for (const r of ['master', 'verifier', 'peer', 'worker']) {
    if (low.startsWith(r)) return r;
  }
  return 'worker';
}

function knownRoleSet(extraRoles) {
  const set = new Set(BUILTIN_ROLES);
  for (const r of extraRoles || []) {
    const name = String((r && typeof r === 'object' ? r.name : r) || '').trim().toLowerCase();
    if (name) set.add(name);
  }
  return set;
}

// Auto-generated spawn alias looks like "machine:path" (e.g. "huatanshaonian:D:\\ametyping-embed")
function looksLikeAutoAlias(alias) {
  const s = String(alias || '').trim();
  return !s || /^[^\s:\\/]+:.+/.test(s);
}

// Normalize a (role, alias) pair coming from MCP/HTTP callers. An unknown role string is never stored as role:
// it becomes the alias (when the caller left alias empty / auto-generated) and role is inferred by prefix.
function normalizeRoleAlias({ role, alias, knownRoles, autoAlias = false } = {}) {
  const known = knownRoles instanceof Set ? knownRoles : knownRoleSet(knownRoles);
  const rawRole = String(role || '').trim();
  const rawAlias = String(alias || '').trim();
  if (!rawRole) return { role: '', alias: rawAlias, fixed: false };
  if (known.has(rawRole.toLowerCase())) return { role: rawRole, alias: rawAlias, fixed: false };
  const nextRole = inferRole(rawRole);
  const takeAlias = !rawAlias || autoAlias || looksLikeAutoAlias(rawAlias);
  return { role: nextRole, alias: takeAlias ? rawRole : rawAlias, fixed: true, droppedRole: rawRole };
}

function pushEvent(proj, evt) {
  proj.events = Array.isArray(proj.events) ? proj.events : [];
  proj.events.push({
    id: `evt_${crypto.randomBytes(5).toString('hex')}`,
    projectId: proj.id,
    ts: Date.now(),
    source: 'repair',
    kind: evt.kind,
    machine: evt.machine || '',
    nodeId: evt.nodeId || null,
    summary: evt.summary || '',
    payload: evt.payload || {},
  });
  if (proj.events.length > 200) proj.events = proj.events.slice(-200);
}

// Idempotent repair of a persisted project. Returns { changed, notes[] }.
function repairProject(proj, { knownRoles } = {}) {
  const notes = [];
  if (!proj || typeof proj !== 'object') return { changed: false, notes };
  const known = knownRoleSet(knownRoles);
  const nodes = Array.isArray(proj.nodes) ? proj.nodes : [];
  const edges = Array.isArray(proj.edges) ? proj.edges : [];

  // (a) role/alias swaps: role holds an alias-like string while alias holds the auto "machine:path" default
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const role = String(n.role || '').trim();
    if (!role || known.has(role.toLowerCase())) continue;
    if (!looksLikeAutoAlias(n.alias)) continue;
    const before = { role: n.role, alias: n.alias || '' };
    n.alias = role.slice(0, 60);
    n.role = inferRole(role);
    const note = `节点 ${n.id}：role「${before.role}」与 alias「${before.alias}」错位，已修正为 role=${n.role}, alias=${n.alias}`;
    notes.push(note);
    pushEvent(proj, {
      kind: 'REPAIR_ROLE_ALIAS',
      machine: n.machine || '',
      nodeId: n.id,
      summary: note,
      payload: { before, after: { role: n.role, alias: n.alias } },
    });
  }

  // (b) 'master-worker' edges whose source is not a master are hand-offs between peers/workers
  const byId = new Map(nodes.map((n) => [n && n.id, n]));
  for (const e of edges) {
    if (!e || e.type !== 'master-worker') continue;
    const from = byId.get(e.from);
    if (!from || from.role === 'master') continue;
    e.type = 'handoff';
    const note = `连线 ${e.from} → ${e.to}：起点角色为 ${from.role || '(空)'} 而非 master，类型 master-worker 改为 handoff`;
    notes.push(note);
    pushEvent(proj, {
      kind: 'REPAIR_EDGE_HANDOFF',
      machine: from.machine || '',
      nodeId: e.to,
      summary: note,
      payload: { from: e.from, to: e.to, before: 'master-worker', after: 'handoff' },
    });
  }

  return { changed: notes.length > 0, notes };
}

module.exports = {
  EDGE_TYPES,
  inferRole,
  normalizeRoleAlias,
  repairProject,
};
