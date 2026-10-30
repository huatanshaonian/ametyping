import { h } from '../util.js';
import * as net from '../net.js';
const scopes = { global: '共享全局', machine: '机器', project: '项目' };
const categories = { duplicate: '去重', conflict: '冲突核对', scope: '归属调整', split: '逐条拆分', rewrite: '整理表述' };
const statuses = { running: '分析中', ready: '待审阅', failed: '失败', applied: '已应用', discarded: '已丢弃' };
const button = (text, onclick) => h('button', { class: 'btn', type: 'button', text, onclick });
export function createReviewPanel({ refs, get, notify, applied }) {
  let dead = false, timer = null, ai = null;
  const root = h('div', { class: 'knowledge-review' }), report = h('div'), history = h('div');
  const instructions = h('textarea', { class: 'field knowledge-instruction', placeholder: '例如：把长文拆成一事一条；找出不同电脑上的重复与矛盾；保留日期和证据。' });
  const apiOnly = h('input', { type: 'checkbox', checked: true });
  const model = h('select', { class: 'field', title: '记忆智能整理模型' });
  const route = h('p', { class: 'ghint' });
  const run = button('智能整理所选', start);
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
    const selected=list.find(m=>m.slug===model.value);
    run.disabled = !list.length || (apiOnly.checked && !ai.api?.has && !selected?.api);
    route.textContent = apiOnly.checked
      ? (selected?.api ? '直接调用 NAS 上的 '+selected.api+' API 入口，沿用该入口的模型、密钥和网络；失败时不会切换到 CLI。' : ai.api?.has ? '通过已配置的 Claude API 分析，失败时不会切换到 CLI。' : '尚未配置 Claude API 密钥，请打开“模型与 API 设置”；也可配置 NAS 的 API 别名。')
      : '使用“AI 模型”里配置的通道和后备模型，可能通过 API、Claude Code 或 Codex 调用。';
  }
  apiOnly.addEventListener('change', fillModels);
  model.addEventListener('change',fillModels);
  async function loadModels() {
    try { const r = await fetch('/api/ai', { cache: 'no-store' }); const d = await r.json(); if (!dead && d.models) { ai = d; fillModels(); } }
    catch { if (!dead) route.textContent = '无法读取 AI 设置，请先配置 AI 模型。'; }
  }
  async function start() {
    try {
      if (!refs().length) throw Error('请先在记忆列表或来源列表勾选内容');
      run.disabled = true;
      const prior=ai?.tasks.find(t=>t.id==='memory')?.set;
      const setting = await net.post('/api/ai/set', { tasks: { memory: { model: model.value, effort:prior?.model===model.value?prior.effort:'' } } });
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
      report.replaceChildren(h('h3', { text: '逐条对照' }), h('p', { class: 'ghint', text: '高亮表示另一条中没有的原文行；相似度只用于找线索，不代表事实相同或矛盾。' }));
      for (const p of d.pairs) {
        const a = d.items.find(x => x.label === p.left), b = d.items.find(x => x.label === p.right);
        report.append(h('details', {}, h('summary', { text: a.name + ' ↔ ' + b.name + ' · ' + p.score + '% · ' + p.note }),
          h('div', { class: 'knowledge-columns' }, h('div', {}, h('b', { text: a.source }), difference(a.body, b.body)), h('div', {}, h('b', { text: b.source }), difference(b.body, a.body)))));
      }
      if (!d.pairs.length) report.append(h('p', { text: '没有发现正文重复或明显文字相似的条目，仍可逐条核对或调用智能整理。' }));
      report.append(h('div', { class: 'knowledge-columns' }, ...d.items.map(x => h('details', {},
        h('summary', { text: x.label + ' · ' + x.name + ' · ' + scopes[x.scope] + (x.owner ? ' / ' + x.owner : '') }), h('small', { text: x.source }), h('pre', { text: x.body })))));
      const published = d.items.filter(x => x.kind === 'memory');
      if (published.length) {
        const label=x=>x.name+' · '+scopes[x.scope]+(x.owner?' / '+x.owner:'');
        const target = h('select', { class: 'field', title: '更新哪条已发布记忆' }, ...published.map(x => h('option', { value: x.label, text: label(x) })));
        const source = h('select', { class: 'field', title: '参考哪条来源' }, ...d.items.map(x => h('option', { value: x.label, text: label(x) })));
        const body = h('textarea', { class: 'field knowledge-body' });
        body.value=published[0].body;
        target.addEventListener('change', () => { body.value = d.items.find(x => x.label === target.value).body; });
        report.append(h('h3', { text: '手动对齐' }), h('p', { class: 'ghint', text: '选择目标，编辑合并后的正文，再生成待审阅方案。保存方案不会立即发布。' }),
          h('div', { class: 'knowledge-toolbar' }, target, source, button('填入来源正文', () => { body.value = d.items.find(x => x.label === source.value).body; })), body,
          button('生成手动对齐方案', async () => {
            try {
              const x = d.items.find(x => x.label === target.value);
              const r = await send('review/manual', { refs: d.items.map(x => x.ref), groups: [{ title: '对齐 ' + x.name, category: 'rewrite', reason: '用户核对后编辑的合并正文',
                operations: [{ action: 'update', target: x.label, scope: x.scope, owner: x.owner, name: x.name, body: body.value }] }] });
              await show(r.id);
            } catch (e) { notify(e.message, true); }
          }));
      }
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function show(id) {
    clearTimeout(timer);
    try {
      const r = (await get('/review?id=' + encodeURIComponent(id))).item;
      if (dead || !r) return;
      report.replaceChildren(h('h3', { text: statuses[r.status] || r.status }));
      if (r.status === 'running') {
        report.append(h('p', { text: '模型正在分析，离开页面不会丢失任务，稍后可在方案历史中查看。' }));
        timer = setTimeout(() => show(id), 1500);
        return;
      }
      if (r.error) report.append(h('p', { class: 'ghint bad', text: r.error }));
      if(r.status==='ready')notify('方案已就绪，请审阅并勾选要应用的分组');
      else if(r.status==='failed')notify(r.error||'分析失败，请检查模型和 API 设置',true);
      if (r.result.summary) report.append(h('p', { text: r.result.summary }));
      const chosen = [], edits = [];
      for (const [gi, group] of (r.result.groups || []).entries()) {
        const pick = h('input', { type: 'checkbox', disabled: r.status !== 'ready' });
        chosen.push({ pick, gi });
        const card = h('section', { class: 'knowledge-proposal' }, h('label', {}, pick, categories[group.category] + ' · ' + group.title + (r.status==='applied'?(r.appliedGroups.includes(gi)?'（已应用）':'（未选择）'):'')), h('p', { text: group.reason }));
        for (const [oi, op] of group.operations.entries()) {
          const before = r.snapshot.items.find(x => x.label === op.target);
          const scope = h('select', { class: 'field' }, ...Object.entries(scopes).map(([value, text]) => h('option', { value, text })));
          scope.value = op.scope;
          const owner = h('input', { class: 'field', value: op.owner, placeholder: '归属（共享全局留空）' });
          const name = h('input', { class: 'field', value: op.name, placeholder: '记忆名称' });
          const body = h('textarea', { class: 'field knowledge-body' });
          body.value=op.body;
          const locked = r.status !== 'ready' || op.action === 'disable';
          for (const x of [scope, owner, name, body]) x.disabled = locked;
          edits.push({ gi, oi, scope, owner, name, body });
          card.append(h('b', { text: ({ create: '新增', update: '修改', disable: '停用' })[op.action] + '：' + op.name }),
            ...(before ? [h('details', {}, h('summary', { text: '原文 · v' + before.ref.revision + ' · ' + before.source }), h('pre', { text: before.body }))] : []),
            h('div', { class: 'knowledge-toolbar' }, scope, owner, name), body);
        }
        report.append(card);
      }
      if (r.status === 'ready') report.append(h('p', { class: 'ghint', text: '勾选完整分组后应用。拆分组中的新增和停用会一起提交；原记忆或来源更新后，需重新分析。' }), button('应用勾选分组', async () => {
        try {
          const groups = chosen.filter(x => x.pick.checked).map(x => x.gi);
          await send('review/apply', { id, groups, edits: edits.filter(x => groups.includes(x.gi)).map(x => ({ group: x.gi, operation: x.oi, scope: x.scope.value, owner: x.owner.value, name: x.name.value, body: x.body.value })) });
          if (!dead) { notify('所选方案已应用并发布，修订历史已保留'); await applied(); }
        } catch (e) { notify(e.message, true); }
      }));
      if (['ready', 'failed'].includes(r.status)) report.append(button('丢弃此方案', async () => { try { await send('review/discard', { id }); await show(id); } catch (e) { notify(e.message, true); } }));
      report.scrollIntoView({block:'start'});
      await loadHistory();
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  async function loadHistory() {
    try {
      const d = await get('/reviews');
      if (dead) return;
      history.replaceChildren(h('h3', { text: '方案历史' }), ...d.items.map(x => button(new Date(x.created).toLocaleString() + ' · ' + (x.kind === 'ai' ? '智能整理' : '手动对齐') + ' · ' + statuses[x.status], () => show(x.id))));
    } catch (e) { if (!dead) notify(e.message, true); }
  }
  root.append(h('p', { class: 'ghint', text: '从“统一记忆”和“记忆来源”勾选条目。智能整理会把勾选内容发送给所选模型，返回可审阅方案；原文和来源保留。' }),
    h('div', { class: 'knowledge-toolbar' }, button('核对所选原文', align), button('清理重复、矛盾与归属', () => { instructions.value = '检查重复、矛盾和适用范围，给出有证据的去重与归属建议；证据不足时保留待核对。'; }),
      button('拆成逐条记忆', () => { instructions.value = '将所选长文拆成一事一条、独立可管理的记忆。保留限定条件、日期和来源；新增条目与停用对应已发布原文放在同一分组。'; })),
    instructions, h('div', { class: 'knowledge-toolbar' }, h('label', {}, apiOnly, '仅使用 API'), model, run,
      button('模型与 API 设置', async () => (await import('./control.js')).open('ai'))), route,
    button('刷新方案历史', loadHistory), report, history);
  run.disabled = true; loadModels(); loadHistory();
  return { root, show, destroy() { dead = true; clearTimeout(timer); } };
}
