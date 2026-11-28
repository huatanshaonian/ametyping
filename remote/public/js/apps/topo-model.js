// AmeMesh 拓扑页的纯数据模型（无 DOM 依赖，可在 node 中单测）。
// 进度视图 (topo-overview.js) 与关系图 (projects.js createTopologyView) 共用：
//   threadKeyOfTask / groupThreads / nodePhaseMap / nodeStatus / findNode / taskState
// 「工作线」按产出（任务标题前缀 M0、M1 …）分组，而不是按 agent 分组。

const KEY_RE = /^\s*([A-Za-z]+\d+)\s*[-‐–]/;
export const OTHER_KEY = '其他';
export const UNASSIGNED_KEY = '未挂任务';
const LIVE_STATES = ['working', 'thinking', 'reading', 'message'];
const STD_ROLES = ['master', 'worker', 'verifier', 'peer'];

/** 'M2-1: xxx' → 'M2'；无前缀 → '其他' */
export function threadKeyOfTask(task) {
  const m = KEY_RE.exec(String((task && task.title) || ''));
  return m ? m[1].toUpperCase() : OTHER_KEY;
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** 按 id / alias / label 找节点（大小写不敏感、去首尾空白）；task.ownerNodeId 常为 alias */
export function findNode(proj, ref) {
  const r = norm(ref);
  if (!r) return null;
  const nodes = (proj && proj.nodes) || [];
  return nodes.find((n) => norm(n.id) === r)
    || nodes.find((n) => norm(n.alias) === r)
    || nodes.find((n) => norm(n.label) === r)
    // 修复前的旧数据：alias 被写进 role（role 非标准值）时，按 role 兜底匹配
    || nodes.find((n) => !STD_ROLES.includes(n.role) && norm(n.role) === r)
    || null;
}

/** 显示名：alias → label → id；旧数据 alias 形如 machine:path 且 role 非标准时，用 role 作名字 */
export function nodeName(node) {
  if (!node) return '';
  const alias = String(node.alias || '').trim();
  if (alias && /^[\w.-]+:(?:[A-Za-z]:)?[\\/]/.test(alias) && node.role && !STD_ROLES.includes(node.role)) return String(node.role);
  return alias || String(node.label || '').trim() || String(node.id || '');
}

/**
 * 节点状态（与 projects.js nodeStatusInfo / dotClassOf 同语义）。
 * 已归档节点不再算「在线」：忽略 liveState（spawning/history 等残留）、asking、watchdogAlert，只看 reviewStatus。
 */
export function nodeStatus(node) {
  if (!node) return { cls: '', label: '未知节点' };
  const archived = Boolean(node.archived);
  const live = archived ? '' : String(node.liveState || '');
  const rs = String(node.reviewStatus || '');
  if ((!archived && node.watchdogAlert) || rs === 'blocked' || live === 'error') return { cls: 'err', label: '告警/受阻' };
  if ((!archived && node.asking) || rs === 'waiting_review' || live === 'waiting') return { cls: 'warn', label: '等待确认/检视' };
  if (LIVE_STATES.includes(live)) return { cls: 'on', label: '执行中' };
  const closeWarn = archived && node.terminalCloseFailed ? '·终端未关' : '';
  if (rs === 'done' || rs === 'approved' || live === 'done') return { cls: 'done', label: archived ? `已完成·归档${closeWarn}` : '已完成' };
  return { cls: '', label: archived ? `已归档${closeWarn}` : '空闲/离线' };
}

/**
 * 单个任务的进度态：
 *   done 已完成 / needs 需要你（review、blocked 或负责人告警/待确认）/ working 进行中 /
 *   waiting 在等前置任务（waitingOn 列出未完成的 blockedBy 任务）/ parked 搁置未开始
 */
export function taskState(proj, task) {
  const tasks = (proj && proj.tasks) || [];
  const owner = findNode(proj, task && task.ownerNodeId);
  const os = nodeStatus(owner);
  const waitingOn = ((task && task.blockedBy) || [])
    .map((id) => tasks.find((t) => t.id === id) || { id, title: String(id), status: 'pending', missing: true })
    .filter((t) => t.status !== 'done');
  const st = String((task && task.status) || 'pending');
  let state;
  if (st === 'done') state = 'done';
  else if (st === 'review' || st === 'blocked' || (owner && !owner.archived && (os.cls === 'err' || os.cls === 'warn'))) state = 'needs';
  else if (waitingOn.length) state = 'waiting';
  else if (st === 'in_progress' || os.cls === 'on') state = 'working';
  else state = 'parked';
  return { state, owner, ownerStatus: os, waitingOn };
}

function keyCmp(a, b) {
  const rank = (k) => (k === UNASSIGNED_KEY ? 2 : k === OTHER_KEY ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const ma = /^([A-Z]+)(\d+)$/.exec(a), mb = /^([A-Z]+)(\d+)$/.exec(b);
  if (ma && mb) return ma[1] === mb[1] ? Number(ma[2]) - Number(mb[2]) : ma[1].localeCompare(mb[1]);
  return a.localeCompare(b);
}

const stripKey = (title) => String(title || '').replace(/^\s*[A-Za-z]+\d+(?:\s*[-‐–]\s*[\w]+)?\s*[:：]?\s*/, '').trim();

function threadTitle(key, tasks) {
  if (key === UNASSIGNED_KEY) return '未挂任务的节点';
  if (!tasks.length) return key;
  // 优先用非验收任务的标题概括产出
  const main = tasks.find((t) => !/验收|verif/i.test(t.title || '')) || tasks[0];
  return stripKey(main.title) || String(main.title || key);
}

/**
 * 工作线分组：[{ key, title, tasks, nodeIds, state }]
 * 顺序 M0, M1, M2 … → 其他 → 未挂任务（非主控且不负责任何任务的节点）。
 * state: done 全部完成 / needs 有需要你处理的 / working 有进行中 / blocked 剩余都在等或搁置
 */
export function groupThreads(proj) {
  const tasks = (proj && proj.tasks) || [];
  const nodes = (proj && proj.nodes) || [];
  const map = new Map();
  const owned = new Set();
  for (const t of tasks) {
    const key = threadKeyOfTask(t);
    if (!map.has(key)) map.set(key, { key, tasks: [], nodeIds: [] });
    const g = map.get(key);
    g.tasks.push(t);
    const n = findNode(proj, t.ownerNodeId);
    if (n) {
      owned.add(n.id);
      if (!g.nodeIds.includes(n.id)) g.nodeIds.push(n.id);
    }
  }
  const out = [...map.values()].sort((a, b) => keyCmp(a.key, b.key)).map((g) => {
    const states = g.tasks.map((t) => taskState(proj, t).state);
    let state;
    if (states.every((s) => s === 'done')) state = 'done';
    else if (states.includes('needs')) state = 'needs';
    else if (states.includes('working')) state = 'working';
    else state = 'blocked';
    return { key: g.key, title: threadTitle(g.key, g.tasks), tasks: g.tasks, nodeIds: g.nodeIds, state };
  });
  const loose = nodes.filter((n) => n.role !== 'master' && !owned.has(n.id));
  if (loose.length) {
    const cls = loose.map((n) => nodeStatus(n).cls);
    let state;
    if (cls.some((c) => c === 'err' || c === 'warn')) state = 'needs';
    else if (cls.includes('on')) state = 'working';
    else if (loose.every((n) => n.archived || nodeStatus(n).cls === 'done')) state = 'done';
    else state = 'blocked';
    out.push({ key: UNASSIGNED_KEY, title: threadTitle(UNASSIGNED_KEY, []), tasks: [], nodeIds: loose.map((n) => n.id), state });
  }
  return out;
}

/** Map(nodeId → threadKey)；一个节点负责多条线时取第一条（按自然序）；主控不入表 */
export function nodePhaseMap(proj) {
  const m = new Map();
  for (const g of groupThreads(proj)) for (const id of g.nodeIds) if (!m.has(id)) m.set(id, g.key);
  return m;
}
