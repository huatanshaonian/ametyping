// AmeMesh 进度视图（仿 Antigravity swarm Overview）：
//   目标行 → 进度条片 → 「需要你处理」提示栏 → 按产出（M0/M1 …）分组的工作线 → 任务卡
// 已完成的工作线默认折叠；点击任务 / 负责人 → onFocusNode(nodeId)，点击黑板引用 → onFocusSeq(seq)。
// 用法：const ov = createTopoOverview({ onFocusNode, onFocusSeq }); parent.append(ov.root); ov.update(proj, entries);
import { h, ago } from '../util.js';
import { groupThreads, nodeStatus, nodeName, findNode, taskState, UNASSIGNED_KEY } from './topo-model.js';

const THREAD_LABEL = { done: '已完成', working: '进行中', blocked: '在等待', needs: '需要你' };
const TASK_LABEL = { done: '已完成', working: '进行中', waiting: '在等待', needs: '需要你', parked: '未开始' };
const TASK_STATUS_TEXT = { pending: '待开始', in_progress: '进行中', review: '待验收', done: '已完成', blocked: '受阻' };

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function attentionReasons(n) {
  if (!n || n.archived) return [];
  const r = [];
  if (n.liveState === 'error') r.push('出错');
  if (n.watchdogAlert) r.push('看门狗告警');
  if (n.reviewStatus === 'blocked') r.push('受阻');
  if (n.asking) r.push('在提问');
  if (n.reviewStatus === 'waiting_review') r.push('待你检视');
  return r;
}

export function createTopoOverview({ onFocusNode, onFocusSeq } = {}) {
  const expanded = new Map(); // threadKey → bool（用户手动展开/折叠的记忆）
  const root = h('div', { class: 'to-root' });
  let proj = null;
  let entries = [];
  let destroyed = false;

  const focusNode = (id) => { if (id && typeof onFocusNode === 'function') onFocusNode(id); };
  const focusSeq = (seq) => { if (seq && typeof onFocusSeq === 'function') onFocusSeq(Number(seq)); };
  const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };

  function dot(cls, title) {
    return h('i', { class: `to-dot ${cls || ''}`, title: title || '' });
  }

  function ownerChip(node, fallback) {
    if (!node) return h('span', { class: 'to-owner none', text: fallback ? `@${clip(fallback, 24)}（未找到）` : '无负责人' });
    const st = nodeStatus(node);
    return h('button', {
      class: 'to-owner', type: 'button', title: `${nodeName(node)} · ${st.label} — 点击在关系图中聚焦`,
      onclick: stop(() => focusNode(node.id)),
    }, dot(st.cls, st.label), h('span', { class: 'to-owner-name', text: clip(nodeName(node), 28) }));
  }

  function lastPostOf(nodeId) {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i] && entries[i].nodeId === nodeId) return entries[i];
    return null;
  }

  function renderGoal() {
    const nodes = proj.nodes || [];
    const master = nodes.find((n) => n.role === 'master' && !n.archived) || nodes.find((n) => n.role === 'master');
    const goal = (master && String(master.goal || '').trim()) || String(proj.desc || '').trim() || String(proj.name || '未命名项目');
    const st = master ? nodeStatus(master) : null;
    return h('div', { class: 'to-goal' },
      h('span', { class: 'to-goal-lbl', text: '目标' }),
      h('span', { class: 'to-goal-text', title: goal, text: clip(goal, 160) }),
      master ? h('button', { class: 'to-goal-master', type: 'button', title: `主控 ${nodeName(master)} · ${st.label}`, onclick: () => focusNode(master.id) },
        dot(st.cls, st.label), clip(master.label || nodeName(master), 18)) : null);
  }

  function renderChips() {
    const tasks = proj.tasks || [];
    const nodes = proj.nodes || [];
    const done = tasks.filter((t) => t.status === 'done').length;
    const live = nodes.filter((n) => !n.archived);
    const working = live.filter((n) => nodeStatus(n).cls === 'on').length;
    const waiting = live.filter((n) => ['warn', 'err'].includes(nodeStatus(n).cls)).length;
    const archived = nodes.length - live.length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    return h('div', { class: 'to-chips' },
      h('span', { class: 'to-chip prog', title: `任务完成 ${done}/${tasks.length}` },
        h('span', { class: 'to-bar' }, h('i', { style: `width:${pct}%` })),
        h('b', { text: `${done}/${tasks.length}` }), ' 任务完成'),
      h('span', { class: 'to-chip' }, dot('on'), `执行中 ${working}`),
      h('span', { class: `to-chip${waiting ? ' hot' : ''}` }, dot('warn'), `等待 ${waiting}`),
      h('span', { class: 'to-chip dim' }, `在线 ${live.length} · 归档 ${archived}`));
  }

  function renderAttention() {
    const items = (proj.nodes || []).map((n) => ({ n, why: attentionReasons(n) })).filter((x) => x.why.length);
    const blockedTasks = (proj.tasks || []).filter((t) => t.status === 'blocked' || t.status === 'review');
    if (!items.length && !blockedTasks.length) return null;
    const rows = items.map(({ n, why }) => {
      const st = nodeStatus(n);
      return h('button', { class: 'to-attn-item', type: 'button', title: '点击在关系图中聚焦', onclick: () => focusNode(n.id) },
        dot(st.cls, st.label),
        h('b', { text: clip(nodeName(n), 30) }),
        h('span', { class: 'to-attn-why', text: why.join(' · ') }),
        n.role === 'master' ? h('span', { class: 'to-tag', text: '主控' }) : null);
    });
    for (const t of blockedTasks) {
      const owner = findNode(proj, t.ownerNodeId);
      if (owner && items.some((x) => x.n === owner)) continue;
      rows.push(h('button', { class: 'to-attn-item', type: 'button', onclick: () => owner && focusNode(owner.id) },
        dot(t.status === 'blocked' ? 'err' : 'warn'),
        h('b', { text: clip(t.title, 40) }),
        h('span', { class: 'to-attn-why', text: TASK_STATUS_TEXT[t.status] || t.status })));
    }
    return h('div', { class: 'to-attn' },
      h('div', { class: 'to-attn-head' }, h('span', { class: 'to-attn-ico', text: '!' }), `需要你处理 (${rows.length})`),
      h('div', { class: 'to-attn-list' }, rows));
  }

  function taskCard(t) {
    const ts = taskState(proj, t);
    const waitTxt = ts.waitingOn.length
      ? '在等 ' + ts.waitingOn.map((w) => { const k = /^\s*([A-Za-z]+\d+\s*[-‐–]\s*\w+)/.exec(w.title || ''); return k ? k[1].replace(/\s+/g, '') : clip(w.title, 14); }).join('、')
      : '';
    const refs = (t.boardRefs || []).filter((x) => Number(x) > 0);
    const post = ts.state !== 'done' && ts.owner ? lastPostOf(ts.owner.id) : null;
    return h('div', {
      class: `to-card s-${ts.state}`, title: t.desc ? clip(t.desc, 300) : t.title,
      onclick: () => ts.owner && focusNode(ts.owner.id),
    },
      h('div', { class: 'to-card-top' },
        h('span', { class: `to-tstate s-${ts.state}`, text: TASK_LABEL[ts.state] }),
        h('span', { class: 'to-card-title', text: t.title || t.id })),
      h('div', { class: 'to-card-meta' },
        ownerChip(ts.owner, t.ownerNodeId),
        h('span', { class: 'to-tstatus', text: TASK_STATUS_TEXT[t.status] || t.status || '' }),
        waitTxt ? h('span', { class: 'to-wait', text: waitTxt }) : null,
        refs.length ? h('span', { class: 'to-refs' }, refs.slice(0, 6).map((seq) => {
          const e = entries.find((x) => Number(x.seq) === Number(seq));
          return h('button', { class: 'to-ref', type: 'button', title: e ? clip(e.text, 200) : `黑板 #${seq}`, onclick: stop(() => focusSeq(seq)), text: `#${seq}` });
        })) : null,
        t.updatedAt ? h('span', { class: 'to-ago', text: ago(t.updatedAt) }) : null),
      post ? h('button', { class: 'to-post', type: 'button', title: clip(post.text, 400), onclick: stop(() => focusSeq(post.seq)) },
        h('span', { class: 'to-post-seq', text: `#${post.seq}` }), clip(post.text, 90)) : null);
  }

  function looseNodeCard(n) {
    const st = nodeStatus(n);
    return h('div', { class: `to-card s-${st.cls === 'on' ? 'working' : (st.cls === 'warn' || st.cls === 'err') ? 'needs' : st.cls === 'done' || n.archived ? 'done' : 'parked'}`, onclick: () => focusNode(n.id) },
      h('div', { class: 'to-card-top' }, h('span', { class: 'to-card-title', text: clip(n.label || nodeName(n), 60) })),
      h('div', { class: 'to-card-meta' }, ownerChip(n), h('span', { class: 'to-tstatus', text: st.label }),
        n.goal ? h('span', { class: 'to-ago', title: n.goal, text: clip(n.goal, 40) }) : null));
  }

  function threadRow(g) {
    const isOpen = expanded.has(g.key) ? expanded.get(g.key) : g.state !== 'done';
    const isLoose = g.key === UNASSIGNED_KEY;
    const nDone = g.tasks.filter((t) => t.status === 'done').length;
    const count = isLoose ? `${g.nodeIds.length} 节点` : `${nDone}/${g.tasks.length}`;
    const owners = g.nodeIds.map((id) => findNode(proj, id)).filter(Boolean);
    const head = h('button', {
      class: 'to-th', type: 'button', 'aria-expanded': String(isOpen),
      onclick: () => { expanded.set(g.key, !isOpen); render(); },
    },
      h('span', { class: 'to-caret', text: isOpen ? '▾' : '▸' }),
      h('span', { class: `to-key${isLoose ? ' loose' : ''}`, text: isLoose ? '未挂' : g.key }),
      h('span', { class: 'to-th-title', title: g.title, text: g.title }),
      h('span', { class: 'to-th-dots' }, owners.slice(0, 6).map((n) => { const s = nodeStatus(n); return dot(s.cls, `${nodeName(n)} · ${s.label}`); })),
      h('span', { class: `to-badge s-${g.state}`, text: THREAD_LABEL[g.state] }),
      h('span', { class: 'to-count', text: count }));
    const body = isOpen
      ? h('div', { class: 'to-tasks' }, isLoose ? owners.map(looseNodeCard) : g.tasks.map(taskCard))
      : null;
    return h('div', { class: `to-thread s-${g.state}${isOpen ? ' open' : ''}`, dataset: { key: g.key } }, head, body);
  }

  function render() {
    if (destroyed) return;
    if (!proj) { root.replaceChildren(h('div', { class: 'to-empty', text: '未选择项目' })); return; }
    const threads = groupThreads(proj);
    const doneN = threads.filter((g) => g.state === 'done').length;
    root.replaceChildren(
      renderGoal(),
      renderChips(),
      renderAttention(),
      h('div', { class: 'to-threads-head' },
        h('b', { text: '工作线' }),
        h('span', { class: 'to-muted', text: threads.length ? `${threads.length} 条 · 已完成 ${doneN}` : '' }),
        threads.length > 1 ? h('span', { class: 'to-th-tools' },
          h('button', { class: 'to-link', type: 'button', text: '全部展开', onclick: () => { threads.forEach((g) => expanded.set(g.key, true)); render(); } }),
          h('button', { class: 'to-link', type: 'button', text: '只看未完成', onclick: () => { threads.forEach((g) => expanded.set(g.key, g.state !== 'done')); render(); } })) : null),
      threads.length
        ? h('div', { class: 'to-threads' }, threads.map(threadRow))
        : h('div', { class: 'to-empty', text: '还没有任务。主控用 mesh_task 建任务后，这里按 M0 / M1 … 分组显示。' }));
  }

  return {
    root,
    update(p, es) {
      proj = p || null;
      entries = Array.isArray(es) ? es : [];
      render();
    },
    destroy() {
      destroyed = true;
      expanded.clear();
      root.replaceChildren();
      root.remove();
    },
  };
}
