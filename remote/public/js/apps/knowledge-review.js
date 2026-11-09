import { h } from '../util.js';
import * as net from '../net.js';
const scopes = { global: '共享全局', machine: '机器', project: '项目' };
const categories = {
  duplicate: '去重合并',
  conflict: '冲突核对',
  scope: '归属调整',
  split: '逐条拆分',
  rewrite: '整理表述',
  defensive: '过度防御修正',
  expression: '生硬/奇怪表达润色',
  outdated: '过时/待更新核对',
};
const statuses = { running: '分析中', ready: '待审阅', failed: '失败', applied: '已应用', discarded: '已丢弃' };
const button = (text, onclick, cls = '') => h('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', text, onclick });
export function createReviewPanel({ refs, get, notify, applied, initialReviewId = null }) {
  let dead = false, timer = null, ai = null, currentReviewId = null;
  const root = h('div', { class: 'knowledge-review' }), report = h('div', { class: 'knowledge-report-area' }), history = h('div', { class: 'knowledge-history-card knowledge-card' });
  const instructions = h('textarea', { class: 'field knowledge-instruction', placeholder: '例如：把长文拆成一事一条；找出不同电脑上的重复与矛盾；保留日期和证据。' });
  const apiOnly = h('input', { type: 'checkbox', checked: true });
  const model = h('select', { class: 'field', title: '记忆智能整理模型' });
  const route = h('p', { class: 'ghint' });
  const run = button('智能整理所选', start, 'go');
  const send = async (p, d) => {
    const r = await net.post('/api/knowledge/' + p, d);
    if (!r.ok) throw Error(r.msg || '操作失败');
    return r.item;
  };
  function fillModels() {
    if (!ai) return;
    const current = model.value || ai.tasks.find(t => t.id === 'memory')?.set.model || '';
    const list = ai.models.filter(m => !apiOnly.checked || m.provider === 'claude');
    model.replaceChildren(...list.map(m => h('option', { value: m.slug, text: m.name })));
    if (list.some(m => m.slug === current)) model.value = current;
    const selected = list.find(m => m.slug === model.value);
    run.disabled = !list.length || (apiOnly.checked && !ai.api?.has && !selected?.api);
    route.textContent = apiOnly.checked
      ? (selected?.api ? '直接调用 NAS 上的 ' + selected.api + ' API 入口，沿用该入口的模型、密钥和网络；失败时不会切换到 CLI。' : ai.api?.has ? '通过已配置的 Claude API 分析，失败时不会切换到 CLI。' : '尚未配置 Claude API 密钥，请打开“模型与 API 设置”；也可配置 NAS 的 API 别名。')
      : '使用“AI 模型”里配置的通道和后备模型，可能通过 API、Claude Code 或 Codex 调用。';
  }
  apiOnly.addEventListener('change', fillModels);
  model.addEventListener('change', fillModels);
  async function loadModels() {
    try { const r = await fetch('/api/ai', { cache: 'no-store' }); const d = await r.json(); if (!dead && d.models) { ai = d; fillModels(); } }
    catch { if (!dead) route.textContent = '无法读取 AI 设置，请先配置 AI 模型。'; }
  }
  async function start() {
    try {
      if (!refs().length) throw Error('请先在记忆列表或来源列表勾选内容');
      run.disabled = true;
      const prior = ai?.tasks.find(t => t.id === 'memory')?.set;
      const setting = await net.post('/api/ai/set', { tasks: { memory: { model: model.value, effort: prior?.model === model.value ? prior.effort : '' } } });
      if (!setting.ok) throw Error(setting.msg || '无法保存模型选择');
      const result = await send('review/start', { refs: refs(), instruction: instructions.value, apiOnly: apiOnly.checked });
      if (dead) return;
      notify('正在分析所选记忆；尚未修改或发布记忆');
      await show(result.id);
    } catch (e) { if (!dead) notify(e.message, true); }
    finally { if (!dead) fillModels(); }
  }
  function difference(a, b) {
    const other = new Set(b.split('\n').map(s => s.trim()));
    return h('pre', { class: 'knowledge-diff' }, ...a.split('\n').map(line => h('span', {
      class: other.has(line.trim()) ? '' : 'knowledge-diff-only', text: line + '\n',
    })));
  }
  async function align() {
    try {
      const d = await send('align', { refs: refs() });
      if (dead) return;
      const box = h('div', { class: 'knowledge-card' },
        h('h3', { class: 'knowledge-section-title', text: '逐条对照 (2-gram 相似度与行级差异)' }),
        h('p', { class: 'ghint', text: '高亮表示另一条中没有的原文行；相似度只用于找线索，不代表事实相同或矛盾。' }));
      for (const p of d.pairs) {
        const a = d.items.find(x => x.label === p.left), b = d.items.find(x => x.label === p.right);
        box.append(h('details', { class: 'knowledge-version-item', open: true }, h('summary', { text: a.name + ' ↔ ' + b.name + ' · 相似度 ' + p.score + '% · ' + p.note }),
          h('div', { class: 'knowledge-columns' }, h('div', {}, h('b', { text: a.source }), difference(a.body, b.body)), h('div', {}, h('b', { text: b.source }), difference(b.body, a.body)))));
      }
      if (!d.pairs.length) box.append(h('p', { text: '没有发现正文重复或明显文字相似的条目，仍可逐条核对或调用智能整理。' }));
      box.append(h('div', { class: 'knowledge-columns' }, ...d.items.map(x => h('details', { class: 'knowledge-version-item' },
        h('summary', { text: x.label + ' · ' + x.name + ' · ' + scopes[x.scope] + (x.owner ? ' / ' + x.owner : '') }), h('small', { text: x.source }), h('pre', { text: x.body })))));
      const published = d.items.filter(x => x.kind === 'memory');
      if (published.length) {
        const label = x => x.name + ' · ' + scopes[x.scope] + (x.owner ? ' / ' + x.owner : '');
        const target = h('select', { class: 'field', title: '更新哪条已发布记忆' }, ...published.map(x => h('option', { value: x.label, text: label(x) })));
        const source = h('select', { class: 'field', title: '参考哪条来源' }, ...d.items.map(x => h('option', { value: x.label, text: label(x) })));
        const body = h('textarea', { class: 'field knowledge-body' });
        body.value = published[0].body;
        target.addEventListener('change', () => { body.value = d.items.find(x => x.label === target.value).body; });
        box.append(h('h3', { class: 'knowledge-section-title', text: '手动对齐合并' }), h('p', { class: 'ghint', text: '选择目标，编辑合并后的正文，再生成待审阅方案。保存方案不会立即发布。' }),
          h('div', { class: 'knowledge-toolbar' }, target, source, button('填入来源正文', () => { body.value = d.items.find(x => x.label === source.value).body; })), body,
          button('生成手动对齐方案', async () => {
            try {
              const x = d.items.find(x => x.label === target.value);
              const r = await send('review/manual', { refs: d.items.map(x => x.ref), groups: [{ title: '对齐 ' + x.name, category: 'rewrite', reason: '用户核对后编辑的合并正文',
                operations: [{ action: 'update', target: x.label, scope: x.scope, owner: x.owner, name: x.name, body: body.value }] }] });
              await show(r.id);
            } catch (e) { notify(e.message, true); }
          }, 'go'));
      }
      report.replaceChildren(box);
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function show(id) {
    clearTimeout(timer);
    currentReviewId = id;
    try {
      const r = (await get('/review?id=' + encodeURIComponent(id))).item;
      if (dead || !r) return;
      const kindBadge = r.kind === 'monthly' ? '📅 月度记忆体检（需手动确认）' : r.kind === 'auto' ? '⚡ 每日增量审阅待裁决' : r.kind === 'ai' ? '🤖 智能整理方案' : '✏️ 手动对齐方案';
      const box = h('div', { class: 'knowledge-card' },
        h('div', { class: 'knowledge-card-head' },
          h('h3', { class: 'knowledge-section-title', text: `${kindBadge} · ${statuses[r.status] || r.status}` }),
          h('small', { class: 'ghint', text: new Date(r.created).toLocaleString() })));
      if (r.status === 'running') {
        box.append(h('p', { text: '模型正在分析，离开页面不会丢失任务，稍后可在方案历史中查看。' }));
        report.replaceChildren(box);
        timer = setTimeout(() => show(id), 1500);
        return;
      }
      if (r.error) box.append(h('p', { class: 'ghint bad', text: r.error }));
      if (r.status === 'ready') notify('方案已就绪：可直接修改下方内容、追加手动修改，再单组或勾选批量应用');
      else if (r.status === 'failed') notify(r.error || '分析失败，请检查模型和 API 设置', true);
      if (r.result.summary) box.append(h('p', { class: 'knowledge-banner', text: r.result.summary }));
      if (r.status === 'ready') {
        box.append(h('p', { class: 'ghint', text: '✏️ 提示：你可以直接在下方修改任意条目的范围、归属、名称与正文，或点击「+ 追加手动修改」补充你的修改，然后点「确认并应用本组」或勾选后批量点「应用勾选分组」。' }));
      }
      const chosen = [], edits = [];
      const memoryItems = (r.snapshot?.items || []).filter(x => x.kind === 'memory');
      for (const [gi, group] of (r.result.groups || []).entries()) {
        const pick = h('input', { type: 'checkbox', disabled: r.status !== 'ready' });
        chosen.push({ pick, gi });
        const opsContainer = h('div', { class: 'knowledge-ops-list' });
        const groupEdits = [];
        const renderOp = (op, oi, isAdded = false) => {
          const before = (r.snapshot?.items || []).find(x => x.label === op.target);
          const actionSel = h('select', { class: 'field', style: 'max-width:110px', title: '操作类型' },
            h('option', { value: 'create', text: '新增记忆' }),
            ...(memoryItems.length ? [h('option', { value: 'update', text: '修改记忆' }), h('option', { value: 'disable', text: '停用记忆' })] : []));
          actionSel.value = op.action || 'create';
          const targetSel = h('select', { class: 'field', style: 'max-width:190px', title: '目标记忆' },
            h('option', { value: '', text: '（新增条目无需选择目标）' }),
            ...memoryItems.map(x => h('option', { value: x.label, text: x.label + ' · ' + x.name })));
          targetSel.value = op.target || '';
          const scope = h('select', { class: 'field', style: 'max-width:120px' }, ...Object.entries(scopes).map(([value, text]) => h('option', { value, text })));
          scope.value = op.scope || 'global';
          const owner = h('input', { class: 'field', value: op.owner || '', placeholder: '归属（共享全局留空）' });
          const name = h('input', { class: 'field', value: op.name || '', placeholder: '记忆名称' });
          const body = h('textarea', { class: 'field knowledge-body' });
          body.value = op.body || '';
          const syncLock = () => {
            const locked = r.status !== 'ready' || actionSel.value === 'disable';
            for (const x of [scope, owner, name, body]) x.disabled = locked;
            actionSel.disabled = r.status !== 'ready';
            targetSel.disabled = r.status !== 'ready' || actionSel.value === 'create';
            if (actionSel.value === 'create') targetSel.value = '';
            else if (!targetSel.value && memoryItems[0]) {
              targetSel.value = memoryItems[0].label;
              const m = memoryItems[0];
              scope.value = m.scope; owner.value = m.owner || ''; name.value = m.name;
              if (!body.value) body.value = m.body;
            }
          };
          actionSel.addEventListener('change', syncLock);
          targetSel.addEventListener('change', () => {
            const m = memoryItems.find(x => x.label === targetSel.value);
            if (m) { scope.value = m.scope; owner.value = m.owner || ''; name.value = m.name; if (actionSel.value === 'disable') body.value = m.body; }
          });
          syncLock();
          const entry = { gi, oi, action: actionSel, target: targetSel, scope, owner, name, body };
          edits.push(entry);
          groupEdits.push(entry);
          const opBox = h('div', { class: 'knowledge-op-item' },
            h('div', { class: 'knowledge-card-head' },
              h('b', { text: (isAdded ? '➕ 手动追加操作：' : ({ create: '新增', update: '修改', disable: '停用' })[op.action] + '：') + (op.name || '新条目') }),
              isAdded && r.status === 'ready' ? button('移除此项', () => {
                const idx = edits.indexOf(entry); if (idx >= 0) edits.splice(idx, 1);
                const gIdx = groupEdits.indexOf(entry); if (gIdx >= 0) groupEdits.splice(gIdx, 1);
                opBox.remove();
              }) : null
            ),
            ...(before ? [h('details', { class: 'knowledge-version-item' }, h('summary', { text: '原文 · v' + before.ref.revision + ' · ' + before.source }), h('pre', { text: before.body }))] : []),
            h('div', { class: 'knowledge-toolbar' }, actionSel, targetSel, scope, owner, name),
            body);
          opsContainer.append(opBox);
        };
        for (const [oi, op] of group.operations.entries()) renderOp(op, oi, false);
        const groupBar = h('div', { class: 'capi-btns' });
        if (r.status === 'ready') {
          groupBar.append(
            button('+ 在本组追加手动修改', () => {
              const defTarget = memoryItems[0];
              renderOp({
                action: defTarget ? 'update' : 'create',
                target: defTarget ? defTarget.label : '',
                scope: defTarget ? defTarget.scope : 'global',
                owner: defTarget ? (defTarget.owner || '') : '',
                name: defTarget ? defTarget.name : '',
                body: defTarget ? defTarget.body : '',
              }, groupEdits.length, true);
              pick.checked = true;
            }),
            button('确认并应用本组（含手动修改）', async () => {
              try {
                const ops = groupEdits.map(x => ({
                  action: x.action.value, target: x.action.value === 'create' ? '' : x.target.value,
                  scope: x.scope.value, owner: x.scope.value === 'global' ? '' : x.owner.value.trim(),
                  name: x.name.value.trim(), body: x.body.value,
                }));
                const res = await send('review/apply', { id, groups: [gi], groupOperations: { [gi]: ops }, keepUnselected: true });
                if (!dead) {
                  notify('本组修改已应用并同步；' + (res.remainingId ? '其余未处理分组已保留在当前方案中' : '全部待办组已处理完毕'));
                  await applied();
                  if (res.remainingId) await show(res.remainingId);
                }
              } catch (e) { notify(e.message, true); }
            }, 'go'),
            button('忽略本组', async () => {
              try {
                const res = await send('review/ignore-group', { id, group: gi });
                if (!dead) {
                  notify(res.remaining ? `已忽略该分组，剩余 ${res.remaining} 组待处理` : '已忽略最后一组的方案');
                  await applied();
                  if (res.remaining) await show(id);
                }
              } catch (e) { notify(e.message, true); }
            })
          );
        }
        const catBadgeCls = ['conflict', 'defensive', 'outdated'].includes(group.category) ? 'scope-project' : 'scope-global';
        const card = h('section', { class: 'knowledge-proposal' },
          h('label', { class: 'knowledge-proposal-title' }, pick,
            h('span', { class: 'knowledge-badge ' + catBadgeCls, text: categories[group.category] || group.category }),
            h('b', { text: group.title + (r.status === 'applied' ? (r.appliedGroups.includes(gi) ? '（已应用）' : '（未选择）') : '') })),
          h('p', { class: 'ghint', text: group.reason }),
          opsContainer,
          groupBar);
        box.append(card);
      }
      const actBar = h('div', { class: 'capi-btns' });
      if (r.status === 'ready') {
        box.append(h('p', { class: 'ghint', text: '勾选完整分组后应用。拆分组中的新增和停用会一起提交；原记忆或来源更新后，需重新分析。' }));
        actBar.append(button('应用勾选分组', async () => {
          try {
            const groups = chosen.filter(x => x.pick.checked).map(x => x.gi);
            const groupOperations = {};
            for (const gIdx of groups) {
              groupOperations[gIdx] = edits.filter(x => x.gi === gIdx).map(x => ({
                action: x.action.value, target: x.action.value === 'create' ? '' : x.target.value,
                scope: x.scope.value, owner: x.scope.value === 'global' ? '' : x.owner.value.trim(),
                name: x.name.value.trim(), body: x.body.value,
              }));
            }
            await send('review/apply', {
              id, groups, groupOperations,
              edits: edits.filter(x => groups.includes(x.gi) && x.oi < (r.result.groups[x.gi]?.operations?.length || 0)).map(x => ({
                group: x.gi, operation: x.oi, action: x.action.value, target: x.action.value === 'create' ? '' : x.target.value,
                scope: x.scope.value, owner: x.scope.value === 'global' ? '' : x.owner.value.trim(), name: x.name.value, body: x.body.value,
              })),
            });
            if (!dead) { notify('所选方案已应用并发布，修订历史已保留'); await applied(); }
          } catch (e) { notify(e.message, true); }
        }, 'go'));
      }
      if (['ready', 'failed'].includes(r.status)) actBar.append(button('丢弃此方案', async () => { try { await send('review/discard', { id }); await applied(); await show(id); } catch (e) { notify(e.message, true); } }));
      if (actBar.childNodes.length) box.append(actBar);
      report.replaceChildren(box);
      report.scrollIntoView({ block: 'start' });
      await loadHistory(false);
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function runAuto() {
    try {
      notify('正在对新增/变更的记忆来源执行增量自动审阅…');
      const r = await send('review/auto', { apiOnly: apiOnly.checked });
      if (dead) return;
      if (r.skipped) {
        notify('当前没有未审阅的新增记忆来源（未调用大模型）');
      } else {
        notify(`增量自动审阅完成：已自动入库 ${r.autoApplied || 0} 条无争议记忆；${r.pendingManual || 0} 组存在矛盾/争议待人工确认`);
        if (r.autoApplied > 0) await applied();
        if (r.id) await show(r.id);
      }
      await loadHistory(false);
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function runMonthly() {
    try {
      notify('正在执行月度全量记忆体检（排查过度防御、生硬表达、过时内容，结果仅供人工确认）…');
      const r = await send('review/monthly', { apiOnly: apiOnly.checked, force: true });
      if (dead) return;
      if (r.skipped) {
        notify('当前没有可体检的启用记忆或已有整理任务运行中');
      } else {
        notify(`月度记忆体检完成：共发现 ${r.pendingManual || 0} 组修订建议，请手动确认或修改后应用`);
        if (r.id) await show(r.id);
      }
      await loadHistory(false);
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function loadHistory(autoOpenReady = true) {
    try {
      const d = await get('/reviews');
      if (dead) return;
      const kindLbl = k => k === 'monthly' ? '📅 月度记忆体检' : k === 'auto' ? '⚡ 每日增量审阅' : k === 'ai' ? '智能整理' : '手动对齐';
      history.replaceChildren(
        h('div', { class: 'knowledge-card-head' },
          h('h3', { class: 'knowledge-section-title', text: '📋 整理方案历史' }),
          button('刷新方案历史', () => loadHistory(false))),
        d.items.length
          ? h('div', { class: 'capi-btns' }, ...d.items.map(x => button(new Date(x.created).toLocaleString() + ' · ' + kindLbl(x.kind) + ' · ' + statuses[x.status], () => show(x.id), x.status === 'ready' ? 'go' : '')))
          : h('p', { class: 'ghint', text: '暂无整理方案记录。' }));
      if (autoOpenReady && !currentReviewId) {
        const targetId = initialReviewId || d.items.find(x => x.status === 'ready')?.id;
        if (targetId) await show(targetId);
      }
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  root.append(
    h('div', { class: 'knowledge-banner' },
      h('span', { text: '🧠 自动化与人工裁决机制：① 每日随日报「增量审阅」新来源（无争议直接入库，冲突挂起待裁决）；② 每月随月度周期自动运行「月度记忆体检」（指出过度防御、生硬表达与过时内容，100% 由你手动修改或确认后才生效）。' })),
    h('div', { class: 'knowledge-review-grid' },
      h('div', { class: 'knowledge-card' },
        h('h3', { class: 'knowledge-section-title', text: '1. 选择整理方式与指令模板' }),
        h('div', { class: 'knowledge-toolbar' },
          button('核对所选原文', align),
          button('清理重复、矛盾与归属', () => { instructions.value = '检查重复、矛盾和适用范围，给出有证据的去重与归属建议；证据不足时保留待核对。'; }),
          button('拆成逐条记忆', () => { instructions.value = '将所选长文拆成一事一条、独立可管理的记忆。保留限定条件、日期和来源；新增条目与停用对应已发布原文放在同一分组。'; }),
          button('月度体检模板（过度防御/表达/过时）', () => { instructions.value = '排查过度防御性限制（defensive）、生硬或奇怪的表达（expression）、已过时需更新的旧任务/旧版本（outdated），给出精炼修改建议供人工确认。'; })),
        instructions),
      h('div', { class: 'knowledge-card' },
        h('h3', { class: 'knowledge-section-title', text: '2. 调用 AI 模型生成审阅方案' }),
        h('div', { class: 'knowledge-toolbar' },
          h('label', { class: 'knowledge-check-lbl' }, apiOnly, '仅使用 API'),
          model,
          run,
          button('增量自动审阅', runAuto),
          button('📅 月度记忆体检', runMonthly),
          button('模型与 API 设置', async () => (await import('./control.js')).open('ai'))),
        route)
    ),
    report,
    history);
  run.disabled = true; loadModels(); loadHistory(true);
  return { root, show, destroy() { dead = true; clearTimeout(timer); } };
}
