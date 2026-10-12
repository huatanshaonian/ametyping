// 画板's 还原稿: the pieces the model found on a handwritten page (server/board/prompts.js: text, formulas, boxes,
// lines, arrows, tables, each with its place on a 1000-wide grid) laid out as HTML where they were written. Nothing is
// designed here: one typeface, one line weight, the manuscript's own colours. The sheet scales with its width --
// places are percentages, sizes are in container units (1 grid unit = 0.1cqw) -- so it needs no script to fit a
// window, a phone or a printed page. Formulas are drawn by `tex(source, display)` (KaTeX, given by board-page.js).
// This file builds strings only (no DOM), so it runs in a test as well.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = (v) => +v.toFixed(2);
const INK = '#1f2328';
const MATH = /\$\$([\s\S]+?)\$\$|\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$/g;

export const SHEET_CSS = `
.sheet{position:relative;width:100%;container-type:inline-size;background:#fff;color:${INK};overflow:hidden;
  font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.sheet>svg{position:absolute;inset:0;width:100%;height:100%}
.sheet .t,.sheet .m,.sheet .s,.sheet .l,.sheet .tb{position:absolute}
.sheet .t,.sheet .l{white-space:pre}
.sheet .b{font-weight:700}
.sheet .s{display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-wrap;line-height:1.25;box-sizing:border-box;padding:0 .35em}
.sheet .l{line-height:1.2}
.sheet .m{white-space:nowrap;transform:translateY(-50%)}
.sheet .m .katex-display{margin:0;text-align:left}
.sheet .m .katex-display>.katex{text-align:left}
.sheet .tb{border-collapse:collapse;line-height:1.3}
.sheet .tb td,.sheet .tb th{border:.07em solid currentColor;padding:.2em .5em;text-align:left;vertical-align:top}
`;

// text with $...$ in it -> HTML (the formulas drawn, the rest escaped)
function inline(text, tex) {
  let out = '', last = 0;
  for (const m of String(text).matchAll(MATH)) {
    out += esc(text.slice(last, m.index)) + tex((m[1] || m[2]).trim(), m[1] != null);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// r: { h, items } (the grid is 1000 wide, h high); tex(source, display) -> HTML
export function sheetHtml(r, tex) {
  const H = r.h || 1000;
  const px = (v) => f(v / 10) + '%', py = (v) => f(v / H * 100) + '%', fs = (u) => f(u / 10) + 'cqw';
  const shapes = [], labels = [];
  for (const i of r.items || []) {
    const col = i.color || INK, colCss = i.color ? `color:${i.color};` : '', b = i.bold ? ' b' : '';
    const w = i.x2 - i.x, h = i.y2 - i.y;
    const stroke = `fill="none" stroke="${col}" stroke-width="1.8"${i.dashed ? ' stroke-dasharray="7 5"' : ''}`;
    if (i.kind === 'text') {
      const lines = i.text.split('\n'), size = clamp(i.size ? i.size * 0.8 : 18, 8, 90);
      const lh = lines.length > 1 && h > 0 ? clamp(h / lines.length / size, 1.1, 2.4) : 1.35;
      const top = i.y + (h > 0 ? (h - size * lh * lines.length) / 2 : 0);          // (centred on where it was written)
      labels.push(`<div class="t${b}" style="left:${px(i.x)};top:${py(top)};font-size:${fs(size)};line-height:${f(lh)};${colCss}">${inline(i.text, tex)}</div>`);
    } else if (i.kind === 'math') {
      const size = clamp(i.size ? i.size * 0.8 : 20, 8, 90);
      labels.push(`<div class="m${b}" style="left:${px(i.x)};top:${py((i.y + i.y2) / 2)};font-size:${fs(size)};${colCss}">${tex(i.text, true)}</div>`);
    } else if (i.kind === 'table') {
      const rows = i.text.split('\n').map((l) => l.trim()).filter((l) => l && !/^[\s:|-]+$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const size = clamp(i.size ? i.size * 0.8 : 15, 8, 60);
      labels.push(`<table class="tb" style="left:${px(i.x)};top:${py(i.y)};width:${px(w)};font-size:${fs(size)};${colCss}">` +
        rows.map((row, n) => '<tr>' + row.map((c) => (n ? '<td>' : '<th>') + inline(c, tex) + (n ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table>');
    } else if (i.kind === 'line' || i.kind === 'arrow') {
      const dx = i.x2 - i.x, dy = i.y2 - i.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      if (i.kind === 'arrow') {
        const a = Math.min(11, len * 0.6), hw = a * 0.38, bx = i.x2 - ux * a, by = i.y2 - uy * a;      // the head: a filled triangle at (x2, y2)
        shapes.push(`<line x1="${f(i.x)}" y1="${f(i.y)}" x2="${f(i.x2 - ux * a * 0.7)}" y2="${f(i.y2 - uy * a * 0.7)}" ${stroke}/>`,
          `<polygon points="${f(i.x2)},${f(i.y2)} ${f(bx - uy * hw)},${f(by + ux * hw)} ${f(bx + uy * hw)},${f(by - ux * hw)}" fill="${col}"/>`);
      } else shapes.push(`<line x1="${f(i.x)}" y1="${f(i.y)}" x2="${f(i.x2)}" y2="${f(i.y2)}" ${stroke} stroke-linecap="round"/>`);
      if (i.text.trim()) {
        // the words beside a line: above the middle of a flat one, to the right of a steep one
        const flat = Math.abs(dx) >= Math.abs(dy), size = clamp(i.size ? i.size * 0.8 : 14, 8, 60);
        labels.push(`<div class="l${b}" style="left:${px((i.x + i.x2) / 2)};top:${py((i.y + i.y2) / 2)};font-size:${fs(size)};transform:translate(${flat ? '-50%,-115%' : '.5em,-50%'});${colCss}">${inline(i.text, tex)}</div>`);
      }
    } else {
      const cx = f(i.x + w / 2), cy = f(i.y + h / 2);
      if (i.kind === 'ellipse') shapes.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(w / 2)}" ry="${f(h / 2)}" ${stroke}/>`);
      else if (i.kind === 'diamond') shapes.push(`<polygon points="${cx},${f(i.y)} ${f(i.x2)},${cy} ${cx},${f(i.y2)} ${f(i.x)},${cy}" ${stroke} stroke-linejoin="round"/>`);
      else shapes.push(`<rect x="${f(i.x)}" y="${f(i.y)}" width="${f(w)}" height="${f(h)}"${i.kind === 'round' ? ` rx="${f(Math.min(14, h / 2, w / 2))}"` : ''} ${stroke}/>`);
      if (i.text.trim()) {
        const size = clamp(i.size ? i.size * 0.8 : Math.min(18, h * 0.35), 8, 60);
        labels.push(`<div class="s${b}" style="left:${px(i.x)};top:${py(i.y)};width:${px(w)};height:${py(h)};font-size:${fs(size)};${colCss}">${inline(i.text, tex)}</div>`);
      }
    }
  }
  return `<div class="sheet" style="aspect-ratio:1000/${H}"><svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none">${shapes.join('')}</svg>${labels.join('')}</div>`;
}
