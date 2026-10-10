// 文献 › 文献库: the queue of the library access (server/literature/pdfqueue.js) -- the PDFs no open-access copy was
// found for, fetched through the browser signed in to the user's institution. Shown only when there is something to
// say: what a site waits for from the user (a check that asks for a person, a sign-in) with 继续 once they did it,
// how many wait, the ones it could not get (重试). 补齐 puts every paper of 每日文献 and 调研工作 without a PDF in.
import { h } from '../util.js';
import { get, post } from './lit-api.js';

const NEED = { verify: '要你点一下人机验证', signin: '要你登录一次' };
const hm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function pdfqBox(ctx) {
  const el = h('div', { class: 'lpq', hidden: true });
  let open = false;

  async function refresh() {
    const s = await get('/api/lit/pdfq');
    if (!s || !s.enabled) { el.hidden = true; return; }
    const act = (text, title, fn) => h('button', { class: 'btn', type: 'button', text, title, onclick: async (e) => { e.target.disabled = true; await fn(); refresh(); } });
    const line = s.running ? '正在下载一篇…' : s.browser ? '暂停：' + s.browser : s.limit ? `今天已经下了 ${s.today} 篇（每天最多 ${s.perDay}），明天继续` : s.waiting ? (s.nextAt > Date.now() ? `下一篇 ${hm(s.nextAt)} 开始` : '马上开始') : '';
    const fill = h('button', { class: 'btn', type: 'button', text: '补齐缺的 PDF', title: '把「每日文献」和「调研工作」里没有 PDF 的文献都排进来，一篇一篇慢慢下', onclick: async (e) => {
      e.target.disabled = true; const r = await post('/api/lit/pdfq/fill', {}); e.target.textContent = r.ok ? (r.n ? `排进了 ${r.n} 篇` : '没有要补的') : (r.msg || '没排上'); refresh(); } });
    const rows = s.items || [];
    el.hidden = false;
    el.replaceChildren(
      h('h3', {}, `图书馆通道`, h('small', { class: 'lpq-n', text: [s.waiting ? `等下载 ${s.waiting}` : '', s.failed ? `没拿到 ${s.failed}` : '', s.done ? `拿到 ${s.done}` : ''].filter(Boolean).join(' · ') || '没有在排队的' })),
      ...(s.blocks || []).map((b) => h('div', { class: 'lpq-b' },
        h('div', {}, h('b', { text: `${b.name}：${NEED[b.need] || '等你处理'}` }), h('span', { text: ` ${b.msg}${b.waiting ? `（${b.waiting} 篇在等）` : ''}` })),
        act('我弄好了，继续', '在 Zotero 网页桌面的浏览器里处理完之后点这里', () => post('/api/lit/pdfq/continue', { site: b.site })))),
      h('div', { class: 'lpq-s' }, h('span', { text: line }), fill),
      rows.length ? h('details', { class: 'lpq-l', open, ontoggle: (e) => { open = e.target.open; } },
        h('summary', { text: '明细' }),
        ...rows.map((x) => h('div', { class: 'lpq-i s-' + x.state },
          h('i', { class: 'tag', text: { waiting: '等', running: '下载中', failed: '没拿到', done: '拿到' }[x.state] || x.state }),
          h('a', { href: '#', text: x.title || x.doi, title: x.doi, onclick: (e) => { e.preventDefault(); ctx.openItem(x.key); } }),
          h('small', { text: [x.site, x.why].filter(Boolean).join(' · ') }),
          x.state === 'failed' ? act('重试', '再排一次', () => post('/api/lit/pdfq/retry', { key: x.key })) : null,
          x.state === 'waiting' || x.state === 'failed' ? act('不下了', '从队列里拿掉', () => post('/api/lit/pdfq/drop', { key: x.key })) : null))) : null);
  }
  return { el, refresh };
}
