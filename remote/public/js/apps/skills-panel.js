// 控制面板 › Skill 与协同 (Skill 文档、角色提示词 .md、全局模型池、机器角色备忘)
import { h, ago } from '../util.js';
import * as net from '../net.js';

const TABS = [
  { id: 'skills', label: 'Skill 管理' },
  { id: 'roles', label: '角色提示词 (.md)' },
  { id: 'pools', label: '全局模型池' },
  { id: 'machines', label: '机器角色备忘' },
];

const POOL_ORDER = ['fast-coder', 'flagship', 'heavy-reasoner', 'image-gen'];

const POOL_STATUS_LABEL = {
  healthy: 'healthy · 正常',
  low_quota: 'low_quota · 低额度',
  cooldown: 'cooldown · 冷却中',
  exhausted: 'exhausted · 已耗尽',
};

function fmtTime(t) {
  if (!t) return '';
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return String(t);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${ago(ms)}）`;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (res.status === 401) { location.href = '/login'; return { ok: false, msg: '需要重新登录' }; }
    return await res.json();
  } catch {
    return null;
  }
}

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

  let items = [];
  let selectedName = null;
  let creating = false;
  let busy = false;

  const say = (t, isBad = false) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', !!isBad);
  };

  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存' });
  const resetBtn = h('button', { class: 'btn no', type: 'button', text: '还原默认' });
  const copyBtn = h('button', { class: 'btn', type: 'button', text: '复制正文' });
  const newBtn = h('button', { class: 'btn', type: 'button', text: cfg.newBtnText });
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新' });

  const side = h('div', { class: 'skp-side' },
    h('div', { class: 'skp-side-bar' }, newBtn, refreshBtn),
    listEl);

  const main = h('div', { class: 'skp-main' },
    editorHead,
    metaLine,
    textarea,
    h('div', { class: 'skp-actions' }, saveBtn, resetBtn, copyBtn, statusEl));

  root.append(h('p', { class: 'ghint', text: cfg.hint }), msg, h('div', { class: 'skp-split' }, side, main));

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

  function renderEditor() {
    statusEl.textContent = '';
    if (creating) {
      editorHead.replaceChildren(
        h('label', { class: 'skp-name-lbl' },
          h('span', { text: `${cfg.itemLabel}名称：` }),
          nameInput));
      metaLine.replaceChildren(makeTag('新建草稿', 'skp-tag-custom'));
      resetBtn.hidden = false;
      resetBtn.textContent = '取消新建';
      resetBtn.disabled = false;
      copyBtn.disabled = false;
      saveBtn.disabled = busy;
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
      return;
    }

    textarea.disabled = false;
    saveBtn.disabled = busy;
    copyBtn.disabled = false;
    editorHead.replaceChildren(
      h('b', { class: 'skp-ed-title', text: cur.name }),
      h('span', { class: 'skp-tags' }, originTag(cur), ...cfg.extraTags(cur)));

    const metaParts = [];
    const desc = cfg.summaryOf(cur);
    if (desc) metaParts.push(desc);
    if (cur.updatedAt) metaParts.push('更新于 ' + fmtTime(cur.updatedAt));
    metaLine.replaceChildren(metaParts.length ? h('small', { text: metaParts.join(' · ') }) : null);

    textarea.value = cur.raw || '';
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

  function selectItem(name) {
    creating = false;
    selectedName = name;
    say('');
    renderList();
    renderEditor();
  }

  newBtn.addEventListener('click', () => {
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
  });

  refreshBtn.addEventListener('click', () => load());

  copyBtn.addEventListener('click', () => {
    copyText(textarea.value || '', textarea, statusEl);
  });

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
    selectedName = name;
    say(`已保存「${name}」`);
    await load();
    statusEl.textContent = '已保存';
  });

  resetBtn.addEventListener('click', async () => {
    if (creating) {
      creating = false;
      selectedName = items[0] ? items[0].name : null;
      renderList();
      renderEditor();
      return;
    }
    const cur = items.find((x) => x.name === selectedName);
    if (!cur) return;
    if (cur.builtin && !cur.overridden) return;
    const actName = cur.builtin ? '还原为内置默认内容' : '永久删除';
    if (!confirm(`确定要将「${cur.name}」${actName}？`)) return;
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
    say(cur.builtin ? `已将「${cur.name}」还原为默认` : `已删除「${cur.name}」`);
    await load();
  });

  async function load() {
    say('加载中…');
    const r = await fetchJson(cfg.endpoint);
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

  return { root, load };
}

function stripPoolReadOnlyFields(poolsObj) {
  const out = {};
  for (const [poolName, list] of Object.entries(poolsObj || {})) {
    if (!Array.isArray(list)) continue;
    out[poolName] = list.filter((c) => c && typeof c === 'object').map((c) => {
      const clean = {
        harness: String(c.harness || '').trim(),
        model: String(c.model || '').trim(),
      };
      if (typeof c.magpieProvider === 'string' && c.magpieProvider.trim()) {
        clean.magpieProvider = c.magpieProvider.trim();
      }
      if (typeof c.quirks === 'string' && c.quirks.trim()) {
        clean.quirks = c.quirks.trim();
      }
      return clean;
    });
  }
  return out;
}

function createPoolsView() {
  const root = h('div', { class: 'skp-pools' });
  const msg = h('p', { class: 'gnote skp-msg', 'aria-live': 'polite' });
  const cardsBox = h('div', { class: 'skp-pool-cards' });
  const jsonArea = h('textarea', { class: 'field skp-editor skp-json', spellcheck: 'false' });
  const statusEl = h('span', { class: 'skp-inline-note', 'aria-live': 'polite' });

  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新状态' });
  const claudeCapInput = h('input', { class: 'field', type: 'number', min: '0', max: '20', step: '1', value: '2', style: 'width:54px;margin:0 4px;' });
  const saveCapBtn = h('button', { class: 'btn', type: 'button', text: '保存上限' });
  const formatBtn = h('button', { class: 'btn', type: 'button', text: '格式化 JSON' });
  const saveBtn = h('button', { class: 'btn go', type: 'button', text: '保存模型池配置' });

  let busy = false;
  const say = (t, isBad = false) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', !!isBad);
  };

  saveCapBtn.addEventListener('click', async () => {
    const val = Math.max(0, Math.min(20, Math.trunc(Number(claudeCapInput.value) || 0)));
    claudeCapInput.value = String(val);
    const r = await net.post('/api/mesh/config', { maxClaudePerProject: val });
    if (r && r.ok) say(val === 0 ? '已关闭单项目 Claude Code 数量上限' : `已保存：单项目最多 ${val} 个活跃 Claude Code 成员`);
    else say((r && r.msg) || '保存上限失败', true);
  });

  root.append(
    h('p', { class: 'ghint', text: '全局模型池决定 AmeMesh 调度各角色时的候选顺位、Magpie 实时额度降权与被动冷却熔断恢复。' }),
    h('div', { class: 'skp-toolbar' },
      refreshBtn,
      h('span', { style: 'margin-left:8px;font-size:11.5px;', text: '单项目 Claude Code 上限(0=不限):' }),
      claudeCapInput,
      saveCapBtn,
      statusEl
    ),
    msg,
    cardsBox,
    h('h4', { class: 'aim-h', text: '模型池 JSON 配置编辑器' }),
    h('p', { class: 'ghint', text: '仅编辑并保存候选配置字段（harness、model、magpieProvider、quirks）；只读运行时状态字段会在保存前自动剔除。' }),
    jsonArea,
    h('div', { class: 'skp-actions' }, saveBtn, formatBtn));

  function statusTag(c) {
    const st = c.status || (c.healthy === false ? 'cooldown' : 'healthy');
    const cls = st === 'healthy' ? 'skp-st-ok'
      : st === 'low_quota' ? 'skp-st-warn'
        : st === 'cooldown' ? 'skp-st-cool'
          : 'skp-st-bad';
    return makeTag(POOL_STATUS_LABEL[st] || st, cls);
  }

  function renderPools(pools) {
    const keys = Object.keys(pools || {});
    keys.sort((a, b) => {
      const ia = POOL_ORDER.indexOf(a);
      const ib = POOL_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });

    if (!keys.length) {
      cardsBox.replaceChildren(h('p', { class: 'ghint', text: '暂无模型池配置。' }));
    } else {
      cardsBox.replaceChildren(...keys.map((poolName) => {
        const list = Array.isArray(pools[poolName]) ? pools[poolName] : [];
        const rows = list.map((c, idx) => {
          const isCooldown = c.status === 'cooldown';
          const resetBtn = isCooldown ? h('button', {
            class: 'btn',
            type: 'button',
            text: '重置冷却',
            disabled: busy,
            onclick: async () => {
              busy = true;
              statusEl.textContent = `正在重置 ${c.harness} / ${c.model || '默认'} 冷却…`;
              const r = await net.post('/api/mesh/pools', {
                op: 'reset-cooldown',
                harness: c.harness,
                model: c.model || '',
              });
              busy = false;
              statusEl.textContent = '';
              if (!r || !r.ok) {
                say((r && r.msg) || '重置冷却失败', true);
                return;
              }
              say(`已重置 ${c.harness}${c.model ? ' / ' + c.model : ''} 冷却状态`);
              if (r.pools) renderAll(r.pools);
              else load();
            },
          }) : null;

          const detailParts = [];
          if (c.magpieProvider) detailParts.push(`Magpie: ${c.magpieProvider}`);
          if (c.quirks) detailParts.push(`备注: ${c.quirks}`);

          const infoParts = [];
          if (c.magpieInfo) infoParts.push(c.magpieInfo);
          if (c.reason) infoParts.push(c.reason);

          return h('tr', {},
            h('td', { class: 'skp-rank', text: `#${idx + 1}` }),
            h('td', {},
              h('div', { class: 'skp-cand' },
                h('b', { text: c.harness || '—' }),
                c.model ? h('code', { text: c.model }) : h('small', { text: '（默认模型）' })),
              detailParts.length ? h('small', { class: 'skp-muted', text: detailParts.join(' · ') }) : null),
            h('td', {}, statusTag(c)),
            h('td', {}, infoParts.length ? h('small', { text: infoParts.join(' · ') }) : h('small', { class: 'skp-muted', text: '正常可用' })),
            h('td', { class: 'skp-op-col' }, resetBtn || h('small', { class: 'skp-muted', text: '—' })));
        });

        return h('div', { class: 'mcp-card skp-card' },
          h('div', { class: 'mcp-h' },
            h('b', { text: poolName }),
            makeTag(`${list.length} 个候选`)),
          list.length
            ? h('table', { class: 'mcp-t skp-pool-t' },
              h('thead', {}, h('tr', {},
                h('th', { text: '顺位' }),
                h('th', { text: 'Harness / 模型' }),
                h('th', { text: '状态' }),
                h('th', { text: 'Magpie 额度与说明' }),
                h('th', { text: '操作' }))),
              h('tbody', {}, ...rows))
            : h('p', { class: 'ghint', text: '该模型池当前没有候选条目。' }));
      }));
    }
  }

  function renderAll(pools) {
    renderPools(pools);
    jsonArea.value = JSON.stringify(stripPoolReadOnlyFields(pools), null, 2);
  }

  refreshBtn.addEventListener('click', () => load());

  formatBtn.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(jsonArea.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        say('JSON 顶层必须是对象 { poolName: [...] }', true);
        return;
      }
      jsonArea.value = JSON.stringify(stripPoolReadOnlyFields(parsed), null, 2);
      say('已格式化并清理只读字段');
    } catch (e) {
      say(`JSON 解析失败：${e.message}`, true);
    }
  });

  saveBtn.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonArea.value);
    } catch (e) {
      say(`JSON 格式错误，无法保存：${e.message}`, true);
      jsonArea.focus();
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      say('模型池配置必须是对象格式 { "fast-coder": [...] }', true);
      return;
    }
    const cleaned = stripPoolReadOnlyFields(parsed);
    for (const [k, list] of Object.entries(cleaned)) {
      if (list.some((c) => !c.harness)) {
        say(`模型池「${k}」存在缺少 harness 字段的条目`, true);
        return;
      }
    }
    busy = true;
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    const r = await net.post('/api/mesh/pools', { pools: cleaned });
    busy = false;
    saveBtn.disabled = false;
    statusEl.textContent = '';
    if (!r || !r.ok) {
      say((r && r.msg) || '保存模型池配置失败', true);
      return;
    }
    say('已保存全局模型池配置');
    if (r.pools) renderAll(r.pools);
    else load();
  });

  async function load() {
    say('加载中…');
    const [r, cfgRes] = await Promise.all([
      fetchJson('/api/mesh/pools'),
      fetchJson('/api/mesh/config'),
    ]);
    if (cfgRes && cfgRes.ok && cfgRes.config && cfgRes.config.maxClaudePerProject !== undefined) {
      claudeCapInput.value = String(cfgRes.config.maxClaudePerProject);
    }
    if (!r || !r.ok || !r.pools) {
      say((r && r.msg) || '读取全局模型池失败', true);
      return;
    }
    say('');
    renderAll(r.pools);
  }

  return { root, load };
}

function createMachinesView() {
  const root = h('div', { class: 'skp-machines' });
  const msg = h('p', { class: 'gnote skp-msg', 'aria-live': 'polite' });
  const listEl = h('div', { class: 'skp-mach-list' });
  const refreshBtn = h('button', { class: 'btn', type: 'button', text: '刷新机器列表' });
  const countNote = h('span', { class: 'skp-inline-note' });

  const say = (t, isBad = false) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', !!isBad);
  };

  root.append(
    h('p', { class: 'ghint', text: '记录各电脑的角色定位、硬件配置与协同注意事项，供主控 Agent 与调度器在派活选机时参考。' }),
    h('div', { class: 'skp-toolbar' }, refreshBtn, countNote),
    msg,
    listEl);

  refreshBtn.addEventListener('click', () => load());

  function renderMachines(machines) {
    countNote.textContent = `共 ${machines.length} 台机器（${machines.filter((m) => m.online).length} 台在线）`;
    if (!machines.length) {
      listEl.replaceChildren(h('p', { class: 'ghint', text: '还没有检测到已登记或在线的机器。' }));
      return;
    }

    listEl.replaceChildren(...machines.map((m) => {
      const harnesses = Array.isArray(m.harnesses) ? m.harnesses : [];
      const readySet = new Set(Array.isArray(m.meshReadyHarnesses) ? m.meshReadyHarnesses : []);

      const roleIn = h('input', {
        class: 'field',
        type: 'text',
        value: m.role || '',
        placeholder: '例如：主算力仿真机 / 轻量编辑与汇报机',
      });
      const hwIn = h('input', {
        class: 'field',
        type: 'text',
        value: m.hardware || '',
        placeholder: '例如：i9 / 64GB RAM / RTX 4090 24GB',
      });
      const noteIn = h('input', {
        class: 'field',
        type: 'text',
        value: m.note || '',
        placeholder: '例如：仅处理 G:/feko_data 具体路径，避免目录遍历',
      });
      const cardStatus = h('span', { class: 'skp-inline-note', 'aria-live': 'polite' });
      const timeEl = h('small', { class: 'skp-muted', text: m.updatedAt ? '更新于 ' + fmtTime(m.updatedAt) : '' });

      const saveBtn = h('button', {
        class: 'btn go',
        type: 'button',
        text: '保存',
        onclick: async () => {
          saveBtn.disabled = true;
          cardStatus.textContent = '保存中…';
          cardStatus.classList.remove('bad');
          const r = await net.post('/api/mesh/machine-profiles', {
            machine: m.machine,
            role: roleIn.value.trim(),
            hardware: hwIn.value.trim(),
            note: noteIn.value.trim(),
          });
          saveBtn.disabled = false;
          if (!r || !r.ok) {
            cardStatus.textContent = (r && r.msg) || '保存失败';
            cardStatus.classList.add('bad');
            return;
          }
          cardStatus.textContent = '已保存';
          const updatedAt = (r.profile && r.profile.updatedAt) || r.updatedAt || Date.now();
          timeEl.textContent = '更新于 ' + fmtTime(updatedAt);
        },
      });

      const harnessChips = harnesses.length
        ? harnesses.map((hn) => {
          const ready = readySet.has(hn);
          return makeTag(ready ? `${hn} · MCP就绪` : hn, ready ? 'skp-st-ok' : '');
        })
        : [h('small', { class: 'skp-muted', text: '未上报 Harness' })];

      return h('div', { class: 'mcp-card skp-card' + (m.online ? '' : ' off') },
        h('div', { class: 'mcp-h skp-mach-head' },
          h('b', { text: m.machine || '未知机器' }),
          makeTag(m.online ? '在线' : '离线', m.online ? 'skp-st-ok' : 'skp-st-off'),
          m.control === false ? makeTag('只读', 'skp-st-warn') : null,
          timeEl),
        h('div', { class: 'skp-harness-row' },
          h('span', { class: 'skp-muted', text: '已装 Harness：' }),
          ...harnessChips),
        h('div', { class: 'skp-form-grid' },
          h('label', { class: 'skp-field-row' }, h('span', { text: '角色定位' }), roleIn),
          h('label', { class: 'skp-field-row' }, h('span', { text: '硬件配置' }), hwIn),
          h('label', { class: 'skp-field-row' }, h('span', { text: '协作备注' }), noteIn)),
        h('div', { class: 'skp-actions' }, saveBtn, cardStatus));
    }));
  }

  async function load() {
    say('加载中…');
    const r = await fetchJson('/api/mesh/machine-profiles');
    if (!r || !r.ok || !Array.isArray(r.machines)) {
      say((r && r.msg) || '读取机器角色备忘失败（看板服务器尚未启用该接口或网络异常）', true);
      return;
    }
    say('');
    renderMachines(r.machines);
  }

  return { root, load };
}

export function panel(initialTab) {
  const root = h('div', { class: 'mcp skp' });
  const tabBar = h('div', { class: 'skp-tabs', role: 'tablist', 'aria-label': 'Skill 与协同管理' });
  const body = h('div', { class: 'skp-body' });
  root.append(tabBar, body);

  const views = {
    skills: createMdLibraryView({
      title: 'Skill 管理',
      endpoint: '/api/mesh/skills',
      listKey: 'skills',
      itemLabel: 'Skill',
      newBtnText: '+ 新建 Skill',
      namePlaceholder: '例如：fem-meshing',
      hint: '管理可复用的 Skill 文档（Markdown）。内置 Skill 修改后标记为「已修改」，可随时还原默认。',
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
      hint: '管理 AmeMesh 各协同角色的系统提示词与默认策略（含 YAML frontmatter：summary、defaultPool、workspaceMode、readOnly）。',
      summaryOf: (it) => it.summary || '',
      extraTags: (it) => {
        const out = [];
        if (it.defaultPool) out.push(makeTag(it.defaultPool));
        if (it.readOnly) out.push(makeTag('只读', 'skp-tag-readonly'));
        if (it.workspaceMode === 'worktree') out.push(makeTag('worktree'));
        return out;
      },
      makeTemplate: (name) => `---\nname: ${name}\nsummary: 角色职责简介\ndefaultPool: fast-coder\nworkspaceMode: inherit\nreadOnly: false\n---\n\n1. \n`,
    }),
    pools: createPoolsView(),
    machines: createMachinesView(),
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

  function show(tabId) {
    if (tabId && views[tabId]) active = tabId;
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
  return { root, show };
}
