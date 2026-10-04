// AI 模型 (in 控制面板): which model each AI job uses and how hard it thinks (remote/server/ai) -- one default for all,
// any job set on its own (empty = the default), and a backup model (后备模型) that finishes the job when the chosen one
// fails or is out of usage. The models are the ones Codex and Claude Code list for their accounts, each offering only
// the efforts it has. A model that failed lately is shown (it rests 15 minutes). Below, the two tools (ai-cli.js).
import { h } from '../util.js';
import * as net from '../net.js';
import { cliBox, when } from './ai-cli.js';

const EFFORT = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
const GROUP = { claude: 'Claude（Claude Code）', codex: 'OpenAI（Codex）' };

export function panel() {
  const root = h('div', { class: 'aim' });
  const msg = h('p', { class: 'gnote' });
  const down = h('div', { class: 'aim-down' });
  const table = h('div', { class: 'aim-table' });
  const boxes = [cliBox('claude'), cliBox('codex')];
  root.append(msg, h('p', { class: 'ghint', text: '日报、周报、问一问、邮件、文献都由群晖上的 Claude Code 或 Codex 调用模型完成（选 Claude 模型就用 Claude Code）。更强的模型和更高的推理强度更准，但更慢、用量更多。没单独设置的任务跟随「默认」；首选模型出错或用量用完时，自动改用「后备模型」把任务做完。' }),
    down, table, h('h4', { class: 'aim-h', text: 'Claude Code' }), boxes[0].root, h('h4', { class: 'aim-h', text: 'Codex' }), boxes[1].root);
  let view = null, dirty = false;
  const nameOf = (slug) => (view.models.find((m) => m.slug === slug) || {}).name || slug;

  // a model + effort pair of selects, the models grouped by tool; follow: the '' option's text (跟随默认 / 不用后备)
  function pair(cur, follow, onChange) {
    const groups = Object.keys(GROUP).map((p) => [p, view.models.filter((m) => m.provider === p)]).filter(([, ms]) => ms.length);
    const model = h('select', { class: 'field' }, h('option', { value: '', text: follow }),
      ...groups.map(([p, ms]) => h('optgroup', { label: GROUP[p] }, ...ms.map((m) => h('option', { value: m.slug, text: m.name, title: m.note })))));
    const effort = h('select', { class: 'field' });
    const fillEffort = () => {
      const m = view.models.find((x) => x.slug === model.value);
      const list = m ? m.efforts : [...new Set(view.models.flatMap((x) => x.efforts))];
      const keep = effort.value || cur.effort;
      effort.replaceChildren(h('option', { value: '', text: m && m.defaultEffort ? `默认（${EFFORT[m.defaultEffort] || m.defaultEffort}）` : m && !m.efforts.length ? '（不分强度）' : '默认' }),
        ...list.map((e) => h('option', { value: e, text: `${EFFORT[e] || e}（${e}）` })));
      effort.value = list.includes(keep) ? keep : '';
      effort.disabled = !!(m && !m.efforts.length);
    };
    model.value = cur.model || '';
    fillEffort();
    model.addEventListener('change', () => { fillEffort(); onChange(); });
    effort.addEventListener('change', onChange);
    return { model, effort, get: () => ({ model: model.value, effort: effort.value }) };
  }

  const one = (u) => `${nameOf(u.model)} · ${u.effort ? EFFORT[u.effort] || u.effort : '默认强度'}`;
  const uses = (u) => '实际：' + one(u) + (u.backup ? `；出错时改用 ${nameOf(u.backup.model)}` : '');
  // the models that failed lately: the next calls go to the other one first for 15 minutes
  function showDown() {
    const list = (view.down || []).filter((d) => d.until > Date.now());
    down.replaceChildren(...list.map((d) => h('p', { class: 'ghint bad', text: `${nameOf(d.model)} 在 ${when(d.at)} 出错（${d.error.slice(0, 120)}），${when(d.until).replace(/.* 日 /, '')} 前先用另一个模型` })));
  }

  async function load() {
    try { view = await (await fetch('/api/ai')).json(); } catch { msg.textContent = '读不到设置'; return; }
    const changed = () => { dirty = true; save(); };
    const def = pair(view.default || {}, `跟随配置（${nameOf(view.fallbackModel)}）`, changed);
    const bak = pair(view.backup || {}, '不用后备', changed);
    const rows = view.tasks.map((t) => ({ t, p: pair(t.set, '跟随默认', changed), out: h('span', { class: 'aim-uses', text: uses(t.uses) }) }));
    table.replaceChildren(
      h('div', { class: 'aim-row aim-def' }, h('div', {}, h('b', { text: '默认' }), h('small', { text: '下面没单独设置的任务都用这个' })), def.model, def.effort, h('span')),
      h('div', { class: 'aim-row aim-def aim-bak' }, h('div', {}, h('b', { text: '后备模型' }), h('small', { text: '首选模型出错或用量用完时，自动改用它把任务做完' })), bak.model, bak.effort, h('span')),
      ...rows.map(({ t, p, out }) => h('div', { class: 'aim-row' }, h('div', {}, h('b', { text: t.name }), h('small', { text: t.note })), p.model, p.effort, out)));
    showDown();
    let saveT = null;
    async function save() {
      clearTimeout(saveT);
      saveT = setTimeout(async () => {
        if (!dirty) return;
        dirty = false;
        const r = await net.post('/api/ai/set', { default: def.get(), backup: bak.get(), tasks: Object.fromEntries(rows.map(({ t, p }) => [t.id, p.get()])) });
        msg.textContent = r.ok ? '已保存，下一次调用就用新的设置' : r.msg || '没能保存';
        if (r.ok && r.tasks) { view = r; rows.forEach((row, i) => { row.out.textContent = uses(r.tasks[i].uses); }); showDown(); }
      }, 400);
    }
  }

  load();
  return { root, destroy() { for (const b of boxes) b.destroy(); } };
}
