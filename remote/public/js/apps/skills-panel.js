// AI 与额度 › Skill 与角色库（唯一跨机 Skill 管理 + 角色提示词 .md 编辑器）
// 全局模型池已收口至「AI 与额度 › 模型路由与能力池」；机器画像与 Fleet 已收口至「设备与算力」。
import { h, ago } from '../util.js';
import * as net from '../net.js';
import { askCode } from '../gate.js';
import { confirmBox } from '../dialog.js';

const TABS = [
  { id: 'skills', label: '跨机 Skill 管理' },
  { id: 'roles', label: '角色提示词 (.md)' },
];

function fmtTime(t) {
  if (!t) return '';
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return String(t);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${ago(ms)}）`;
}

const fetchJson = (url) => net.getJson(url, null);

async function copyText(text, targetEl, statusEl) {
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = '已复制正文';
  } catch {
    if (targetEl && typeof targetEl.select === 'function') {
      targetEl.focus();
      targetEl.select();
      statusEl.textContent = '已全选，请按 Ctrl+C 复制';
    } else {
      statusEl.textContent = '复制失败';
    }
  }
}

function makeTag(text, cls = '') {
  return h('span', { class: 'skp-tag' + (cls ? ' ' + cls : ''), text });
}

function originTag(item) {
  if (!item.builtin) return makeTag('自定义', 'skp-tag-custom');
  if (item.overridden) return makeTag('已修改', 'skp-tag-mod');
  return makeTag('内置', 'skp-tag-builtin');
}

function createMdLibraryView(cfg) {
  const root = h('div', { class: 'skp-lib' });
  const msg = h('p', { class: 'gnote skp-msg', 'aria-live': 'polite' });
  const listEl = h('div', { class: 'skp-list', role: 'listbox', 'aria-label': cfg.title });
  const editorHead = h('div', { class: 'skp-ed-head' });
  const nameInput = h('input', {
    class: 'field skp-name-input',
    type: 'text',
    placeholder: cfg.namePlaceholder,
    maxlength: 48,
  });
  const textarea = h('textarea', {
    class: 'field skp-editor',
    spellcheck: 'false',
    placeholder: '在此编辑 Markdown 内容…',
  });
  const metaLine = h('div', { class: 'skp-ed-meta' });
  const statusEl = h('span', { class: 'skp-inline-note', 'aria-live': 'polite' });
  const dirtyBadge = makeTag('未保存', 'skp-st-warn');
  dirtyBadge.hidden = true;

  let items = [];
  let selectedName = null;
  let creating = false;
  let dirty = false;
  let busy = false;

  const setDirty = (v) => {
    dirty = !!v;
    dirtyBadge.hidden = !dirty;
  };

  const confirmDiscard = async () => {
    if (!dirty) return true;
    const label = creating ? (nameInput.value.trim() || '新建草稿') : (selectedName || cfg.itemLabel);
    return confirmBox(`「${label}」有未保存修改，确定放弃当前修改吗？`);
  };

  const say = (t, isBad = false) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', !!isBad);
  };

  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存' });
  const resetBtn = h('button', { class: 'btn no', type: 'button', text: '还原默认' });
  const copyBtn = h('button', { class: 'btn', type: 'button', text: '复制正文' });
  const syncOneBtn = cfg.canSync ? h('button', { class: 'btn', type: 'button', text: '下发到所有电脑' }) : null;
  const newBtn = h('button', { class: 'btn', type: 'button', text: cfg.newBtnText });
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新' });
  const syncAllBtn = cfg.canSync ? h('button', { class: 'btn', type: 'button', text: '同步全部' }) : null;

  const side = h('div', { class: 'skp-side' },
    h('div', { class: 'skp-side-bar' }, newBtn, refreshBtn, syncAllBtn),
    listEl);

  const main = h('div', { class: 'skp-main' },
    editorHead,
    metaLine,
    textarea,
    h('div', { class: 'skp-actions' }, saveBtn, resetBtn, copyBtn, syncOneBtn, statusEl));

  root.append(h('p', { class: 'ghint', text: cfg.hint }), msg, h('div', { class: 'skp-split' }, side, main));

  textarea.addEventListener('input', () => setDirty(true));

  function renderList() {
    if (!items.length) {
      listEl.replaceChildren(h('div', { class: 'skp-empty', text: `暂无${cfg.itemLabel}条目` }));
      return;
    }
    listEl.replaceChildren(...items.map((it) => {
      const isSel = !creating && selectedName === it.name;
      const tags = [originTag(it), ...cfg.extraTags(it)];
      const desc = cfg.summaryOf(it);
      return h('button', {
        type: 'button',
        class: 'skp-item' + (isSel ? ' sel' : ''),
        role: 'option',
        'aria-selected': String(isSel),
        onclick: () => selectItem(it.name),
      },
      h('div', { class: 'skp-item-top' },
        h('b', { class: 'skp-item-name', text: it.name }),
        h('span', { class: 'skp-tags' }, ...tags)),
      desc ? h('small', { class: 'skp-item-desc', text: desc }) : null);
    }));
  }

  function renderRoleFrontmatterBar() {
    if (!cfg.roleFrontmatter) return null;
    const getFm = (key, def) => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(textarea.value);
      return m ? m[1].trim() : def;
    };
    const setFm = (key, val) => {
      const re = new RegExp(`^(${key}:\\s*).*$`, 'm');
      if (re.test(textarea.value)) {
        textarea.value = textarea.value.replace(re, `$1${val}`);
      } else if (/^---\r?\n/.test(textarea.value)) {
        textarea.value = textarea.value.replace(/^---\r?\n/, `---\n${key}: ${val}\n`);
      }
      setDirty(true);
    };
    const curPool = getFm('defaultPool', 'fast-coder');
    const poolOpts = ['fast-coder', 'flagship', 'heavy-reasoner', 'image-gen'];
    if (curPool && !poolOpts.includes(curPool)) poolOpts.unshift(curPool);
    const poolSel = h('select', { class: 'field', style: 'font-size:11.5px;padding:1px 4px', onchange: (e) => setFm('defaultPool', e.target.value) },
      ...poolOpts.map((p) => h('option', { value: p, text: p, selected: p === curPool })));
    const curWs = getFm('workspaceMode', 'inherit');
    const wsSel = h('select', { class: 'field', style: 'font-size:11.5px;padding:1px 4px', onchange: (e) => setFm('workspaceMode', e.target.value) },
      h('option', { value: 'inherit', text: 'inherit', selected: curWs !== 'worktree' }),
      h('option', { value: 'worktree', text: 'worktree', selected: curWs === 'worktree' }));
    const roChk = h('input', { type: 'checkbox', checked: getFm('readOnly', 'false') === 'true', onchange: (e) => setFm('readOnly', e.target.checked ? 'true' : 'false') });
    return h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px' },
      h('label', { style: 'display:inline-flex;align-items:center;gap:4px' }, '默认模型池', poolSel),
      h('label', { style: 'display:inline-flex;align-items:center;gap:4px' }, '工作区', wsSel),
      h('label', { style: 'display:inline-flex;align-items:center;gap:4px;cursor:pointer' }, roChk, '只读约束'));
  }

  function renderEditor() {
    statusEl.textContent = '';
    setDirty(false);
    if (creating) {
      editorHead.replaceChildren(
        h('label', { class: 'skp-name-lbl' },
          h('span', { text: `${cfg.itemLabel}名称：` }),
          nameInput),
        dirtyBadge);
      const fmBar = renderRoleFrontmatterBar();
      metaLine.replaceChildren(...[makeTag('新建草稿', 'skp-tag-custom'), fmBar].filter(Boolean));
      resetBtn.hidden = false;
      resetBtn.textContent = '取消新建';
      resetBtn.disabled = false;
      copyBtn.disabled = false;
      saveBtn.disabled = busy;
      if (syncOneBtn) syncOneBtn.disabled = true;
      setDirty(true);
      return;
    }

    const cur = items.find((x) => x.name === selectedName) || null;
    if (!cur) {
      editorHead.replaceChildren(h('b', { text: `请选择左侧${cfg.itemLabel}，或点击「${cfg.newBtnText}」` }));
      metaLine.replaceChildren();
      textarea.value = '';
      textarea.disabled = true;
      saveBtn.disabled = true;
      resetBtn.disabled = true;
      resetBtn.textContent = '还原默认';
      copyBtn.disabled = true;
      if (syncOneBtn) syncOneBtn.disabled = true;
      return;
    }

    textarea.disabled = false;
    saveBtn.disabled = busy;
    copyBtn.disabled = false;
    if (syncOneBtn) syncOneBtn.disabled = busy;
    textarea.value = cur.raw || '';

    editorHead.replaceChildren(
      h('b', { class: 'skp-ed-title', text: cur.name }),
      h('span', { class: 'skp-tags' }, originTag(cur), ...cfg.extraTags(cur), dirtyBadge));

    const metaParts = [];
    const desc = cfg.summaryOf(cur);
    if (desc) metaParts.push(desc);
    if (cur.updatedAt) metaParts.push('更新于 ' + fmtTime(cur.updatedAt));
    const fmBar = renderRoleFrontmatterBar();
    metaLine.replaceChildren(...[
      metaParts.length ? h('small', { text: metaParts.join(' · ') }) : null,
      fmBar,
    ].filter(Boolean));

    if (!cur.builtin) {
      resetBtn.textContent = '删除';
      resetBtn.disabled = busy;
    } else if (cur.overridden) {
      resetBtn.textContent = '还原默认';
      resetBtn.disabled = busy;
    } else {
      resetBtn.textContent = '还原默认';
      resetBtn.disabled = true;
    }
  }

  async function selectItem(name) {
    if (!creating && selectedName === name) return;
    if (!(await confirmDiscard())) return;
    creating = false;
    selectedName = name;
    say('');
    renderList();
    renderEditor();
  }

  newBtn.addEventListener('click', async () => {
    if (!(await confirmDiscard())) return;
    creating = true;
    selectedName = null;
    nameInput.value = '';
    textarea.disabled = false;
    textarea.value = cfg.makeTemplate('new-item');
    say('');
    renderList();
    renderEditor();
    nameInput.focus();
  });

  nameInput.addEventListener('input', () => {
    if (!creating) return;
    const slug = nameInput.value.trim();
    if (/^[a-z0-9_-]{1,48}$/i.test(slug)) {
      textarea.value = textarea.value.replace(/^(name:\s*).+$/m, `$1${slug}`);
    }
    setDirty(true);
  });

  refreshBtn.addEventListener('click', async () => {
    if (!(await confirmDiscard())) return;
    load();
  });

  copyBtn.addEventListener('click', () => {
    copyText(textarea.value || '', textarea, statusEl);
  });

  async function syncSkills(names) {
    if (busy) return;
    busy = true;
    if (syncOneBtn) syncOneBtn.disabled = true;
    if (syncAllBtn) syncAllBtn.disabled = true;
    const label = names && names.length ? `下发「${names.join('、')}」` : '同步全部 Skill ';
    statusEl.textContent = `正在${label}…`;
    say(`正在向所有在线电脑${label}…`);
    let r = await net.post('/api/fleet/sync-skills', { machine: '*', ...(names ? { names } : {}) });
    if (r && !r.ok && r.need === 'totp') {
      if (await askCode()) r = await net.post('/api/fleet/sync-skills', { machine: '*', ...(names ? { names } : {}) });
      else r = { ok: false, msg: '已取消' };
    }
    busy = false;
    if (syncAllBtn) syncAllBtn.disabled = false;
    if (syncOneBtn) syncOneBtn.disabled = creating || !selectedName;
    const text = (r && r.msg) || (r && r.ok ? '已下发' : '下发失败');
    statusEl.textContent = r && r.ok ? '已下发' : '下发失败';
    say(text, !(r && r.ok));
  }
  if (syncOneBtn) syncOneBtn.addEventListener('click', () => { if (selectedName) syncSkills([selectedName]); });
  if (syncAllBtn) syncAllBtn.addEventListener('click', () => syncSkills(null));

  saveBtn.addEventListener('click', async () => {
    const name = creating ? nameInput.value.trim() : selectedName;
    if (!name) {
      say(`请先填写${cfg.itemLabel}名称（字母、数字、-、_）`, true);
      if (creating) nameInput.focus();
      return;
    }
    if (!/^[a-z0-9_-]{1,48}$/i.test(name)) {
      say(`${cfg.itemLabel}名称仅支持字母、数字、下划线和连字符`, true);
      if (creating) nameInput.focus();
      return;
    }
    const raw = textarea.value;
    if (!raw.trim()) {
      say('正文不能为空', true);
      textarea.focus();
      return;
    }
    busy = true;
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    const r = await net.post(cfg.endpoint, { op: 'save', name, raw });
    busy = false;
    if (!r || !r.ok) {
      saveBtn.disabled = false;
      statusEl.textContent = '';
      say((r && r.msg) || '保存失败', true);
      return;
    }
    creating = false;
    setDirty(false);
    selectedName = name;
    say(`已保存「${name}」`);
    await load();
    statusEl.textContent = '已保存';
  });

  resetBtn.addEventListener('click', async () => {
    if (creating) {
      creating = false;
      setDirty(false);
      selectedName = items[0] ? items[0].name : null;
      renderList();
      renderEditor();
      return;
    }
    const cur = items.find((x) => x.name === selectedName);
    if (!cur) return;
    if (cur.builtin && !cur.overridden) return;
    const actName = cur.builtin ? '还原为内置默认内容' : '永久删除';
    if (!(await confirmBox(`确定要将「${cur.name}」${actName}？`, { title: cur.builtin ? '还原默认' : '删除确认', ok: cur.builtin ? '还原' : '删除', danger: true }))) return;
    busy = true;
    resetBtn.disabled = true;
    statusEl.textContent = '处理中…';
    const r = await net.post(cfg.endpoint, { op: 'reset', name: cur.name });
    busy = false;
    if (!r || !r.ok) {
      statusEl.textContent = '';
      say((r && r.msg) || '操作失败', true);
      renderEditor();
      return;
    }
    setDirty(false);
    say(cur.builtin ? `已将「${cur.name}」还原为默认` : `已删除「${cur.name}」`);
    await load();
  });

  let loadSeq = 0;
  let destroyed = false;
  async function load() {
    const seq = ++loadSeq;
    say('加载中…');
    const r = await fetchJson(cfg.endpoint);
    if (destroyed || seq !== loadSeq) return;
    if (!r || !r.ok || !Array.isArray(r[cfg.listKey])) {
      say((r && r.msg) || `读取${cfg.title}失败（看板服务器尚未启用该接口或网络异常）`, true);
      return;
    }
    say('');
    items = r[cfg.listKey];
    if (!creating) {
      if (!selectedName || !items.some((x) => x.name === selectedName)) {
        selectedName = items[0] ? items[0].name : null;
      }
    }
    renderList();
    renderEditor();
  }

  return { root, load, confirmDiscard, destroy() { destroyed = true; } };
}

export function panel(initialTab) {
  const root = h('div', { class: 'mcp skp' });
  const tabBar = h('div', { class: 'skp-tabs', role: 'tablist', 'aria-label': 'Skill 与角色库' });
  const body = h('div', { class: 'skp-body' });
  root.append(tabBar, body);

  const views = {
    skills: createMdLibraryView({
      title: '跨机 Skill 管理',
      endpoint: '/api/mesh/skills',
      listKey: 'skills',
      itemLabel: 'Skill',
      newBtnText: '+ 新建 Skill',
      namePlaceholder: '例如：fem-meshing',
      hint: '管理可复用的 Skill 文档（Markdown）。内置 Skill 修改后标记为「已修改」，可随时还原默认；点击「同步全部」或「下发到所有电脑」可将托管 Skill 推送到各在线设备的 Claude / Codex / OpenCode / Antigravity 目录。',
      canSync: true,
      summaryOf: (it) => it.description || '',
      extraTags: () => [],
      makeTemplate: (name) => `---\nname: ${name}\ndescription: 在此填写 Skill 适用场景与简介\n---\n\n# ${name}\n\n## 目标\n\n## 执行步骤\n1. \n`,
    }),
    roles: createMdLibraryView({
      title: '角色提示词 (.md)',
      endpoint: '/api/mesh/roles',
      listKey: 'roles',
      itemLabel: '角色',
      newBtnText: '+ 新建角色',
      namePlaceholder: '例如：verifier',
      hint: '唯一权威的 AmeMesh 协同角色系统提示词与策略库（含默认模型池 defaultPool、工作区模式 workspaceMode、只读约束 readOnly）。未保存切换时会提醒确认。',
      roleFrontmatter: true,
      summaryOf: (it) => it.summary || '',
      extraTags: (it) => {
        const out = [];
        if (it.defaultPool) out.push(makeTag(it.defaultPool));
        if (it.readOnly) out.push(makeTag('只读', 'skp-tag-readonly'));
        if (it.workspaceMode === 'worktree') out.push(makeTag('worktree'));
        return out;
      },
      makeTemplate: (name) => `---\nname: ${name}\nsummary: 角色职责简介\ndefaultPool: fast-coder\nworkspaceMode: inherit\nreadOnly: false\n---\n\n# ${name} 行为规范\n\n1. 严格遵守授权目录与 Stop Gate 边界。\n2. 通过 mesh_board_post 发布进展并用 #seq 引用证据。\n`,
    }),
  };

  let active = TABS.some((t) => t.id === initialTab) ? initialTab : 'skills';

  const tabBtns = TABS.map((t) => h('button', {
    class: 'btn skp-tab',
    type: 'button',
    role: 'tab',
    dataset: { tab: t.id },
    text: t.label,
    onclick: () => show(t.id),
  }));
  tabBar.replaceChildren(...tabBtns);

  async function show(tabId) {
    if (tabId && views[tabId] && tabId !== active) {
      const curView = views[active];
      if (curView && curView.confirmDiscard && !(await curView.confirmDiscard())) return;
      active = tabId;
    }
    for (const b of tabBtns) {
      const isSel = b.dataset.tab === active;
      b.classList.toggle('sel', isSel);
      b.setAttribute('aria-selected', String(isSel));
    }
    const view = views[active];
    body.replaceChildren(view.root);
    view.load();
  }

  show(active);
  return {
    root,
    show,
    destroy() {
      for (const v of Object.values(views)) {
        if (v && v.destroy) v.destroy();
      }
    },
  };
}
