// PDF in a Windose window, by pdf.js (Mozilla; public/vendor/pdfjs, loaded the first time a PDF is opened): pages one
// under another at the window's width (－ / ＋ / 适合宽度), the page number to jump to, only the pages near the view
// drawn (a long paper stays quick), and a text layer so the words can be selected and copied. Chinese PDFs without
// their fonts use the character maps and standard fonts that come with it; images in JPX / JBIG2 are decoded in
// plain JS (WebAssembly would need the page's CSP loosened).
//   renderPdf(container, data: ArrayBuffer) -> { destroy() }
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
  const pagesEl = h('div', { class: 'pdf-pages' });
  const bar = h('div', { class: 'pdf-bar' },
    h('span', {}, '第 ', pageNo, ` / ${n} 页`),
    h('button', { class: 'btn', type: 'button', text: '－', title: '缩小', onclick: () => zoom(scale / 1.2) }), zoomTxt,
    h('button', { class: 'btn', type: 'button', text: '＋', title: '放大', onclick: () => zoom(scale * 1.2) }),
    h('button', { class: 'btn', type: 'button', text: '适合宽度', onclick: () => zoom(fitScale()) }));
  container.replaceChildren(bar, pagesEl);

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });                // (pages are sized like the first until drawn)
  const fitScale = () => Math.max(0.3, Math.min(4, (pagesEl.clientWidth - 24 - 18) / base.width));    // (room for the scrollbar to come)
  let scale = fitScale(), slots = [], io = null, destroyed = false;
  const drawn = new Map();                                       // page number -> its render task

  function layout() {
    if (io) io.disconnect();
    for (const t of drawn.values()) try { t.cancel(); } catch {}
    drawn.clear();
    zoomTxt.textContent = Math.round(scale * 100) + '%';
    slots = Array.from({ length: n }, (_, i) => h('div', { class: 'pdf-page', dataset: { n: i + 1 },
      style: `width:${Math.floor(base.width * scale)}px;height:${Math.floor(base.height * scale)}px` }));
    pagesEl.replaceChildren(...slots);
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
  // the page number follows the scrolling; typing one goes there
  pagesEl.addEventListener('scroll', () => {
    const top = pagesEl.scrollTop + pagesEl.clientHeight / 3;
    const s = slots.find((x) => x.offsetTop + x.offsetHeight > top);
    if (s && document.activeElement !== pageNo) pageNo.value = s.dataset.n;
  });
  pageNo.addEventListener('change', () => { const s = slots[Math.min(n, Math.max(1, +pageNo.value || 1)) - 1]; if (s) pagesEl.scrollTop = s.offsetTop - 8; });
  layout();
  return { pages: n, destroy() { destroyed = true; if (io) io.disconnect(); loading.destroy(); } };      // (the worker too)
}
