// 读图 for one paper (server/literature/vision.js), in the library's detail and the reader: how much of it has been
// read as images, the run going on, and for a paper too long to read whole -- the pages the AI asks to read (approve
// them all, edit the range to approve a part, or decline) or the pages the user picks.
import { h } from '../util.js';
import { get, post, onLit } from './lit-api.js';
import { renderMd } from './lit-md.js';

// returns { el, destroy }; the box updates itself on the server's vision:<key> events.
// curPage (the reader): the page shown in the PDF -- its transcription can be opened to check against the page
export function visionBox(key, { curPage = null } = {}) {
  const el = h('div', { class: 'lv' });
  let alive = true, t = null;
  const btn = (text, title, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', text, title, onclick });

  async function load() {
    const v = await get('/api/lit/vision?key=' + encodeURIComponent(key));
    if (!alive) return;
    if (!v || !v.pdf) { el.replaceChildren(); el.hidden = true; return; }
    el.hidden = false;
    const msg = h('span', { class: 'lit-st' });
    const start = async (ranges) => {
      const r = await post('/api/lit/vision/start', ranges ? { key, ranges } : { key });
      msg.textContent = r.ok ? '开始读图…' : (r.msg || '没开始');
    };
    const rows = [];
    const job = v.job && v.job.running ? v.job : null;
    if (v.error) rows.push(h('div', { class: 'lit-empty bad', text: '读图用不了：' + v.error }));
    else {
      // what has been read so far
      const head = v.done
        ? `读图：已看原图转写 ${v.done === v.n ? '全部 ' + v.n : `${v.done}/${v.n}`} 页${v.done < v.n ? `（第 ${v.ranges} 页）` : ''}${v.unsure ? `，${v.unsure} 处看不清标了 [?]` : ''}`
        : v.auto ? `读图：这篇 ${v.n} 页，第一次深读时会自动看原图逐页转写（公式、表格更准）` : `读图：这篇 ${v.n} 页，超过整篇读图的上限（${v.max} 页），深读用的是文字层`;
      rows.push(h('div', { class: 'lv-h' }, h('span', { text: head }),
        !job && v.auto && v.done < v.n ? btn('现在就读', '不用等深读，现在就把整篇看原图转写', () => start()) : null));
      if (job) rows.push(h('div', { class: 'lv-run', text: `正在看原图转写… ${job.done}/${job.total || '?'} 页（每 4 页一问，一般每问一两分钟）` }));
      else if (v.job && v.job.error) rows.push(h('div', { class: 'lit-empty bad', text: '上次读图：' + v.job.error }));
      // the AI's request (a long paper): approve all, a part (edit the pages), or decline
      if (v.request && !job) {
        const pages = h('input', { class: 'field lv-p', value: v.request.ranges, title: '可以改：只批准其中一部分页' });
        rows.push(h('div', { class: 'lv-req' },
          h('div', { text: `AI 建议看原图精读第 ${v.request.ranges} 页${v.request.why ? '：' + v.request.why : ''}` }),
          h('div', { class: 'gbtns' }, h('span', { text: '页码' }), pages,
            btn('批准', '按这些页看原图转写（可以先把页码改小）', async () => { const r = await post('/api/lit/vision/approve', { key, ranges: pages.value }); msg.textContent = r.ok ? `开始读 ${r.pages} 页…` : (r.msg || '没开始'); }, 'btn go'),
            btn('不用了', '不读图，继续用文字层', async () => { await post('/api/lit/vision/decline', { key }); load(); }))));
      } else if (!job && !v.auto) {
        // a long paper without a request: the user picks pages
        const pages = h('input', { class: 'field lv-p', placeholder: '如 12-18, 25' });
        rows.push(h('details', { class: 'lv-pick' }, h('summary', { text: '自己挑几页看原图精读' }),
          h('div', { class: 'gbtns' }, pages, btn('读这些页', '', () => start(pages.value.trim()), 'btn go'))));
      }
    }
    if (curPage && v.done) {
      const out = h('div', { class: 'md lv-md', hidden: true });
      rows.push(h('div', { class: 'lv-h' }, btn('看这一页的转写', '左边 PDF 当前这一页转写出来的内容，对着原图核对（[?] 是看不清的地方）', async () => {
        const n = curPage() || 1, r = await get(`/api/lit/vision/page?key=${encodeURIComponent(key)}&page=${n}`);
        out.hidden = false;
        if (r && r.md) renderMd(out, `**第 ${n} 页的转写**\n\n` + r.md, {}); else out.textContent = `第 ${n} 页没有读图（用的是文字层）。`;
      }), btn('收起', '', () => { out.hidden = true; })), out);
    }
    rows.push(msg);
    el.replaceChildren(...rows);
  }
  const off = onLit((w) => { if (w === 'vision:' + key) { clearTimeout(t); t = setTimeout(load, 200); } });
  load();
  return { el, reload: load, destroy() { alive = false; off(); clearTimeout(t); } };
}
