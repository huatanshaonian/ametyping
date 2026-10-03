// Markdown of the knowledge base (cards, topics, answers) in the 文献 windows: marked + DOMPurify + KaTeX (md-math.js),
// the YAML front matter left out, [[citekey]] links opening that card (onLink), "- [ ]" tasks shown as ☐ / ☑, and the
// page numbers the model cites ([p.12]) clickable when the reader has the PDF open (onPage).
import { Marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.js';
import { createMath, drawMath } from './md-math.js';

export const stripFront = (text) => String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

export async function renderMd(el, text, { onLink, onPage } = {}) {
  const src = stripFront(text)
    .replace(/^(\s*)- \[ \] /gm, '$1- ☐ ').replace(/^(\s*)- \[x\] /gim, '$1- ☑ ')
    .replace(/\[\[([^\]|#\n]+)(?:\|([^\]\n]+))?\]\]/g, (m, k, label) => `[${label || k}](#lit:${encodeURIComponent(k.trim())})`)
    .replace(/\[p\.\s?(\d{1,4})\]/g, (m, n) => `[p.${n}](#page:${n})`);
  const math = createMath();
  const html = new Marked({ gfm: true, breaks: false }, { extensions: math.extensions }).parse(src);
  el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'img'], FORBID_ATTR: ['style'] });
  await drawMath(el, math.found);
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#lit:')) { a.classList.add('wlink'); a.addEventListener('click', (e) => { e.preventDefault(); if (onLink) onLink(decodeURIComponent(href.slice(5))); }); }
    else if (href.startsWith('#page:')) { a.classList.add('plink'); a.addEventListener('click', (e) => { e.preventDefault(); if (onPage) onPage(+href.slice(6)); }); }
    else if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else a.removeAttribute('href');
  }
}

// a small line diff for the proposals (before -> after): [{ t: ' ' | '+' | '-', line }]
export function lineDiff(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  if (A.length * B.length > 4e6) return [...A.map((line) => ({ t: '-', line })), ...B.map((line) => ({ t: '+', line }))];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', line: A[i++] });
    else out.push({ t: '+', line: B[j++] });
  }
  while (i < n) out.push({ t: '-', line: A[i++] });
  while (j < m) out.push({ t: '+', line: B[j++] });
  return out;
}
