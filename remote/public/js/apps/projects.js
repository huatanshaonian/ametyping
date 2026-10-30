// 项目管理 (AmeMesh Project & Topology Manager):
// Dedicated Win98 window application for cross-machine, cross-agent collaboration:
//   1) 协同拓扑与契约 (Topology & Contracts): visual Master-Worker & Cowork graph, per-node Goal & Stop Gate editor,
//      spawning remote workers in allowed folders, linking existing sessions, and review/wake controls.
//   2) 跨机工作区与结构树 (Workspaces & VFS Tree): assign read-write / read-only folders across computers,
//      inspect "我的备注" & "AI 备注", and browse the NAS cached directory tree + disk free space without pulling files.
//   3) 文件协同与硬盘摆渡 (File Transfers & Sneakernet Handoff): track cross-machine file requests and confirm
//      manual hard-drive copies (> 50 MB) to automatically wake waiting sessions.
import { h, icon, ago } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as mesh from '../mesh.js';
import * as catalog from '../fs-catalog.js';
import { size } from '../filetypes.js';
import { confirmBox, askText } from '../dialog.js';
import { openNoteDialog, open as openExplorer } from './explorer.js';
import * as dashboard from './dashboard.js';

let inst = null;

export function open(projectId = null) {
  if (inst) {
    if (projectId) inst.select(projectId);
    wm.open({ id: 'projects' });
    return;
  }
  inst = mount(projectId);
  wm.open({
    id: 'projects',
    title: '项目管理 — 跨机协同与拓扑中心',
    icon: icon('projects', true),
    width: 920,
    height: 580,
    content: inst.root,
    onClose: () => { inst.destroy(); inst = null; },
  });
}

const ROLE_NAMES = { master: 'Master 主控', worker: 'Worker 执行', peer: 'Cowork 平级' };
const REVIEW_NAMES = {
  running: ['run', '执行中'],
  waiting_review: ['wait', '待检视 (Review Gate)'],
  approved: ['done', '已批准'],
  done: ['done', '已完成'],
  blocked: ['err', '受阻'],
};

function mount(initialProjectId) {
  let selId = initialProjectId;
  let activeTab = 'topo'; // 'topo' | 'vfs' | 'xfer'
  let expandedTreeKey = null;

  const sideList = h('div', { class: 'pm-side-list' });
  const mainHead = h('div', { class: 'pm-main-head' });
  const tabBar = h('div', { class: 'pm-tabs' });
  const mainBody = h('div', { class: 'pm-main-body' });
  const statusLine = h('div', { class: 'pm-status', text: '就绪' });

  const newProjBtn = h('button', { class: 'btn go', type: 'button', text: '＋ 新建项目', onclick: createNewProject });
  const side = h('aside', { class: 'pm-side' },
    h('div', { class: 'pm-side-bar' }, h('b', { text: '协同项目' }), newProjBtn),
    sideList
  );
  const main = h('section', { class: 'pm-main' }, mainHead, tabBar, mainBody, statusLine);
  const root = h('div', { class: 'pm-app' }, side, main);

  function say(msg) { statusLine.textContent = msg; }

  async function createNewProject() {
    const name = await askText({ title: '新建协同项目', label: '项目名称（将自动在糖糖看板创建同名会话分组）：', max: 50 });
    if (!name) return;
    const r = await mesh.saveProject({ name });
    if (!r.ok) return say(r.msg || '创建失败');
    selId = r.project.id;
    render();
    say(`已创建项目「${name}」并同步看板分组`);
  }

  function currentProject() {
    const list = mesh.list();
    if (!list.length) return null;
    let p = selId ? list.find((x) => x.id === selId) : null;
    if (!p) { p = list[0]; selId = p.id; }
    return p;
  }

  function renderSide() {
    const list = mesh.list();
    if (!list.length) {
      sideList.replaceChildren(h('div', { class: 'pm-empty', text: '还没有协同项目。点上方「＋ 新建项目」开始。' }));
      return;
    }
    sideList.replaceChildren(...list.map((p) => {
      const reviewCount = (p.nodes || []).filter((n) => n.reviewStatus === 'waiting_review').length;
      const xferCount = (p.transfers || []).filter((t) => t.status === 'pending').length;
      return h('div', {
        class: 'pm-item' + (p.id === selId ? ' sel' : ''),
        onclick: () => { selId = p.id; render(); },
      },
        h('div', { class: 'pm-item-title' },
          h('img', { src: icon('projects', true), alt: '' }),
          h('span', { text: p.name })
        ),
        h('div', { class: 'pm-item-meta' },
          h('span', { text: `${(p.nodes || []).length} 节点 · ${(p.workspaces || []).length} 目录` }),
          reviewCount ? h('span', { class: 'pm-badge warn', text: `待检视 ${reviewCount}` }) : null,
          xferCount ? h('span', { class: 'pm-badge err', text: `待拷盘 ${xferCount}` }) : null
        )
      );
    }));
  }

  function renderTabs(proj) {
    const reviewCount = (proj.nodes || []).filter((n) => n.reviewStatus === 'waiting_review').length;
    const xferCount = (proj.transfers || []).filter((t) => t.status === 'pending').length;
    const tabs = [
      ['topo', '协同拓扑与契约', icon('projects', true), reviewCount ? ` (${reviewCount})` : ''],
      ['vfs', '跨机目录与结构树', icon('tree', true), ` (${(proj.workspaces || []).length})`],
      ['xfer', '文件协同与硬盘摆渡', icon('handoff', true), xferCount ? ` (${xferCount})` : ''],
    ];
    tabBar.replaceChildren(...tabs.map(([k, label, ic, suffix]) =>
      h('button', {
        class: 'pm-tab' + (activeTab === k ? ' active' : ''),
        type: 'button',
        onclick: () => { activeTab = k; renderMain(); },
      }, h('img', { src: ic, alt: '' }), label + suffix)
    ));
  }

  // ---- Tab 1: Topology Graph & Contracts ----
  function renderTopologyTab(proj) {
    const nodes = proj.nodes || [];
    const edges = proj.edges || [];

    // Visual SVG + Card Topology Graph
    const graphBox = h('div', { class: 'pm-graph-box' });
    if (!nodes.length) {
      graphBox.append(h('div', { class: 'pm-empty', text: '该项目还没有会话节点。你可以从下方「绑定现有会话」或「在远程电脑派生新节点」。' }));
    } else {
      // Group nodes by tier: Masters on top/left, Peers in middle, Workers on bottom/right
      const masters = nodes.filter((n) => n.role === 'master');
      const peers = nodes.filter((n) => n.role === 'peer');
      const workers = nodes.filter((n) => n.role !== 'master' && n.role !== 'peer');

      const edgeList = edges.map((e) => {
        const fn = nodes.find((n) => n.id === e.from);
        const tn = nodes.find((n) => n.id === e.to);
        if (!fn || !tn) return null;
        return h('div', { class: 'pm-edge-pill' },
          h('span', { class: 'pm-edge-from', text: `${fn.alias || fn.id} (${fn.machine})` }),
          h('span', { class: 'pm-edge-arrow', text: e.type === 'cowork' ? ' ⟷ 平级协同 (Cowork) ⟷ ' : ' ──(主从委派 Master→Worker)──► ' }),
          h('span', { class: 'pm-edge-to', text: `${tn.alias || tn.id} (${tn.machine})` }),
          h('button', { class: 'pm-edge-del', type: 'button', title: '断开连线', text: '×', onclick: async () => {
            await mesh.removeEdge(proj.id, e.from, e.to);
          } })
        );
      }).filter(Boolean);

      const lanes = h('div', { class: 'pm-lanes' },
        masters.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '主控层 (Master)' }), ...masters.map((n) => nodeCard(proj, n))) : null,
        peers.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '平级协作层 (Cowork Peers)' }), ...peers.map((n) => nodeCard(proj, n))) : null,
        workers.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '执行层 (Workers)' }), ...workers.map((n) => nodeCard(proj, n))) : null
      );

      graphBox.append(
        edgeList.length ? h('div', { class: 'pm-edges-bar' }, h('b', { text: '拓扑关系边：' }), ...edgeList) : null,
        lanes
      );
    }

    // Action toolbar: Spawn Worker / Bind Existing Session / Add Edge
    const actBar = h('div', { class: 'pm-act-bar' },
      h('button', { class: 'btn go', type: 'button', onclick: () => openSpawnDialog(proj) },
        h('img', { src: icon('console_prompt', true), alt: '', style: 'vertical-align:-3px;margin-right:4px' }), '在指定电脑派生新节点 (Spawn)'),
      h('button', { class: 'btn', type: 'button', text: '＋ 挂载已有会话到拓扑…', onclick: () => openBindSessionDialog(proj) }),
      nodes.length >= 2 ? h('button', { class: 'btn', type: 'button', text: '⇄ 建立节点连线 (Master/Cowork)…', onclick: () => openLinkDialog(proj) }) : null
    );

    mainBody.replaceChildren(actBar, graphBox);
  }

  function nodeCard(proj, n) {
    const [rCls, rText] = REVIEW_NAMES[n.reviewStatus] || ['run', n.reviewStatus || '就绪'];
    const inboxCount = Array.isArray(n.inbox) ? n.inbox.length : 0;
    return h('div', { class: `pm-node role-${n.role}` },
      h('div', { class: 'pm-node-top' },
        h('span', { class: `pm-role-tag ${n.role}`, text: ROLE_NAMES[n.role] || n.role }),
        h('b', { class: 'pm-node-name', text: n.alias || n.label || n.id }),
        h('span', { class: 'pm-node-mach', text: `${n.machine} · ${n.tool || 'claude'}` }),
        h('span', { class: `pm-rev-badge ${rCls}`, text: rText }),
        n.asking ? h('span', { class: 'pm-badge err', text: '等你确认权限' }) : null
      ),
      n.cwd ? h('div', { class: 'pm-node-cwd', text: `📁 目录：${n.cwd}` }) : null,
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
      h('div', { class: 'pm-node-btns' },
        h('button', { class: 'btn go', type: 'button', text: '下发指令 / 改契约', onclick: () => openSendDialog(proj, n) }),
        n.reviewStatus === 'waiting_review' ? h('button', { class: 'btn', type: 'button', text: '✓ 批准检视继续', onclick: () => openSendDialog(proj, n, '检视通过，请继续下一阶段任务。') }) : null,
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
          if (await confirmBox(`从项目拓扑中移除节点「${n.alias || n.id}」？（不会删除原对话记录）`, { danger: true })) {
            await mesh.removeNode(proj.id, n.id);
          }
        } })
      )
    );
  }

  // ---- Tab 2: Cross-Machine Workspaces & VFS Structure Tree ----
  function renderVfsTab(proj) {
    const allCat = catalog.list();
    const wsList = proj.workspaces || [];

    const addBar = h('div', { class: 'pm-act-bar' },
      h('button', { class: 'btn go', type: 'button', text: '＋ 从已备注目录添加授权工作区…', onclick: () => openAddWorkspaceDialog(proj, allCat) }),
      h('button', { class: 'btn', type: 'button', text: '＋ 手动输入跨机路径授权…', onclick: () => openManualWorkspaceDialog(proj) }),
      h('span', { class: 'pm-hint', text: '提示：分配给项目的文件夹将作为 Agent 派生与跨机传文件的安全边界；点击「展开结构树」无需拉取文件即可秒看群晖缓存的目录结构。' })
    );

    const rows = wsList.map((w) => {
      const key = `${w.machine}|${w.path}`;
      const isExp = expandedTreeKey === key;
      const snap = w.snapshot;
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
          snap && snap.gitBranch ? h('span', { class: 'pm-ws-git', text: `Git: ${snap.gitBranch}` }) : null,
          h('div', { class: 'pm-ws-actions' },
            h('button', { class: 'btn', type: 'button', text: isExp ? '▾ 收起结构树' : '▸ 展开结构树', onclick: () => {
              expandedTreeKey = isExp ? null : key;
              renderMain();
            } }),
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

    // Also show other annotated folders in NAS catalog not yet bound to this project
    const unbound = allCat.filter((c) => !wsList.some((w) => w.machine === c.machine && w.path === c.path));
    const unboundBox = unbound.length ? h('div', { class: 'pm-unbound-sec' },
      h('div', { class: 'pm-sec-title', text: `群晖已登记的其他机器备注文件夹（共 ${unbound.length} 个，可一键授权加入本项目）：` }),
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
      addBar,
      rows.length ? h('div', { class: 'pm-ws-list' }, ...rows) : h('div', { class: 'pm-empty', text: '尚未给该项目分配专属文件夹。' }),
      unboundBox
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

  // ---- Tab 3: File Transfers & Sneakernet (Manual Hard-Drive Copy) ----
  function renderTransfersTab(proj) {
    const xfers = proj.transfers || [];
    const bar = h('div', { class: 'pm-act-bar' },
      h('button', { class: 'btn go', type: 'button', text: '＋ 登记跨机文件传输 / 大文件人工拷盘请求…', onclick: () => openNewTransferDialog(proj) }),
      h('span', { class: 'pm-hint', text: '当跨机文件过大（>50MB，如全波仿真场数据）或 Tailscale 较慢时，在此挂起人工硬盘拷贝任务；拷贝完成后点击「我已拷好」将自动唤醒对应会话继续工作。' })
    );

    const cards = xfers.map((t) => {
      const isPending = t.status === 'pending';
      return h('div', { class: `pm-xfer-card ${isPending ? 'pending' : 'done'}` },
        h('div', { class: 'pm-xfer-head' },
          h('img', { src: icon('handoff', true), alt: '' }),
          h('b', { text: t.mode === 'manual_disk' ? '📦 需移动硬盘人工摆渡 (Sneakernet)' : '⚡ 跨机文件传输' }),
          t.size ? h('span', { class: 'pm-xfer-size', text: size(t.size) }) : null,
          h('span', { class: `pm-rev-badge ${isPending ? 'wait' : 'done'}`, text: isPending ? '等待拷贝就位' : '已就位完成' }),
          h('span', { class: 'pm-xfer-time', text: ago(t.createdAt) })
        ),
        h('div', { class: 'pm-xfer-paths' },
          h('div', {}, h('b', { text: '源位置：' }), h('code', { text: `${t.fromMachine} : ${t.fromPath}` })),
          h('div', {}, h('b', { text: '目标位置：' }), h('code', { text: `${t.toMachine} : ${t.toPath}` }))
        ),
        t.note ? h('div', { class: 'pm-xfer-note', text: `说明：${t.note}` }) : null,
        isPending ? h('div', { class: 'pm-node-btns' },
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

  // ---- Dialogs for Spawning, Linking, Sending, and Workspace Binding ----
  function openSpawnDialog(proj) {
    const machines = net.state.sessions.map((m) => m.machine);
    const machSel = h('select', { class: 'field' },
      ...machines.map((m) => h('option', { value: m, text: m }))
    );
    const cwdIn = h('input', { class: 'field', type: 'text', placeholder: '例如：/data/cem_solver 或 D:\\feko_data' });
    // Quick-fill from project workspaces
    const wsQuick = (proj.workspaces || []).length ? h('select', {
      class: 'field',
      onchange: (e) => {
        if (!e.target.value) return;
        const [m, p] = e.target.value.split('|');
        machSel.value = m;
        cwdIn.value = p;
      },
    },
      h('option', { value: '', text: '— 快速选择本项目已授权文件夹 —' }),
      ...(proj.workspaces || []).map((w) => h('option', { value: `${w.machine}|${w.path}`, text: `${w.machine} : ${w.path} (${w.tagLabel || w.mode})` }))
    ) : null;

    const toolSel = h('select', { class: 'field' },
      h('option', { value: 'claude', text: 'Claude Code' }),
      h('option', { value: 'agy', text: 'Antigravity (agy)' }),
      h('option', { value: 'codex', text: 'Codex' }),
      h('option', { value: 'opencode', text: 'OpenCode' })
    );
    const aliasIn = h('input', { class: 'field', type: 'text', placeholder: '如：电脑B-FEKO求解Worker' });
    const goalIn = h('input', { class: 'field', type: 'text', placeholder: '如：从 GitHub 拉取最新代码并跑完球体双站 RCS 误差对比' });
    const stopIn = h('input', { class: 'field', type: 'text', value: '产出结果图表与误差数据后立即停下汇报，等待主控会话 Review' });
    const promptIn = h('textarea', { class: 'field xnote-ta', rows: 3, placeholder: '首轮详细执行指令…' });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '在远程电脑派生新协同节点 (Spawn Worker)' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        wsQuick ? h('label', { class: 'xnote-lbl', text: '从项目工作区快选：' }) : null,
        wsQuick,
        h('label', { class: 'xnote-lbl', text: '目标电脑与工作目录：' }),
        h('div', { style: 'display:flex;gap:6px' }, machSel, cwdIn),
        h('label', { class: 'xnote-lbl', text: 'Coding Agent 类型与节点别名：' }),
        h('div', { style: 'display:flex;gap:6px' }, toolSel, aliasIn),
        h('label', { class: 'xnote-lbl', text: '明确目标 (Goal)：' }),
        goalIn,
        h('label', { class: 'xnote-lbl', text: '停机检视边界 (Stop & Review Gate)：' }),
        stopIn,
        h('label', { class: 'xnote-lbl', text: '首轮具体指令：' }),
        promptIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '启动并加入拓扑' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!machSel.value || !cwdIn.value.trim()) return;
      const master = (proj.nodes || []).find((n) => n.role === 'master');
      say('正在远程启动协同会话…');
      done();
      const r = await mesh.spawnWorker({
        projectId: proj.id,
        fromNodeId: master ? master.id : undefined,
        machine: machSel.value,
        cwd: cwdIn.value.trim(),
        tool: toolSel.value,
        alias: aliasIn.value.trim(),
        goal: goalIn.value.trim(),
        stopCondition: stopIn.value.trim(),
        prompt: promptIn.value.trim() || goalIn.value.trim() || '请按项目契约准备执行任务。',
      });
      say(r.msg || (r.ok ? '已启动' : '启动失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openBindSessionDialog(proj) {
    const allSessions = [];
    for (const m of net.state.sessions) {
      for (const s of m.sessions || []) {
        allSessions.push({ machine: m.machine, id: s.id, label: s.label, cwd: s.cwd || '', state: s.state });
      }
    }
    const sessSel = h('select', { class: 'field' },
      ...allSessions.map((s) => h('option', { value: `${s.machine}|${s.id}`, text: `[${s.machine}] ${s.label} (${s.state})` }))
    );
    const roleSel = h('select', { class: 'field' },
      h('option', { value: 'master', text: 'Master 主控会话（负责统筹与检视）' }),
      h('option', { value: 'worker', text: 'Worker 执行会话（负责子任务计算与汇报）' }),
      h('option', { value: 'peer', text: 'Cowork 平级会话（对等联调协作）' })
    );
    const aliasIn = h('input', { class: 'field', type: 'text', placeholder: '节点别名（可留空使用原会话标题）' });
    const goalIn = h('input', { class: 'field', type: 'text', placeholder: '该节点的职责目标（Goal）' });
    const stopIn = h('input', { class: 'field', type: 'text', placeholder: '停机检视条件（Stop Gate）' });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '挂载现有会话到项目拓扑' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '选择正在运行或历史的会话：' }),
        sessSel,
        h('label', { class: 'xnote-lbl', text: '在拓扑中的角色：' }),
        roleSel,
        h('label', { class: 'xnote-lbl', text: '节点别名：' }),
        aliasIn,
        h('label', { class: 'xnote-lbl', text: '负责目标 (Goal)：' }),
        goalIn,
        h('label', { class: 'xnote-lbl', text: '停机检视条件 (Stop Gate)：' }),
        stopIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '加入拓扑并同步看板分组' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sessSel.value) return;
      const [machine, sessionId] = sessSel.value.split('|');
      const picked = allSessions.find((x) => x.machine === machine && x.id === sessionId);
      const master = (proj.nodes || []).find((n) => n.role === 'master');
      done();
      const r = await mesh.upsertNode(proj.id, {
        machine,
        sessionId,
        alias: aliasIn.value.trim() || (picked ? picked.label : sessionId),
        role: roleSel.value,
        cwd: picked ? picked.cwd : '',
        goal: goalIn.value.trim(),
        stopCondition: stopIn.value.trim(),
        fromNodeId: roleSel.value !== 'master' && master ? master.id : undefined,
        edgeType: roleSel.value === 'peer' ? 'cowork' : 'master-worker',
      });
      say(r.ok ? '已挂载节点并自动归入糖糖看板分组' : (r.msg || '挂载失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openLinkDialog(proj) {
    const nodes = proj.nodes || [];
    const fromSel = h('select', { class: 'field' }, ...nodes.map((n) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})` })));
    const toSel = h('select', { class: 'field' }, ...nodes.map((n, i) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})`, selected: i === 1 })));
    const typeSel = h('select', { class: 'field' },
      h('option', { value: 'master-worker', text: 'Master → Worker 主从控制与自动汇报边' }),
      h('option', { value: 'cowork', text: 'Cowork ⟷ Cowork 平级对等协作边' })
    );
    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '建立会话拓扑连线' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '起点节点：' }), fromSel,
        h('label', { class: 'xnote-lbl', text: '终点节点：' }), toSel,
        h('label', { class: 'xnote-lbl', text: '协同关系模式：' }), typeSel,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '建立连线' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      done();
      const r = await mesh.addEdge(proj.id, fromSel.value, toSel.value, typeSel.value);
      say(r.ok ? '已建立拓扑连线' : (r.msg || '连线失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openSendDialog(proj, targetNode, defaultText = '') {
    const goalIn = h('input', { class: 'field', type: 'text', value: targetNode.goal || '' });
    const stopIn = h('input', { class: 'field', type: 'text', value: targetNode.stopCondition || '' });
    const textIn = h('textarea', { class: 'field xnote-ta', rows: 4, placeholder: '输入要发给该节点的指令或平级协作消息（对方空闲将直接打入终端，正忙则进收件箱）…' });
    textIn.value = defaultText;
    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: `向节点「${targetNode.alias || targetNode.id}」下发指令 / 修改契约` }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '阶段目标 (Goal)：' }), goalIn,
        h('label', { class: 'xnote-lbl', text: '停机检视条件 (Stop Gate)：' }), stopIn,
        h('label', { class: 'xnote-lbl', text: '发送消息内容（若只改目标契约不发消息可留空）：' }), textIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '确定执行' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = textIn.value.trim();
      done();
      if (!msg) {
        await mesh.upsertNode(proj.id, { id: targetNode.id, goal: goalIn.value.trim(), stopCondition: stopIn.value.trim() });
        say('已更新节点目标与停机条件');
        return;
      }
      say('正在投递协同指令…');
      const r = await mesh.sendMessage({
        projectId: proj.id,
        toNodeId: targetNode.id,
        text: msg,
        goal: goalIn.value.trim(),
        stopCondition: stopIn.value.trim(),
      });
      say(r.msg || (r.ok ? '已投递' : '投递失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
    textIn.focus();
  }

  function openAddWorkspaceDialog(proj, allCat) {
    if (!allCat.length) {
      openManualWorkspaceDialog(proj);
      return;
    }
    const sel = h('select', { class: 'field' },
      ...allCat.map((c) => h('option', { value: `${c.machine}|${c.path}|${c.tag || ''}`, text: `[${c.machine}] ${c.path} (${c.tagLabel || '无标签'}) ${c.userNote ? '— ' + c.userNote : ''}` }))
    );
    const modeSel = h('select', { class: 'field' },
      h('option', { value: 'rw', text: '读写授权 (RW - 允许改代码/输出数据)' }),
      h('option', { value: 'ro', text: '只读参考 (RO - 仅允许读取参考)' })
    );
    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '添加已备注文件夹到项目工作区' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '选择文件夹：' }), sel,
        h('label', { class: 'xnote-lbl', text: '访问权限边界：' }), modeSel,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '添加授权' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const [machine, path, tag] = sel.value.split('|');
      done();
      const cur = proj.workspaces || [];
      if (cur.some((w) => w.machine === machine && w.path === path)) return say('该文件夹已在项目工作区中');
      await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: [...cur, { machine, path, mode: modeSel.value, tag }] });
      say('已添加项目授权文件夹');
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openManualWorkspaceDialog(proj) {
    const machines = net.state.sessions.map((m) => m.machine);
    const machSel = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
    const pathIn = h('input', { class: 'field', type: 'text', placeholder: '文件夹绝对路径，如 D:\\CEM_PO 或 /data/feko_runs' });
    const tagSel = h('select', { class: 'field' },
      h('option', { value: 'solver', text: 'CEM求解器 (solver)' }),
      h('option', { value: 'results', text: '求解结果 (results)' }),
      h('option', { value: 'code', text: '核心代码 (code)' }),
      h('option', { value: 'data', text: '数据集 (data)' }),
      h('option', { value: 'docs', text: '文档资料 (docs)' })
    );
    const noteIn = h('input', { class: 'field', type: 'text', placeholder: '我的备注（如：存放高频条带积分结果数据）' });
    const modeSel = h('select', { class: 'field' },
      h('option', { value: 'rw', text: '读写授权 (RW)' }),
      h('option', { value: 'ro', text: '只读参考 (RO)' })
    );
    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '手动登记并授权跨机文件夹' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '目标电脑与文件夹路径：' }),
        h('div', { style: 'display:flex;gap:6px' }, machSel, pathIn),
        h('label', { class: 'xnote-lbl', text: '角色标签与权限：' }),
        h('div', { style: 'display:flex;gap:6px' }, tagSel, modeSel),
        h('label', { class: 'xnote-lbl', text: '我的备注：' }),
        noteIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存并同步结构树' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!machSel.value || !pathIn.value.trim()) return;
      const machine = machSel.value, p = pathIn.value.trim();
      done();
      await catalog.setNote({ machine, path: p, tag: tagSel.value, userNote: noteIn.value.trim(), aiNote: '' });
      const cur = proj.workspaces || [];
      if (!cur.some((w) => w.machine === machine && w.path === p)) {
        await mesh.saveProject({ id: proj.id, name: proj.name, workspaces: [...cur, { machine, path: p, mode: modeSel.value, tag: tagSel.value }] });
      }
      say('已保存文件夹备注并授权给当前项目');
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function openNewTransferDialog(proj) {
    const machines = net.state.sessions.map((m) => m.machine);
    const fromM = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
    const fromP = h('input', { class: 'field', type: 'text', placeholder: '源文件路径（如 /data/feko/sphere.h5）' });
    const toM = h('select', { class: 'field' }, ...machines.map((m, i) => h('option', { value: m, text: m, selected: i === 1 })));
    const toP = h('input', { class: 'field', type: 'text', placeholder: '目标存放路径（如 G:\\feko_data\\sphere.h5）' });
    const noteIn = h('input', { class: 'field', type: 'text', placeholder: '备注说明（如：18GB 近场数据，请用移动硬盘拷到电脑A）' });
    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '登记大文件移动硬盘人工摆渡请求' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '源电脑与文件路径：' }),
        h('div', { style: 'display:flex;gap:6px' }, fromM, fromP),
        h('label', { class: 'xnote-lbl', text: '目标电脑与存放路径：' }),
        h('div', { style: 'display:flex;gap:6px' }, toM, toP),
        h('label', { class: 'xnote-lbl', text: '说明备注：' }),
        noteIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '挂起摆渡卡片' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!fromP.value.trim() || !toP.value.trim()) return;
      done();
      const r = await mesh.requestTransfer({
        projectId: proj.id,
        fromMachine: fromM.value,
        fromPath: fromP.value.trim(),
        toMachine: toM.value,
        toPath: toP.value.trim(),
        mode: 'manual_disk',
        note: noteIn.value.trim(),
      });
      say(r.ok ? '已创建大文件人工摆渡卡片' : (r.msg || '创建失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
  }

  function renderMain() {
    const proj = currentProject();
    if (!proj) {
      mainHead.replaceChildren(h('b', { text: '尚未选择项目' }));
      tabBar.replaceChildren();
      mainBody.replaceChildren(h('div', { class: 'pm-empty', text: '请先在左侧点击「＋ 新建项目」，或者在任意会话中使用 ame-mesh 工具自动创建。' }));
      return;
    }
    mainHead.replaceChildren(
      h('div', { class: 'pm-title-row' },
        h('img', { src: icon('projects', true), alt: '' }),
        h('b', { text: proj.name }),
        h('label', { class: 'pm-chk', style: 'margin-left:auto' },
          h('input', {
            type: 'checkbox',
            checked: proj.autoResumeMaster !== false,
            onchange: (e) => mesh.saveProject({ id: proj.id, name: proj.name, autoResumeMaster: e.target.checked }),
          }),
          'Worker 汇报时若主会话已关闭则自动后台唤醒'
        ),
        h('button', { class: 'btn', type: 'button', text: '重命名', onclick: async () => {
          const n = await askText({ title: '重命名项目', value: proj.name, max: 50 });
          if (n && n !== proj.name) await mesh.saveProject({ id: proj.id, name: n });
        } }),
        h('button', { class: 'btn no', type: 'button', text: '删除项目', onclick: async () => {
          if (await confirmBox(`确定删除协同项目「${proj.name}」吗？（看板会话记录仍会保留）`, { danger: true })) {
            await mesh.deleteProject(proj.id);
            selId = null;
            render();
          }
        } })
      )
    );
    renderTabs(proj);
    if (activeTab === 'topo') renderTopologyTab(proj);
    else if (activeTab === 'vfs') renderVfsTab(proj);
    else renderTransfersTab(proj);
  }

  function render() {
    renderSide();
    renderMain();
  }

  const offMesh = mesh.subscribe(render);
  const offCat = catalog.subscribe(render);
  const offSess = net.on('sessions', render);

  return {
    root,
    select(id) { selId = id; render(); },
    destroy() { offMesh(); offCat(); offSess(); },
  };
}
