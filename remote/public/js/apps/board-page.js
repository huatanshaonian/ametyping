// 画板's pages: the 还原稿 (board-sheet.js) and the 设计稿 (HTML written by a model) as whole HTML documents -- one
// to show in the window (in a frame that runs no script), one to save as a file that opens anywhere.
//   Formulas are drawn here with KaTeX: its stylesheet is linked while the page is shown in Windose; a saved file
//     carries the stylesheet and the fonts inside it (about 400 KB, only when the page has formulas).
//   The model's HTML is cleaned (DOMPurify: no scripts, forms, frames, links to stylesheets) and every page says, by
//     its own Content-Security-Policy, that it loads nothing from anywhere -- a saved file never calls out either.
import DOMPurify from '/vendor/purify.es.js';
import { esc } from '../util.js';
import { sheetHtml, SHEET_CSS } from './board-sheet.js';

const KATEX = '/vendor/katex/';
let katex = null, inlineCss = null;

// tex(source, display) -> HTML; a formula KaTeX cannot read stays as its source
export async function loadTex() {
  if (!katex) katex = (await import(KATEX + 'katex.mjs')).default;
  return (src, display) => {
    try { return katex.renderToString(src, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' }); }
    catch { return esc((display ? '$$' : '$') + src + (display ? '$$' : '$')); }
  };
}

function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
// KaTeX's stylesheet for the page's <head>: a link (shown here) or the whole of it with the fonts inside (saved)
async function katexHead(standalone) {
  if (!standalone) return `<link rel="stylesheet" href="${location.origin}${KATEX}katex.min.css">`;
  if (!inlineCss) {
    let css = await (await fetch(KATEX + 'katex.min.css')).text();
    const names = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)].map((m) => m[1]))];
    const data = {};
    await Promise.all(names.map(async (n) => { data[n] = b64(await (await fetch(`${KATEX}fonts/${n}.woff2`)).arrayBuffer()); }));
    // (each face lists woff2, woff and ttf: only the first is kept)
    css = css.replace(/src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)[^;}]*/g, (m, n) => `src:url(data:font/woff2;base64,${data[n]}) format("woff2")`);
    inlineCss = `<style>${css}</style>`;
  }
  return inlineCss;
}
const csp = (standalone) => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${standalone ? '' : ' ' + location.origin}; img-src data:; font-src ${standalone ? 'data:' : location.origin}">`;
const head = async (title, standalone, withMath) => `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${csp(standalone)}<title>${esc(title)}</title>${withMath ? await katexHead(standalone) : ''}`;

// r: the 还原稿 as the server keeps it ({ title, h, items })
export async function restorePage(r, { standalone = false } = {}) {
  const body = sheetHtml(r, await loadTex());
  return `<!doctype html>\n<html lang="zh-CN"><head>${await head(r.title || '还原稿', standalone, body.includes('class="katex'))}<style>
html,body{margin:0;background:#fff}
.wrap{max-width:1100px;margin:0 auto;padding:12px;box-sizing:border-box}
@media print{.wrap{max-width:none;padding:0}}${SHEET_CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

const FORMULA = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?![\p{L}\p{N}])/gu;
// the formulas written between dollars in a page's text (not in its styles, code or drawings) are drawn in place
function drawFormulas(root, tex) {
  const doc = root.ownerDocument, texts = [];
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/[$\\]/.test(n.nodeValue) && !n.parentElement.closest('style,script,svg,code,pre,textarea,title')) texts.push(n);
  let any = false;
  for (const n of texts) {
    const s = n.nodeValue, parts = [];
    let last = 0;
    for (const m of s.matchAll(FORMULA)) {
      const display = m[1] != null || m[2] != null, src = (m[1] || m[2] || m[3] || m[4]).trim();
      const span = doc.createElement('span');
      span.innerHTML = tex(src, display);
      parts.push(s.slice(last, m.index), span);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    any = true;
    n.replaceWith(...parts, s.slice(last));
  }
  return any;
}

// html: the 设计稿 as the model wrote it
export async function designPage(html, { standalone = false, title = '设计稿' } = {}) {
  const root = DOMPurify.sanitize(String(html), { WHOLE_DOCUMENT: true, RETURN_DOM: true, ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'audio', 'video', 'source'] });
  const doc = root.ownerDocument, h = root.querySelector('head') || root.insertBefore(doc.createElement('head'), root.firstChild);
  const body = root.querySelector('body') || root;
  // pictures from elsewhere would not load anyway (the page's policy): taken out, so no broken frame is left
  for (const im of root.querySelectorAll('img, image')) if (!/^data:image\//i.test(im.getAttribute('src') || im.getAttribute('href') || im.getAttribute('xlink:href') || '')) im.remove();
  const math = drawFormulas(body, await loadTex());
  for (const t of h.querySelectorAll('title')) t.remove();
  h.insertAdjacentHTML('afterbegin', await head(title, standalone, math));
  if (!root.getAttribute('lang')) root.setAttribute('lang', 'zh-CN');
  return '<!doctype html>\n' + root.outerHTML;
}

// a frame showing one of these pages: no script runs in it (and the page's own policy lets nothing in from outside)
export function frameOf(page) {
  const f = document.createElement('iframe');
  f.className = 'bo-frame';
  f.setAttribute('sandbox', 'allow-same-origin');
  f.srcdoc = page;
  return f;
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30e3);
}
