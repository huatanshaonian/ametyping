// 项目管理 (AmeMesh Project & Topology Manager):
// Dedicated Win98 window application for cross-machine, cross-agent collaboration:
//   1) 协同拓扑与契约 (Topology & Contracts): visual Master-Worker & Cowork graph, per-node Goal & Stop Gate editor,
//      spawning remote workers in allowed folders, linking existing sessions, and review/wake controls.
//   2) 跨机工作区与结构树 (Workspaces & VFS Tree): assign read-write / read-only folders across computers,
//      inspect "我的备注" & "AI 备注", and browse the NAS cached directory tree + disk free space without pulling files.
//   3) 文件协同与硬盘摆渡 (File Transfers & Sneakernet Handoff): track cross-machine file requests and confirm
//      manual hard-drive copies (> 50 MB) to automatically wake waiting sessions.
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as net from '../net.js';
import * as mesh from '../mesh.js';
import * as catalog from '../fs-catalog.js';
import { confirmBox, askText } from '../dialog.js';
import { researchTab } from './project-research.js';
import { createBoardTab } from './proj-board.js';
import { createTopologyView } from './proj-topo.js';
import { createRolesTab } from './proj-roles.js';
import { renderNodeCard, renderVfsTab, renderTransfersTab, renderEventsTab } from './proj-panels.js';
import {
  openWatchdogConfigDialog,
  openAddTriggerDialog,
  openSpawnDialog,
  openBindSessionDialog,
  openLinkDialog,
  openSendDialog,
  openAddWorkspaceDialog,
  openManualWorkspaceDialog,
  openNewTransferDialog,
} from './proj-dialogs.js';

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

function mount(initialProjectId) {
  let selId = initialProjectId;
  let activeTab = 'research';
  let researchView = null;
  let boardView = null;
  let topoView = null;
  let rolesView = null;
  let expandedTreeKey = null;
  const boardDrafts = new Map();

  const sideList = h('div', { class: 'pm-side-list' });
  const mainHead = h('div', { class: 'pm-main-head' });
  const tabBar = h('div', { class: 'pm-tabs' });
  const mainBody = h('div', { class: 'pm-main-body' });
  const statusLine = h('div', { class: 'pm-status', text: '就绪' });

  const newProjBtn = h('button', { class: 'btn go', type: 'button', text: '＋ 新建项目', onclick: createNewProject });
  const side = h('aside', { class: 'pm-side' },
    h('div', { class: 'pm-side-bar' }, h('b', { text: '项目目录' }), newProjBtn),
    sideList
  );
  const main = h('section', { class: 'pm-main' }, mainHead, tabBar, mainBody, statusLine);
  const root = h('div', { class: 'pm-app' }, side, main);

  function say(msg) { statusLine.textContent = msg; }

  const dialogDeps = { say };
  const nodeCard = (proj, n) => renderNodeCard(proj, n, {
    say,
    openSendDialog: (p, target, def) => openSendDialog(p, target, def, dialogDeps),
  });

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
          h('span', { text: `${(p.nodes || []).length} 个会话 · ${(p.workspaces || []).length} 个工作区` }),
          reviewCount ? h('span', { class: 'pm-badge warn', text: `待检视 ${reviewCount}` }) : null,
          xferCount ? h('span', { class: 'pm-badge err', text: `待拷盘 ${xferCount}` }) : null
        )
      );
    }));
  }

  function renderTabs(proj) {
    const reviewCount = (proj.nodes || []).filter((n) => n.reviewStatus === 'waiting_review').length;
    const taskCount = (proj.tasks || []).length;
    const boardSuffix = proj.boardSeq ? ` (#${proj.boardSeq})` : (taskCount ? ` (${taskCount})` : '');
    const tabs = [
      ['research', '研究与计算', icon('projects', true), ''],
      ['board', '黑板与任务', icon('projects', true), boardSuffix],
      ['topo', '协同拓扑与契约', icon('projects', true), reviewCount ? ` (${reviewCount})` : ''],
      ['roles', '角色与模型池', icon('projects', true), ''],
      ['vfs', '跨机目录与结构树', icon('tree', true), ` (${(proj.workspaces || []).length})`],
      ['events', '⚡ 触发器与看门狗', icon('clock', true), (proj.triggers || []).length ? ` (${(proj.triggers || []).length})` : ''],
    ];
    tabBar.replaceChildren(...tabs.map(([k, label, ic, suffix]) =>
      h('button', {
        class: 'pm-tab' + (activeTab === k ? ' active' : ''),
        type: 'button',
        onclick: () => { activeTab = k; renderMain(); },
      }, h('img', { src: ic, alt: '' }), label + suffix)
    ));
  }

  function renderMain() {
    const proj = currentProject();
    if (researchView && (!proj || activeTab !== 'research' || researchView.projectId !== proj.id)) { researchView.destroy(); researchView = null; }
    if (boardView && (!proj || activeTab !== 'board' || boardView.projectId !== proj.id)) { boardView.destroy(); boardView = null; }
    if (topoView && (!proj || activeTab !== 'topo' || topoView.projectId !== proj.id)) { topoView.destroy(); topoView = null; }
    if (rolesView && (!proj || activeTab !== 'roles')) { rolesView.destroy(); rolesView = null; }
    if (!proj) {
      mainHead.replaceChildren(h('b', { text: '尚未选择项目' }));
      tabBar.replaceChildren();
      mainBody.replaceChildren(h('div', { class: 'pm-empty', text: '请先在左侧点击「＋ 新建项目」，或者在任意会话中使用 ame-mesh 工具自动创建。' }));
      return;
    }
    const activeXfers = (proj.transfers || []).filter((t) => t.status === 'pending' || t.status === 'transferring').length;
    const xferBtn = h('button', {
      class: 'btn pm-xfer-btn' + (activeTab === 'xfer' ? ' active' : ''),
      type: 'button',
      title: '查看跨机文件协同与硬盘摆渡任务',
      onclick: () => { activeTab = 'xfer'; renderMain(); },
    },
      '传输/摆渡',
      activeXfers ? h('span', { class: 'pm-xfer-badge', text: String(activeXfers) }) : null
    );
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
        xferBtn,
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
    if (activeTab === 'research') {
      if (!researchView) { researchView = researchTab(proj); mainBody.replaceChildren(researchView.root); }
    } else if (activeTab === 'board') {
      if (!boardView) {
        boardView = createBoardTab(proj, { say, boardDrafts });
        mainBody.replaceChildren(boardView.root);
      } else {
        boardView.update(proj);
      }
    } else if (activeTab === 'topo') {
      if (!topoView) {
        topoView = createTopologyView(proj, {
          nodeCard,
          openSpawnDialog: (p) => openSpawnDialog(p, dialogDeps),
          openBindSessionDialog: (p) => openBindSessionDialog(p, dialogDeps),
          openLinkDialog: (p) => openLinkDialog(p, dialogDeps),
        });
        mainBody.replaceChildren(topoView.root);
      } else {
        topoView.update(proj);
      }
    } else if (activeTab === 'roles') {
      if (!rolesView) {
        rolesView = createRolesTab({ say });
        mainBody.replaceChildren(rolesView.root);
      }
    } else if (activeTab === 'vfs') {
      renderVfsTab(mainBody, proj, {
        say,
        expandedTreeKey,
        onToggleTreeKey: (k) => { expandedTreeKey = k; renderMain(); },
        openAddWorkspaceDialog: (p, allCat) => openAddWorkspaceDialog(p, allCat, dialogDeps),
        openManualWorkspaceDialog: (p) => openManualWorkspaceDialog(p, dialogDeps),
      });
    } else if (activeTab === 'events') {
      renderEventsTab(mainBody, proj, {
        openAddTriggerDialog: (p) => openAddTriggerDialog(p, dialogDeps),
        openWatchdogConfigDialog: () => openWatchdogConfigDialog(dialogDeps),
      });
    } else {
      renderTransfersTab(mainBody, proj, {
        say,
        openNewTransferDialog: (p) => openNewTransferDialog(p, dialogDeps),
      });
    }
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
    destroy() {
      if (researchView) researchView.destroy();
      if (boardView) boardView.destroy();
      if (topoView) topoView.destroy();
      if (rolesView) rolesView.destroy();
      offMesh();
      offCat();
      offSess();
    },
  };
}
