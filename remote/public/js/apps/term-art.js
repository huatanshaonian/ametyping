// A picture the terminal draws with block characters (/mobile's QR code) shown in the dashboard as the picture it is.
// Drawn as text, a font's █ seldom fills its whole cell: thin gaps run between the squares and a phone may not read
// the code. Here each character is two cells, one above the other (▀ the upper, ▄ the lower, █ both, a blank
// neither), drawn as solid squares, dark on light, with a margin of light around them. A character of any other
// shape: null (the caller shows the text as it is).
const SVG = 'http://www.w3.org/2000/svg';
const CELLS = { ' ': [0, 0], '▀': [1, 0], '▄': [0, 1], '█': [1, 1] };

export function artEl(text, px = 4) {
  const lines = String(text || '').split('\n');
  if (!lines.every((l) => [...l].every((c) => CELLS[c]))) return null;
  // (m: the light margin, four squares wide -- what a QR code asks for around it)
  const w = Math.max(...lines.map((l) => [...l].length)), hgt = lines.length * 2, m = 4;
  let d = '';
  lines.forEach((l, y) => [...l].forEach((c, x) => {
    const [top, bottom] = CELLS[c];
    if (top) d += `M${x + m} ${y * 2 + m}h1v1h-1z`;
    if (bottom) d += `M${x + m} ${y * 2 + 1 + m}h1v1h-1z`;
  }));
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w + 2 * m} ${hgt + 2 * m}`);
  svg.setAttribute('width', (w + 2 * m) * px);
  svg.setAttribute('height', (hgt + 2 * m) * px);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'tart');
  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', '#000');
  svg.append(bg, p);
  return svg;
}
