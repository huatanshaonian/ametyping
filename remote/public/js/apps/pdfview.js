// PDF in a Windose window, by pdf.js (Mozilla; public/vendor/pdfjs, loaded the first time a PDF is opened): pages one
// under another at the window's width (－ / ＋ / 适合宽度), the page number to jump to, only the pages near the view
// drawn (a long paper stays quick), and a text layer so the words can be selected and copied. Chinese PDFs without
// their fonts use the character maps and standard fonts that come with it; images in JPX / JBIG2 are decoded in
// plain JS (WebAssembly would need the page's CSP loosened). Until －/＋ is pressed the pages keep to the width as the
// window is resized (适合宽度 goes back to that). Ctrl + wheel over the pages (a touchpad's pinch too) zooms the PDF
// around the pointer instead of the whole page: shown scaled at once, drawn again at that size when the wheel stops.
//   renderPdf(container, data: ArrayBuffer) -> { pages, bar, pagesEl, onDraw(fn), page(no), labels(), destroy() }
//   onDraw(fn): fn(no, slot, viewport) for each page as it is drawn (and those drawn already) -- for layers over
//   the page, put before its .textLayer (pdf-annot.js); page(no) -> { slot, vp } of a drawn page, or null
import { h } from '../util.js';

const BASE = '/vendor/pdfjs/';
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import(BASE + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
  }
  return lib;
}

export async function renderPdf(container, data) {
  const pdfjsLib = await pdfjs();
  const loading = pdfjsLib.getDocument({ data, cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/', useWasm: false, isEvalSupported: false });
  const doc = await loading.promise;
  const n = doc.numPages;
  const pageNo = h('input', { class: 'pdf-no', type: 'number', min: 1, max: n, value: 1, title: '跳到第几页' });
  const zoomTxt = h('span', { class: 'pdf-zoom' });
  const inner = h('div', { class: 'pdf-inner' });             // (the pages; scaled as a picture while Ctrl + wheel goes on)
  const pagesEl = h('div', { class: 'pdf-pages' }, inner);
  const bar = h('div', { class: 'pdf-bar' },
    h('span', {}, '第 ', pageNo, ` / ${n} 页`),
    h('button', { class: 'btn', type: 'button', text: '－', title: '缩小', onclick: () => { fit = false; zoom(scale / 1.2); } }), zoomTxt,
    h('button', { class: 'btn', type: 'button', text: '＋', title: '放大', onclick: () => { fit = false; zoom(scale * 1.2); } }),
    h('button', { class: 'btn', type: 'button', text: '适合宽度', onclick: () => { fit = true; zoom(fitScale()); } }));
  container.replaceChildren(bar, pagesEl);

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });                // (pages are sized like the first until drawn)
  const fitScale = () => Math.max(0.3, Math.min(4, (pagesEl.clientWidth - 24 - 18) / base.width));    // (room for the scrollbar to come)
  let scale = fitScale(), slots = [], io = null, destroyed = false, fit = true, refit = 0;
  const drawn = new Map();                                       // page number -> its render task
  const shown = new Map(), hooks = [];                          // page number -> { slot, vp } once drawn; onDraw's

  function layout() {
    if (io) io.disconnect();
    for (const t of drawn.values()) try { t.cancel(); } catch {}
    drawn.clear(); shown.clear();
    zoomTxt.textContent = Math.round(scale * 100) + '%';
    slots = Array.from({ length: n }, (_, i) => h('div', { class: 'pdf-page', dataset: { n: i + 1 },
      style: `width:${Math.floor(base.width * scale)}px;height:${Math.floor(base.height * scale)}px` }));
    inner.replaceChildren(...slots);
    io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) draw(+e.target.dataset.n); }, { root: pagesEl, rootMargin: '600px 0px' });
    for (const s of slots) io.observe(s);
  }
  async function draw(no) {
    if (drawn.has(no) || destroyed) return;
    drawn.set(no, { cancel() {} });
    const at = scale, slot = slots[no - 1];
    const page = await doc.getPage(no);
    if (destroyed || at !== scale) return;
    const vp = page.getViewport({ scale: at });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = h('canvas', { width: Math.floor(vp.width * dpr), height: Math.floor(vp.height * dpr) });
    Object.assign(canvas.style, { width: Math.floor(vp.width) + 'px', height: Math.floor(vp.height) + 'px' });
    Object.assign(slot.style, { width: Math.floor(vp.width) + 'px', height: Math.floor(vp.height) + 'px' });
    slot.style.setProperty('--total-scale-factor', String(at));
    const text = h('div', { class: 'textLayer' });
    slot.replaceChildren(canvas, text);
    shown.set(no, { slot, vp });
    for (const f of hooks) try { f(no, slot, vp); } catch {}
    const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    drawn.set(no, task);
    try { await task.promise; } catch { return; }
    try { await new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render(); } catch {}
  }
  function zoom(s) {
    const keep = (pagesEl.scrollTop + 1) / Math.max(1, pagesEl.scrollHeight);
    scale = Math.max(0.3, Math.min(4, s));
    layout();
    pagesEl.scrollTop = keep * pagesEl.scrollHeight;
  }
  // Ctrl + wheel: the pages scaled around the pointer as a picture until the wheel stops, then drawn at that size
  let wheelTo = 0, wheelAt = null, wheelT = 0;
  pagesEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = pagesEl.getBoundingClientRect(), k = r.width / (pagesEl.offsetWidth || r.width || 1);   // (a zoomed page: CSS px)
    if (!wheelAt) {
      const mx = (e.clientX - r.left) / k, my = (e.clientY - r.top) / k;
      wheelAt = { mx, my, x: pagesEl.scrollLeft + mx, y: pagesEl.scrollTop + my, pad: inner.offsetTop - pagesEl.offsetTop };
      wheelTo = scale;
    }
    const step = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.0025;
    wheelTo = Math.max(0.3, Math.min(4, wheelTo * Math.exp(-e.deltaY * step)));
    zoomTxt.textContent = Math.round(wheelTo * 100) + '%';
    inner.style.transformOrigin = `${wheelAt.x - 12}px ${wheelAt.y - 12}px`;
    inner.style.transform = `scale(${wheelTo / scale})`;
    clearTimeout(wheelT); wheelT = setTimeout(wheelDone, 200);
  }, { passive: false });
  function wheelDone() {
    const a = wheelAt, f = wheelTo / scale;
    wheelAt = null; inner.style.transform = ''; inner.style.transformOrigin = '';
    if (!a || destroyed || Math.abs(f - 1) < 0.005) { zoomTxt.textContent = Math.round(scale * 100) + '%'; return; }
    fit = false; scale = wheelTo; layout();
    pagesEl.scrollLeft = (a.x - 12) * f + 12 - a.mx;
    pagesEl.scrollTop = (a.y - 12) * f + 12 - a.my;
  }
  // the page number follows the scrolling; typing one goes there
  pagesEl.addEventListener('scroll', () => {
    const top = pagesEl.scrollTop + pagesEl.clientHeight / 3;
    const s = slots.find((x) => x.offsetTop + x.offsetHeight > top);
    if (s && document.activeElement !== pageNo) pageNo.value = s.dataset.n;
  });
  pageNo.addEventListener('change', () => { const s = slots[Math.min(n, Math.max(1, +pageNo.value || 1)) - 1]; if (s) pagesEl.scrollTop = s.offsetTop - 8; });
  layout();
  // the window resized (or the PDF given more room): the width again, unless zoomed by hand
  const ro = new ResizeObserver(() => { clearTimeout(refit); refit = setTimeout(() => { if (!destroyed && fit && pagesEl.clientWidth > 50 && Math.abs(fitScale() - scale) > 0.01) zoom(fitScale()); }, 150); });
  ro.observe(pagesEl);
  let labelsP = null;
  return { pages: n, bar, pagesEl,
    onDraw(fn) { hooks.push(fn); for (const [no, s] of shown) try { fn(no, s.slot, s.vp); } catch {} },
    page: (no) => shown.get(no) || null,
    labels: () => labelsP || (labelsP = doc.getPageLabels().catch(() => null)),       // (the printed page numbers, if the PDF has them)
    destroy() { destroyed = true; clearTimeout(refit); clearTimeout(wheelT); ro.disconnect(); if (io) io.disconnect(); hooks.length = 0; loading.destroy(); } };      // (the worker too)
}
