// AI 模型 (in 控制面板): which model each AI job uses and how hard it thinks (remote/server/ai) -- one default for all,
// any job set on its own (empty = the default). The models are the ones Codex lists for the account, each offering
// only the efforts it has. Below, Codex itself: its version, the newest release (looked up every 5 days; 「现在检查」
// asks now), 「更新 Codex」 (asks for a code), whether it is logged in.
import { h } from '../util.js';
import * as net from '../net.js';

const EFFORT = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
const pad = (n) => String(n).padStart(2, '0');
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function panel() {
  const root = h('div', { class: 'aim' });
  const msg = h('p', { class: 'gnote' });
  const table = h('div', { class: 'aim-table' });
  const codexBox = h('div', { class: 'aim-codex' });
  root.append(msg, h('p', { class: 'ghint', text: '日报、周报、问一问、邮件把关、邮件起草都由群晖上的 Codex 调用模型完成。更强的模型和更高的推理强度更准，但更慢、用量更多。没单独设置的任务跟随「默认」。' }),
    table, h('h4', { class: 'aim-h', text: 'Codex' }), codexBox);
  let view = null, dirty = false;

  // a model + effort pair of selects; follow: '' option text (跟随默认 / Codex 默认)
  function pair(cur, follow, onChange) {
    const model = h('select', { class: 'field' }, h('option', { value: '', text: follow }),
      ...view.models.map((m) => h('option', { value: m.slug, text: m.name, title: m.note })));
    const effort = h('select', { class: 'field' });
    const fillEffort = () => {
      const m = view.models.find((x) => x.slug === model.value);
      const list = m ? m.efforts : [...new Set(view.models.flatMap((x) => x.efforts))];
      const keep = effort.value || cur.effort;
      effort.replaceChildren(h('option', { value: '', text: m && m.defaultEffort ? `默认（${EFFORT[m.defaultEffort] || m.defaultEffort}）` : '默认' }),
        ...list.map((e) => h('option', { value: e, text: `${EFFORT[e] || e}（${e}）` })));
      effort.value = list.includes(keep) ? keep : '';
    };
    model.value = cur.model || '';
    fillEffort();
    model.addEventListener('change', () => { fillEffort(); onChange(); });
    effort.addEventListener('change', onChange);
    return { model, effort, get: () => ({ model: model.value, effort: effort.value }) };
  }

  async function load() {
    try { view = await (await fetch('/api/ai')).json(); } catch { msg.textContent = '读不到设置'; return; }
    const changed = () => { dirty = true; save(); };
    const def = pair(view.default || {}, `跟随配置（${view.fallbackModel}）`, changed);
    const rows = view.tasks.map((t) => ({ t, p: pair(t.set, '跟随默认', changed) }));
    const uses = (u) => `${(view.models.find((m) => m.slug === u.model) || {}).name || u.model} · ${u.effort ? EFFORT[u.effort] || u.effort : '默认强度'}`;
    table.replaceChildren(
      h('div', { class: 'aim-row aim-def' }, h('div', {}, h('b', { text: '默认' }), h('small', { text: '下面没单独设置的任务都用这个' })), def.model, def.effort, h('span')),
      ...rows.map(({ t, p }) => h('div', { class: 'aim-row' }, h('div', {}, h('b', { text: t.name }), h('small', { text: t.note })), p.model, p.effort,
        h('span', { class: 'aim-uses', text: '实际：' + uses(t.uses) }))));
    let saveT = null;
    async function save() {
      clearTimeout(saveT);
      saveT = setTimeout(async () => {
        if (!dirty) return;
        dirty = false;
        const r = await net.post('/api/ai/set', { default: def.get(), tasks: Object.fromEntries(rows.map(({ t, p }) => [t.id, p.get()])) });
        msg.textContent = r.ok ? '已保存，下一次调用就用新的设置' : r.msg || '没能保存';
        if (r.ok && r.tasks) { view = r; rows.forEach((_, i) => { const el = table.children[i + 1].querySelector('.aim-uses'); if (el) el.textContent = '实际：' + uses(r.tasks[i].uses); }); }
      }, 400);
    }
  }

  // Codex: version, newest release, update, login
  async function loadCodex(check) {
    codexBox.replaceChildren(h('p', { class: 'ghint', text: check ? '正在向 GitHub 查最新版本…' : '读取中…' }));
    let c = {}; try { c = await (await fetch('/api/ai/codex' + (check ? '?check=1' : ''))).json(); } catch {}
    const newer = c.latest && c.version && c.latest !== c.version;
    const lu = c.lastUpdate;
    codexBox.replaceChildren(...[
      h('div', { class: 'aim-kv' }, h('b', { text: '当前版本' }), h('span', { text: c.version || '（读不到）' })),
      h('div', { class: 'aim-kv' }, h('b', { text: '最新版本' }), h('span', { class: newer ? 'aim-new' : '',
        text: c.latest ? `${c.latest}${newer ? '（有新版本）' : '（已是最新）'}` : c.latestError ? '没查到：' + c.latestError : '还没查过' }),
        h('small', { text: c.checkedAt ? `  ${when(c.checkedAt)} 查的，每 5 天自动查一次` : '  每 5 天自动查一次' })),
      h('div', { class: 'aim-kv' }, h('b', { text: '登录' }), h('span', { class: c.login && c.login.ok ? '' : 'aim-bad',
        text: c.login ? `${c.login.ok ? '已登录' : '没登录'}${c.login.mode ? '（' + (c.login.mode === 'chatgpt' ? 'ChatGPT 账号' : c.login.mode) + '）' : ''}${c.login.refreshed ? '，' + when(Date.parse(c.login.refreshed)) + ' 刷新过' : ''}` : '' })),
      c.updating ? h('p', { class: 'gnote', text: '正在更新 Codex…（几分钟）' }) : null,
      lu ? h('p', { class: 'ghint' + (lu.ok ? '' : ' bad'), text: `上次更新：${when(lu.at)}，${lu.ok ? `${lu.from} → ${lu.to}` : '失败'}` }) : null,
      lu && !lu.ok && lu.out ? h('pre', { class: 'aim-out', text: lu.out }) : null,
      h('div', { class: 'gbtns' },
        h('button', { class: 'btn', type: 'button', text: '现在检查', onclick: () => loadCodex(true) }),
        h('button', { class: 'btn' + (newer ? ' go' : ''), type: 'button', text: '更新 Codex', disabled: !!c.updating, onclick: async () => {
          if (!confirm('现在更新群晖上的 Codex？\n（正在写的日报会用旧版本写完）')) return;
          const r = await net.post('/api/ai/codex/update', {});
          if (!r.ok) return alert(r.msg || '没能开始更新');
          loadCodex(false); poll();
        } }))].filter(Boolean));                                  // (replaceChildren would print null)
  }
  let pollT = null;
  function poll() { clearTimeout(pollT); pollT = setTimeout(async () => { let c = {}; try { c = await (await fetch('/api/ai/codex')).json(); } catch {} if (c.updating) poll(); else loadCodex(false); }, 5000); }

  load(); loadCodex(false);
  return { root, destroy() { clearTimeout(pollT); } };
}
