'use strict';
// AmeMesh topology data hygiene: @mention resolver (board `targets`), role/alias entry guard, load-time repair.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveTargets, createBoard } = require('../server/mesh-board');
const { repairProject, normalizeRoleAlias, inferRole } = require('../server/mesh-repair');
const { createMarks } = require('../server/session-marks');
const { createFsCatalog } = require('../server/fs-catalog');
const { createMesh } = require('../server/mesh');

// Minimal shapes copied from the AmeTyping-LitKB project (real data)
const NODES = [
  { id: 'node_af7e29818d', alias: 'Ametyping Embedding Integration Plan', role: 'master', label: '文献系统设计和优化' },
  { id: 'node_75c0f0d9d8', alias: 'worker-evidence-engine', role: 'worker', label: 'worker-evidence-engine' },
  { id: 'node_9fed1094da', alias: 'verifier-m1', role: 'verifier', label: 'AmeTyping-LitKB M1 kb-struct与evidence模块' },
  { id: 'node_3c1a0f9753', alias: 'worker-kb-store', role: 'worker', label: '' },
  { id: 'node_a3ff1a20e1', alias: 'huatanshaonian:D:\\ametyping-embed', role: 'worker-m3-clippy-auto', label: 'embed' },
];

function fixtureProject() {
  return {
    id: 'proj_c828ef1d6d',
    name: 'AmeTyping-LitKB',
    nodes: [
      { id: 'node_8cae812a18', alias: 'worker-embed', role: 'worker', machine: 'huatanshaonian' },
      { id: 'node_d7b2d8d627', alias: 'worker-lit', role: 'worker', machine: 'huatanshaonian' },
      { id: 'node_d2eaa4dfb9', alias: 'verifier-m0', role: 'verifier', machine: 'huatanshaonian' },
      { id: 'node_af7e29818d', alias: 'Ametyping Embedding Integration Plan', role: 'master', machine: 'huatanshaonian' },
      { id: 'node_a3ff1a20e1', alias: 'huatanshaonian:D:\\ametyping-embed', role: 'worker-m3-clippy-auto', machine: 'huatanshaonian' },
    ],
    edges: [
      { from: 'node_8cae812a18', to: 'node_d7b2d8d627', type: 'master-worker' },
      { from: 'node_d7b2d8d627', to: 'node_d2eaa4dfb9', type: 'master-worker' },
      { from: 'node_af7e29818d', to: 'node_a3ff1a20e1', type: 'master-worker' },
    ],
    events: [],
  };
}

describe('resolveTargets', () => {
  it('matches spaced alias by longest match and ignores trailing text', () => {
    const r = resolveTargets('@Ametyping Embedding Integration Plan [done] worker-evidence-engine 交卷', NODES);
    assert.deepEqual(r.targets, ['node_af7e29818d']);
    assert.equal(r.targetsAll, false);
  });

  it('is case-insensitive and requires a non-name char after the match', () => {
    assert.deepEqual(resolveTargets('请 @ametyping embedding integration plan，看一下', NODES).targets, ['node_af7e29818d']);
    // "Ametyping" alone is not a node name -> unknown token, no target
    assert.deepEqual(resolveTargets('@Ametyping 你好', NODES).targets, []);
    // prefix of a longer word must not match
    assert.deepEqual(resolveTargets('@verifier-m1x 你好', NODES).targets, []);
  });

  it('resolves role master, id, label, machine:path alias, fullwidth ＠, and multiple mentions', () => {
    assert.deepEqual(resolveTargets('@master（#31）', NODES).targets, ['node_af7e29818d']);
    assert.deepEqual(resolveTargets('ping @node_3c1a0f9753 now', NODES).targets, ['node_3c1a0f9753']);
    assert.deepEqual(resolveTargets('@embed 请处理', NODES).targets, ['node_a3ff1a20e1']);
    assert.deepEqual(resolveTargets('@huatanshaonian:D:\\ametyping-embed 派活契约已下发', NODES).targets, ['node_a3ff1a20e1']);
    assert.deepEqual(resolveTargets('＠verifier-m1 看看', NODES).targets, ['node_9fed1094da']);
    const multi = resolveTargets('@worker-kb-store 请立即处理 @verifier-m1 @master。', NODES);
    assert.deepEqual(multi.targets.sort(), ['node_3c1a0f9753', 'node_9fed1094da', 'node_af7e29818d'].sort());
  });

  it('handles @all, unknown tokens, code spans, channels, explicit mentions and self exclusion', () => {
    const all = resolveTargets('@all 全员注意', NODES);
    assert.equal(all.targetsAll, true);
    assert.deepEqual(all.targets, []);
    assert.deepEqual(resolveTargets('@nobody 在吗 @ 空格', NODES).targets, []);
    assert.deepEqual(resolveTargets('模板 `@verifier` 与 ```\n@master\n```', NODES).targets, []);
    assert.deepEqual(resolveTargets('@#ops 频道', NODES).targets, []);
    assert.deepEqual(resolveTargets('mail a@master.com', NODES).targets, []);
    const explicit = resolveTargets('@huatanshaonian 不该切断', NODES, { mentions: ['worker-kb-store'], skipText: true });
    assert.deepEqual(explicit.targets, ['node_3c1a0f9753']);
    const self = resolveTargets('@master @verifier-m1', NODES, { excludeId: 'node_af7e29818d' });
    assert.deepEqual(self.targets, ['node_9fed1094da']);
  });
});

describe('board targets', () => {
  it('persists targets at append and backfills legacy entries at read without rewriting JSONL', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-topo-board-'));
    const b = createBoard({ dataDir: tmp, getNodes: () => NODES });
    const e = b.append('p1', { agent: 'worker-evidence-engine', nodeId: 'node_75c0f0d9d8', text: '@Ametyping Embedding Integration Plan [done] 交卷' });
    assert.deepEqual(e.targets, ['node_af7e29818d']);
    assert.equal(e.targetsAll, false);
    assert.deepEqual(e.mentions, ['Ametyping'], 'legacy mentions field unchanged');

    // Legacy line without targets
    const fp = path.join(tmp, 'mesh-boards', 'p1.jsonl');
    const legacy = { seq: 2, ts: 1, channel: 'main', kind: 'post', agent: 'verifier-m1', nodeId: 'node_9fed1094da', text: '@Ametyping Embedding Integration Plan [done] @master（#31）', mentions: ['Ametyping', 'master'], mentionAll: false, mentionChannels: [], refs: [31] };
    const legacyBrief = { seq: 3, ts: 2, channel: 'main', kind: 'brief', agent: 'm', nodeId: 'node_af7e29818d', text: '@huatanshaonian:D:\\ametyping-embed 派活契约已下发\n请 @verifier-m1 验收', mentions: ['huatanshaonian:D:\\ametyping-embed'], mentionAll: false };
    fs.appendFileSync(fp, JSON.stringify(legacy) + '\n' + JSON.stringify(legacyBrief) + '\n');
    const before = fs.readFileSync(fp, 'utf8');

    const b2 = createBoard({ dataDir: tmp, getNodes: () => NODES });
    const { entries } = b2.read('p1', { since: 0 });
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[1].targets, ['node_af7e29818d']);
    assert.equal(entries[1].targetsAll, false);
    assert.deepEqual(entries[2].targets, ['node_a3ff1a20e1'], 'brief uses explicit mentions only');
    assert.equal(fs.readFileSync(fp, 'utf8'), before, 'JSONL must not be rewritten');
  });
});

describe('role/alias normalization and repair', () => {
  it('normalizeRoleAlias moves unknown role into alias and infers role', () => {
    assert.equal(inferRole('verifier-m2'), 'verifier');
    assert.equal(inferRole('xyz'), 'worker');
    assert.deepEqual(
      normalizeRoleAlias({ role: 'worker-m3-clippy-auto', alias: '' }),
      { role: 'worker', alias: 'worker-m3-clippy-auto', fixed: true, droppedRole: 'worker-m3-clippy-auto' },
    );
    assert.equal(normalizeRoleAlias({ role: 'worker-m3', alias: 'my-alias' }).alias, 'my-alias');
    assert.equal(normalizeRoleAlias({ role: 'reviewer', alias: 'r1', knownRoles: ['reviewer'] }).fixed, false);
    assert.equal(normalizeRoleAlias({ role: 'master', alias: 'x' }).fixed, false);
  });

  it('repairProject fixes swaps and non-master master-worker edges, records events, and is idempotent', () => {
    const proj = fixtureProject();
    const r1 = repairProject(proj);
    assert.equal(r1.changed, true);
    const n = proj.nodes.find((x) => x.id === 'node_a3ff1a20e1');
    assert.equal(n.role, 'worker');
    assert.equal(n.alias, 'worker-m3-clippy-auto');
    assert.deepEqual(proj.edges.map((e) => e.type), ['handoff', 'handoff', 'master-worker']);
    assert.equal(proj.nodes.length, 5, 'no node deleted');
    assert.equal(proj.edges.length, 3, 'no edge deleted');
    assert.equal(proj.events.length, 3);
    assert.deepEqual(proj.events.map((e) => e.kind).sort(), ['REPAIR_EDGE_HANDOFF', 'REPAIR_EDGE_HANDOFF', 'REPAIR_ROLE_ALIAS']);
    assert.equal(proj.events[0].source, 'repair');
    assert.equal(r1.notes.length, 3);

    const snapshot = JSON.stringify(proj);
    const r2 = repairProject(proj);
    assert.equal(r2.changed, false);
    assert.equal(JSON.stringify(proj), snapshot);
  });

  it('keeps custom roleCatalog roles and normal aliases untouched', () => {
    const proj = { id: 'p', nodes: [{ id: 'a', alias: 'rv-1', role: 'reviewer' }, { id: 'b', alias: 'huatanshaonian:D:\\x', role: 'reviewer' }], edges: [] };
    assert.equal(repairProject(proj, { knownRoles: ['reviewer'] }).changed, false);
    assert.equal(repairProject(proj).changed, true, 'unknown role with auto alias is repaired');
    assert.equal(proj.nodes[0].role, 'reviewer', 'normal alias is never swapped');
  });
});

function makeMesh(tmp, dispatched) {
  const machines = new Map();
  machines.set('pc-a', {
    name: 'pc-a', online: true, control: true, files: true,
    sessions: new Map([['agy:master-1', { id: 'agy:master-1', label: 'Master', state: 'idle', lines: [], perms: [] }]]),
  });
  return createMesh({
    dataDir: tmp,
    machines,
    store: { sessions: () => ({}), info: () => null },
    marks: createMarks({ dataDir: tmp }),
    fsCatalog: createFsCatalog({ dataDir: tmp, machines }),
    dispatchControl: async (machineName, payload) => {
      dispatched.push({ machine: machineName, payload });
      return { ok: true, msg: 'ok' };
    },
  });
}

describe('mesh integration', () => {
  it('load-time repair persists only when changed and records events', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-topo-load-'));
    const file = path.join(tmp, 'mesh-projects.json');
    fs.writeFileSync(file, JSON.stringify({ projects: [{ ...fixtureProject(), workspaces: [], tasks: [] }] }));
    makeMesh(tmp, []);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).projects[0];
    assert.equal(saved.nodes.find((x) => x.id === 'node_a3ff1a20e1').role, 'worker');
    assert.equal(saved.edges[0].type, 'handoff');
    assert.equal(saved.events.filter((e) => e.source === 'repair').length, 3);
    const mtime = fs.statSync(file).mtimeMs;
    const text = fs.readFileSync(file, 'utf8');
    makeMesh(tmp, []);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'second load is a no-op');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
  });

  it('spawnWorker stores an alias-like role as alias; worker-spawned edges are handoff; wake uses spaced alias', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-topo-spawn-'));
    const dispatched = [];
    const mesh = makeMesh(tmp, dispatched);
    const projId = mesh.saveProject({ name: 'Topo 测试', workspaces: [{ machine: 'pc-a', path: 'D:\\ametyping-embed', mode: 'rw' }] }).project.id;
    const master = mesh.upsertNode(projId, { machine: 'pc-a', sessionId: 'agy:master-1', alias: 'Ametyping Embedding Integration Plan', role: 'master', tool: 'agy' }).node;

    const sp = await mesh.spawnWorker({
      projectId: projId, fromNodeId: master.id, machine: 'pc-a', cwd: 'D:\\ametyping-embed', tool: 'claude', role: 'worker-m3-clippy-auto', goal: 'g',
    });
    assert.equal(sp.ok, true, sp.msg);
    assert.equal(sp.node.role, 'worker');
    assert.equal(sp.node.alias, 'worker-m3-clippy-auto');
    assert.match(dispatched[0].payload.prompt, /role="worker"/);

    const sp2 = await mesh.spawnWorker({ projectId: projId, fromNodeId: master.id, machine: 'pc-a', cwd: 'D:\\ametyping-embed', tool: 'claude', goal: 'g2' });
    assert.equal(sp2.ok, true, sp2.msg);
    assert.equal(sp2.node.alias, 'pc-a:ametyping-embed', 'default alias uses the Windows basename');

    // Worker binding a relay node with fromNodeId -> handoff edge
    const relay = mesh.upsertNode(projId, { machine: 'pc-a', sessionId: 'claude:relay', alias: 'relay', role: 'verifier', fromNodeId: sp.node.id });
    const edge = relay.project.edges.find((e) => e.to === relay.node.id);
    assert.equal(edge.type, 'handoff');
    assert.equal(mesh.addEdge(projId, { from: sp.node.id, to: sp2.node.id, type: 'handoff' }).project.edges.find((e) => e.from === sp.node.id && e.to === sp2.node.id).type, 'handoff');

    const post = await mesh.postBoard({ projectId: projId, fromNodeId: sp.node.id, text: '@Ametyping Embedding Integration Plan [done] 交卷', skipWake: true });
    assert.equal(post.ok, true);
    assert.deepEqual(post.entry.targets, [master.id]);
    const rb = mesh.readBoard({ projectId: projId, since: 0 });
    assert.ok(rb.entries.every((e) => Array.isArray(e.targets) && typeof e.targetsAll === 'boolean'));
  });
});
