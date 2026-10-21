// A Word document (.docx) drawn in the page, page by page as Word lays it out (vendor/docx-preview, which reads the
// file with vendor/jszip): text, styles, tables, pictures, headers and footers, footnotes. Both are loaded the first
// time one is opened. What the document could carry beyond its text is left out: a web page embedded in it
// (altChunk), its own fonts (the page's rules allow fonts only from this server), links other than web, mail and
// within the document.
import { h } from '../util.js';

let loading = null;
const script = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('加载 ' + src + ' 失败'));
  document.head.append(s);
});
function load() {
  if (window.docx && window.docx.renderAsync) return Promise.resolve(window.docx);
  if (!loading) loading = script('/vendor/jszip/jszip.min.js').then(() => script('/vendor/docx-preview/docx-preview.min.js')).then(() => window.docx);
  loading.catch(() => { loading = null; });
  return loading;
}

const SAFE = /^(https?:|mailto:|#)/i;

// into wrap (empty); -> { pages, fit() } -- fit(): the pages scaled to the window's width (a phone shows a whole page)
export async function renderDocx(wrap, buf) {
  const docx = await load();
  const styles = h('div'), body = h('div', { class: 'docx-pages' });
  wrap.replaceChildren(styles, body);
  await docx.renderAsync(buf, body, styles, {
    className: 'docx', inWrapper: true, ignoreFonts: true, renderAltChunks: false, useBase64URL: false,
    breakPages: true, ignoreLastRenderedPageBreak: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
  });
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!SAFE.test(href.trim())) { a.removeAttribute('href'); continue; }
    if (!href.startsWith('#')) Object.assign(a, { target: '_blank', rel: 'noopener noreferrer' });
  }
  const pages = body.querySelectorAll('section.docx').length;
  const fit = () => {
    const page = body.querySelector('section.docx');
    if (!page) return;
    body.style.zoom = '';
    const need = page.offsetWidth + 32, have = wrap.clientWidth;
    if (need > have && have > 0) body.style.zoom = String(have / need);
  };
  fit();
  return { pages, fit };
}
