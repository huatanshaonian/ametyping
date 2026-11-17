// 文献 › 文献库: 按 DOI 下载 (server/literature/downloads.js). A box for one or more DOIs; each becomes a job in the
// same queue the agents' MCP uses (one paper at a time through the library access). Under it the jobs still on their
// way and the last few finished ones, an agent's marked as such; a click opens the paper in the library.
import { h } from '../util.js';
import { get, post } from './lit-api.js';

const LABEL = { queued: '排队', working: '处理中', waiting: '等下载', downloading: '下载中', blocked: '等你处理', paused: '暂停', done: '拿到', failed: '没拿到' };
const ACTIVE = new Set(['queued', 'working', 'waiting', 'downloading', 'blocked', 'paused']);

export function downloadBox(ctx) {
  const input = h('input', { class: 'field ldl-in', type: 'text', placeholder: '输入 DOI 下载，可一次粘贴多个（空格或换行分开）', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } } });
  const go = h('button', { class: 'btn go', type: 'button', text: '下载', title: '查到文献信息后放进 Zotero 的「文献下载」，先找开放获取的 PDF，没有就排进图书馆通道', onclick: () => submit() });
  const msg = h('span', { class: 'lit-st ldl-msg' });
  const list = h('div', { class: 'ldl-l' });
  const el = h('div', { class: 'ldl' }, h('div', { class: 'ldl-f' }, h('b', { text: '按 DOI 下载' }), input, go), msg, list);

  async function submit() {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    go.disabled = true;
    const r = await post('/api/lit/download', { text });
    go.disabled = false;
    msg.classList.toggle('bad', !r.ok);
    if (r.ok) {
      const rs = r.results || [], fresh = rs.filter((x) => x.ok && !x.duplicate).length, dup = rs.filter((x) => x.ok && x.duplicate).length, bad = rs.filter((x) => !x.ok);
      msg.textContent = [fresh ? `提交了 ${fresh} 篇` : '', dup ? `${dup} 篇已经在任务里` : '', bad.length ? `${bad.length} 个没收：${bad[0].msg}` : ''].filter(Boolean).join('，');
      input.value = '';
    } else msg.textContent = r.msg || ((r.results || []).find((x) => !x.ok) || {}).msg || '没提交上';
    refresh();
  }

  async function refresh() {
    const r = await get('/api/lit/downloads');
    if (!r) return;
    const items = r.items || [];
    const open = items.filter((x) => ACTIVE.has(x.state)), ended = items.filter((x) => !ACTIVE.has(x.state)).slice(0, 5);
    const row = (x) => h('div', { class: 'ldl-i s-' + x.state + (x.needsUser ? ' need' : '') },
      h('i', { class: 'tag', text: LABEL[x.state] || x.state }),
      x.key ? h('a', { href: '#', text: x.title || x.doi, title: x.doi, onclick: (e) => { e.preventDefault(); ctx.openItem(x.key); } }) : h('span', { class: 'ldl-t', text: x.title || x.doi }),
      h('small', { text: [x.by && x.by !== 'windose' ? '来自 ' + x.by.replace(/^mcp:/, '') : '', x.msg].filter(Boolean).join(' · ') }));
    const lim = r.limits || {};
    list.replaceChildren(...open.map(row), ...(ended.length ? [h('details', { class: 'ldl-done' }, h('summary', { text: `最近完成 ${ended.length} 篇` }), ...ended.map(row))] : []),
      h('div', { class: 'ldl-lim', text: `一次最多 ${lim.maxPerCall || 20} 个 DOI · 图书馆通道一次一篇、间隔约 ${Math.round((lim.gapSec || 90) / 60 * 10) / 10} 分钟 · 今天已下 ${lim.today || 0}/${lim.perDay != null ? lim.perDay : 30}` + (lim.libraryEnabled ? '' : ' · 图书馆通道没开（只能拿开放获取的）') }));
  }
  return { el, refresh };
}
