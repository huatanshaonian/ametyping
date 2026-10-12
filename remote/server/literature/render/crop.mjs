// Cuts figures out of page images (figures.js runs it as a child process, like pages.mjs: the native canvas stays out
// of the server).
//   node crop.mjs <spec.json>     spec: { jobs: [{ src: a page's PNG, box: [x0, y0, x1, y1] as fractions of the page, out, maxWidth }] }
// Prints one JSON line: { files: [{ out, w, h, box }] } (box: as cut, in fractions; a job that fails: { out, error }).
// The box comes from a model that looked at the page, and is a little off more often than not -- inside the frame of
// a plot (the tick labels and the axis titles cut away), or with white around. So it is put right by the page itself:
// the figure is taken to be the ink in the box together with all the ink that hangs on to it -- other ink no further
// than GAP of the page away, step by step (a frame the curves touch, the tick labels beside the frame, the axis title
// beside those) -- as far as GROW of the page beyond the box; the cut is what holds all of that, with a small margin.
// A caption or the text of the page lies further from a figure than its own parts lie from each other.
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const GROW = 0.06, GAP = 0.011, INK = 228, PAD = 10;

function refine(img, w, h, box) {
  const [bx0, by0, bx1, by1] = [Math.floor(box[0] * w), Math.floor(box[1] * h), Math.ceil(box[2] * w), Math.ceil(box[3] * h)].map((v, i) => Math.max(0, Math.min(i % 2 ? h : w, v)));
  if (bx1 - bx0 < 8 || by1 - by0 < 8) return null;
  const c = createCanvas(w, h), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, w, h).data;
  const dark = (x, y) => { const i = (y * w + x) * 4; return (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 < INK; };
  // the page as cells of half a GAP: does a cell hold ink? (ink two cells away hangs on)
  const cell = Math.max(3, Math.round(GAP * Math.max(w, h) / 2)), cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const ink = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y)) ink[Math.floor(y / cell) * cw + Math.floor(x / cell)] = 1;
  // how far the figure may reach: GROW beyond the box
  const lx0 = Math.max(0, Math.floor((bx0 - GROW * w) / cell)), ly0 = Math.max(0, Math.floor((by0 - GROW * h) / cell));
  const lx1 = Math.min(cw - 1, Math.floor((bx1 + GROW * w) / cell)), ly1 = Math.min(ch - 1, Math.floor((by1 + GROW * h) / cell));
  const seen = new Uint8Array(cw * ch), todo = [];
  for (let cy = Math.floor(by0 / cell); cy <= Math.min(ch - 1, Math.floor((by1 - 1) / cell)); cy++)
    for (let cx = Math.floor(bx0 / cell); cx <= Math.min(cw - 1, Math.floor((bx1 - 1) / cell)); cx++) if (ink[cy * cw + cx]) { seen[cy * cw + cx] = 1; todo.push(cx, cy); }
  if (!todo.length) return null;                               // (nothing drawn there)
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  while (todo.length) {
    const cy = todo.pop(), cx = todo.pop();
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < lx0 || nx > lx1 || ny < ly0 || ny > ly1) continue;
      const k = ny * cw + nx;
      if (ink[k] && !seen[k]) { seen[k] = 1; todo.push(nx, ny); }
    }
  }
  // the cells' bounds, brought in to the ink itself
  let px0 = x0 * cell, py0 = y0 * cell, px1 = Math.min(w, (x1 + 1) * cell), py1 = Math.min(h, (y1 + 1) * cell);
  const row = (y) => { for (let x = px0; x < px1; x++) if (dark(x, y)) return true; return false; };
  const col = (x) => { for (let y = py0; y < py1; y++) if (dark(x, y)) return true; return false; };
  while (py1 - py0 > 16 && !row(py0)) py0++;
  while (py1 - py0 > 16 && !row(py1 - 1)) py1--;
  while (px1 - px0 > 16 && !col(px0)) px0++;
  while (px1 - px0 > 16 && !col(px1 - 1)) px1--;
  return [Math.max(0, px0 - PAD), Math.max(0, py0 - PAD), Math.min(w, px1 + PAD), Math.min(h, py1 + PAD)];
}

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pages = new Map(), files = [];
for (const j of spec.jobs || []) {
  try {
    if (!pages.has(j.src)) pages.set(j.src, await loadImage(fs.readFileSync(j.src)));
    const img = pages.get(j.src), w = img.width, h = img.height;
    const b = refine(img, w, h, j.box);
    if (!b) throw new Error('nothing to cut there');
    const bw = b[2] - b[0], bh = b[3] - b[1], s = Math.min(1, (j.maxWidth || 1400) / bw);
    const out = createCanvas(Math.round(bw * s), Math.round(bh * s)), g = out.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(img, b[0], b[1], bw, bh, 0, 0, out.width, out.height);
    fs.writeFileSync(j.out, out.toBuffer('image/png'));
    files.push({ out: j.out, w: out.width, h: out.height, box: [b[0] / w, b[1] / h, b[2] / w, b[3] / h].map((v) => +v.toFixed(4)) });
  } catch (e) { files.push({ out: j.out, error: e.message }); }
}
process.stdout.write(JSON.stringify({ files }) + '\n');
