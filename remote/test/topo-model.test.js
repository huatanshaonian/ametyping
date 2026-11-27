// topo-model.js 纯函数单测（前端 ES 模块，通过 data: URL 动态导入，避免依赖 package type 检测）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/apps/topo-model.js'), 'utf8');
const load = () => import('data:text/javascript;base64,' + Buffer.from(SRC).toString('base64'));

// 夹具：取自 AmeTyping-LitKB 真实数据的形状（ownerNodeId 多为 alias）
function fixture() {
  return {
    id: 'p1', name: 'AmeTyping-LitKB', desc: '',
    nodes: [
      { id: 'node_m', alias: 'Ametyping Embedding Integration Plan', label: '文献系统设计和优化', role: 'master', liveState: 'history', reviewStatus: 'waiting_review' },
      { id: 'node_a', alias: 'worker-embed', label: 'remote/server/embed', role: 'worker', archived: true, liveState: 'history', reviewStatus: 'done' },
      { id: 'node_b', alias: 'worker-lit', label: 'M0-2 文献 embed 混合检索', role: 'worker', archived: true, liveState: 'spawning', reviewStatus: 'done' },
      { id: 'node_v', alias: 'verifier-m0', label: 'M0 验收', role: 'verifier', archived: true, liveState: 'history', reviewStatus: 'done' },
      { id: 'node_c', alias: 'worker-m3', label: 'M3 核心', role: 'worker', liveState: 'working', reviewStatus: 'pending' },
      { id: 'node_d', alias: 'worker-m3-ui', label: 'M3 UI', role: 'worker', liveState: 'waiting', asking: true },
      { id: 'node_x', alias: 'worker-openwrt-proxy', label: 'worker-openwrt-proxy', role: 'worker', archived: true, liveState: 'spawning', reviewStatus: 'done' },
    ],
    edges: [],
    tasks: [
      { id: 't1', title: 'M0-1: 扩展 embed 子系统', ownerNodeId: 'worker-embed', status: 'done', blockedBy: [] },
      { id: 't2', title: 'M0-2: 将文献向量接入 feed', ownerNodeId: 'WORKER-LIT ', status: 'done', blockedBy: ['t1'] },
      { id: 't3', title: 'M0-3: 只读独立验收', ownerNodeId: 'verifier-m0', status: 'done', blockedBy: ['t2'] },
      { id: 't10', title: 'M10-1: 远期', ownerNodeId: 'node_c', status: 'pending', blockedBy: [] },
      { id: 't4', title: 'M3-1: 核心实现', ownerNodeId: 'worker-m3', status: 'in_progress', blockedBy: [] },
      { id: 't5', title: 'M3-2: UI', ownerNodeId: 'worker-m3-ui', status: 'in_progress', blockedBy: [] },
      { id: 't6', title: 'M3-3: 验收', ownerNodeId: 'nobody', status: 'pending', blockedBy: ['t4', 't5'] },
      { id: 't7', title: '杂项清理', ownerNodeId: '', status: 'pending', blockedBy: [] },
    ],
  };
}

test('threadKeyOfTask', async () => {
  const m = await load();
  assert.strictEqual(m.threadKeyOfTask({ title: 'M2-1: x' }), 'M2');
  assert.strictEqual(m.threadKeyOfTask({ title: '  m1 – y' }), 'M1');
  assert.strictEqual(m.threadKeyOfTask({ title: 'M1‐B: y' }), 'M1');
  assert.strictEqual(m.threadKeyOfTask({ title: 'M1: no dash' }), '其他');
  assert.strictEqual(m.threadKeyOfTask({ title: '杂项' }), '其他');
  assert.strictEqual(m.threadKeyOfTask({}), '其他');
});

test('findNode by id / alias / label, case-insensitive', async () => {
  const m = await load();
  const p = fixture();
  assert.strictEqual(m.findNode(p, 'node_a').alias, 'worker-embed');
  assert.strictEqual(m.findNode(p, ' Worker-Embed ').id, 'node_a');
  assert.strictEqual(m.findNode(p, '文献系统设计和优化').id, 'node_m');
  assert.strictEqual(m.findNode(p, 'nobody'), null);
  assert.strictEqual(m.findNode(p, ''), null);
  assert.strictEqual(m.findNode(null, 'x'), null);
  // 旧数据 alias/role 错位
  const p2 = { nodes: [{ id: 'n9', alias: 'huatanshaonian:D:\\ametyping-embed', role: 'worker-m3-clippy-auto', label: 'embed' }] };
  assert.strictEqual(m.findNode(p2, 'worker-m3-clippy-auto').id, 'n9');
  assert.strictEqual(m.nodeName(p2.nodes[0]), 'worker-m3-clippy-auto');
  assert.strictEqual(m.nodeName({ id: 'x', alias: 'worker-a', role: 'worker' }), 'worker-a');
  assert.strictEqual(m.nodeName({ id: 'x', label: 'L' }), 'L');
  assert.strictEqual(m.findNode({ nodes: [{ id: 'a', role: 'worker' }] }, 'worker'), null);
});

test('nodeStatus semantics, archived not live', async () => {
  const m = await load();
  const p = fixture();
  const s = (alias) => m.nodeStatus(m.findNode(p, alias)).cls;
  assert.strictEqual(s('Ametyping Embedding Integration Plan'), 'warn');
  assert.strictEqual(s('worker-m3'), 'on');
  assert.strictEqual(s('worker-m3-ui'), 'warn');
  assert.strictEqual(s('worker-lit'), 'done'); // archived + spawning → not live
  assert.strictEqual(m.nodeStatus({ archived: true, liveState: 'working' }).cls, '');
  assert.strictEqual(m.nodeStatus({ archived: true, asking: true }).cls, '');
  assert.strictEqual(m.nodeStatus({ liveState: 'error' }).cls, 'err');
  assert.strictEqual(m.nodeStatus({ watchdogAlert: { x: 1 } }).cls, 'err');
  assert.strictEqual(m.nodeStatus({ reviewStatus: 'blocked', archived: true }).cls, 'err');
  assert.strictEqual(m.nodeStatus({}).cls, '');
  assert.strictEqual(m.nodeStatus(null).cls, '');
});

test('groupThreads order, nodes and state', async () => {
  const m = await load();
  const p = fixture();
  const g = m.groupThreads(p);
  assert.deepStrictEqual(g.map((x) => x.key), ['M0', 'M3', 'M10', '其他', '未挂任务']);
  const by = Object.fromEntries(g.map((x) => [x.key, x]));
  assert.strictEqual(by.M0.state, 'done');
  assert.deepStrictEqual(by.M0.nodeIds, ['node_a', 'node_b', 'node_v']);
  assert.strictEqual(by.M0.title, '扩展 embed 子系统');
  assert.strictEqual(by.M3.state, 'needs'); // worker-m3-ui asking
  assert.deepStrictEqual(by.M3.nodeIds, ['node_c', 'node_d']);
  assert.strictEqual(by.M10.state, 'working'); // owner node_c is live
  assert.strictEqual(by['其他'].state, 'blocked'); // parked
  assert.deepStrictEqual(by['未挂任务'].nodeIds, ['node_x']);
  assert.strictEqual(by['未挂任务'].state, 'done');
  assert.ok(!g.some((x) => x.nodeIds.includes('node_m')));
});

test('taskState waiting on unfinished blockers', async () => {
  const m = await load();
  const p = fixture();
  const t6 = p.tasks.find((t) => t.id === 't6');
  const st = m.taskState(p, t6);
  assert.strictEqual(st.state, 'waiting');
  assert.deepStrictEqual(st.waitingOn.map((t) => t.id), ['t4', 't5']);
  assert.strictEqual(m.taskState(p, p.tasks[1]).state, 'done');
});

test('nodePhaseMap', async () => {
  const m = await load();
  const pm = m.nodePhaseMap(fixture());
  assert.strictEqual(pm.get('node_b'), 'M0');
  assert.strictEqual(pm.get('node_c'), 'M3'); // first thread in natural order
  assert.strictEqual(pm.get('node_x'), '未挂任务');
  assert.strictEqual(pm.has('node_m'), false);
});
