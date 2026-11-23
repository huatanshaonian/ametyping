// Desktop sticky widget: 待我介入 / 审批便签 (sits beside 重要计划 & Magpie 用量; pops above windows when permissions or watchdog alerts need attention)
import { h, icon, prefs } from '../util.js';
import * as net from '../net.js';
import * as mesh from '../mesh.js';
import * as dashboard from './dashboard.js';
import * as projects from './projects.js';

function permBrief(p) {
  const tool = String((p && p.tool) || '操作');
  let detail = '';
  if (p && p.input) {
    try {
      const obj = typeof p.input === 'string' ? JSON.parse(p.input) : p.input;
      detail = obj.command || obj.file_path || obj.path || obj.description || obj.pattern || '';
    } catch {
      detail = String(p.input || '');
    }
  }
  const clean = String(detail || '').replace(/\s+/g, ' ').trim();
  return clean ? `${tool}: ${clean.slice(0, 72)}${clean.length > 72 ? '…' : ''}` : tool;
}

export function initWidget(desktop) {
  if (document.getElementById('approvewidget')) return;
  let collapsed = prefs.get('approve.collapsed', false);
  let dismissedSig = ''; // user clicked "先收到底层" for this exact set of pending IDs
  const busyPerms = new Set();

  const rows = h('div', { class: 'mpw-rows apw-rows' });
  const status = h('small', { class: 'mpw-status', text: '暂无待审批项', role: 'status' });
  const title = h('span', { class: 'mpw-title', text: '待我介入' });
  const sinkBtn = h('button', {
    class: 'mpw-fold apw-sink',
    type: 'button',
    title: '先收回到桌面底层',
    text: '↓',
    hidden: true,
    onclick: () => {
      dismissedSig = currentSig();
      render();
    },
  });
  const foldBtn = h('button', { class: 'mpw-fold', type: 'button', title: '收起 / 展开', 'aria-label': '收起或展开待我介入便签' });
  const root = h('section', { id: 'approvewidget', class: 'mp-widget ap-widget', 'aria-label': '待我介入与权限审批便签' },
    h('div', { class: 'mpw-head apw-head' }, h('img', { src: icon('msg_information', true), alt: '' }), title, sinkBtn, foldBtn),
    h('div', { class: 'mpw-body apw-body' }, rows, status)
  );

  function collectItems() {
    const items = [];
    for (const m of net.state.sessions || []) {
      for (const s of m.sessions || []) {
        const perms = Array.isArray(s.perms) ? s.perms : [];
        for (const p of perms) {
          items.push({
            kind: 'perm',
            sig: `p:${m.machine}|${s.id}|${p.id}`,
            machine: m.machine,
            sessionId: s.id,
            label: s.label || s.id,
            perm: p,
          });
        }
      }
    }
    for (const proj of mesh.projects() || []) {
      for (const n of proj.nodes || []) {
        if (n.archived) continue;
        if (n.watchdogAlert) {
          items.push({
            kind: 'alert',
            sig: `a:${proj.id}|${n.id}|${n.watchdogAlert.code || ''}`,
            projectId: proj.id,
            projectName: proj.name,
            node: n,
            alert: n.watchdogAlert,
          });
        }
      }
    }
    return items;
  }

  let latestSig = '';
  function currentSig() { return latestSig; }

  async function decide(it, choice) {
    const k = it.sig;
    if (busyPerms.has(k)) return;
    busyPerms.add(k);
    render();
    try {
      const r = await net.act({ t: 'decide', machine: it.machine, id: it.sessionId, perm: it.perm.id, choice });
      if (!r || !r.ok) status.textContent = (r && r.msg) || '审批发送失败';
    } finally {
      busyPerms.delete(k);
      render();
    }
  }

  function applyFold() {
    root.classList.toggle('collapsed', collapsed);
    foldBtn.textContent = collapsed ? '＋' : '－';
    foldBtn.setAttribute('aria-expanded', String(!collapsed));
  }
  foldBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    prefs.set('approve.collapsed', collapsed);
    applyFold();
  });

  function render() {
    const items = collectItems();
    latestSig = items.map((x) => x.sig).sort().join(',');
    if (!items.length) dismissedSig = '';

    const urgent = items.length > 0 && latestSig !== dismissedSig;
    root.classList.toggle('urgent', urgent);
    sinkBtn.hidden = !urgent;
    if (urgent && collapsed) {
      collapsed = false;
      applyFold();
    }
    title.textContent = items.length ? `待我介入 (${items.length})` : '待我介入';

    if (!items.length) {
      rows.replaceChildren(h('div', { class: 'mpw-empty', text: '全部畅通，暂无权限确认或告警。' }));
      status.textContent = '平时静驻桌面底层，有审批时自动置顶';
      return;
    }

    const els = items.map((it) => {
      if (it.kind === 'perm') {
        const busy = busyPerms.has(it.sig);
        const canAlways = Boolean(it.perm && it.perm.always);
        return h('div', { class: 'apw-card perm' },
          h('div', { class: 'apw-meta' },
            h('span', { class: 'apw-tag perm', text: '权限' }),
            h('b', { class: 'apw-name', text: it.label }),
            h('small', { text: it.machine })
          ),
          h('div', { class: 'apw-desc', text: permBrief(it.perm) }),
          h('div', { class: 'apw-acts' },
            h('button', { class: 'btn go', type: 'button', disabled: busy, text: '允许', onclick: () => decide(it, 'allow') }),
            canAlways ? h('button', { class: 'btn', type: 'button', disabled: busy, text: '总是', onclick: () => decide(it, 'always') }) : null,
            h('button', { class: 'btn no', type: 'button', disabled: busy, text: '拒绝', onclick: () => decide(it, 'deny') }),
            h('button', { class: 'btn apw-jump', type: 'button', text: '看板', onclick: () => dashboard.openSession(it.machine, it.sessionId) })
          )
        );
      }
      return h('div', { class: 'apw-card alert' },
        h('div', { class: 'apw-meta' },
          h('span', { class: 'apw-tag alert', text: '告警' }),
          h('b', { class: 'apw-name', text: it.node.alias || it.node.id }),
          h('small', { text: it.projectName })
        ),
        h('div', { class: 'apw-desc', text: `${it.alert.label || '看门狗告警'}${it.alert.detail ? ' · ' + it.alert.detail : ''}` }),
        h('div', { class: 'apw-acts' },
          h('button', { class: 'btn go', type: 'button', text: '看拓扑', onclick: () => projects.open(it.projectId) }),
          it.node.sessionId ? h('button', { class: 'btn', type: 'button', text: '跳看板', onclick: () => dashboard.openSession(it.node.machine, it.node.sessionId) }) : null
        )
      );
    });

    rows.replaceChildren(...els);
    status.textContent = urgent
      ? `共 ${items.length} 项待处理 · 可直接审批或点 ↓ 先收到底层`
      : `共 ${items.length} 项待处理（已手动收到底层）`;
  }

  applyFold();
  desktop.append(root);
  render();
  net.on('sessions', render);
  mesh.on(render);
}
