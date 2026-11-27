// Node cards, Workspaces/VFS tree, File Transfers, and Triggers/Events tabs for AmeMesh Projects (used by projects.js).
import { h, icon, ago } from '../util.js';
import * as mesh from '../mesh.js';
import * as catalog from '../fs-catalog.js';
import { size } from '../filetypes.js';
import { confirmBox, askText } from '../dialog.js';
import { openNoteDialog, open as openExplorer } from './explorer.js';
import * as dashboard from './dashboard.js';
import { ROLE_NAMES, REVIEW_NAMES, TOPO_EDGE_TYPE_NAMES } from './proj-const.js';

// 节点详情卡片里的静态连线：每条出/入边一个小 × 用于断开
function nodeEdgeRow(proj, n, { say }) {
  const nodes = proj.nodes || [];
  const mine = (proj.edges || []).filter((e) => e.from === n.id || e.to === n.id);
  if (!mine.length) return null;
  return h('div', { class: 'pm-node-edges' },
    h('span', { class: 'pm-node-edges-hd', text: '连线：' }),
    ...mine.map((e) => {
      const out = e.from === n.id;
      const other = nodes.find((x) => x.id === (out ? e.to : e.from));
      const type = e.type || 'master-worker';
      return h('span', { class: `pm-node-edge t-${type}`, title: `${out ? '出边' : '入边'} · ${TOPO_EDGE_TYPE_NAMES[type] || type}` },
        h('span', { text: `${out ? '→' : '←'} ${other ? (other.alias || other.label || other.id) : (out ? e.to : e.from)}` }),
        h('small', { text: TOPO_EDGE_TYPE_NAMES[type] || type }),
        h('button', { class: 'pm-edge-del', type: 'button', title: '断开连线', text: '×', onclick: async (ev) => {
          ev.stopPropagation();
          const r = await mesh.removeEdge(proj.id, e.from, e.to);
          if (r && r.ok === false) say(r.msg || '断开连线失败');
        } })
      );
    })
  );
}

export function renderNodeCard(proj, n, { say, openSendDialog }) {
  const [rCls, rText] = REVIEW_NAMES[n.reviewStatus] || ['run', n.reviewStatus || '就绪'];
  const inboxCount = Array.isArray(n.inbox) ? n.inbox.length : 0;
  const hasWorktree = n.workspaceMode === 'worktree' || !!n.worktreeBranch;
  const wtBranch = n.worktreeBranch || '隔离分支';
  return h('div', { class: `pm-node role-${n.role}` },
    h('div', { class: 'pm-node-top' },
      h('span', { class: `pm-role-tag ${n.role}`, text: ROLE_NAMES[n.role] || n.role }),
      h('b', { class: 'pm-node-name', text: n.alias || n.label || n.id }),
      h('span', { class: 'pm-node-mach', text: `${n.machine} · ${n.tool || 'claude'}${n.model ? ':' + n.model : ''}` }),
      hasWorktree ? h('span', { class: 'pm-wt-badge', title: n.worktreePath || '', text: `worktree: ${wtBranch}` }) : null,
      n.archived ? h('span', { class: 'pm-rev-badge done', text: '已归档 (保留痕迹)' }) : h('span', { class: `pm-rev-badge ${rCls}`, text: rText }),
      n.asking ? h('button', {
        type: 'button',
        class: 'pm-badge err',
        style: 'cursor:pointer;border:1px solid currentColor;',
        title: '点击前往糖糖看板查看并确认该会话的权限弹窗',
        onclick: (e) => {
          e.stopPropagation();
          if (n.machine && n.sessionId) dashboard.openSession(n.machine, n.sessionId);
        },
        text: '等你确认权限 (点此前往)',
      }) : null
    ),
    n.cwd ? h('div', { class: 'pm-node-cwd', text: `📁 目录：${n.cwd}` }) : null,
    n.watchdogAlert ? h('div', { class: 'pm-node-wd' },
      h('span', { class: 'pm-wd-badge', text: `⚠️ 看门狗告警：${n.watchdogAlert.label}${n.watchdogAlert.detail ? ' (' + n.watchdogAlert.detail + ')' : ''}` }),
      h('button', { class: 'btn xact', type: 'button', text: '忽略告警', onclick: async () => {
        await mesh.dismissWatchdog(proj.id, n.id);
      } })
    ) : null,
    h('div', { class: 'pm-contract' },
      h('div', {}, h('b', { text: '目标 (Goal)：' }), h('span', { text: n.goal || '（未设定明确目标）' })),
      h('div', {}, h('b', { text: '停机检视边界 (Stop Gate)：' }), h('span', { text: n.stopCondition || '（完成本轮或遇阻塞即停）' }))
    ),
    n.lastReport ? h('div', { class: 'pm-node-rep', text: `📋 最新汇报：${n.lastReport}` }) : null,
    n.lastAct ? h('div', { class: 'pm-node-act', text: `实时状态 [${n.liveState}]：${n.lastAct}` }) : null,
    inboxCount ? h('div', { class: 'pm-node-inbox' },
      h('span', { text: `📥 收件箱有 ${inboxCount} 条待投递消息` }),
      h('button', { class: 'btn xact', type: 'button', text: '立即唤醒投递', onclick: async () => {
        say('正在唤醒并投递收件箱消息…');
        const r = await mesh.flushInbox(proj.id, n.id);
        say(r.msg || (r.ok ? '已投递' : '投递失败'));
      } })
    ) : null,
    nodeEdgeRow(proj, n, { say }),
    h('div', { class: 'pm-node-btns' },
      h('button', { class: 'btn go', type: 'button', text: '下发指令 / 改契约', onclick: () => openSendDialog(proj, n) }),
      n.reviewStatus === 'waiting_review' ? h('button', { class: 'btn', type: 'button', text: '静默批准结单', onclick: async () => {
        const r = await mesh.reviewNode(proj.id, n.id, 'approve');
        say(r.msg || (r.ok ? '已批准结单' : '操作失败'));
      } }) : null,
      n.reviewStatus === 'waiting_review' ? h('button', { class: 'btn', type: 'button', text: '✓ 批准检视继续', onclick: () => openSendDialog(proj, n, '检视通过，请继续下一阶段任务。') }) : null,
      !n.archived && n.role !== 'master' ? h('button', { class: 'btn', type: 'button', title: '停止唤醒与看门狗巡检，但永久保留在拓扑图和黑板历史痕迹中', text: '归档退役', onclick: async () => {
        const closeTerm = await confirmBox(
          `是否同时向「${n.alias || n.id}」发送 /exit 优雅退出该会话？`,
          {
            title: '归档退役节点',
            ok: '归档并退出会话',
            cancel: '仅归档（保留窗口）',
          }
        );
        const r = await mesh.reviewNode(proj.id, n.id, 'archive', '', closeTerm);
        say(r.msg || (r.ok ? '节点已归档退役' : '归档失败'));
      } }) : null,
      n.sessionId ? h('button', { class: 'btn', type: 'button', text: '在糖糖看板打开对话', onclick: () => dashboard.openSession(n.machine, n.sessionId) }) : null,
      h('label', { class: 'pm-chk', title: '当该会话已关闭时，收到消息是否自动在后台或终端唤醒续聊' },
        h('input', {
          type: 'checkbox',
          checked: n.autoResumeClosed !== false,
          onchange: (e) => mesh.upsertNode(proj.id, { id: n.id, autoResumeClosed: e.target.checked }),
        }),
        '关闭时自动唤醒'
      ),
      h('button', { class: 'btn no', type: 'button', text: '移除', onclick: async () => {
        if (n.workspaceMode === 'worktree' && n.worktreePath) {
          say('正在检查节点工作树分支状态…');
          const wt = await mesh.checkWorktree(proj.id, n.id);
          const dirty = !!(wt && wt.dirty);
          const unmergedCommits = Number(wt && wt.unmergedCommits) || 0;
          if (wt && wt.ok === false) {
            const ok = await confirmBox(`无法检查节点「${n.alias || n.id}」工作树状态（${wt.msg || '目标节点可能离线'}）。确定仍要从项目拓扑中移除节点吗？`, { danger: true });
            if (!ok) return;
            await mesh.removeNode(proj.id, n.id);
            return;
          }
          if (dirty || unmergedCommits > 0) {
            const ok = await confirmBox(
              `该节点工作树分支「${n.worktreeBranch || (wt && wt.branch) || '隔离分支'}」存在未提交改动或 ${unmergedCommits} 个未合并提交。建议先合并分支再删除；确定要移除节点并保留/清理工作树吗？`,
              { title: '未合并工作树警告', ok: '继续移除', danger: true }
            );
            if (!ok) return;
            const clean = await confirmBox(
              `是否同时强制清理工作树目录与分支「${n.worktreePath}」？（选「保留工作树」可稍后手动合并）`,
              { title: '清理工作树', ok: '强制清理', cancel: '保留工作树', danger: true }
            );
            if (clean) {
              const wr = await mesh.removeWorktree(proj.id, n.id, true);
              if (!wr || !wr.ok) say((wr && wr.msg) || '清理工作树失败，将继续移除拓扑节点');
            }
            await mesh.removeNode(proj.id, n.id);
            say(clean ? '已清理工作树并移除节点' : '已移除节点（工作树目录已保留）');
            return;
          }
          const ok = await confirmBox(`从项目拓扑中移除节点「${n.alias || n.id}」？（不会删除原对话记录）`, { danger: true });
          if (!ok) return;
          const clean = await confirmBox(
            `工作树分支「${n.worktreeBranch || '隔离分支'}」无未提交改动或未合并提交，是否同时清理工作树目录？`,
            { title: '清理工作树', ok: '清理工作树', cancel: '保留目录' }
          );
          if (clean) {
            const wr = await mesh.removeWorktree(proj.id, n.id, false);
            if (!wr || !wr.ok) say((wr && wr.msg) || '清理工作树失败，将继续移除拓扑节点');
          }
          await mesh.removeNode(proj.id, n.id);
          say(clean ? '已清理工作树并移除节点' : '已移除节点');
          return;
        }
        if (await confirmBox(`从项目拓扑中移除节点「${n.alias || n.id}」？（不会删除原对话记录）`, { danger: true })) {
          await mesh.removeNode(proj.id, n.id);
        }
      } })
    )
  );
}

function renderSnapshotTree(machine, rootPath, snap) {
  if (!snap || !Array.isArray(snap.tree)) {
    return h('div', { class: 'pm-tree-box', text: '群晖尚无该目录的结构树快照，请点击「刷新树」（需目标电脑在线）。' });
  }
  function buildNodes(items) {
    return h('ul', { class: 'pm-tree-ul' }, ...items.map((it) =>
      h('li', { class: 'pm-tree-li' },
        h('span', { class: it.dir ? 'pm-tree-dir' : 'pm-tree-file', text: (it.dir ? '📁 ' : '📄 ') + it.name }),
        !it.dir ? h('small', { text: ` (${size(it.size)})` }) : null,
        it.skipped ? h('small', { class: 'pm-tree-skip', text: ' [已折叠依赖/构建目录]' }) : null,
        it.children && it.children.length ? buildNodes(it.children) : null
      )
    ));
  }
  return h('div', { class: 'pm-tree-box' },
    h('div', { class: 'pm-tree-meta', text: `快照时间：${ago(snap.scannedAt)} · 共记录 ${snap.count} 个条目${snap.truncated ? '（已截断）' : ''}` }),
    snap.tree.length ? buildNodes(snap.tree) : h('div', { text: '（空文件夹）' })
  );
}

export function renderVfsTab(mainBody, proj, { say, expandedTreeKey, onToggleTreeKey, openAddWorkspaceDialog, openManualWorkspaceDialog }) {
  const allCat = catalog.list();
  const wsList = proj.workspaces || [];

  const addBar = h('div', { class: 'pm-act-bar' },
    h('button', { class: 'btn go', type: 'button', text: '＋ 从已备注目录添加授权工作区…', onclick: () => openAddWorkspaceDialog(proj, allCat) }),
    h('button', { class: 'btn', type: 'button', text: '＋ 手动输入跨机路径授权…', onclick: () => openManualWorkspaceDialog(proj) }),
    h('span', { class: 'pm-hint', text: '说明：此处汇总本项目散落在各台电脑上的代码分支（Git Worktree）与数据目录，作为 Agent 跨机派活的访问边界；点「展开结构树」无需拉取实际文件即可查看目录前 3 层结构与剩余空间。' })
  );

  const rows = wsList.map((w) => {
    const key = `${w.machine}|${w.path}`;
    const isExp = expandedTreeKey === key;
    const snap = w.snapshot;
    const gitBranch = (snap && snap.gitBranch) || w.branch || '';
    return h('div', { class: 'pm-ws-card' },
      h('div', { class: 'pm-ws-head' },
        h('img', { src: icon('folder_tag', true), alt: '' }),
        h('b', { text: `${w.machine} : ${w.path}` }),
        w.tag ? h('span', { class: 'xtag', text: w.tagLabel || w.tag }) : null,
        h('select', {
          class: 'field pm-ws-mode',
          onchange: async (e) => {
            const next = wsList.map((x) => (x.machine === w.machine && x.path === w.path ? { ...x, mode: e.target.value } : x));
            await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: next });
          },
        },
          h('option', { value: 'rw', text: '读写授权 (RW)', selected: w.mode !== 'ro' }),
          h('option', { value: 'ro', text: '只读参考 (RO)', selected: w.mode === 'ro' })
        ),
        snap && snap.freeBytes != null ? h('span', { class: 'pm-ws-free', text: `可用空间: ${size(snap.freeBytes)}` }) : null,
        gitBranch ? h('span', { class: 'pm-ws-git', text: `Git: ${gitBranch}` }) : null,
        h('div', { class: 'pm-ws-actions' },
          h('button', { class: 'btn', type: 'button', text: isExp ? '▾ 收起结构树' : '▸ 展开结构树', onclick: () => onToggleTreeKey(isExp ? null : key) }),
          h('button', { class: 'btn', type: 'button', text: '刷新树', onclick: async () => {
            say(`正在向 ${w.machine} 扫描同步 ${w.path} 的目录结构…`);
            const r = await catalog.syncTree(w.machine, w.path);
            await mesh.load();
            say(r.ok ? '目录结构树已更新' : (r.msg || '同步失败'));
          } }),
          h('button', { class: 'btn', type: 'button', text: '编辑备注', onclick: async () => {
            await openNoteDialog(w.machine, w.path);
            await mesh.load();
          } }),
          h('button', { class: 'btn', type: 'button', text: '在我的电脑打开', onclick: () => openExplorer(w.machine, w.path) }),
          h('button', { class: 'btn no', type: 'button', text: '移除', onclick: async () => {
            const next = wsList.filter((x) => !(x.machine === w.machine && x.path === w.path));
            await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: next });
          } })
        )
      ),
      h('div', { class: 'pm-ws-notes' },
        h('div', {}, h('b', { text: '我的备注：' }), h('span', { text: w.userNote || '（未填，点右侧「编辑备注」添加）' })),
        h('div', {}, h('b', { text: 'AI 备注：' }), h('span', { text: w.aiNote || '（AI 尚未在此目录留下备注）' }))
      ),
      isExp ? renderSnapshotTree(w.machine, w.path, snap) : null
    );
  });

  // Fold other annotated folders in NAS catalog not yet bound to this project so they don't clutter the view
  const unbound = allCat.filter((c) => !wsList.some((w) => w.machine === c.machine && w.path.replace(/\\/g, '/').toLowerCase() === c.path.replace(/\\/g, '/').toLowerCase()));
  const unboundBox = unbound.length ? h('details', { class: 'pm-unbound-sec' },
    h('summary', { class: 'pm-sec-title', style: 'cursor:pointer', text: `查看群晖上登记的其他非本项目文件夹（共 ${unbound.length} 个，可按需加入本项目）` }),
    ...unbound.map((c) => h('div', { class: 'pm-unbound-row' },
      h('span', { class: 'xtag', text: c.tagLabel || c.tag || '目录' }),
      h('b', { text: `${c.machine} : ${c.path}` }),
      h('span', { class: 'pm-unbound-note', text: c.userNote || c.aiNote || '' }),
      h('button', { class: 'btn', type: 'button', text: '＋ 加入项目 (读写)', onclick: async () => {
        const next = [...wsList, { machine: c.machine, path: c.path, mode: 'rw', tag: c.tag }];
        await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: next });
      } })
    ))
  ) : null;

  mainBody.replaceChildren(
    ...[
      addBar,
      rows.length ? h('div', { class: 'pm-ws-list' }, ...rows) : h('div', { class: 'pm-empty', text: '尚未给该项目分配专属文件夹。' }),
      unboundBox,
    ].filter(Boolean)
  );
}

export function renderTransfersTab(mainBody, proj, { say, openNewTransferDialog }) {
  const xfers = proj.transfers || [];
  const bar = h('div', { class: 'pm-act-bar' },
    h('button', { class: 'btn go', type: 'button', text: '＋ 登记跨机文件传输 / 大文件人工拷盘请求…', onclick: () => openNewTransferDialog(proj) }),
    h('span', { class: 'pm-hint', text: '当跨机文件过大（>50MB，如全波仿真场数据）或 Tailscale 较慢时，在此挂起人工硬盘拷贝任务；拷贝完成后点击「我已拷好」将自动唤醒对应会话继续工作。' })
  );

  const cards = xfers.map((t) => {
    const isTransferring = t.status === 'transferring';
    const isPending = t.status === 'pending';
    const canConfirm = isPending || isTransferring;
    const badgeClass = isTransferring ? 'run' : (isPending ? 'wait' : 'done');
    const badgeText = isTransferring ? '正在自动传输…' : (isPending ? '等待拷贝就位' : '已就位完成');
    return h('div', { class: `pm-xfer-card ${t.status === 'completed' ? 'done' : 'pending'}` },
      h('div', { class: 'pm-xfer-head' },
        h('img', { src: icon('handoff', true), alt: '' }),
        h('b', { text: t.mode === 'manual_disk' ? '📦 需移动硬盘人工摆渡 (Sneakernet)' : '⚡ 跨机文件传输' }),
        t.size ? h('span', { class: 'pm-xfer-size', text: size(t.size) }) : null,
        h('span', { class: `pm-rev-badge ${badgeClass}`, text: badgeText }),
        h('span', { class: 'pm-xfer-time', text: ago(t.createdAt) })
      ),
      h('div', { class: 'pm-xfer-paths' },
        h('div', {}, h('b', { text: '源位置：' }), h('code', { text: `${t.fromMachine} : ${t.fromPath}` })),
        h('div', {}, h('b', { text: '目标位置：' }), h('code', { text: `${t.toMachine} : ${t.toPath}` }))
      ),
      t.note ? h('div', { class: 'pm-xfer-note', text: `说明：${t.note}` }) : null,
      t.error ? h('div', { class: 'pm-xfer-note', text: `自动传输提示：${t.error}` }) : null,
      canConfirm ? h('div', { class: 'pm-node-btns' },
        h('button', { class: 'btn go', type: 'button', text: '✓ 我已用硬盘拷好，通知并唤醒会话', onclick: async () => {
          say('正在确认文件就位并唤醒目标会话…');
          const r = await mesh.confirmTransfer(proj.id, t.id, { wake: true });
          say(r.ok ? '已确认就位并通知目标会话' : (r.msg || '操作失败'));
        } }),
        h('button', { class: 'btn', type: 'button', text: '修改实际拷入路径并确认…', onclick: async () => {
          const np = await askText({ title: '修改实际目标存放路径', label: `文件在 ${t.toMachine} 上的实际路径：`, value: t.toPath, max: 500 });
          if (!np) return;
          const r = await mesh.confirmTransfer(proj.id, t.id, { newToPath: np, wake: true });
          say(r.ok ? '已更新路径并唤醒目标会话' : (r.msg || '操作失败'));
        } })
      ) : null
    );
  });

  mainBody.replaceChildren(
    bar,
    cards.length ? h('div', { class: 'pm-ws-list' }, ...cards) : h('div', { class: 'pm-empty', text: '暂无跨机文件传输或人工硬盘摆渡请求。' })
  );
}

export function renderEventsTab(mainBody, proj, { openAddTriggerDialog, openWatchdogConfigDialog }) {
  const trigs = proj.triggers || [];
  const evts = [...(proj.events || [])].reverse().slice(0, 30);

  const bar = h('div', { class: 'pm-act-bar' },
    h('button', { class: 'btn go', type: 'button', text: '＋ 添加目录文件触发器…', onclick: () => openAddTriggerDialog(proj) }),
    h('button', { class: 'btn', type: 'button', text: '看门狗参数配置 (W1~W8)…', onclick: openWatchdogConfigDialog }),
    h('span', { class: 'pm-hint', text: '说明：看门狗自动巡检各节点状态（W1~W6 基础巡检 + W7 点名未回帖 + W8 全组停滞）；目录触发器与 ame-mesh run 进程结束事件会自动唤醒目标节点。' })
  );

  const trigCards = trigs.map((t) => {
    const targetNode = (proj.nodes || []).find((n) => n.id === t.targetNodeId);
    const isEnabled = t.enabled !== false;
    return h('div', { class: 'pm-ws-card' },
      h('div', { class: 'pm-ws-head' },
        h('span', { class: `pm-rev-badge ${isEnabled ? 'run' : 'wait'}`, text: isEnabled ? '监听中' : '已暂停' }),
        h('b', { text: `${t.label || '目录触发器'} (${t.machine} : ${t.path})` }),
        h('code', { text: `匹配: ${t.glob || '*'}` }),
        h('span', { text: `→ 唤醒: ${targetNode ? (targetNode.alias || targetNode.id) : 'Master 主控节点'}` }),
        t.lastTriggeredAt ? h('span', { class: 'pm-ws-free', text: `最近触发: ${ago(t.lastTriggeredAt)}` }) : null,
        h('div', { class: 'pm-ws-actions' },
          h('button', { class: 'btn', type: 'button', text: isEnabled ? '暂停' : '启用', onclick: async () => {
            await mesh.trigger({ projectId: proj.id, id: t.id, enabled: !isEnabled });
          } }),
          h('button', { class: 'btn no', type: 'button', text: '删除', onclick: async () => {
            await mesh.trigger({ op: 'remove', projectId: proj.id, triggerId: t.id });
          } })
        )
      )
    );
  });

  const evtRows = evts.map((ev) => {
    const srcName = ev.source === 'watchdog' ? '🛡️ 看门狗' : ev.source === 'run' ? '⚙️ 计算结束' : '📁 目录触发';
    return h('div', { class: 'pm-unbound-row' },
      h('span', { class: 'xtag', text: srcName }),
      h('b', { text: ev.kind || ev.source }),
      ev.machine ? h('code', { text: ev.machine }) : null,
      h('span', { class: 'pm-unbound-note', text: ev.summary || '' }),
      h('span', { style: 'margin-left:auto;color:#555;font-size:11px', text: ago(ev.ts) })
    );
  });

  mainBody.replaceChildren(
    bar,
    h('div', { class: 'pm-sec-title', text: `目录文件触发器（${trigs.length}）：` }),
    trigCards.length ? h('div', { class: 'pm-ws-list' }, ...trigCards) : h('div', { class: 'pm-empty', text: '尚未配置目录触发器。点击上方「＋ 添加目录文件触发器」监听仿真输出目录。' }),
    h('div', { class: 'pm-sec-title', style: 'margin-top:10px', text: `最近看门狗与触发器事件流水（${evts.length}）：` }),
    evtRows.length ? h('div', { class: 'pm-unbound-sec' }, ...evtRows) : h('div', { class: 'pm-empty', text: '暂无看门狗告警或外部触发事件记录。' })
  );
}
