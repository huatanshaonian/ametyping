// 画板's ink: what a stroke is and how it is drawn (board-surface.js collects them, board.js is the window).
//   a stroke: { t: 'pencil' | 'marker', c: '#rrggbb', w: width, p: [x, y, pressure, x, y, pressure, ...], bb: [x0, y0, x1, y1] }
// The page is white paper and ink only ever darkens it:
//   铅笔 (pencil): pressure decides how dark a piece of the line is (and, a little, how wide) -- no tapered ends.
//     Each piece is drawn opaque in its own shade with "darken", so pieces of one line do not add up where they meet
//     and a light line crossing a dark one does not paint over it.
//   荧光笔 (marker): one even, wide path in a pale shade, multiplied onto what is under it (the writing shows through).
// Lines are smoothed the usual way: through the midpoints of the samples, each sample the control point of its curve.

export const TOOLS = { pencil: { w: 2.2, blend: 'darken' }, marker: { w: 18, blend: 'multiply' } };
export const NO_PRESSURE = 0.8;                    // a mouse or a finger: one even, fairly dark line

const SHADES = 16;
const rgb = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (c, k) => { const [r, g, b] = rgb(c); const f = (v) => Math.round(255 - (255 - v) * k); return `rgb(${f(r)},${f(g)},${f(b)})`; };
const shadeCache = new Map();
// a pencil's colour at a pressure: from about half strength up to the full colour (reached at firm, not maximal, pressure)
function shade(c, pr) {
  const q = Math.round(Math.min(1, Math.max(0, 0.3 + 0.9 * pr)) * SHADES);
  const key = c + q;
  let v = shadeCache.get(key);
  if (!v) { v = mix(c, q / SHADES); shadeCache.set(key, v); }
  return v;
}
const pencilWidth = (w, pr) => w * (0.75 + 0.5 * pr);
export const markerColor = (c) => mix(c, 0.45);

export function bounds(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.p.length; i += 3) { const x = s.p[i], y = s.p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = s.w;                                   // (wide enough for either tool at full pressure)
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

// Draw a stroke into a context already set to the board's coordinates: all of it, or (while the pen is down) only
// what the samples from index `from` on add -- the last piece, up to the newest sample, is straight until the next
// sample shows which way the line bends.
export function drawStroke(ctx, s, from = 0) {
  const p = s.p, n = p.length / 3;
  if (!n) return;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (s.t === 'marker') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = ctx.fillStyle = markerColor(s.c);
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2);
    if (n > 1) ctx.lineTo(p[n * 3 - 3], p[n * 3 - 2]);
    ctx.stroke();
    return;
  }
  ctx.globalCompositeOperation = 'darken';
  const piece = (pr, path) => { ctx.strokeStyle = shade(s.c, pr); ctx.lineWidth = pencilWidth(s.w, pr); ctx.beginPath(); path(); ctx.stroke(); };
  if (n === 1) { piece(p[2], () => { ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.01, p[1]); }); return; }
  const mx = (i) => (p[i * 3 - 3] + p[i * 3]) / 2, my = (i) => (p[i * 3 - 2] + p[i * 3 + 1]) / 2;   // the midpoint before sample i
  if (from <= 1) piece(p[2], () => { ctx.moveTo(p[0], p[1]); ctx.lineTo(mx(1), my(1)); });
  // the curve around sample i (from the midpoint before it to the one after) can be drawn once sample i + 1 is there
  for (let i = Math.max(1, from - 1); i < n - 1; i++) piece(p[i * 3 + 2], () => { ctx.moveTo(mx(i), my(i)); ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx(i + 1), my(i + 1)); });
  piece(p[n * 3 - 1], () => { ctx.moveTo(mx(n - 1), my(n - 1)); ctx.lineTo(p[n * 3 - 3], p[n * 3 - 2]); });
}

// is (x, y) within r of the stroke's line?
export function hit(s, x, y, r) {
  const b = s.bb;
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const p = s.p, d = r + s.w / 2, d2 = d * d;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= d2;
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    if ((ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2 <= d2) return true;
  }
  return false;
}

// the rectangle around all the strokes ([x0, y0, x1, y1]), or null when there are none
export function extent(strokes) {
  if (!strokes.length) return null;
  const e = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) { e[0] = Math.min(e[0], s.bb[0]); e[1] = Math.min(e[1], s.bb[1]); e[2] = Math.max(e[2], s.bb[2]); e[3] = Math.max(e[3], s.bb[3]); }
  return e;
}

// the strokes within a rectangle of the board, on white, as a canvas at most `maxSide` pixels long (never enlarged past 2x)
export function picture(strokes, rect, maxSide = 2000) {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const k = Math.min(2, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(16, Math.round(w * k)); c.height = Math.max(16, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(k, 0, 0, k, -rect[0] * k, -rect[1] * k);
  for (const s of strokes) if (s.bb[2] >= rect[0] && s.bb[0] <= rect[2] && s.bb[3] >= rect[1] && s.bb[1] <= rect[3]) drawStroke(ctx, s);
  return c;
}
