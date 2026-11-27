// Infrastructure topology layout, node cards, and SVG link routing (used by infra.js).
import { h, icon, svgEl } from '../util.js';

export const ROLE_NAMES = {
  router: '网关路由',
  nas: '核心存储/NAS',
  cloud: '云端服务器',
  workstation: '工作站/算力机',
};

export const ROLE_ICONS = {
  router: 'network_cool_two_pcs',
  nas: 'hard_disk_drive',
  cloud: 'network_normal_two_pcs',
  workstation: 'computer_2',
};

export function effectiveTier(n) {
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

function meterRow(label, pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const cls = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
  return h('div', { class: 'inf-bar-row' },
    h('span', { class: 'inf-bar-lbl', text: label }),
    h('div', { class: 'inf-meter' }, h('i', { class: cls, style: `width:${Math.min(100, Math.max(0, pct))}%` })),
    h('span', { class: 'inf-bar-val', text: `${pct}%` })
  );
}

function sortColumnNodes(list, links) {
  const linkedIds = new Set();
  for (const l of links || []) { linkedIds.add(l.from); linkedIds.add(l.to); }
  return [...list].sort((a, b) => {
    const aPri = (a.role === 'router' ? 4 : 0) + (linkedIds.has(a.id) ? 2 : 0) + (a.online ? 1 : 0);
    const bPri = (b.role === 'router' ? 4 : 0) + (linkedIds.has(b.id) ? 2 : 0) + (b.online ? 1 : 0);
    return bPri - aPri;
  });
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

export function renderNodeCard(n, colIdx, { state, selId, showEvents, onSelectNode, attachItemMenu }) {
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
      onclick: () => onSelectNode(n.id),
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
    onclick: () => onSelectNode(n.id),
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

export function renderTopology(tiersBox, ctx) {
  const { state } = ctx;
  const tiers = [
    ['终端与算力工作站', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 0), state.links)],
    ['局域网核心 (网关 / NAS)', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) === 1), state.links)],
    ['云端出口与穿透节点', sortColumnNodes(state.nodes.filter((n) => effectiveTier(n) >= 2), state.links)],
  ];
  tiersBox.replaceChildren(...tiers.map(([title, list], i) =>
    h('div', { class: 'inf-tier-col', 'data-tier-col': String(i) },
      h('div', { class: 'inf-tier-title', title, text: title }),
      h('div', { class: 'inf-tier-cards' }, ...list.map((n) => renderNodeCard(n, i, ctx)))
    )
  ));
}

// All geometry is computed in "logical" coordinates where the tier axis runs along x. In the stacked (narrow) layout the
// tiers run top-to-bottom, so logical (x, y) maps to physical (y, x); the same routing code serves both orientations.
export function drawSvgLinks(svgCanvas, tiersBox, { state, selId, showEvents, onSelectNode }) {
  svgCanvas.replaceChildren();
  const baseR = tiersBox.getBoundingClientRect();
  if (!baseR.width || !tiersBox.offsetWidth) return;
  // Client rects are in screen px (they include the page-wide CSS zoom of the size setting); SVG user units are layout px.
  const z = baseR.width / tiersBox.offsetWidth || 1;
  const W = tiersBox.offsetWidth;
  const H = tiersBox.offsetHeight;
  svgCanvas.setAttribute('width', W);
  svgCanvas.setAttribute('height', H);
  svgCanvas.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const colEls = [...tiersBox.querySelectorAll('.inf-tier-col')];
  if (colEls.length < 2) return;
  const V = colEls[1].offsetTop >= colEls[0].offsetTop + colEls[0].offsetHeight - 2;
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
  const linesG = svgEl('g');
  const badgesG = svgEl('g');
  svgCanvas.append(linesG, badgesG);
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
    linesG.append(svgEl('path', {
      d, fill: 'none', stroke: color, 'stroke-opacity': strong ? 1 : 0.35,
      'stroke-width': isDown ? 2.4 : isRel ? 2 : 1.3, 'stroke-linecap': 'round',
      ...(standby ? { 'stroke-dasharray': '5 4' } : {}),
    }));
    for (const [px, py] of [phys(x1, y1), phys(x2, y2)]) {
      linesG.append(svgEl('circle', { cx: px, cy: py, r: 2.6, fill: color, 'fill-opacity': strong ? 1 : 0.4 }));
    }

    const [bx, by] = phys(mx, my);
    const { text, w } = it.fit;
    const g = svgEl('g', { class: 'inf-badge', opacity: strong ? 1 : 0.6 });
    const title = svgEl('title', {
      text: `${l.from} → ${l.to}：${l.label}${l.probeHost ? ` (${l.probeHost}:${l.probePort})` : ''}${l.ms != null ? ` · ${l.ms}ms` : isDown ? ' · 中断' : standby ? ' · 备用' : ''}`,
    });
    g.append(
      title,
      svgEl('rect', {
        x: Math.round((bx - w / 2) * 10) / 10, y: Math.round((by - BADGE_H / 2) * 10) / 10, width: Math.round(w), height: BADGE_H, rx: 3,
        fill: isDown ? '#ffe3e8' : '#fff', stroke: color, 'stroke-width': isRel ? 1.2 : 0.8,
      }),
      svgEl('text', {
        x: bx, y: by + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': BADGE_FONT_PX,
        'font-family': BADGE_FONT_FAMILY, fill: isDown ? '#a40e26' : '#1f2937', text,
      })
    );
    g.addEventListener('click', () => onSelectNode(selId === l.from ? l.to : l.from));
    badgesG.append(g);
  }
}
