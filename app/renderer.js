window.addEventListener('error', (e) => console.error('uncaught: ' + e.message + ' @' + e.lineno));
// Ame typing pet — renderer.
// Scene space is 1448x1000; the character rig lives in its own 1086x1448 space (assets/rig/rig.json)
// and is placed into the scene with CS/OX/OY. Design notes: ../PLAN.md ("悬空大手设计 v3").
'use strict';

// the window only shows the part of the scene she can ever occupy (tails swing, wave, zzz): x 190..1250
const VX = 190, ART_W = 1060;
let ART_H = 1190, legs = true;              // keyboard on her lap: the knees and stockings show below it (tray 显示腿部 off: 1080, cut at the keyboard)
const DESK_Y = 803;                         // where the body is cut; kept hidden behind the keyboard
const CS = 0.851, OX = 262, OY = -14;       // rig -> scene
let HS = 0.95;                              // floating-hand sprite scale (overridden by rig.floatScale)
const BODY_MAX_X = 60;
const HOVER_Z = 16;                         // resting height of a hand above the keys

const INK = '#1c1522';

const canvas = document.getElementById('c');
// willReadFrequently: false = stay on the GPU. Left unset, Chromium moves the canvas to software rendering for good once
// the click-through probe (opaqueAt) has read it a few times, and every frame then costs about three times the CPU.
const ctx = canvas.getContext('2d', { willReadFrequently: false });
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
const fhair = { x: 0, v: 0 };             // front hair (bangs + side locks): sideways sway of the tips, rig px
const mouse = { x: 724, y: 300, seen: false };   // cursor in art space (from the main process)
const fx = [];                              // transient effects {type, x, y, t0}
const lower = {                             // lower body: last happy / shy wiggle + one spring set per leg
  wigT: -1e9, kickT: -1e9,                  // a = swing angle, q = squash (w / z / wq / zq = tuning, a bit different per leg)
  L: { a: 0, v: 0, q: 0, qv: 0, w: 12, z: 0.45, wq: 15, zq: 0.45 },
  R: { a: 0, v: 0, q: 0, qv: 0, w: 10.5, z: 0.5, wq: 13, zq: 0.5 },
};
const pat = { on: false, last: 0, dir: 0, px: null, revs: [], heartAt: 0, hearts: [] };   // stroking her head
const pressTimes = [];

// ---------- expressions (design: PLAN.md) ----------
// face = which expression patch sits on the head; temp faces override the base one for a while
const FACES = ['blink', 'half', 'focus', 'happy', 'annoyed', 'surprised', 'yandere', 'sleep'];
const mood = {
  face: 'neutral', prev: 'neutral', open: 'neutral', fadeT: 0, temp: null, tempUntil: 0,
  lastKeyT: performance.now(), sleeping: false, bksp: [], undo: [],
  blinkAt: performance.now() + 2500, blinkUntil: 0, doubleBlink: false,
};
// how "strong" a face is: a new temp face may only cut short a running one of the same or lower strength
const FACE_PRI = { sleep: 6, yandere: 5, angry: 5, teary: 5, surprised: 4, dizzy: 4, annoyed: 3, sweat: 3, deadpan: 3,
  happy: 2, wink: 2, smug: 2, sparkle: 2, blush: 2, yawn: 2, sip: 2, stretch: 2, pout: 2, focus: 1, half: 1, neutral: 0, blink: 0 };
const facePri = (f) => FACE_PRI[f] ?? 1;
const TEMP_MIN = 1600;
const FACE_ZH = { neutral: '普通', blink: '眨眼', half: '困倦', focus: '专注', happy: '开心', annoyed: '烦躁', surprised: '惊讶', yandere: '黑化', sleep: '睡着',
  wink: '眨一只眼', smug: '得意', pout: '嘟嘴', teary: '含泪', blush: '害羞', angry: '生气', sparkle: '星星眼', dizzy: '眩晕', deadpan: '面无表情', sweat: '冒汗', yawn: '打哈欠', sip: '喝茶', stretch: '伸懒腰' };                                   // a temp face stays at least this long
function setTemp(face, ms, why) {
  const t = performance.now();
  if (t < mood.tempUntil && mood.temp !== face && facePri(face) < facePri(mood.temp)) return;   // weaker: ignore
  if (['happy', 'sparkle', 'blush'].includes(face) && mood.temp !== face) lower.wigT = t;
  mood.temp = face; mood.tempUntil = t + Math.max(ms, TEMP_MIN); mood.tempWhy = why || face;
}
function recent(arr, t, win) { while (arr.length && t - arr[0] > win) arr.shift(); return arr.length; }

// temp face only if its art exists (the second expression batch may not be installed yet)
const hasFace = (f) => f === 'neutral' || !!(RIG && RIG.faces && RIG.faces[f]) || (KA.on && f in K_FACE);
function tryTemp(face, ms, fallback, why) {
  if (hasFace(face)) setTemp(face, ms, why); else if (fallback) setTemp(fallback, ms, why);
}

// ---------- KAngel form (easter egg): her streamer alter ego ----------
// A pure data swap: while the form is on, img[head|tailL|tailR|torso|face_*] and RIG.faces / gaze / frontHair / faceTop
// point at the KAngel art, so no draw call knows about it (drawRig('torso') just draws her torso). Faces she lacks map
// to the nearest one she has (K_FACE). Triggers: type K A N G E L within 3 s (toggles; a typed switch lasts 3 min),
// tray "天使模式（常驻）" (lock). The change: white flash that peaks at the swap, sparkle burst, surprised -> happy.
// Art: assets/rig/kangel/ (kangel.js = KANGEL_DATA.faces boxes); if it is missing the form is simply unavailable.
const KA = { ready: false, on: false, lock: false, until: 0, pending: null, fxTo: false, flashT: -1e9, swapT: -1e9, id: 0, seq: [], parts: [], img: {}, faces: null, ame: null };
const K_FX = { swap: 300, flash: 800, sparks: 700, hold: 180000 };
const K_WORD = [37, 30, 49, 34, 18, 38];                       // K A N G E L (uiohook keycodes)
const K_IGNORE = new Set([42, 54, 29, 3613, 56, 3640, 3675, 3676, 58]);   // shift ctrl alt win caps: never break the word
const K_FACE = {                                               // her missing faces -> nearest she has ('neutral' = no patch)
  sparkle: 'happy', smug: 'happy', blush: 'happy', stretch: 'happy',
  sleep: 'blink', yawn: 'blink', sip: 'blink',
  dizzy: 'surprised', sweat: 'surprised',
  half: 'neutral', focus: 'neutral', annoyed: 'neutral', angry: 'neutral', pout: 'neutral', deadpan: 'neutral', teary: 'neutral', yandere: 'neutral',
};
const kFace = (n) => (KA.on && !(RIG.faces && RIG.faces[n]) ? K_FACE[n] || 'neutral' : n);
async function loadKangel() {
  const D = window.KANGEL_DATA;
  if (!D || !D.faces) return;
  const load = (n) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = `assets/rig/kangel/${n}.png`; });
  const parts = ['head', 'tailL', 'tailR', 'torso'], fn = Object.keys(D.faces);
  const got = await Promise.all([...parts, ...fn.map((f) => 'face_' + f)].map(load));
  if (parts.some((_, i) => !got[i])) return;                   // incomplete body art: the form stays unavailable
  parts.forEach((n, i) => { KA.img[n] = got[i]; });
  KA.faces = {};
  fn.forEach((f, i) => { const im = got[parts.length + i]; if (im) { KA.img['face_' + f] = im; KA.faces[f] = D.faces[f]; } });
  KA.gaze = null;                                              // eye directions (optional art)
  if (D.gaze) {
    const gd = Object.keys(D.gaze), gi = await Promise.all(gd.map((d) => load('gaze_' + d)));
    if (gi.every(Boolean)) { KA.gaze = {}; gd.forEach((d, i) => { KA.img['gaze_' + d] = gi[i]; KA.gaze[d] = D.gaze[d]; }); }
  }
  KA.ready = true;
}
function swapKForm(on) {
  if (!KA.ready || on === KA.on) return;
  if (on) {
    KA.ame = { img: {}, faces: RIG.faces, gaze: RIG.gaze, frontHair: RIG.frontHair, faceTop: RIG.faceTop };
    for (const n in KA.img) { KA.ame.img[n] = img[n]; img[n] = KA.img[n]; }
    Object.assign(RIG, { faces: KA.faces, gaze: KA.gaze, frontHair: null, faceTop: [] });
    KA.on = true;
  } else {
    for (const n in KA.ame.img) { if (KA.ame.img[n]) img[n] = KA.ame.img[n]; else delete img[n]; }
    Object.assign(RIG, { faces: KA.ame.faces, gaze: KA.ame.gaze, frontHair: KA.ame.frontHair, faceTop: KA.ame.faceTop });
    KA.on = false;
    if (boneTails()) { initTail('L'); initTail('R'); }         // the bone tails slept while she was KAngel: restart them at rest
  }
  gazeDir = null;
}
// start the change (flash now, swap at the flash peak); ms = how long a timed form lasts (0 = until switched back)
function setKForm(on, ms = 0, instant = false) {
  if (!KA.ready) return;
  KA.until = on && ms ? now() + ms : 0;
  if (on === (KA.pending ? KA.pending.on : KA.on)) return;
  if (instant) { KA.pending = null; swapKForm(on); return; }
  const t = now();
  KA.flashT = t; KA.fxTo = on; KA.pending = { on, at: t + K_FX.swap };
}
function kSwapNow(on) {
  swapKForm(on);
  const id = ++KA.id, pal = on ? ['#ffb3d1', '#a8d4ff', '#ffffff', '#ffd6e8'] : ['#ff8fb0', '#d9b3ff', '#ffffff', '#ffc2d6'];
  KA.swapT = now();
  KA.parts = Array.from({ length: 9 }, (_, i) => ({ a: (i + Math.random() * 0.5) / 9 * Math.PI * 2 - 0.3, r: 190 + Math.random() * 170, s: 30 + Math.random() * 26,
    rot: Math.random(), spin: (Math.random() - 0.5) * 3, c: pal[i % pal.length] }));
  mood.tempUntil = 0; setTemp('surprised', 700, '变身');
  setTimeout(() => { if (KA.id === id) { mood.tempUntil = 0; setTemp('happy', 1500, '变身完成'); } }, 700);
  tails.L.v += 2.4; tails.R.v -= 2.4; body.dipV += 30; head.nodUntil = now() + 200;
  for (const s of ['L', 'R']) if (tailSim[s]) tailSim[s].forEach((p, i) => { if (i) { p.px -= (s === 'L' ? -9 : 9) * i / TAIL_N; p.py += 5 * i / TAIL_N; } });
}
function updateKForm(t) {
  const p = KA.pending;
  if (p && t >= p.at) { KA.pending = null; kSwapNow(p.on); }
  else if (KA.on && !KA.lock && KA.until && t > KA.until && !p) setKForm(false);
}
// K-A-N-G-E-L in a row within 3 s (modifiers ignored, OS auto-repeat ignored); only keycodes are compared, nothing is kept
function kFormOnKey(code, down) {
  if (!down || !KA.ready || K_IGNORE.has(code)) return;
  const t = now(), s = KA.seq;
  if (s.length && s[s.length - 1].code === code) return;       // auto-repeat of a held key
  s.push({ code, t }); if (s.length > K_WORD.length) s.shift();
  if (s.length < K_WORD.length || t - s[0].t > 3000 || !s.every((x, i) => x.code === K_WORD[i])) return;
  s.length = 0;
  if (KA.lock) return;                                         // the tray lock wins
  const cur = KA.pending ? KA.pending.on : KA.on;
  setKForm(!cur, cur ? 0 : K_FX.hold);
}
function kStar(x, y, r, rot) {                                 // 4-point sparkle
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = rot + i * Math.PI / 4, d = i % 2 ? r * 0.28 : r; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * d, y + Math.sin(a) * d); }
  ctx.closePath();
}
function drawKForm() {
  const t = now(), e = t - KA.flashT, ps = t - KA.swapT;
  const flash = e >= 0 && e < K_FX.flash, sparks = ps >= 0 && ps < K_FX.sparks;
  if (!flash && !sparks) return;
  const c = toScene([543, 440]); c.x += body.x;                 // middle of her head
  const tint = KA.fxTo ? '170,210,255' : '255,170,205';
  ctx.save();
  if (flash) {
    const a = e < K_FX.swap ? easeIO(e / K_FX.swap) : 1 - easeIO((e - K_FX.swap) / (K_FX.flash - K_FX.swap));
    ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = a; ctx.fillStyle = '#fff';   // whites out only what is drawn (the window stays see-through)
    ctx.fillRect(VX, 0, ART_W, ART_H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(c.x, c.y, 10, c.x, c.y, 540);   // soft glow around her
    g.addColorStop(0, `rgba(255,255,255,${0.8 * a})`); g.addColorStop(0.45, `rgba(${tint},${0.4 * a})`); g.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = g; ctx.fillRect(c.x - 540, c.y - 540, 1080, 1080);
  }
  if (sparks) {
    const p = ps / K_FX.sparks;
    ctx.lineJoin = 'round'; ctx.lineWidth = 6; ctx.shadowColor = `rgba(${tint},.9)`; ctx.shadowBlur = 14;
    for (const s of KA.parts) {
      const r = s.r * (1 - (1 - p) * (1 - p)), sz = s.s * Math.min(1, p / 0.15) * (1 - 0.55 * p);
      ctx.globalAlpha = Math.min(1, (1 - p) * 1.6);
      kStar(c.x + Math.cos(s.a) * r, c.y + Math.sin(s.a) * r * 0.85 - p * 30, sz, s.rot + p * s.spin);
      ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.fillStyle = s.c; ctx.fill();
    }
  }
  ctx.restore();
}

// ---------- time of day / wellbeing ----------
// tests can fake the clock hour (window.__fakeHour) and the length of the work session (fakeSession(min))
const curHour = () => (typeof window.__fakeHour === 'number' ? window.__fakeHour : new Date().getHours());
const lateNight = () => curHour() < 5;      // 00:00-05:00: sleepier, yawns more, dozes off sooner
const ACTIVE_KEY = 'ame.lastActive', AWAY_MS = 4 * 3600e3, ACTIVE_SAVE_MS = 30000;
let lastActiveWall = 0, activeSavedAt = 0, nagOn = true;     // wall clock of the last key press (persisted across restarts)
try { lastActiveWall = Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch {}
function saveActive(force) {
  const w = Date.now();
  if (window.__noPersist || (!force && w - activeSavedAt < ACTIVE_SAVE_MS)) return;
  activeSavedAt = w;
  try { localStorage.setItem(ACTIVE_KEY, String(lastActiveWall)); } catch {}
}
window.addEventListener('beforeunload', () => saveActive(true));
// break reminder: a work session starts with a key and ends after a 5 min pause; nag after 90 min, then every 20 min
const NAG = { after: 90 * 60e3, gap: 5 * 60e3, every: 20 * 60e3, face: 4000, bubble: 6000, fade: 250 };
const NAG_LINES = ['休息一下嘛……', '陪我喝杯茶好不好', '眼睛会累坏的啦', '已经打了好久了诶', '理理我嘛～', '站起来伸个懒腰吧'];
const work = { start: 0, last: 0, nextNag: 0 };
const nag = { text: '', t0: -1e9 };
function fakeSession(min) {                 // self-test: pretend the current work session began `min` minutes ago
  const t = now();
  work.start = t - min * 60e3; work.last = t; work.nextNag = work.start + NAG.after;
}
function showNag(text) {
  const t = now();
  let line = text;
  while (!line) { line = NAG_LINES[Math.floor(Math.random() * NAG_LINES.length)]; if (line === nag.text) line = ''; }
  nag.text = line; nag.t0 = t;
  tryTemp('pout', NAG.face, 'annoyed', '连续工作太久，劝你休息');
}
function updateNag(t) {
  if (!nagOn || mood.sleeping || !work.start || t < work.nextNag) return;
  if (t - work.last > 60000) return;         // she only nags while you are actually typing; a pause waits for the next key
  work.nextNag = t + NAG.every;
  showNag();
}

function moodOnKey(k, t) {
  const idle = t - mood.lastKeyT;
  mood.lastKeyT = t;
  mood.pouted = false;
  const wall = Date.now(), away = lastActiveWall ? wall - lastActiveWall : 0;
  lastActiveWall = wall; saveActive(false);
  if (!work.start || t - work.last >= NAG.gap) { work.start = t; work.nextNag = t + NAG.after; }   // new work session
  work.last = t;
  if (away >= AWAY_MS) { mood.sleeping = false; mood.tempUntil = 0; setTemp('happy', 2000, '久别回来'); setTimeout(() => wave('L', 1600), 400); }   // welcome back
  else if (mood.sleeping) { mood.sleeping = false; mood.tempUntil = 0; setTemp('surprised', 1400, '被吵醒'); setTimeout(() => wave('L', 1400), 500); }  // woken up
  else if (idle > 20000) setTemp('surprised', 1600, '闲了很久突然打字');          // sudden burst
  const ctrl = byCode.get(29)?.down;
  // same key over and over -> deadpan
  mood.repeat = k.label === mood.lastLabel ? (mood.repeat || 1) + 1 : 1;
  mood.lastLabel = k.label;
  if (mood.repeat >= 6 && !ctrl && k.label !== 'Bksp') tryTemp('deadpan', 2000, null, `同一个键连按 ${mood.repeat} 次`);
  // mashing: 4+ keys held at once -> dizzy
  if (keys.filter((x) => x.down).length >= 4) tryTemp('dizzy', 1800, null, '同时按住 4 个键');
  if (k.label === 'Bksp') {
    mood.bksp.push(t);
    if (recent(mood.bksp, t, 6000) >= 10) tryTemp('teary', 3000, 'annoyed', '6 秒内删了 10 次');
    else if (recent(mood.bksp, t, 2000) >= 4) setTemp('annoyed', 2500, '2 秒内连删 4 次');
  }
  if (k.label === 'Esc') { mood.esc = (mood.esc || []); mood.esc.push(t); if (recent(mood.esc, t, 2000) >= 4) tryTemp('angry', 2200, 'annoyed', '连按 Esc'); }
  if (ctrl && k.label === 'Z') {
    mood.undo.push(t);
    const n = recent(mood.undo, t, 3000);
    if (n >= 5) setTemp('yandere', 3000, `3 秒内撤销 ${n} 次`); else if (n >= 3) tryTemp('sweat', 1800, null, `连按撤销 ${n} 次`);
  }
  if (ctrl && k.label === 'C') mood.copyT = t;
  if (ctrl && k.label === 'V' && t - (mood.copyT || -1e9) < 3000) tryTemp('wink', 1600, 'happy', '复制后粘贴');
  if (ctrl && k.label === 'S') tryTemp('smug', 1800, 'happy', 'Ctrl+S 保存');
  if (k.label === 'Enter' && pressTimes.length >= 20) setTemp('happy', 1800, '打完一段按回车');
}

// typing-speed face with hysteresis: goes up at once, comes down only after the speed stayed low for 2 s
const speed = { face: null, lowT: 0 };
function speedFace(t) {
  const k = kpm(), up = k > 320 && hasFace('sparkle') ? 'sparkle' : k > 200 ? 'focus' : null;
  if (up === 'sparkle' || (up === 'focus' && speed.face !== 'sparkle')) { speed.face = up; speed.lowT = 0; return speed.face; }
  const keep = speed.face === 'sparkle' ? k >= 260 : speed.face === 'focus' ? k >= 150 : false;
  if (speed.face && !keep) {
    if (!speed.lowT) speed.lowT = t;
    if (t - speed.lowT > 2000) { speed.face = speed.face === 'sparkle' && k >= 150 ? 'focus' : null; speed.lowT = 0; }
  } else speed.lowT = 0;
  return speed.face;
}
function baseFace(t) {
  const why = (w) => { mood.baseWhy = w; };
  if (t < mood.tempUntil) { why(mood.tempWhy); return mood.temp; }
  const idle = t - mood.lastKeyT;
  if (idle > (lateNight() ? 90000 : 180000)) { mood.sleeping = true; why(`${Math.round(idle / 1000)} 秒没打字，睡着了`); return 'sleep'; }
  if (idle > 60000) { why('闲置超过 1 分钟'); return 'half'; }
  if (idle > 30000 && idle < 33000 && !mood.pouted && hasFace('pout')) { why('被冷落 30 秒'); return 'pout'; }   // ignored for a while
  if (idle >= 33000) mood.pouted = true;
  const sf = speedFace(t);
  if (sf) { why(`打字速度 ${kpm()} 键/分`); return sf; }
  // watching Claude work with a focused face -- unless you are moving the mouse, then she follows it
  if (claude.state === 'working' && idle > 3000 && now() - (mouse.movedAt || 0) > 4000) { why('在看 Claude 干活'); return 'focus'; }
  const hr = curHour();
  if (hr >= 2 && hr < 5) { why('凌晨 2–5 点'); return 'yandere'; }
  if (hr < 2 && idle > 5000) { why('过了午夜，犯困'); return 'half'; }      // past midnight: sleepy eyes once you stop typing
  why('');
  return 'neutral';
}

function updateMood(t) {
  updateKForm(t);
  let f = baseFace(t);
  // hold: a face that just appeared stays at least HOLD ms, unless the newcomer is stronger (or she falls asleep)
  const HOLD = 1200;
  if (f !== mood.open && f !== 'sleep' && t - (mood.openT || 0) < HOLD && facePri(f) <= facePri(mood.open)) { f = mood.open; }
  else if (f !== mood.open) { startPop(mood.open, f, t); mood.open = f; mood.openT = t; mood.why = mood.baseWhy; }   // the open face changes here
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
    // (the pop starts above when the open face changes; blink <-> open never pops)
  }
}

// face-change "pop": instant pixel switch + a short squash/stretch, nod or tilt, and a hair kick (blinks never pop)
const POP_KIND = { surprised: 'up', sparkle: 'up', angry: 'up', teary: 'down', half: 'down', sleep: 'down', pout: 'down', sweat: 'down', yawn: 'down', deadpan: 'down' };
const POP_GAIN = { neutral: 0.6, focus: 0.7, yandere: 0.7 };
const facePop = { t0: -1e9, dur: 300, g: 1, kind: 'tilt', dir: 1 };
function startPop(from, to, t) {
  if (t - facePop.t0 < 200) return;                                     // fast typing: don't restart the pop
  const slow = from === 'sleep' || to === 'sleep' || from === 'half' || to === 'half';   // long states: gentler, slower
  const g = (POP_GAIN[to] || 1) * (slow ? 0.55 : 1), kind = POP_KIND[to] || 'tilt', nd = kind === 'up' ? -1 : kind === 'down' ? 1 : 0;
  facePop.t0 = t; facePop.dur = slow ? 520 : 300; facePop.g = g; facePop.kind = kind; facePop.dir = -facePop.dir;
  const d = facePop.dir, tk = nd ? -nd * 1.1 : -d * 0.9;
  tails.L.v += tk * g; tails.R.v += tk * g; fhair.v += (nd ? d * 45 : -d * 70) * g;
}
// current pop offsets (null when idle): squash first, then stretch, settle; one smooth hump for nod / tilt
function popVals(t) {
  const u = window.__popU !== undefined ? window.__popU : (t - facePop.t0) / facePop.dur;   // __popU: demo freeze
  if (!(u >= 0 && u < 1)) return null;
  const g = facePop.g, k = facePop.kind, w = -Math.sin(u * 2 * Math.PI) * (1 - u * u), h = Math.sin(Math.PI * u) * (1 - 0.4 * u);
  return { sy: 1 + 0.04 * g * w, sx: 1 - 0.025 * g * w, dy: (k === 'up' ? -6 : k === 'down' ? 7 : 0) * g * h, rot: (k === 'tilt' ? 0.04 : 0.012) * g * h * facePop.dir };
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
  kFormOnKey(code, down);
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
  if (act.kind) stopAct(); else act.next = Math.max(act.next, t + (lateNight() ? 12000 : 20000));
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
  stepLegs(dt);

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
  stepEye(gx, gy, dt);
  const idleRot = mood.sleeping ? 0.09 : mood.face === 'half' ? 0.04 : Math.sin(t / 2100) * 0.02 + head.gx * 0.075;
  const patRot = pat.on ? Math.max(-0.06, Math.min(0.06, (mouse.x - NECK.x - body.x) / 2500)) : 0;
  head.rot = ease(head.rot, lookDown ? side * 0.07 : idleRot + patRot, mood.sleeping ? 1.5 : 8, dt);
  head.vrot = (head.rot - pr) / Math.max(dt, 1e-3);
  head.dy = ease(head.dy, (pat.on ? 9 : 0) + (lookDown ? 12 : 0) + (t < head.nodUntil ? 16 : 0) + (mood.sleeping ? 14 : mood.face === 'half' ? 5 : 0) + head.gy * 7, mood.sleeping ? 2 : 14, dt);

  // twin tails: damped springs kicked by body sway, dips and head turns
  for (const s of ['L', 'R']) {
    const tl = tails[s];
    const force = -body.vx * 0.0012 - head.vrot * 0.35 - body.dipV * 0.0006 + Math.sin(t / 900 + (s === 'L' ? 0 : 1.7)) * 0.02;
    tl.v += (-60 * tl.a - 7 * tl.v + force * 60) * dt;
    tl.a += tl.v * dt;
    tl.a = Math.max(-0.45, Math.min(0.45, tl.a));
  }
  // front hair: a quicker, lighter spring than the tails; hangs a little against the head tilt (gravity)
  {
    const kick = (-body.vx * 0.0012 - head.vrot * 0.35 - body.dipV * 0.0006) * 60 + Math.sin(t / 1300) * 0.8;
    const target = -head.rot * 110;
    fhair.v += (-90 * (fhair.x - target) - 16 * fhair.v + kick * 90) * dt;
    fhair.x += fhair.v * dt;
    fhair.x = Math.max(-14, Math.min(14, fhair.x));
  }
  if (boneTails()) { stepTail('L', dt); stepTail('R', dt); }
  updateAct();
  updateNag(t);
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
// lower body (below the keyboard): squashes a little with each keystroke (body.dip), dangles behind
// when she is carried around, and wiggles for a moment when she is happy or shy. The seam with the
// upper body is hidden behind the keyboard.
const LEG_FLOOR = () => OY + 1398 * CS;
// Two legs = two underdamped spring sets (swing angle a, squash q), split at the knee gap. Drag velocity pulls
// the legs behind (they swing back with ~20% overshoot), key dips squash them softly, a wiggle is an impulse.
const LEG_GAP = () => OX + 543 * CS;           // knee gap (rig x 543)
function stepLegs(dt) {
  if (lower.wigT !== lower.kickT) {            // happy / shy wiggle starts: opposite kicks, then it rings out
    lower.kickT = lower.wigT; lower.kick2 = true;
    lower.L.v += 1.0; lower.R.v -= 0.85; lower.L.qv += 1.0; lower.R.qv += 0.8;
  } else if (lower.kick2 && now() - lower.wigT > 330) {   // a smaller answering kick the other way
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
    if (Math.abs(s.a) < 1e-4 && Math.abs(s.v) < 2e-3 && Math.abs(ta) < 1e-4) s.a = s.v = 0;   // settle exactly at rest
    if (Math.abs(s.q) < 1e-4 && Math.abs(s.qv) < 2e-3 && Math.abs(tq) < 1e-4) s.q = s.qv = 0;
  }
}
function drawLowerBody() {
  const gx = LEG_GAP(), top = CLIP_Y, floor = LEG_FLOOR(), L = lower.L, R = lower.R;
  if (!(L.a || L.q || R.a || R.q)) {           // at rest: one plain draw, identical to the static torso
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, 99999, 99999); ctx.clip(); drawRig('torso'); ctx.restore(); return;
  }
  for (const side of [-1, 1]) {
    const s = side < 0 ? L : R;
    ctx.save(); ctx.beginPath();
    if (side < 0) ctx.rect(0, top, gx + 2, 99999); else ctx.rect(gx, top, 99999, 99999);   // 2px overlap: no AA seam
    ctx.clip();
    const px = gx + side * 30;                 // hip pivot just below the seam line, on this side
    ctx.translate(px, top); ctx.rotate(s.a); ctx.translate(-px, -top);
    ctx.translate(gx, floor); ctx.scale(1 + s.q * 0.6, 1 - s.q); ctx.translate(-gx, -floor);
    drawRig('torso'); ctx.restore();
  }
}
function drawHearts() {                      // little hearts popping out of her head while patted
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
const drawRig = (name) => ctx.drawImage(img[name], OX, OY, RIG.size[0] * CS, RIG.size[1] * CS);

function drawFacePatch(name, alpha) {
  name = kFace(name);
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
// Smooth gaze: instead of swapping between the 8 painted eyes, one iris disc slides under the lids (three layers:
// eye white, iris, lid lines -- assets/rig/gaze_smooth.js). The iris passes through the painted positions, so at the
// 8 directions it looks like the painted patch. Needs the layer art; without it (and for KAngel) the eyes snap as before.
const GS = window.GAZE_SMOOTH;
const eye = { x: 0, y: 0, amt: 0, cv: null };          // iris offset from rest (rig px), 0..1 how far it is turned
const EYE_RES = 2;                                      // the eye is composed at 2x so the iris can sit between pixels
const smoothGaze = () => !!(GS && img.gaze_white && img.gaze_iris && img.gaze_lid && !KA.on);
// where the iris should be for a gaze vector (gx, gy in -1..1): direction between the two nearest painted offsets,
// distance grows with how far the cursor is from her face (full turn from 0.6 on)
function gazeOffset(gx, gy) {
  const m = Math.hypot(gx, gy);
  if (m < 1e-3) return { x: 0, y: 0, amt: 0 };
  const ang = (Math.atan2(gy, gx) / (Math.PI / 4) + 8) % 8, i = Math.floor(ang) % 8, f = ang - Math.floor(ang);
  const a = GS.offset[GAZE_DIRS[i]], b = GS.offset[GAZE_DIRS[(i + 1) % 8]], amt = smooth(Math.min(1, m / 0.6));
  return { x: (a[0] + (b[0] - a[0]) * f) * amt, y: (a[1] + (b[1] - a[1]) * f) * amt, amt };
}
function stepEye(gx, gy, dt) {                          // eyes are quicker than the head: they get there first
  if (!smoothGaze()) return;
  const o = gazeOffset(gx, gy);
  const k = GS.speed || 16;
  eye.x = ease(eye.x, o.x, k, dt); eye.y = ease(eye.y, o.y, k, dt); eye.amt = ease(eye.amt, o.amt, k, dt);
}
function drawSmoothGaze() {
  if (!eye.cv) { eye.cv = document.createElement('canvas'); eye.cv.width = GS.w * EYE_RES; eye.cv.height = GS.h * EYE_RES; }
  const key = eye.x.toFixed(2) + ',' + eye.y.toFixed(2) + ',' + eye.amt.toFixed(3);
  if (key !== eye.key) { eye.key = key; composeEye(); }   // the cursor is still most of the time: reuse the composed eye
  ctx.drawImage(eye.cv, OX + GS.x * CS, OY + GS.y * CS, GS.w * CS, GS.h * CS);
}
function composeEye() {
  const g = eye.cv.getContext('2d');
  g.setTransform(EYE_RES, 0, 0, EYE_RES, 0, 0);
  g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, GS.w, GS.h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img.gaze_white, 0, 0, GS.w, GS.h);
  g.globalCompositeOperation = 'source-atop';           // the iris only shows inside the eye opening
  // Foreshortening, as painted: the side of the iris she looks toward is squeezed (the rim comes in to ~2/3 of its
  // distance from the pupil at a full sideways turn), the far side stays (grows a little). An affine map cannot be
  // lopsided, so the disc is drawn as two halves split at the pupil, each scaled along the gaze axis by its own
  // factor; points on the split line do not move under either, so the halves meet without a seam.
  const d = Math.hypot(eye.x, eye.y), turn = Math.min(1, d / GS.turn), phi = d > 1e-3 ? Math.atan2(eye.y, eye.x) : 0;
  const u = 1 + GS.restGrow * (1 - eye.amt);            // the painted neutral iris is a touch bigger than the turned ones
  const px = GS.pupil[0] + eye.x, py = GS.pupil[1] + eye.y;
  for (const [s, x0] of [[1 - GS.squeeze * turn, -0.5], [1 + GS.stretch * turn, -200]]) {   // near half, far half
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
// front hair (bangs + side locks, cut out of the head): drawn over the face with a shear about its root line,
// so the roots stay put (the cut never shows) and the tips swing sideways by fhair.x
function drawFrontHair() {
  const fh = RIG.frontHair;
  if (!fh || !img.front_hair) return;
  const y0 = OY + fh.y0 * CS, k = fhair.x / (fh.y1 - fh.y0);
  ctx.save();
  ctx.translate(0, y0); ctx.transform(1, 0, k, 1, 0, 0); ctx.translate(0, -y0);
  drawRig('front_hair');
  ctx.restore();
}
// the bits of an expression that sit on top of the bangs (brows, sweat drop, shading)
function drawFaceTop() {
  const k = mood.face;
  if (!RIG.faceTop || !RIG.faceTop.includes(k) || !img['face_' + k + '_top']) return;
  const f = RIG.faces[k];
  ctx.drawImage(img['face_' + k + '_top'], OX + f.x * CS, OY + f.y * CS, f.w * CS, f.h * CS);
}

// break-reminder speech bubble above her head (scene space, kept inside the visible canvas)
function drawNagBubble() {
  const p = now() - nag.t0;
  if (p < 0 || p > NAG.bubble || !nag.text) return;
  const a = Math.min(1, p / NAG.fade, (NAG.bubble - p) / NAG.fade), e = easeIO(a);
  ctx.save();
  ctx.globalAlpha = e;
  ctx.font = '40px "Microsoft YaHei", "Segoe UI", sans-serif';
  const bw = Math.min(ART_W - 40, Math.ceil(ctx.measureText(nag.text).width) + 72), bh = 84;
  const hx = NECK.x + body.x, bob = Math.sin(p / 420) * 3 + (1 - e) * 10;
  const bx = Math.max(VX + 12, Math.min(VX + ART_W - 12 - bw, hx - bw / 2)), by = 12 + bob;
  const tx = Math.max(bx + 44, Math.min(bx + bw - 44, hx)), tipY = by + bh + 30;
  ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#c2255f'; ctx.fillStyle = '#ffffff';
  roundRect(bx, by, bw, bh, 34); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tx - 15, by + bh); ctx.lineTo(hx > tx + 10 ? tx + 10 : hx < tx - 10 ? tx - 10 : hx, tipY); ctx.lineTo(tx + 15, by + bh);
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tx - 13, by + bh); ctx.lineTo(tx + 13, by + bh);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.stroke();      // hide the bubble outline under the tail
  ctx.fillStyle = '#4a2338'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(nag.text, bx + bw / 2, by + bh / 2 + 2);
  ctx.restore();
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

const boneTails = () => RIG && RIG.tail && tailTex.L && !KA.on;   // KAngel has plain rotating tails (tailL / tailR)
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
  ctx.fillStyle = 'rgba(30,20,40,.75)'; ctx.fillRect(10, 10, 760, 156);
  ctx.fillStyle = '#fff'; ctx.font = '34px sans-serif';
  ctx.fillText(`KPM ${kpm()}  key ${lastKey}`, 24, 54);
  ctx.fillText(`face ${mood.face}  L ${hands.L.state}  R ${hands.R.state}`, 24, 100);
  ctx.fillText(`${FACE_ZH[mood.open] || mood.open} ← ${mood.why || '默认'}`, 24, 146);
}

// Windows 每块屏的缩放可以不同，把她拖过去 devicePixelRatio 就变了；drawFrame 每帧
// 都用最新的 dpr 算 transform，所以后备画布必须跟着重建，否则画出来的比画布大（裁切）或小（缩在角里）。
let sizedForDpr = 0;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  sizedForDpr = dpr;
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
  if (dpr !== sizedForDpr) resize();                      // 被拖到了缩放不同的屏幕上
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -VX * scale * dpr, 0);
  ctx.clearRect(VX, 0, ART_W, ART_H);
  ctx.imageSmoothingQuality = 'high';

  if (kbOnly) { drawKeyboard(ctx, scale * dpr, 0); return; }
  drawKeyboardShadow(ctx, breathPhase);
  drawTails();
  withCharacterClip(() => drawRig('torso'));
  // keyboard on her lap: the lower body (skirt, knees, stockings) is drawn below the keyboard's clip line and
  // stays put (no breathing / lean); the seam between the two halves is hidden behind the keyboard
  if (legs) drawLowerBody();
  drawKeyboard(ctx, scale * dpr, breathPhase);
  withCharacterClip(() => { applyHead(); drawRig('head'); drawFace(); drawFrontHair(); drawFaceTop(); });
  drawHandShadow(hands.L); drawHandShadow(hands.R);
  for (const sd of topHand === 'L' ? ['R', 'L'] : ['L', 'R']) drawHand(sd);
  drawActProps();
  drawEffects();
  drawZzz();
  drawHearts();
  drawNagBubble();
  drawKForm();
  drawPchan();
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
  pch.target = overPchan(e) ? 1 : 0;
  canvas.style.cursor = overGrip ? 'nwse-resize' : pch.target ? 'pointer' : 'default';
});
document.addEventListener('mouseleave', () => { pch.target = 0; if (!drag && !sizing) { hover = false; overGrip = false; setHit(false); } });

let lastClickAt = 0;
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
    tryTemp('blush', 2000, 'happy', '被点了一下头'); head.nodUntil = now() + 200;                 // a click (no drag) on her head: pat
  }
  if (!wasSizing && moved < 4) {
    if (downAt && overPchan({ offsetX: downAt.ox, offsetY: downAt.oy })) { pch.hop = now(); window.pet.panelExpand(); }   // click on P-chan: open the panel
    else {                               // a double click (two clicks without dragging) anywhere on her: open the Windose web desktop
      const t = performance.now();
      if (t - lastClickAt < 400) { lastClickAt = 0; window.pet.openDashboard(); } else lastClickAt = t;
    }
  }
  downAt = null; drag = null; sizing = null;
});

// ---------- P-chan (ピーちゃん): stands in for the Claude panel while it is collapsed ----------
// Sits on the floor at Ame's right (past the keyboard's right end). Main process tells us the panel state.
// sleep = no sessions, alert = unread lines or a session waiting for you (bounce + red badge), idle = otherwise.
const PCH = { x: 1105, y: 1180, h: 118 };            // bottom-centre of the sprite (art px, y = ART_H - 10) and its height (the game's pixel pien-cat head)
const panel = { collapsed: false, unread: 0, waiting: false, n: 0 };
const pch = { target: 0, hover: 0, hop: -1e9, blinkAt: now() + 2200, blinkUntil: 0 };
window.pet.onPanel((s) => Object.assign(panel, s));
const pchState = () => (panel.n === 0 ? 'sleep' : panel.unread > 0 || panel.waiting ? 'alert' : 'idle');
function pchRect() {
  const im = img.pchan_idle;
  if (!im) return null;
  const w = PCH.h * im.width / im.height;
  return { x: PCH.x - w / 2, y: PCH.y - PCH.h, w, h: PCH.h };
}
function overPchan(e) {                               // e.offsetX / offsetY in CSS px; the pixel test (opaqueAt) is done by the caller's `hit`
  const r = pchRect();
  if (!panel.collapsed || !r) return false;
  const x = e.offsetX / scale + VX, y = e.offsetY / scale;
  return x >= r.x && x < r.x + r.w && y >= r.y - 20 && y < r.y + r.h + 10;
}
function drawPchan() {
  const r = pchRect();
  if (!panel.collapsed || !r) return;
  const st = pchState(), t = now();
  let name = st;
  if (st === 'idle') {
    if (t >= pch.blinkAt) { pch.blinkUntil = t + 130; pch.blinkAt = t + 2500 + Math.random() * 3500; }
    if (t < pch.blinkUntil) name = 'blink';
  }
  const im = img['pchan_' + name];
  if (!im) return;
  pch.hover += (pch.target - pch.hover) * 0.25;
  const br = Math.sin(t / (st === 'sleep' ? 1100 : 750));                // breathing squash, anchored at the floor
  let sy = 1 + br * (st === 'sleep' ? 0.025 : 0.016), dy = 0;
  const rot = st === 'sleep' ? 0 : Math.sin(t / 1700) * 0.018;             // slow sway (the sprite has no separate ears / tail)
  if (st === 'alert') {                                                    // small hop every ~2 s, squash on landing
    const p = (t % 2000) / 2000;
    if (p < 0.3) dy = -22 * Math.sin(Math.PI * p / 0.3);
    else if (p < 0.4) sy *= 1 - 0.08 * Math.sin(Math.PI * (p - 0.3) / 0.1);
  }
  const hp = (t - pch.hop) / 380;
  if (hp >= 0 && hp < 1) dy -= 16 * Math.sin(Math.PI * hp);                // clicked: hop
  const hs = 1 + 0.08 * pch.hover, sx = (1 - (sy - 1) * 0.6) * hs;
  ctx.save();
  ctx.fillStyle = 'rgba(30,20,40,0.16)';                                   // contact shadow shrinks while she is up
  ctx.beginPath(); ctx.ellipse(PCH.x, PCH.y - 3, r.w * 0.3 * (1 + dy / 150), 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(PCH.x, PCH.y + dy); ctx.rotate(rot); ctx.scale(sx, sy * hs);
  ctx.imageSmoothingEnabled = false;                                       // pixel art: keep it crisp
  ctx.drawImage(im, -r.w / 2, -r.h, r.w, r.h);
  ctx.restore();
  if (st === 'sleep') {                                                    // a tiny drifting z
    ctx.save(); ctx.font = 'bold 34px "Segoe UI", sans-serif'; ctx.lineWidth = 6; ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      const p = ((t / 2600) + i / 2) % 1;
      ctx.globalAlpha = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
      const x = PCH.x + 52 + p * 22, y = PCH.y - r.h * 0.55 - p * 46, z = 0.7 + p * 0.5;
      ctx.save(); ctx.translate(x, y); ctx.scale(z, z); ctx.strokeStyle = '#fff'; ctx.strokeText('z', 0, 0); ctx.fillStyle = '#6d5a67'; ctx.fillText('z', 0, 0); ctx.restore();
    }
    ctx.restore();
  }
  if (st === 'alert' && panel.unread > 0) {                                // red unread count above her right ear
    const bx = PCH.x + r.w * 0.36, by = PCH.y + dy - r.h * 0.84, txt = panel.unread > 9 ? '9+' : String(panel.unread);
    ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#e0243d';
    ctx.beginPath(); ctx.arc(bx, by, 25, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 32px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx, by + 2); ctx.restore();
  }
}

function drawGrip() {                              // three diagonal ticks on the keyboard corner, while hovering her
  if (!hover && !sizing) return;
  const dpr = window.devicePixelRatio || 1, g = gripCss();
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = overGrip || sizing ? 'rgba(210,80,140,.95)' : 'rgba(110,90,105,.6)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const o of [5, 10, 15]) { ctx.beginPath(); ctx.moveTo(g.x + 8, g.y + 8 - o); ctx.lineTo(g.x + 8 - o, g.y + 8); ctx.stroke(); }
  ctx.restore();
}

let mouseFrozen = false;                     // self-test only: ignore the real cursor
window.pet.onMouse((m) => {
  if (mouseFrozen) return;
  if (Math.hypot(m.x - mouse.x, m.y - mouse.y) > 3) mouse.movedAt = now();
  mouse.x = m.x; mouse.y = m.y; mouse.seen = true;
  detectPat(m);
});
// stroking her head: the cursor (no button) goes back and forth over the top of her head a few times
function detectPat(m) {
  const t = now(), hx = NECK.x + body.x;
  const onHead = !drag && Math.abs(m.x - hx) < 240 && m.y > 60 && m.y < NECK.y - 230;
  if (!onHead) { pat.px = null; if (pat.on && t - pat.last > 700) pat.on = false; return; }
  if (pat.px !== null) {
    const dx = m.x - pat.px;
    if (Math.abs(dx) > 5) {
      const d = Math.sign(dx);
      if (pat.dir && d !== pat.dir) pat.revs.push(t);
      pat.dir = d;
      fhair.v += dx * 1.2;                                  // the hand drags the bangs along
    }
  }
  pat.px = m.x;
  pat.revs = pat.revs.filter((r) => t - r < 1500);
  if (pat.revs.length >= 3) {
    pat.on = true; pat.last = pat.revs[pat.revs.length - 1];
    if (!mood.sleeping) tryTemp('happy', 1600, 'blush', '被摸头');
    if (t - pat.heartAt > 380) { pat.heartAt = t; pat.hearts.push({ x: hx + (Math.random() - 0.5) * 220, y: 150 + Math.random() * 60, t0: t, ph: Math.random() * 6 }); }
  }
  if (pat.on && t - pat.last > 700) pat.on = false;
}

window.pet.onConfig((c) => {
  scale = c.scale; debug = c.debug; nagOn = c.breakNag !== false;
  if (c.facing && c.facing !== facing) { facing = c.facing; buildKeys(); }
  if (c.kbTheme && c.kbTheme !== KB_PAINT.theme) loadKbTheme(c.kbTheme);
  const kl = !!c.kangel;                       // tray lock "天使模式（常驻）"
  if (kl !== KA.lock) { KA.lock = kl; if (KA.ready) { if (kl) setKForm(true, 0); else if (!KA.until) setKForm(false); } }
  legs = c.legs !== false; ART_H = legs ? 1190 : 1080; PCH.y = ART_H - 10;   // same heights as main.js artH()
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
    setTimeout(() => { if (act.kind === 'sip' && act.t0 === t0) tryTemp('sip', SIP.down - SIP.atMouth, 'happy', '喝茶'); }, SIP.atMouth);
  } else tryTemp(face[0], ACTS[kind], face[1], '闲着的小动作');
}
function stopAct() {
  if (act.kind) { act.kind = null; mood.tempUntil = 0; }
  act.next = now() + (lateNight() ? 12000 + Math.random() * 13000 : 25000 + Math.random() * 35000);
}
function updateAct() {
  const t = now(), idle = t - mood.lastKeyT;
  if (act.kind && t - act.t0 > act.dur) stopAct();
  if (!act.kind && idle > 6000 && t > act.next && !mood.sleeping) {
    startAct(Math.random() < (lateNight() ? 0.8 : 0.5) ? 'yawn' : 'sip');   // late at night: mostly yawns
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
  fhair.v -= dx * k * 0.5;
  if (!mood.carried) { mood.carried = true; tryTemp('surprised', 1600, null, '被拖着走'); }
});

// ---------- Claude Code companion ----------
// working: she watches with a small "..." bubble; waiting for you: waves + "!"; done: happy nod; error: sweat
const claude = { state: 'idle', t: 0 };
window.pet.onClaude((type) => {
  const t = now();
  if (type === 'message') { claude.state = 'working'; head.nodUntil = t + 220; }
  else if (type === 'thinking' || type === 'reading') claude.state = 'working';
  else if (type === 'error') { claude.state = 'working'; tryTemp('sweat', 1800, null, 'Claude 报错了'); }
  else if (type === 'waiting') { claude.state = 'waiting'; tryTemp('surprised', 1600, null, 'Claude 在等你确认'); wave('R', 1500); }
  else if (type === 'done') { claude.state = 'idle'; tryTemp('happy', 2500, null, 'Claude 做完了'); head.nodUntil = t + 260; }
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
  if (GS) for (const n of ['gaze_white', 'gaze_iris', 'gaze_lid']) loadImg(n, `assets/rig/${n}.png`).catch(() => {});   // smooth gaze (optional art)
  const names = ['head', 'tailL', 'tailR', 'torso', ...Object.keys(RIG.faces || {}).map((f) => 'face_' + f),
    ...Object.keys(RIG.gaze || {}).map((g) => 'gaze_' + g), ...(RIG.faceTop || []).map((f) => 'face_' + f + '_top'),
    ...(RIG.frontHair ? ['front_hair'] : [])];
  for (const k of Object.keys(RIG.float)) names.push(`float_${k}`);
  await Promise.all(names.map((n) => loadImg(n, `assets/rig/${n}.png`)));
  await loadKangel().catch(() => {});
  if (KA.lock) setKForm(true, 0, true);
  for (const s of ['L', 'R']) { const r = restPoint(s); Object.assign(hands[s], { gx: r.x, gy: r.y }); }
  for (const s of ['idle', 'alert', 'sleep', 'blink']) loadImg('pchan_' + s, `assets/pchan/pchan_${s}.png`).catch(() => {});   // P-chan (optional art)
  if (RIG.tail) loadTailTextures();
  resize();
  requestAnimationFrame(frame);
  setTimeout(() => wave('L', 1600), 700);
})();
