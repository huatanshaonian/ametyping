// Board & Shared Tasks tab for AmeMesh Projects (used by projects.js).
import { h, ago } from '../util.js';
import * as mesh from '../mesh.js';
import { askText } from '../dialog.js';
import { TASK_STATUSES, BOARD_KINDS, BOARD_KIND_LABELS, renderPostBody, formatAuditMessage } from './proj-const.js';

export function openNewTaskDialog(proj, { say }) {
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

export function createBoardTab(proj, { say, boardDrafts }) {
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
          if (!rawName || destroyed) return;
          const channel = rawName.trim().replace(/^#+/, '');
          if (!channel) return;
          say(`正在创建频道 #${channel}…`);
          const r = await mesh.channel({ action: 'create', projectId: curProj.id, channel });
          if (destroyed) return;
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
        onclick: () => openNewTaskDialog(curProj, { say }),
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
    if (destroyed) return;
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
