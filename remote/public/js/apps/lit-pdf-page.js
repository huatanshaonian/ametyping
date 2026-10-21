// The PDF window of 拆分 (/lit-pdf?key=<key>&p=<page>, opened by the 深读 window -- see lit-split.js): only the PDF,
// filling the browser window; the page it is on and the text selected in it go to the 深读 window, which can send it
// to a page or close it.
import { h } from '../util.js';
import { renderPdf } from './pdfview.js';
import { splitChannel } from './lit-split.js';

const q = new URLSearchParams(location.search);
const key = q.get('key') || '', first = +q.get('p') || 0;
const box = document.getElementById('pdf');
const notice = (text) => box.replaceChildren(h('div', { class: 'notice', text }));

if (!/^[A-Z0-9]{8}$/.test(key)) notice('链接不对：没有文献的 key。');
else start();

async function start() {
  const ch = splitChannel(key);
  let page = 0, sel = '';
  const no = () => box.querySelector('.pdf-no');
  const goto = (n) => { const i = no(); if (!i || !(n > 0)) return; i.value = n; i.dispatchEvent(new Event('change')); };
  const say = (t, d = {}) => ch.postMessage({ t, ...d });
  ch.onmessage = ({ data: m }) => {
    if (!m) return;
    if (m.t === 'ping') say('here', { page, sel });
    else if (m.t === 'goto') { goto(+m.n); try { window.focus(); } catch {} }
    else if (m.t === 'close') window.close();
  };
  addEventListener('pagehide', () => say('bye', { page }));

  try {
    const it = await fetch('/api/lit/item?key=' + key);
    if (it.status === 401) { location.href = '/login'; return; }
    if (it.ok) { const d = await it.json(); if (d && d.title) document.title = 'PDF：' + d.title; }
    const res = await fetch('/api/lit/pdf?key=' + key);
    if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch {} notice(m || '没有 PDF。'); return; }
    await renderPdf(box, await res.arrayBuffer());
  } catch (e) { notice('PDF 打不开：' + (e.message || e)); return; }

  // the page shown follows the scrolling (pdfview.js keeps the number box up to date) or a number typed
  const report = () => { const n = +((no() || {}).value || 0); if (n && n !== page) { page = n; say('page', { n }); } };
  box.addEventListener('scroll', () => requestAnimationFrame(report), true);
  box.addEventListener('change', report, true);
  document.addEventListener('selectionchange', () => {
    const s = document.getSelection();
    const t = s && s.rangeCount && box.contains(s.anchorNode) ? s.toString().trim() : '';
    if (t !== sel) { sel = t; say('sel', { s: t }); }
  });
  if (first > 1) { await new Promise((r) => setTimeout(r, 400)); goto(first); }
  page = +((no() || {}).value || 1);
  say('here', { page, sel });
}
