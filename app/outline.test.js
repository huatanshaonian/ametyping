'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rectsOfMask, growMask, createOutline, OUTLINE } = require('./outline');

const maskOf = (rows) => ({ mask: Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0))), cols: rows[0].length, rows: rows.length });
const area = (rects) => rects.reduce((n, r) => n + r[2] * r[3], 0);

test('a mask as rectangles: runs joined downwards, every cell covered once', () => {
  const m = maskOf(['.##..', '.##..', '.###.', '.....', '#...#']);
  const r = rectsOfMask(m.mask, m.cols, m.rows);
  assert.deepEqual(r, [[1, 0, 2, 2], [1, 2, 3, 1], [0, 4, 1, 1], [4, 4, 1, 1]]);
  assert.equal(area(r), 9);
  assert.deepEqual(rectsOfMask(new Uint8Array(6), 3, 2), []);
});
test('grown by a margin, kept inside the grid', () => {
  const m = maskOf(['.....', '.....', '..#..', '.....', '.....']);
  assert.deepEqual(rectsOfMask(growMask(m.mask, 5, 5, 1), 5, 5), [[1, 1, 3, 3]]);
  const c = maskOf(['#....', '.....', '.....']);
  assert.deepEqual(rectsOfMask(growMask(c.mask, 5, 3, 2), 5, 3), [[0, 0, 3, 3]]);
});
test('read off a canvas: in css px, loose, and a cell that emptied stays for a few refreshes', () => {
  // a stand-in for the scaled-down canvas: `drawn` is what the pet's canvas shows, one value per cell
  let drawn = null;
  const small = { getContext: () => ({ clearRect() {}, drawImage() {}, getImageData: (x, y, w, h) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? drawn[(i - 3) / 4] : 0)) }) }) };
  const read = createOutline({}, { createElement: () => small });
  const k = OUTLINE.cell, W = 10 * k, H = 10 * k;
  drawn = new Uint8Array(100);
  assert.deepEqual(read(W, H), []);                                   // nothing drawn yet: no shape (the whole window)
  drawn[55] = 255; drawn[99] = 3;                                     // one cell; a faint one that does not count
  const g = OUTLINE.grow;
  assert.deepEqual(read(W, H), [[(5 - g) * k, (5 - g) * k, (2 * g + 1) * k, (2 * g + 1) * k]]);
  drawn[55] = 0;
  for (let i = 0; i < OUTLINE.keep - 1; i++) assert.equal(read(W, H).length, 1, 'still there after ' + (i + 1));
  assert.deepEqual(read(W, H), []);
});
