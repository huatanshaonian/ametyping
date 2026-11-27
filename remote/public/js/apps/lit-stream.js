// 文献 › 速览流: high-density Twitter-style visual feed built on top of deep cards + kb_struct.sqlite
// + University / Lab / Team network view. Clicking any card jumps straight to the deep card or reader.
import { h } from '../util.js';
import { get, post, authors, STATUS } from './lit-api.js';
import { figUrl } from './lit-md.js';

export function mount(el, ctx) {
  let mode = 'stream'; // 'stream' | 'teams'
  let activeTeam = '';
  let activeTag = '';
  let onlyCards = false;
  let query = '';
  let loading = false;

  const qInput = h('input', {
    class: 'field',
    type: 'search',
    placeholder: '搜索标题、方法、高校/团队…',
    style: 'width:210px',
    onkeydown: (ev) => { if (ev.key === 'Enter') { query = qInput.value.trim(); refresh(); } },
  });
  const segStream = h('button', { class: 'lit-tab lf-seg on', type: 'button', text: '速览流', onclick: () => { mode = 'stream'; activeTeam = ''; refresh(); } });
  const segTeams = h('button', { class: 'lit-tab lf-seg', type: 'button', text: '高校与团队网', onclick: () => { mode = 'teams'; activeTeam = ''; refresh(); } });
  const onlyChk = h('input', { type: 'checkbox', onchange: () => { onlyCards = onlyChk.checked; refresh(); } });
  const onlyLbl = h('label', { style: 'display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer' }, onlyChk, '仅看有卡片');
  const extractBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: '补全团队信息 (10篇)',
    title: '从论文首页与元数据抽取大学/实验室/PI 简介并建立团队关联',
    onclick: async () => {
      extractBtn.disabled = true;
      st.textContent = '正在抽取大学与团队信息…';
      const r = await post('/api/lit/teams/extract', { limit: 10 });
      extractBtn.disabled = false;
      st.textContent = r && r.ok ? `已补全 ${r.extracted}/${r.processed} 篇团队信息` : ((r && r.msg) || '抽取失败');
      refresh();
    },
  });
  const st = h('span', { class: 'lit-st' });
  const filterBar = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 8px;align-items:center', hidden: true });
  const content = h('div', { style: 'padding:8px;overflow:auto;flex:1;max-width:860px;margin:0 auto;width:100%;box-sizing:border-box' });

  el.append(
    h('div', { class: 'lit-sub', style: 'flex-wrap:wrap;gap:6px' },
      h('span', { class: 'lf-segs' }, segStream, segTeams),
      qInput,
      h('button', { class: 'btn', type: 'button', text: '搜索', onclick: () => { query = qInput.value.trim(); refresh(); } }),
      onlyLbl,
      extractBtn,
      st),
    filterBar,
    content
  );

  function updateFilters() {
    const chips = [];
    if (activeTeam) {
      chips.push(h('button', { class: 'btn', type: 'button', text: `✕ 取消团队筛选`, onclick: () => { activeTeam = ''; refresh(); } }));
    }
    if (activeTag) {
      chips.push(h('button', { class: 'btn', type: 'button', text: `✕ #${activeTag}`, onclick: () => { activeTag = ''; refresh(); } }));
    }
    filterBar.hidden = !chips.length;
    filterBar.replaceChildren(...chips);
  }

  function teamBadge(t) {
    const label = [t.institution, t.lab || t.pi].filter(Boolean).join(' · ');
    return h('button', {
      type: 'button',
      class: 'btn',
      style: 'padding:1px 6px;font-size:11px;font-weight:bold',
      title: t.bio || label,
      text: '@' + label,
      onclick: (ev) => { ev.stopPropagation(); mode = 'stream'; activeTeam = t.id; refresh(); },
    });
  }

  function renderPost(item) {
    const statusLabel = item.cardStatus ? (STATUS[item.cardStatus] || item.cardStatus) : (item.verifiedRatio != null ? '证据表' : '');
    const header = h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px' },
      ...(item.teams && item.teams.length
        ? item.teams.map(teamBadge)
        : [h('span', { style: 'font-size:11px;color:#555;font-weight:bold', text: authors(item.authors) || '未提取团队' })]),
      item.venue || item.year ? h('span', { style: 'font-size:11px;color:#666', text: [item.venue, item.year].filter(Boolean).join(' · ') }) : null,
      statusLabel ? h('i', { class: 'tag ' + (item.cardStatus === 'deep' || item.cardStatus === 'reviewed' ? 'rv' : 'new'), text: statusLabel }) : null,
      item.starred ? h('span', { style: 'color:#b8860b;font-size:12px', text: '★' }) : null
    );

    const titleEl = h('div', {
      style: 'font-weight:bold;font-size:13px;margin-bottom:4px;cursor:pointer;color:#000080',
      text: item.title,
      onclick: () => ctx.openItem(item.key),
    });

    const summaryText = item.oneLine || item.keyResult || '';
    const bodyEl = summaryText ? h('div', { style: 'font-size:12px;line-height:1.5;margin-bottom:5px;color:#111' }, summaryText) : null;

    const resultsEl = item.results && item.results.length ? h('ul', { style: 'margin:0 0 6px 18px;padding:0;font-size:11.5px;line-height:1.45;color:#222' },
      ...item.results.map((r) => h('li', { text: r }))) : null;

    const doubtEl = item.doubt ? h('div', { style: 'font-size:11px;color:#7a3e00;background:#fff8e6;border-left:2px solid #d48806;padding:2px 6px;margin-bottom:6px' },
      h('b', { text: '局限/疑点：' }), h('span', { text: item.doubt })) : null;

    const mediaEl = item.cover ? h('div', { style: 'margin:6px 0;cursor:pointer', onclick: () => ctx.openItem(item.key) },
      h('img', { src: figUrl(item.cover), loading: 'lazy', alt: '', style: 'max-width:100%;max-height:240px;border:1px solid #808080;background:#fff;display:block' })) : null;

    const tagsEl = item.tags && item.tags.length ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px' },
      ...item.tags.map((tg) => h('button', {
        type: 'button',
        style: 'border:1px solid #999;background:#f0f0f0;font-size:11px;padding:1px 5px;cursor:pointer',
        text: '#' + tg,
        onclick: () => { activeTag = tg; mode = 'stream'; refresh(); },
      }))) : null;

    const actions = h('div', { class: 'gbtns', style: 'margin-top:4px' },
      h('button', { class: 'btn go', type: 'button', text: item.hasCard ? '打开深读卡' : '查看详情 / 生成深读卡', onclick: () => ctx.openItem(item.key) }),
      h('button', { class: 'btn', type: 'button', text: '并排读原文', onclick: () => ctx.openReader(item.key) }),
      !item.teams.length ? h('button', {
        class: 'btn',
        type: 'button',
        text: '识别团队',
        onclick: async (ev) => {
          ev.target.disabled = true;
          await post('/api/lit/teams/extract', { key: item.key });
          refresh();
        },
      }) : null
    );

    return h('article', {
      style: 'border:1px solid #808080;background:#fff;padding:10px 12px;margin-bottom:10px;box-shadow:inset 1px 1px 0 #fff, 1px 1px 0 #c0c0c0',
    }, header, titleEl, bodyEl, resultsEl, doubtEl, mediaEl, tagsEl, actions);
  }

  async function renderTeamHeader(teamId) {
    const d = await get('/api/lit/team?id=' + encodeURIComponent(teamId));
    if (!d || !d.ok || !d.team) return null;
    const t = d.team;
    const collabs = (d.collaborators || []).slice(0, 8);
    return h('div', { style: 'border:2px solid #000080;background:#eef3ff;padding:10px 12px;margin-bottom:12px' },
      h('div', { style: 'font-weight:bold;font-size:14px;margin-bottom:4px', text: `🏛️ ${t.institution}${t.lab ? ' · ' + t.lab : ''}${t.pi ? '（' + t.pi + '）' : ''}` }),
      t.bio ? h('div', { style: 'font-size:12px;margin-bottom:6px;line-height:1.45', text: t.bio }) : null,
      t.tags && t.tags.length ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px' },
        ...t.tags.map((tg) => h('span', { style: 'background:#fff;border:1px solid #808080;padding:1px 5px;font-size:11px', text: '#' + tg }))) : null,
      collabs.length ? h('div', { style: 'font-size:11px;color:#333;display:flex;flex-wrap:wrap;gap:6px;align-items:center' },
        h('b', { text: '合作网络：' }),
        ...collabs.map((c) => h('button', {
          class: 'btn',
          type: 'button',
          style: 'padding:1px 6px;font-size:11px',
          text: `${c.institution}${c.pi ? '·' + c.pi : ''} (${c.sharedPapers}篇)`,
          onclick: () => { activeTeam = c.id; refresh(); },
        }))) : null
    );
  }

  function renderTeamGraphSvg(nodes, edges, onPick) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs = {}, text = '') => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text) n.textContent = text;
      return n;
    };
    const topNodes = nodes.slice(0, 40);
    const idSet = new Set(topNodes.map((n) => n.id));
    const visEdges = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
    const W = 820, H = 360;
    const cx = W / 2, cy = H / 2;

    // Initial placement on concentric rings (highest paper count near center) + lightweight spring iterations
    const pos = new Map();
    topNodes.forEach((n, i) => {
      const ring = i < 8 ? 0.28 : i < 20 ? 0.58 : 0.86;
      const angle = (i * 2.39996) % (Math.PI * 2); // golden angle
      pos.set(n.id, { x: cx + Math.cos(angle) * (W * 0.42) * ring, y: cy + Math.sin(angle) * (H * 0.40) * ring, vx: 0, vy: 0 });
    });
    for (let iter = 0; iter < 55; iter++) {
      for (let i = 0; i < topNodes.length; i++) {
        const a = pos.get(topNodes[i].id);
        for (let j = i + 1; j < topNodes.length; j++) {
          const b = pos.get(topNodes[j].id);
          let dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 25;
          const f = 900 / d2;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      for (const e of visEdges) {
        const a = pos.get(e.from), b = pos.get(e.to);
        const dx = b.x - a.x, dy = b.y - a.y;
        const k = 0.025 * Math.min(3, e.weight);
        a.vx += dx * k; a.vy += dy * k; b.vx -= dx * k; b.vy -= dy * k;
      }
      for (const n of topNodes) {
        const p = pos.get(n.id);
        p.vx += (cx - p.x) * 0.008;
        p.vy += (cy - p.y) * 0.008;
        p.x = Math.max(54, Math.min(W - 54, p.x + Math.max(-12, Math.min(12, p.vx * 0.4))));
        p.y = Math.max(28, Math.min(H - 28, p.y + Math.max(-12, Math.min(12, p.vy * 0.4))));
        p.vx *= 0.6; p.vy *= 0.6;
      }
    }

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:340px;background:#fafcff;border:1px solid #808080;display:block;margin-bottom:10px' });
    const tip = h('div', { style: 'font-size:11px;color:#333;min-height:18px;margin-bottom:8px;padding:2px 6px;background:#f4f4f4;border:1px solid #ccc', text: '实线 = 跨团队合著，虚线 = 同校或共享方法；悬停高亮关联，点击进入团队主页（展示前 40 个活跃团队）' });

    const edgeEls = visEdges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      const isCo = !e.kind || e.kind === 'coauthor';
      const attrs = {
        x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
        stroke: isCo ? '#3b6fc4' : (e.kind === 'inst' ? '#7b9acc' : '#b8c4d8'),
        'stroke-width': isCo ? Math.min(5, 1.5 + e.weight * 0.9) : 1.1,
        'stroke-opacity': isCo ? '0.8' : '0.5',
      };
      if (!isCo) attrs['stroke-dasharray'] = e.kind === 'inst' ? '5,3' : '2,3';
      const line = svgEl('line', attrs);
      svg.appendChild(line);
      return { e, line, isCo };
    });

    const maxP = Math.max(1, ...topNodes.map((n) => n.paperCount || 1));
    for (const n of topNodes) {
      const p = pos.get(n.id);
      const r = 6 + Math.round(12 * Math.sqrt((n.paperCount || 1) / maxP));
      const g = svgEl('g', { style: 'cursor:pointer' });
      const circle = svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r, fill: (n.paperCount || 0) >= 3 ? '#1e4ea8' : '#4a7bd0', stroke: '#fff', 'stroke-width': 1.5 });
      const shortName = String(n.institution || '').replace(/University of |University|Institute of |Research Center/gi, '').trim().slice(0, 12) || n.institution.slice(0, 12);
      const label = svgEl('text', { x: p.x.toFixed(1), y: (p.y + r + 11).toFixed(1), 'text-anchor': 'middle', 'font-size': '10', fill: '#111' }, `${shortName}${n.pi ? '·' + n.pi.split(' ').pop() : ''}`);
      g.appendChild(circle);
      g.appendChild(label);
      g.addEventListener('mouseenter', () => {
        circle.setAttribute('fill', '#d9534f');
        for (const { e, line } of edgeEls) {
          const hit = e.from === n.id || e.to === n.id;
          line.setAttribute('stroke', hit ? '#d9534f' : '#c8d4e8');
          line.setAttribute('stroke-opacity', hit ? '0.95' : '0.25');
        }
        tip.textContent = `${n.institution}${n.lab ? ' · ' + n.lab : ''}${n.pi ? '（' + n.pi + '）' : ''} · ${n.paperCount || 0} 篇${n.bio ? ' — ' + n.bio : ''}`;
      });
      g.addEventListener('mouseleave', () => {
        circle.setAttribute('fill', (n.paperCount || 0) >= 3 ? '#1e4ea8' : '#4a7bd0');
        for (const { line } of edgeEls) { line.setAttribute('stroke', '#9ab0d8'); line.setAttribute('stroke-opacity', '0.65'); }
      });
      g.addEventListener('click', () => onPick(n.id));
      svg.appendChild(g);
    }
    return h('div', {}, svg, tip);
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    segStream.classList.toggle('on', mode === 'stream');
    segTeams.classList.toggle('on', mode === 'teams');
    updateFilters();
    try {
      if (mode === 'teams') {
        const g = await get('/api/lit/teams');
        const nodes = (g && g.nodes) || [];
        const edges = (g && g.edges) || [];
        st.textContent = `${nodes.length} 个大学/实验室团队，${edges.length} 条跨团队合作边`;
        if (!nodes.length) {
          content.replaceChildren(h('p', { class: 'lit-empty', text: '还没有提取团队信息。点击上方「补全团队信息」即可自动从论文首页识别大学、实验室与合作关系网。' }));
          return;
        }
        const graphEl = renderTeamGraphSvg(nodes, edges, (tid) => { mode = 'stream'; activeTeam = tid; refresh(); });
        const edgeMap = new Map();
        for (const e of edges) {
          if (!edgeMap.has(e.from)) edgeMap.set(e.from, []);
          if (!edgeMap.has(e.to)) edgeMap.set(e.to, []);
          edgeMap.get(e.from).push({ id: e.to, w: e.weight });
          edgeMap.get(e.to).push({ id: e.from, w: e.weight });
        }
        const byId = new Map(nodes.map((n) => [n.id, n]));
        content.replaceChildren(graphEl, ...nodes.map((t) => {
          const peers = (edgeMap.get(t.id) || []).slice(0, 5).map((p) => {
            const o = byId.get(p.id);
            return o ? `${o.institution}${o.pi ? '·' + o.pi : ''}(${p.w})` : '';
          }).filter(Boolean);
          return h('div', {
            style: 'border:1px solid #808080;background:#fff;padding:8px 10px;margin-bottom:8px;cursor:pointer',
            onclick: () => { mode = 'stream'; activeTeam = t.id; refresh(); },
          },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:3px' },
            h('b', { style: 'color:#000080;font-size:13px', text: `${t.institution}${t.lab ? ' · ' + t.lab : ''}${t.pi ? '（' + t.pi + '）' : ''}` }),
            h('span', { class: 'tag new', text: `${t.paperCount || 0} 篇` })),
          t.bio ? h('div', { style: 'font-size:12px;color:#222;margin-bottom:4px', text: t.bio }) : null,
          t.tags && t.tags.length ? h('div', { style: 'font-size:11px;color:#555;margin-bottom:3px', text: t.tags.map((x) => '#' + x).join('  ') }) : null,
          peers.length ? h('div', { style: 'font-size:11px;color:#444', text: '合作团队：' + peers.join('、') }) : null);
        }));
        return;
      }

      const qs = new URLSearchParams();
      if (activeTeam) qs.set('team', activeTeam);
      if (activeTag) qs.set('tag', activeTag);
      if (query) qs.set('q', query);
      if (onlyCards) qs.set('onlyCards', '1');
      const r = await get('/api/lit/stream?' + qs.toString());
      const items = (r && r.items) || [];
      st.textContent = `共 ${r ? r.total : 0} 篇（展示 ${items.length} 条）`;
      const parts = [];
      if (activeTeam) {
        const th = await renderTeamHeader(activeTeam);
        if (th) parts.push(th);
      }
      if (!items.length) {
        parts.push(h('p', { class: 'lit-empty', text: '没有符合条件的速览条目。' }));
      } else {
        parts.push(...items.map(renderPost));
      }
      content.replaceChildren(...parts);
    } finally {
      loading = false;
    }
  }

  return { refresh, onLit: (w) => { if (w === 'stream' || w === 'evidence' || w.startsWith('card:')) refresh(); } };
}
