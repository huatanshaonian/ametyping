// AI 与额度中心 (AI, Quota & Agent Hub — IA 2-A):
// Unified 5-Tab hub (window id 'magpie' for 100% backward compatibility with #magpie, widget & UI tests):
//   1) 额度与顾问 (quota, default): Magpie subscription windows, usage/cost stats & Devin/Fable 5.2 advisor
//   2) 模型路由与能力池 (models): Single authoritative AmeMesh global model pools (inline move/edit, probe, cooldown reset,
//      per-project Claude cap, collapsible JSON) + NAS background task models, Clippy model & official API keys
//   3) Skill 与角色库 (skills): Cross-machine Skill library & AmeMesh role (.md) prompt editor with dirty guard
//   4) MCP 工具中枢 (mcp): Managed MCP server catalog, per-machine client registration matrix & one-click sync
//   5) 客户端配置与入口 (clients): Interactive opencode.json generator + plugin download + collapsible manual guide
//      + restored claude-apis.js multi-environment launcher manager (cc-environments)
import { h, icon } from '../util.js';
import * as wm from '../wm.js';
import * as mesh from '../mesh.js';
import { askText } from '../dialog.js';
import { panel as magpiePanel } from './magpie.js';
import { panel as aiModelsPanel } from './ai-models.js';
import { panel as skillsPanel } from './skills-panel.js';
import { panel as mcpPanel } from './mcp-panel.js';
import { panel as opencodeGuidePanel } from './opencode-guide.js';
import { panel as claudeApisPanel } from './claude-apis.js';

const TABS = [
  ['quota', '额度与顾问'],
  ['models', '模型路由与能力池'],
  ['skills', 'Skill 与角色库'],
  ['mcp', 'MCP 工具中枢'],
  ['clients', '客户端配置与入口'],
];

const POOL_ORDER = ['flagship', 'heavy-reasoner', 'fast-coder', 'image-gen'];

function normalizeOpts(arg) {
  if (!arg) return { tab: 'quota' };
  if (typeof arg === 'string') {
    if (TABS.some(([id]) => id === arg)) return { tab: arg };
    if (arg === 'roles') return { tab: 'skills', sub: 'roles' };
    if (arg === 'pools') return { tab: 'models', sec: 'pools' };
    if (arg === 'opencode' || arg === 'apis') return { tab: 'clients', sec: arg };
    if (arg === 'clippy') return { tab: 'models', sec: 'clippy' };
    return { tab: 'quota' };
  }
  if (typeof arg === 'object') return { tab: arg.tab || 'quota', ...arg };
  return { tab: 'quota' };
}

function formatResetAt(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return String(ts);
  const diffMin = Math.round((ms - Date.now()) / 60000);
  if (diffMin <= 0) return '即将恢复';
  if (diffMin < 60) return `${diffMin}m 后恢复`;
  return `${Math.round((diffMin / 60) * 10) / 10}h 后恢复`;
}

function createGlobalPoolsSection() {
  const root = h('section', { class: 'skp-pools pm-roles-sec', dataset: { sec: 'pools' } });
  const msg = h('p', { class: 'gnote skp-msg', 'aria-live': 'polite' });
  const toolbarBox = h('div', { class: 'skp-toolbar' });
  const cardsBox = h('div', { class: 'skp-pool-cards' });
  const jsonArea = h('textarea', { class: 'field skp-editor skp-json', spellcheck: 'false' });
  const jsonDetails = h('details', { style: 'margin:10px 0' });
  const harnessDatalist = h('datalist', { id: 'aihub-harness-list' },
    ...['claude', 'agy', 'codex', 'opencode', 'kiro'].map((hn) => h('option', { value: hn }))
  );

  let poolsMap = {};
  let poolShapes = {};
  let healthMap = {};
  let poolsDirty = false;
  let loading = false;
  let destroyed = false;
  let loadSeq = 0;
  let probeHarness = 'agy';

  const claudeCapInput = h('input', {
    class: 'field',
    type: 'number',
    min: '0',
    max: '20',
    step: '1',
    value: '2',
    style: 'width:54px;margin:0 4px',
    'aria-label': '单项目 Claude Code 上限',
  });

  const say = (t, isBad = false) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', !!isBad);
  };

  function serializePools() {
    const out = {};
    for (const [poolName, list] of Object.entries(poolsMap)) {
      const cleanList = (Array.isArray(list) ? list : []).map((c) => {
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

  function stripReadOnlyJson(parsed) {
    const out = {};
    for (const [poolName, rawVal] of Object.entries(parsed || {})) {
      const arr = Array.isArray(rawVal)
        ? rawVal
        : (rawVal && typeof rawVal === 'object' && Array.isArray(rawVal.candidates) ? rawVal.candidates : null);
      if (!arr) continue;
      out[poolName] = arr.filter((c) => c && typeof c === 'object').map((c) => {
        const clean = {
          harness: String(c.harness || '').trim(),
          model: String(c.model || '').trim(),
        };
        if (typeof c.magpieProvider === 'string' && c.magpieProvider.trim()) clean.magpieProvider = c.magpieProvider.trim();
        if (typeof c.quirks === 'string' && c.quirks.trim()) clean.quirks = c.quirks.trim();
        return clean;
      });
    }
    return out;
  }

  function syncJsonArea() {
    jsonArea.value = JSON.stringify(stripReadOnlyJson(serializePools()), null, 2);
  }

  function candidateHealth(c) {
    const hObj = (c && typeof c.health === 'object' && c.health)
      || healthMap[`${c.harness}:${c.model}`]
      || healthMap[`${c.harness}/${c.model}`]
      || null;
    const rawStatus = String((hObj && (hObj.status || hObj.state)) || (typeof c.health === 'string' ? c.health : '') || c.status || c.state || (c.healthy === false ? 'cooldown' : 'healthy')).toLowerCase();
    const rem = (hObj && (hObj.magpieInfo ?? hObj.remaining ?? hObj.magpieRemaining ?? hObj.quotaRemaining ?? hObj.balance))
      ?? c.magpieInfo ?? c.remaining ?? c.magpieRemaining ?? c.quotaRemaining;
    const resetAt = (hObj && (hObj.resetAt ?? hObj.cooldownUntil)) ?? c.resetAt ?? c.cooldownUntil;
    const reason = (hObj && (hObj.reason || hObj.msg)) || c.reason || '';

    if (rawStatus === 'cooldown' || rawStatus === 'cooling') {
      const rs = formatResetAt(resetAt);
      return { tagCls: 'skp-st-cool', label: `冷却中${rs ? ' · ' + rs : ''}`, isCooldown: true, title: reason };
    }
    if (rawStatus === 'exhausted' || rawStatus === 'depleted') {
      const remStr = rem != null && rem !== '' ? ` · ${rem}` : '';
      return { tagCls: 'skp-st-bad', label: `耗尽${remStr}`, isCooldown: true, title: reason };
    }
    if (rawStatus === 'low_quota' || rawStatus === 'low' || rawStatus === 'warn') {
      const remStr = rem != null && rem !== '' ? ` · ${rem}` : '';
      return { tagCls: 'skp-st-warn', label: `低额度${remStr}`, isCooldown: false, title: reason };
    }
    const remStr = rem != null && rem !== '' ? ` · ${rem}` : '';
    return { tagCls: 'skp-st-ok', label: `健康${remStr}`, isCooldown: false, title: reason };
  }

  function sortedPoolNames() {
    const keys = Object.keys(poolsMap);
    keys.sort((a, b) => {
      const ia = POOL_ORDER.indexOf(a);
      const ib = POOL_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return keys;
  }

  function renderPools() {
    const poolNames = sortedPoolNames();
    const harnessesInPools = new Set(['claude', 'agy', 'codex', 'opencode', 'kiro']);
    for (const list of Object.values(poolsMap)) {
      for (const c of list || []) if (c.harness) harnessesInPools.add(c.harness);
    }
    const harnessOpts = [...harnessesInPools];
    if (!harnessOpts.includes(probeHarness)) probeHarness = harnessOpts[0] || 'agy';

    const probeSel = h('select', {
      class: 'field',
      title: '选择要按需探测可用性与额度的 Harness',
      onchange: (e) => { probeHarness = e.target.value; },
    }, ...harnessOpts.map((hn) => h('option', { value: hn, text: hn, selected: hn === probeHarness })));

    const savePoolsBtn = h('button', {
      class: 'btn go',
      type: 'button',
      text: poolsDirty ? '保存模型池 *' : '保存模型池',
      onclick: async () => {
        say('正在保存全局模型池配置…');
        const r = await mesh.savePools(serializePools());
        if (destroyed) return;
        if (!r || !r.ok) {
          say((r && r.msg) || '保存模型池失败', true);
          return;
        }
        poolsDirty = false;
        say('已保存全局模型能力池配置');
        await load();
      },
    });

    toolbarBox.replaceChildren(
      savePoolsBtn,
      h('button', {
        class: 'btn',
        type: 'button',
        text: '复位全部熔断',
        onclick: async () => {
          say('正在复位全部模型冷却熔断状态…');
          const r = await mesh.resetPoolCooldown();
          if (destroyed) return;
          say(r && r.ok ? '已复位全部熔断状态' : ((r && r.msg) || '复位失败'), !(r && r.ok));
          await load();
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
          if (destroyed) return;
          say(r && r.ok ? `已完成 ${probeHarness} 余额探测` : ((r && r.msg) || '探测失败'), !(r && r.ok));
          await load();
        },
      }),
      h('button', {
        class: 'btn',
        type: 'button',
        text: '＋ 新建模型池…',
        onclick: async () => {
          const name = await askText({ title: '新建模型能力池', label: '模型池名称（如 fast-coder / flagship / heavy-reasoner）：', max: 40 });
          if (!name || destroyed) return;
          const clean = name.trim();
          if (!clean) return;
          if (poolsMap[clean]) { say(`模型池「${clean}」已存在`, true); return; }
          poolsMap[clean] = [{ harness: 'claude', model: '', magpieProvider: '', quirks: '' }];
          poolShapes[clean] = 'array';
          poolsDirty = true;
          renderPools();
          syncJsonArea();
        },
      }),
      h('span', { style: 'display:inline-flex;align-items:center;gap:4px;margin-left:4px' },
        h('small', { text: '单项目 Claude 上限(0=不限):' }),
        claudeCapInput,
        h('button', {
          class: 'btn',
          type: 'button',
          text: '保存上限',
          onclick: async () => {
            const val = Math.max(0, Math.min(20, Math.trunc(Number(claudeCapInput.value) || 0)));
            claudeCapInput.value = String(val);
            const r = await mesh.saveConfig({ maxClaudePerProject: val });
            if (destroyed) return;
            if (r && r.ok) say(val === 0 ? '已关闭单项目 Claude Code 数量上限' : `已保存：单项目最多 ${val} 个活跃 Claude Code 成员`);
            else say((r && r.msg) || '保存上限失败', true);
          },
        })
      ),
      h('button', { class: 'btn', type: 'button', text: '刷新', disabled: loading, onclick: load })
    );

    if (loading && !poolNames.length) {
      cardsBox.replaceChildren(h('p', { class: 'ghint', text: '正在加载全局模型能力池…' }));
      return;
    }

    if (!poolNames.length) {
      cardsBox.replaceChildren(h('p', { class: 'ghint', text: '暂无模型能力池配置，可点击上方「＋ 新建模型池…」添加。' }));
      return;
    }

    const markDirty = () => {
      if (!poolsDirty) {
        poolsDirty = true;
        savePoolsBtn.textContent = '保存模型池 *';
      }
      syncJsonArea();
    };

    const cards = poolNames.map((poolName) => {
      const list = poolsMap[poolName] || [];
      const rows = list.map((c, idx) => {
        const hp = candidateHealth(c);
        const harnessIn = h('input', {
          class: 'field',
          type: 'text',
          list: 'aihub-harness-list',
          value: c.harness || '',
          placeholder: 'harness',
          style: 'width:92px',
          oninput: (e) => { c.harness = e.target.value; markDirty(); },
        });
        const modelIn = h('input', {
          class: 'field',
          type: 'text',
          value: c.model || '',
          placeholder: 'model (如 sonnet / 空=默认)',
          style: 'min-width:150px;width:100%',
          oninput: (e) => { c.model = e.target.value; markDirty(); },
        });
        const provIn = h('input', {
          class: 'field',
          type: 'text',
          value: c.magpieProvider || '',
          placeholder: 'magpieProvider (可选)',
          style: 'width:120px',
          oninput: (e) => { c.magpieProvider = e.target.value; markDirty(); },
        });
        const quirksIn = h('input', {
          class: 'field',
          type: 'text',
          value: c.quirks || '',
          placeholder: 'quirks 微调提示（可选）',
          style: 'min-width:130px;width:100%',
          oninput: (e) => { c.quirks = e.target.value; markDirty(); },
        });

        const actBtns = [
          (hp.isCooldown || c.status === 'cooldown' || c.healthy === false) ? h('button', {
            class: 'btn fleet-sm',
            type: 'button',
            text: '复位',
            title: '复位该候选模型的冷却熔断状态',
            onclick: async () => {
              const r = await mesh.resetPoolCooldown(c.harness, c.model || '');
              if (destroyed) return;
              say(r && r.ok ? `已复位 ${c.harness}${c.model ? ':' + c.model : ''}` : ((r && r.msg) || '复位失败'), !(r && r.ok));
              await load();
            },
          }) : null,
          h('button', {
            class: 'btn fleet-sm',
            type: 'button',
            text: '↑',
            title: '上移顺位',
            disabled: idx === 0,
            onclick: () => {
              if (idx <= 0) return;
              const tmp = list[idx - 1];
              list[idx - 1] = list[idx];
              list[idx] = tmp;
              poolsDirty = true;
              renderPools();
              syncJsonArea();
            },
          }),
          h('button', {
            class: 'btn fleet-sm',
            type: 'button',
            text: '↓',
            title: '下移顺位',
            disabled: idx >= list.length - 1,
            onclick: () => {
              if (idx >= list.length - 1) return;
              const tmp = list[idx + 1];
              list[idx + 1] = list[idx];
              list[idx] = tmp;
              poolsDirty = true;
              renderPools();
              syncJsonArea();
            },
          }),
          h('button', {
            class: 'btn no fleet-sm',
            type: 'button',
            text: '删',
            title: '删除此候选条目',
            onclick: () => {
              list.splice(idx, 1);
              poolsDirty = true;
              renderPools();
              syncJsonArea();
            },
          }),
        ].filter(Boolean);

        return h('tr', {},
          h('td', { class: 'skp-rank', style: 'white-space:nowrap', text: `#${idx + 1}` }),
          h('td', { style: 'white-space:nowrap' }, h('span', { class: `skp-tag ${hp.tagCls}`, style: 'white-space:nowrap', title: hp.title || '', text: hp.label })),
          h('td', {}, harnessIn),
          h('td', {}, modelIn),
          h('td', {}, provIn),
          h('td', {}, quirksIn),
          h('td', { style: 'white-space:nowrap' }, ...actBtns)
        );
      });

      return h('div', { class: 'mcp-card skp-card' },
        h('div', { class: 'mcp-h' },
          h('b', { text: poolName }),
          h('span', { class: 'skp-tag', text: `${list.length} 个候选` }),
          h('button', {
            class: 'btn fleet-sm',
            type: 'button',
            style: 'margin-left:auto',
            text: '＋ 添加候选',
            onclick: () => {
              list.push({ harness: 'claude', model: '', magpieProvider: '', quirks: '' });
              poolsDirty = true;
              renderPools();
              syncJsonArea();
            },
          })
        ),
        rows.length
          ? h('table', { class: 'mcp-t skp-pool-t' },
              h('thead', {}, h('tr', {},
                h('th', { style: 'white-space:nowrap', text: '顺位' }),
                h('th', { style: 'white-space:nowrap', text: '健康状态' }),
                h('th', { text: 'Harness' }),
                h('th', { text: '模型 (Model)' }),
                h('th', { text: 'Magpie 渠道' }),
                h('th', { text: 'Quirks 备注' }),
                h('th', { text: '操作' })
              )),
              h('tbody', {}, ...rows))
          : h('p', { class: 'ghint', text: '该模型池暂无候选条目，请点击右上角「＋ 添加候选」。' })
      );
    });

    cardsBox.replaceChildren(...cards);
  }

  const formatJsonBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: '格式化 JSON',
    onclick: () => {
      try {
        const parsed = JSON.parse(jsonArea.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          say('JSON 顶层必须是对象 { poolName: [...] }', true);
          return;
        }
        jsonArea.value = JSON.stringify(stripReadOnlyJson(parsed), null, 2);
        say('已格式化并清理只读字段');
      } catch (e) {
        say(`JSON 解析失败：${e.message}`, true);
      }
    },
  });

  const saveJsonBtn = h('button', {
    class: 'btn go',
    type: 'button',
    text: '应用 JSON 并保存',
    onclick: async () => {
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
      const cleaned = stripReadOnlyJson(parsed);
      for (const [k, list] of Object.entries(cleaned)) {
        if (list.some((c) => !c.harness)) {
          say(`模型池「${k}」存在缺少 harness 字段的条目`, true);
          return;
        }
      }
      say('正在从 JSON 保存全局模型池配置…');
      const r = await mesh.savePools(cleaned);
      if (destroyed) return;
      if (!r || !r.ok) {
        say((r && r.msg) || '保存模型池配置失败', true);
        return;
      }
      poolsDirty = false;
      say('已保存全局模型池配置');
      await load();
    },
  });

  jsonDetails.append(
    h('summary', { style: 'cursor:pointer;font-weight:bold;color:var(--border);padding:2px 0', text: '高级：JSON 批量导入 / 导出编辑器' }),
    h('p', { class: 'ghint', text: '仅保存候选配置字段（harness、model、magpieProvider、quirks）；运行时健康度字段会自动剥离。' }),
    jsonArea,
    h('div', { class: 'skp-actions', style: 'margin-top:6px' }, saveJsonBtn, formatJsonBtn)
  );

  root.append(
    h('h3', { class: 'aim-h', style: 'margin-top:2px', text: '全局模型能力池与熔断路由（AmeMesh 唯一权威入口）' }),
    h('p', { class: 'ghint', text: '决定跨机协同各角色（Master / Worker / Verifier）的候选模型顺位、Magpie 低额度自动降权与熔断冷却恢复。支持行内直接调整顺位或展开底部 JSON 批量导入导出。' }),
    harnessDatalist,
    toolbarBox,
    msg,
    cardsBox,
    jsonDetails
  );

  async function load() {
    if (destroyed) return;
    const seq = ++loadSeq;
    loading = true;
    renderPools();
    const [r, cfgRes] = await Promise.all([
      mesh.getPools(),
      mesh.getConfig(),
    ]);
    if (destroyed || seq !== loadSeq) return;
    loading = false;
    if (cfgRes && cfgRes.ok && cfgRes.config && cfgRes.config.maxClaudePerProject !== undefined) {
      claudeCapInput.value = String(cfgRes.config.maxClaudePerProject);
    }
    if (!r || !r.ok || !r.pools) {
      say((r && r.msg) || '读取全局模型池失败', true);
      renderPools();
      return;
    }
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
    renderPools();
    syncJsonArea();
  }

  load();
  return { root, load, destroy() { destroyed = true; } };
}

let inst = null;

export function open(arg) {
  const opts = normalizeOpts(arg);
  if (inst) {
    wm.open({ id: 'magpie' });
    inst.applyOpts(opts);
    return;
  }
  inst = mount(opts);
  wm.open({
    id: 'magpie',
    title: 'AI 与额度',
    icon: icon('chip_ramdrive', true),
    width: 1060,
    height: 720,
    content: inst.root,
    onClose: () => {
      inst.destroy();
      inst = null;
    },
  });
}

function mount(initialOpts = { tab: 'quota' }) {
  let activeTab = TABS.some(([id]) => id === initialOpts.tab) ? initialOpts.tab : 'quota';

  const tabBar = h('div', {
    class: 'skp-tabs',
    role: 'tablist',
    'aria-label': 'AI 与额度中心',
    style: 'flex:none;padding:6px 8px;margin:0;background:var(--head-bg);border-bottom:1px solid var(--edge)',
  });

  const quotaWrap = h('div', { dataset: { pane: 'quota' }, style: 'display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden' });
  const modelsWrap = h('div', { dataset: { pane: 'models' }, style: 'display:none;flex:1;min-height:0;overflow:auto;padding:8px 14px 18px' });
  const skillsWrap = h('div', { dataset: { pane: 'skills' }, style: 'display:none;flex:1;min-height:0;overflow:auto' });
  const mcpWrap = h('div', { dataset: { pane: 'mcp' }, style: 'display:none;flex:1;min-height:0;overflow:auto' });
  const clientsWrap = h('div', { dataset: { pane: 'clients' }, style: 'display:none;flex:1;min-height:0;overflow:auto;padding:8px 14px 18px' });

  let quotaView = null;
  let poolsView = null;
  let aiModelsView = null;
  let skillsView = null;
  let mcpView = null;
  let ocGuideView = null;
  let claudeApisView = null;
  let apisHeadEl = null;

  function ensureQuota() {
    if (!quotaView) {
      quotaView = magpiePanel({ onJumpModels: () => switchTab('models', { sec: 'pools' }) });
      quotaWrap.replaceChildren(quotaView.root);
    }
  }

  function ensureModels(sec = '') {
    if (!poolsView || !aiModelsView) {
      poolsView = createGlobalPoolsSection();
      aiModelsView = aiModelsPanel(sec);
      const nasHead = h('h3', {
        class: 'aim-h',
        style: 'margin-top:18px;padding-top:10px;border-top:2px solid var(--edge)',
        text: 'NAS 后台自动任务模型与官方备用 API 密钥',
      });
      modelsWrap.replaceChildren(poolsView.root, nasHead, aiModelsView.root);
    } else {
      poolsView.load();
      if (sec) aiModelsView.show(sec);
    }
    if (sec === 'pools') {
      requestAnimationFrame(() => { try { modelsWrap.scrollTop = 0; } catch {} });
    }
  }

  function ensureSkills(sub = '') {
    if (!skillsView) {
      skillsView = skillsPanel(sub || 'skills');
      skillsWrap.replaceChildren(skillsView.root);
    } else if (sub) {
      skillsView.show(sub);
    }
  }

  function ensureMcp() {
    if (!mcpView) {
      mcpView = mcpPanel();
      mcpWrap.replaceChildren(mcpView.root);
    } else {
      mcpView.show();
    }
  }

  function ensureClients(sec = '') {
    if (!ocGuideView || !claudeApisView) {
      ocGuideView = opencodeGuidePanel();
      claudeApisView = claudeApisPanel();
      apisHeadEl = h('h3', {
        class: 'aim-h',
        style: 'margin-top:18px;padding-top:12px;border-top:2px solid var(--edge)',
        text: '各电脑本地 Claude 多环境启动入口 (cc-environments)',
      });
      clientsWrap.replaceChildren(ocGuideView.root, apisHeadEl, claudeApisView.root);
    } else if (sec === 'apis') {
      claudeApisView.show();
    }
    if (sec === 'apis' && apisHeadEl) {
      requestAnimationFrame(() => { try { apisHeadEl.scrollIntoView({ block: 'start' }); } catch {} });
    } else if (sec === 'opencode') {
      requestAnimationFrame(() => { try { clientsWrap.scrollTop = 0; } catch {} });
    }
  }

  const tabBtns = TABS.map(([id, label]) => h('button', {
    class: 'btn skp-tab',
    type: 'button',
    role: 'tab',
    dataset: { tab: id },
    text: label,
    onclick: () => switchTab(id),
  }));
  tabBar.replaceChildren(...tabBtns);

  function renderTabs() {
    for (const b of tabBtns) {
      const isSel = b.dataset.tab === activeTab;
      b.classList.toggle('sel', isSel);
      b.classList.toggle('go', isSel);
      b.setAttribute('aria-selected', String(isSel));
    }
    quotaWrap.style.display = activeTab === 'quota' ? 'flex' : 'none';
    modelsWrap.style.display = activeTab === 'models' ? 'block' : 'none';
    skillsWrap.style.display = activeTab === 'skills' ? 'block' : 'none';
    mcpWrap.style.display = activeTab === 'mcp' ? 'block' : 'none';
    clientsWrap.style.display = activeTab === 'clients' ? 'block' : 'none';
  }

  function switchTab(tabId, extra = {}) {
    if (TABS.some(([id]) => id === tabId)) activeTab = tabId;
    if (activeTab === 'quota') ensureQuota();
    else if (activeTab === 'models') ensureModels(extra.sec || '');
    else if (activeTab === 'skills') ensureSkills(extra.sub || '');
    else if (activeTab === 'mcp') ensureMcp();
    else if (activeTab === 'clients') ensureClients(extra.sec || '');
    renderTabs();
  }

  const root = h('div', {
    class: 'ai-hub',
    style: 'height:100%;min-height:0;display:flex;flex-direction:column;background:var(--body);color:var(--ink)',
  }, tabBar, quotaWrap, modelsWrap, skillsWrap, mcpWrap, clientsWrap);

  switchTab(activeTab, initialOpts);

  return {
    root,
    applyOpts(opts = {}) {
      switchTab(opts.tab || activeTab, opts);
    },
    destroy() {
      for (const v of [quotaView, poolsView, aiModelsView, skillsView, mcpView, ocGuideView, claudeApisView]) {
        if (v && v.destroy) {
          try { v.destroy(); } catch {}
        }
      }
    },
  };
}
