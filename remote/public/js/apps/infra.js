// 网络与设备 (Infrastructure & Network Topology Monitor):
//   - Visualizes workstations, OpenWrt router, Synology NAS, and cloud servers (AWS/GCP) with live SVG interconnect links.
//   - Event-driven low-traffic monitoring: 60s silent heartbeat when closed, 10s fast refresh while this window is open.
//   - Remote control (restart/start/stop systemd/init.d services, Docker containers, NAS egress.sh, OpenWrt sing-box retest)
//     protected by TOTP step-up authentication.
import { h, icon, ago } from '../util.js';
import * as net from '../net.js';
import * as wm from '../wm.js';
import { confirmBox, askText } from '../dialog.js';
import * as computers from './computers.js';

let inst = null;

const ROLE_NAMES = {
  router: '网关路由',
  nas: '核心存储/NAS',
  cloud: '云端服务器',
  workstation: '工作站/算力机',
};

const ROLE_ICONS = {
  router: 'network_cool_two_pcs',
  nas: 'hard_disk_drive',
  cloud: 'network_normal_two_pcs',
  workstation: 'computer_2',
};

function fmtUptime(sec) {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

function fmtBytes(b) {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

export function open(initialNodeId) {
  if (inst) {
    if (initialNodeId) inst.select(initialNodeId);
    wm.focus('infra');
    return;
  }
  inst = mount(initialNodeId);
  wm.open({
    id: 'infra',
    title: '网络与设备 — 服务监控与互联拓扑',
    icon: icon('network_cool_two_pcs', true),
    width: 1140,
    height: 680,
    content: inst.root,
    onClose: () => {
      inst.destroy();
      inst = null;
    },
  });
}

function effectiveTier(n) {
  if (n.role === 'router' || n.role === 'nas') return 1;
  if (n.role === 'workstation') return 0;
  if (Number.isFinite(n.tier)) return Math.max(0, Math.min(2, n.tier));
  return 2;
}

function shortLinkLabel(l) {
  let s = String(l.label || '').trim();
  s = s.replace(/\s*\([^)]*\)/g, '');
  s = s.replace(/^Tailscale\s+SOCKS5/i, 'SOCKS5');
  s = s.replace(/^Tailscale\s+互联/i, 'TS 互联');
  s = s.replace(/^Sing-box\s*\/\s*Tailscale/i, 'Sing-box');
  s = s.replace(/^LAN\s*\/\s*Windose/i, 'LAN');
  s = s.replace(/^LAN\s*网关\s*\/\s*Sing-box/i, 'LAN 网关');
  s = s.replace(/^SSH\s+-D/i, 'SSH');
  s = s.replace(/^Claude\s+HTTP/i, 'Claude');
  s = s.replace(/^FRP\s+穿透/i, 'FRP');
  if (s.length > 14) s = s.slice(0, 13) + '…';
  return s || `${l.from}→${l.to}`;
}

function estimateTextWidth(str) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += str.charCodeAt(i) > 255 ? 10.5 : 5.8;
  }
  return Math.ceil(w);
}

function mount(initialNodeId) {
  let state = { nodes: [], links: [], events: [], fast: false, intervalSec: 60 };
  let selId = initialNodeId || 'nas';
  let showEvents = false;

  const topBar = h('div', { class: 'inf-bar' });
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('class', 'inf-svg');
  const tiersBox = h('div', { class: 'inf-tiers' });
  const canvasWrap = h('div', { class: 'inf-canvas-wrap' }, svgEl, tiersBox);

  const topoHead = h('div', { class: 'inf-topo-head' },
    h('b', { text: '设备与服务互联拓扑（点击节点高亮链路并查看详情）' }),
    h('div', { class: 'inf-legend' },
      h('span', { class: 'inf-leg-item' }, h('i', { class: 'inf-leg-line' }), '主用畅通'),
      h('span', { class: 'inf-leg-item' }, h('i', { class: 'inf-leg-line standby' }), '备用待命'),
      h('span', { class: 'inf-leg-item' }, h('i', { class: 'inf-leg-line down' }), '中断/告警')
    )
  );
  const topoPane = h('div', { class: 'inf-topo-pane' }, topoHead, canvasWrap);
  const detailPane = h('div', { class: 'inf-detail-pane' });
  const body = h('div', { class: 'inf-body' }, topoPane, detailPane);
  const statusLine = h('div', { class: 'inf-status' });
  const root = h('div', { class: 'inf-app' }, topBar, body, statusLine);

  function say(msg) {
    statusLine.replaceChildren(
      h('span', { text: msg || '就绪' }),
      h('span', { text: `通信模式：${state.fast ? '实时巡检 (10s)' : '事件驱动低频心跳 (60s)'}` })
    );
  }

  async function fetchState() {
    try {
      const res = await fetch('/api/infra/state');
      const d = await res.json();
      if (d && d.ok) {
        state = d;
        if (!state.nodes.some((n) => n.id === selId) && state.nodes.length) {
          selId = state.nodes[0].id;
        }
        render();
      }
    } catch {}
  }

  async function triggerRefresh() {
    say('正在向所有在线节点请求最新状态与链路测速…');
    try {
      const r = await net.post('/api/infra/refresh', {});
      if (r && r.ok) {
        state = r;
        render();
        say('已刷新全部节点与链路状态');
      }
    } catch {}
  }

  function renderTopBar() {
    const onlineCnt = state.nodes.filter((n) => n.online).length;
    const totalSvcs = state.nodes.reduce((s, n) => s + (n.services || []).filter((x) => x.state === 'running').length, 0);
    const totalCnts = state.nodes.reduce((s, n) => s + (n.containers || []).filter((x) => x.state === 'running').length, 0);
    const totalAlerts = state.nodes.reduce((s, n) => s + (n.alertCount || 0), 0);

    topBar.replaceChildren(
      h('span', { class: `inf-stat-pill ${onlineCnt > 0 ? 'ok' : ''}`, text: `在线设备 ${onlineCnt} / ${state.nodes.length}` }),
      h('span', { class: 'inf-stat-pill', text: `运行服务 ${totalSvcs}` }),
      h('span', { class: 'inf-stat-pill', text: `Docker 容器 ${totalCnts}` }),
      totalAlerts > 0
        ? h('span', { class: 'inf-stat-pill err', text: `⚠️ 异常告警 ${totalAlerts}` })
        : h('span', { class: 'inf-stat-pill ok', text: '✓ 核心服务正常' }),
      h('div', { class: 'inf-bar-right' },
        h('button', { class: 'btn', type: 'button', text: '🔄 立即刷新', onclick: triggerRefresh }),
        h('button', { class: 'btn', type: 'button', text: '＋ 添加节点', onclick: () => openNodeDialog(null) }),
        h('button', { class: 'btn', type: 'button', text: '🔗 添加互联链路', onclick: () => openLinkDialog(null) }),
        h('button', { class: 'btn', type: 'button', text: '🔑 令牌与安装命令', onclick: () => computers.open() }),
        h('button', {
          class: `btn ${showEvents ? 'go' : ''}`,
          type: 'button',
          text: `📋 事件流水 (${(state.events || []).length})`,
          onclick: () => { showEvents = !showEvents; renderDetail(); },
        })
      )
    );
  }

  function meterRow(label, pct) {
    if (pct == null || !Number.isFinite(pct)) return null;
    const cls = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
    return h('div', { class: 'inf-bar-row' },
      h('span', { class: 'inf-bar-lbl', text: label }),
      h('div', { class: 'inf-meter' }, h('i', { class: cls, style: `width:${Math.min(100, Math.max(0, pct))}%` })),
      h('span', { class: 'inf-bar-val', text: `${pct}%` })
    );
  }

  function renderNodeCard(n, colIdx) {
    const isSel = n.id === selId && !showEvents;
    const hasAlert = n.alertCount > 0;
    const dotCls = hasAlert ? 'err' : n.online ? 'on' : '';
    const hasLink = (state.links || []).some((l) => l.from === n.id || l.to === n.id);
    const isCompact = !n.online && !hasAlert && !hasLink && !(n.services && n.services.length) && !(n.containers && n.containers.length);

    if (isCompact) {
      return h('div', {
        class: `inf-node compact off${isSel ? ' sel' : ''}`,
        'data-node-id': n.id,
        'data-col': String(colIdx),
        onclick: () => { selId = n.id; showEvents = false; render(); },
      },
        h('div', { class: 'inf-node-hd' },
          h('span', { class: `inf-dot ${dotCls}` }),
          h('img', { src: icon(ROLE_ICONS[n.role] || 'computer_2', true), alt: '' }),
          h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: n.label || n.id }),
          h('span', { style: 'font-size:9.5px;color:var(--muted)', text: '离线' })
        )
      );
    }

    // Pick concise key pills to show on the card without overflowing vertically
    const pills = [];
    if (n.proxy && n.proxy.active) {
      const shortProxy = n.proxy.active.length > 14 ? n.proxy.active.slice(0, 13) + '…' : n.proxy.active;
      pills.push(h('span', {
        class: 'inf-pill proxy',
        title: `${n.proxy.active}${n.proxy.delayMs ? ` (${n.proxy.delayMs}ms)` : ''}`,
        text: `🚀 ${shortProxy}${n.proxy.delayMs ? ` ${n.proxy.delayMs}ms` : ''}`,
      }));
    }
    if (n.gpus && n.gpus.length > 0) {
      const g = n.gpus[0];
      pills.push(h('span', { class: 'inf-pill proxy', text: `GPU ${g.utilPct}%·${g.tempC}°C` }));
    }
    if (n.net && n.net.monthTxGb != null) {
      pills.push(h('span', { class: 'inf-pill', text: `月↑${n.net.monthTxGb}G` }));
    }

    const downSvcs = (n.services || []).filter((s) => s.state !== 'running');
    const downCnts = (n.containers || []).filter((c) => c.state !== 'running');
    for (const s of downSvcs.slice(0, 2)) {
      pills.push(h('span', { class: 'inf-pill err', text: `× ${s.name}` }));
    }
    for (const c of downCnts.slice(0, 2)) {
      pills.push(h('span', { class: 'inf-pill err', text: `× 🐳${c.name}` }));
    }

    const okWatchedSvcs = (n.services || []).filter((s) => s.watched && s.state === 'running');
    const okWatchedCnts = (n.containers || []).filter((c) => c.watched && c.state === 'running');
    const shownOk = [];
    for (const s of okWatchedSvcs) {
      if (shownOk.length < 2) shownOk.push(h('span', { class: 'inf-pill ok', text: `● ${s.name}` }));
    }
    for (const c of okWatchedCnts) {
      if (shownOk.length < 2) shownOk.push(h('span', { class: 'inf-pill ok', text: `🐳 ${c.name}` }));
    }
    pills.push(...shownOk);
    const totalOkWatched = okWatchedSvcs.length + okWatchedCnts.length;
    if (totalOkWatched > shownOk.length) {
      pills.push(h('span', { class: 'inf-pill ok', text: `+${totalOkWatched - shownOk.length} 正常` }));
    }

    return h('div', {
      class: `inf-node${isSel ? ' sel' : ''}${n.online ? '' : ' off'}${hasAlert ? ' alert' : ''}`,
      'data-node-id': n.id,
      'data-col': String(colIdx),
      onclick: () => {
        selId = n.id;
        showEvents = false;
        render();
      },
    },
      h('div', { class: 'inf-node-hd' },
        h('span', { class: `inf-dot ${dotCls}` }),
        h('img', { src: icon(ROLE_ICONS[n.role] || 'computer_2', true), alt: '' }),
        h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: n.label || n.id, text: n.label || n.id })
      ),
      n.host ? h('div', { class: 'inf-node-host', title: n.host, text: n.host }) : null,
      n.online && (n.cpuPct != null || (n.mem && n.mem.pct != null)) ? h('div', { class: 'inf-bars' },
        meterRow('CPU', n.cpuPct),
        n.mem ? meterRow('MEM', n.mem.pct) : null
      ) : null,
      pills.length ? h('div', { class: 'inf-pills' }, ...pills) : null
    );
  }

  function sortColumnNodes(list) {
    const linkedIds = new Set();
    for (const l of state.links || []) { linkedIds.add(l.from); linkedIds.add(l.to); }
    return [...list].sort((a, b) => {
      const aPri = (a.role === 'router' ? 4 : 0) + (linkedIds.has(a.id) ? 2 : 0) + (a.online ? 1 : 0);
      const bPri = (b.role === 'router' ? 4 : 0) + (linkedIds.has(b.id) ? 2 : 0) + (b.online ? 1 : 0);
      return bPri - aPri;
    });
  }

  function renderTopology() {
    const tier0 = sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 0));
    const tier1 = sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 1));
    const tier2 = sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) >= 2));

    tiersBox.replaceChildren(
      h('div', { class: 'inf-tier-col', 'data-tier-col': '0' },
        h('div', { class: 'inf-tier-title', text: '终端与算力工作站' }),
        ...tier0.map((n) => renderNodeCard(n, 0))
      ),
      h('div', { class: 'inf-tier-col', 'data-tier-col': '1' },
        h('div', { class: 'inf-tier-title', text: '局域网核心 (网关 / NAS)' }),
        ...tier1.map((n) => renderNodeCard(n, 1))
      ),
      h('div', { class: 'inf-tier-col', 'data-tier-col': '2' },
        h('div', { class: 'inf-tier-title', text: '云端出口与穿透节点' }),
        ...tier2.map((n) => renderNodeCard(n, 2))
      )
    );

    requestAnimationFrame(drawSvgLinks);
  }

  function resolveBadgeOverlaps(items, minGap, minY, maxY) {
    if (items.length <= 1) return;
    items.sort((a, b) => a.wantY - b.wantY || a.idx - b.idx);
    for (let i = 0; i < items.length; i++) items[i].my = items[i].wantY;

    for (let iter = 0; iter < 4; iter++) {
      // Push down
      for (let i = 1; i < items.length; i++) {
        if (items[i].my < items[i - 1].my + minGap) {
          items[i].my = items[i - 1].my + minGap;
        }
      }
      // Re-center shift toward original wantY mean
      const shift = items.reduce((s, x) => s + (x.my - x.wantY), 0) / items.length;
      for (let i = 0; i < items.length; i++) items[i].my -= shift * 0.5;
      // Push up from bottom if needed
      for (let i = items.length - 2; i >= 0; i--) {
        if (items[i].my > items[i + 1].my - minGap) {
          items[i].my = items[i + 1].my - minGap;
        }
      }
    }
    // Final strict forward pass & bounds clamp
    if (items[0].my < minY) items[0].my = minY;
    for (let i = 1; i < items.length; i++) {
      if (items[i].my < items[i - 1].my + minGap) {
        items[i].my = items[i - 1].my + minGap;
      }
    }
    const over = items[items.length - 1].my - maxY;
    if (over > 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        items[i].my = Math.max(minY + i * minGap, items[i].my - over);
      }
    }
  }

  function drawSvgLinks() {
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    const wrapRect = canvasWrap.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;

    const w = Math.max(canvasWrap.scrollWidth, canvasWrap.clientWidth);
    const hgt = Math.max(canvasWrap.scrollHeight, canvasWrap.clientHeight);
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', hgt);
    svgEl.setAttribute('viewBox', `0 0 ${w} ${hgt}`);

    const boxMap = new Map();
    for (const el of tiersBox.querySelectorAll('.inf-node[data-node-id]')) {
      const id = el.getAttribute('data-node-id');
      const col = Number(el.getAttribute('data-col') || 0);
      const r = el.getBoundingClientRect();
      boxMap.set(id, {
        id,
        col,
        left: r.left - wrapRect.left + canvasWrap.scrollLeft,
        right: r.right - wrapRect.left + canvasWrap.scrollLeft,
        top: r.top - wrapRect.top + canvasWrap.scrollTop,
        bottom: r.bottom - wrapRect.top + canvasWrap.scrollTop,
        width: r.width,
        height: r.height,
        cx: r.left - wrapRect.left + canvasWrap.scrollLeft + r.width / 2,
        cy: r.top - wrapRect.top + canvasWrap.scrollTop + r.height / 2,
      });
    }

    // Measure column horizontal bounds to find exact corridor centers
    const colBounds = [null, null, null];
    for (const b of boxMap.values()) {
      const c = b.col;
      if (!colBounds[c]) {
        colBounds[c] = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      } else {
        colBounds[c].left = Math.min(colBounds[c].left, b.left);
        colBounds[c].right = Math.max(colBounds[c].right, b.right);
        colBounds[c].top = Math.min(colBounds[c].top, b.top);
        colBounds[c].bottom = Math.max(colBounds[c].bottom, b.bottom);
      }
    }

    const validLinks = (state.links || []).filter((l) => boxMap.has(l.from) && boxMap.has(l.to));
    if (!validLinks.length) return;

    // Distribute attachment ports along each node edge so multiple links don't cross at the card border
    const rightPorts = new Map(); // nodeId -> Array<{ item, peerY }>
    const leftPorts = new Map();
    const items = validLinks.map((l, idx) => {
      const b1 = boxMap.get(l.from);
      const b2 = boxMap.get(l.to);
      const item = { l, idx, b1, b2, x1: b1.right, y1: b1.cy, x2: b2.left, y2: b2.cy, mx: 0, my: 0, wantY: 0, kind: 'adj' };
      if (b1.col === b2.col) {
        item.kind = 'same';
      } else if (Math.abs(b1.col - b2.col) >= 2) {
        item.kind = 'span';
      }
      if (item.kind !== 'same') {
        const leftBox = b1.cx <= b2.cx ? b1 : b2;
        const rightBox = b1.cx <= b2.cx ? b2 : b1;
        if (!rightPorts.has(leftBox.id)) rightPorts.set(leftBox.id, []);
        if (!leftPorts.has(rightBox.id)) leftPorts.set(rightBox.id, []);
        rightPorts.get(leftBox.id).push({ item, isFrom: leftBox === b1, peerY: rightBox.cy, idx });
        leftPorts.get(rightBox.id).push({ item, isFrom: rightBox === b1, peerY: leftBox.cy, idx });
      }
      return item;
    });

    function assignEdgePorts(portMap, isRightEdge) {
      for (const [nodeId, list] of portMap.entries()) {
        const box = boxMap.get(nodeId);
        list.sort((a, b) => a.peerY - b.peerY || a.idx - b.idx);
        const usableH = Math.max(16, box.height - 22);
        const step = list.length > 1 ? Math.min(13, usableH / (list.length - 1)) : 0;
        for (let i = 0; i < list.length; i++) {
          const py = box.cy + (i - (list.length - 1) / 2) * step;
          const px = isRightEdge ? box.right : box.left;
          if (list[i].isFrom) {
            list[i].item.x1 = px;
            list[i].item.y1 = py;
          } else {
            list[i].item.x2 = px;
            list[i].item.y2 = py;
          }
        }
      }
    }
    assignEdgePorts(rightPorts, true);
    assignEdgePorts(leftPorts, false);

    // Group into corridors and compute badge positions
    const corridors = new Map();
    for (const it of items) {
      const { b1, b2 } = it;
      if (it.kind === 'same') {
        const upper = b1.cy <= b2.cy ? b1 : b2;
        const lower = b1.cy <= b2.cy ? b2 : b1;
        it.x1 = b1.cx;
        it.y1 = b1 === upper ? upper.bottom : lower.top;
        it.x2 = b2.cx;
        it.y2 = b2 === lower ? lower.top : upper.bottom;
        it.mx = (b1.cx + b2.cx) / 2;
        it.wantY = (upper.bottom + lower.top) / 2;
        it.my = it.wantY;
      } else if (it.kind === 'span') {
        const midCol = colBounds[1];
        const topClear = Math.min(midCol ? midCol.top : b1.top, b1.top, b2.top) - 22;
        it.mx = midCol ? (midCol.left + midCol.right) / 2 : (it.x1 + it.x2) / 2;
        it.wantY = Math.max(14, topClear);
        const key = 'span:0-2';
        if (!corridors.has(key)) corridors.set(key, []);
        corridors.get(key).push(it);
      } else {
        const cMin = Math.min(b1.col, b2.col);
        const cMax = Math.max(b1.col, b2.col);
        const leftB = colBounds[cMin];
        const rightB = colBounds[cMax];
        it.mx = (leftB && rightB) ? (leftB.right + rightB.left) / 2 : (it.x1 + it.x2) / 2;
        it.wantY = (it.y1 + it.y2) / 2;
        const key = `adj:${cMin}-${cMax}`;
        if (!corridors.has(key)) corridors.set(key, []);
        corridors.get(key).push(it);
      }
    }

    for (const group of corridors.values()) {
      resolveBadgeOverlaps(group, 21, 16, Math.max(120, hgt - 16));
    }

    const linesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const badgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svgEl.appendChild(linesGroup);
    svgEl.appendChild(badgesGroup);

    for (const it of items) {
      const { l, x1, y1, x2, y2, mx, my, kind } = it;
      const isRelated = !selId || showEvents || l.from === selId || l.to === selId;
      const isDown = l.status === 'down';
      const color = isDown ? '#d90429' : l.status === 'standby' ? '#1d6fd8' : l.status === 'ok' ? '#1b8a3d' : '#888';
      const opacity = isDown || isRelated ? '1' : '0.42';

      let dPath;
      if (kind === 'same') {
        dPath = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else {
        // Two-piece horizontal-tangent cubic Bezier passing smoothly through (mx, my)
        const s1 = mx >= x1 ? 1 : -1;
        const s2 = x2 >= mx ? 1 : -1;
        const d1 = Math.max(16, Math.abs(mx - x1) * 0.46);
        const d2 = Math.max(16, Math.abs(x2 - mx) * 0.46);
        dPath = `M ${x1} ${y1} C ${x1 + s1 * d1} ${y1}, ${mx - s1 * d1 * 0.65} ${my}, ${mx} ${my} C ${mx + s2 * d2 * 0.65} ${my}, ${x2 - s2 * d2} ${y2}, ${x2} ${y2}`;
      }

      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', dPath);
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('stroke', color);
      pathEl.setAttribute('stroke-opacity', opacity);
      pathEl.setAttribute('stroke-width', isDown ? '2.4' : isRelated ? '2.0' : '1.4');
      if (l.status === 'standby' || l.standby) {
        pathEl.setAttribute('stroke-dasharray', '5,4');
      }
      linesGroup.appendChild(pathEl);

      // Port dots on card edges
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', py);
        dot.setAttribute('r', '2.6');
        dot.setAttribute('fill', color);
        dot.setAttribute('fill-opacity', opacity);
        linesGroup.appendChild(dot);
      }

      // Compact midpoint badge
      const shortTxt = shortLinkLabel(l);
      const suffix = l.ms != null ? ` · ${l.ms}ms` : isDown ? ' · 断' : '';
      const labelText = `${shortTxt}${suffix}`;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('opacity', isDown || isRelated ? '1' : '0.68');
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = `${l.from} → ${l.to}：${l.label}${l.probeHost ? ` (${l.probeHost}:${l.probePort})` : ''}${l.ms != null ? ` · ${l.ms}ms` : ''}`;
      g.appendChild(titleEl);

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', mx);
      text.setAttribute('y', my + 3.5);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '9.5');
      text.setAttribute('font-family', 'monospace, sans-serif');
      text.setAttribute('fill', isDown ? '#a40e26' : '#1f2937');
      text.textContent = labelText;

      const estW = Math.min(110, Math.max(46, estimateTextWidth(labelText) + 10));
      rect.setAttribute('x', mx - estW / 2);
      rect.setAttribute('y', my - 7.5);
      rect.setAttribute('width', estW);
      rect.setAttribute('height', 15);
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', isDown ? '#ffe3e8' : isRelated ? '#ffffff' : 'rgba(255,255,255,0.92)');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', isRelated ? '1.2' : '0.9');

      g.appendChild(rect);
      g.appendChild(text);
      badgesGroup.appendChild(g);
    }
  }

  async function runControl(nodeId, kind, target, op, label) {
    if (!(await confirmBox(`确定要在「${nodeId}」上执行 ${label} 吗？`, { title: '远程服务控制' }))) return;
    say(`正在下发指令：${label}…`);
    const r = await net.post('/api/infra/control', { nodeId, kind, target, op });
    say(r.ok ? `✓ ${r.msg || '执行成功'}` : `✗ ${r.msg || '执行失败'}`);
    await fetchState();
  }

  async function togglePin(nodeId, item) {
    const r = await net.post('/api/infra/pin', { nodeId, item });
    if (r && r.ok) await fetchState();
  }

  function renderEventsView() {
    const evts = state.events || [];
    detailPane.replaceChildren(
      h('div', { class: 'inf-det-head' },
        h('div', {},
          h('div', { class: 'inf-det-title', text: '📋 节点状态变更与远程控制流水' }),
          h('div', { class: 'inf-det-sub', text: '记录关键服务启停、Docker 容器状态变化、节点上下线及手动控制操作' })
        ),
        h('button', { class: 'btn', type: 'button', text: '返回节点详情', onclick: () => { showEvents = false; renderDetail(); } })
      ),
      evts.length ? h('div', { class: 'inf-list' }, ...evts.map((ev) =>
        h('div', { class: `inf-row ${ev.level === 'err' ? 'err' : ''}` },
          h('span', { class: `inf-pill ${ev.level === 'err' ? 'err' : ev.level === 'ok' ? 'ok' : 'warn'}`, text: ev.nodeId }),
          h('span', { style: 'flex:1', text: ev.summary }),
          h('span', { class: 'inf-row-meta', style: 'flex:none', text: ago(ev.ts) })
        )
      )) : h('div', { class: 'notice', text: '暂无告警或状态变更记录。' })
    );
  }

  function renderDetail() {
    if (showEvents) return renderEventsView();
    const n = state.nodes.find((x) => x.id === selId);
    if (!n) {
      detailPane.replaceChildren(h('div', { class: 'notice', text: '请在左侧拓扑图中点击选择一个节点。' }));
      return;
    }

    const kpis = [
      h('div', { class: 'inf-kpi' },
        h('div', { class: 'inf-kpi-k', text: '在线状态 / 运行时长' }),
        h('div', { class: 'inf-kpi-v', text: n.online ? `🟢 在线 · ${fmtUptime(n.uptimeSec)}` : '⚪ 离线 / 未上报' })
      ),
      h('div', { class: 'inf-kpi' },
        h('div', { class: 'inf-kpi-k', text: 'CPU 占用 / 系统负载' }),
        h('div', { class: 'inf-kpi-v', text: n.cpuPct != null ? `${n.cpuPct}% (Load ${n.load1 || 0})` : '—' })
      ),
      h('div', { class: 'inf-kpi' },
        h('div', { class: 'inf-kpi-k', text: '内存占用' }),
        h('div', { class: 'inf-kpi-v', text: n.mem ? `${n.mem.usedMb} / ${n.mem.totalMb} MB (${n.mem.pct}%)` : '—' })
      ),
      h('div', { class: 'inf-kpi' },
        h('div', { class: 'inf-kpi-k', text: `磁盘空间 (${(n.disk && n.disk.mount) || '/'})` }),
        h('div', { class: 'inf-kpi-v', text: n.disk ? `${n.disk.usedGb} / ${n.disk.totalGb} GB (${n.disk.pct}%)` : '—' })
      ),
    ];

    if (n.net) {
      const rateStr = `↓${n.net.rxKbps || 0} KB/s · ↑${n.net.txKbps || 0} KB/s`;
      const monthStr = n.net.monthTxGb != null
        ? `月累计 ↓${n.net.monthRxGb}G ↑${n.net.monthTxGb}G`
        : `总计 ↓${fmtBytes(n.net.rxBytes)} ↑${fmtBytes(n.net.txBytes)}`;
      kpis.push(h('div', { class: 'inf-kpi' },
        h('div', { class: 'inf-kpi-k', text: `网络吞吐 (${monthStr})` }),
        h('div', { class: 'inf-kpi-v', text: rateStr })
      ));
    }

    if (n.gpus && n.gpus.length > 0) {
      for (const g of n.gpus) {
        kpis.push(h('div', { class: 'inf-kpi' },
          h('div', { class: 'inf-kpi-k', text: `GPU: ${g.name}` }),
          h('div', { class: 'inf-kpi-v', text: `利用率 ${g.utilPct}% · 显存 ${g.memUsedMb}/${g.memTotalMb}MB · ${g.tempC}°C` })
        ));
      }
    }

    // OpenWrt Sing-box active proxy banner
    const proxyBox = n.proxy ? h('div', { class: 'inf-row', style: 'background:#e7f5ff;border-color:#1971c2' },
      h('b', { text: `🚀 Sing-box 当前出站节点：${n.proxy.active || '未知'}` }),
      h('span', { class: 'inf-row-meta', text: `策略组: ${n.proxy.group || 'auto'}${n.proxy.delayMs ? ` · 测速延迟: ${n.proxy.delayMs} ms` : ''}` }),
      h('div', { class: 'inf-row-acts' },
        h('button', {
          class: 'btn go',
          type: 'button',
          text: '⚡ 重新测速并切换最优节点',
          onclick: () => runControl(n.id, 'singbox', 'auto', 'retest', 'Sing-box 节点分级重测与切换'),
        })
      )
    ) : null;

    // Services list
    const svcs = n.services || [];
    const svcRows = svcs.map((s) => {
      const isOk = s.state === 'running';
      const isDeg = s.state === 'degraded';
      const badgeCls = isOk ? 'ok' : isDeg ? 'warn' : 'err';
      const badgeTxt = isOk ? '运行中' : isDeg ? '异常/降级' : '已停止';
      const ctrlKind = s.kind === 'egress' ? 'egress' : 'service';

      return h('div', { class: `inf-row ${!isOk && s.watched ? 'err' : ''}` },
        h('button', {
          class: `inf-pin ${s.watched ? 'on' : ''}`,
          type: 'button',
          title: s.watched ? '已设为关键关注服务（停止时告警），点击取消' : '点击设为关键关注服务',
          text: '📌',
          onclick: () => togglePin(n.id, s.name),
        }),
        h('span', { class: `inf-pill ${badgeCls}`, text: badgeTxt }),
        h('span', { class: 'inf-row-name', text: s.label || s.name }),
        h('span', { class: 'inf-row-meta', text: `${s.port ? `:${s.port}` : ''}${s.detail ? ` ${s.detail}` : ''}` }),
        h('div', { class: 'inf-row-acts' },
          h('button', {
            class: 'btn',
            type: 'button',
            text: '重启',
            onclick: () => runControl(n.id, ctrlKind, s.name, 'restart', `重启服务 ${s.label || s.name}`),
          }),
          isOk
            ? h('button', {
                class: 'btn no',
                type: 'button',
                text: '停止',
                onclick: () => runControl(n.id, ctrlKind, s.name, 'stop', `停止服务 ${s.label || s.name}`),
              })
            : h('button', {
                class: 'btn go',
                type: 'button',
                text: '启动',
                onclick: () => runControl(n.id, ctrlKind, s.name, 'start', `启动服务 ${s.label || s.name}`),
              })
        )
      );
    });

    // Docker containers list
    const cnts = n.containers || [];
    const cntRows = cnts.map((c) => {
      const isOk = c.state === 'running';
      return h('div', { class: `inf-row ${!isOk && c.watched ? 'err' : ''}` },
        h('button', {
          class: `inf-pin ${c.watched ? 'on' : ''}`,
          type: 'button',
          title: c.watched ? '已设为关键关注容器，点击取消' : '点击设为关键关注容器',
          text: '📌',
          onclick: () => togglePin(n.id, 'docker:' + c.name),
        }),
        h('span', { class: `inf-pill ${isOk ? 'ok' : 'err'}`, text: isOk ? 'Up' : 'Stopped' }),
        h('span', { class: 'inf-row-name', text: `🐳 ${c.name}` }),
        h('span', { class: 'inf-row-meta', text: `${c.status || ''}${c.ports ? ` · ${c.ports}` : ''}` }),
        h('div', { class: 'inf-row-acts' },
          h('button', {
            class: 'btn',
            type: 'button',
            text: '重启',
            onclick: () => runControl(n.id, 'docker', c.name, 'restart', `重启容器 ${c.name}`),
          }),
          isOk
            ? h('button', {
                class: 'btn no',
                type: 'button',
                text: '停止',
                onclick: () => runControl(n.id, 'docker', c.name, 'stop', `停止容器 ${c.name}`),
              })
            : h('button', {
                class: 'btn go',
                type: 'button',
                text: '启动',
                onclick: () => runControl(n.id, 'docker', c.name, 'start', `启动容器 ${c.name}`),
              })
        )
      );
    });

    // Connected links for this node
    const nodeLinks = (state.links || []).filter((l) => l.from === n.id || l.to === n.id);
    const linkRows = nodeLinks.map((l) => {
      const badgeCls = l.status === 'down' ? 'err' : l.status === 'standby' ? 'proxy' : l.status === 'ok' ? 'ok' : '';
      const badgeTxt = l.status === 'down' ? '断开' : l.status === 'standby' ? '备用待命' : l.status === 'ok' ? '畅通' : '待测';
      return h('div', { class: 'inf-row' },
        h('span', { class: `inf-pill ${badgeCls}`, text: badgeTxt }),
        h('b', { text: `${l.from} → ${l.to}` }),
        h('span', { text: l.label }),
        h('span', { class: 'inf-row-meta', text: `${l.probeHost ? `${l.probeHost}:${l.probePort}` : ''}${l.ms != null ? ` (${l.ms} ms)` : ''}` }),
        h('div', { class: 'inf-row-acts' },
          h('button', { class: 'btn', type: 'button', text: '编辑', onclick: () => openLinkDialog(l) }),
          h('button', {
            class: 'btn no',
            type: 'button',
            text: '删除',
            onclick: async () => {
              if (await confirmBox(`删除互联链路「${l.label}」吗？`, { danger: true })) {
                await net.post('/api/infra/link', { op: 'delete', id: l.id });
                await fetchState();
              }
            },
          })
        )
      );
    });

    detailPane.replaceChildren(
      h('div', { class: 'inf-det-head' },
        h('div', {},
          h('div', { class: 'inf-det-title' },
            h('img', { src: icon(ROLE_ICONS[n.role] || 'computer_2', true), alt: '' }),
            h('span', { text: n.label || n.id }),
            h('span', { class: 'inf-pill', text: ROLE_NAMES[n.role] || n.role })
          ),
          h('div', { class: 'inf-det-sub', text: `ID: ${n.id}${n.host ? ` · 地址: ${n.host}` : ''}${n.lastSeen ? ` · 最近上报: ${ago(n.lastSeen)}` : ' · 尚未收到探针上报'}` })
        ),
        h('div', { style: 'display:flex;gap:4px' },
          h('button', {
            class: 'btn',
            type: 'button',
            text: '＋ 关注服务',
            onclick: async () => {
              const s = await askText({ title: `在「${n.label}」添加常驻监控服务名（如 xray, nginx 或 docker:容器名）`, max: 64 });
              if (s && s.trim()) await togglePin(n.id, s.trim());
            },
          }),
          h('button', { class: 'btn', type: 'button', text: '编辑节点', onclick: () => openNodeDialog(n) })
        )
      ),
      h('div', { class: 'inf-kpi-grid' }, ...kpis),
      proxyBox,
      h('div', { class: 'inf-sec' },
        h('div', { class: 'inf-sec-hd' },
          h('span', { text: `常驻服务与守护进程 (${svcs.length})` }),
          h('span', { style: 'font-weight:normal;font-size:11px;color:var(--muted)', text: '📌 亮起表示设为必看服务（异常时推送告警）' })
        ),
        svcRows.length ? h('div', { class: 'inf-list' }, ...svcRows) : h('div', { class: 'notice', text: n.online ? '未发现额外服务，可点击右上角「＋ 关注服务」添加。' : '节点尚未连接上报。请在「🔑 令牌与安装命令」生成令牌并运行一键安装脚本。' })
      ),
      (cntRows.length > 0 || n.role === 'nas') ? h('div', { class: 'inf-sec' },
        h('div', { class: 'inf-sec-hd', text: `Docker 容器 (${cnts.length})` }),
        cntRows.length ? h('div', { class: 'inf-list' }, ...cntRows) : h('div', { class: 'notice', text: '未检测到 Docker 容器。' })
      ) : null,
      h('div', { class: 'inf-sec' },
        h('div', { class: 'inf-sec-hd' },
          h('span', { text: `关联的网络互联通道 (${nodeLinks.length})` }),
          h('button', { class: 'btn', type: 'button', text: '＋ 新增链路', onclick: () => openLinkDialog({ from: n.id }) })
        ),
        linkRows.length ? h('div', { class: 'inf-list' }, ...linkRows) : h('div', { class: 'notice', text: '尚未配置该节点的互联链路。' })
      )
    );
  }

  function openNodeDialog(existing) {
    const isEdit = !!(existing && existing.id);
    const idIn = h('input', { class: 'field', type: 'text', value: existing ? existing.id : '', disabled: isEdit, placeholder: '与令牌电脑名一致，如 aws1, gcp1, openwrt' });
    const labelIn = h('input', { class: 'field', type: 'text', value: existing ? existing.label : '', placeholder: '显示名称，如：AWS 东京 (aws1)' });
    const hostIn = h('input', { class: 'field', type: 'text', value: existing ? existing.host : '', placeholder: 'IP 或 Tailscale 地址，如 100.120.53.46' });
    const roleSel = h('select', { class: 'field' },
      h('option', { value: 'cloud', text: '云端服务器 (AWS / GCP / VPS)' }),
      h('option', { value: 'router', text: '网关路由器 (OpenWrt)' }),
      h('option', { value: 'nas', text: '核心存储与容器宿主 (NAS)' }),
      h('option', { value: 'workstation', text: '开发工作站 / GPU 算力机' })
    );
    if (existing && existing.role) roleSel.value = existing.role;
    const tierSel = h('select', { class: 'field' },
      h('option', { value: '0', text: '第 1 列：终端与算力工作站' }),
      h('option', { value: '1', text: '第 2 列：局域网核心 (网关 / NAS)' }),
      h('option', { value: '2', text: '第 3 列：云端出口与穿透节点' })
    );
    tierSel.value = String(existing ? effectiveTier(existing) : 2);

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: isEdit ? `编辑节点「${existing.id}」` : '添加监控设备节点' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '节点标识 ID（需与「控制面板 → 电脑」里的名字一致）：' }),
        idIn,
        h('label', { class: 'xnote-lbl', text: '显示名称与地址说明：' }),
        h('div', { style: 'display:flex;gap:6px' }, labelIn, hostIn),
        h('label', { class: 'xnote-lbl', text: '设备角色与拓扑图所在列：' }),
        h('div', { style: 'display:flex;gap:6px' }, roleSel, tierSel),
        h('div', { class: 'dlga' },
          isEdit && existing.id !== 'nas' ? h('button', {
            class: 'btn no',
            type: 'button',
            style: 'margin-right:auto',
            text: '删除节点',
            onclick: async () => {
              if (await confirmBox(`确定从拓扑图中移除节点「${existing.label || existing.id}」吗？`, { danger: true })) {
                done();
                await net.post('/api/infra/node', { op: 'delete', id: existing.id });
                await fetchState();
              }
            },
          }) : null,
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = idIn.value.trim();
      if (!id) return;
      done();
      await net.post('/api/infra/node', {
        id,
        label: labelIn.value.trim() || id,
        host: hostIn.value.trim(),
        role: roleSel.value,
        tier: Number(tierSel.value),
      });
      selId = id;
      await fetchState();
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openLinkDialog(existing) {
    const isEdit = !!(existing && existing.id);
    const fromSel = h('select', { class: 'field' }, ...state.nodes.map((n) => h('option', { value: n.id, text: `${n.label} (${n.id})` })));
    const toSel = h('select', { class: 'field' }, ...state.nodes.map((n) => h('option', { value: n.id, text: `${n.label} (${n.id})` })));
    if (existing && existing.from) fromSel.value = existing.from;
    if (existing && existing.to) toSel.value = existing.to;
    else if (state.nodes.length > 1) toSel.value = state.nodes[state.nodes.length - 1].id;

    const labelIn = h('input', { class: 'field', type: 'text', value: (existing && existing.label) || '', placeholder: '如：Tailscale SOCKS5 :1080 或 Claude HTTP :18888' });
    const svcIn = h('input', { class: 'field', type: 'text', value: (existing && existing.service) || '', placeholder: '关联服务名，如 danted, claude-gcp-proxy, sing-box' });
    const hostIn = h('input', { class: 'field', type: 'text', value: (existing && existing.probeHost) || '', placeholder: '探测目标 IP/域名，如 100.120.53.46' });
    const portIn = h('input', { class: 'field', type: 'number', value: (existing && existing.probePort) || '', placeholder: '探测端口，如 1080' });
    const standbyChk = h('input', { type: 'checkbox', checked: !!(existing && existing.standby) });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: isEdit ? '编辑网络互联链路' : '添加网络互联链路' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '起点设备 → 终点设备：' }),
        h('div', { style: 'display:flex;gap:6px;align-items:center' }, fromSel, h('span', { text: '→' }), toSel),
        h('label', { class: 'xnote-lbl', text: '链路显示名称与依赖的服务名：' }),
        h('div', { style: 'display:flex;gap:6px' }, labelIn, svcIn),
        h('label', { class: 'xnote-lbl', text: '实时延迟探测目标 IP 与 TCP 端口（可选）：' }),
        h('div', { style: 'display:flex;gap:6px' }, hostIn, portIn),
        h('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:6px' }, standbyChk, '设为备用待命通道（拓扑图中以蓝色虚线显示，如 NAS 备用出口）'),
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存链路' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      done();
      await net.post('/api/infra/link', {
        id: existing && existing.id ? existing.id : undefined,
        from: fromSel.value,
        to: toSel.value,
        label: labelIn.value.trim(),
        service: svcIn.value.trim(),
        probeHost: hostIn.value.trim(),
        probePort: Number(portIn.value) || 0,
        standby: standbyChk.checked,
      });
      await fetchState();
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function render() {
    renderTopBar();
    renderTopology();
    renderDetail();
    say();
  }

  // Keep fast mode active while this window is open
  fetch('/api/infra/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' }).catch(() => {});
  const watchTimer = setInterval(() => {
    if (!document.hidden) {
      fetch('/api/infra/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' }).catch(() => {});
    }
  }, 25000);

  const ro = new ResizeObserver(() => requestAnimationFrame(drawSvgLinks));
  ro.observe(canvasWrap);
  canvasWrap.addEventListener('scroll', () => requestAnimationFrame(drawSvgLinks));

  const offInfra = net.on('infra', fetchState);
  const offSess = net.on('sessions', fetchState);
  fetchState();

  return {
    root,
    select(id) { selId = id; showEvents = false; render(); },
    destroy() {
      clearInterval(watchTimer);
      ro.disconnect();
      offInfra();
      offSess();
      fetch('/api/infra/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' }).catch(() => {});
    },
  };
}
