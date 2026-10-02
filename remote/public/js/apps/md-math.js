// LaTeX formulas in Markdown, the way papers and AI answers write them: $$…$$ and \[…\] on their own (display), $…$
// and \(…\) within a line. marked is taught to recognise them (so code spans / blocks stay as they are) and leaves a
// placeholder; after DOMPurify has cleaned the page they are drawn by KaTeX (public/vendor/katex, loaded only when a
// document has formulas). KaTeX builds its output from the formula itself with trust off (no links, no HTML from the
// text), so it goes in after the cleaning -- which would strip the inline styles it lays the formula out with.
// A price like "$5 and $10" is not a formula: no space just inside the dollars, no letter or digit right after the
// closing one, and never across a code span.
const BASE = '/vendor/katex/';

// marked extensions + the formulas found while rendering ({ tex, display }); usage: marked.use({ extensions: math.extensions })
export function createMath() {
  const found = [];
  const ph = (tex, display) => { found.push({ tex, display }); return `<span class="mathph" data-math="${found.length - 1}"></span>`; };
  const extensions = [
    { name: 'mathBlock', level: 'block',
      // (only at the start of a line: a $$ inside a paragraph is the inline one's)
      start: (src) => { const m = /(^|\n) {0,3}(\$\$|\\\[)/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) {
        const m = /^ {0,3}\$\$((?:(?!\$\$)[\s\S])+?)\$\$[^\S\n]*(?:\n|$)/.exec(src) || /^ {0,3}\\\[((?:(?!\\\])[\s\S])+?)\\\][^\S\n]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: (t) => `<div class="mathblock">${ph(t.text, true)}</div>\n` },
    { name: 'mathInline', level: 'inline',
      start: (src) => { const i = src.search(/\$|\\\(|\\\[/); return i < 0 ? undefined : i; },
      tokenizer(src) {
        let m = /^\$\$((?:(?!\$\$)[\s\S])+?)\$\$/.exec(src) || /^\\\[((?:(?!\\\])[\s\S])+?)\\\]/.exec(src);    // display, within a line
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
        // (no space just inside the dollars, no letter / digit right after the closing one, never across a code span)
        m = /^\$(?![\s$])((?:\\.|[^\\$\n`])+?)(?<!\s)\$(?![\p{L}\p{N}])/u.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: false };
      },
      renderer: (t) => ph(t.text, t.display) },
  ];
  return { extensions, found };
}

let katex = null;
function loadCss() {
  if (document.querySelector('link[data-katex]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = BASE + 'katex.min.css'; l.dataset.katex = '1';
  document.head.append(l);
}
// draw the placeholders left in `el` (after the page was cleaned)
export async function drawMath(el, found) {
  const phs = el.querySelectorAll('.mathph');
  if (!phs.length) return;
  loadCss();
  if (!katex) katex = (await import(BASE + 'katex.mjs')).default;
  for (const p of phs) {
    const f = found[+p.dataset.math];
    if (!f) continue;
    try { p.innerHTML = katex.renderToString(f.tex, { displayMode: f.display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' }); }
    catch { p.textContent = (f.display ? '$$' : '$') + f.tex + (f.display ? '$$' : '$'); }
    p.title = f.tex;
  }
}
