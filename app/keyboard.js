// Keyboard rendering: the user's GravaStar 75% (NGO keycap set, translucent white-pink shell, blue RGB).
// Slightly realistic: sculpted keycaps (smaller top face, visible front wall, drop shadow), printed legends,
// mild perspective (rows nearer the viewer are wider), shell with visible thickness and light windows,
// blue light bleeding between the caps. Shares the global scope with renderer.js.
'use strict';

const KB_ART_W = 1448, KB_ART_H = 1040;
const KB = { u: 38, v: 26, padX: 15, padY: 11, faceH: 16, lip: 9 };   // taller caps: mechanical, not membrane
KB.w = 16 * KB.u + 2 * KB.padX;
KB.h = 6 * KB.v + 2 * KB.padY + 2;
KB.x = Math.round((KB_ART_W - KB.w) / 2);
KB.y = 790;
KB.cx = KB.x + KB.w / 2;
const KB_FRONT = 36;                         // visible front: case lip + RGB light band + sculpted base tray
const CLIP_Y = KB.y + 16;                    // character is clipped here (hidden behind the keyboard)

const KCOL = {
  shell: ['#fbf3f6', '#ecdbe3'], shellEdge: '#8d7482', plate: '#eadbe3', ink: '#6d5a67',
  glow: 'rgba(80,150,255,', legend: { w: '#d04a64', p: '#c63d5c', m: '#2f7f86', c: '#2d6f8c', r: '#fff4f6', d: '#ffd9df', g: '#9fe8c9', k: '#b58ea0' },
  w: ['#ffffff', '#f3edf1', '#d5c8cf'], p: ['#fde3eb', '#f8c9d8', '#dc9db2'], m: ['#e2f8f9', '#c3ecee', '#8fcbd0'],
  c: ['rgba(215,245,252,.92)', 'rgba(170,228,242,.9)', '#7cbfd4'], r: ['#f28b97', '#e66b79', '#b84756'],
  d: ['#c95f69', '#ad4450', '#7a2c35'], g: ['#3f7061', '#2c5549', '#1a362f'], k: ['#fbf6f8', '#ede1e7', '#cdb9c4'],
  hot: ['#d8f4ff', '#8fdcff', '#3f9fd8'],
};
const LEGEND = {
  Esc: 'Esc', Bksp: '⌫', Tab: '⇥', Caps: 'Caps', Enter: '↵', Shift: '⇧', RShift: '⇧', Ctrl: 'Ctrl', Win: '⊞',
  Alt: 'Alt', RAlt: 'Alt', Fn: 'Fn', Space: '', Up: '↑', Down: '↓', Left: '←', Right: '→', Del: 'Del',
  PgUp: 'PgU', PgDn: 'PgD', End: 'End', Knob: '',
};

// facing 'her': her keyboard seen from across the desk (rotated 180deg, legends upside down for us).
// facing 'you': laid out as the user sees their own.
let facing = 'her';
let showLegends = true;
const keys = [];
const byCode = new Map();
let splitX = 0;
let kbShake = 0;
const knob = { phase: 0, vel: 0 };
// ripple lighting: every press starts a ring of pale-pink light that spreads from that key under the caps
const ripples = [];                           // { x, y, t0, big }
const RIPPLE = { speed: 300, width: 24, life: 0.9, color: '255,120,190' };
function addRipple(x, y, big) { ripples.push({ x, y, t0: performance.now(), big }); if (ripples.length > 24) ripples.shift(); }
function rippleLight(k, t) {                  // 0..1 light on key k from all live ripples
  let v = 0;
  for (const r of ripples) {
    const age = (t - r.t0) / 1000;
    const life = RIPPLE.life * (r.big ? 1.4 : 1);
    if (age > life) continue;
    const d = Math.hypot(k.cx - r.x, (k.cy - r.y) * 1.6);   // rows are close together: stretch vertically
    const radius = age * RIPPLE.speed * (r.big ? 1.3 : 1);
    const ring = Math.exp(-(((d - radius) / RIPPLE.width) ** 2));
    const fade = (1 - age / life) ** 1.4;
    v += ring * fade * (d < 8 && age < 0.18 ? 1.4 : 1);
  }
  return Math.min(1, v);
}
// light glowing up around a cap (between the caps) + a soft tint on the cap itself
function drawCapGlow(ctx, k, v) {
  const a = v * 0.32;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const gl = ctx.createRadialGradient(k.cx, k.y + k.h * 0.75, 1, k.cx, k.y + k.h * 0.6, k.w * 0.75 + 10);
  gl.addColorStop(0, `rgba(${RIPPLE.color},${a})`); gl.addColorStop(1, `rgba(${RIPPLE.color},0)`);
  ctx.fillStyle = gl; ctx.fillRect(k.x - 12, k.y - 10, k.w + 24, k.h + 20);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(255,150,205,${v * 0.3})`;
  ctx.beginPath(); ctx.roundRect(k.x + 2, k.y + 1, k.w - 4, KB.faceH - 1, 5); ctx.fill();
  ctx.restore();
}

// mild perspective: row r (0 = farthest from the viewer) is scaled horizontally around the centre
const rowScale = (yy) => 0.93 + 0.07 * Math.max(0, Math.min(1, (yy - KB.y) / KB.h));
const persp = (x, y) => KB.cx + (x - KB.cx) * rowScale(y);

function buildKeys() {
  const held = new Set(keys.filter((k) => k.down).map((k) => k.code));
  keys.length = 0; byCode.clear();
  LAYOUT75.forEach((row, r) => {
    let cu = 0;
    for (const [label, wu, code, kind, dyu = 0] of row) {
      if (label == null) { cu += wu; continue; }
      let x = KB.x + KB.padX + cu * KB.u + 2.5;
      const w0 = wu * KB.u - 5;
      let rr = r, dy = dyu * KB.v;
      if (facing === 'her') { x = KB.x + KB.w - (x - KB.x) - w0; rr = 5 - r; dy = -dy; }
      const y = KB.y + KB.padY + rr * KB.v + dy;
      const s = rowScale(y + KB.faceH / 2);
      const px = persp(x, y + KB.faceH / 2), w = w0 * s;
      const k = { label, code, kind, x: px, y, w, h: KB.faceH + KB.lip, cx: px + w / 2, cy: y + KB.faceH / 2,
        down: held.has(code), hotUntil: 0 };
      keys.push(k);
      if (code != null) byCode.set(code, k);
      cu += wu;
    }
  });
  splitX = (byCode.get(34).cx + byCode.get(35).cx) / 2;   // between G and H
  kbCache = null;
}

// ---------- shell ----------
function shellPath(g, inset, extraBottom) {
  // trapezoid with rounded corners (narrower at the far edge)
  const top = KB.y + inset, bot = KB.y + KB.h + extraBottom - inset;
  const tl = persp(KB.x + inset, top), tr = persp(KB.x + KB.w - inset, top);
  const bl = persp(KB.x + inset, bot), br = persp(KB.x + KB.w - inset, bot);
  const r = 16 - inset * 0.5;
  g.beginPath();
  g.moveTo(tl + r, top); g.lineTo(tr - r, top); g.quadraticCurveTo(tr, top, tr, top + r);
  g.lineTo(br, bot - r); g.quadraticCurveTo(br, bot, br - r, bot);
  g.lineTo(bl + r, bot); g.quadraticCurveTo(bl, bot, bl, bot - r);
  g.lineTo(tl, top + r); g.quadraticCurveTo(tl, top, tl + r, top);
  g.closePath();
}

// base tray: wider than the case, sculpted front edge (gentle centre bulge, raised corners with vents)
function trayPath(g) {
  const top = KB.y + 24, bot = KB.y + KB.h + KB_FRONT;
  const L = persp(KB.x - 6, bot), R = persp(KB.x + KB.w + 6, bot);
  const tl = persp(KB.x - 4, top), tr = persp(KB.x + KB.w + 4, top);
  const w = R - L, r = 18;
  g.beginPath();
  g.moveTo(tl + r, top); g.lineTo(tr - r, top); g.quadraticCurveTo(tr, top, tr, top + r);
  g.lineTo(R, bot - 16);
  g.bezierCurveTo(R, bot - 4, R - w * 0.06, bot - 9, R - w * 0.12, bot - 5);     // right corner lifts up
  g.bezierCurveTo(R - w * 0.3, bot + 2, L + w * 0.3, bot + 2, L + w * 0.12, bot - 5); // centre bulges down
  g.bezierCurveTo(L + w * 0.06, bot - 9, L, bot - 4, L, bot - 16);
  g.lineTo(tl, top + r); g.quadraticCurveTo(tl, top, tl + r, top);
  g.closePath();
}

function drawShellStatic(g) {
  const caseBot = KB.y + KB.h + 12;                         // bottom of the top case's front lip
  // 1) sculpted base tray
  trayPath(g); g.fillStyle = KCOL.shellEdge; g.fill();
  g.save(); trayPath(g); g.clip();
  const tg0 = g.createLinearGradient(0, caseBot, 0, KB.y + KB.h + KB_FRONT);
  tg0.addColorStop(0, '#f6ebf0'); tg0.addColorStop(0.55, '#e7d3dd'); tg0.addColorStop(1, '#c9aebd');
  g.fillStyle = tg0; g.fillRect(KB.x - 40, KB.y, KB.w + 80, KB.h + KB_FRONT + 10);
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2;                   // chamfer highlight
  g.beginPath(); g.moveTo(persp(KB.x + 20, caseBot + 14), caseBot + 14); g.lineTo(persp(KB.x + KB.w - 20, caseBot + 14), caseBot + 14); g.stroke();
  g.restore();
  trayPath(g); g.strokeStyle = KCOL.shellEdge; g.lineWidth = 2.5; g.stroke();
  for (const side of [0, 1]) {                                                // corner vents
    const cx = persp(side ? KB.x + KB.w - 14 : KB.x + 14, KB.y + KB.h + KB_FRONT - 12);
    const cy = KB.y + KB.h + KB_FRONT - 13;
    g.beginPath(); g.moveTo(cx - 7, cy - 5); g.lineTo(cx + 7, cy - 5); g.lineTo(cx + (side ? 4 : -4), cy + 5);
    g.closePath(); g.fillStyle = '#4c3d47'; g.fill();
  }
  for (const f of [0.16, 0.84]) {                                              // rubber feet
    const fx = persp(KB.x + KB.w * f, KB.y + KB.h + KB_FRONT);
    g.fillStyle = '#5a4a55'; g.beginPath(); g.roundRect(fx - 22, KB.y + KB.h + KB_FRONT - 3, 44, 6, 3); g.fill();
  }
  // 2) frosted acrylic light band between case and tray
  const bandY = caseBot - 2, bandH = 11;
  const bx0 = persp(KB.x + 4, bandY), bx1 = persp(KB.x + KB.w - 4, bandY);
  g.save(); g.beginPath(); g.roundRect(bx0, bandY, bx1 - bx0, bandH, 5); g.clip();
  const lg = g.createLinearGradient(0, bandY, 0, bandY + bandH);
  lg.addColorStop(0, 'rgba(185,225,255,.95)'); lg.addColorStop(0.6, 'rgba(95,160,255,.95)'); lg.addColorStop(1, 'rgba(70,120,230,.95)');
  g.fillStyle = lg; g.fillRect(bx0, bandY, bx1 - bx0, bandH);
  g.fillStyle = 'rgba(255,255,255,.55)';
  for (let i = 0; i < 9; i++) { const x = bx0 + (bx1 - bx0) * (0.06 + i * 0.11); g.fillRect(x, bandY + 2, 26, 2); }
  g.restore();
  g.strokeStyle = 'rgba(90,70,90,.45)'; g.lineWidth = 1.5;
  g.beginPath(); g.roundRect(bx0, bandY, bx1 - bx0, bandH, 5); g.stroke();
  // 3) top case: front lip (thickness) + top surface + recessed plate
  shellPath(g, 0, 12); g.fillStyle = KCOL.shellEdge; g.fill();
  shellPath(g, 2, 11);
  const fg = g.createLinearGradient(0, KB.y + KB.h - 10, 0, caseBot);
  fg.addColorStop(0, KCOL.shell[1]); fg.addColorStop(1, '#dcc6d2');
  g.fillStyle = fg; g.fill();
  shellPath(g, 0, 0); g.fillStyle = KCOL.shellEdge; g.fill();
  shellPath(g, 2, 0);
  const tg = g.createLinearGradient(0, KB.y, 0, KB.y + KB.h);
  tg.addColorStop(0, KCOL.shell[0]); tg.addColorStop(1, KCOL.shell[1]);
  g.fillStyle = tg; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2;                   // top chamfer highlight
  g.beginPath(); g.moveTo(persp(KB.x + 18, KB.y + 3), KB.y + 3); g.lineTo(persp(KB.x + KB.w - 18, KB.y + 3), KB.y + 3); g.stroke();
  shellPath(g, 8, -4); g.fillStyle = KCOL.plate; g.fill();
  g.save(); shellPath(g, 8, -4); g.clip();
  g.fillStyle = 'rgba(120,90,110,.25)'; g.fillRect(KB.x, KB.y + 4, KB.w, 5);   // inner shadow at the far lip
  g.restore();
}

// blue light bleeding up between the caps (kept on its own layer so it can breathe)
function drawGlowStatic(g) {
  g.save(); shellPath(g, 8, -4); g.clip();
  g.filter = 'blur(6px)';
  for (const k of keys) {
    g.fillStyle = KCOL.glow + '.55)';
    g.beginPath(); g.roundRect(k.x - 1, k.y + k.h - 5, k.w + 2, 8, 4); g.fill();
  }
  g.filter = 'none';
  g.restore();
}

function legendFont(label) {
  const txt = LEGEND[label] ?? label;
  const size = txt.length >= 3 ? 7.5 : txt.length === 2 ? 9 : 11;
  return { txt, font: `bold ${size}px "Segoe UI", "Microsoft YaHei", sans-serif` };
}

function drawCap(g, k, hot, t) {
  if (k.kind === 'k') return drawKnob(g, k, hot);
  const sink = hot ? 3 : 0;
  const [topHi, top, side] = hot ? KCOL.hot : KCOL[k.kind];
  const x = k.x, y = k.y + sink, w = k.w, h = k.h - sink;
  if (!hot) {                                             // drop shadow on the plate
    g.fillStyle = 'rgba(70,40,60,.22)';
    g.beginPath(); g.roundRect(x - 1, y + 3, w + 2, h, 6); g.fill();
  }
  // skirt / front wall
  g.beginPath(); g.roundRect(x, y, w, h, 5); g.fillStyle = KCOL.ink; g.fill();
  const sg = g.createLinearGradient(0, y, 0, y + h);
  sg.addColorStop(0, side); sg.addColorStop(1, shade(side, -18));
  g.beginPath(); g.roundRect(x + 1, y + 1, w - 2, h - 2, 4.5); g.fillStyle = sg; g.fill();
  // top face: inset (sculpted cap), slightly dished gradient, highlight line
  const fx = x + 3, fy = y + 1.5, fw = w - 6, fh = KB.faceH - 3;
  const tg = g.createLinearGradient(0, fy, 0, fy + fh);
  tg.addColorStop(0, topHi); tg.addColorStop(1, top);
  g.beginPath(); g.roundRect(fx, fy, fw, fh, 4); g.fillStyle = tg; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(fx + 3, fy + 1.2); g.lineTo(fx + fw - 3, fy + 1.2); g.stroke();
  if (k.kind === 'c' || hot) {                            // translucent caps light up from inside
    const ig = g.createRadialGradient(k.cx, fy + fh, 1, k.cx, fy + fh, fw * 0.6);
    ig.addColorStop(0, hot ? 'rgba(120,200,255,.8)' : 'rgba(110,180,255,.45)'); ig.addColorStop(1, 'rgba(110,180,255,0)');
    g.fillStyle = ig; g.beginPath(); g.roundRect(fx, fy, fw, fh, 4); g.fill();
  }
  if (k.label === 'Space') {                              // NGO spacebar: pale art band
    g.fillStyle = 'rgba(255,240,244,.85)';
    g.beginPath(); g.roundRect(fx + fw * 0.08, fy + fh * 0.3, fw * 0.5, fh * 0.35, 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.fillRect(fx + fw * 0.66, fy + fh * 0.35, fw * 0.26, 1.5); g.fillRect(fx + fw * 0.66, fy + fh * 0.6, fw * 0.2, 1.5);
  }
  const { txt, font } = legendFont(k.label);
  if (txt && showLegends) {
    g.save();
    g.translate(k.cx, fy + fh / 2 + 0.5);
    if (facing === 'her') g.rotate(Math.PI);             // printed for her, so upside down from our side
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = hot ? '#1f5f8a' : KCOL.legend[k.kind];
    g.fillText(txt, 0, 0);
    g.restore();
  }
}

function drawKnob(g, k, hot) {                            // pearl roller; ridges scroll when it turns
  const x = k.x, y = k.y + (hot ? 2 : 0), w = k.w, h = k.h - (hot ? 2 : 0);
  g.fillStyle = 'rgba(70,40,60,.22)'; g.beginPath(); g.roundRect(x - 1, y + 3, w + 2, h, h / 2); g.fill();
  g.beginPath(); g.roundRect(x, y, w, h, h / 2); g.fillStyle = KCOL.ink; g.fill();
  const cg = g.createLinearGradient(0, y, 0, y + h);
  cg.addColorStop(0, '#ffffff'); cg.addColorStop(0.45, '#f1e6ec'); cg.addColorStop(1, '#bca6b2');
  g.beginPath(); g.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, (h - 3) / 2); g.fillStyle = cg; g.fill();
  g.save(); g.beginPath(); g.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, (h - 3) / 2); g.clip();
  g.strokeStyle = 'rgba(120,90,110,.4)'; g.lineWidth = 1.6;
  const step = 5, off = ((knob.phase % step) + step) % step;
  for (let gx = x - step + off; gx < x + w + step; gx += step) {
    g.beginPath(); g.moveTo(gx, y + 3); g.lineTo(gx, y + h - 3); g.stroke();
  }
  g.restore();
}

function shade(hex, amt) {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// ---------- caching: shell + idle caps are drawn once; pressed caps are redrawn per frame ----------
let kbCache = null, glowCache = null;
function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = Math.round(KB_ART_W * KB_RES); c.height = Math.round(KB_ART_H * KB_RES);
  const g = c.getContext('2d'); g.scale(KB_RES, KB_RES);
  return [c, g];
}
let KB_RES = 1;
function ensureCache(res) {
  if (kbCache && KB_RES === res) return;
  KB_RES = res;
  const [c, g] = makeCanvas(); drawShellStatic(g);
  const [gc, gg] = makeCanvas(); drawGlowStatic(gg);
  for (const k of [...keys].sort((a, b) => a.y - b.y)) drawCap(g, k, false, 0);
  kbCache = { base: c, glow: gc };
  // the plate under each cap, used to "erase" a cap before redrawing it pressed
  const [pc, pg] = makeCanvas(); drawShellStatic(pg); kbCache.plate = pc;
}

// Underglow: RGB light spilling out from under the keyboard onto the "desk". A blurred mask is rendered
// once; every frame it is tinted with a slowly flowing blue -> violet -> pink gradient and breathes.
const GLOW = { padX: 150, above: 30, below: 70, res: 0.5, mask: null, tint: null };
function glowMask() {
  if (GLOW.mask) return GLOW.mask;
  const w = KB.w + GLOW.padX * 2, h = GLOW.above + GLOW.below;
  const c = document.createElement('canvas'); c.width = Math.round(w * GLOW.res); c.height = Math.round(h * GLOW.res);
  const g = c.getContext('2d'); g.scale(GLOW.res, GLOW.res);
  const cy = GLOW.above;                                        // the keyboard's bottom edge
  g.filter = `blur(${Math.round(12 * GLOW.res)}px)`;            // blur radius is in canvas pixels
  g.fillStyle = 'rgba(255,255,255,.95)';                        // bright core right under the base
  g.beginPath(); g.ellipse(w / 2, cy + 4, KB.w / 2 - 10, 12, 0, 0, Math.PI * 2); g.fill();
  g.filter = `blur(${Math.round(26 * GLOW.res)}px)`;
  g.fillStyle = 'rgba(255,255,255,.6)';                         // soft pool spreading on the desk
  g.beginPath(); g.ellipse(w / 2, cy + 12, KB.w / 2 + 40, 26, 0, 0, Math.PI * 2); g.fill();
  GLOW.mask = c;
  GLOW.tint = document.createElement('canvas'); GLOW.tint.width = c.width; GLOW.tint.height = c.height;
  return c;
}
function drawKeyboardShadow(ctx, breath = 0) {
  const mask = glowMask(), tint = GLOW.tint, g = tint.getContext('2d');
  const t = performance.now() / 1000, W = tint.width, H = tint.height;
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, W, H);
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  const grad = g.createLinearGradient(0, 0, W, 0);
  for (let i = 0; i <= 6; i++) {                                // hue wave flowing sideways: blue / violet / pink
    const hue = 262 + 58 * Math.sin(t * 0.6 + i * 0.9);         // 204 (blue) .. 320 (pink)
    grad.addColorStop(i / 6, `hsl(${hue}, 95%, 66%)`);
  }
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const x0 = KB.x - GLOW.padX, y0 = KB.y + KB.h + KB_FRONT - GLOW.above;
  ctx.save();
  ctx.globalAlpha = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(breath));
  ctx.drawImage(tint, x0, y0, KB.w + GLOW.padX * 2, GLOW.above + GLOW.below);
  ctx.restore();
}

// Hand-painted keyboard (codex repaint of our own render, same geometry): painted pixel -> art space
const KB_PAINT = { x0: 384.03, y0: 671.45, s: 0.44273, img: {}, theme: 'ngo' };
const KB_THEMES = { default: 'kb_paint', ngo: 'kb_ngo' };
function loadKbTheme(theme) {
  KB_PAINT.theme = KB_THEMES[theme] ? theme : 'default';
  const stem = KB_THEMES[KB_PAINT.theme];
  for (const f of ['her', 'you']) {
    const im = new Image();
    im.onload = () => { KB_PAINT.img[f] = gradeKb(im); };
    im.onerror = () => { if (stem !== 'kb_paint') loadKbTheme('default'); };   // theme missing: fall back
    im.src = `assets/kb/${stem}_${f}.png`;
  }
}
// colour grade the keyboard art once when it loads: a bit brighter, a bit less saturated (it read greyish)
const KB_GRADE = 'brightness(1.08) saturate(0.88) contrast(1.03)';
function gradeKb(im) {
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const g = c.getContext('2d'); g.filter = KB_GRADE; g.drawImage(im, 0, 0);
  return c;
}
loadKbTheme('ngo');
const toPaint = (x, y) => [(x - KB_PAINT.x0) / KB_PAINT.s, (y - KB_PAINT.y0) / KB_PAINT.s];

// a pressed painted cap: dark socket, the cap's own pixels a bit smaller and lower, blue light from below
function drawPaintedPress(ctx, im, k) {
  const [sx, sy] = toPaint(k.x, k.y), sw = k.w / KB_PAINT.s, sh = k.h / KB_PAINT.s;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(k.x - 1, k.y - 1, k.w + 2, k.h + 2, 6);
  ctx.fillStyle = '#b9a4b2'; ctx.fill();                                     // socket between the caps
  const sc = 0.93, dx = k.w * (1 - sc) / 2, dy = 3;
  ctx.drawImage(im, sx, sy, sw, sh, k.x + dx, k.y + dy, k.w * sc, k.h * sc);
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(k.cx, k.y + k.h, 1, k.cx, k.y + k.h * 0.6, k.w * 0.7);
  g.addColorStop(0, 'rgba(255,160,210,.6)'); g.addColorStop(1, 'rgba(255,160,210,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(k.x + dx, k.y + dy, k.w * sc, k.h * sc, 5); ctx.fill();
  ctx.restore();
}

// Detail over the painted base so it does not read as one glossy slab: a crisp edge on the case lip,
// a darker front wall, fine vertical grooves on the tray, LED beads in the light bar, feet and a shadow line.
function drawBaseDetail(g, breath) {
  const caseTop = KB.y + KB.h, caseBot = caseTop + 12, bot = KB.y + KB.h + KB_FRONT;
  const X = (x, y) => persp(x, y);
  g.save();
  // case lip: slightly darker front wall + crisp ink edges
  g.beginPath(); g.moveTo(X(KB.x + 6, caseTop), caseTop); g.lineTo(X(KB.x + KB.w - 6, caseTop), caseTop);
  g.lineTo(X(KB.x + KB.w - 4, caseBot - 2), caseBot - 2); g.lineTo(X(KB.x + 4, caseBot - 2), caseBot - 2); g.closePath();
  g.fillStyle = 'rgba(120,80,105,.16)'; g.fill();

  // light bar: LED beads, brightness breathing
  const bandY = caseBot + 3, a = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(breath));
  for (let i = 0; i < 38; i++) {
    const x = X(KB.x + 22 + i * (KB.w - 44) / 37, bandY);
    g.fillStyle = `rgba(235,248,255,${a})`; g.fillRect(x - 3, bandY - 1, 6, 3);
  }
  // tray: fine vertical grooves + darker lower half + bottom edge
  g.save(); trayPath(g); g.clip();
  g.fillStyle = 'rgba(110,70,95,.12)'; g.fillRect(KB.x - 20, caseBot + 10, KB.w + 40, bot - caseBot);
  g.strokeStyle = 'rgba(120,85,110,.18)'; g.lineWidth = 1;
  for (let x = KB.x + 10; x < KB.x + KB.w - 10; x += 7) {
    g.beginPath(); g.moveTo(X(x, caseBot + 12), caseBot + 12); g.lineTo(X(x, bot), bot); g.stroke();
  }
  g.restore();

  // rubber feet
  for (const f of [0.14, 0.86]) {
    const fx = X(KB.x + KB.w * f, bot);
    g.fillStyle = '#4a3a45'; g.beginPath(); g.roundRect(fx - 26, bot - 2, 52, 7, 3); g.fill();
  }
  g.restore();
}

function drawKeyboard(ctx, res, breath) {
  const t = performance.now();
  const painted = KB_PAINT.img[facing];
  ctx.save();
  ctx.translate(Math.sin(t / 9) * kbShake * 2.5, kbShake * 2);
  if (painted) {
    ctx.drawImage(painted, KB_PAINT.x0, KB_PAINT.y0, painted.width * KB_PAINT.s, painted.height * KB_PAINT.s);
    drawBaseDetail(ctx, breath);
    for (const k of [...keys].sort((a, b) => a.y - b.y)) {
      const hot = k.down || t < k.hotUntil;
      if (k.kind === 'k' && (hot || Math.abs(knob.vel) > 0.05)) { drawKnob(ctx, k, hot); continue; }
      if (hot) drawPaintedPress(ctx, painted, k);
    }
    if (ripples.length) {
      while (ripples.length && (t - ripples[0].t0) / 1000 > RIPPLE.life * 1.4) ripples.shift();
      for (const k of keys) { const v = rippleLight(k, t); if (v > 0.03) drawCapGlow(ctx, k, v); }
    }
    ctx.restore();
    return;
  }
  // fallback: procedural keyboard (used until the painted art has loaded)
  ensureCache(res);
  ctx.drawImage(kbCache.base, 0, 0, KB_ART_W, KB_ART_H);
  ctx.globalAlpha = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(breath));
  ctx.drawImage(kbCache.glow, 0, 0, KB_ART_W, KB_ART_H);
  ctx.globalAlpha = 1;
  for (const k of keys) {
    const hot = k.down || t < k.hotUntil;
    if (!hot && !(k.kind === 'k' && Math.abs(knob.vel) > 0.05)) continue;
    const pad = 4;
    ctx.save(); ctx.beginPath(); ctx.rect(k.x - pad, k.y - pad, k.w + pad * 2, k.h + pad * 2); ctx.clip();
    ctx.drawImage(kbCache.plate, 0, 0, KB_ART_W, KB_ART_H);
    const near = keys.filter((n) => n === k ||
      (n.x < k.x + k.w + pad && n.x + n.w > k.x - pad && n.y < k.y + k.h + pad && n.y + n.h > k.y - pad));
    for (const n of near.sort((a, b) => a.y - b.y)) drawCap(ctx, n, n === k ? hot : (n.down || t < n.hotUntil), t);
    ctx.restore();
  }
  ctx.restore();
}

