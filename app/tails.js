// Twin tails with a bone chain: a straight hanging tail texture is skinned onto a verlet chain
// (TAIL_N segments) and drawn as a textured triangle strip, so the whole tail bends and whips
// instead of rotating as one stiff piece. The root follows the hair tie through the body and head
// transforms. Shares the global scope with renderer.js (body, head, TIE, NECK, HIP, ...).
'use strict';

const TAIL_N = 10;
// rest shape, degrees away from straight down (positive = outward); fluffy bulge, then a curl at the tips
const TAIL_REST = [40, 33, 25, 17, 11, 6, 4, 6, 14, 24];
// how strongly each joint is pulled back to its rest shape (root stiff, tip loose)
const TAIL_STIFF = [0.55, 0.42, 0.32, 0.24, 0.18, 0.14, 0.11, 0.09, 0.08, 0.07];
const TAIL_GRAVITY = 900;          // scene px / s^2
const TAIL_DAMP = 0.9;             // velocity kept per 1/60 s

const tailSim = { L: null, R: null };
const tailTex = {};                // side -> canvas (mirrored for R)

function loadTailTextures(done) {
  const im = new Image();
  im.onload = () => {
    tailTex.L = im;
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.translate(im.width, 0); g.scale(-1, 1); g.drawImage(im, 0, 0);
    tailTex.R = c;
    done && done();
  };
  im.src = 'assets/rig/tail.png';
}

// where the hair tie of `side` is on screen right now (body + head transforms, like applyBody/applyHead)
function tieWorld(side) {
  const m = new DOMMatrix();
  m.translateSelf(body.x, body.dip);
  m.translateSelf(HIP.x, HIP.y); m.rotateSelf(body.rot * 180 / Math.PI); m.scaleSelf(1, breath()); m.translateSelf(-HIP.x, -HIP.y);
  m.translateSelf(0, head.dy - Math.sin(breathPhase) * 3.5 * idleAmt());
  m.translateSelf(NECK.x, NECK.y); m.rotateSelf(head.rot * 180 / Math.PI); m.translateSelf(-NECK.x, -NECK.y);
  const o = RIG.tail.rootOffset;                                   // root sits a little below / outside the tie
  const p = m.transformPoint(new DOMPoint(TIE[side].x + (side === 'L' ? -o[0] : o[0]), TIE[side].y + o[1]));
  return { x: p.x, y: p.y, rot: body.rot + head.rot };
}

function tailSegLen() { return RIG.tail.lengthScene / TAIL_N; }

// direction of rest segment i: rotate "straight down" (0,1) clockwise by theta; outward = away from the face
function restDir(side, rot, i) {
  const sgn = side === 'L' ? -1 : 1;
  const theta = rot - sgn * TAIL_REST[i] * Math.PI / 180;
  return [-Math.sin(theta), Math.cos(theta)];
}

function initTail(side) {
  const r = tieWorld(side), L = tailSegLen();
  const pts = [{ x: r.x, y: r.y, px: r.x, py: r.y }];
  for (let i = 0; i < TAIL_N; i++) {
    const [dx, dy] = restDir(side, r.rot, i), q = pts[i];
    pts.push({ x: q.x + dx * L, y: q.y + dy * L, px: q.x + dx * L, py: q.y + dy * L });
  }
  tailSim[side] = pts;
}

function stepTail(side, dt) {
  if (!tailSim[side]) initTail(side);
  const pts = tailSim[side], root = tieWorld(side), L = tailSegLen(), sgn = side === 'L' ? -1 : 1;
  const k = dt * 60, damp = Math.pow(TAIL_DAMP, k);
  const breeze = Math.sin(performance.now() / 1300 + (side === 'L' ? 0 : 2)) * 14;
  pts[0].x = root.x; pts[0].y = root.y; pts[0].px = root.x; pts[0].py = root.y;
  for (let i = 1; i <= TAIL_N; i++) {                      // verlet integration
    const p = pts[i];
    const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
    p.px = p.x; p.py = p.y;
    p.x += vx + sgn * breeze * (i / TAIL_N) * dt * dt * 60;
    p.y += vy + TAIL_GRAVITY * dt * dt;
  }
  for (let it = 0; it < 3; it++) {
    for (let i = 1; i <= TAIL_N; i++) {                    // pull toward the rest shape (relative to the head)
      const [dx, dy] = restDir(side, root.rot, i - 1);
      const tx = pts[i - 1].x + dx * L, ty = pts[i - 1].y + dy * L;
      const st = Math.min(1, TAIL_STIFF[i - 1] * k / 3 * 3) / 3;
      pts[i].x += (tx - pts[i].x) * st; pts[i].y += (ty - pts[i].y) * st;
    }
    for (let i = 1; i <= TAIL_N; i++) {                    // keep segment lengths (root pinned)
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - L) / d;
      b.x -= dx * f; b.y -= dy * f;
    }
  }
}

// affine-map the source triangle (s) onto the destination triangle (d) and draw that part of `tex`
function texTri(tex, s0, s1, s2, d0, d1, d2) {
  // grow the destination triangle by ~0.6 px around its centroid to hide hairline seams
  const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
  const grow = (p) => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * 0.6, p[1] + dy / l * 0.6]; };
  const e0 = grow(d0), e1 = grow(d1), e2 = grow(d2);
  const [u0, v0] = s0, [u1, v1] = s1, [u2, v2] = s2;
  const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(den) < 1e-6) return;
  const a = ((d1[0] - d0[0]) * (v2 - v0) - (d2[0] - d0[0]) * (v1 - v0)) / den;
  const b = ((d1[1] - d0[1]) * (v2 - v0) - (d2[1] - d0[1]) * (v1 - v0)) / den;
  const c = ((d2[0] - d0[0]) * (u1 - u0) - (d1[0] - d0[0]) * (u2 - u0)) / den;
  const d = ((d2[1] - d0[1]) * (u1 - u0) - (d1[1] - d0[1]) * (u2 - u0)) / den;
  const e = d0[0] - a * u0 - c * v0, f = d0[1] - b * u0 - d * v0;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(e0[0], e0[1]); ctx.lineTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]); ctx.closePath(); ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(tex, 0, 0);
  ctx.restore();
}

function drawTailMesh(side) {
  const pts = tailSim[side], tex = tailTex[side];
  if (!pts || !tex) return;
  const T = RIG.tail, sc = T.lengthScene / T.h;            // texture px -> scene px
  const halfW = (T.w / 2) * sc;
  const axis = side === 'L' ? T.axisX : T.w - T.axisX;    // texture x of the tail's centre line
  // per joint: centre + normal (averaged tangent)
  const rows = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(TAIL_N, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    return { x: p.x, y: p.y, nx: -ty, ny: tx };
  });
  const cols = [-1, 0, 1];                                 // left edge, centre, right edge
  for (let i = 0; i < TAIL_N; i++) {
    const v0 = T.top + (T.h * i) / TAIL_N, v1 = T.top + (T.h * (i + 1)) / TAIL_N;
    for (let c = 0; c < 2; c++) {
      const ca = cols[c], cb = cols[c + 1];
      const ua = axis + ca * (T.w / 2), ub = axis + cb * (T.w / 2);
      const P = (row, cc) => [rows[row].x - rows[row].nx * cc * halfW, rows[row].y - rows[row].ny * cc * halfW];
      const p00 = P(i, ca), p01 = P(i, cb), p10 = P(i + 1, ca), p11 = P(i + 1, cb);
      texTri(tex, [ua, v0], [ub, v0], [ua, v1], p00, p01, p10);
      texTri(tex, [ub, v0], [ub, v1], [ua, v1], p01, p11, p10);
    }
  }
}
