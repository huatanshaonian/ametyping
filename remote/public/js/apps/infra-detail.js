// Infrastructure node detail pane & event log view (used by infra.js).
import { h, icon, ago, fmtUptime, fmtBytes } from '../util.js';
import * as net from '../net.js';
import { confirmBox, askText } from '../dialog.js';
import { ROLE_NAMES, ROLE_ICONS } from './infra-topo.js';

// the last one-click upgrade of a container (shown for a day, or while it runs / when it went wrong)
const UPGRADE_NOTE = {
  running: ['proxy', '升级中'],
  latest: ['ok', '已是最新'],
  done: ['ok', '已升级'],
  rolledback: ['err', '升级失败·已回退'],
  failed: ['err', '升级失败'],
};

function upgradeNote(c) {
  const u = c.upgrade;
  if (!u || !UPGRADE_NOTE[u.state]) return null;
  const bad = u.state === 'failed' || u.state === 'rolledback';
  if (!bad && u.state !== 'running' && Date.now() - (u.at || 0) > 86400e3) return null;
  const [cls, txt] = UPGRADE_NOTE[u.state];
  const when = u.at ? new Date(u.at).toLocaleString('zh-CN', { hour12: false }) : '';
  return h('span', {
    class: `inf-pill ${cls}`,
    text: txt,
    title: `${u.msg || ''}${u.from && u.to && u.from !== u.to ? `\n${u.from} → ${u.to}` : ''}${when ? `\n${when}` : ''}`,
  });
}

export function renderEventsView(detailPane, { state, onCloseEvents }) {
  const evts = state.events || [];
  detailPane.replaceChildren(
    h('div', { class: 'inf-det-head' },
      h('div', {},
        h('div', { class: 'inf-det-title', text: '📋 节点状态变更与远程控制流水' }),
        h('div', { class: 'inf-det-sub', text: '记录关键服务启停、Docker 容器状态变化、节点上下线及手动控制操作' })
      ),
      h('button', { class: 'btn', type: 'button', text: '返回节点详情', onclick: onCloseEvents })
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

export function renderDetailPane(detailPane, ctx) {
  const { state, selId, showEvents, runControl, togglePin, attachItemMenu, openNodeDialog, openLinkDialog, fetchState } = ctx;
  if (showEvents) return renderEventsView(detailPane, ctx);
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
    const upgrading = !!(c.upgrade && c.upgrade.state === 'running');
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
      upgradeNote(c),
      h('div', { class: 'inf-row-acts' },
        c.compose ? h('button', {
          class: 'btn',
          type: 'button',
          text: upgrading ? '升级中…' : '升级',
          disabled: upgrading,
          title: '拉取新镜像并按 compose 文件重建（设置和数据保留）；新版本起不来会自动回退',
          onclick: () => runControl(n.id, 'docker', c.name, 'upgrade', `升级容器 ${c.name}（拉取新镜像后重建，期间服务会中断片刻）`),
        }) : null,
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

  const sections = [
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
    ),
  ].filter(Boolean);

  detailPane.replaceChildren(...sections);
}
