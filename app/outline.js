// Her outline as a handful of rectangles, for the window's shape (main.js, "触屏模式"): Windows then lets a press
// through wherever she is not, before it reaches us -- which a finger needs, since it does not hover first.
// Taken from what is actually drawn: the canvas scaled down to a coarse grid, a cell counted in when anything shows
// there. Loose on purpose -- grown by a margin, and a cell stays in for a moment after it empties -- because what is
// outside the shape is not drawn at all: hands, hearts and bubbles move faster than the shape is refreshed.
// Loaded by index.html before renderer.js (and by the unit test, as a module).
'use strict';

const OUTLINE = { cell: 8, grow: 2, keep: 8, alpha: 6 };       // css px per cell; cells added around; refreshes a cell outlives; alpha that counts

// mask: Uint8Array(cols * rows), non-zero = in -> [[x, y, w, h], ...] in cells: runs per row, equal runs of
// consecutive rows joined into one rectangle
function rectsOfMask(mask, cols, rows) {
  const out = [];
  let open = new Map();                                        // "x0,x1" -> the rectangle still growing downwards
  for (let y = 0; y < rows; y++) {
    const next = new Map();
    for (let x = 0; x < cols; x++) {
      if (!mask[y * cols + x]) continue;
      const x0 = x; while (x + 1 < cols && mask[y * cols + x + 1]) x++;
      const key = x0 + ',' + x, r = open.get(key);
      if (r) { r[3]++; next.set(key, r); } else { const n = [x0, y, x - x0 + 1, 1]; out.push(n); next.set(key, n); }
    }
    open = next;
  }
  return out;
}

// every cell within `by` cells of one that is in
function growMask(mask, cols, rows, by) {
  let cur = mask;
  for (let pass = 0; pass < 2; pass++) {                       // rows, then columns: a square neighbourhood
    const out = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!cur[y * cols + x]) continue;
      for (let d = -by; d <= by; d++) {
        const xx = pass ? x : x + d, yy = pass ? y + d : y;
        if (xx >= 0 && yy >= 0 && xx < cols && yy < rows) out[yy * cols + xx] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

// canvas: the pet's; returns read(cssW, cssH) -> rectangles in css px ([] while nothing is drawn yet)
function createOutline(canvas, doc = document) {
  const small = doc.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let age = null, cols = 0, rows = 0;
  return function read(cssW, cssH) {
    const c = Math.ceil(cssW / OUTLINE.cell), r = Math.ceil(cssH / OUTLINE.cell);
    if (c < 1 || r < 1) return [];
    if (c !== cols || r !== rows) { cols = c; rows = r; small.width = c; small.height = r; age = new Uint8Array(c * r); }
    sctx.clearRect(0, 0, c, r);
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, c, r);
    const px = sctx.getImageData(0, 0, c, r).data, mask = new Uint8Array(c * r);
    let any = false;
    for (let i = 0; i < c * r; i++) {
      if (px[i * 4 + 3] > OUTLINE.alpha) age[i] = OUTLINE.keep; else if (age[i]) age[i]--;
      if (age[i]) { mask[i] = 1; any = true; }
    }
    if (!any) return [];
    const k = OUTLINE.cell;
    return rectsOfMask(growMask(mask, c, r, OUTLINE.grow), c, r).map(([x, y, w, h]) => [x * k, y * k, w * k, h * k]);
  };
}

if (typeof module !== 'undefined') module.exports = { rectsOfMask, growMask, createOutline, OUTLINE };
