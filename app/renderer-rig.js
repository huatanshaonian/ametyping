window.addEventListener('error', (e) => console.error('uncaught: ' + e.message + ' @' + e.lineno));
// Ame typing pet — scene state, floating hands kinematics, body/legs springs, and smooth gaze rig.
// Scene space is 1448x1000; character rig lives in 1086x1448 space (assets/rig/rig.json).
'use strict';

const VX = 190, ART_W = 1060;
let ART_H = 1190, legs = true;
const DESK_Y = 803;
const CS = 0.851, OX = 262, OY = -14;
let HS = 0.95;
const BODY_MAX_X = 60;
const HOVER_Z = 16;
const INK = '#1c1522';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { willReadFrequently: false });
let scale = 0.36, debug = false;
let kbOnly = false;
let RIG, NECK, HIP, TIE;
const toScene = ([x, y]) => ({ x: x * CS + OX, y: y * CS + OY });

const SLAM_KEYS = new Set(['Space', 'Enter', 'Bksp']);
const MODS = new Set(['Shift', 'RShift', 'Ctrl', 'RCtrl', 'Alt', 'RAlt', 'Win', 'Fn']);

// ---------- assets ----------
const img = {};
const loadImg = (name, src) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => { img[name] = i; res(); };
  i.onerror = rej;
  i.src = src;
});

// ---------- core math & state ----------
const now = () => performance.now();
const ease = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const smooth = (p) => p * p * (3 - 2 * p);
const easeIO = (x) => x * x * (3 - 2 * x);
const roundRect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

const mkHand = () => ({
  gx: 0, gy: 0, z: HOVER_Z, zv: 0, zStart: HOVER_Z, state: 'hover', from: null, to: null, t0: 0, dur: 0, arc: 0,
  key: null, strikeT: -1e9, lastAct: -1e9, slam: false, sx: 1, sy: 1, jitter: 0, homing: false,
  push: 0, lift: 0, spread: 0,
});
const hands = { L: mkHand(), R: mkHand() };
let topHand = 'R';
const body = { x: 0, rot: 0, vx: 0, dip: 0, dipV: 0 };
const head = { rot: 0, dy: 0, nodUntil: 0, vrot: 0 };
const tails = { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } };
const fhair = { x: 0, v: 0 };
const mouse = { x: 724, y: 300, seen: false };
const fx = [];
const lower = {
  wigT: -1e9, kickT: -1e9,
  L: { a: 0, v: 0, q: 0, qv: 0, w: 12, z: 0.45, wq: 15, zq: 0.45 },
  R: { a: 0, v: 0, q: 0, qv: 0, w: 10.5, z: 0.5, wq: 13, zq: 0.5 },
};
const pat = { on: false, last: 0, dir: 0, px: null, revs: [], heartAt: 0, hearts: [] };
const pressTimes = [];
const carry = { vx: 0, vy: 0, t: -1e9 };
let lastKey = '', breathPhase = 0;

function kpm() {
  const t = now();
  while (pressTimes.length && t - pressTimes[0] > 10000) pressTimes.shift();
  return pressTimes.length * 6;
}
const speedFactor = () => { const k = kpm(); return k > 250 ? 0.65 : k > 120 ? 0.82 : 1; };

function restPoint(s) {
  const a = byCode.get(REST_KEYS.L), b = byCode.get(REST_KEYS.R);
  const k = (a.cx < b.cx) === (s === 'L') ? a : b;
  return { x: k.cx, y: k.cy };
}

const holdingMod = (h) => h.state === 'strike' && h.key && h.key.down && MODS.has(h.key.label);
const heldModOf = (h) => (h.chordMod && h.chordMod.down ? h.chordMod : holdingMod(h) ? h.key : null);
const sameHalf = (a, b) => (a.cx < splitX) === (b.cx < splitX);

function land(h, k, t) {
  k.hotUntil = t + 120;
  addRipple(h.to ? h.to.x : k.cx, k.cy, h.slam);
  if (h.slam) kbShake = 1;
  body.dipV += h.slam ? 55 : 28;
}

function sendHand(h, to, key, t, homing = false) {
  if (h.state === 'travel' && h.key && !h.homing) land(h, h.key, t);
  const dist = Math.hypot(to.x - h.gx, to.y - h.gy);
  const sf = homing ? 1 : speedFactor();
  h.from = { x: h.gx, y: h.gy }; h.to = to; h.key = key; h.homing = homing;
  h.t0 = t;
  h.dur = homing ? Math.min(260, 160 + dist * 0.4) : Math.max(45, Math.min(110, 40 + dist * 0.35)) * sf;
  h.arc = homing ? 8 : Math.min(34, 10 + dist * 0.12) * (kpm() > 250 ? 0.6 : 1);
  h.zStart = h.z;
  h.state = 'travel';
}

const busy = (h, t) => (h.state === 'travel' && !h.homing) || h.state === 'strike' || t - h.lastAct < 70;
function pickHand(k) {
  const L = hands.L, R = hands.R;
  let side = k.cx < splitX ? 'L' : 'R';
  const shared = Math.abs(k.cx - splitX) < KB.u * 1.6 || k.label === 'Space';
  if (shared) {
    const d = { L: Math.hypot(L.gx - k.cx, L.gy - k.cy), R: Math.hypot(R.gx - k.cx, R.gy - k.cy) };
    const other = side === 'L' ? 'R' : 'L';
    if (d[other] < KB.u * 1.2 && d[side] > KB.u * 2) side = other;
    else if (k.label === 'Space') side = d.L <= d.R ? 'L' : 'R';
  }
  if (side === 'L' && k.cx > R.gx - 20 && R.state !== 'strike') side = 'R';
  if (side === 'R' && k.cx < L.gx + 20 && L.state !== 'strike') side = 'L';
  return side;
}

function wave(side = 'L', ms = 1600) {
  const h = hands[side];
  if (h.state === 'strike' || h.state === 'travel') return;
  Object.assign(h, { state: 'wave', waveT: now(), waveUntil: now() + ms, z: HOVER_Z, sx: 1, sy: 1 });
}

function fingerFor(k) {
  const farY = KB.y + KB.padY + KB.v * 3.5;
  if (k.cy > farY) return 'reach';
  const d = Math.abs(k.cx - splitX) / KB.u;
  return d < 2.2 ? 'press' : d < 3.3 ? 'middle' : d < 4.4 ? 'ring' : 'pinky';
}

function onKey({ code, down }) {
  kFormOnKey(code, down);
  if (down && code in KNOB_DIR) knob.vel += KNOB_DIR[code] * 14;
  code = KEY_ALIASES[code] ?? code;
  const k = byCode.get(code);
  if (!k) return;
  if (!down) { k.down = false; return; }
  const t = now();
  if (k.down) {
    for (const h of Object.values(hands)) if (h.key === k) { h.jitter = 1; k.hotUntil = t + 80; }
    return;
  }
  k.down = true;
  if (act.kind) stopAct(); else act.next = Math.max(act.next, t + (lateNight() ? 12000 : 20000));
  pressTimes.push(t);
  lastKey = k.label;
  moodOnKey(k, t);

  let side = pickHand(k), chord = null;
  for (const sd of ['L', 'R']) {
    const mod = heldModOf(hands[sd]);
    if (mod && mod !== k && sameHalf(mod, k)) { side = sd; chord = mod; }
  }
  const h = hands[side];
  h.slam = !chord && SLAM_KEYS.has(k.label);
  h.pressPose = chord ? 'pinky' : fingerFor(k);
  h.chordMod = chord;
  h.lastAct = t;
  topHand = side;
  const edge = KB.u * 0.5;
  let tx = k.w > KB.u * 1.6 ? Math.max(k.x + edge, Math.min(k.x + k.w - edge, h.gx)) : k.cx;
  let ty = k.cy;
  if (chord) { tx = chord.cx + (tx - chord.cx) * 0.62; ty = chord.cy + (k.cy - chord.cy) * 0.62; }
  sendHand(h, { x: tx, y: ty }, k, t);
  if (k.label === 'Enter') head.nodUntil = t + 240;
}

const idleAmt = () => Math.max(0, Math.min(1, (now() - mood.lastKeyT - 800) / 1500));

function updateHand(s, h, t, dt) {
  if (h.state === 'wave') { if (t > h.waveUntil) { h.state = 'hover'; h.lastAct = t; } return; }
  if (h.state === 'travel') {
    const p = Math.min(1, (t - h.t0) / h.dur), e = smooth(p);
    h.gx = h.from.x + (h.to.x - h.from.x) * e;
    h.gy = h.from.y + (h.to.y - h.from.y) * e;
    if (h.homing) {
      h.z = h.zStart + (HOVER_Z - h.zStart) * e + Math.sin(Math.PI * p) * h.arc;
      h.sx = ease(h.sx, 1, 18, dt); h.sy = ease(h.sy, 1, 18, dt);
      if (p >= 1) { h.state = 'hover'; h.key = null; h.homing = false; h.zv = 0; }
    } else {
      h.z = h.zStart * (1 - e) + Math.sin(Math.PI * Math.min(1, p * 1.15)) * h.arc;
      h.sy = 1 + 0.07 * Math.sin(Math.PI * p); h.sx = 1 / h.sy;
      if (p >= 1) { h.state = 'strike'; h.strikeT = t; h.z = 0; h.zv = 0; land(h, h.key, t); }
    }
  } else if (h.state === 'strike') {
    const squash = Math.max(0, 1 - (t - h.strikeT) / 120);
    h.sx = 1 + (h.slam ? 0.14 : 0.09) * squash; h.sy = 1 - (h.slam ? 0.16 : 0.11) * squash;
    const held = h.key && h.key.down;
    if (t - h.strikeT > 85 && !held) {
      if (h.chordMod && h.chordMod.down) {
        const mod = h.chordMod; h.chordMod = null; h.pressPose = fingerFor(mod); h.slam = false;
        sendHand(h, { x: mod.cx, y: mod.cy }, mod, t);
      } else { h.chordMod = null; h.state = 'recoil'; h.zv = 260; }
    }
  } else {
    const zt = (mood.sleeping ? 3 : HOVER_Z) + Math.sin(breathPhase + (s === 'L' ? 0 : 1)) * (mood.sleeping ? 1.5 : 2.5 + 3 * idleAmt());
    h.zv += (380 * (zt - h.z) - 22 * h.zv) * dt;
    h.z += h.zv * dt;
    h.sx = ease(h.sx, 1, 18, dt); h.sy = ease(h.sy, 1, 18, dt);
    if (h.state === 'recoil' && Math.abs(h.z - zt) < 1.5 && Math.abs(h.zv) < 20) h.state = 'hover';
    if (h.state === 'hover' && t - h.lastAct > 420) {
      const r = restPoint(s);
      if (Math.hypot(r.x - h.gx, r.y - h.gy) > 3) sendHand(h, r, null, t, true);
    }
  }
  h.jitter = ease(h.jitter, 0, 14, dt);
}

function poseOf(h) {
  if (h.state === 'wave') return 'wave';
  if (h.state === 'strike') return h.slam ? 'slam' : h.pressPose || 'press';
  return mood.sleeping ? 'rest' : 'hover';
}
const handPersp = (h) => 0.95 + 0.12 * Math.max(0, Math.min(1, (h.gy - KB.y) / KB.h));

function handCenter(side, ahead = false) {
  const h = hands[side];
  const pose = poseOf(h);
  const m = RIG.float[`${side}_${pose}`];
  const gx = ahead && h.state === 'travel' ? h.to.x : h.gx;
  return gx + h.push + (m.w / 2 - m.tip[0]) * HS;
}

function separateHands(t, dt) {
  const L = hands.L, R = hands.R;
  const minGap = RIG.float.L_hover.w * HS * 0.82;
  const gap = (handCenter('R', true) - R.push) - (handCenter('L', true) - L.push);
  const need = Math.max(0, minGap - gap);
  const yl = !busy(L, t) && busy(R, t) ? true : busy(L, t) && !busy(R, t) ? false : L.lastAct < R.lastAct;
  const canL = L.state !== 'strike', canR = R.state !== 'strike';
  let pl = 0, pr = 0;
  if (need > 0) {
    if (yl && canL) pl = -need; else if (!yl && canR) pr = need;
    else if (canL) pl = -need; else if (canR) pr = need;
  }
  L.push = ease(L.push, pl, 26, dt); R.push = ease(R.push, pr, 26, dt);
  L.lift = ease(L.lift, pl ? 8 : 0, 12, dt); R.lift = ease(R.lift, pr ? 8 : 0, 12, dt);
  const nowGap = handCenter('R') - handCenter('L');
  const close = Math.max(0, Math.min(1, (minGap - nowGap) / 45));
  L.spread = ease(L.spread, close * 0.26, 20, dt); R.spread = ease(R.spread, close * 0.26, 20, dt);
}

// ---------- body, legs, gaze & hair rendering ----------
function breath() {
  const st = act.kind === 'stretch' ? 0.035 * easeIO(actEnv()) : 0;
  return 1 + st + Math.sin(breathPhase) * (0.008 + 0.012 * idleAmt());
}
const actBodyDy = () => (act.kind === 'stretch' ? -42 * easeIO(actEnv()) : 0);
function applyBody() {
  ctx.translate(body.x, body.dip + actBodyDy());
  ctx.translate(HIP.x, HIP.y); ctx.rotate(body.rot); ctx.scale(1, breath()); ctx.translate(-HIP.x, -HIP.y);
}
function actHeadDy() {
  return act.kind === 'stretch' || act.kind === 'yawn' ? -10 * easeIO(actEnv()) : act.kind === 'sip' ? 4 * sipState().lift + 6 * sipBeat() : 0;
}

const LEG_FLOOR = () => OY + 1398 * CS;
const LEG_GAP = () => OX + 543 * CS;
function stepLegs(dt) {
  if (lower.wigT !== lower.kickT) {
    lower.kickT = lower.wigT; lower.kick2 = true;
    lower.L.v += 1.0; lower.R.v -= 0.85; lower.L.qv += 1.0; lower.R.qv += 0.8;
  } else if (lower.kick2 && now() - lower.wigT > 330) {
    lower.kick2 = false; lower.L.v -= 0.6; lower.R.v += 0.7;
  }
  const ta = Math.max(-0.045, Math.min(0.045, carry.vx * 0.00016));
  const stretch = Math.max(0, Math.min(0.03, -carry.vy * 0.0002));
  const tq = Math.max(-0.035, Math.min(0.035, body.dip / 28 - stretch));
  const n = Math.max(1, Math.ceil(dt / 0.012)), h = dt / n;
  for (const s of [lower.L, lower.R]) {
    for (let i = 0; i < n; i++) {
      s.v += (-s.w * s.w * (s.a - ta) - 2 * s.z * s.w * s.v) * h; s.a += s.v * h;
      s.qv += (-s.wq * s.wq * (s.q - tq) - 2 * s.zq * s.wq * s.qv) * h; s.q += s.qv * h;
    }
    s.a = Math.max(-0.05, Math.min(0.05, s.a)); s.q = Math.max(-0.04, Math.min(0.04, s.q));
    if (Math.abs(s.a) < 1e-4 && Math.abs(s.v) < 2e-3 && Math.abs(ta) < 1e-4) s.a = s.v = 0;
    if (Math.abs(s.q) < 1e-4 && Math.abs(s.qv) < 2e-3 && Math.abs(tq) < 1e-4) s.q = s.qv = 0;
  }
}

function drawRig(name) {
  ctx.drawImage(img[name], OX, OY, RIG.size[0] * CS, RIG.size[1] * CS);
}

function drawLowerBody() {
  const gx = LEG_GAP(), top = CLIP_Y, floor = LEG_FLOOR(), L = lower.L, R = lower.R;
  if (!(L.a || L.q || R.a || R.q)) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, 99999, 99999); ctx.clip(); drawRig('torso'); ctx.restore();
    return;
  }
  for (const side of [-1, 1]) {
    const s = side < 0 ? L : R;
    ctx.save(); ctx.beginPath();
    if (side < 0) ctx.rect(0, top, gx + 2, 99999); else ctx.rect(gx, top, 99999, 99999);
    ctx.clip();
    const px = gx + side * 30;
    ctx.translate(px, top); ctx.rotate(s.a); ctx.translate(-px, -top);
    ctx.translate(gx, floor); ctx.scale(1 + s.q * 0.6, 1 - s.q); ctx.translate(-gx, -floor);
    drawRig('torso'); ctx.restore();
  }
}

function drawHearts() {
  const t = now();
  pat.hearts = pat.hearts.filter((h) => t - h.t0 < 1300);
  if (!pat.hearts.length) return;
  ctx.save();
  ctx.font = 'bold 72px "Segoe UI Symbol", "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.lineWidth = 6; ctx.lineJoin = 'round';
  for (const h of pat.hearts) {
    const p = (t - h.t0) / 1300;
    ctx.globalAlpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    const x = h.x + Math.sin(p * 7 + h.ph) * 14, y = h.y - p * 150, sz = 0.7 + p * 0.5;
    ctx.save(); ctx.translate(x, y); ctx.scale(sz, sz);
    ctx.strokeStyle = '#ffffff'; ctx.strokeText('♥', 0, 0);
    ctx.fillStyle = '#ff6fa8'; ctx.fillText('♥', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function applyHead() {
  ctx.translate(0, head.dy + actHeadDy() - Math.sin(breathPhase) * 3.5 * idleAmt());
  const pv = popVals(now());
  if (pv) ctx.translate(0, pv.dy);
  ctx.translate(NECK.x, NECK.y); ctx.rotate(head.rot + (pv ? pv.rot : 0)); if (pv) ctx.scale(pv.sx, pv.sy); ctx.translate(-NECK.x, -NECK.y);
}

function drawFacePatch(name, alpha) {
  name = kFace(name);
  if (name === 'neutral' || alpha <= 0 || !RIG.faces || !RIG.faces[name]) return;
  const f = RIG.faces[name];
  ctx.globalAlpha = alpha;
  ctx.drawImage(img['face_' + name], OX + f.x * CS, OY + f.y * CS, f.w * CS, f.h * CS);
  ctx.globalAlpha = 1;
}

const GAZE_DIRS = ['r', 'dr', 'd', 'dl', 'l', 'ul', 'u', 'ur'];
let gazeDir = null;
function pickGaze() {
  const m = Math.hypot(head.gx || 0, head.gy || 0);
  if (m < (gazeDir ? 0.22 : 0.32)) return (gazeDir = null);
  const ang = (Math.atan2(head.gy, head.gx) / (Math.PI / 4) + 8) % 8;
  const idx = Math.round(ang) % 8;
  if (gazeDir !== null) {
    const cur = GAZE_DIRS.indexOf(gazeDir), diff = Math.abs(((ang - cur + 12) % 8) - 4);
    if (diff < 0.65) return gazeDir;
  }
  return (gazeDir = GAZE_DIRS[idx]);
}

const GS = window.GAZE_SMOOTH;
const eye = { x: 0, y: 0, amt: 0, cv: null };
const EYE_RES = 2;
const smoothGaze = () => !!(GS && img.gaze_white && img.gaze_iris && img.gaze_lid && !KA.on);

function gazeOffset(gx, gy) {
  const m = Math.hypot(gx, gy);
  if (m < 1e-3) return { x: 0, y: 0, amt: 0 };
  const ang = (Math.atan2(gy, gx) / (Math.PI / 4) + 8) % 8, i = Math.floor(ang) % 8, f = ang - Math.floor(ang);
  const a = GS.offset[GAZE_DIRS[i]], b = GS.offset[GAZE_DIRS[(i + 1) % 8]], amt = smooth(Math.min(1, m / 0.6));
  return { x: (a[0] + (b[0] - a[0]) * f) * amt, y: (a[1] + (b[1] - a[1]) * f) * amt, amt };
}

function stepEye(gx, gy, dt) {
  if (!smoothGaze()) return;
  const o = gazeOffset(gx, gy);
  const k = GS.speed || 16;
  eye.x = ease(eye.x, o.x, k, dt); eye.y = ease(eye.y, o.y, k, dt); eye.amt = ease(eye.amt, o.amt, k, dt);
}

function composeEye() {
  const g = eye.cv.getContext('2d');
  g.setTransform(EYE_RES, 0, 0, EYE_RES, 0, 0);
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, GS.w, GS.h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img.gaze_white, 0, 0, GS.w, GS.h);
  g.globalCompositeOperation = 'source-atop';
  const d = Math.hypot(eye.x, eye.y), turn = Math.min(1, d / GS.turn), phi = d > 1e-3 ? Math.atan2(eye.y, eye.x) : 0;
  const u = 1 + GS.restGrow * (1 - eye.amt);
  const px = GS.pupil[0] + eye.x, py = GS.pupil[1] + eye.y;
  for (const [s, x0] of [[1 - GS.squeeze * turn, -0.5], [1 + GS.stretch * turn, -200]]) {
    g.save();
    g.translate(px, py); g.rotate(phi);
    g.beginPath(); g.rect(x0, -200, 200.5, 400); g.clip();
    g.scale(u * s, u); g.rotate(-phi); g.translate(-GS.pupil[0], -GS.pupil[1]);
    g.drawImage(img.gaze_iris, GS.irisX, GS.irisY, GS.irisW, GS.irisH);
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
  g.drawImage(img.gaze_lid, 0, 0, GS.w, GS.h);
}

function drawSmoothGaze() {
  if (!eye.cv) { eye.cv = document.createElement('canvas'); eye.cv.width = GS.w * EYE_RES; eye.cv.height = GS.h * EYE_RES; }
  const key = eye.x.toFixed(2) + ',' + eye.y.toFixed(2) + ',' + eye.amt.toFixed(3);
  if (key !== eye.key) { eye.key = key; composeEye(); }
  ctx.drawImage(eye.cv, OX + GS.x * CS, OY + GS.y * CS, GS.w * CS, GS.h * CS);
}

function drawGaze() {
  if (!RIG.gaze || mood.face !== 'neutral') return;
  if (smoothGaze()) return drawSmoothGaze();
  const d = pickGaze();
  if (!d) return;
  const g = RIG.gaze[d];
  ctx.drawImage(img['gaze_' + d], OX + g.x * CS, OY + g.y * CS, g.w * CS, g.h * CS);
}

function drawFace() {
  drawGaze();
  const p = mood.fadeT ? Math.min(1, (now() - mood.fadeT) / 140) : 1;
  if (p < 1) drawFacePatch(mood.prev, 1 - p);
  drawFacePatch(mood.face, p);
}

function drawFrontHair() {
  const fh = RIG.frontHair;
  if (!fh || !img.front_hair) return;
  const y0 = OY + fh.y0 * CS, k = fhair.x / (fh.y1 - fh.y0);
  ctx.save();
  ctx.translate(0, y0); ctx.transform(1, 0, k, 1, 0, 0); ctx.translate(0, -y0);
  drawRig('front_hair');
  ctx.restore();
}

function drawFaceTop() {
  const k = mood.face;
  if (!RIG.faceTop || !RIG.faceTop.includes(k) || !img['face_' + k + '_top']) return;
  const f = RIG.faces[k];
  ctx.drawImage(img['face_' + k + '_top'], OX + f.x * CS, OY + f.y * CS, f.w * CS, f.h * CS);
}

function withCharacterClip(fn) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 99999, CLIP_Y); ctx.clip();
  try { applyBody(); fn(); } finally { ctx.restore(); }
}

const boneTails = () => RIG && RIG.tail && tailTex.L && !KA.on;
function drawTails() {
  if (boneTails()) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 99999, CLIP_Y); ctx.clip();
    drawTailMesh('L'); drawTailMesh('R');
    ctx.restore();
    return;
  }
  withCharacterClip(() => {
    applyHead();
    for (const s of ['L', 'R']) {
      const p = TIE[s];
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(tails[s].a); ctx.translate(-p.x, -p.y);
      drawRig('tail' + s); ctx.restore();
    }
  });
}

function drawHandShadow(h) {
  if (act.kind === 'sip') return;
  const sd = h === hands.L ? 'L' : 'R';
  if (act.kind && actHand(sd)) return;
  if (h.state === 'wave') return;
  const a = Math.max(0.06, 0.26 - (h.z + h.lift) * 0.007);
  ctx.fillStyle = `rgba(30,20,40,${a})`;
  const z = h.z + h.lift;
  ctx.beginPath(); ctx.ellipse(h.gx + h.push + 4, h.gy + 6, 34 + z * 0.6, 10 + z * 0.15, 0, 0, Math.PI * 2); ctx.fill();
}

function drawHand(side) {
  const h = hands[side];
  if (act.kind === 'sip') {
    const sh = sipHand(side);
    if (sh.alpha <= 0.01) return;
    const meta = RIG.float[`${side}_hover`];
    ctx.save(); ctx.globalAlpha = sh.alpha; ctx.translate(sh.x, sh.y);
    ctx.drawImage(img[`float_${side}_hover`], -meta.tip[0] * HS, -meta.tip[1] * HS, meta.w * HS, meta.h * HS);
    ctx.restore();
    return;
  }
  const ah = actHand(side);
  if (ah === 'hidden') return;
  if (ah && ah.e > 0.02) {
    const sp = act.kind === 'yawn' ? `${side === 'L' ? 'R' : 'L'}_back` : `${side}_wave`;
    const m = RIG.float[sp];
    ctx.save(); ctx.translate(ah.x, ah.y); ctx.rotate(ah.rot);
    ctx.drawImage(img[`float_${sp}`], -m.tip[0] * HS, -m.tip[1] * HS, m.w * HS, m.h * HS);
    ctx.restore();
    return;
  }
  const pose = poseOf(h);
  const meta = RIG.float[`${side}_${pose}`];
  const jx = Math.sin(now() / 14) * h.jitter * 3;
  let tx = h.gx + h.push + jx, ty = h.gy - h.z - h.lift + (pose === 'hover' || pose === 'rest' ? 0 : 3);
  let rot = Math.max(-0.16, Math.min(0.16, (tx - NECK.x) / 1600)) + (side === 'L' ? -h.spread : h.spread);
  const ps = handPersp(h);
  if (pose === 'wave') {
    const w = (now() - h.waveT) / 1000;
    tx = NECK.x + (side === 'L' ? -330 : 330) + body.x; ty = NECK.y - 60;
    rot = Math.sin(w * 13) * 0.32;
  }
  ctx.save();
  ctx.translate(tx, ty); ctx.rotate(rot); ctx.scale(h.sx * ps, h.sy * ps);
  ctx.drawImage(img[`float_${side}_${pose}`], -meta.tip[0] * HS, -meta.tip[1] * HS, meta.w * HS, meta.h * HS);
  ctx.restore();
}
