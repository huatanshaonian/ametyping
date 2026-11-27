// Topology Graph (pill graph + @mention replay) & Contracts tab for AmeMesh Projects (used by projects.js).
import { h, icon, ago, svgEl } from '../util.js';
import * as mesh from '../mesh.js';
import { nodePhaseMap, nodeStatus, findNode } from './topo-model.js';
import { createTopoOverview } from './topo-overview.js';
import { BOARD_KIND_LABELS, TOPO_EDGE_TYPE_NAMES, matchNodeByToken, extractMentionTokens } from './proj-const.js';

const TOPO_ROLES = ['master', 'verifier', 'peer', 'worker'];
const TOPO_ROLE_TAG = { master: '主控', verifier: '验收', peer: '协理', worker: '执行' };
const TOPO_NODE_H = 26;
const topoRoleOf = (n) => (TOPO_ROLES.includes(n.role) ? n.role : 'worker');
const topoRank = (n) => (n.group ? 3 : n.role === 'master' ? 0 : (n.role === 'verifier' || n.role === 'peer') ? 1 : 2);
const topoName = (n) => n.alias || n.label || n.id;

// 估算药丸宽度：圆点 + 名称 + 角色标签 + 内边距（12px 字体，CJK 约 12px、ASCII 约 7px）
function topoTextW(s, px = 12) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2e80 ? px : px * 0.6;
  return w;
}
const topoFinished = (n) => Boolean(n.archived) || nodeStatus(n).cls === 'done';

// 可见节点 ≤16：椭圆，主控在顶（执行节点之间的边是弦，不穿过邻居）；更多或椭圆放不下：分层分行、交错排列
function topoLayout(items, width) {
  const H = TOPO_NODE_H;
  const pos = new Map();
  const n = items.length;
  if (!n) return { pos, height: 60 };
  if (n === 1) {
    pos.set(items[0].id, { x: width / 2, y: 30, w: items[0].w, h: H });
    return { pos, height: 64 };
  }
  const overlaps = (p) => {
    const arr = [...p.values()];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 10 && Math.abs(a.y - b.y) < H + 10) return true;
      }
    }
    return false;
  };
  if (n <= 16) {
    const rest = items.filter((it) => it.rank !== 0);
    const maxW = Math.max(...rest.map((it) => it.w), 60);
    const avgW = rest.length ? rest.reduce((s, it) => s + it.w, 0) / rest.length : maxW;
    const rx = Math.max(60, width / 2 - maxW / 2 - 10);
    const needX = avgW + 14, needY = H + 14;
    const S = 1440;
    // 沿椭圆按「药丸尺寸归一化」的弧长等距摆放：上下沿横向排得开，左右沿纵向排得开
    for (let ry = n <= 2 ? 44 : Math.max(60, Math.min(170, n * 11)); ry <= 420; ry += 12) {
      const cy = ry + H / 2 + 12;
      const pts = [];
      const cum = [0];
      for (let s = 0; s <= S; s++) {
        const a = -Math.PI / 2 + (2 * Math.PI * s) / S;
        pts.push([width / 2 + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        if (s) cum.push(cum[s - 1] + Math.max(Math.abs(pts[s][0] - pts[s - 1][0]) / needX, Math.abs(pts[s][1] - pts[s - 1][1]) / needY));
      }
      const P = cum[S];
      if (P < n) continue;
      const p = new Map();
      let s = 0;
      items.forEach((it, i) => {
        const t = (i * P) / n;
        while (s < S && cum[s] < t) s++;
        p.set(it.id, { x: pts[s][0], y: pts[s][1], w: it.w, h: H });
      });
      if (!overlaps(p)) return { pos: p, height: cy + ry + H / 2 + 12 };
    }
  }
  const tiers = new Map();
  for (const it of items) {
    if (!tiers.has(it.rank)) tiers.set(it.rank, []);
    tiers.get(it.rank).push(it);
  }
  let y = 22;
  for (const [, list] of [...tiers.entries()].sort((a, b) => a[0] - b[0])) {
    const maxW = Math.max(...list.map((it) => it.w));
    const perLine = Math.max(1, Math.floor(width / (maxW + 14)));
    for (let i = 0; i < list.length; i += perLine) {
      const line = list.slice(i, i + perLine);
      const gap = width / (line.length + 1);
      const stagger = line.length > 3 ? 18 : 0;
      line.forEach((it, j) => pos.set(it.id, { x: gap * (j + 1), y: y + (j % 2 ? stagger : 0), w: Math.min(it.w, gap - 8), h: H }));
      y += H + 22 + stagger;
    }
    y += 12;
  }
  return { pos, height: y };
}

// 两节点间的二次曲线（稍弯，向图中心弯，避开椭圆上的邻居；端点截到药丸边框外），返回路径与中点
function topoEdgeGeom(a, b, bend = 16, center = null) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (center) {
    const mx0 = (a.x + b.x) / 2, my0 = (a.y + b.y) / 2;
    if ((center.x - mx0) * nx + (center.y - my0) * ny < 0) { nx = -nx; ny = -ny; }
  }
  const cx = (a.x + b.x) / 2 + nx * bend, cy = (a.y + b.y) / 2 + ny * bend;
  const trim = (p, q) => {
    const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
    const ux = tx / l, uy = ty / l;
    const toBorder = Math.min(ux ? p.w / 2 / Math.abs(ux) : Infinity, uy ? p.h / 2 / Math.abs(uy) : Infinity);
    const t = Math.min(0.45 * l, toBorder + 4);
    return { x: p.x + ux * t, y: p.y + uy * t };
  };
  const s = trim(a, { x: cx, y: cy }), e = trim(b, { x: cx, y: cy });
  return {
    d: `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${e.x.toFixed(1)} ${e.y.toFixed(1)}`,
    mx: 0.25 * s.x + 0.5 * cx + 0.25 * e.x,
    my: 0.25 * s.y + 0.5 * cy + 0.25 * e.y,
  };
}

export function createTopologyView(proj, { nodeCard, openSpawnDialog, openBindSessionDialog, openLinkDialog }) {
  let curProj = proj;
  let entries = [];
  let selectedSeq = 0; // 0 = show all flows; >0 = highlight that post's flow
  let selectedNodeId = ''; // optional node filter/highlight
  let channelFilter = 'all';
  let loadedBoardSeq = -1;
  let loading = false;
  let loadToken = 0;
  let destroyed = false;
  let showArchived = false;
  const expandedPhases = new Set(); // 已展开的已完成阶段（每个视图实例独立）
  let replayIdx = null; // null = 最新（全部帖子）；数字 = 回放到 entries[replayIdx]
  let replayTimer = 0;
  let archLaneOpen = false;
  let feedCollapsed = false;
  try { feedCollapsed = localStorage.getItem('pm.topo.feedCollapsed') === '1'; } catch {}
  let resolvedCache = null; // [{ seq, from, targets: [nodeId], all }]
  let lastLayoutW = 0;

  const actBar = h('div', { class: 'pm-act-bar' });
  const archChk = h('input', { type: 'checkbox', onchange: () => { showArchived = archChk.checked; renderStage(); } });
  const archLbl = h('label', { class: 'pm-chk pm-stage-arch' }, archChk, h('span', { text: '显示已归档' }));
  const btnCollapsePhases = h('button', {
    class: 'btn xact', type: 'button', text: '收起已完成阶段', hidden: true,
    onclick: () => { expandedPhases.clear(); renderStage(); },
  });
  const topoHead = h('div', { class: 'pm-stage-head' },
    h('div', { class: 'pm-stage-title' },
      h('b', { text: '协同关系图' }),
      archLbl,
      btnCollapsePhases
    ),
    h('div', { class: 'pm-stage-legend' },
      h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line' }), '黑板 @（粗细=次数，悬停看计数）'),
      h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line static' }), '委派'),
      h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line handoff' }), '交接'),
      h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line cowork' }), '平级协同'),
      h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line hot' }), '当前流向')
    )
  );
  const svgLayer = svgEl('svg', { class: 'pm-stage-svg' });
  const nodesEl = h('div', { class: 'pm-stage-nodes' });
  const hintEl = h('div', { class: 'pm-stage-hint', hidden: true });
  const stageEl = h('div', { class: 'pm-stage' }, svgLayer, nodesEl);
  const stageWrap = h('div', { class: 'pm-stage-wrap' }, stageEl, hintEl);

  // 回放条：单步 / 播放 / 拖动 / 回到最新
  const rpBack = h('button', { class: 'btn xact', type: 'button', text: '⏮', title: '上一帖', onclick: () => stepReplay(-1) });
  const rpPlay = h('button', { class: 'btn xact', type: 'button', text: '▶', title: '播放', onclick: () => togglePlay() });
  const rpFwd = h('button', { class: 'btn xact', type: 'button', text: '⏭', title: '下一帖', onclick: () => stepReplay(1) });
  const rpSlider = h('input', {
    class: 'pm-replay-slider', type: 'range', min: '0', max: '0', value: '0',
    oninput: () => { stopPlay(); setReplay(Number(rpSlider.value)); },
  });
  const rpLabel = h('span', { class: 'pm-replay-lbl' });
  const rpLive = h('button', { class: 'btn xact', type: 'button', text: '最新', title: '回到最新（显示全部帖子）', onclick: () => { stopPlay(); goLive(); } });
  const replayBar = h('div', { class: 'pm-replay-bar' }, h('span', { class: 'pm-replay-title', text: '回放' }), rpBack, rpPlay, rpFwd, rpSlider, rpLabel, rpLive);
  const topoPane = h('div', { class: 'pm-stage-pane' }, topoHead, stageWrap, replayBar);

  const feedStatusEl = h('span', { class: 'pm-feed-status', text: '全部流向' });
  const chanSel = h('select', {
    class: 'field pm-feed-chan',
    onchange: () => {
      channelFilter = chanSel.value || 'all';
      renderFeed();
    },
  }, h('option', { value: 'all', text: '全部频道' }));
  const btnClearFocus = h('button', {
    class: 'btn',
    type: 'button',
    text: '显示全部',
    hidden: true,
    onclick: () => {
      selectedSeq = 0;
      selectedNodeId = '';
      if (replayIdx != null) { stopPlay(); replayIdx = null; }
      renderAll();
    },
  });
  const btnRefresh = h('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadBoardHistory() });
  const btnFeedFold = h('button', {
    class: 'btn xact pm-feed-fold', type: 'button',
    onclick: () => setFeedCollapsed(!feedCollapsed),
  });
  const feedHead = h('div', { class: 'pm-feed-head' },
    btnFeedFold,
    h('b', { class: 'pm-feed-title', text: '黑板看板流' }),
    feedStatusEl,
    h('div', { class: 'pm-feed-tools' }, chanSel, btnClearFocus, btnRefresh)
  );
  const feedListEl = h('div', { class: 'pm-feed-list' });
  const feedPane = h('div', { class: 'pm-feed-pane' }, feedHead, feedListEl);

  const overview = createTopoOverview({
    onFocusNode: (ref) => focusNode(ref),
    onFocusSeq: (seq) => {
      const s = Number(seq) || 0;
      selectedNodeId = '';
      if (replayIdx != null) {
        const i = entries.findIndex((e) => Number(e.seq) === s);
        if (i >= 0) { setReplay(i); return; }
      }
      selectedSeq = s;
      renderAll();
    },
  });

  const staticBox = h('div', { class: 'pm-detail-lanes' });
  const rightCol = h('div', { class: 'pm-right-col' }, overview.root, topoPane, staticBox);
  const splitBox = h('div', { class: 'pm-topo-split' }, feedPane, rightCol);
  const rootEl = h('div', { class: 'pm-graph-box' }, actBar, splitBox);

  let lastRenderNodes = [];

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
      if (destroyed) return;
      const w = stageWrap.clientWidth;
      if (Math.abs(w - lastLayoutW) > 2) renderStage();
    })
    : null;
  if (ro) ro.observe(stageWrap);

  function setFeedCollapsed(v) {
    feedCollapsed = v;
    try { localStorage.setItem('pm.topo.feedCollapsed', v ? '1' : '0'); } catch {}
    splitBox.classList.toggle('feed-collapsed', v);
    btnFeedFold.textContent = v ? '»' : '«';
    btnFeedFold.title = v ? '展开黑板看板流' : '收起黑板看板流（给关系图更多宽度）';
  }
  setFeedCollapsed(feedCollapsed);

  function renderAll() {
    renderStage();
    renderFeed();
    renderStatic();
  }

  function focusNode(ref) {
    const n = findNode(curProj, ref) || (curProj.nodes || []).find((x) => x.id === ref);
    if (!n) return;
    if (n.archived && !showArchived) { showArchived = true; archChk.checked = true; }
    const key = nodePhaseMap(curProj).get(n.id);
    if (key) expandedPhases.add(key);
    selectedSeq = 0;
    selectedNodeId = n.id;
    renderAll();
    topoPane.scrollIntoView({ block: 'nearest' });
  }

  function renderActBar() {
    const nodes = curProj.nodes || [];
    actBar.replaceChildren(
      h('button', { class: 'btn go', type: 'button', onclick: () => openSpawnDialog(curProj) },
        h('img', { src: icon('console_prompt', true), alt: '', style: 'vertical-align:-3px;margin-right:4px' }), '在指定电脑派生新节点 (Spawn)'),
      h('button', { class: 'btn', type: 'button', text: '＋ 挂载已有会话到拓扑…', onclick: () => openBindSessionDialog(curProj) }),
      nodes.length >= 2 ? h('button', { class: 'btn', type: 'button', text: '⇄ 建立节点连线 (Master/Cowork)…', onclick: () => openLinkDialog(curProj) }) : null
    );
  }

  function allRenderNodes() {
    const nodes = curProj.nodes || [];
    if (nodes.some((n) => n.role === 'master')) return nodes;
    return [{ id: '__virtual_master__', alias: 'Master (主控)', role: 'master', machine: '', tool: '', liveState: 'idle', reviewStatus: 'running' }, ...nodes];
  }

  // 每条帖子解析一次：发帖节点 + 收件节点 id（优先服务端 entry.targets，旧数据回退 token 匹配）
  function resolveEntries(renderNodes) {
    if (resolvedCache) return resolvedCache;
    const ids = new Set(renderNodes.map((n) => n.id));
    const masters = renderNodes.filter((n) => n.role === 'master');
    resolvedCache = entries.map((e) => {
      const seq = Number(e.seq) || 0;
      const fromNode = (e.nodeId && renderNodes.find((n) => n.id === e.nodeId))
        || matchNodeByToken(renderNodes, e.agent)
        || ((e.agent === 'Master' || e.agent === '管理员' || e.agent === '主控会话') ? masters[0] : null);
      const from = fromNode ? fromNode.id : '';
      let targets = [];
      let all = false;
      if (Array.isArray(e.targets)) {
        all = Boolean(e.targetsAll);
        targets = [...new Set(e.targets.filter((id) => ids.has(id) && id !== from))];
        // @all 帖若服务端把全体都列进 targets，只记角标，不画全连接
        if (all && targets.length >= renderNodes.length - 1) targets = [];
      } else {
        const { tokens, mentionAll } = extractMentionTokens(e);
        all = mentionAll;
        const set = new Set();
        for (const tok of tokens) {
          const to = matchNodeByToken(renderNodes, tok);
          if (to && to.id !== from) set.add(to.id);
        }
        targets = [...set];
      }
      return { seq, from, targets, all };
    });
    return resolvedCache;
  }

  // 可见节点：默认隐藏已归档；显示时把「全部已完成/归档」的阶段折叠成一个组节点
  function buildVisible(renderNodes) {
    const rep = new Map();
    const list = [];
    const hiddenArchived = renderNodes.filter((n) => n.archived && n.role !== 'master').length;
    const phaseMap = nodePhaseMap(curProj);
    const byPhase = new Map();
    for (const n of renderNodes) {
      const k = phaseMap.get(n.id);
      if (!k || n.role === 'master') continue;
      if (!byPhase.has(k)) byPhase.set(k, []);
      byPhase.get(k).push(n);
    }
    const collapsed = new Map();
    if (showArchived) {
      for (const [k, members] of byPhase) {
        if (expandedPhases.has(k)) continue;
        if (members.length >= 2 && members.every(topoFinished)) collapsed.set(k, members);
      }
    }
    for (const n of renderNodes) {
      if (n.archived && n.role !== 'master' && !showArchived) continue;
      const k = phaseMap.get(n.id);
      if (k && collapsed.has(k)) { rep.set(n.id, `__phase__:${k}`); continue; }
      rep.set(n.id, n.id);
      list.push({ id: n.id, node: n, role: topoRoleOf(n), phase: k || '', name: topoName(n) });
    }
    for (const [k, members] of collapsed) {
      list.push({ id: `__phase__:${k}`, group: true, phase: k, members, name: `${k} · ${members.length} 节点 · 已完成` });
    }
    list.sort((a, b) => topoRank(a) - topoRank(b)
      || String(a.phase).localeCompare(String(b.phase), 'zh-CN', { numeric: true })
      || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      || a.id.localeCompare(b.id));
    return { list, rep, hiddenArchived, collapsedCount: collapsed.size };
  }

  function computeEdges(vis, resolved) {
    const cutoff = replayIdx == null ? Infinity : (Number(entries[replayIdx] && entries[replayIdx].seq) || 0);
    const edges = new Map(); // "a|b" -> { a, b, ab, ba, hot }
    const allCount = new Map();
    const activeNodes = new Set();
    const hasPostFocus = selectedSeq > 0;
    const hasNodeFocus = !hasPostFocus && Boolean(selectedNodeId);
    for (const r of resolved) {
      if (r.seq > cutoff) continue;
      const f = vis.rep.get(r.from);
      if (!f) continue;
      const isSelPost = hasPostFocus && r.seq === selectedSeq;
      if (r.all) allCount.set(f, (allCount.get(f) || 0) + 1);
      if (isSelPost) activeNodes.add(f);
      for (const t0 of r.targets) {
        const t = vis.rep.get(t0);
        if (!t || t === f) continue;
        const [a, b] = f < t ? [f, t] : [t, f];
        const key = `${a}|${b}`;
        const ed = edges.get(key) || { a, b, ab: 0, ba: 0, hot: false };
        if (f === a) ed.ab += 1; else ed.ba += 1;
        if (isSelPost) { ed.hot = true; activeNodes.add(t); }
        else if (hasNodeFocus && (f === selectedNodeId || t === selectedNodeId)) {
          ed.hot = true;
          activeNodes.add(f);
          activeNodes.add(t);
        }
        edges.set(key, ed);
      }
    }
    if (hasNodeFocus) activeNodes.add(selectedNodeId);
    return { edges, allCount, activeNodes };
  }

  function renderStage() {
    if (destroyed) return;
    const renderNodes = allRenderNodes();
    lastRenderNodes = renderNodes;
    const archivedTotal = renderNodes.filter((n) => n.archived && n.role !== 'master').length;
    archLbl.lastChild.textContent = `显示已归档 (${archivedTotal})`;
    archLbl.hidden = !archivedTotal;
    btnCollapsePhases.hidden = !(showArchived && expandedPhases.size);
    renderReplayBar();
    if (!(curProj.nodes || []).length) {
      nodesEl.replaceChildren(h('div', { class: 'pm-empty', text: '暂无拓扑节点，请先派生或挂载会话节点。' }));
      svgLayer.replaceChildren();
      stageEl.style.height = '';
      hintEl.hidden = true;
      return;
    }

    const vis = buildVisible(renderNodes);
    const { edges, allCount, activeNodes } = computeEdges(vis, resolveEntries(renderNodes));
    const hasFocus = selectedSeq > 0 || Boolean(selectedNodeId);

    const width = Math.max(240, stageWrap.clientWidth - 24);
    lastLayoutW = stageWrap.clientWidth;
    const items = vis.list.map((it) => {
      const label = it.name;
      const w = it.group
        ? Math.min(240, Math.max(110, 40 + topoTextW(label, 12.5)))
        : Math.min(it.role === 'master' ? 280 : 190, Math.max(84, 58 + topoTextW(label, 12.5)));
      return { ...it, w, rank: topoRank(it) };
    });
    const { pos, height } = topoLayout(items, width);
    stageEl.style.width = `${width}px`;
    stageEl.style.height = `${Math.ceil(height)}px`;

    nodesEl.replaceChildren(...items.map((it) => {
      const p = pos.get(it.id);
      const style = `left:${(p.x - p.w / 2).toFixed(1)}px;top:${(p.y - p.h / 2).toFixed(1)}px;width:${p.w.toFixed(1)}px`;
      const isHot = activeNodes.has(it.id);
      const dimmed = hasFocus && !isHot;
      const nAll = allCount.get(it.id) || 0;
      const allBadge = nAll ? h('span', { class: 'pm-gnode-all', title: `发过 ${nAll} 条 @all 广播`, text: `@all ${nAll}` }) : null;
      if (it.group) {
        return h('div', {
          class: `pm-gnode grp${isHot ? ' hot' : ''}${dimmed ? ' dim' : ''}`,
          style,
          dataset: { nodeId: it.id },
          title: `阶段 ${it.phase}（已完成，点击展开）\n${it.members.map((m) => `· ${topoName(m)}${m.archived ? '（已归档）' : ''}`).join('\n')}`,
          onclick: () => { expandedPhases.add(it.phase); renderStage(); },
        },
          h('span', { class: 'pm-gnode-plus', text: '+' }),
          h('span', { class: 'pm-gnode-name', text: it.name }),
          allBadge
        );
      }
      const n = it.node;
      const st = nodeStatus(n);
      const cls = [
        'pm-gnode', `role-${it.role}`,
        isHot ? 'hot' : '',
        selectedNodeId === n.id ? 'sel' : '',
        dimmed ? 'dim' : '',
        n.archived ? 'arch' : '',
        st.cls === 'err' ? 'alert' : '',
      ].filter(Boolean).join(' ');
      const tip = [
        `${topoName(n)}${n.label && n.label !== n.alias ? `（${n.label}）` : ''}`,
        `${TOPO_ROLE_TAG[it.role]} · ${st.label}${n.archived ? ' · 已归档' : ''}${it.phase ? ` · 阶段 ${it.phase}` : ''}`,
        [n.machine, [n.tool, n.model].filter(Boolean).join(':')].filter(Boolean).join(' · '),
        n.goal ? `目标: ${n.goal}` : '',
      ].filter(Boolean).join('\n');
      return h('div', {
        class: cls,
        style,
        dataset: { nodeId: n.id },
        title: tip,
        onclick: () => {
          selectedSeq = 0;
          selectedNodeId = selectedNodeId === n.id ? '' : n.id;
          renderAll();
        },
      },
        h('span', { class: `pm-tdot ${st.cls}` }),
        h('span', { class: 'pm-gnode-name', text: it.name }),
        h('span', { class: 'pm-gnode-role', text: TOPO_ROLE_TAG[it.role] }),
        allBadge
      );
    }));

    if (vis.hiddenArchived && !showArchived) {
      hintEl.hidden = false;
      hintEl.textContent = `已隐藏 ${vis.hiddenArchived} 个已归档节点（勾选「显示已归档」查看历史协作）`;
    } else if (showArchived && vis.collapsedCount) {
      hintEl.hidden = false;
      hintEl.textContent = '已完成的阶段折叠为组节点，点击组节点展开';
    } else {
      hintEl.hidden = true;
    }

    drawEdges(pos, edges, hasFocus, vis);
  }

  function drawEdges(pos, edges, hasFocus, vis) {
    const W = stageEl.clientWidth || 1;
    const H = stageEl.clientHeight || 1;
    const center = { x: W / 2, y: H / 2 };
    svgLayer.setAttribute('width', String(W));
    svgLayer.setAttribute('height', String(H));
    svgLayer.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const mk = (id, fill, size = 6) => svgEl('marker', { id, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: String(size), markerHeight: String(size), orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
      svgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill })
    );
    const defs = svgEl('defs', {}, mk('pm-arr-base', '#9aa3b2', 7), mk('pm-arr-dyn', '#3d4b63', 8), mk('pm-arr-hot', '#c43e00', 9));
    const baseG = svgEl('g');
    const linesG = svgEl('g');
    svgLayer.replaceChildren(defs, baseG, linesG);
    const nameOf = (id) => {
      const it = vis.list.find((x) => x.id === id);
      return it ? it.name : id;
    };

    // 静态连线：仅在两点间没有黑板交互时画淡线
    const seen = new Set();
    for (const se of curProj.edges || []) {
      const a0 = vis.rep.get(se.from), b0 = vis.rep.get(se.to);
      if (!a0 || !b0 || a0 === b0) continue;
      const key = a0 < b0 ? `${a0}|${b0}` : `${b0}|${a0}`;
      if (edges.has(key) || seen.has(key)) continue;
      seen.add(key);
      const pa = pos.get(a0), pb = pos.get(b0);
      if (!pa || !pb) continue;
      const g = topoEdgeGeom(pa, pb, 10, center);
      const type = se.type || 'master-worker';
      baseG.append(svgEl('path', {
        d: g.d,
        class: `pm-sedge t-${type}`,
        fill: 'none',
        'stroke-opacity': hasFocus ? '0.25' : '0.7',
        'marker-end': type === 'cowork' ? null : 'url(#pm-arr-base)',
      }, svgEl('title', { text: `${nameOf(a0)} → ${nameOf(b0)} · ${TOPO_EDGE_TYPE_NAMES[type] || type}（静态连线）` })));
    }

    // 黑板 @ 交互：A↔B 合并为一条线，粗细按 log(次数)，双向时两端都有箭头
    const list = [...edges.values()].sort((x, y) => Number(x.hot) - Number(y.hot));
    for (const ed of list) {
      const pa = pos.get(ed.a), pb = pos.get(ed.b);
      if (!pa || !pb) continue;
      const total = ed.ab + ed.ba;
      const g = topoEdgeGeom(pa, pb, 18, center);
      const dimmed = hasFocus && !ed.hot;
      const sw = ed.hot ? 2.6 : Math.min(4.2, 1.1 + Math.log2(total + 1) * 0.85);
      const marker = ed.hot ? 'url(#pm-arr-hot)' : 'url(#pm-arr-dyn)';
      const tipLines = [];
      if (ed.ab) tipLines.push(`${nameOf(ed.a)} → ${nameOf(ed.b)}：${ed.ab} 次`);
      if (ed.ba) tipLines.push(`${nameOf(ed.b)} → ${nameOf(ed.a)}：${ed.ba} 次`);
      const lbl = ed.ab && ed.ba ? `${ed.ab} ⇄ ${ed.ba}` : `${total}次`;
      const lw = Math.max(26, topoTextW(lbl, 10) + 10);
      const grp = svgEl('g', { class: `pm-dedge${ed.hot ? ' hot' : ''}${dimmed ? ' dim' : ''}` },
        svgEl('title', { text: tipLines.join('\n') }),
        svgEl('path', { d: g.d, class: 'pm-dedge-hit', fill: 'none' }),
        svgEl('path', {
          d: g.d,
          class: `pm-dedge-line${ed.hot ? ' pm-link-hot' : ''}`,
          fill: 'none',
          'stroke-width': sw.toFixed(2),
          'marker-end': ed.ab ? marker : null,
          'marker-start': ed.ba ? marker : null,
        }),
        svgEl('g', { class: 'pm-dedge-lbl' },
          svgEl('rect', { x: (g.mx - lw / 2).toFixed(1), y: (g.my - 8).toFixed(1), width: lw.toFixed(1), height: '16', rx: '3' }),
          svgEl('text', { x: g.mx.toFixed(1), y: (g.my + 0.5).toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central', text: lbl })
        )
      );
      linesG.append(grp);
    }
  }

  // ---- 回放 ----
  function renderReplayBar() {
    const n = entries.length;
    replayBar.hidden = !n;
    if (!n) return;
    rpSlider.max = String(Math.max(0, n - 1));
    const idx = replayIdx == null ? n - 1 : replayIdx;
    rpSlider.value = String(idx);
    const e = entries[idx];
    rpLabel.textContent = replayIdx == null
      ? `最新 · 共 ${n} 帖`
      : `#${Number(e && e.seq) || 0}（${idx + 1}/${n}）${e && e.agent ? ' · ' + e.agent : ''}`;
    rpPlay.textContent = replayTimer ? '⏸' : '▶';
    rpPlay.title = replayTimer ? '暂停' : '播放';
    rpBack.disabled = replayIdx != null && replayIdx <= 0;
    rpFwd.disabled = replayIdx == null;
    rpLive.disabled = replayIdx == null && !replayTimer;
    replayBar.classList.toggle('on', replayIdx != null);
  }

  function setReplay(idx) {
    if (!entries.length) return;
    replayIdx = Math.max(0, Math.min(entries.length - 1, idx));
    const hadNode = Boolean(selectedNodeId);
    selectedNodeId = '';
    selectedSeq = Number(entries[replayIdx].seq) || 0;
    renderStage();
    renderFeed();
    if (hadNode) renderStatic();
  }

  function goLive() {
    replayIdx = null;
    selectedSeq = 0;
    renderStage();
    renderFeed();
  }

  function stepReplay(d) {
    stopPlay();
    if (!entries.length) return;
    if (replayIdx == null) { if (d < 0) setReplay(entries.length - 2); return; }
    if (d > 0 && replayIdx >= entries.length - 1) { goLive(); return; }
    setReplay(replayIdx + d);
  }

  function stopPlay() {
    if (replayTimer) { clearInterval(replayTimer); replayTimer = 0; }
  }

  function togglePlay() {
    if (replayTimer) { stopPlay(); renderReplayBar(); return; }
    if (!entries.length) return;
    if (replayIdx == null || replayIdx >= entries.length - 1) setReplay(0);
    replayTimer = setInterval(() => {
      if (destroyed) { stopPlay(); return; }
      if (replayIdx == null || replayIdx >= entries.length - 1) { stopPlay(); goLive(); return; }
      setReplay(replayIdx + 1);
    }, 1100);
    renderReplayBar();
  }

  function renderFeed() {
    const channels = [...new Set(entries.map((e) => e.channel || 'main'))];
    const curChan = channels.includes(channelFilter) ? channelFilter : 'all';
    channelFilter = curChan;
    chanSel.replaceChildren(
      h('option', { value: 'all', text: `全部频道 (${entries.length})`, selected: curChan === 'all' }),
      ...channels.map((ch) => h('option', {
        value: ch,
        text: `#${ch}`,
        selected: curChan === ch,
      }))
    );

    btnClearFocus.hidden = !selectedSeq && !selectedNodeId && replayIdx == null;
    if (loading && !entries.length) {
      feedStatusEl.textContent = '正在加载…';
      feedListEl.replaceChildren(h('div', { class: 'pm-empty', text: '正在加载黑板消息流…' }));
      return;
    }
    let visible = curChan === 'all' ? entries : entries.filter((e) => (e.channel || 'main') === curChan);
    if (selectedNodeId) {
      const selNode = lastRenderNodes.find((n) => n.id === selectedNodeId);
      const selAlias = selNode ? topoName(selNode) : selectedNodeId;
      const resolved = resolveEntries(lastRenderNodes);
      const involved = new Set(resolved.filter((r) => r.from === selectedNodeId || r.targets.includes(selectedNodeId)).map((r) => r.seq));
      visible = visible.filter((e) => involved.has(Number(e.seq) || 0));
      feedStatusEl.textContent = `节点「${selAlias}」相关 ${visible.length} 条`;
    } else if (replayIdx != null) {
      feedStatusEl.textContent = `回放到 #${selectedSeq}`;
    } else if (selectedSeq) {
      feedStatusEl.textContent = `已高亮 #${selectedSeq} 流向`;
    } else {
      feedStatusEl.textContent = `共 ${visible.length} 条 · 点击看流向`;
    }

    if (!visible.length) {
      feedListEl.replaceChildren(h('div', { class: 'pm-empty', text: selectedNodeId ? '该节点在黑板上没有发帖或被 @ 的记录。' : '黑板尚无消息，节点派单或汇报后会实时出现在这里。' }));
      return;
    }

    const cutoff = replayIdx == null ? Infinity : selectedSeq;
    let selEl = null;
    const rows = visible.map((e) => {
      const seq = Number(e.seq) || 0;
      const isSel = selectedSeq === seq;
      const kLabel = BOARD_KIND_LABELS[e.kind] || e.kind || '帖子';
      const { tokens, mentionAll } = extractMentionTokens(e);
      const body = String(e.text || '').trim();
      const shortBody = body.length > 240 ? body.slice(0, 240) + '…' : body;
      const timeStr = e.ts ? ago(e.ts) : '';
      const auditBadge = e.audit && e.audit.checked
        ? h('span', { class: `pm-feed-audit ${e.audit.ok ? 'ok' : 'bad'}`, text: e.audit.ok ? 'gitAudit OK' : 'gitAudit 告警' })
        : null;

      const el = h('div', {
        class: `pm-feed-item${isSel ? ' sel' : ''}${seq > cutoff ? ' future' : ''}`,
        role: 'button',
        tabindex: '0',
        dataset: { seq: String(seq) },
        onclick: () => {
          selectedNodeId = '';
          if (replayIdx != null) {
            stopPlay();
            const i = entries.findIndex((x) => Number(x.seq) === seq);
            if (i >= 0) { setReplay(i); renderStatic(); return; }
          }
          selectedSeq = selectedSeq === seq ? 0 : seq;
          renderAll();
        },
      },
        h('div', { class: 'pm-feed-meta' },
          h('span', { class: 'pm-feed-seq', text: `#${seq}` }),
          h('b', { class: 'pm-feed-author', text: e.agent || '系统' }),
          h('span', { class: `pm-feed-kind k-${e.kind || 'post'}`, text: kLabel }),
          e.channel && e.channel !== 'main' ? h('span', { class: 'pm-feed-ch', text: `#${e.channel}` }) : null,
          mentionAll ? h('span', { class: 'pm-feed-mention', text: '-> @all' }) : null,
          ...tokens.slice(0, 3).map((t) => h('span', { class: 'pm-feed-mention', text: `-> @${t}` })),
          auditBadge,
          h('span', { class: 'pm-feed-time', text: timeStr })
        ),
        h('div', { class: 'pm-feed-body', text: shortBody })
      );
      if (isSel) selEl = el;
      return el;
    });
    feedListEl.replaceChildren(...rows);
    if (selEl) {
      // feed pane 是 sticky 定位，条目与列表的 offsetTop 同以它为基准
      const top = selEl.offsetTop - feedListEl.offsetTop;
      const viewH = feedListEl.clientHeight;
      if (top < feedListEl.scrollTop || top + Math.min(selEl.offsetHeight, viewH / 2) > feedListEl.scrollTop + viewH) {
        feedListEl.scrollTop = Math.max(0, top - 40);
      }
    } else if (!selectedSeq) {
      feedListEl.scrollTop = feedListEl.scrollHeight;
    }
  }

  function renderStatic() {
    const nodes = curProj.nodes || [];
    if (!nodes.length) {
      staticBox.replaceChildren(h('div', { class: 'pm-empty', text: '该项目还没有会话节点。你可以从上方「挂载已有会话到拓扑」或「在远程电脑派生新节点」。' }));
      return;
    }
    const sel = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
    const active = nodes.filter((n) => !n.archived);
    const archived = nodes.filter((n) => n.archived);
    const byRole = (list, pred) => list.filter(pred);
    const masters = byRole(active, (n) => n.role === 'master');
    const peers = byRole(active, (n) => n.role === 'peer');
    const verifiers = byRole(active, (n) => n.role === 'verifier');
    const workers = byRole(active, (n) => !['master', 'peer', 'verifier'].includes(n.role));
    const lane = (title, list) => (list.length
      ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: title }), ...list.map((n) => nodeCard(curProj, n)))
      : null);

    const archBox = archived.length ? h('details', {
      class: 'pm-lane pm-lane-arch',
      open: archLaneOpen,
      ontoggle: (ev) => { archLaneOpen = ev.currentTarget.open; },
    },
      h('summary', { class: 'pm-lane-hd', text: `已归档 (${archived.length})` }),
      ...archived.map((n) => nodeCard(curProj, n))
    ) : null;

    staticBox.replaceChildren(...[
      sel ? h('div', { class: 'pm-lane pm-lane-sel' },
        h('div', { class: 'pm-lane-hd' },
          h('span', { text: `节点详情：${topoName(sel)}` }),
          h('button', { class: 'pm-edge-del', type: 'button', title: '关闭详情', text: '×', onclick: () => { selectedNodeId = ''; renderAll(); } })
        ),
        nodeCard(curProj, sel)
      ) : null,
      h('div', { class: 'pm-lanes' },
        lane('主控层 (Master)', masters),
        lane('平级协作层 (Cowork Peers)', peers),
        lane('验收层 (Verifier)', verifiers),
        lane('执行层 (Workers)', workers),
        archBox
      ),
    ].filter(Boolean));
  }

  async function loadBoardHistory() {
    if (destroyed) return;
    const token = ++loadToken;
    loading = true;
    renderFeed();
    const r = await mesh.getBoard(curProj.id, { limit: 200 });
    if (destroyed || token !== loadToken) return;
    loading = false;
    if (r && r.ok) {
      entries = (Array.isArray(r.entries) ? r.entries : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
      resolvedCache = null;
      const nextMax = entries.length ? Math.max(...entries.map((e) => Number(e.seq) || 0)) : 0;
      loadedBoardSeq = typeof r.latestSeq === 'number' ? r.latestSeq : (curProj.boardSeq || nextMax);
      if (selectedSeq && !entries.some((e) => Number(e.seq) === selectedSeq)) selectedSeq = 0;
      if (replayIdx != null && replayIdx >= entries.length) replayIdx = null;
    }
    overview.update(curProj, entries);
    renderStage();
    renderFeed();
  }

  renderActBar();
  renderStage();
  renderFeed();
  renderStatic();
  overview.update(curProj, entries);
  loadBoardHistory();

  return {
    projectId: proj.id,
    root: rootEl,
    update(nextProj) {
      curProj = nextProj;
      resolvedCache = null;
      renderActBar();
      renderStatic();
      const nextSeq = typeof nextProj.boardSeq === 'number' ? nextProj.boardSeq : 0;
      if (loadedBoardSeq !== -1 && nextSeq !== loadedBoardSeq) {
        loadBoardHistory();
      } else {
        overview.update(curProj, entries);
        renderStage();
      }
    },
    destroy() {
      destroyed = true;
      stopPlay();
      if (ro) ro.disconnect();
      try { overview.destroy(); } catch {}
    },
  };
}
