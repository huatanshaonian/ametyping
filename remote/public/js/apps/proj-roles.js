// Roles & Model Pools tab for AmeMesh Projects (used by projects.js).
import { h, formatResetAt } from '../util.js';
import * as mesh from '../mesh.js';
import { confirmBox, askText } from '../dialog.js';
import { roleOriginOf } from './proj-const.js';

export function createRolesTab({ say }) {
  let roles = [];
  let selectedRole = null;
  let roleDraft = '';
  let roleDirty = false;
  let rolesLoading = false;
  let rolesLoadToken = 0;
  let rolesErr = '';

  let poolsMap = {};       // poolName -> [{ harness, model, magpieProvider, quirks, ... }]
  let poolShapes = {};     // poolName -> 'array' | { objMeta }
  let healthMap = {};      // optional top-level health map
  let poolsDirty = false;
  let poolsLoading = false;
  let poolsLoadToken = 0;
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
      if (destroyed) return;
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
              if (!ok || destroyed) return;
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
        if (destroyed) return;
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
        if (destroyed) return;
        say(`正在恢复默认角色「${cur.name}」…`);
        const r = await mesh.resetRole(cur.name);
        if (destroyed) return;
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
          if (destroyed) return;
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
          if (destroyed) return;
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
          if (destroyed) return;
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
          if (!name || destroyed) return;
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
                if (destroyed) return;
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
    const token = ++rolesLoadToken;
    rolesLoading = true;
    rolesErr = '';
    renderRolesSection();
    const r = await mesh.getRoles();
    if (destroyed || token !== rolesLoadToken) return;
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
    const token = ++poolsLoadToken;
    poolsLoading = true;
    poolsErr = '';
    renderPoolsSection();
    const r = await mesh.getPools();
    if (destroyed || token !== poolsLoadToken) return;
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
