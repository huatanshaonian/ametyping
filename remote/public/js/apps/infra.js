// 网络与设备 (Infrastructure & Network Topology Monitor):
//   - Visualizes workstations, OpenWrt router, Synology NAS, and cloud servers (AWS/GCP) with live SVG interconnect links.
//   - Event-driven low-traffic monitoring: 60s silent heartbeat when closed, 10s fast refresh while this window is open.
//   - Remote control (restart/start/stop systemd/init.d services, Docker containers, NAS egress.sh, OpenWrt sing-box retest)
//     protected by TOTP step-up authentication.
import { h, icon, svgEl } from '../util.js';
import * as net from '../net.js';
import * as wm from '../wm.js';
import { confirmBox } from '../dialog.js';
import * as ctxmenu from '../ctxmenu.js';
import * as computers from './computers.js';
import { createComputeView } from './infra-compute.js';
import { renderTopology, drawSvgLinks } from './infra-topo.js';
import { renderDetailPane } from './infra-detail.js';
import { openNodeDialog, openLinkDialog } from './infra-dialogs.js';

let inst = null;

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

function mount(initialNodeId) {
  let state = { nodes: [], links: [], events: [], fast: false, intervalSec: 60 };
  let selId = initialNodeId || 'nas';
  let showEvents = false;
  let activeTab = 'topo'; // 'topo' | 'compute'
  let destroyed = false;
  let fetchSeq = 0;

  const topBar = h('div', { class: 'inf-bar' });
  const svgCanvas = svgEl('svg', { class: 'inf-svg' });
  const tiersBox = h('div', { class: 'inf-tiers' });
  // the svg shares the stage's origin with the tiers grid, so link geometry is measured relative to tiersBox and scrolls with it
  const stage = h('div', { class: 'inf-stage' }, svgCanvas, tiersBox);
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
  const computeView = createComputeView({ say });
  computeView.root.style.display = 'none';
  const root = h('div', { class: 'inf-app' }, topBar, body, computeView.root, statusLine);

  function say(msg) {
    statusLine.replaceChildren(
      h('span', { text: msg || '就绪' }),
      h('span', { text: `通信模式：${state.fast ? '实时巡检 (10s)' : '事件驱动低频心跳 (60s)'}` })
    );
  }

  async function fetchState() {
    const seq = ++fetchSeq;
    const d = await net.getJson('/api/infra/state');
    if (destroyed || seq !== fetchSeq) return;
    if (d && d.ok) {
      state = d;
      if (!state.nodes.some((n) => n.id === selId) && state.nodes.length) {
        selId = state.nodes[0].id;
      }
      render();
    }
  }

  async function triggerRefresh() {
    say('正在向所有在线节点请求最新状态与链路测速…');
    const seq = ++fetchSeq;
    try {
      const r = await net.post('/api/infra/refresh', {});
      if (destroyed || seq !== fetchSeq) return;
      if (r && r.ok) {
        state = r;
        render();
        say('已刷新全部节点与链路状态');
      }
    } catch {}
  }

  async function runControl(nodeId, kind, target, op, label) {
    if (!(await confirmBox(`确定要在「${nodeId}」上执行 ${label} 吗？`, { title: '远程服务控制' }))) return;
    if (destroyed) return;
    say(`正在下发指令：${label}…`);
    const r = await net.post('/api/infra/control', { nodeId, kind, target, op });
    if (destroyed) return;
    say(r.ok ? `✓ ${r.msg || '执行成功'}` : `✗ ${r.msg || '执行失败'}`);
    await fetchState();
  }

  async function togglePin(nodeId, item) {
    const r = await net.post('/api/infra/pin', { nodeId, item });
    if (!destroyed && r && r.ok) await fetchState();
  }

  async function toggleMute(nodeId, item, mute) {
    const r = await net.post('/api/infra/pin', { nodeId, item, mute });
    if (!destroyed && r && r.ok) {
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

  function selectNode(id) {
    selId = id;
    showEvents = false;
    render();
  }

  function openNode(existing) {
    openNodeDialog(existing, {
      onSelectNode: (id) => { selId = id; },
      fetchState,
    });
  }

  function openLink(existing) {
    openLinkDialog(existing, { nodes: state.nodes, fetchState });
  }

  function renderTopBar() {
    const onlineCnt = state.nodes.filter((n) => n.online).length;
    const totalSvcs = state.nodes.reduce((s, n) => s + (n.services || []).filter((x) => x.state === 'running').length, 0);
    const totalCnts = state.nodes.reduce((s, n) => s + (n.containers || []).filter((x) => x.state === 'running').length, 0);
    const totalAlerts = state.nodes.reduce((s, n) => s + (n.alertCount || 0), 0);

    topBar.replaceChildren(
      h('button', {
        class: `btn ${activeTab === 'topo' ? 'go' : ''}`,
        type: 'button',
        text: '拓扑与服务',
        onclick: () => { activeTab = 'topo'; render(); scheduleDraw(); },
      }),
      h('button', {
        class: `btn ${activeTab === 'compute' ? 'go' : ''}`,
        type: 'button',
        text: '算力与作业 (Mini-Slurm)',
        onclick: () => { activeTab = 'compute'; render(); computeView.refresh(); },
      }),
      h('span', { class: `inf-stat-pill ${onlineCnt > 0 ? 'ok' : ''}`, text: `在线设备 ${onlineCnt} / ${state.nodes.length}` }),
      h('span', { class: 'inf-stat-pill', text: `运行服务 ${totalSvcs}` }),
      h('span', { class: 'inf-stat-pill', text: `Docker 容器 ${totalCnts}` }),
      totalAlerts > 0
        ? h('span', { class: 'inf-stat-pill err', text: `⚠️ 异常告警 ${totalAlerts}` })
        : h('span', { class: 'inf-stat-pill ok', text: '✓ 核心服务正常' }),
      h('div', { class: 'inf-bar-right' },
        h('button', { class: 'btn', type: 'button', text: '🔄 立即刷新', onclick: triggerRefresh }),
        h('button', { class: 'btn', type: 'button', text: '＋ 添加节点', onclick: () => openNode(null) }),
        h('button', { class: 'btn', type: 'button', text: '🔗 添加互联链路', onclick: () => openLink(null) }),
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

  let drawQueued = false;
  function scheduleDraw() {
    if (drawQueued || destroyed) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      if (destroyed) return;
      drawSvgLinks(svgCanvas, tiersBox, { state, selId, showEvents, onSelectNode: selectNode });
    });
  }

  function renderDetail() {
    renderDetailPane(detailPane, {
      state,
      selId,
      showEvents,
      onCloseEvents: () => { showEvents = false; renderDetail(); },
      runControl,
      togglePin,
      attachItemMenu,
      openNodeDialog: openNode,
      openLinkDialog: openLink,
      fetchState,
    });
  }

  function render() {
    renderTopBar();
    body.style.display = activeTab === 'topo' ? '' : 'none';
    computeView.root.style.display = activeTab === 'compute' ? '' : 'none';
    if (activeTab === 'topo') {
      renderTopology(tiersBox, { state, selId, showEvents, onSelectNode: selectNode, attachItemMenu });
      scheduleDraw();
      renderDetail();
    }
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
  const offMesh = net.on('mesh', () => { if (activeTab === 'compute') computeView.refresh(); });
  fetchState();

  return {
    root,
    select(id) { selId = id; showEvents = false; render(); },
    destroy() {
      destroyed = true;
      clearInterval(watchTimer);
      ro.disconnect();
      removeEventListener('resize', scheduleDraw);
      offInfra();
      offSess();
      offMesh();
      if (computeView.destroy) computeView.destroy();
      fetch('/api/infra/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' }).catch(() => {});
    },
  };
}
