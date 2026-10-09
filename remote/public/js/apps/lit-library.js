// 文献 › 文献库: the Zotero library (as the NAS's copy has it) by collection, searchable; a paper on the right with its
// card (速读卡 / 深读卡: made on request, edited here, 已核对 when the user has checked it against the paper), the
// actions it suggests (one click into 重要计划), the user's annotations, and the way into 深读 and the PDF.
import { h } from '../util.js';
import { openUrl } from './viewer.js';
import { get, post, authors, STATUS } from './lit-api.js';
import { renderMd } from './lit-md.js';
import { visionBox } from './lit-vision.js';
import * as backnav from '../backnav.js';

export function mount(el, ctx) {
  const colSel = h('select', { class: 'field lb-col', title: '分类' });
  const q = h('input', { class: 'field lb-q', type: 'search', placeholder: '搜标题、作者、摘要、citekey' });
  const filt = h('select', { class: 'field', title: '筛选' }, h('option', { value: '', text: '全部' }), h('option', { value: 'star', text: '★ 星标' }),
    h('option', { value: 'card', text: '有卡片' }), h('option', { value: 'nocard', text: '没卡片' }), h('option', { value: 'notes', text: '有批注' }), h('option', { value: 'nopdf', text: '没 PDF' }));
  const count = h('span', { class: 'lit-st' });
  const back = h('button', { class: 'btn lb-back', type: 'button', text: '‹ 列表', onclick: () => el.classList.remove('viewing') });
  backnav.pane(el, 'viewing', () => back.click());                              // (a phone's back gesture: js/backnav.js)
  const listEl = h('div', { class: 'lb-list' });
  const view = h('div', { class: 'lb-view' }, h('p', { class: 'lit-empty', text: '点左边的一篇看详情。' }));
  el.classList.add('lb');
  el.append(h('div', { class: 'lit-sub' }, back, colSel, q, filt, count), h('div', { class: 'lb-main' }, listEl, view));
  let items = [], cur = null, cols = [], qT = null, vbox = null;

  async function loadCols() {
    const r = await get('/api/lit/collections'); cols = (r && r.items) || [];
    const kids = (p) => cols.filter((c) => (c.parent || '') === p).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const opts = [h('option', { value: '', text: '全部文献' })];
    const walk = (p, d) => { for (const c of kids(p)) { opts.push(h('option', { value: c.key, text: '　'.repeat(d) + c.name })); walk(c.key, d + 1); } };
    walk('', 0);
    const keep = colSel.value; colSel.replaceChildren(...opts); colSel.value = keep;
  }
  async function loadList() {
    const r = await get(`/api/lit/library?col=${encodeURIComponent(colSel.value)}&q=${encodeURIComponent(q.value.trim())}`);
    items = (r && r.items) || [];
    const f = filt.value;
    const shown = items.filter((x) => !f || (f === 'star' ? x.card && x.card.starred : f === 'card' ? !!x.card && x.card.status !== 'none' : f === 'nocard' ? !x.card || x.card.status === 'none' : f === 'notes' ? x.notes > 0 : !x.pdf));
    count.textContent = `${shown.length} 篇`;
    listEl.replaceChildren(...shown.map((x) => h('div', { class: 'lb-i' + (cur === x.key ? ' sel' : ''), dataset: { key: x.key } },
      h('div', { class: 'lb-t' }, x.card && x.card.starred ? h('i', { class: 'star', text: '★' }) : null, h('span', { text: x.title || '（无题）' })),
      h('div', { class: 'lb-m' }, h('span', { text: [authors(x.creators), x.year].filter(Boolean).join(' · ') }),
        x.pdf ? h('i', { class: 'tag', text: 'PDF' }) : null, x.notes ? h('i', { class: 'tag', text: `批注 ${x.notes}` }) : null,
        x.card && STATUS[x.card.status] ? h('i', { class: 'tag c', text: STATUS[x.card.status] }) : null))));
    if (!shown.length) listEl.append(h('p', { class: 'lit-empty', text: '没有符合的文献。' }));
  }

  async function show(key, quiet) {
    const d = await get('/api/lit/item?key=' + encodeURIComponent(key));
    if (!d) return;
    cur = key;
    for (const e of listEl.querySelectorAll('.lb-i')) e.classList.toggle('sel', e.dataset.key === key);
    const job = d.job && d.job.running ? d.job : null;
    const cardBox = h('div', { class: 'md lb-card' });
    const jobLine = h('div', { class: 'lb-job' + (d.job && d.job.error ? ' bad' : '') },
      job ? `正在生成${job.kind === 'deep' ? '深读' : '速读'}卡…（一般一两分钟）` : d.job && d.job.error ? '上次生成失败：' + d.job.error : d.job && d.job.result && d.job.result.proposed ? '新卡片放进了「知识库」里等你确认（你改过这张卡片，没直接覆盖）。' : '');
    const btn = (text, title, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', text, title, onclick });
    const meta = d.card ? d.card.meta : {};
    const acts = h('div', { class: 'gbtns lb-acts' },
      btn('深读', d.pdf ? '左边 PDF、右边卡片和对话' : '没有 PDF 时只能看卡片和摘要', () => ctx.openReader(key), 'btn go'),
      d.pdf ? btn('PDF', '在 Windose 里看 PDF', () => openUrl({ id: 'lit-pdf:' + key, title: d.title, name: d.citekey + '.pdf', where: d.citekey, url: '/api/lit/pdf?key=' + key })) : null,
      btn(d.card && d.card.meta.status === 'quick' ? '重做速读卡' : '速读卡', '按摘要和开头几页', async () => { await post('/api/lit/card', { key, kind: 'quick' }); show(key, true); }),
      btn(d.card && /deep|reviewed/.test(d.card.meta.status) ? '重做深读卡' : '深读卡', '按全文（需要 PDF）', async () => { await post('/api/lit/card', { key, kind: 'deep' }); show(key, true); }),
      d.card ? btn(meta.starred ? '★ 已星标' : '☆ 星标', '星标 = 进深读清单', async () => { await post('/api/lit/card/meta', { key, starred: !meta.starred }); show(key, true); loadList(); }) : null,
      d.card && d.card.meta.status !== 'none' ? btn(meta.verified ? '✓ 已核对' : '核对过了', '你对照原文检查过这张卡片', async () => { await post('/api/lit/card/meta', { key, verified: !meta.verified }); show(key, true); }) : null,
      d.card ? btn('编辑', '直接改卡片的 Markdown（Obsidian 里改也行）', () => edit(d)) : null,
      !d.pdf && d.pdfVia ? btn('走图书馆通道下载', '用网页桌面里登录着图书馆的浏览器下载这篇的 PDF（排队，一次一篇）', async (e) => { const r = await post('/api/lit/pdfq/add', { key }); if (r.ok) show(key, true); else e.target.textContent = r.msg || '没排上'; }) : null);
    if (vbox && (vbox.key !== key || !quiet)) { vbox.destroy(); vbox = null; }
    if (!vbox) { vbox = visionBox(key); vbox.key = key; }
    view.replaceChildren(...[h('div', { class: 'lb-head' },
      h('h3', { text: d.title }),
      h('div', { class: 'lf-m', text: [d.creators.join('; '), d.venue, d.year, d.number].filter(Boolean).join(' · ') }),
      h('div', { class: 'lf-m' }, h('code', { text: d.citekey }), d.doi ? h('a', { href: 'https://doi.org/' + d.doi, target: '_blank', rel: 'noopener noreferrer', text: ' doi:' + d.doi }) : null,
        d.collectionNames.length ? ' · ' + d.collectionNames.join('、') : '', d.pdf ? ' · 有 PDF' : ' · 没有 PDF'),
      acts, jobLine),
    vbox.el,
    !d.pdf && d.pdfNote ? h('div', { class: 'lb-tip', text: d.pdfNote }) : null,
    d.card && d.card.meta.getpdf ? h('div', { class: 'lb-tip', text: '建议找全文：' + d.card.meta.getpdf }) : null,
    d.actions.length ? h('div', { class: 'lb-sec' }, h('h4', { text: '可以采取的行动' }), ...d.actions.map((a) => h('div', { class: 'lb-act' + (a.done ? ' done' : '') },
      h('span', { text: (a.done ? '☑ ' : '☐ ') + a.text }),
      h('button', { class: 'btn', type: 'button', text: '加入重要计划', onclick: async (e) => { const r = await post('/api/lit/action/todo', { key, text: a.text }); e.target.textContent = r.ok ? '已加入' : (r.msg || '没加上'); e.target.disabled = r.ok; } })))) : null,
    d.card ? cardBox : h('p', { class: 'lit-empty', text: '还没有卡片：点「速读卡」先看个大概，或「深读」边读边写。' }),
    d.annotations.length ? h('details', { class: 'lb-sec' }, h('summary', { text: `我的批注（${d.annotations.length}）` }),
      h('ul', {}, ...d.annotations.map((a) => h('li', {}, a.type === 'ink' ? h('i', { text: '（手写）' }) : h('span', { text: a.text ? `“${a.text}”` : '' }), a.comment ? h('b', { text: ' ' + a.comment }) : null, a.page ? h('small', { text: ` p.${a.page}` }) : null)))) : null,
    d.abstract ? h('details', { class: 'lb-sec', open: !d.card }, h('summary', { text: '摘要' }), h('p', { text: d.abstract })) : null].filter(Boolean));
    if (d.card) renderMd(cardBox, d.card.text, { onLink: (k) => ctx.openCitekey(k), onPage: (n) => ctx.openReader(key, n) });
    if (!quiet) view.scrollTop = 0;
    el.classList.add('viewing');
  }

  // the card's Markdown as it is on disk; saved with the version it was opened from (a change elsewhere is not overwritten)
  function edit(d) {
    const ta = h('textarea', { class: 'field lb-edit', spellcheck: 'false' }); ta.value = d.card.text;
    const msg = h('span', { class: 'lit-st' });
    view.replaceChildren(h('div', { class: 'lb-head' }, h('h3', { text: '编辑卡片：' + d.citekey }),
      h('div', { class: 'gbtns' }, h('button', { class: 'btn go', type: 'button', text: '保存', onclick: async () => {
        const r = await post('/api/lit/kb/save', { path: d.card.path, text: ta.value, base: d.card.hash });
        if (r.ok) show(d.key); else msg.textContent = r.msg || '没保存上';
      } }), h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => show(d.key) }), msg)), ta);
  }

  async function select({ key, citekey }) {
    if (citekey && !key) {
      const r = await get('/api/lit/library?q=' + encodeURIComponent(citekey));
      const hit = ((r && r.items) || []).find((x) => x.citekey === citekey);
      if (!hit) return;
      key = hit.key;
    }
    if (key) show(key);
  }
  listEl.addEventListener('click', (e) => { const it = e.target.closest('.lb-i'); if (it) show(it.dataset.key); });
  colSel.addEventListener('change', loadList); filt.addEventListener('change', loadList);
  q.addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(loadList, 250); });
  let first = true;
  async function refresh() { if (first) { first = false; await loadCols(); } await loadList(); }
  return { refresh, select, onLit: (w) => { if (w === 'library') { loadCols(); loadList(); } if (cur && (w === 'card:' + cur || w === 'kb' || w === 'pdfq')) show(cur, true); } };
}
