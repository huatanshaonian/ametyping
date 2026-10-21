// 批注 on the 深读 PDF (server/literature/annots.js -- kept in Zotero, so Zotero's own show here as well):
//   drawn on the pages: highlights, underlines, notes, Zotero's text boxes and drawings
//   text selected -> a bar: highlight it in one of Zotero's colours, underline it, or highlight it with a comment
//   a click on one -> its comment (to change), its colour, highlight <-> underline, delete
//   便签 (in the PDF's bar) -> a click on the page puts a note there
//   attachAnnots(pdf (pdfview.js), key) -> { reload(), destroy() }
import { h } from '../util.js';

export const COLORS = [['#ffd400', '黄'], ['#ff6666', '红'], ['#5fb236', '绿'], ['#2ea8e5', '蓝'], ['#a28ae5', '紫']];
const KIND = { highlight: '高亮', underline: '下划线', note: '便签', text: '文字', ink: '手绘', image: '框选' };
const NO_WRITE = '要先在「控制面板 › 文献」里授权写入 Zotero，才能加批注';

async function call(path, body) {
  try {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return await r.json();
  } catch { return { ok: false, msg: '连不上服务器' }; }
}

// rects of the text on one line run together (Zotero keeps one per line); [x1, y1, x2, y2] in PDF points
export function mergeRects(rects) {
  const rs = rects.map((r) => [...r]).sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const h1 = r[3] - r[1];
    const m = out.find((o) => {
      const ov = Math.min(o[3], r[3]) - Math.max(o[1], r[1]), hh = Math.min(o[3] - o[1], h1);
      return ov > 0.5 * hh && r[0] <= o[2] + 0.8 * hh && r[2] >= o[0] - 0.8 * hh;
    });
    if (m) { m[0] = Math.min(m[0], r[0]); m[1] = Math.min(m[1], r[1]); m[2] = Math.max(m[2], r[2]); m[3] = Math.max(m[3], r[3]); } else out.push(r);
  }
  return out.map((r) => r.map((x) => Math.round(x * 1000) / 1000));
}

export function attachAnnots(pdf, key) {
  const wrap = pdf.pagesEl.parentElement;
  let items = [], canWrite = false, color = '#ffd400', destroyed = false, placing = false, lastLoad = 0;
  let open = null, pop = null;                             // the annotation whose box is open, and the box
  const msgEl = h('span', { class: 'pa-msg' }), topMsg = h('span', { class: 'pa-msg' });   // (in the bar or box; in the PDF's bar)
  const say = (t) => { for (const m of [msgEl, topMsg]) { m.textContent = t || ''; if (t) setTimeout(() => { if (m.textContent === t) m.textContent = ''; }, 5000); } };

  // ---- drawing ----
  const box = (vp, r) => { const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]), [x2, y2] = vp.convertToViewportPoint(r[2], r[3]); return { l: Math.min(x1, x2), t: Math.min(y1, y2), w: Math.abs(x2 - x1), hh: Math.abs(y2 - y1) }; };
  const px = (b) => `left:${b.l}px;top:${b.t}px;width:${b.w}px;height:${b.hh}px`;
  function paint(no) {
    const pg = pdf.page(no); if (!pg) return;
    const { slot, vp } = pg;
    let layer = slot.querySelector(':scope > .pdf-annots');
    if (!layer) { layer = h('div', { class: 'pdf-annots' }); slot.insertBefore(layer, slot.querySelector(':scope > .textLayer')); }
    const kids = [];
    for (const a of items) {
      if (a.pageIndex !== no - 1) continue;
      const on = open && open.id === a.id ? ' on' : '';
      const rects = a.rects || [];
      if (a.type === 'highlight') for (const r of rects) kids.push(h('div', { class: 'pa-hl' + on, style: `${px(box(vp, r))};background:${a.color}` }));
      else if (a.type === 'underline') for (const r of rects) { const b = box(vp, r); kids.push(h('div', { class: 'pa-ul' + on, style: `${px(b)};border-bottom-color:${a.color}` })); }
      else if (a.type === 'note' && rects[0]) kids.push(h('div', { class: 'pa-note' + on, style: `${px(box(vp, rects[0]))};background:${a.color}`, title: a.comment || '便签', dataset: { id: a.id } }));
      else if (a.type === 'text' && rects[0]) kids.push(h('div', { class: 'pa-text' + on, style: `${px(box(vp, rects[0]))};color:${a.color};font-size:${Math.max(8, 12 * vp.scale)}px`, text: a.comment, dataset: { id: a.id } }));
      else if (a.type === 'image') for (const r of rects) kids.push(h('div', { class: 'pa-img' + on, style: `${px(box(vp, r))};border-color:${a.color}` }));
      else if (a.type === 'ink' && a.paths) {
        const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'pa-ink' + on); svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height);
        for (const p of a.paths) {
          let d = '';
          for (let i = 0; i + 1 < p.length; i += 2) { const [x, y] = vp.convertToViewportPoint(p[i], p[i + 1]); d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }
          const path = document.createElementNS(NS, 'path');
          path.setAttribute('d', d); path.setAttribute('stroke', a.color); path.setAttribute('stroke-width', String((a.width || 1) * vp.scale)); path.setAttribute('fill', 'none');
          path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
          svg.append(path);
        }
        kids.push(svg);
      }
      // a highlight or underline with a comment: a mark at its end (a click opens it)
      if ((a.type === 'highlight' || a.type === 'underline') && a.comment && rects.length) {
        const b = box(vp, rects[rects.length - 1]);
        kids.push(h('div', { class: 'pa-cm', style: `left:${b.l + b.w - 3}px;top:${b.t - 7}px;background:${a.color}`, title: a.comment, dataset: { id: a.id } }));
      }
    }
    layer.replaceChildren(...kids);
  }
  const paintAll = () => { for (let no = 1; no <= pdf.pages; no++) paint(no); };
  pdf.onDraw((no) => paint(no));

  async function reload() {
    lastLoad = Date.now();
    const r = await call('/api/lit/annots?key=' + encodeURIComponent(key));
    if (destroyed || !r || !Array.isArray(r.items)) return;
    items = r.items; canWrite = !!r.canWrite;
    if (open && !items.some((a) => a.id === open.id)) closePop();
    paintAll();
  }

  // ---- where things are: client pixels <-> a page's PDF points ----
  const kOf = (el) => { const r = el.getBoundingClientRect(); return { r, k: r.width / (el.offsetWidth || r.width || 1) }; };
  function toPdf(slot, vp, cx, cy) { const { r, k } = kOf(slot); return vp.convertToPdfPoint((cx - r.left) / k, (cy - r.top) / k); }
  function placeIn(el, cx, cy) {                         // a bar or box near a point, inside the PDF's area
    const { r, k } = kOf(wrap);
    wrap.append(el);
    const w = el.offsetWidth, hh = el.offsetHeight, W = wrap.offsetWidth, H = wrap.offsetHeight;
    let x = (cx - r.left) / k - w / 2, y = (cy - r.top) / k + 8;
    if (y + hh > H - 4) y = Math.max(4, (cy - r.top) / k - hh - 12);
    el.style.left = Math.max(4, Math.min(W - w - 4, x)) + 'px'; el.style.top = Math.max(4, y) + 'px';
  }

  // the text selected in the PDF, page by page: { pages: [{ no, rects, text, top, offset }], at: { x, y } } or null
  function selected() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0), root = range.commonAncestorContainer;
    if (!pdf.pagesEl.contains(root)) return null;
    const nodes = [];
    if (root.nodeType === 3) nodes.push(root);
    else { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (range.intersectsNode(n)) nodes.push(n); }
    const pages = new Map();
    let last = null;
    for (const n of nodes) {
      const el = n.parentElement;
      if (!el || !el.closest('.textLayer') || el.closest('.endOfContent')) continue;
      const slot = el.closest('.pdf-page'), no = +slot.dataset.n, pg = pdf.page(no);
      if (!pg) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      const t = r.toString();
      if (!t.trim()) continue;
      let e = pages.get(no);
      if (!e) {
        // where the text starts in the page (Zotero orders by it): the characters of the text layer before it
        let offset = 0;
        const tw = document.createTreeWalker(slot.querySelector('.textLayer'), NodeFilter.SHOW_TEXT);
        for (let m = tw.nextNode(); m && m !== n; m = tw.nextNode()) offset += m.length;
        e = { no, vp: pg.vp, slot, raw: [], text: '', offset: offset + (n === range.startContainer ? range.startOffset : 0) };
        pages.set(no, e);
      }
      e.text += (e.text && !/[\s-]$/.test(e.text) && !/^\s/.test(t) ? ' ' : '') + t;
      for (const c of r.getClientRects()) {
        if (c.width < 0.5 || c.height < 0.5) continue;
        const [x1, y1] = toPdf(slot, pg.vp, c.left, c.top), [x2, y2] = toPdf(slot, pg.vp, c.right, c.bottom);
        e.raw.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
        last = c;
      }
    }
    if (!pages.size || !last) return null;
    const list = [...pages.values()].filter((e) => e.raw.length).map((e) => {
      const rects = mergeRects(e.raw);
      return { no: e.no, rects, text: e.text, offset: e.offset, top: e.vp.viewBox[3] - Math.max(...rects.map((r) => r[3])) };
    });
    // one page: the browser's own reading of the selection (its line breaks and spaces)
    if (list.length === 1) list[0].text = sel.toString();
    return { pages: list, at: { x: last.right, y: last.bottom } };
  }

  // ---- the bar for the text selected ----
  let bar = null, barSel = null;
  const hideBar = () => { if (bar) bar.remove(); bar = null; barSel = null; };
  async function addFrom(s, type, c, comment = '') {
    for (const p of s.pages) {
      const labels = await pdf.labels();
      const r = await call('/api/lit/annots/add', { key, type, color: c, text: p.text, comment, pageIndex: p.no - 1, pageLabel: (labels && labels[p.no - 1]) || String(p.no), rects: p.rects, top: p.top, offset: p.offset });
      if (!r.ok) { say(r.msg || '没加上'); return false; }
      items.push(r.item); paint(p.no);
    }
    color = c;
    return true;
  }
  function showBar(s) {
    hideBar();
    barSel = s;
    const keep = (el) => { el.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'TEXTAREA') e.preventDefault(); }); return el; };
    const done = () => { hideBar(); try { document.getSelection().removeAllRanges(); } catch {} };
    const dot = (c, n, fn) => h('button', { class: 'pa-dot' + (c === color ? ' on' : ''), type: 'button', title: n, style: `background:${c}`, onclick: fn });
    if (!canWrite) { bar = keep(h('div', { class: 'pa-bar' }, h('span', { class: 'pa-msg', text: NO_WRITE }))); placeIn(bar, s.at.x, s.at.y); return; }
    const pick = () => h('div', { class: 'pa-row' },
      ...COLORS.map(([c, n]) => dot(c, n + '色高亮', async () => { if (await addFrom(barSel, 'highlight', c)) done(); })),
      h('button', { class: 'btn', type: 'button', text: '下划线', title: '用上次的颜色划线', onclick: async () => { if (await addFrom(barSel, 'underline', color)) done(); } }),
      h('button', { class: 'btn', type: 'button', text: '加评论', onclick: () => { bar.replaceChildren(...comment()); bar.querySelector('textarea').focus(); } }));
    const comment = () => {
      const ta = h('textarea', { class: 'field pa-ta', rows: 3, placeholder: '对这段的评论（存进 Zotero，卡片也会读到）' });
      let c = color;
      const row = h('div', { class: 'pa-row' }, ...COLORS.map(([cc, n]) => { const b = dot(cc, n, () => { c = cc; row.querySelectorAll('.pa-dot').forEach((x) => x.classList.toggle('on', x === b)); }); return b; }));
      return [ta, row, h('div', { class: 'pa-row' },
        h('button', { class: 'btn go', type: 'button', text: '高亮并保存', onclick: async () => { if (await addFrom(barSel, 'highlight', c, ta.value.trim())) done(); } }),
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: done }), msgEl)];
    };
    bar = keep(h('div', { class: 'pa-bar' }, pick(), msgEl));
    placeIn(bar, s.at.x, s.at.y);
  }

  // ---- one annotation: its box ----
  function closePop() { const was = open; open = null; if (pop) pop.remove(); pop = null; if (was) paint(was.pageIndex + 1); }
  function showPop(a, cx, cy, isNew = null) {
    closePop(); hideBar();
    open = a; if (!isNew) paint(a.pageIndex + 1);
    const ta = h('textarea', { class: 'field pa-ta', rows: 3, placeholder: canWrite ? '评论（存进 Zotero）' : '（没有评论）', readonly: !canWrite });
    ta.value = a.comment || '';
    const head = h('div', { class: 'pa-head' }, h('b', { text: isNew ? '新便签' : (KIND[a.type] || '批注') }), h('span', { class: 'pa-pg', text: ` 第 ${a.pageLabel || a.pageIndex + 1} 页` }),
      h('button', { class: 'btn pa-x', type: 'button', text: '×', title: '关掉', onclick: closePop }));
    const kids = [head];
    if (a.text) kids.push(h('blockquote', { class: 'pa-q', text: a.text.length > 300 ? a.text.slice(0, 300) + '…' : a.text }));
    kids.push(ta);
    const upd = async (f) => {
      const r = await call('/api/lit/annots/update', { key, id: a.id, ...f });
      if (!r.ok) { say(r.msg || '没改成'); return; }
      const i = items.findIndex((x) => x.id === a.id); if (i >= 0) items[i] = r.item;
      Object.assign(a, r.item); paint(a.pageIndex + 1); say('已保存');
    };
    if (isNew) {
      let c = color;
      const row = h('div', { class: 'pa-row' }, ...COLORS.map(([cc, n]) => { const b = h('button', { class: 'pa-dot' + (cc === c ? ' on' : ''), type: 'button', title: n, style: `background:${cc}`, onclick: () => { c = cc; row.querySelectorAll('.pa-dot').forEach((x) => x.classList.toggle('on', x === b)); } }); return b; }));
      kids.push(row, h('div', { class: 'pa-row' },
        h('button', { class: 'btn go', type: 'button', text: '放上便签', onclick: async () => {
          const r = await call('/api/lit/annots/add', { key, type: 'note', color: c, comment: ta.value.trim(), pageIndex: a.pageIndex, pageLabel: a.pageLabel, rects: a.rects, top: isNew.top, offset: 0 });
          if (!r.ok) { say(r.msg || '没放上'); return; }
          color = c; items.push(r.item); closePop(); paint(r.item.pageIndex + 1);
        } }),
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: closePop }), msgEl));
    } else if (canWrite) {
      kids.push(h('div', { class: 'pa-row' },
        h('button', { class: 'btn go', type: 'button', text: '保存评论', onclick: () => upd({ comment: ta.value.trim() }) }),
        ...COLORS.map(([c, n]) => h('button', { class: 'pa-dot' + (c === a.color ? ' on' : ''), type: 'button', title: '改成' + n + '色', style: `background:${c}`, onclick: () => upd({ color: c }) }))),
      h('div', { class: 'pa-row' },
        a.type === 'highlight' || a.type === 'underline' ? h('button', { class: 'btn', type: 'button', text: a.type === 'highlight' ? '改成下划线' : '改成高亮', onclick: () => upd({ type: a.type === 'highlight' ? 'underline' : 'highlight' }) }) : null,
        h('button', { class: 'btn pa-del', type: 'button', text: '删除', onclick: async (e) => {
          const b = e.currentTarget;
          if (b.textContent !== '确定删除？') { b.textContent = '确定删除？'; return; }
          const r = await call('/api/lit/annots/delete', { key, id: a.id });
          if (!r.ok) { say(r.msg || '没删掉'); return; }
          items = items.filter((x) => x.id !== a.id); closePop();
        } }), msgEl));
    } else kids.push(h('div', { class: 'pa-row' }, h('span', { class: 'pa-msg', text: NO_WRITE })));
    pop = h('div', { class: 'pa-pop' }, ...kids);
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    placeIn(pop, cx, cy);
    if (isNew) ta.focus();
  }

  // ---- the mouse ----
  // the annotation under a point of a page (the last drawn first: the one on top)
  function hit(slot, vp, cx, cy) {
    const [x, y] = toPdf(slot, vp, cx, cy), no = +slot.dataset.n, tol = 2 / vp.scale;
    const on = items.filter((a) => a.pageIndex === no - 1 && (a.rects || []).some((r) => x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol));
    return on[on.length - 1] || null;
  }
  const onUp = (e) => {
    if (placing || e.button > 0) return;
    setTimeout(() => {
      if (destroyed) return;
      const s = selected();
      if (s) { closePop(); showBar(s); return; }
      if (bar && !bar.contains(e.target)) hideBar();
      const mark = e.target.closest && e.target.closest('.pa-note, .pa-cm, .pa-text');
      const slot = e.target.closest && e.target.closest('.pdf-page');
      const pg = slot && pdf.page(+slot.dataset.n);
      const a = mark ? items.find((x) => x.id === mark.dataset.id) : pg ? hit(slot, pg.vp, e.clientX, e.clientY) : null;
      if (a) showPop(a, e.clientX, e.clientY); else if (pop && !pop.contains(e.target)) closePop();
    }, 0);
  };
  const onClickPlace = (e) => {
    if (!placing) return;
    const slot = e.target.closest('.pdf-page'), pg = slot && pdf.page(+slot.dataset.n);
    if (!pg) return;
    e.preventDefault(); e.stopPropagation();
    setPlacing(false);
    const [x, y] = toPdf(slot, pg.vp, e.clientX, e.clientY), no = +slot.dataset.n;
    pdf.labels().then((labels) => showPop({ id: '', type: 'note', color, pageIndex: no - 1, pageLabel: (labels && labels[no - 1]) || String(no), rects: [[x, y - 22, x + 22, y]], comment: '' }, e.clientX, e.clientY, { top: pg.vp.viewBox[3] - y }));
  };
  const onSelChange = () => { if (bar && !bar.querySelector('textarea') && !selected()) hideBar(); };
  const onKey = (e) => { if (e.key === 'Escape') { hideBar(); closePop(); setPlacing(false); } };
  const onFocus = () => { if (Date.now() - lastLoad > 5000) reload(); };   // (back from Zotero, or the other window)
  pdf.pagesEl.addEventListener('pointerup', onUp);
  pdf.pagesEl.addEventListener('click', onClickPlace, true);
  document.addEventListener('selectionchange', onSelChange);
  document.addEventListener('keydown', onKey);
  addEventListener('focus', onFocus);

  // 便签 in the PDF's bar
  const noteB = h('button', { class: 'btn pa-nb', type: 'button', text: '便签', title: '在页面上点一下，放一张便签（存进 Zotero）' });
  function setPlacing(on) { placing = on; noteB.classList.toggle('on', on); pdf.pagesEl.classList.toggle('pa-placing', on); }
  noteB.addEventListener('click', () => { if (!canWrite) { say(NO_WRITE); return; } closePop(); hideBar(); setPlacing(!placing); });
  pdf.bar.append(noteB, topMsg);
  reload();

  return {
    reload,
    destroy() {
      destroyed = true; hideBar(); closePop(); noteB.remove(); topMsg.remove();
      pdf.pagesEl.removeEventListener('pointerup', onUp); pdf.pagesEl.removeEventListener('click', onClickPlace, true);
      document.removeEventListener('selectionchange', onSelChange); document.removeEventListener('keydown', onKey); removeEventListener('focus', onFocus);
    },
  };
}
