window.addEventListener('error', (e) => console.error('uncaught: ' + e.message + ' @' + e.lineno));
// Ame typing pet — renderer.
// Scene space is 1448x1000; the character rig lives in its own 1086x1448 space (assets/rig/rig.json)
// and is placed into the scene with CS/OX/OY. Design notes: ../PLAN.md ("悬空大手设计 v3").
'use strict';

// the window only shows the part of the scene she can ever occupy (tails swing, wave, zzz): x 190..1250
const VX = 190, ART_W = 1060, ART_H = 1080;
const DESK_Y = 803;                         // where the body is cut; kept hidden behind the keyboard
const CS = 0.851, OX = 262, OY = -14;       // rig -> scene
let HS = 0.95;                              // floating-hand sprite scale (overridden by rig.floatScale)
const BODY_MAX_X = 60;
const HOVER_Z = 16;                         // resting height of a hand above the keys

const INK = '#1c1522';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let scale = 0.36, debug = false;
let kbOnly = false;                         // self-test: render the keyboard alone
let RIG, NECK, HIP, TIE;
const toScene = ([x, y]) => ({ x: x * CS + OX, y: y * CS + OY });

const SLAM_KEYS = new Set(['Space', 'Enter', 'Bksp']);
const MODS = new Set(['Shift', 'RShift', 'Ctrl', 'RCtrl', 'Alt', 'RAlt', 'Win', 'Fn']);

// ---------- assets ----------
const img = {};
const loadImg = (name, src) => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => { img[name] = i; res(); }; i.onerror = rej; i.src = src;
});

// ---------- state ----------
const now = () => performance.now();
// ground = fingertip position projected on the keyboard; z = height above it
const mkHand = () => ({
  gx: 0, gy: 0, z: HOVER_Z, zv: 0, zStart: HOVER_Z, state: 'hover', from: null, to: null, t0: 0, dur: 0, arc: 0,
  key: null, strikeT: -1e9, lastAct: -1e9, slam: false, sx: 1, sy: 1, jitter: 0, homing: false,
  push: 0, lift: 0, spread: 0,   // yielding: sideways shift + lift; spread = palm swung outward around the fingertip
});
const hands = { L: mkHand(), R: mkHand() };
let topHand = 'R';                          // most recently active hand is drawn on top
const body = { x: 0, rot: 0, vx: 0, dip: 0, dipV: 0 };
const head = { rot: 0, dy: 0, nodUntil: 0, vrot: 0 };
const tails = { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } };
const mouse = { x: 724, y: 300, seen: false };   // cursor in art space (from the main process)
const fx = [];                              // transient effects {type, x, y, t0}
const pressTimes = [];

// ---------- expressions (design: PLAN.md) ----------
// face = which expression patch sits on the head; temp faces override the base one for a while
const FACES = ['blink', 'half', 'focus', 'happy', 'annoyed', 'surprised', 'yandere', 'sleep'];
const mood = {
  face: 'neutral', prev: 'neutral', fadeT: 0, temp: null, tempUntil: 0,
  lastKeyT: performance.now(), sleeping: false, bksp: [], undo: [],
  blinkAt: performance.now() + 2500, blinkUntil: 0, doubleBlink: false,
};
function setTemp(face, ms) { mood.temp = face; mood.tempUntil = performance.now() + ms; }
function recent(arr, t, win) { while (arr.length && t - arr[0] > win) arr.shift(); return arr.length; }

// temp face only if its art exists (the second expression batch may not be installed yet)
const hasFace = (f) => f === 'neutral' || !!(RIG && RIG.faces && RIG.faces[f]);
function tryTemp(face, ms, fallback) {
  if (hasFace(face)) setTemp(face, ms); else if (fallback) setTemp(fallback, ms);
}

function moodOnKey(k, t) {
  const idle = t - mood.lastKeyT;
  mood.lastKeyT = t;
  mood.pouted = false;
  if (mood.sleeping) { mood.sleeping = false; setTemp('surprised', 1400); setTimeout(() => wave('L', 1400), 500); }  // woken up
  else if (idle > 20000) setTemp('surprised', 900);                               // sudden burst
  const ctrl = byCode.get(29)?.down;
  // same key over and over -> deadpan
  mood.repeat = k.label === mood.lastLabel ? (mood.repeat || 1) + 1 : 1;
  mood.lastLabel = k.label;
  if (mood.repeat >= 6 && !ctrl && k.label !== 'Bksp') tryTemp('deadpan', 2000);
  // mashing: 4+ keys held at once -> dizzy
  if (keys.filter((x) => x.down).length >= 4) tryTemp('dizzy', 1600);
  if (k.label === 'Bksp') {
    mood.bksp.push(t);
    if (recent(mood.bksp, t, 6000) >= 10) tryTemp('teary', 3000, 'annoyed');
    else if (recent(mood.bksp, t, 2000) >= 4) setTemp('annoyed', 2500);
  }
  if (k.label === 'Esc') { mood.esc = (mood.esc || []); mood.esc.push(t); if (recent(mood.esc, t, 2000) >= 4) tryTemp('angry', 2000, 'annoyed'); }
  if (ctrl && k.label === 'Z') {
    mood.undo.push(t);
    const n = recent(mood.undo, t, 3000);
    if (n >= 5) setTemp('yandere', 3000); else if (n >= 3) tryTemp('sweat', 1800);
  }
  if (ctrl && k.label === 'C') mood.copyT = t;
  if (ctrl && k.label === 'V' && t - (mood.copyT || -1e9) < 3000) tryTemp('wink', 1200, 'happy');
  if (ctrl && k.label === 'S') tryTemp('smug', 1500, 'happy');
  if (k.label === 'Enter' && pressTimes.length >= 20) setTemp('happy', 1300);
}

function baseFace(t) {
  if (t < mood.tempUntil) return mood.temp;
  const idle = t - mood.lastKeyT;
  if (idle > 180000) { mood.sleeping = true; return 'sleep'; }
  if (idle > 60000) return 'half';
  if (idle > 30000 && idle < 33000 && !mood.pouted && hasFace('pout')) return 'pout';   // ignored for a while
  if (idle >= 33000) mood.pouted = true;
  if (kpm() > 320 && hasFace('sparkle')) return 'sparkle';
  if (kpm() > 200) return 'focus';
  // watching Claude work with a focused face -- unless you are moving the mouse, then she follows it
  if (claude.state === 'working' && idle > 1500 && now() - (mouse.movedAt || 0) > 4000) return 'focus';
  const hr = new Date().getHours();
  if (hr >= 2 && hr < 5) return 'yandere';
  return 'neutral';
}

function updateMood(t) {
  let f = baseFace(t);
  // blinking (not while asleep / surprised)
  if (f !== 'sleep' && f !== 'surprised') {
    if (t >= mood.blinkAt) {
      mood.blinkUntil = t + 110;
      mood.blinkAt = mood.doubleBlink ? t + 220 : t + 2200 + Math.random() * 3300;
      mood.doubleBlink = !mood.doubleBlink && Math.random() < 0.18;
    }
    if (t < mood.blinkUntil) f = 'blink';
  }
  if (f !== mood.face) {
    mood.prev = mood.face; mood.face = f;
    mood.fadeT = 0;                        // faces switch instantly (a crossfade ghosts the eyes)
  }
}

let lastKey = '', breathPhase = 0;

function kpm() {
  const t = now();
  while (pressTimes.length && t - pressTimes[0] > 10000) pressTimes.shift();
  return pressTimes.length * 6;
}
const speedFactor = () => { const k = kpm(); return k > 250 ? 0.65 : k > 120 ? 0.82 : 1; };

function restPoint(s) {       // index-finger home key on this screen side (F or J depending on facing)
  const a = byCode.get(REST_KEYS.L), b = byCode.get(REST_KEYS.R);
  const k = (a.cx < b.cx) === (s === 'L') ? a : b;
  return { x: k.cx, y: k.cy };
}

const holdingMod = (h) => h.state === 'strike' && h.key && h.key.down && MODS.has(h.key.label);
// the modifier a hand is keeping pressed right now (directly, or under its pinky during a chord)
const heldModOf = (h) => (h.chordMod && h.chordMod.down ? h.chordMod : holdingMod(h) ? h.key : null);
const sameHalf = (a, b) => (a.cx < splitX) === (b.cx < splitX);

function land(h, k, t) {
  k.hotUntil = t + 120;
  addRipple(h.to ? h.to.x : k.cx, k.cy, h.slam);
  if (h.slam) kbShake = 1;
  body.dipV += h.slam ? 55 : 28;
}

function sendHand(h, to, key, t, homing = false) {
  if (h.state === 'travel' && h.key && !h.homing) land(h, h.key, t);   // never lose an interrupted key press
  const dist = Math.hypot(to.x - h.gx, to.y - h.gy);
  const sf = homing ? 1 : speedFactor();
  h.from = { x: h.gx, y: h.gy }; h.to = to; h.key = key; h.homing = homing;
  h.t0 = t;
  h.dur = homing ? Math.min(260, 160 + dist * 0.4) : Math.max(45, Math.min(110, 40 + dist * 0.35)) * sf;
  h.arc = homing ? 8 : Math.min(34, 10 + dist * 0.12) * (kpm() > 250 ? 0.6 : 1);
  h.zStart = h.z;
  h.state = 'travel';
}

// which hand presses k: its own half by default; keys near the split go to the free / nearer hand;
// never cross the hands over; while one hand holds a modifier the other presses the letter (Ctrl+C)
const busy = (h, t) => h.state === 'travel' && !h.homing || h.state === 'strike' || t - h.lastAct < 70;
function pickHand(k, t) {
  const L = hands.L, R = hands.R;
  let side = k.cx < splitX ? 'L' : 'R';
  const shared = Math.abs(k.cx - splitX) < KB.u * 1.6 || k.label === 'Space';
  if (shared) {
    // keep the natural (touch-typing) hand unless the other hand is right next to the key and the
    // natural one is far away -- then the near hand just hops over instead of the two colliding
    const d = { L: Math.hypot(L.gx - k.cx, L.gy - k.cy), R: Math.hypot(R.gx - k.cx, R.gy - k.cy) };
    const other = side === 'L' ? 'R' : 'L';
    if (d[other] < KB.u * 1.2 && d[side] > KB.u * 2) side = other;
    else if (k.label === 'Space') side = d.L <= d.R ? 'L' : 'R';
  }
  // no crossing: the left hand must stay left of the right hand's fingertip (and vice versa)
  if (side === 'L' && k.cx > R.gx - 20 && R.state !== 'strike') side = 'R';
  if (side === 'R' && k.cx < L.gx + 20 && L.state !== 'strike') side = 'L';
  return side;
}

function wave(side = 'L', ms = 1600) {
  const h = hands[side];
  if (h.state === 'strike' || h.state === 'travel') return;
  Object.assign(h, { state: 'wave', waveT: now(), waveUntil: now() + ms, z: HOVER_Z, sx: 1, sy: 1 });
}

function onKey({ code, down }) {
  if (down && code in KNOB_DIR) knob.vel += KNOB_DIR[code] * 14;
  code = KEY_ALIASES[code] ?? code;
  const k = byCode.get(code);
  if (!k) return;
  if (!down) { k.down = false; return; }
  const t = now();
  if (k.down) {                              // OS auto-repeat while held: jiggle the hand holding it
    for (const h of Object.values(hands)) if (h.key === k) { h.jitter = 1; k.hotUntil = t + 80; }
    return;
  }
  k.down = true;
  if (act.kind) stopAct(); else act.next = Math.max(act.next, t + 20000);
  pressTimes.push(t);
  lastKey = k.label;
  moodOnKey(k, t);

  let side = pickHand(k, t), chord = null;
  for (const sd of ['L', 'R']) {
    const mod = heldModOf(hands[sd]);
    if (mod && mod !== k && sameHalf(mod, k)) { side = sd; chord = mod; }   // Ctrl+Z: same hand, pinky on Ctrl
  }
  const h = hands[side];
  h.slam = !chord && SLAM_KEYS.has(k.label);
  h.pressPose = chord ? 'pinky' : fingerFor(k);
  h.chordMod = chord;
  h.lastAct = t;
  topHand = side;
  // wide keys (Space, Enter, Shift, Bksp): press the spot nearest the hand instead of the key's centre
  const edge = KB.u * 0.5;
  let tx = k.w > KB.u * 1.6 ? Math.max(k.x + edge, Math.min(k.x + k.w - edge, h.gx)) : k.cx;
  let ty = k.cy;
  if (chord) { tx = chord.cx + (tx - chord.cx) * 0.62; ty = chord.cy + (k.cy - chord.cy) * 0.62; }   // between both keys
  sendHand(h, { x: tx, y: ty }, k, t);
  if (k.label === 'Enter') head.nodUntil = t + 240;
}

// ---------- animation ----------
const ease = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const smooth = (p) => p * p * (3 - 2 * p);

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
      // lift along an arc (stretching a little), then drop onto the key
      h.z = h.zStart * (1 - e) + Math.sin(Math.PI * Math.min(1, p * 1.15)) * h.arc;
      h.sy = 1 + 0.07 * Math.sin(Math.PI * p); h.sx = 1 / h.sy;
      if (p >= 1) { h.state = 'strike'; h.strikeT = t; h.z = 0; h.zv = 0; land(h, h.key, t); }
    }
  } else if (h.state === 'strike') {
    const squash = Math.max(0, 1 - (t - h.strikeT) / 120);
    h.sx = 1 + (h.slam ? 0.14 : 0.09) * squash; h.sy = 1 - (h.slam ? 0.16 : 0.11) * squash;
    const held = h.key && h.key.down;
    if (t - h.strikeT > 85 && !held) {
      if (h.chordMod && h.chordMod.down) {             // chord key released, modifier still held: back onto it
        const mod = h.chordMod; h.chordMod = null; h.pressPose = fingerFor(mod); h.slam = false;
        sendHand(h, { x: mod.cx, y: mod.cy }, mod, t);
      } else { h.chordMod = null; h.state = 'recoil'; h.zv = 260; }
    }
  } else {
    // hover / recoil: underdamped spring back to hover height (small overshoot), bobbing with the breath
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

// visual centre of a hand (the sprite extends away from the fingertip anchor)
// which sprite a hand shows right now
function poseOf(h) {
  if (h.state === 'wave') return 'wave';
  if (h.state === 'strike') return h.slam ? 'slam' : h.pressPose || 'press';
  return mood.sleeping ? 'rest' : 'hover';
}
// finger for a key: distance from the keyboard's middle decides index / middle / ring / pinky;
// the two rows farthest from her are reached with the whole hand stretched forward
function fingerFor(k) {
  const farY = KB.y + KB.padY + KB.v * 3.5;
  if (k.cy > farY) return 'reach';
  const d = Math.abs(k.cx - splitX) / KB.u;
  return d < 2.2 ? 'press' : d < 3.3 ? 'middle' : d < 4.4 ? 'ring' : 'pinky';
}
// hands near the viewer look a little bigger (the keyboard has the same perspective)
const handPersp = (h) => 0.95 + 0.12 * Math.max(0, Math.min(1, (h.gy - KB.y) / KB.h));

function handCenter(side, ahead = false) {
  const h = hands[side];
  const pose = poseOf(h);
  const m = RIG.float[`${side}_${pose}`];
  const gx = ahead && h.state === 'travel' ? h.to.x : h.gx;    // anticipate: where a flying hand will land
  return gx + h.push + (m.w / 2 - m.tip[0]) * HS;
}
function separateHands(t, dt) {
  const L = hands.L, R = hands.R;
  const minGap = RIG.float.L_hover.w * HS * 0.82;
  const gap = (handCenter('R', true) - R.push) - (handCenter('L', true) - L.push);   // gap without current pushes
  const need = Math.max(0, minGap - gap);
  // the hand that is not working yields; if both work, the one that acted earlier yields
  const yl = !busy(L, t) && busy(R, t) ? true : busy(L, t) && !busy(R, t) ? false : L.lastAct < R.lastAct;
  const canL = L.state !== 'strike', canR = R.state !== 'strike';
  let pl = 0, pr = 0;
  if (need > 0) {
    if (yl && canL) pl = -need; else if (!yl && canR) pr = need;
    else if (canL) pl = -need; else if (canR) pr = need;          // both striking: nothing to do
  }
  L.push = ease(L.push, pl, 26, dt); R.push = ease(R.push, pr, 26, dt);
  L.lift = ease(L.lift, pl ? 8 : 0, 12, dt); R.lift = ease(R.lift, pr ? 8 : 0, 12, dt);
  // index fingers side by side (both working): swing both palms outward like real wrists do
  const nowGap = handCenter('R') - handCenter('L');
  const close = Math.max(0, Math.min(1, (minGap - nowGap) / 45));
  L.spread = ease(L.spread, close * 0.26, 20, dt); R.spread = ease(R.spread, close * 0.26, 20, dt);
}

function update(dt) {
  const t = now();
  updateMood(t);
  for (const s of ['L', 'R']) updateHand(s, hands[s], t, dt);
  separateHands(t, dt);

  // body leans toward where the hands are working; every strike makes it dip (typing groove)
  const homeMid = (restPoint('L').x + restPoint('R').x) / 2;
  const bx = Math.max(-BODY_MAX_X, Math.min(BODY_MAX_X, ((hands.L.gx + hands.R.gx) / 2 - homeMid) * 0.35 + (head.gx || 0) * 14));
  const px = body.x;
  body.x = ease(body.x, bx, 7, dt);
  body.vx = (body.x - px) / Math.max(dt, 1e-3);
  body.rot = ease(body.rot, (bx / BODY_MAX_X) * 0.07 - Math.max(-0.12, Math.min(0.12, carry.vx * 0.004)), 7, dt);
  body.dipV += (-420 * body.dip - 26 * body.dipV) * dt;
  body.dip += body.dipV * dt;

  // head: looks at you; glances down when a hand works on the rows nearest the viewer
  const farY = KB.y + KB.padY + KB.v * 3.5;
  const busy = [hands.L, hands.R].filter((h) => h.state !== 'hover' && !h.homing && h.gy > farY);
  const lookDown = busy.length > 0;
  const side = busy.length ? Math.sign(busy[0].gx - NECK.x) : 0;
  const pr = head.rot;
  const gazeOn = mouse.seen && !mood.sleeping && t - mood.lastKeyT > 1500;
  const gx = gazeOn ? Math.max(-1, Math.min(1, (mouse.x - NECK.x) / 700)) : 0;
  const gy = gazeOn ? Math.max(-1, Math.min(1, (mouse.y - (NECK.y - 120)) / 500)) : 0;
  head.gx = ease(head.gx || 0, gx, 5, dt); head.gy = ease(head.gy || 0, gy, 5, dt);
  const idleRot = mood.sleeping ? 0.09 : mood.face === 'half' ? 0.04 : Math.sin(t / 2100) * 0.02 + head.gx * 0.075;
  head.rot = ease(head.rot, lookDown ? side * 0.07 : idleRot, mood.sleeping ? 1.5 : 8, dt);
  head.vrot = (head.rot - pr) / Math.max(dt, 1e-3);
  head.dy = ease(head.dy, (lookDown ? 12 : 0) + (t < head.nodUntil ? 16 : 0) + (mood.sleeping ? 14 : mood.face === 'half' ? 5 : 0) + head.gy * 7, mood.sleeping ? 2 : 14, dt);

  // twin tails: damped springs kicked by body sway, dips and head turns
  for (const s of ['L', 'R']) {
    const tl = tails[s];
    const force = -body.vx * 0.0012 - head.vrot * 0.35 - body.dipV * 0.0006 + Math.sin(t / 900 + (s === 'L' ? 0 : 1.7)) * 0.02;
    tl.v += (-60 * tl.a - 7 * tl.v + force * 60) * dt;
    tl.a += tl.v * dt;
    tl.a = Math.max(-0.45, Math.min(0.45, tl.a));
  }
  if (boneTails()) { stepTail('L', dt); stepTail('R', dt); }
  updateAct();
  if (mood.carried && now() - carry.t > 350) mood.carried = false;
  carry.vx = ease(carry.vx, 0, 8, dt); carry.vy = ease(carry.vy, 0, 8, dt);
  kbShake = ease(kbShake, 0, 16, dt);
  knob.phase += knob.vel * dt; knob.vel = ease(knob.vel, 0, 6, dt);
  while (fx.length && t - fx[0].t0 > 200) fx.shift();

  const freq = mood.sleeping ? 0.14 : 0.22 + Math.min(kpm(), 400) / 400 * 0.35;
  breathPhase += dt * freq * Math.PI * 2;
}

// ---------- drawing ----------
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

// body transform (lean + groove dip + breathing) in scene space
// idle = not typing for a moment: breathing, head and hands rise and fall more visibly
const idleAmt = () => Math.max(0, Math.min(1, (now() - mood.lastKeyT - 800) / 1500));
function breath() {
  const st = act.kind === 'stretch' ? 0.035 * easeIO(actEnv()) : 0;
  return 1 + st + Math.sin(breathPhase) * (0.008 + 0.012 * idleAmt());
}
// stretching lifts the whole upper body (sitting up tall), not just the arms
const actBodyDy = () => (act.kind === 'stretch' ? -42 * easeIO(actEnv()) : 0);
function applyBody() {
  ctx.translate(body.x, body.dip + actBodyDy());
  ctx.translate(HIP.x, HIP.y); ctx.rotate(body.rot); ctx.scale(1, breath()); ctx.translate(-HIP.x, -HIP.y);
}
function actHeadDy() { return act.kind === 'stretch' || act.kind === 'yawn' ? -10 * easeIO(actEnv()) : act.kind === 'sip' ? 4 * sipState().lift + 6 * sipBeat() : 0; }
function applyHead() {
  ctx.translate(0, head.dy + actHeadDy() - Math.sin(breathPhase) * 3.5 * idleAmt());
  ctx.translate(NECK.x, NECK.y); ctx.rotate(head.rot); ctx.translate(-NECK.x, -NECK.y);
}
const drawRig = (name) => ctx.drawImage(img[name], OX, OY, RIG.size[0] * CS, RIG.size[1] * CS);

function drawFacePatch(name, alpha) {
  if (name === 'neutral' || alpha <= 0 || !RIG.faces || !RIG.faces[name]) return;
  const f = RIG.faces[name];
  ctx.globalAlpha = alpha;
  ctx.drawImage(img['face_' + name], OX + f.x * CS, OY + f.y * CS, f.w * CS, f.h * CS);
  ctx.globalAlpha = 1;
}
const GAZE_DIRS = ['r', 'dr', 'd', 'dl', 'l', 'ul', 'u', 'ur'];   // angle order: 0, 45, 90 ... degrees (y down)
// eyes snap between directions like real saccades (no alpha blending -> no double irises);
// a little hysteresis keeps them from flickering on a boundary
let gazeDir = null;
function pickGaze() {
  const m = Math.hypot(head.gx || 0, head.gy || 0);
  if (m < (gazeDir ? 0.22 : 0.32)) return (gazeDir = null);
  const ang = (Math.atan2(head.gy, head.gx) / (Math.PI / 4) + 8) % 8;
  const idx = Math.round(ang) % 8;
  if (gazeDir !== null) {
    const cur = GAZE_DIRS.indexOf(gazeDir), diff = Math.abs(((ang - cur + 12) % 8) - 4);
    if (diff < 0.65) return gazeDir;                              // within ~30 deg of the current one: keep it
  }
  return (gazeDir = GAZE_DIRS[idx]);
}
function drawGaze() {
  if (!RIG.gaze || mood.face !== 'neutral') return;
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

function drawZzz() {                     // floating Z's while asleep
  if (!mood.sleeping) return;
  const t = now();
  ctx.save();
  ctx.font = 'bold 44px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.lineWidth = 7; ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    const p = ((t / 2400) + i / 3) % 1;
    const x = NECK.x + 400 + p * 60 + Math.sin(p * 6) * 12 + body.x, y = NECK.y - 170 - p * 190;
    const size = 0.8 + p * 0.9;
    ctx.globalAlpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    ctx.strokeStyle = '#ffffff'; ctx.strokeText('Z', 0, 0);
    ctx.fillStyle = '#6d5a67'; ctx.fillText('Z', 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function withCharacterClip(fn) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 99999, CLIP_Y); ctx.clip();
  try { applyBody(); fn(); } finally { ctx.restore(); }   // a throw must never leave the clip on the canvas
}

const boneTails = () => RIG && RIG.tail && tailTex.L;
function drawTails() {
  if (boneTails()) {                     // bone-chain tails: already in screen space, just clip at the keyboard
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

// floating hands (no arms): fingertip at (ground - z); a contact shadow on the keys shows the height
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
  if (act.kind === 'sip') {                 // gather at the mug and fade out while the painted mug hands fade in
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
  if (ah && ah.e > 0.02) {                  // hand taking part in an idle action (raised / covering the mouth)
    // covering the mouth the palm faces her, so we see the back of the hand: thumb on the outside (mirrored sprite)
    const sp = act.kind === 'yawn' ? `${side === 'L' ? 'R' : 'L'}_back` : `${side}_wave`;   // wave = palm side (no nails)
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
  if (pose === 'wave') {                    // raised beside her face, waving
    const w = (now() - h.waveT) / 1000;
    tx = NECK.x + (side === 'L' ? -330 : 330) + body.x; ty = NECK.y - 60;
    rot = Math.sin(w * 13) * 0.32;
  }
  ctx.save();
  ctx.translate(tx, ty); ctx.rotate(rot); ctx.scale(h.sx * ps, h.sy * ps);
  ctx.drawImage(img[`float_${side}_${pose}`], -meta.tip[0] * HS, -meta.tip[1] * HS, meta.w * HS, meta.h * HS);
  ctx.restore();
}

function drawEffects() {                  // only a faint, quick ring on the pressed key (no motion lines)
  const t = now();
  ctx.save();
  for (const e of fx) {
    const p = (t - e.t0) / 180;
    if (p > 1) continue;
    const a = (1 - p) * 0.55;
    ctx.strokeStyle = `rgba(255,120,175,${a})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(e.x, e.y + 2, 12 + p * 18, 5 + p * 7, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function drawDebug() {
  ctx.fillStyle = 'rgba(30,20,40,.75)'; ctx.fillRect(10, 10, 460, 110);
  ctx.fillStyle = '#fff'; ctx.font = '34px sans-serif';
  ctx.fillText(`KPM ${kpm()}  key ${lastKey}`, 24, 54);
  ctx.fillText(`face ${mood.face}  L ${hands.L.state}  R ${hands.R.state}`, 24, 100);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = Math.round(ART_W * scale) + 'px';
  canvas.style.height = Math.round(ART_H * scale) + 'px';
  canvas.width = Math.round(ART_W * scale * dpr);
  canvas.height = Math.round(ART_H * scale * dpr);
}

let last = now();
let lastFrameErr = '';
function frame() {
  requestAnimationFrame(frame);             // keep the loop alive whatever happens below
  // start every frame from a clean canvas state (no leftover clip / transform / alpha from a broken frame)
  if (ctx.reset) ctx.reset(); else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; }
  try { drawFrame(); } catch (e) {
    const msg = 'frame error: ' + (e && e.stack || e);
    if (msg !== lastFrameErr) { lastFrameErr = msg; console.error(msg); }
  }
}
function drawFrame() {
  const t = now(), dt = Math.min(0.05, (t - last) / 1000); last = t;
  update(dt);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -VX * scale * dpr, 0);
  ctx.clearRect(VX, 0, ART_W, ART_H);
  ctx.imageSmoothingQuality = 'high';

  if (kbOnly) { drawKeyboard(ctx, scale * dpr, 0); return; }
  drawKeyboardShadow(ctx, breathPhase);
  drawTails();
  withCharacterClip(() => drawRig('torso'));
  drawKeyboard(ctx, scale * dpr, breathPhase);
  withCharacterClip(() => { applyHead(); drawRig('head'); drawFace(); });
  drawHandShadow(hands.L); drawHandShadow(hands.R);
  for (const sd of topHand === 'L' ? ['R', 'L'] : ['L', 'R']) drawHand(sd);
  drawActProps();
  drawEffects();
  drawZzz();
  drawGrip();
  if (debug) drawDebug();
}

// ---------- window drag + resize grip + per-pixel click-through ----------
// Transparent pixels let clicks fall through to whatever is underneath; only her / the keyboard catch the mouse.
const GRIP_R = 16;                                 // grip radius in CSS px, sits on the keyboard's bottom-right corner
let drag = null, sizing = null, hover = false, overGrip = false, downAt = null, hit = false, lastProbe = 0;
function gripCss() {
  return { x: (KB.x + KB.w - 30 - VX) * scale, y: (KB.y + KB.h + KB_FRONT - 20) * scale };
}
const inGrip = (e) => { const g = gripCss(); return Math.hypot(e.offsetX - g.x, e.offsetY - g.y) < GRIP_R; };
function opaqueAt(e) {
  const dpr = window.devicePixelRatio || 1;
  const x = Math.round(e.offsetX * dpr), y = Math.round(e.offsetY * dpr);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  return ctx.getImageData(x, y, 1, 1).data[3] > 110;   // high: the soft underglow must not catch clicks
}
function setHit(v) { if (v !== hit) { hit = v; window.pet.setHit(v); } }
// forwarded mouse moves arrive even while the window ignores the mouse
window.addEventListener('mousemove', (e) => {
  if (drag || sizing) return;
  const t = performance.now();
  if (t - lastProbe < 25) return;
  lastProbe = t;
  overGrip = inGrip(e);
  hover = overGrip || opaqueAt(e);
  setHit(hover);
  canvas.style.cursor = overGrip ? 'nwse-resize' : 'default';
});
document.addEventListener('mouseleave', () => { if (!drag && !sizing) { hover = false; overGrip = false; setHit(false); } });

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hit) return;
  downAt = { x: e.screenX, y: e.screenY, ox: e.offsetX, oy: e.offsetY };
  canvas.setPointerCapture(e.pointerId);
  if (inGrip(e)) { sizing = true; window.pet.gesture('resize-start'); }
  else { drag = true; window.pet.gesture('drag-start'); }
});
// the main process reads the real cursor and places the window absolutely (no delta drift)
// the main process moves / resizes the window itself (cursor polling); make sure it always stops
const endGesture = () => { if (drag || sizing) window.pet.gesture(sizing ? 'resize-end' : 'drag-end'); drag = null; sizing = null; };
// (the main process also ends drags on the global mouse-up; moving windows can fire lostpointercapture / blur mid-drag)
canvas.addEventListener('pointerup', (e) => {
  const moved = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : 99;
  const wasSizing = !!sizing;
  if (sizing) window.pet.gesture('resize-end');     // commit (saves + updates the tray menu)
  else if (drag) window.pet.gesture('drag-end');
  if (!wasSizing && moved < 4 && downAt.oy / scale < NECK.y + 20) {
    tryTemp('blush', 2000, 'happy'); head.nodUntil = now() + 200;                 // a click (no drag) on her head: pat
  }
  downAt = null; drag = null; sizing = null;
});

function drawGrip() {                              // three diagonal ticks on the keyboard corner, while hovering her
  if (!hover && !sizing) return;
  const dpr = window.devicePixelRatio || 1, g = gripCss();
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = overGrip || sizing ? 'rgba(210,80,140,.95)' : 'rgba(110,90,105,.6)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const o of [5, 10, 15]) { ctx.beginPath(); ctx.moveTo(g.x + 8, g.y + 8 - o); ctx.lineTo(g.x + 8 - o, g.y + 8); ctx.stroke(); }
  ctx.restore();
}

window.pet.onMouse((m) => {
  if (Math.hypot(m.x - mouse.x, m.y - mouse.y) > 3) mouse.movedAt = now();
  mouse.x = m.x; mouse.y = m.y; mouse.seen = true;
});

window.pet.onConfig((c) => {
  scale = c.scale; debug = c.debug;
  if (c.facing && c.facing !== facing) { facing = c.facing; buildKeys(); }
  if (c.kbTheme && c.kbTheme !== KB_PAINT.theme) loadKbTheme(c.kbTheme);
  resize();
});
window.pet.onKey(onKey);

// ---------- idle little actions: yawn / stretch / sip (every 25-60 s while you are not typing) ----------
const ACTS = { yawn: 2600, stretch: 2600, sip: 4300 };
const act = { kind: null, t0: 0, dur: 0, next: now() + 30000 };
function startAct(kind) {
  if (act.kind || mood.sleeping || mood.carried || claude.state === 'waiting') return;
  if (kind === 'sip' && !img.mug) kind = 'yawn';
  Object.assign(act, { kind, t0: now(), dur: ACTS[kind] });
  const face = { yawn: ['yawn', 'half'], stretch: ['stretch', 'happy'], sip: ['sip', 'happy'] }[kind];
  if (kind === 'sip') {                    // close her eyes only once the cup reaches her mouth
    const t0 = act.t0;
    setTimeout(() => { if (act.kind === 'sip' && act.t0 === t0) tryTemp('sip', SIP.down - SIP.atMouth, 'happy'); }, SIP.atMouth);
  } else tryTemp(face[0], ACTS[kind], face[1]);
}
function stopAct() { if (act.kind) { act.kind = null; mood.tempUntil = 0; } act.next = now() + 25000 + Math.random() * 35000; }
function updateAct() {
  const t = now(), idle = t - mood.lastKeyT;
  if (act.kind && t - act.t0 > act.dur) stopAct();
  if (!act.kind && idle > 6000 && t > act.next && !mood.sleeping) {
    startAct(Math.random() < 0.5 ? 'yawn' : 'sip');
  }
}
const actP = () => (act.kind ? Math.min(1, (now() - act.t0) / act.dur) : 0);
// 0 -> 1 -> 0 envelope with quick in/out
const actEnv = () => { const p = actP(); return p < 0.18 ? p / 0.18 : p > 0.82 ? (1 - p) / 0.18 : 1; };
const easeIO = (x) => x * x * (3 - 2 * x);

// hands that belong to the action (null = the normal typing hand is drawn)
function actHand(side) {
  if (!act.kind) return null;
  const e = easeIO(actEnv()), t = now();
  if (act.kind === 'sip') return null;
  if (act.kind === 'yawn' && side === 'R') return null;
  const home = restPoint(side);
  let tx, ty, rot;
  if (act.kind === 'yawn') { tx = NECK.x - 20; ty = NECK.y + 100; rot = 0.4; }              // back of the hand over the mouth, fingers across
  else { tx = NECK.x + (side === 'L' ? -300 : 300); ty = NECK.y - 250 + actBodyDy() + Math.sin(t / 160) * 6; rot = side === 'L' ? -0.5 : 0.5; }
  return { x: home.x + (tx - home.x) * e, y: home.y + (ty - home.y) * e, rot: rot * e, e };
}
// sip timeline (ms from the start): the hands gather in the middle of the keyboard, the mug fades in
// between them on the desk, is lifted to her lower lip, two small sips (cup tips toward her, head dips),
// then everything plays back in reverse.
const SIP = { gather: 450, swap: 700, atMouth: 1250, sip1: [1450, 2000], sip2: [2150, 2700], down: 3000, onDesk: 3550, unswap: 3800, end: 4300 };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (t, a, b) => easeIO(clamp01((t - a) / (b - a)));
function sipT() { return act.kind === 'sip' ? now() - act.t0 : -1; }
function sipBeat() {
  const t = sipT(), pulse = ([a, b]) => (t > a && t < b ? Math.sin((t - a) / (b - a) * Math.PI) : 0);
  return t < 0 ? 0 : Math.max(pulse(SIP.sip1), pulse(SIP.sip2));
}
function sipState() {
  const t = sipT();
  const lift = t < SIP.down ? seg(t, SIP.swap, SIP.atMouth) : 1 - seg(t, SIP.down, SIP.onDesk);   // 0 desk .. 1 mouth
  const mugA = t < SIP.down ? seg(t, SIP.gather, SIP.swap) : 1 - seg(t, SIP.onDesk, SIP.unswap);  // mug opacity
  const gather = t < SIP.down ? seg(t, 0, SIP.gather) : 1 - seg(t, SIP.unswap, SIP.end);          // hands to the middle
  return { t, lift, mugA, gather };
}
function mugPose(st) {
  const m = RIG.props.mug, sc = RIG.props.mugScale, w = m.w * sc, h = m.h * sc, beat = sipBeat();
  const deskX = (restPoint('L').x + restPoint('R').x) / 2, deskY = KB.y + 6 - h / 2 + 30;
  const mouthY = RIG.props.mouthY * CS + OY + head.dy + actHeadDy();
  const holdX = NECK.x + body.x, holdY = mouthY + 12 - RIG.props.rimY * sc + h / 2 - beat * 6;   // rim just under the lower lip
  return { x: deskX + (holdX - deskX) * st.lift, y: deskY + (holdY - deskY) * st.lift, w, h, beat };
}
function drawActProps() {
  if (act.kind !== 'sip' || !img.mug) return;
  const st = sipState();
  if (st.mugA <= 0.01) return;
  const p = mugPose(st);
  ctx.save();
  ctx.globalAlpha = st.mugA;
  ctx.translate(p.x, p.y);
  ctx.rotate(-0.09 * p.beat);                                   // tip toward her while sipping
  ctx.drawImage(img.mug, -p.w / 2, -p.h / 2, p.w, p.h);
  ctx.restore();
}
// typing hands during the sip: they gather at the mug's sides and fade as the painted mug hands fade in
function sipHand(side) {
  const st = sipState(), p = mugPose({ ...st, lift: 0 });
  const home = restPoint(side), gx = p.x + (side === 'L' ? -p.w * 0.36 : p.w * 0.36), gy = KB.y + 40;
  return { x: home.x + (gx - home.x) * st.gather, y: home.y + (gy - home.y) * st.gather, alpha: 1 - st.mugA };
}

// ---------- carried around (window dragged) ----------
const carry = { vx: 0, vy: 0, t: -1e9 };
window.pet.onWinMove((dx, dy) => {
  const k = 1 / Math.max(scale, 0.1);                    // screen px -> art px
  carry.vx += dx * k; carry.vy += dy * k; carry.t = now();
  for (const s of ['L', 'R']) tails[s].v -= dx * k * 0.004 + (s === 'L' ? 1 : -1) * dy * k * 0.002;
  if (!mood.carried) { mood.carried = true; tryTemp('surprised', 700); }
});

// ---------- Claude Code companion ----------
// working: she watches with a small "..." bubble; waiting for you: waves + "!"; done: happy nod; error: sweat
const claude = { state: 'idle', t: 0 };
window.pet.onClaude((type) => {
  const t = now();
  if (type === 'message') { claude.state = 'working'; head.nodUntil = t + 220; }
  else if (type === 'thinking' || type === 'reading') claude.state = 'working';
  else if (type === 'error') { claude.state = 'working'; tryTemp('sweat', 1800); }
  else if (type === 'waiting') { claude.state = 'waiting'; tryTemp('surprised', 1200); wave('R', 1500); }
  else if (type === 'done') { claude.state = 'idle'; tryTemp('happy', 2500); head.nodUntil = t + 260; }
  else if (type === 'done-partial') { head.nodUntil = t + 200; }        // one session done, others still busy
  else if (type === 'idle' || type === 'quit') claude.state = 'idle';
  claude.t = t;
});
function drawClaudeBubble() {
  const t = now();
  if (claude.state === 'working' && t - claude.t > 600000) claude.state = 'idle';     // stale (main process also expires sessions)
  if (claude.state === 'idle' || mood.sleeping) return;
  const x = NECK.x + 300 + body.x, y = NECK.y - 330;
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#6d5a67'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.roundRect(x - 62, y - 36, 124, 72, 34); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x - 70, y + 46, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x - 88, y + 68, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (claude.state === 'working') {
    for (let i = 0; i < 3; i++) {
      const b = Math.max(0, Math.sin(t / 180 - i * 0.9)) * 9;
      ctx.fillStyle = '#b48aa6'; ctx.beginPath(); ctx.arc(x - 30 + i * 30, y + 4 - b, 9, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ctx.fillStyle = '#e0457b'; ctx.font = 'bold 56px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', x, y + 3 + Math.sin(t / 120) * 3);
  }
  ctx.restore();
}

(async () => {
  buildKeys();
  RIG = window.RIG_DATA;
  if (RIG.floatScale) HS = RIG.floatScale;
  NECK = toScene(RIG.neck);
  HIP = { x: NECK.x, y: DESK_Y };
  TIE = { L: toScene(RIG.tie.L), R: toScene(RIG.tie.R) };
  if (RIG.props && RIG.props.mug) loadImg('mug', 'assets/rig/mug_hands.png').catch(() => {});
  const names = ['head', 'tailL', 'tailR', 'torso', ...Object.keys(RIG.faces || {}).map((f) => 'face_' + f),
    ...Object.keys(RIG.gaze || {}).map((g) => 'gaze_' + g)];
  for (const k of Object.keys(RIG.float)) names.push(`float_${k}`);
  await Promise.all(names.map((n) => loadImg(n, `assets/rig/${n}.png`)));
  for (const s of ['L', 'R']) { const r = restPoint(s); Object.assign(hands[s], { gx: r.x, gy: r.y }); }
  if (RIG.tail) loadTailTextures();
  resize();
  requestAnimationFrame(frame);
  setTimeout(() => wave('L', 1600), 700);
})();
