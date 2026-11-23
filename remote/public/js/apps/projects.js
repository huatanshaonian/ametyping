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
import { researchTab } from './project-research.js';
import { open as openResearchPilots } from './research-pilots.js';

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

const ROLE_NAMES = { master: 'Master 主控', worker: 'Worker 执行', peer: 'Cowork 平级', verifier: 'Verifier 验收' };
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const REVIEW_NAMES = {
  running: ['run', '执行中'],
  waiting_review: ['wait', '待检视 (Review Gate)'],
  approved: ['done', '已批准'],
  done: ['done', '已完成'],
  blocked: ['err', '受阻'],
};

const TASK_STATUSES = [
  ['pending', '待办'],
  ['in_progress', '进行中'],
  ['review', '待审'],
  ['done', '完成'],
  ['blocked', '受阻'],
];
const BOARD_KINDS = [
  ['all', '全部'],
  ['post', '帖子'],
  ['brief', '契约'],
  ['report', '汇报'],
  ['task', '任务'],
  ['watchdog', '看门狗'],
  ['event', '事件'],
];
const BOARD_KIND_LABELS = {
  brief: '契约',
  post: '帖子',
  report: '汇报',
  task: '任务',
  watchdog: '看门狗',
  event: '事件',
  control: '控制',
};

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

  // ---- Tab: Board & Shared Tasks ----
  function renderPostBody(text, onJumpSeq) {
    const body = h('div', { class: 'pm-post-body' });
    const src = String(text || '');
    const re = /(@[A-Za-z0-9_\u4e00-\u9fa5-]+(?:\.[A-Za-z0-9_\u4e00-\u9fa5-]+)*|#\d+(?![A-Za-z0-9_]))/g;
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const idx = m.index;
      const tok = m[0];
      if (tok.startsWith('@') && idx > 0 && /[A-Za-z0-9_]/.test(src[idx - 1])) continue;
      if (idx > last) body.append(document.createTextNode(src.slice(last, idx)));
      if (tok.startsWith('@')) {
        body.append(h('span', { class: 'pm-mention', text: tok }));
      } else {
        const seqNum = tok.slice(1);
        body.append(h('button', {
          class: 'pm-ref-pill',
          type: 'button',
          text: tok,
          title: `跳转到 #${seqNum}`,
          onclick: () => onJumpSeq(seqNum),
        }));
      }
      last = idx + tok.length;
    }
    if (last < src.length) body.append(document.createTextNode(src.slice(last)));
    return body;
  }

  function formatAuditMessage(audit) {
    if (!audit) return '';
    const parts = [];
    const oob = audit.outOfBounds || audit.outsideFiles || audit.outside || audit.violations || audit.unexpectedFiles;
    if (Array.isArray(oob) && oob.length) parts.push(`越界改动文件: ${oob.join(', ')}`);
    if (audit.emptyChange || audit.empty || audit.noChanges || audit.changedCount === 0) parts.push('未检测到实际代码改动（空变更）');
    if (audit.reason || audit.msg || audit.summary) parts.push(String(audit.reason || audit.msg || audit.summary));
    return parts.length ? parts.join('；') : 'Git 工作区审计未通过，请核查改动范围';
  }

  function openNewTaskDialog(proj) {
    const nodes = proj.nodes || [];
    const existingTasks = proj.tasks || [];
    const titleIn = h('input', { class: 'field', type: 'text', placeholder: '例如：修复导出脚本中英混排字形映射' });
    const ownerSel = h('select', { class: 'field' },
      h('option', { value: '', text: '（暂不指派，放入待认领队列）' }),
      ...nodes.map((n) => h('option', { value: n.id, text: `${n.alias || n.label || n.id} (${n.machine} · ${n.role || 'worker'})` }))
    );
    const blockedIn = h('input', {
      class: 'field',
      type: 'text',
      placeholder: existingTasks.length
        ? `可选，逗号分隔前置任务 ID，如 ${existingTasks.slice(0, 2).map((t) => t.id).join(', ')}`
        : '可选，逗号分隔前置任务 ID，如 task_1, task_2',
    });
    const boundIn = h('textarea', {
      class: 'field xnote-ta',
      rows: 2,
      placeholder: '可选，逗号或换行分隔允许修改的文件/目录边界，如 remote/public/js/mesh.js',
    });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '新建共享任务' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '任务标题：' }),
        titleIn,
        h('label', { class: 'xnote-lbl', text: '负责节点：' }),
        ownerSel,
        h('label', { class: 'xnote-lbl', text: '前置依赖 (blockedBy)：' }),
        blockedIn,
        h('label', { class: 'xnote-lbl', text: '文件边界 (boundaries)：' }),
        boundIn,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '创建任务' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleIn.value.trim();
      if (!title) { titleIn.focus(); return; }
      const blockedBy = blockedIn.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
      const boundaries = boundIn.value.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean);
      done();
      say('正在创建共享任务…');
      const r = await mesh.task({
        action: 'add',
        projectId: proj.id,
        title,
        ownerNodeId: ownerSel.value || '',
        blockedBy,
        boundaries,
      });
      say(r.ok ? '已创建共享任务' : (r.msg || '创建任务失败'));
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
    const wrap = h('div', { class: 'dlg' }, form);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
    document.body.append(wrap);
    titleIn.focus();
  }

  function renderBoardTab(proj) {
    let curProj = proj;
    let entries = [];
    let activeChannel = 'main';
    let filterKind = 'all';
    let filterQuery = '';
    let loadedSeq = -1;
    let loading = false;
    let loadToken = 0;
    let destroyed = false;

    const taskStripEl = h('div', { class: 'pm-task-strip' });
    const channelBarEl = h('div', { class: 'pm-channel-bar' });
    const kindSel = h('select', { class: 'field pm-board-kind' },
      ...BOARD_KINDS.map(([val, lbl]) => h('option', { value: val, text: lbl }))
    );
    const searchIn = h('input', {
      class: 'field pm-board-search',
      type: 'search',
      placeholder: '按关键词、作者或 #楼层筛选…',
    });
    const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新' });
    const filterBarEl = h('div', { class: 'pm-board-filter' },
      h('span', { class: 'pm-sec-title', text: '共享黑板流' }),
      kindSel,
      searchIn,
      refreshBtn
    );
    const feedEl = h('div', { class: 'pm-board-feed' });
    const mentionBarEl = h('div', { class: 'pm-mention-bar' });
    const draftTa = h('textarea', {
      class: 'field pm-composer-ta',
      rows: 3,
      placeholder: '以人类管理员身份向黑板发帖（可用 @节点别名 唤醒，#楼层 引用上下文，Ctrl+Enter 发送）…',
    });
    draftTa.value = boardDrafts.get(proj.id) || '';
    const sendBtn = h('button', { class: 'btn go', type: 'button', text: '发送到黑板' });
    const composerEl = h('div', { class: 'pm-composer' },
      mentionBarEl,
      h('div', { class: 'pm-composer-row' }, draftTa, sendBtn)
    );
    const rootEl = h('div', { class: 'pm-board-wrap' }, taskStripEl, channelBarEl, filterBarEl, feedEl, composerEl);

    function getChannels(p) {
      const raw = Array.isArray(p && p.channels) && p.channels.length
        ? p.channels
        : [{ name: 'main', archived: false }];
      const list = raw
        .map((c) => (typeof c === 'string' ? { name: c, archived: false } : c))
        .filter((c) => c && c.name && !c.archived);
      return list.length ? list : [{ name: 'main', archived: false }];
    }

    function renderChannels(p) {
      const channels = getChannels(p);
      if (!channels.some((c) => c.name === activeChannel)) {
        activeChannel = channels[0].name;
      }
      channelBarEl.replaceChildren(
        h('span', { class: 'pm-sec-title', text: '频道:' }),
        ...channels.map((ch) => h('button', {
          class: 'pm-ch-btn' + (ch.name === activeChannel ? ' active' : ''),
          type: 'button',
          text: `#${ch.name}`,
          onclick: () => {
            if (activeChannel === ch.name) return;
            activeChannel = ch.name;
            entries = [];
            renderChannels(curProj);
            loadBoard();
          },
        })),
        h('button', {
          class: 'btn pm-ch-add',
          type: 'button',
          text: '＋ 新建频道',
          onclick: async () => {
            const rawName = await askText({
              title: '新建黑板频道',
              label: '频道名称（如 gpu-solver / verifier，不含 # 号）：',
              max: 32,
            });
            if (!rawName) return;
            const channel = rawName.trim().replace(/^#+/, '');
            if (!channel) return;
            say(`正在创建频道 #${channel}…`);
            const r = await mesh.channel({ action: 'create', projectId: curProj.id, channel });
            if (!r || !r.ok) {
              say((r && r.msg) || '创建频道失败');
              return;
            }
            activeChannel = channel;
            entries = [];
            renderChannels(curProj);
            await loadBoard();
            say(`已创建并切换到频道 #${channel}`);
          },
        })
      );
    }

    function renderTasks(p) {
      const tasks = p.tasks || [];
      const nodes = p.nodes || [];
      const counts = { pending: 0, in_progress: 0, review: 0, done: 0, blocked: 0 };
      for (const t of tasks) {
        if (Object.prototype.hasOwnProperty.call(counts, t.status)) counts[t.status]++;
      }
      const head = h('div', { class: 'pm-task-strip-head' },
        h('div', { class: 'pm-task-counts' },
          h('span', { class: 'pm-sec-title', text: `共享任务板 (${tasks.length})` }),
          ...TASK_STATUSES.map(([st, lbl]) =>
            h('span', { class: `pm-task-stat st-${st}`, text: `${lbl} ${counts[st]}` })
          )
        ),
        h('button', {
          class: 'btn go',
          type: 'button',
          text: '＋ 新建任务…',
          onclick: () => openNewTaskDialog(curProj),
        })
      );

      if (!tasks.length) {
        taskStripEl.replaceChildren(
          head,
          h('div', { class: 'pm-task-empty', text: '暂无共享任务。点击右上角「＋ 新建任务…」或由 Master 调度创建。' })
        );
        return;
      }

      const cards = tasks.map((t) => {
        const owner = nodes.find((n) => n.id === t.ownerNodeId);
        const ownerName = owner ? (owner.alias || owner.label || owner.id) : (t.ownerNodeId || '未指派');
        const statusSel = h('select', {
          class: `field pm-task-status st-${t.status || 'pending'}`,
          onchange: async (e) => {
            const nextStatus = e.target.value;
            statusSel.disabled = true;
            const r = await mesh.task({ action: 'update', projectId: curProj.id, taskId: t.id, status: nextStatus });
            statusSel.disabled = false;
            say(r.ok ? `已更新任务 [${t.id}] 状态` : (r.msg || '更新任务状态失败'));
          },
        },
          ...TASK_STATUSES.map(([st, lbl]) => h('option', { value: st, text: lbl, selected: (t.status || 'pending') === st }))
        );

        const deps = Array.isArray(t.blockedBy) ? t.blockedBy.filter(Boolean) : [];
        const bounds = Array.isArray(t.boundaries) ? t.boundaries.filter(Boolean)
          : (typeof t.boundaries === 'string' && t.boundaries.trim() ? [t.boundaries.trim()] : []);

        return h('div', { class: `pm-task-card st-${t.status || 'pending'}` },
          h('div', { class: 'pm-task-top' },
            h('code', { class: 'pm-task-id', text: `[${t.id}]` }),
            h('b', { class: 'pm-task-title', text: t.title || '(无标题)' }),
            h('span', { class: 'pm-task-owner', text: `@${ownerName}` }),
            statusSel
          ),
          (deps.length || bounds.length) ? h('div', { class: 'pm-task-pills' },
            ...deps.map((depId) => {
              const depTask = tasks.find((x) => x.id === depId);
              const depDone = depTask && depTask.status === 'done';
              return h('span', {
                class: `pm-dep-pill${depDone ? ' done' : ''}`,
                text: `前置: ${depId}${depDone ? ' (已完成)' : ''}`,
              });
            }),
            ...bounds.map((b) => h('code', { class: 'pm-bound-pill', text: b }))
          ) : null
        );
      });

      taskStripEl.replaceChildren(head, h('div', { class: 'pm-task-cards' }, ...cards));
    }

    function jumpToSeq(seqNum) {
      const targetId = `board-seq-${seqNum}`;
      let card = document.getElementById(targetId);
      if (!card && (filterKind !== 'all' || filterQuery)) {
        filterKind = 'all';
        filterQuery = '';
        kindSel.value = 'all';
        searchIn.value = '';
        renderFeed();
        card = document.getElementById(targetId);
      }
      if (!card) {
        say(`未在当前黑板记录中找到 #${seqNum}`);
        return;
      }
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    }

    function renderFeed() {
      if (loading && !entries.length) {
        feedEl.replaceChildren(h('div', { class: 'pm-empty', text: '正在加载共享黑板…' }));
        return;
      }
      const q = filterQuery.trim().toLowerCase();
      const filtered = entries.filter((e) => {
        if (filterKind !== 'all' && (e.kind || 'post') !== filterKind) return false;
        if (!q) return true;
        const hay = `#${e.seq} ${e.agent || ''} ${e.text || ''} ${(e.artifacts || []).join(' ')}`.toLowerCase();
        return hay.includes(q);
      });

      if (!filtered.length) {
        feedEl.replaceChildren(h('div', {
          class: 'pm-empty',
          text: entries.length ? '当前筛选条件下没有匹配的黑板条目。' : '共享黑板暂无记录，可在下方输入内容发送第一条消息。',
        }));
        return;
      }

      const cards = filtered.map((e) => {
        const kind = e.kind || 'post';
        const kindText = BOARD_KIND_LABELS[kind] || kind;
        const artifacts = Array.isArray(e.artifacts) ? e.artifacts.filter(Boolean) : [];
        const showAuditWarn = !!(e.audit && e.audit.checked && e.audit.isGit && !e.audit.ok);

        return h('article', { id: `board-seq-${e.seq}`, class: `pm-post-card kind-${kind}` },
          h('div', { class: 'pm-post-head' },
            h('span', { class: 'pm-post-seq', text: `#${e.seq}` }),
            h('span', { class: `pm-kind-badge kind-${kind}`, text: kindText }),
            h('b', { class: 'pm-post-author', text: e.agent || '系统' }),
            e.channel && e.channel !== 'main' ? h('span', { class: 'pm-post-chan', text: `[${e.channel}]` }) : null,
            e.done ? h('span', { class: 'pm-done-badge', text: '[done]' }) : null,
            h('span', { class: 'pm-post-time', text: e.ts ? ago(e.ts) : '' })
          ),
          renderPostBody(e.text, jumpToSeq),
          showAuditWarn ? h('div', { class: 'pm-audit-warn', text: formatAuditMessage(e.audit) }) : null,
          artifacts.length ? h('div', { class: 'pm-post-artifacts' },
            h('span', { class: 'pm-art-lbl', text: '产物:' }),
            ...artifacts.map((a) => h('code', {
              class: 'pm-art-pill',
              text: typeof a === 'string' ? a : (a.path || a.name || JSON.stringify(a)),
            }))
          ) : null
        );
      });

      feedEl.replaceChildren(...cards);
    }

    function insertMention(alias) {
      const token = `@${alias} `;
      const start = draftTa.selectionStart ?? draftTa.value.length;
      const end = draftTa.selectionEnd ?? draftTa.value.length;
      const before = draftTa.value.slice(0, start);
      const after = draftTa.value.slice(end);
      const sep = before && !/[\s\n]$/.test(before) ? ' ' : '';
      draftTa.value = before + sep + token + after;
      const pos = (before + sep + token).length;
      draftTa.focus();
      try { draftTa.setSelectionRange(pos, pos); } catch {}
      boardDrafts.set(curProj.id, draftTa.value);
    }

    function renderMentions(p) {
      const nodes = p.nodes || [];
      if (!nodes.length) {
        mentionBarEl.replaceChildren(h('span', { class: 'pm-hint', text: '快速 @ 点名：当前项目暂无节点' }));
        return;
      }
      mentionBarEl.replaceChildren(
        h('span', { class: 'pm-mention-lbl', text: '点名:' }),
        ...nodes.map((n) => {
          const alias = n.alias || n.label || n.id;
          return h('button', {
            class: 'btn pm-mention-btn',
            type: 'button',
            title: `${n.machine || ''} · ${n.role || 'worker'}`,
            text: `@${alias}`,
            onclick: () => insertMention(alias),
          });
        })
      );
    }

    async function loadBoard() {
      if (destroyed) return;
      const token = ++loadToken;
      const reqChan = activeChannel;
      loading = true;
      refreshBtn.disabled = true;
      if (!entries.length) renderFeed();
      const r = await mesh.getBoard(curProj.id, { limit: 200, channel: reqChan });
      if (destroyed || token !== loadToken) return;
      loading = false;
      refreshBtn.disabled = false;
      if (r && r.ok) {
        entries = Array.isArray(r.entries) ? r.entries : [];
        loadedSeq = typeof r.latestSeq === 'number' ? r.latestSeq : (curProj.boardSeq || 0);
      }
      renderFeed();
    }

    async function submitPost() {
      const text = draftTa.value.trim();
      if (!text) { draftTa.focus(); return; }
      sendBtn.disabled = true;
      say('正在发送消息到共享黑板…');
      const r = await mesh.postBoard({ projectId: curProj.id, channel: activeChannel, agent: '管理员', text });
      sendBtn.disabled = false;
      if (!r || !r.ok) {
        say((r && r.msg) || '发送到黑板失败');
        return;
      }
      draftTa.value = '';
      boardDrafts.delete(curProj.id);
      say('已发送到共享黑板');
      await loadBoard();
    }

    kindSel.addEventListener('change', () => { filterKind = kindSel.value; renderFeed(); });
    searchIn.addEventListener('input', () => { filterQuery = searchIn.value; renderFeed(); });
    refreshBtn.addEventListener('click', loadBoard);
    draftTa.addEventListener('input', () => { boardDrafts.set(curProj.id, draftTa.value); });
    draftTa.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitPost();
      }
    });
    sendBtn.addEventListener('click', submitPost);

    renderTasks(curProj);
    renderChannels(curProj);
    renderMentions(curProj);
    loadBoard();

    return {
      projectId: proj.id,
      root: rootEl,
      update(nextProj) {
        curProj = nextProj;
        renderTasks(nextProj);
        renderChannels(nextProj);
        renderMentions(nextProj);
        const nextSeq = typeof nextProj.boardSeq === 'number' ? nextProj.boardSeq : 0;
        if (loadedSeq !== -1 && nextSeq !== loadedSeq) loadBoard();
      },
      destroy() { destroyed = true; },
    };
  }

  // ---- Tab 1: Topology Graph (Dynamic SVG @mention Replay + Static Tiers) & Contracts ----
  function matchNodeByToken(nodes, tok) {
    const t = String(tok || '').trim().toLowerCase();
    if (!t) return null;
    return nodes.find((n) => {
      const a = String(n.alias || '').trim().toLowerCase();
      const l = String(n.label || '').trim().toLowerCase();
      const id = String(n.id || '').trim().toLowerCase();
      const r = String(n.role || '').trim().toLowerCase();
      return (a && a === t) || (l && l === t) || (id && id === t) || (r && r === t);
    }) || null;
  }

  function extractMentionTokens(entry) {
    if (Array.isArray(entry.mentions) && entry.mentions.length) {
      return { tokens: entry.mentions, mentionAll: !!entry.mentionAll };
    }
    const src = String(entry.text || '');
    const re = /@([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
    const tokens = [];
    let mentionAll = !!entry.mentionAll;
    let m;
    while ((m = re.exec(src)) !== null) {
      const tok = m[1];
      if (!tok) continue;
      if (tok.toLowerCase() === 'all') mentionAll = true;
      else tokens.push(tok);
    }
    return { tokens, mentionAll };
  }

  function clipRayToBox(cx, cy, tx, ty, hw, hh) {
    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const rx = Math.abs(ux) > 1e-4 ? hw / Math.abs(ux) : 1e9;
    const ry = Math.abs(uy) > 1e-4 ? hh / Math.abs(uy) : 1e9;
    const t = Math.min(rx, ry, dist * 0.45);
    return [cx + ux * t, cy + uy * t];
  }

  function nodeStatusInfo(n) {
    if (n.watchdogAlert || n.reviewStatus === 'blocked' || n.liveState === 'error') {
      return { color: '#c9184a', label: '告警/受阻' };
    }
    if (n.asking || n.reviewStatus === 'waiting_review' || n.liveState === 'waiting') {
      return { color: '#d97706', label: '等待确认/检视' };
    }
    if (['working', 'thinking', 'reading', 'message'].includes(n.liveState)) {
      return { color: '#16a34a', label: '执行中' };
    }
    if (n.reviewStatus === 'done' || n.reviewStatus === 'approved' || n.liveState === 'done') {
      return { color: '#0284c7', label: '已完成' };
    }
    return { color: '#808080', label: '空闲/离线' };
  }

  function createTopologyView(proj) {
    let curProj = proj;
    let entries = [];
    let selectedSeq = 0; // 0 = show all flows; >0 = highlight that post's flow
    let selectedNodeId = ''; // optional node filter/highlight
    let channelFilter = 'all';
    let loadedBoardSeq = -1;
    let loading = false;
    let destroyed = false;

    const actBar = h('div', { class: 'pm-act-bar' });
    const topoHead = h('div', { class: 'pm-stage-head' },
      h('b', { text: '协同组织拓扑图（上主控 · 中验收/协理 · 下执行 · 点击左栏帖子或卡片高亮信息流向）' }),
      h('div', { class: 'pm-stage-legend' },
        h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line' }), '黑板 @ 交互'),
        h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line hot' }), '当前选中流向'),
        h('span', { class: 'pm-leg-item' }, h('i', { class: 'pm-leg-line static' }), '层级委派')
      )
    );
    const svgLayer = svgEl('svg', { class: 'pm-stage-svg' });
    const tiersEl = h('div', { class: 'pm-stage-rows' });
    const stageEl = h('div', { class: 'pm-stage' }, svgLayer, tiersEl);
    const stageWrap = h('div', { class: 'pm-stage-wrap' }, stageEl);
    const topoPane = h('div', { class: 'pm-stage-pane' }, topoHead, stageWrap);

    const feedStatusEl = h('span', { class: 'pm-feed-status', text: '全部流向' });
    const chanSel = h('select', {
      class: 'field pm-feed-chan',
      onchange: () => {
        channelFilter = chanSel.value || 'all';
        renderFeed();
      },
    }, h('option', { value: 'all', text: '全部频道' }));
    const btnClearFocus = h('button', {
      class: 'btn',
      type: 'button',
      text: '显示全部',
      hidden: true,
      onclick: () => {
        selectedSeq = 0;
        selectedNodeId = '';
        renderStage();
        renderFeed();
      },
    });
    const btnRefresh = h('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadBoardHistory() });
    const feedHead = h('div', { class: 'pm-feed-head' },
      h('b', { text: '黑板看板流' }),
      feedStatusEl,
      h('div', { class: 'pm-feed-tools' }, chanSel, btnClearFocus, btnRefresh)
    );
    const feedListEl = h('div', { class: 'pm-feed-list' });
    const feedPane = h('div', { class: 'pm-feed-pane' }, feedHead, feedListEl);

    const staticBox = h('div', { class: 'pm-detail-lanes' });
    const rightCol = h('div', { class: 'pm-right-col' }, topoPane, staticBox);
    const splitBox = h('div', { class: 'pm-topo-split' }, feedPane, rightCol);
    const rootEl = h('div', { class: 'pm-graph-box' }, actBar, splitBox);

    let lastRenderNodes = [];
    let lastEdgeMap = new Map();
    let lastActiveNodes = new Set();
    let lastActiveEdges = new Set();
    let rafDraw = 0;

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleDrawLinks())
      : null;
    if (ro) ro.observe(stageWrap);

    function scheduleDrawLinks() {
      if (destroyed) return;
      if (rafDraw) cancelAnimationFrame(rafDraw);
      rafDraw = requestAnimationFrame(() => {
        rafDraw = 0;
        drawStageLinks();
      });
    }

    function renderActBar() {
      const nodes = curProj.nodes || [];
      actBar.replaceChildren(
        h('button', { class: 'btn go', type: 'button', onclick: () => openSpawnDialog(curProj) },
          h('img', { src: icon('console_prompt', true), alt: '', style: 'vertical-align:-3px;margin-right:4px' }), '在指定电脑派生新节点 (Spawn)'),
        h('button', { class: 'btn', type: 'button', text: '＋ 挂载已有会话到拓扑…', onclick: () => openBindSessionDialog(curProj) }),
        nodes.length >= 2 ? h('button', { class: 'btn', type: 'button', text: '⇄ 建立节点连线 (Master/Cowork)…', onclick: () => openLinkDialog(curProj) }) : null
      );
    }

    function dotClassOf(n) {
      if (n.watchdogAlert || n.reviewStatus === 'blocked' || n.liveState === 'error') return 'err';
      if (n.asking || n.reviewStatus === 'waiting_review' || n.liveState === 'waiting') return 'warn';
      if (['working', 'thinking', 'reading', 'message'].includes(n.liveState)) return 'on';
      if (n.reviewStatus === 'done' || n.reviewStatus === 'approved' || n.liveState === 'done') return 'done';
      return '';
    }

    function computeFlows(renderNodes) {
      const masters = renderNodes.filter((n) => n.role === 'master');
      const edgeMap = new Map();
      const activeNodes = new Set();
      const activeEdges = new Set();
      const hasPostFocus = selectedSeq > 0;
      const hasNodeFocus = !hasPostFocus && Boolean(selectedNodeId);

      for (const e of entries) {
        const seq = Number(e.seq) || 0;
        const fromNode = (e.nodeId && renderNodes.find((n) => n.id === e.nodeId))
          || matchNodeByToken(renderNodes, e.agent)
          || ((e.agent === 'Master' || e.agent === '管理员' || e.agent === '主控会话') ? masters[0] : null);
        if (!fromNode) continue;
        const { tokens, mentionAll } = extractMentionTokens(e);
        const targets = new Set();
        if (mentionAll) {
          for (const n of renderNodes) if (n.id !== fromNode.id) targets.add(n.id);
        }
        for (const tok of tokens) {
          const toNode = matchNodeByToken(renderNodes, tok);
          if (toNode && toNode.id !== fromNode.id) targets.add(toNode.id);
        }
        if (hasPostFocus && seq === selectedSeq) activeNodes.add(fromNode.id);
        for (const toId of targets) {
          const key = `${fromNode.id}->${toId}`;
          const prev = edgeMap.get(key) || { from: fromNode.id, to: toId, count: 0, lastSeq: 0 };
          prev.count += 1;
          prev.lastSeq = seq;
          edgeMap.set(key, prev);
          if (hasPostFocus && seq === selectedSeq) {
            activeEdges.add(key);
            activeNodes.add(toId);
          } else if (hasNodeFocus && (fromNode.id === selectedNodeId || toId === selectedNodeId)) {
            activeEdges.add(key);
            activeNodes.add(fromNode.id);
            activeNodes.add(toId);
          }
        }
      }
      if (hasNodeFocus) activeNodes.add(selectedNodeId);
      return { edgeMap, activeNodes, activeEdges };
    }

    function renderStage() {
      const nodes = curProj.nodes || [];
      if (!nodes.length) {
        tiersEl.replaceChildren(h('div', { class: 'pm-empty', text: '暂无拓扑节点，请先派生或挂载会话节点。' }));
        svgLayer.replaceChildren();
        return;
      }

      const hasMaster = nodes.some((n) => n.role === 'master');
      const renderNodes = hasMaster
        ? nodes
        : [{ id: '__virtual_master__', alias: 'Master (主控)', role: 'master', machine: '', tool: '', liveState: 'idle', reviewStatus: 'running' }, ...nodes];

      const { edgeMap, activeNodes, activeEdges } = computeFlows(renderNodes);
      lastRenderNodes = renderNodes;
      lastEdgeMap = edgeMap;
      lastActiveNodes = activeNodes;
      lastActiveEdges = activeEdges;

      const hasFocus = selectedSeq > 0 || Boolean(selectedNodeId);
      const masters = renderNodes.filter((n) => n.role === 'master');
      const mids = renderNodes.filter((n) => n.role === 'verifier' || n.role === 'peer');
      const workers = renderNodes.filter((n) => n.role !== 'master' && n.role !== 'verifier' && n.role !== 'peer');

      // 3-row top-down org chart (三省六部层级：1 行主控中枢 -> 2 行督察验收/平级协理 -> 3 行并行执行部)
      const rows = [
        ['中枢主控层 · Master', 'tier-master', masters],
        ['督察验收 / 协理层 · Verifier & Peers', 'tier-mid', mids],
        ['并行执行层 · Workers', 'tier-worker', workers],
      ].filter(([, , list]) => list.length > 0);

      tiersEl.dataset.rows = String(rows.length);
      tiersEl.replaceChildren(...rows.map(([title, tierCls, list], rowIdx) =>
        h('div', { class: `pm-tier-row ${tierCls}`, dataset: { tierRow: String(rowIdx) } },
          h('div', { class: 'pm-tier-row-lbl', text: title }),
          h('div', { class: 'pm-tier-row-cards' },
            ...list.map((n) => {
              const st = nodeStatusInfo(n);
              const isHot = activeNodes.has(n.id);
              const isSel = selectedNodeId === n.id;
              const dimmed = hasFocus && !isHot;
              const isAlert = Boolean(n.watchdogAlert || n.reviewStatus === 'blocked' || n.liveState === 'error');
              const isOff = !n.liveState || n.liveState === 'offline' || n.liveState === 'history';
              const modelTag = [n.tool, n.model].filter(Boolean).join(':');
              const roleBadge = n.role === 'master' ? 'MASTER' : n.role === 'verifier' ? 'VERIFIER' : n.role === 'peer' ? 'PEER' : 'WORKER';
              const cardCls = [
                'pm-tcard',
                `role-${n.role || 'worker'}`,
                isHot ? 'hot' : '',
                isSel ? 'sel' : '',
                dimmed ? 'dim' : '',
                isAlert ? 'alert' : '',
                isOff && n.id !== '__virtual_master__' ? 'off' : '',
              ].filter(Boolean).join(' ');

              return h('div', {
                class: cardCls,
                dataset: { nodeId: n.id, tierRow: String(rowIdx) },
                title: `${n.alias || n.id} · ${st.label}${n.goal ? '\n目标: ' + n.goal : ''}`,
                onclick: () => {
                  selectedSeq = 0;
                  selectedNodeId = selectedNodeId === n.id ? '' : n.id;
                  renderStage();
                  renderFeed();
                },
              },
                h('div', { class: 'pm-tcard-hd' },
                  h('span', { class: `pm-tdot ${dotClassOf(n)}` }),
                  h('span', { class: 'pm-tcard-name', text: n.alias || n.label || n.id }),
                  h('span', { class: 'pm-tcard-role', text: roleBadge })
                ),
                h('div', { class: 'pm-tcard-sub', text: [n.machine || '主控会话', modelTag].filter(Boolean).join(' · ') }),
                h('div', { class: 'pm-tcard-pills' },
                  n.archived ? h('span', { class: 'pm-tpill', text: '已归档' }) : h('span', { class: `pm-tpill st-${dotClassOf(n) || 'idle'}`, text: st.label }),
                  n.pool ? h('span', { class: 'pm-tpill', text: n.pool }) : null,
                  n.workspaceMode === 'worktree' ? h('span', { class: 'pm-tpill wt', text: 'worktree' }) : null
                )
              );
            })
          )
        )
      ));

      scheduleDrawLinks();
    }

    function drawStageLinks() {
      if (destroyed) return;
      const W = Math.max(stageEl.scrollWidth, stageEl.clientWidth, 1);
      const H = Math.max(stageEl.scrollHeight, stageEl.clientHeight, 1);
      svgLayer.setAttribute('width', String(W));
      svgLayer.setAttribute('height', String(H));
      svgLayer.setAttribute('viewBox', `0 0 ${W} ${H}`);

      const stageRect = stageEl.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;

      const cardBoxes = new Map();
      for (const el of tiersEl.querySelectorAll('.pm-tcard')) {
        const nid = el.dataset.nodeId;
        const r = el.getBoundingClientRect();
        cardBoxes.set(nid, {
          left: r.left - stageRect.left,
          right: r.right - stageRect.left,
          top: r.top - stageRect.top,
          bottom: r.bottom - stageRect.top,
          cx: r.left - stageRect.left + r.width / 2,
          cy: r.top - stageRect.top + r.height / 2,
          w: r.width,
          h: r.height,
        });
      }

      const defs = svgEl('defs', {},
        svgEl('marker', { id: 'pm-arr-base', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
          svgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#8a94a6' })
        ),
        svgEl('marker', { id: 'pm-arr-dyn', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
          svgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#1d6fd8' })
        ),
        svgEl('marker', { id: 'pm-arr-hot', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
          svgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#c43e00' })
        )
      );
      const baseG = svgEl('g');
      const linesG = svgEl('g');
      const badgesG = svgEl('g');
      svgLayer.replaceChildren(defs, baseG, linesG, badgesG);

      const hasFocus = selectedSeq > 0 || Boolean(selectedNodeId);

      function curveBetween(a, b, offset = 0) {
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const sameRow = Math.abs(dy) < 28;
        let x1, y1, x2, y2, c1x, c1y, c2x, c2y, mx, my;
        if (sameRow) {
          // Same-row peer/worker horizontal arc hovering gently above or below cards
          const ltr = dx >= 0;
          x1 = a.cx + (ltr ? a.w * 0.22 : -a.w * 0.22);
          x2 = b.cx + (ltr ? -b.w * 0.22 : b.w * 0.22);
          const archDir = offset < 0 ? 1 : -1; // -1 = above row, +1 = below row
          y1 = archDir < 0 ? a.top : a.bottom;
          y2 = archDir < 0 ? b.top : b.bottom;
          const lift = Math.min(40, Math.max(22, Math.abs(dx) * 0.14)) * archDir;
          c1x = x1 + (x2 - x1) * 0.28;
          c1y = y1 + lift;
          c2x = x1 + (x2 - x1) * 0.72;
          c2y = y2 + lift;
          mx = 0.125 * x1 + 0.375 * c1x + 0.375 * c2x + 0.125 * x2;
          my = 0.125 * y1 + 0.375 * c1y + 0.375 * c2y + 0.125 * y2;
        } else {
          // Top-down hierarchical S-curve between rows (row 1 Master -> row 2 Verifier -> row 3 Workers)
          const ttb = dy >= 0;
          x1 = a.cx + offset * 0.55;
          y1 = ttb ? a.bottom : a.top;
          x2 = b.cx + offset * 0.55;
          y2 = ttb ? b.top : b.bottom;
          const span = Math.max(26, Math.abs(y2 - y1) * 0.48);
          c1x = x1 + offset * 0.8;
          c1y = y1 + (ttb ? span : -span);
          c2x = x2 + offset * 0.8;
          c2y = y2 + (ttb ? -span : span);
          mx = 0.125 * x1 + 0.375 * c1x + 0.375 * c2x + 0.125 * x2;
          my = 0.125 * y1 + 0.375 * c1y + 0.375 * c2y + 0.125 * y2;
        }
        return {
          d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
          x1, y1, x2, y2, mx, my,
        };
      }

      // Faint static delegation edges (Master -> Worker / Cowork)
      for (const se of curProj.edges || []) {
        const a = cardBoxes.get(se.from);
        const b = cardBoxes.get(se.to);
        if (!a || !b) continue;
        if (lastEdgeMap.has(`${se.from}->${se.to}`)) continue;
        const g = curveBetween(a, b, 0);
        baseG.append(svgEl('path', {
          d: g.d,
          fill: 'none',
          stroke: '#8a94a6',
          'stroke-width': '1.2',
          'stroke-opacity': hasFocus ? '0.18' : '0.45',
          'stroke-dasharray': '4 3',
          'marker-end': 'url(#pm-arr-base)',
        }));
      }

      // Dynamic @mention links
      const edgeEntries = [...lastEdgeMap.entries()].sort((a, b) => Number(lastActiveEdges.has(a[0])) - Number(lastActiveEdges.has(b[0])));
      for (const [edgeKey, ed] of edgeEntries) {
        const a = cardBoxes.get(ed.from);
        const b = cardBoxes.get(ed.to);
        if (!a || !b) continue;
        const hasRev = lastEdgeMap.has(`${ed.to}->${ed.from}`);
        const offset = hasRev ? (ed.from < ed.to ? -16 : 16) : 0;
        const geom = curveBetween(a, b, offset);
        const isHot = lastActiveEdges.has(edgeKey);
        const dimmed = hasFocus && !isHot;
        const color = isHot ? '#c43e00' : '#1d6fd8';
        const sw = isHot ? 2.6 : Math.min(3.2, 1.4 + Math.log2(ed.count + 1) * 0.65);

        linesG.append(svgEl('path', {
          d: geom.d,
          class: isHot ? 'pm-link-hot' : '',
          fill: 'none',
          stroke: color,
          'stroke-width': sw.toFixed(2),
          'stroke-linecap': 'round',
          'stroke-opacity': isHot ? '0.98' : dimmed ? '0.16' : '0.78',
          'marker-end': isHot ? 'url(#pm-arr-hot)' : 'url(#pm-arr-dyn)',
        }));
        linesG.append(svgEl('circle', {
          cx: geom.x1.toFixed(1),
          cy: geom.y1.toFixed(1),
          r: isHot ? '3' : '2.4',
          fill: color,
          'fill-opacity': isHot ? '1' : dimmed ? '0.2' : '0.8',
        }));

        const lblText = isHot && selectedSeq ? `#${selectedSeq}` : `${ed.count}次`;
        const pillW = Math.max(24, lblText.length * 7 + 10);
        const pillH = 16;
        const bg = svgEl('g', { opacity: dimmed ? '0.22' : '1' },
          svgEl('rect', {
            x: (geom.mx - pillW / 2).toFixed(1),
            y: (geom.my - pillH / 2).toFixed(1),
            width: pillW,
            height: pillH,
            rx: '3',
            fill: isHot ? '#fff3cd' : '#ffffff',
            stroke: color,
            'stroke-width': isHot ? '1.3' : '1',
          }),
          svgEl('text', {
            x: geom.mx.toFixed(1),
            y: (geom.my + 0.5).toFixed(1),
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            'font-size': '9.5',
            'font-family': 'Consolas, "Microsoft YaHei", monospace',
            'font-weight': isHot ? 'bold' : 'normal',
            fill: isHot ? '#8a2c00' : '#1f2937',
            text: lblText,
          })
        );
        badgesG.append(bg);
      }
    }

    function renderFeed() {
      const channels = [...new Set(entries.map((e) => e.channel || 'main'))];
      const curChan = channels.includes(channelFilter) ? channelFilter : 'all';
      channelFilter = curChan;
      chanSel.replaceChildren(
        h('option', { value: 'all', text: `全部频道 (${entries.length})`, selected: curChan === 'all' }),
        ...channels.map((ch) => h('option', {
          value: ch,
          text: `#${ch}`,
          selected: curChan === ch,
        }))
      );

      btnClearFocus.hidden = !selectedSeq && !selectedNodeId;
      if (loading && !entries.length) {
        feedStatusEl.textContent = '正在加载…';
        feedListEl.replaceChildren(h('div', { class: 'pm-empty', text: '正在加载黑板消息流…' }));
        return;
      }
      let visible = curChan === 'all' ? entries : entries.filter((e) => (e.channel || 'main') === curChan);
      if (selectedNodeId) {
        const selNode = lastRenderNodes.find((n) => n.id === selectedNodeId);
        const selAlias = selNode ? (selNode.alias || selNode.id) : selectedNodeId;
        feedStatusEl.textContent = `已聚焦节点「${selAlias}」`;
      } else if (selectedSeq) {
        feedStatusEl.textContent = `已高亮 #${selectedSeq} 流向`;
      } else {
        feedStatusEl.textContent = `共 ${visible.length} 条 · 点击看流向`;
      }

      if (!visible.length) {
        feedListEl.replaceChildren(h('div', { class: 'pm-empty', text: '黑板尚无消息，节点派单或汇报后会实时出现在这里。' }));
        return;
      }

      const rows = visible.map((e) => {
        const seq = Number(e.seq) || 0;
        const isSel = selectedSeq === seq;
        const kLabel = BOARD_KIND_LABELS[e.kind] || e.kind || '帖子';
        const { tokens, mentionAll } = extractMentionTokens(e);
        const body = String(e.text || '').trim();
        const shortBody = body.length > 240 ? body.slice(0, 240) + '…' : body;
        const timeStr = e.ts ? ago(e.ts) : '';
        const auditBadge = e.audit && e.audit.checked
          ? h('span', { class: `pm-feed-audit ${e.audit.ok ? 'ok' : 'bad'}`, text: e.audit.ok ? 'gitAudit OK' : 'gitAudit 告警' })
          : null;

        return h('div', {
          class: `pm-feed-item${isSel ? ' sel' : ''}`,
          role: 'button',
          tabindex: '0',
          onclick: () => {
            selectedNodeId = '';
            selectedSeq = selectedSeq === seq ? 0 : seq;
            renderStage();
            renderFeed();
          },
        },
          h('div', { class: 'pm-feed-meta' },
            h('span', { class: 'pm-feed-seq', text: `#${seq}` }),
            h('b', { class: 'pm-feed-author', text: e.agent || '系统' }),
            h('span', { class: `pm-feed-kind k-${e.kind || 'post'}`, text: kLabel }),
            e.channel && e.channel !== 'main' ? h('span', { class: 'pm-feed-ch', text: `#${e.channel}` }) : null,
            mentionAll ? h('span', { class: 'pm-feed-mention', text: '-> @all' }) : null,
            ...tokens.slice(0, 3).map((t) => h('span', { class: 'pm-feed-mention', text: `-> @${t}` })),
            auditBadge,
            h('span', { class: 'pm-feed-time', text: timeStr })
          ),
          h('div', { class: 'pm-feed-body', text: shortBody })
        );
      });
      feedListEl.replaceChildren(...rows);
      if (!selectedSeq) feedListEl.scrollTop = feedListEl.scrollHeight;
    }

    function renderStatic() {
      const nodes = curProj.nodes || [];
      const edges = curProj.edges || [];
      if (!nodes.length) {
        staticBox.replaceChildren(h('div', { class: 'pm-empty', text: '该项目还没有会话节点。你可以从上方「挂载已有会话到拓扑」或「在远程电脑派生新节点」。' }));
        return;
      }
      const masters = nodes.filter((n) => n.role === 'master');
      const peers = nodes.filter((n) => n.role === 'peer');
      const verifiers = nodes.filter((n) => n.role === 'verifier');
      const workers = nodes.filter((n) => n.role !== 'master' && n.role !== 'peer' && n.role !== 'verifier');

      const edgeList = edges.map((e) => {
        const fn = nodes.find((n) => n.id === e.from);
        const tn = nodes.find((n) => n.id === e.to);
        if (!fn || !tn) return null;
        return h('div', { class: 'pm-edge-pill' },
          h('span', { class: 'pm-edge-from', text: `${fn.alias || fn.id} (${fn.machine})` }),
          h('span', { class: 'pm-edge-arrow', text: e.type === 'cowork' ? ' <-> 平级协同 (Cowork) <-> ' : ' --(主从委派 Master->Worker)--> ' }),
          h('span', { class: 'pm-edge-to', text: `${tn.alias || tn.id} (${tn.machine})` }),
          h('button', { class: 'pm-edge-del', type: 'button', title: '断开连线', text: '×', onclick: async () => {
            await mesh.removeEdge(curProj.id, e.from, e.to);
          } })
        );
      }).filter(Boolean);

      const lanes = h('div', { class: 'pm-lanes' },
        masters.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '主控层 (Master)' }), ...masters.map((n) => nodeCard(curProj, n))) : null,
        peers.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '平级协作层 (Cowork Peers)' }), ...peers.map((n) => nodeCard(curProj, n))) : null,
        verifiers.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '验收层 (Verifier)' }), ...verifiers.map((n) => nodeCard(curProj, n))) : null,
        workers.length ? h('div', { class: 'pm-lane' }, h('div', { class: 'pm-lane-hd', text: '执行层 (Workers)' }), ...workers.map((n) => nodeCard(curProj, n))) : null
      );

      staticBox.replaceChildren(
        edgeList.length ? h('div', { class: 'pm-edges-bar' }, h('b', { text: '静态拓扑关系边：' }), ...edgeList) : null,
        lanes
      );
    }

    async function loadBoardHistory() {
      if (destroyed) return;
      loading = true;
      renderFeed();
      const r = await mesh.getBoard(curProj.id, { limit: 200 });
      if (destroyed) return;
      loading = false;
      if (r && r.ok) {
        entries = (Array.isArray(r.entries) ? r.entries : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
        const nextMax = entries.length ? Math.max(...entries.map((e) => Number(e.seq) || 0)) : 0;
        loadedBoardSeq = typeof r.latestSeq === 'number' ? r.latestSeq : (curProj.boardSeq || nextMax);
        if (selectedSeq && !entries.some((e) => Number(e.seq) === selectedSeq)) selectedSeq = 0;
      }
      renderStage();
      renderFeed();
    }

    renderActBar();
    renderStage();
    renderFeed();
    renderStatic();
    loadBoardHistory();

    return {
      projectId: proj.id,
      root: rootEl,
      update(nextProj) {
        curProj = nextProj;
        renderActBar();
        renderStatic();
        const nextSeq = typeof nextProj.boardSeq === 'number' ? nextProj.boardSeq : 0;
        if (loadedBoardSeq !== -1 && nextSeq !== loadedBoardSeq) {
          loadBoardHistory();
        } else {
          renderStage();
        }
      },
      destroy() {
        destroyed = true;
        if (rafDraw) cancelAnimationFrame(rafDraw);
        if (ro) ro.disconnect();
      },
    };
  }

  // ---- Tab 2: Roles & Model Pools (Phase 2) ----
  function roleOriginOf(r) {
    const src = String((r && (r.source || r.origin || r.status)) || '').toLowerCase();
    if ((r && (r.overridden || r.isOverridden)) || src === 'overridden') return 'overridden';
    if ((r && (r.builtin || r.isBuiltin)) || src === 'builtin') return 'builtin';
    return 'custom';
  }

  function formatResetAt(resetAt) {
    if (!resetAt) return '';
    if (typeof resetAt === 'number') {
      const diffMin = Math.ceil((resetAt - Date.now()) / 60000);
      if (diffMin > 0 && diffMin < 24 * 60) return `约 ${diffMin} 分后恢复`;
      const d = new Date(resetAt);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 恢复`;
    }
    return String(resetAt);
  }

  function createRolesTab() {
    let roles = [];
    let selectedRole = null;
    let roleDraft = '';
    let roleDirty = false;
    let rolesLoading = false;
    let rolesErr = '';

    let poolsMap = {};       // poolName -> [{ harness, model, magpieProvider, quirks, ... }]
    let poolShapes = {};     // poolName -> 'array' | { objMeta }
    let healthMap = {};      // optional top-level health map
    let poolsDirty = false;
    let poolsLoading = false;
    let poolsErr = '';
    let probeHarness = 'agy';
    let destroyed = false;

    const rolesSec = h('section', { class: 'pm-roles-sec' });
    const poolsSec = h('section', { class: 'pm-roles-sec' });
    const harnessList = h('datalist', { id: 'pm-harness-list' },
      ...['claude', 'agy', 'codex', 'opencode', 'kiro', 'devin'].map((x) => h('option', { value: x }))
    );
    const rootEl = h('div', { class: 'pm-roles-wrap' }, harnessList, rolesSec, poolsSec);

    function openNewRoleDialog() {
      const nameIn = h('input', { class: 'field', type: 'text', placeholder: '例如：solver-runner（仅限字母数字与 -/_）' });
      const sumIn = h('input', { class: 'field', type: 'text', placeholder: '一句话适用场景，如：运行数值求解器并整理 RCS 误差' });
      const poolNames = Object.keys(poolsMap);
      const poolChoices = poolNames.length ? poolNames : ['fast-coder', 'flagship', 'heavy-reasoner', 'image-gen'];
      const poolSel = h('select', { class: 'field' },
        ...poolChoices.map((p) => h('option', { value: p, text: p }))
      );
      const wsSel = h('select', { class: 'field' },
        h('option', { value: 'inherit', text: 'inherit（继承项目工作区）' }),
        h('option', { value: 'worktree', text: 'worktree（独立 Git 分支工作树）' })
      );
      const roChk = h('input', { type: 'checkbox' });

      const done = () => wrap.remove();
      const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
        h('div', { class: 'dlgt' }, h('span', { text: '新建自定义角色模板' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
        h('div', { class: 'dlgb' },
          h('label', { class: 'xnote-lbl', text: '角色标识 (filename.md)：' }),
          nameIn,
          h('label', { class: 'xnote-lbl', text: '适用场景一句话说明：' }),
          sumIn,
          h('label', { class: 'xnote-lbl', text: '默认绑定模型组 (defaultPool) 与工作区模式：' }),
          h('div', { style: 'display:flex;gap:6px' }, poolSel, wsSel),
          h('label', { class: 'pm-chk', style: 'margin-top:6px' }, roChk, '只读角色（禁止修改业务代码，仅核查与评审）'),
          h('div', { class: 'dlga' },
            h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
            h('button', { class: 'btn go', type: 'submit', text: '创建角色' })
          )
        )
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nameIn.value.trim().replace(/\.md$/i, '');
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)) {
          nameIn.focus();
          say('角色标识仅允许字母、数字、连字符和下划线');
          return;
        }
        const summary = sumIn.value.trim() || '自定义协同角色';
        const raw = [
          '---',
          `name: ${name}`,
          `summary: ${summary}`,
          `defaultPool: ${poolSel.value}`,
          `workspaceMode: ${wsSel.value}`,
          `readOnly: ${roChk.checked ? 'true' : 'false'}`,
          '---',
          '',
          `# ${name} 行为规范`,
          '',
          '- 严格遵守授权目录与 Stop Gate 边界。',
          '- 通过 mesh_board_post 发布进展并用 #seq 引用证据。',
          roChk.checked ? '- 仅核查与复现，不直接修改业务代码。' : '- 完成后附带 [done] 并 @master 或 @verifier。',
          '',
        ].join('\n');
        done();
        say(`正在创建角色「${name}」…`);
        const r = await mesh.saveRole(name, raw);
        if (!r || !r.ok) {
          say((r && r.msg) || '创建角色失败');
          return;
        }
        selectedRole = name;
        roleDirty = false;
        say(`已创建角色「${name}」`);
        await loadRoles();
      });
      form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
      const wrap = h('div', { class: 'dlg' }, form);
      wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
      document.body.append(wrap);
      nameIn.focus();
    }

    function renderRolesSection() {
      const originLabel = { builtin: '内置', overridden: '已覆盖默认', custom: '自定义' };
      const head = h('div', { class: 'pm-act-bar' },
        h('b', { class: 'pm-sec-title', text: 'Section A · 角色模板库 (mesh-roles/*.md)' }),
        h('button', { class: 'btn go', type: 'button', text: '＋ 新建自定义角色…', onclick: openNewRoleDialog }),
        h('button', { class: 'btn', type: 'button', text: '刷新', disabled: rolesLoading, onclick: loadRoles }),
        h('span', { class: 'pm-hint', text: rolesErr || '点击左侧角色模板可编辑 .md 规范；覆盖内置模板后可随时恢复默认。' })
      );

      if (rolesLoading && !roles.length) {
        rolesSec.replaceChildren(head, h('div', { class: 'pm-empty', text: '正在加载角色模板库…' }));
        return;
      }

      if (!roles.length) {
        rolesSec.replaceChildren(head, h('div', { class: 'pm-empty', text: rolesErr || '暂未发现角色模板，请检查后端 /api/mesh/roles 接口或点击「＋ 新建自定义角色…」。' }));
        return;
      }

      const cur = roles.find((r) => r.name === selectedRole) || roles[0];
      if (cur && cur.name !== selectedRole) {
        selectedRole = cur.name;
        roleDraft = cur.raw || '';
        roleDirty = false;
      }

      const listEl = h('div', { class: 'pm-role-list' },
        ...roles.map((r) => {
          const orig = roleOriginOf(r);
          const isSel = cur && r.name === cur.name;
          return h('button', {
            class: 'pm-role-item' + (isSel ? ' sel' : ''),
            type: 'button',
            onclick: async () => {
              if (cur && r.name === cur.name) return;
              if (roleDirty) {
                const ok = await confirmBox(`角色「${cur.name}」有未保存修改，确定切换并放弃当前修改吗？`);
                if (!ok) return;
              }
              selectedRole = r.name;
              roleDraft = r.raw || '';
              roleDirty = false;
              renderRolesSection();
            },
          },
            h('div', { class: 'pm-role-item-top' },
              h('b', { text: r.name }),
              h('span', { class: `pm-role-badge ${orig}`, text: originLabel[orig] }),
              r.readOnly ? h('span', { class: 'pm-role-badge ro', text: '只读' }) : null,
              r.defaultPool ? h('span', { class: 'pm-role-badge pool', text: r.defaultPool }) : null
            ),
            h('div', { class: 'pm-role-item-sum', text: r.summary || r.description || '（无描述）' })
          );
        })
      );

      const curOrigin = cur ? roleOriginOf(cur) : 'custom';
      const dirtyTag = h('span', { class: 'pm-badge warn', text: '未保存', hidden: !roleDirty });
      const ta = h('textarea', {
        class: 'field pm-role-ta',
        spellcheck: 'false',
        oninput: (e) => {
          roleDraft = e.target.value;
          if (!roleDirty) {
            roleDirty = true;
            dirtyTag.hidden = false;
          }
        },
      });
      ta.value = roleDraft;

      const saveBtn = h('button', {
        class: 'btn go',
        type: 'button',
        text: '保存角色',
        disabled: !cur,
        onclick: async () => {
          if (!cur) return;
          say(`正在保存角色「${cur.name}」…`);
          const r = await mesh.saveRole(cur.name, ta.value);
          if (!r || !r.ok) {
            say((r && r.msg) || '保存角色失败');
            return;
          }
          roleDirty = false;
          say(`已保存角色「${cur.name}」`);
          await loadRoles();
        },
      });

      const resetBtn = h('button', {
        class: 'btn',
        type: 'button',
        text: '恢复默认',
        disabled: !cur || curOrigin !== 'overridden',
        title: curOrigin === 'overridden' ? '删除用户覆盖层，恢复仓库内置默认模板' : '仅已覆盖的内置角色可恢复默认',
        onclick: async () => {
          if (!cur || curOrigin !== 'overridden') return;
          if (!(await confirmBox(`确定将「${cur.name}」恢复为内置默认模板吗？当前自定义修改将被移除。`, { danger: true }))) return;
          say(`正在恢复默认角色「${cur.name}」…`);
          const r = await mesh.resetRole(cur.name);
          if (!r || !r.ok) {
            say((r && r.msg) || '恢复默认失败');
            return;
          }
          roleDirty = false;
          say(`已恢复默认角色「${cur.name}」`);
          await loadRoles();
        },
      });

      const editorEl = h('div', { class: 'pm-role-editor' },
        h('div', { class: 'pm-role-ed-head' },
          h('b', { text: cur ? `正在编辑：${cur.name}.md` : '未选择角色' }),
          cur ? h('span', { class: `pm-role-badge ${curOrigin}`, text: originLabel[curOrigin] }) : null,
          cur && cur.readOnly ? h('span', { class: 'pm-role-badge ro', text: '只读约束' }) : null,
          cur && cur.defaultPool ? h('span', { class: 'pm-role-badge pool', text: `默认模型池: ${cur.defaultPool}` }) : null,
          dirtyTag
        ),
        ta,
        h('div', { class: 'pm-role-ed-actions' }, saveBtn, resetBtn)
      );

      rolesSec.replaceChildren(head, h('div', { class: 'pm-roles-grid' }, listEl, editorEl));
    }

    function candidateHealth(c) {
      const hObj = (c && typeof c.health === 'object' && c.health)
        || healthMap[`${c.harness}:${c.model}`]
        || healthMap[`${c.harness}/${c.model}`]
        || null;
      const rawStatus = String((hObj && (hObj.status || hObj.state)) || (typeof c.health === 'string' ? c.health : '') || c.status || c.state || 'healthy').toLowerCase();
      const rem = (hObj && (hObj.magpieInfo ?? hObj.remaining ?? hObj.magpieRemaining ?? hObj.quotaRemaining ?? hObj.balance))
        ?? c.magpieInfo ?? c.remaining ?? c.magpieRemaining ?? c.quotaRemaining;
      const resetAt = (hObj && (hObj.resetAt ?? hObj.cooldownUntil)) ?? c.resetAt ?? c.cooldownUntil;
      const reason = (hObj && (hObj.reason || hObj.msg)) || c.reason || '';

      if (rawStatus === 'cooldown' || rawStatus === 'cooling') {
        const rs = formatResetAt(resetAt);
        return { cls: 'cool', label: `冷却中${rs ? ' (' + rs + ')' : ''}`, isCooldown: true, title: reason };
      }
      if (rawStatus === 'exhausted' || rawStatus === 'depleted') {
        const remStr = rem != null && rem !== '' ? ` · ${rem}` : '';
        return { cls: 'warn', label: `耗尽${remStr}`, isCooldown: true, title: reason };
      }
      if (rawStatus === 'low_quota' || rawStatus === 'low' || rawStatus === 'warn') {
        const remStr = rem != null && rem !== '' ? ` (${rem})` : '';
        return { cls: 'warn', label: `低额度${remStr}`, isCooldown: false, title: reason };
      }
      const remStr = rem != null && rem !== '' ? ` (${rem})` : '';
      return { cls: 'ok', label: `健康${remStr}`, isCooldown: false, title: reason };
    }

    function serializePools() {
      const out = {};
      for (const [poolName, list] of Object.entries(poolsMap)) {
        const cleanList = list.map((c) => {
          const item = {
            harness: String(c.harness || '').trim(),
            model: String(c.model || '').trim(),
          };
          if (String(c.magpieProvider || '').trim()) item.magpieProvider = String(c.magpieProvider).trim();
          if (String(c.quirks || '').trim()) item.quirks = String(c.quirks).trim();
          return item;
        }).filter((c) => c.harness || c.model);

        const shape = poolShapes[poolName];
        if (shape && typeof shape === 'object' && !Array.isArray(shape)) {
          out[poolName] = { ...shape, candidates: cleanList };
        } else {
          out[poolName] = cleanList;
        }
      }
      return out;
    }

    function renderPoolsSection() {
      const poolNames = Object.keys(poolsMap);
      const harnessesInPools = new Set(['claude', 'agy', 'codex', 'opencode', 'kiro']);
      for (const list of Object.values(poolsMap)) {
        for (const c of list) if (c.harness) harnessesInPools.add(c.harness);
      }
      const harnessOpts = [...harnessesInPools];
      if (!harnessOpts.includes(probeHarness)) probeHarness = harnessOpts[0] || 'agy';

      const probeSel = h('select', {
        class: 'field',
        onchange: (e) => { probeHarness = e.target.value; },
      }, ...harnessOpts.map((hn) => h('option', { value: hn, text: hn, selected: hn === probeHarness })));

      const head = h('div', { class: 'pm-act-bar' },
        h('b', { class: 'pm-sec-title', text: 'Section B · 模型能力池与余额健康 (Model Pools)' }),
        h('button', {
          class: 'btn go',
          type: 'button',
          text: poolsDirty ? '保存模型池 *' : '保存模型池',
          onclick: async () => {
            say('正在保存模型能力池配置…');
            const r = await mesh.savePools(serializePools());
            if (!r || !r.ok) {
              say((r && r.msg) || '保存模型池失败');
              return;
            }
            poolsDirty = false;
            say('已保存模型能力池配置');
            await loadPools();
          },
        }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: '复位全部熔断',
          onclick: async () => {
            say('正在复位全部模型冷却熔断状态…');
            const r = await mesh.resetPoolCooldown();
            say(r && r.ok ? '已复位全部熔断状态' : ((r && r.msg) || '复位失败'));
            await loadPools();
          },
        }),
        probeSel,
        h('button', {
          class: 'btn',
          type: 'button',
          text: '按需探测余额',
          onclick: async () => {
            say(`正在探测 ${probeHarness} 可用性与额度…`);
            const r = await mesh.probePool(probeHarness);
            say(r && r.ok ? `已完成 ${probeHarness} 余额探测` : ((r && r.msg) || '探测失败'));
            await loadPools();
          },
        }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: '＋ 新建模型池…',
          onclick: async () => {
            const name = await askText({ title: '新建模型能力池', label: '模型池名称（如 fast-coder / flagship / heavy-reasoner）：', max: 40 });
            if (!name) return;
            if (poolsMap[name]) return say(`模型池「${name}」已存在`);
            poolsMap[name] = [{ harness: 'claude', model: '', magpieProvider: '', quirks: '' }];
            poolShapes[name] = 'array';
            poolsDirty = true;
            renderPoolsSection();
          },
        }),
        h('button', { class: 'btn', type: 'button', text: '刷新', disabled: poolsLoading, onclick: loadPools })
      );

      if (poolsLoading && !poolNames.length) {
        poolsSec.replaceChildren(head, h('div', { class: 'pm-empty', text: '正在加载模型能力池…' }));
        return;
      }

      if (!poolNames.length) {
        poolsSec.replaceChildren(head, h('div', { class: 'pm-empty', text: poolsErr || '暂无模型能力池配置，可点击「＋ 新建模型池…」添加。' }));
        return;
      }

      const cards = poolNames.map((poolName) => {
        const list = poolsMap[poolName] || [];
        const rows = list.map((c, idx) => {
          const hp = candidateHealth(c);
          const harnessIn = h('input', {
            class: 'field pm-pool-field pm-pool-harness',
            type: 'text',
            list: 'pm-harness-list',
            value: c.harness || '',
            placeholder: 'harness',
            oninput: (e) => { c.harness = e.target.value; poolsDirty = true; },
          });
          const modelIn = h('input', {
            class: 'field pm-pool-field pm-pool-model',
            type: 'text',
            value: c.model || '',
            placeholder: 'model (如 sonnet)',
            oninput: (e) => { c.model = e.target.value; poolsDirty = true; },
          });
          const provIn = h('input', {
            class: 'field pm-pool-field pm-pool-provider',
            type: 'text',
            value: c.magpieProvider || '',
            placeholder: 'magpieProvider',
            title: '可选：Magpie 额度渠道标识',
            oninput: (e) => { c.magpieProvider = e.target.value; poolsDirty = true; },
          });
          const quirksIn = h('input', {
            class: 'field pm-pool-field pm-pool-quirks',
            type: 'text',
            value: c.quirks || '',
            placeholder: 'quirks 微调提示词（可选）',
            oninput: (e) => { c.quirks = e.target.value; poolsDirty = true; },
          });

          return h('div', { class: 'pm-pool-row' },
            h('span', { class: 'pm-pool-idx', text: `#${idx + 1}` }),
            h('span', { class: 'pm-pool-health', title: hp.title || '' },
              h('span', { class: `pm-health-dot ${hp.cls}` }),
              h('span', { text: hp.label })
            ),
            harnessIn,
            modelIn,
            provIn,
            quirksIn,
            h('div', { class: 'pm-pool-row-btns' },
              hp.isCooldown ? h('button', {
                class: 'btn',
                type: 'button',
                text: '复位',
                title: '复位该候选模型的熔断冷却状态',
                onclick: async () => {
                  const r = await mesh.resetPoolCooldown(c.harness, c.model);
                  say(r && r.ok ? `已复位 ${c.harness}:${c.model}` : ((r && r.msg) || '复位失败'));
                  await loadPools();
                },
              }) : null,
              h('button', {
                class: 'btn',
                type: 'button',
                text: '上移',
                disabled: idx === 0,
                onclick: () => {
                  if (idx <= 0) return;
                  const tmp = list[idx - 1];
                  list[idx - 1] = list[idx];
                  list[idx] = tmp;
                  poolsDirty = true;
                  renderPoolsSection();
                },
              }),
              h('button', {
                class: 'btn',
                type: 'button',
                text: '下移',
                disabled: idx >= list.length - 1,
                onclick: () => {
                  if (idx >= list.length - 1) return;
                  const tmp = list[idx + 1];
                  list[idx + 1] = list[idx];
                  list[idx] = tmp;
                  poolsDirty = true;
                  renderPoolsSection();
                },
              }),
              h('button', {
                class: 'btn no',
                type: 'button',
                text: '删除',
                onclick: () => {
                  list.splice(idx, 1);
                  poolsDirty = true;
                  renderPoolsSection();
                },
              })
            )
          );
        });

        return h('div', { class: 'pm-pool-card' },
          h('div', { class: 'pm-pool-head' },
            h('b', { text: poolName }),
            h('span', { class: 'pm-role-badge pool', text: `${list.length} 个候选` }),
            h('button', {
              class: 'btn',
              type: 'button',
              style: 'margin-left:auto',
              text: '＋ 添加候选',
              onclick: () => {
                list.push({ harness: 'claude', model: '', magpieProvider: '', quirks: '' });
                poolsDirty = true;
                renderPoolsSection();
              },
            })
          ),
          rows.length ? h('div', { class: 'pm-pool-rows' }, ...rows) : h('div', { class: 'pm-empty', text: '该模型池暂无候选条目，请点击「＋ 添加候选」。' })
        );
      });

      poolsSec.replaceChildren(head, h('div', { class: 'pm-pools-list' }, ...cards));
    }

    async function loadRoles() {
      if (destroyed) return;
      rolesLoading = true;
      rolesErr = '';
      renderRolesSection();
      const r = await mesh.getRoles();
      if (destroyed) return;
      rolesLoading = false;
      if (r && r.ok) {
        const list = Array.isArray(r.roles) ? r.roles : Object.values(r.roles || {});
        roles = list;
        const cur = roles.find((x) => x.name === selectedRole) || roles[0];
        if (cur) {
          selectedRole = cur.name;
          if (!roleDirty) roleDraft = cur.raw || '';
        }
      } else {
        rolesErr = (r && r.msg) || '无法加载角色模板（后端 /api/mesh/roles 未就绪或返回失败）';
      }
      renderRolesSection();
    }

    async function loadPools() {
      if (destroyed) return;
      poolsLoading = true;
      poolsErr = '';
      renderPoolsSection();
      const r = await mesh.getPools();
      if (destroyed) return;
      poolsLoading = false;
      if (r && r.ok) {
        const rawPools = (r.pools && typeof r.pools === 'object') ? r.pools : {};
        healthMap = (r.health && typeof r.health === 'object') ? r.health : {};
        const nextMap = {};
        const nextShapes = {};
        for (const [k, v] of Object.entries(rawPools)) {
          if (Array.isArray(v)) {
            nextMap[k] = v.map((c) => ({ ...c }));
            nextShapes[k] = 'array';
          } else if (v && typeof v === 'object') {
            const arr = Array.isArray(v.candidates) ? v.candidates : (Array.isArray(v.items) ? v.items : []);
            nextMap[k] = arr.map((c) => ({ ...c }));
            const meta = { ...v };
            delete meta.candidates;
            delete meta.items;
            nextShapes[k] = meta;
          }
        }
        poolsMap = nextMap;
        poolShapes = nextShapes;
        poolsDirty = false;
      } else {
        poolsErr = (r && r.msg) || '无法加载模型池配置（后端 /api/mesh/pools 未就绪或返回失败）';
      }
      renderPoolsSection();
    }

    loadRoles();
    loadPools();

    return {
      root: rootEl,
      destroy() { destroyed = true; },
    };
  }

  function nodeCard(proj, n) {
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
      h('div', { class: 'pm-node-btns' },
        h('button', { class: 'btn go', type: 'button', text: '下发指令 / 改契约', onclick: () => openSendDialog(proj, n) }),
        n.reviewStatus === 'waiting_review' ? h('button', { class: 'btn', type: 'button', text: '静默批准结单', onclick: async () => {
          const r = await mesh.reviewNode(proj.id, n.id, 'approve');
          say(r.msg || (r.ok ? '已批准结单' : '操作失败'));
        } }) : null,
        n.reviewStatus === 'waiting_review' ? h('button', { class: 'btn', type: 'button', text: '✓ 批准检视继续', onclick: () => openSendDialog(proj, n, '检视通过，请继续下一阶段任务。') }) : null,
        !n.archived && n.role !== 'master' ? h('button', { class: 'btn', type: 'button', title: '停止唤醒与看门狗巡检，但永久保留在拓扑图和黑板历史痕迹中', text: '归档退役', onclick: async () => {
          const r = await mesh.reviewNode(proj.id, n.id, 'archive');
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

  // ---- Tab 2: Cross-Machine Workspaces & VFS Structure Tree ----
  function renderVfsTab(proj) {
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

  // ---- Tab 4: External Triggers & Watchdog Event Timeline ----
  async function openWatchdogConfigDialog() {
    say('正在读取看门狗配置…');
    const res = await mesh.getConfig();
    const cfg = (res && res.ok && res.config) ? res.config : {};
    const val = (k, def) => (cfg[k] != null ? cfg[k] : def);

    const f = {
      idleNudgeMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('idleNudgeMin', 3)) }),
      idleAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('idleAlertMin', 10)) }),
      askingAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('askingAlertMin', 10)) }),
      silentAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('silentAlertMin', 60)) }),
      loopWindowMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('loopWindowMin', 10)) }),
      loopCount: h('input', { class: 'field', type: 'number', min: '2', step: '1', value: String(val('loopCount', 5)) }),
      loopNudge: h('input', { type: 'checkbox', checked: val('loopNudge', true) !== false }),
      autoRestart: h('input', { type: 'checkbox', checked: val('autoRestart', true) !== false }),
      restartWindowMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('restartWindowMin', 30)) }),
      offlineAlertMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('offlineAlertMin', 2)) }),
      mentionTimeoutMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('mentionTimeoutMin', 10)) }),
      swarmStallMin: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('swarmStallMin', 5)) }),
      folderPollSec: h('input', { class: 'field', type: 'number', min: '5', step: '5', value: String(val('folderPollSec', 30)) }),
      triggerMaxPerHour: h('input', { class: 'field', type: 'number', min: '1', step: '1', value: String(val('triggerMaxPerHour', 6)) }),
    };

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg pm-wd-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '看门狗与触发器参数配置 (W1~W8)' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('div', { class: 'pm-wd-sec', text: '基础看门狗阈值 (W1~W6)' }),
        h('div', { class: 'pm-wd-grid' },
          h('label', { text: 'W1 空闲提醒汇报超时(分钟)：' }), f.idleNudgeMin,
          h('label', { text: 'W1 空闲升级告警追加(分钟)：' }), f.idleAlertMin,
          h('label', { text: 'W2 权限确认卡死超时(分钟)：' }), f.askingAlertMin,
          h('label', { text: 'W3 连续工作无汇报超时(分钟)：' }), f.silentAlertMin,
          h('label', { text: 'W4 错误循环检测窗口(分钟)：' }), f.loopWindowMin,
          h('label', { text: 'W4 同错重复触发次数阈值：' }), f.loopCount,
          h('label', { class: 'pm-wd-chk' }, f.loopNudge, 'W4 检测到错误死循环时自动发消息提醒停止盲试'),
          h('label', { class: 'pm-wd-chk' }, f.autoRestart, 'W5 会话意外退出时自动唤醒恢复 (窗口期内最多1次)'),
          h('label', { text: 'W5 重启次数统计窗口(分钟)：' }), f.restartWindowMin,
          h('label', { text: 'W6 机器掉线告警超时(分钟)：' }), f.offlineAlertMin
        ),
        h('div', { class: 'pm-wd-sec', text: 'Swarm 协同看门狗阈值 (W7~W8)' }),
        h('div', { class: 'pm-wd-grid' },
          h('label', { text: 'W7 点名未回帖超时(分钟)：' }), f.mentionTimeoutMin,
          h('label', { text: 'W8 全组停滞超时(分钟)：' }), f.swarmStallMin
        ),
        h('div', { class: 'pm-wd-sec', text: '目录文件触发器参数' }),
        h('div', { class: 'pm-wd-grid' },
          h('label', { text: '目录轮询周期(秒)：' }), f.folderPollSec,
          h('label', { text: '每小时最多触发次数：' }), f.triggerMaxPerHour
        ),
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存配置' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = (el, d) => {
        const n = Number(el.value);
        return Number.isFinite(n) && n > 0 ? n : d;
      };
      const patch = {
        idleNudgeMin: num(f.idleNudgeMin, 3),
        idleAlertMin: num(f.idleAlertMin, 10),
        askingAlertMin: num(f.askingAlertMin, 10),
        silentAlertMin: num(f.silentAlertMin, 60),
        loopWindowMin: num(f.loopWindowMin, 10),
        loopCount: num(f.loopCount, 5),
        loopNudge: f.loopNudge.checked,
        autoRestart: f.autoRestart.checked,
        restartWindowMin: num(f.restartWindowMin, 30),
        offlineAlertMin: num(f.offlineAlertMin, 2),
        mentionTimeoutMin: num(f.mentionTimeoutMin, 10),
        swarmStallMin: num(f.swarmStallMin, 5),
        folderPollSec: num(f.folderPollSec, 30),
        triggerMaxPerHour: num(f.triggerMaxPerHour, 6),
      };
      done();
      say('正在保存看门狗参数…');
      const r = await mesh.saveConfig(patch);
      say(r && r.ok ? '已保存看门狗参数 (W1~W8)' : ((r && r.msg) || '保存配置失败'));
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
    const wrap = h('div', { class: 'dlg' }, form);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(); });
    document.body.append(wrap);
    f.mentionTimeoutMin.focus();
  }

  function renderEventsTab(proj) {
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
              await mesh.trigger({ op: 'delete', projectId: proj.id, triggerId: t.id });
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

  function openAddTriggerDialog(proj) {
    const machines = net.state.sessions.map((m) => m.machine);
    const machSel = h('select', { class: 'field' }, ...machines.map((m) => h('option', { value: m, text: m })));
    const pathIn = h('input', { class: 'field', type: 'text', placeholder: '需在项目授权工作区内，如 /data/cem_results' });
    const wsQuick = (proj.workspaces || []).length ? h('select', {
      class: 'field',
      onchange: (e) => {
        if (!e.target.value) return;
        const [m, p] = e.target.value.split('|');
        machSel.value = m;
        pathIn.value = p;
      },
    },
      h('option', { value: '', text: '— 从项目已授权文件夹快选 —' }),
      ...(proj.workspaces || []).map((w) => h('option', { value: `${w.machine}|${w.path}`, text: `${w.machine} : ${w.path}` }))
    ) : null;
    const globIn = h('input', { class: 'field', type: 'text', value: '*.ffe', placeholder: '如 *.ffe, *.out, *.csv 或 *' });
    const labelIn = h('input', { class: 'field', type: 'text', placeholder: '如：FEKO 远场结果生成触发' });
    const nodeSel = h('select', { class: 'field' },
      h('option', { value: '', text: '（默认通知 Master 主控节点）' }),
      ...(proj.nodes || []).map((n) => h('option', { value: n.id, text: `${n.alias || n.id} (${n.machine})` }))
    );

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '添加跨机目录文件触发器' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        wsQuick ? h('label', { class: 'xnote-lbl', text: '从项目授权工作区选择：' }) : null,
        wsQuick,
        h('label', { class: 'xnote-lbl', text: '监听电脑与目录路径：' }),
        h('div', { style: 'display:flex;gap:6px' }, machSel, pathIn),
        h('label', { class: 'xnote-lbl', text: '文件名匹配通配符与触发器名称：' }),
        h('div', { style: 'display:flex;gap:6px' }, globIn, labelIn),
        h('label', { class: 'xnote-lbl', text: '文件就绪后唤醒的目标节点：' }),
        nodeSel,
        h('div', { class: 'dlga' },
          h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }),
          h('button', { class: 'btn go', type: 'submit', text: '保存并开启监听' })
        )
      )
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!machSel.value || !pathIn.value.trim()) return;
      done();
      const r = await mesh.trigger({
        projectId: proj.id,
        type: 'folder',
        machine: machSel.value,
        path: pathIn.value.trim(),
        glob: globIn.value.trim() || '*',
        label: labelIn.value.trim(),
        targetNodeId: nodeSel.value || '',
      });
      say(r.ok ? '已添加目录文件触发器' : (r.msg || '添加失败'));
    });
    const wrap = h('div', { class: 'dlg' }, form);
    document.body.append(wrap);
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
      h('option', { value: 'opencode', text: 'OpenCode' }),
      h('option', { value: 'kiro', text: 'Kiro CLI' })
    );
    const wsModeSel = h('select', { class: 'field' },
      h('option', { value: 'inherit', text: 'inherit (共用目录)' }),
      h('option', { value: 'worktree', text: 'worktree (独立 Git Worktree 分支)' })
    );
    const branchIn = h('input', {
      class: 'field',
      type: 'text',
      placeholder: '分支名（可选，留空自动生成）',
      disabled: true,
    });
    wsModeSel.addEventListener('change', () => {
      branchIn.disabled = wsModeSel.value !== 'worktree';
      if (branchIn.disabled) branchIn.value = '';
    });
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
        h('label', { class: 'xnote-lbl', text: '工作区模式与分支名：' }),
        h('div', { style: 'display:flex;gap:6px' }, wsModeSel, branchIn),
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
        workspaceMode: wsModeSel.value,
        branch: wsModeSel.value === 'worktree' ? branchIn.value.trim() : '',
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
    const machines = (net.state.sessions || []).slice().sort((a, b) => {
      if (!!b.online !== !!a.online) return b.online ? 1 : -1;
      return String(a.machine || '').localeCompare(String(b.machine || ''));
    });
    const sessionsByMachine = new Map();
    for (const m of machines) {
      const list = (m.sessions || []).map((s) => ({
        machine: m.machine,
        id: s.id,
        label: s.label || s.id,
        cwd: s.cwd || '',
        state: s.state || 'idle',
        last: Number(s.last || s.t0 || 0),
      }));
      list.sort((a, b) => {
        const score = (st) => (['working', 'thinking', 'reading', 'message', 'waiting'].includes(st) ? 2 : st === 'idle' ? 1 : 0);
        const ds = score(b.state) - score(a.state);
        if (ds !== 0) return ds;
        return b.last - a.last;
      });
      sessionsByMachine.set(m.machine, list);
    }

    const machSel = h('select', { class: 'field' },
      ...machines.map((m) => {
        const cnt = (sessionsByMachine.get(m.machine) || []).length;
        return h('option', {
          value: m.machine,
          text: `${m.machine} (${m.online ? '在线' : '离线'} · ${cnt} 个对话)`,
        });
      })
    );
    const sessSel = h('select', { class: 'field' });
    const renderSessionOptions = () => {
      const mName = machSel.value;
      const list = sessionsByMachine.get(mName) || [];
      if (!list.length) {
        sessSel.replaceChildren(h('option', { value: '', text: '（该电脑当前没有可挂载的对话）' }));
        return;
      }
      sessSel.replaceChildren(...list.map((s) => {
        const dirShort = s.cwd ? ` · ${s.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || s.cwd}` : '';
        return h('option', {
          value: `${s.machine}|${s.id}`,
          text: `${s.label} (${s.state}${dirShort})`,
        });
      }));
    };
    machSel.addEventListener('change', renderSessionOptions);
    renderSessionOptions();

    const allSessions = [...sessionsByMachine.values()].flat();
    const roleSel = h('select', { class: 'field' },
      h('option', { value: 'master', text: 'Master 主控会话（负责统筹与检视）' }),
      h('option', { value: 'worker', text: 'Worker 执行会话（负责子任务计算与汇报）' }),
      h('option', { value: 'verifier', text: 'Verifier 验收会话（只读核查与打回返工）' }),
      h('option', { value: 'peer', text: 'Cowork 平级会话（对等联调协作）' })
    );
    const aliasIn = h('input', { class: 'field', type: 'text', placeholder: '节点别名（可留空使用原会话标题）' });
    const goalIn = h('input', { class: 'field', type: 'text', placeholder: '该节点的职责目标（Goal）' });
    const stopIn = h('input', { class: 'field', type: 'text', placeholder: '停机检视条件（Stop Gate）' });

    const done = () => wrap.remove();
    const form = h('form', { class: 'dlgbox xnote-dlg', autocomplete: 'off' },
      h('div', { class: 'dlgt' }, h('span', { text: '挂载现有会话到项目拓扑' }), h('button', { class: 'dlgx', type: 'button', text: '×', onclick: done })),
      h('div', { class: 'dlgb' },
        h('label', { class: 'xnote-lbl', text: '1. 选择电脑：' }),
        machSel,
        h('label', { class: 'xnote-lbl', text: '2. 选择该电脑上的对话：' }),
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
    if(researchView&&(!proj||activeTab!=='research'||researchView.projectId!==proj.id)){researchView.destroy();researchView=null;}
    if(boardView&&(!proj||activeTab!=='board'||boardView.projectId!==proj.id)){boardView.destroy();boardView=null;}
    if(topoView&&(!proj||activeTab!=='topo'||topoView.projectId!==proj.id)){topoView.destroy();topoView=null;}
    if(rolesView&&(!proj||activeTab!=='roles')){rolesView.destroy();rolesView=null;}
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
    if (activeTab === 'research') { if(!researchView){researchView=researchTab(proj);mainBody.replaceChildren(researchView.root);} }
    else if (activeTab === 'board') {
      if (!boardView) {
        boardView = renderBoardTab(proj);
        mainBody.replaceChildren(boardView.root);
      } else {
        boardView.update(proj);
      }
    }
    else if (activeTab === 'topo') {
      if (!topoView) {
        topoView = createTopologyView(proj);
        mainBody.replaceChildren(topoView.root);
      } else {
        topoView.update(proj);
      }
    }
    else if (activeTab === 'roles') {
      if (!rolesView) {
        rolesView = createRolesTab();
        mainBody.replaceChildren(rolesView.root);
      }
    }
    else if (activeTab === 'vfs') renderVfsTab(proj);
    else if (activeTab === 'events') renderEventsTab(proj);
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
    destroy() { if(researchView)researchView.destroy();if(boardView)boardView.destroy();if(topoView)topoView.destroy();if(rolesView)rolesView.destroy();offMesh(); offCat(); offSess(); },
  };
}
