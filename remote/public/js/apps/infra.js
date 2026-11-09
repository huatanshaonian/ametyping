// 网络与设备 (Infrastructure & Network Topology Monitor):
//   - Visualizes workstations, OpenWrt router, Synology NAS, and cloud servers (AWS/GCP) with live SVG interconnect links.
//   - Event-driven low-traffic monitoring: 60s silent heartbeat when closed, 10s fast refresh while this window is open.
//   - Remote control (restart/start/stop systemd/init.d services, Docker containers, NAS egress.sh, OpenWrt sing-box retest)
//     protected by TOTP step-up authentication.
import { h, icon, ago } from '../util.js';
import * as net from '../net.js';
import * as wm from '../wm.js';
import { confirmBox, askText } from '../dialog.js';
import * as ctxmenu from '../ctxmenu.js';
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

const SVGNS = 'http://www.w3.org/2000/svg';
const BADGE_FONT_PX = 9.5;
const BADGE_FONT_FAMILY = 'Consolas, "Microsoft YaHei", monospace';
let measureCtx = null;

// width in layout px of a badge label (canvas metrics are independent of the page zoom)
function textWidth(str) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${BADGE_FONT_PX}px ${BADGE_FONT_FAMILY}`;
  }
  return Math.ceil(measureCtx.measureText(str).width);
}

function svgNode(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function mount(initialNodeId) {
  let state = { nodes: [], links: [], events: [], fast: false, intervalSec: 60 };
  let selId = initialNodeId || 'nas';
  let showEvents = false;

  const topBar = h('div', { class: 'inf-bar' });
  const svgEl = svgNode('svg', { class: 'inf-svg' });
  const tiersBox = h('div', { class: 'inf-tiers' });
  // the svg shares the stage's origin with the tiers grid, so link geometry is measured relative to tiersBox and scrolls with it
  const stage = h('div', { class: 'inf-stage' }, svgEl, tiersBox);
  const canvasWrap = h('div', { class: 'inf-canvas-wrap' }, stage);

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
      const pill = h('span', {
        class: `inf-pill ${s.muted ? 'warn' : 'err'}`,
        title: s.muted ? `${s.name}：已设为按需关闭（右键可恢复异常告警）` : `${s.name}：已停止（右键可降级为按需关闭）`,
        text: `${s.muted ? '⏸' : '×'} ${s.name}`,
      });
      attachItemMenu(pill, n.id, s.name, s.label || s.name, false, !!s.muted, !!s.watched);
      pills.push(pill);
    }
    for (const c of downCnts.slice(0, 2)) {
      const pill = h('span', {
        class: `inf-pill ${c.muted ? 'warn' : 'err'}`,
        title: c.muted ? `${c.name}：已设为按需关闭（右键可恢复异常告警）` : `${c.name}：已停止（右键可降级为按需关闭）`,
        text: `${c.muted ? '⏸' : '×'} 🐳${c.name}`,
      });
      attachItemMenu(pill, n.id, 'docker:' + c.name, `容器 ${c.name}`, true, !!c.muted, !!c.watched);
      pills.push(pill);
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
        h('span', { class: 'inf-node-name', title: n.label || n.id, text: n.label || n.id })
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
    const tiers = [
      ['终端与算力工作站', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 0))],
      ['局域网核心 (网关 / NAS)', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 1))],
      ['云端出口与穿透节点', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) >= 2))],
    ];
    tiersBox.replaceChildren(...tiers.map(([title, list], i) =>
      h('div', { class: 'inf-tier-col', 'data-tier-col': String(i) },
        h('div', { class: 'inf-tier-title', title, text: title }),
        h('div', { class: 'inf-tier-cards' }, ...list.map((n) => renderNodeCard(n, i)))
      )
    ));
    scheduleDraw();
  }

  // Packs badges along one lane so they never overlap while staying as close as possible to where their links want them
  // (least-squares cluster merging); each item has wantY (desired centre) and ln (its length along the lane).
  function packLane(list, gap, lo, hi) {
    list.sort((a, b) => a.wantY - b.wantY || a.idx - b.idx);
    const clusters = [];
    const place = (c) => { c.start = Math.min(Math.max(c.sumWant / c.items.length, lo), Math.max(lo, hi - c.len)); };
    for (const it of list) {
      let c = { items: [it], len: it.ln, sumWant: it.wantY - it.ln / 2 };
      place(c);
      while (clusters.length) {
        const p = clusters[clusters.length - 1];
        if (p.start + p.len + gap <= c.start) break;
        clusters.pop();
        const shift = p.len + gap;
        c = { items: [...p.items, ...c.items], len: p.len + gap + c.len, sumWant: p.sumWant + c.sumWant - shift * c.items.length };
        place(c);
      }
      clusters.push(c);
    }
    for (const c of clusters) {
      let y = c.start;
      for (const it of c.items) { it.my = y + it.ln / 2; y += it.ln + gap; }
    }
  }

  let drawQueued = false;
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawSvgLinks(); });
  }

  // All geometry is computed in "logical" coordinates where the tier axis runs along x. In the stacked (narrow) layout the
  // tiers run top-to-bottom, so logical (x, y) maps to physical (y, x); the same routing code serves both orientations.
  function drawSvgLinks() {
    svgEl.replaceChildren();
    const baseR = tiersBox.getBoundingClientRect();
    if (!baseR.width || !tiersBox.offsetWidth) return;
    // Client rects are in screen px (they include the page-wide CSS zoom of the size setting); SVG user units are layout px.
    const z = baseR.width / tiersBox.offsetWidth || 1;
    const W = tiersBox.offsetWidth;
    const H = tiersBox.offsetHeight;
    svgEl.setAttribute('width', W);
    svgEl.setAttribute('height', H);
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const colEls = [...tiersBox.querySelectorAll('.inf-tier-col')];
    if (colEls.length < 2) return;
    const V = colEls[1].offsetTop >= colEls[0].offsetTop + colEls[0].offsetHeight - 2;
    const LW = V ? H : W; // logical extent along x (tier axis)
    const LH = V ? W : H; // logical extent along y (cross axis)
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      const p = { left: (r.left - baseR.left) / z, top: (r.top - baseR.top) / z, right: (r.right - baseR.left) / z, bottom: (r.bottom - baseR.top) / z };
      return V ? { l: p.top, r: p.bottom, t: p.left, b: p.right } : { l: p.left, r: p.right, t: p.top, b: p.bottom };
    };
    const phys = (lx, ly) => (V ? [ly, lx] : [lx, ly]);

    const boxMap = new Map();
    const colBounds = [null, null, null];
    const grow = (c, b) => {
      if (!colBounds[c]) colBounds[c] = { ...b };
      else Object.assign(colBounds[c], { l: Math.min(colBounds[c].l, b.l), r: Math.max(colBounds[c].r, b.r), t: Math.min(colBounds[c].t, b.t), b: Math.max(colBounds[c].b, b.b) });
    };
    for (const el of tiersBox.querySelectorAll('.inf-node[data-node-id]')) {
      const col = Number(el.getAttribute('data-col') || 0);
      const b = rel(el);
      b.id = el.getAttribute('data-node-id');
      b.col = col;
      b.cx = (b.l + b.r) / 2;
      b.cy = (b.t + b.b) / 2;
      boxMap.set(b.id, b);
      grow(col, b);
    }
    // the corridor between two tiers must also stay clear of the next tier's title
    colEls.forEach((el, i) => {
      const t = el.querySelector('.inf-tier-title');
      if (t && colBounds[i]) grow(i, rel(t));
    });

    const validLinks = (state.links || []).filter((l) => boxMap.has(l.from) && boxMap.has(l.to));
    if (!validLinks.length) return;

    // 1) attachment ports: spread each card's links along its facing edge, ordered by where the peer sits (no crossings at the edge)
    const farPorts = new Map();
    const nearPorts = new Map();
    const items = validLinks.map((l, idx) => {
      const b1 = boxMap.get(l.from);
      const b2 = boxMap.get(l.to);
      const it = { l, idx, b1, b2, x1: b1.r, y1: b1.cy, x2: b2.l, y2: b2.cy, mx: 0, my: 0, wantY: 0, kind: 'adj' };
      if (b1.col === b2.col) it.kind = 'same';
      else if (Math.abs(b1.col - b2.col) >= 2) it.kind = 'span';
      if (it.kind !== 'same') {
        const a = b1.col < b2.col ? b1 : b2;
        const c = a === b1 ? b2 : b1;
        if (!farPorts.has(a.id)) farPorts.set(a.id, []);
        if (!nearPorts.has(c.id)) nearPorts.set(c.id, []);
        farPorts.get(a.id).push({ it, isFrom: a === b1, peer: c.cy, idx });
        nearPorts.get(c.id).push({ it, isFrom: c === b1, peer: a.cy, idx });
      }
      return it;
    });
    const spreadPorts = (map, far) => {
      for (const [id, list] of map) {
        const box = boxMap.get(id);
        list.sort((a, b) => a.peer - b.peer || a.idx - b.idx);
        const usable = Math.max(10, box.b - box.t - (V ? 28 : 18));
        const step = list.length > 1 ? Math.min(V ? 18 : 12, usable / (list.length - 1)) : 0;
        list.forEach((p, i) => {
          const px = far ? box.r : box.l;
          const py = box.cy + (i - (list.length - 1) / 2) * step;
          if (p.isFrom) { p.it.x1 = px; p.it.y1 = py; } else { p.it.x2 = px; p.it.y2 = py; }
        });
      }
    };
    spreadPorts(farPorts, true);
    spreadPorts(nearPorts, false);

    // 2) badge text fitted to the room in its corridor (full label → short → latency only), full text stays in the tooltip
    const BADGE_H = 15;
    const fitLabel = (l, maxW) => {
      const short = shortLinkLabel(l);
      const tail = l.ms != null ? `${l.ms}ms` : l.status === 'down' ? '断' : '';
      const port = (String(l.label || '').match(/:\d+/) || [''])[0];
      const cands = [tail ? `${short} · ${tail}` : short, short];
      if (tail) cands.push(port ? `${port} · ${tail}` : tail, tail);
      else if (port) cands.push(port);
      for (const c of cands) {
        const w = textWidth(c) + 12;
        if (w <= maxW) return { text: c, w };
      }
      let s = cands[cands.length - 1];
      while (s.length > 1 && textWidth(`${s}…`) + 12 > maxW) s = s.slice(0, -1);
      return { text: `${s}…`, w: Math.max(24, Math.min(maxW, textWidth(`${s}…`) + 12)) };
    };

    // 3) group links into corridors, fit labels, then pack badges (in parallel lanes when one lane is too short)
    const corridors = new Map();
    const addTo = (key, it, thick, lo, hi) => {
      if (!corridors.has(key)) corridors.set(key, { list: [], thick, lo, hi });
      corridors.get(key).list.push(it);
    };
    for (const it of items) {
      const { b1, b2, l } = it;
      if (it.kind === 'same') {
        const up = b1.cy <= b2.cy ? b1 : b2;
        const dn = up === b1 ? b2 : b1;
        const ux = up.cx, dx = dn.cx;
        if (up === b1) { it.x1 = ux; it.y1 = up.b; it.x2 = dx; it.y2 = dn.t; } else { it.x1 = dx; it.y1 = dn.t; it.x2 = ux; it.y2 = up.b; }
        it.mx = (ux + dx) / 2;
        it.my = (up.b + dn.t) / 2;
        it.fit = fitLabel(l, V ? 120 : Math.max(40, up.r - up.l - 16));
        continue;
      }
      if (it.kind === 'span') {
        const mid = colBounds[1];
        it.mx = mid ? (mid.l + mid.r) / 2 : (it.x1 + it.x2) / 2;
        const room = mid ? mid.r - mid.l : 120;
        it.fit = fitLabel(l, V ? 140 : Math.min(150, room));
        it.ln = V ? it.fit.w : BADGE_H;
        it.tk = V ? BADGE_H : it.fit.w;
        it.wantY = Math.max(10, (mid ? mid.t : Math.min(b1.t, b2.t)) - 16);
        addTo('span', it, room, 4, Math.max(20, mid ? mid.t - 6 : LH));
        continue;
      }
      const lo = Math.min(b1.col, b2.col);
      const hiC = Math.max(b1.col, b2.col);
      const A = colBounds[lo], B = colBounds[hiC];
      const gapL = A && B ? A.r : Math.min(it.x1, it.x2);
      const gapR = A && B ? B.l : Math.max(it.x1, it.x2);
      const thick = Math.max(20, gapR - gapL);
      it.mx = (gapL + gapR) / 2;
      it.wantY = (it.y1 + it.y2) / 2;
      it.fit = fitLabel(l, V ? 150 : Math.min(160, thick - 10));
      it.ln = V ? it.fit.w : BADGE_H;
      it.tk = V ? BADGE_H : it.fit.w;
      addTo(`adj:${lo}-${hiC}`, it, thick, 6, LH - 6);
    }
    const GAP = V ? 6 : 4;
    for (const c of corridors.values()) {
      const maxTk = Math.max(...c.list.map((x) => x.tk));
      const need = c.list.reduce((s, x) => s + x.ln + GAP, -GAP);
      const lanesMax = Math.max(1, Math.floor((c.thick - 6 + GAP) / (maxTk + GAP)));
      const lanes = Math.min(lanesMax, c.list.length, Math.max(1, Math.ceil(need / Math.max(1, c.hi - c.lo))));
      const sorted = [...c.list].sort((a, b) => a.wantY - b.wantY || a.idx - b.idx);
      for (let k = 0; k < lanes; k++) {
        const lane = sorted.filter((_, i) => i % lanes === k);
        const off = (k - (lanes - 1) / 2) * (maxTk + GAP);
        for (const it of lane) it.mx += off;
        packLane(lane, GAP, c.lo, c.hi);
      }
    }

    // 4) draw: unrelated links first (dimmed), the selected node's links on top
    const linesG = document.createElementNS(SVGNS, 'g');
    const badgesG = document.createElementNS(SVGNS, 'g');
    svgEl.append(linesG, badgesG);
    const related = (l) => !selId || showEvents || l.from === selId || l.to === selId;
    items.sort((a, b) => Number(related(a.l) || a.l.status === 'down') - Number(related(b.l) || b.l.status === 'down'));
    for (const it of items) {
      const { l, x1, y1, x2, y2, mx, my, kind } = it;
      const isRel = related(l);
      const isDown = l.status === 'down';
      const standby = l.status === 'standby' || l.standby;
      const color = isDown ? '#d90429' : standby ? '#1d6fd8' : l.status === 'ok' ? '#1b8a3d' : '#888';
      const strong = isDown || isRel;
      const P = (lx, ly) => phys(lx, ly).map((v) => Math.round(v * 10) / 10).join(' ');

      let d;
      if (kind === 'same') {
        d = `M ${P(x1, y1)} L ${P(x2, y2)}`;
      } else {
        // two cubic pieces with tangents along the tier axis, meeting smoothly at the badge centre
        const s1 = mx >= x1 ? 1 : -1;
        const s2 = x2 >= mx ? 1 : -1;
        const d1 = Math.max(12, Math.abs(mx - x1) * 0.55);
        const d2 = Math.max(12, Math.abs(x2 - mx) * 0.55);
        d = `M ${P(x1, y1)} C ${P(x1 + s1 * d1, y1)}, ${P(mx - s1 * d1 * 0.6, my)}, ${P(mx, my)} C ${P(mx + s2 * d2 * 0.6, my)}, ${P(x2 - s2 * d2, y2)}, ${P(x2, y2)}`;
      }
      linesG.append(svgNode('path', {
        d, fill: 'none', stroke: color, 'stroke-opacity': strong ? 1 : 0.35,
        'stroke-width': isDown ? 2.4 : isRel ? 2 : 1.3, 'stroke-linecap': 'round',
        ...(standby ? { 'stroke-dasharray': '5 4' } : {}),
      }));
      for (const [px, py] of [phys(x1, y1), phys(x2, y2)]) {
        linesG.append(svgNode('circle', { cx: px, cy: py, r: 2.6, fill: color, 'fill-opacity': strong ? 1 : 0.4 }));
      }

      const [bx, by] = phys(mx, my);
      const { text, w } = it.fit;
      const g = svgNode('g', { class: 'inf-badge', opacity: strong ? 1 : 0.6 });
      const title = svgNode('title', {});
      title.textContent = `${l.from} → ${l.to}：${l.label}${l.probeHost ? ` (${l.probeHost}:${l.probePort})` : ''}${l.ms != null ? ` · ${l.ms}ms` : isDown ? ' · 中断' : standby ? ' · 备用' : ''}`;
      g.append(
        title,
        svgNode('rect', {
          x: Math.round((bx - w / 2) * 10) / 10, y: Math.round((by - BADGE_H / 2) * 10) / 10, width: Math.round(w), height: BADGE_H, rx: 3,
          fill: isDown ? '#ffe3e8' : '#fff', stroke: color, 'stroke-width': isRel ? 1.2 : 0.8,
        }),
        Object.assign(svgNode('text', {
          x: bx, y: by + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': BADGE_FONT_PX,
          'font-family': BADGE_FONT_FAMILY, fill: isDown ? '#a40e26' : '#1f2937',
        }), { textContent: text })
      );
      g.addEventListener('click', () => { selId = selId === l.from ? l.to : l.from; showEvents = false; render(); });
      badgesG.append(g);
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

  async function toggleMute(nodeId, item, mute) {
    const r = await net.post('/api/infra/pin', { nodeId, item, mute });
    if (r && r.ok) {
      say(mute ? `已将「${item}」降级为按需关闭（黄色待命，不计入异常告警）` : `已恢复「${item}」的停止异常告警（红色）`);
      await fetchState();
    }
  }

  function attachItemMenu(el, nodeId, itemKey, label, isDocker, isMuted, isWatched) {
    ctxmenu.attach(el, () => [
      {
        label: '🟡 降级为「按需关闭 / 暂不开启」（黄色，不报异常）',
        check: isMuted,
        onClick: () => toggleMute(nodeId, itemKey, !isMuted),
      },
      {
        label: '🔴 停止时标红告警（视为异常中断）',
        check: !isMuted,
        onClick: () => { if (isMuted) toggleMute(nodeId, itemKey, false); },
      },
      '-',
      {
        label: isWatched ? '📌 取消设为常驻关注项' : '📌 设为常驻关注项',
        check: isWatched,
        onClick: () => togglePin(nodeId, itemKey),
      },
    ]);
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
      const isMuted = !!s.muted;
      const badgeCls = isOk ? 'ok' : (isDeg || isMuted) ? 'warn' : 'err';
      const badgeTxt = isOk ? '运行中' : isDeg ? '异常/降级' : isMuted ? '按需关闭' : '已停止';
      const ctrlKind = s.kind === 'egress' ? 'egress' : 'service';

      const row = h('div', {
        class: `inf-row ${!isOk && s.watched ? (isMuted ? 'warn' : 'err') : ''}`,
        title: '右键可切换「按需关闭（黄色降级）」或「异常告警（红色）」',
      },
        h('button', {
          class: `inf-pin ${s.watched ? 'on' : ''}`,
          type: 'button',
          title: s.watched ? '已设为关键关注服务（停止时告警），点击取消' : '点击设为关键关注服务',
          text: '📌',
          onclick: () => togglePin(n.id, s.name),
        }),
        h('span', { class: `inf-pill ${badgeCls}`, text: badgeTxt }),
        h('span', { class: 'inf-row-name', text: s.label || s.name }),
        h('span', { class: 'inf-row-meta', text: `${s.port ? `:${s.port}` : ''}${s.detail ? ` ${s.detail}` : ''}${!isOk && isMuted ? ' · 暂不开(已降级)' : ''}` }),
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
      attachItemMenu(row, n.id, s.name, s.label || s.name, false, isMuted, !!s.watched);
      return row;
    });

    // Docker containers list
    const cnts = n.containers || [];
    const cntRows = cnts.map((c) => {
      const isOk = c.state === 'running';
      const isMuted = !!c.muted;
      const badgeCls = isOk ? 'ok' : isMuted ? 'warn' : 'err';
      const badgeTxt = isOk ? 'Up' : isMuted ? '按需未开' : 'Stopped';
      const row = h('div', {
        class: `inf-row ${!isOk && c.watched ? (isMuted ? 'warn' : 'err') : ''}`,
        title: '右键可切换「按需关闭（黄色降级）」或「异常告警（红色）」',
      },
        h('button', {
          class: `inf-pin ${c.watched ? 'on' : ''}`,
          type: 'button',
          title: c.watched ? '已设为关键关注容器，点击取消' : '点击设为关键关注容器',
          text: '📌',
          onclick: () => togglePin(n.id, 'docker:' + c.name),
        }),
        h('span', { class: `inf-pill ${badgeCls}`, text: badgeTxt }),
        h('span', { class: 'inf-row-name', text: `🐳 ${c.name}` }),
        h('span', { class: 'inf-row-meta', text: `${c.status || ''}${c.ports ? ` · ${c.ports}` : ''}${!isOk && isMuted ? ' · 暂不开(已降级)' : ''}` }),
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
      attachItemMenu(row, n.id, 'docker:' + c.name, `容器 ${c.name}`, true, isMuted, !!c.watched);
      return row;
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
      ...(proxyBox ? [proxyBox] : []), // replaceChildren() would print a literal "null"
      h('div', { class: 'inf-sec' },
        h('div', { class: 'inf-sec-hd' },
          h('span', { text: `常驻服务与守护进程 (${svcs.length})` }),
          h('span', { style: 'font-weight:normal;font-size:11px;color:var(--muted)', text: '📌 必看 · 右键可降级为按需未开(黄)' })
        ),
        svcRows.length ? h('div', { class: 'inf-list' }, ...svcRows) : h('div', { class: 'notice', text: n.online ? '未发现额外服务，可点击右上角「＋ 关注服务」添加。' : '节点尚未连接上报。请在「🔑 令牌与安装命令」生成令牌并运行一键安装脚本。' })
      ),
      (cntRows.length > 0 || n.role === 'nas') ? h('div', { class: 'inf-sec' },
        h('div', { class: 'inf-sec-hd' },
          h('span', { text: `Docker 容器 (${cnts.length})` }),
          h('span', { style: 'font-weight:normal;font-size:11px;color:var(--muted)', text: '右键容器可降级为按需未开(黄色，不告警)' })
        ),
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

  const ro = new ResizeObserver(scheduleDraw);
  ro.observe(canvasWrap);
  ro.observe(tiersBox);
  addEventListener('resize', scheduleDraw);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleDraw).catch(() => {});

  const offInfra = net.on('infra', fetchState);
  const offSess = net.on('sessions', fetchState);
  fetchState();

  return {
    root,
    select(id) { selId = id; showEvents = false; render(); },
    destroy() {
      clearInterval(watchTimer);
      ro.disconnect();
      removeEventListener('resize', scheduleDraw);
      offInfra();
      offSess();
      fetch('/api/infra/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' }).catch(() => {});
    },
  };
}
