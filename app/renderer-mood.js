// Ame typing pet — expression state machine, KAngel alter-ego form, and time-of-day / break-nag wellbeing.
'use strict';

const FACES = ['blink', 'half', 'focus', 'happy', 'annoyed', 'surprised', 'yandere', 'sleep'];
const mood = {
  face: 'neutral', prev: 'neutral', open: 'neutral', fadeT: 0, temp: null, tempUntil: 0,
  lastKeyT: performance.now(), sleeping: false, bksp: [], undo: [],
  blinkAt: performance.now() + 2500, blinkUntil: 0, doubleBlink: false,
};
const FACE_PRI = {
  sleep: 6, yandere: 5, angry: 5, teary: 5, surprised: 4, dizzy: 4, annoyed: 3, sweat: 3, deadpan: 3,
  happy: 2, wink: 2, smug: 2, sparkle: 2, blush: 2, yawn: 2, sip: 2, stretch: 2, pout: 2, focus: 1, half: 1, neutral: 0, blink: 0,
};
const facePri = (f) => FACE_PRI[f] ?? 1;
const TEMP_MIN = 1600;
const FACE_ZH = {
  neutral: '普通', blink: '眨眼', half: '困倦', focus: '专注', happy: '开心', annoyed: '烦躁', surprised: '惊讶', yandere: '黑化', sleep: '睡着',
  wink: '眨一只眼', smug: '得意', pout: '嘟嘴', teary: '含泪', blush: '害羞', angry: '生气', sparkle: '星星眼', dizzy: '眩晕', deadpan: '面无表情', sweat: '冒汗', yawn: '打哈欠', sip: '喝茶', stretch: '伸懒腰',
};

function setTemp(face, ms, why) {
  const t = performance.now();
  if (t < mood.tempUntil && mood.temp !== face && facePri(face) < facePri(mood.temp)) return;
  if (['happy', 'sparkle', 'blush'].includes(face) && mood.temp !== face) lower.wigT = t;
  mood.temp = face; mood.tempUntil = t + Math.max(ms, TEMP_MIN); mood.tempWhy = why || face;
}
function recent(arr, t, win) { while (arr.length && t - arr[0] > win) arr.shift(); return arr.length; }

// ---------- KAngel form (easter egg): her streamer alter ego ----------
const KA = { ready: false, on: false, lock: false, until: 0, pending: null, fxTo: false, flashT: -1e9, swapT: -1e9, id: 0, seq: [], parts: [], img: {}, faces: null, ame: null };
const K_FX = { swap: 300, flash: 800, sparks: 700, hold: 180000 };
const K_WORD = [37, 30, 49, 34, 18, 38]; // K A N G E L
const K_IGNORE = new Set([42, 54, 29, 3613, 56, 3640, 3675, 3676, 58]);
const K_FACE = {
  sparkle: 'happy', smug: 'happy', blush: 'happy', stretch: 'happy',
  sleep: 'blink', yawn: 'blink', sip: 'blink',
  dizzy: 'surprised', sweat: 'surprised',
  half: 'neutral', focus: 'neutral', annoyed: 'neutral', angry: 'neutral', pout: 'neutral', deadpan: 'neutral', teary: 'neutral', yandere: 'neutral',
};
const kFace = (n) => (KA.on && !(RIG.faces && RIG.faces[n]) ? K_FACE[n] || 'neutral' : n);
const hasFace = (f) => f === 'neutral' || !!(RIG && RIG.faces && RIG.faces[f]) || (KA.on && f in K_FACE);

function tryTemp(face, ms, fallback, why) {
  if (hasFace(face)) setTemp(face, ms, why); else if (fallback) setTemp(fallback, ms, why);
}

async function loadKangel() {
  const D = window.KANGEL_DATA;
  if (!D || !D.faces) return;
  const load = (n) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = `assets/rig/kangel/${n}.png`; });
  const parts = ['head', 'tailL', 'tailR', 'torso'], fn = Object.keys(D.faces);
  const got = await Promise.all([...parts, ...fn.map((f) => 'face_' + f)].map(load));
  if (parts.some((_, i) => !got[i])) return;
  parts.forEach((n, i) => { KA.img[n] = got[i]; });
  KA.faces = {};
  fn.forEach((f, i) => { const im = got[parts.length + i]; if (im) { KA.img['face_' + f] = im; KA.faces[f] = D.faces[f]; } });
  KA.gaze = null;
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
    if (boneTails()) { initTail('L'); initTail('R'); }
  }
  gazeDir = null;
}

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
  KA.parts = Array.from({ length: 9 }, (_, i) => ({
    a: (i + Math.random() * 0.5) / 9 * Math.PI * 2 - 0.3, r: 190 + Math.random() * 170, s: 30 + Math.random() * 26,
    rot: Math.random(), spin: (Math.random() - 0.5) * 3, c: pal[i % pal.length],
  }));
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

function kFormOnKey(code, down) {
  if (!down || !KA.ready || K_IGNORE.has(code)) return;
  const t = now(), s = KA.seq;
  if (s.length && s[s.length - 1].code === code) return;
  s.push({ code, t }); if (s.length > K_WORD.length) s.shift();
  if (s.length < K_WORD.length || t - s[0].t > 3000 || !s.every((x, i) => x.code === K_WORD[i])) return;
  s.length = 0;
  if (KA.lock) return;
  const cur = KA.pending ? KA.pending.on : KA.on;
  setKForm(!cur, cur ? 0 : K_FX.hold);
}

function kStar(x, y, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + i * Math.PI / 4, d = i % 2 ? r * 0.28 : r;
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  ctx.closePath();
}

function drawKForm() {
  const t = now(), e = t - KA.flashT, ps = t - KA.swapT;
  const flash = e >= 0 && e < K_FX.flash, sparks = ps >= 0 && ps < K_FX.sparks;
  if (!flash && !sparks) return;
  const c = toScene([543, 440]); c.x += body.x;
  const tint = KA.fxTo ? '170,210,255' : '255,170,205';
  ctx.save();
  if (flash) {
    const a = e < K_FX.swap ? easeIO(e / K_FX.swap) : 1 - easeIO((e - K_FX.swap) / (K_FX.flash - K_FX.swap));
    ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = a; ctx.fillStyle = '#fff';
    ctx.fillRect(VX, 0, ART_W, ART_H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(c.x, c.y, 10, c.x, c.y, 540);
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
const curHour = () => (typeof window.__fakeHour === 'number' ? window.__fakeHour : new Date().getHours());
const lateNight = () => curHour() < 5;
const ACTIVE_KEY = 'ame.lastActive', AWAY_MS = 4 * 3600e3, ACTIVE_SAVE_MS = 30000;
let lastActiveWall = 0, activeSavedAt = 0, nagOn = true;
try { lastActiveWall = Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch {}
function saveActive(force) {
  const w = Date.now();
  if (window.__noPersist || (!force && w - activeSavedAt < ACTIVE_SAVE_MS)) return;
  activeSavedAt = w;
  try { localStorage.setItem(ACTIVE_KEY, String(lastActiveWall)); } catch {}
}
window.addEventListener('beforeunload', () => saveActive(true));

const NAG = { after: 90 * 60e3, gap: 5 * 60e3, every: 20 * 60e3, face: 4000, bubble: 6000, fade: 250 };
const NAG_LINES = ['休息一下嘛……', '陪我喝杯茶好不好', '眼睛会累坏的啦', '已经打了好久了诶', '理理我嘛～', '站起来伸个懒腰吧'];
const work = { start: 0, last: 0, nextNag: 0 };
const nag = { text: '', t0: -1e9 };

function fakeSession(min) {
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
  if (t - work.last > 60000) return;
  work.nextNag = t + NAG.every;
  showNag();
}

function moodOnKey(k, t) {
  const idle = t - mood.lastKeyT;
  mood.lastKeyT = t;
  mood.pouted = false;
  const wall = Date.now(), away = lastActiveWall ? wall - lastActiveWall : 0;
  lastActiveWall = wall; saveActive(false);
  if (!work.start || t - work.last >= NAG.gap) { work.start = t; work.nextNag = t + NAG.after; }
  work.last = t;
  if (away >= AWAY_MS) { mood.sleeping = false; mood.tempUntil = 0; setTemp('happy', 2000, '久别回来'); setTimeout(() => wave('L', 1600), 400); }
  else if (mood.sleeping) { mood.sleeping = false; mood.tempUntil = 0; setTemp('surprised', 1400, '被吵醒'); setTimeout(() => wave('L', 1400), 500); }
  else if (idle > 20000) setTemp('surprised', 1600, '闲了很久突然打字');
  const ctrl = byCode.get(29)?.down;
  mood.repeat = k.label === mood.lastLabel ? (mood.repeat || 1) + 1 : 1;
  mood.lastLabel = k.label;
  if (mood.repeat >= 6 && !ctrl && k.label !== 'Bksp') tryTemp('deadpan', 2000, null, `同一个键连按 ${mood.repeat} 次`);
  if (keys.filter((x) => x.down).length >= 4) tryTemp('dizzy', 1800, null, '同时按住 4 个键');
  if (k.label === 'Bksp') {
    mood.bksp.push(t);
    if (recent(mood.bksp, t, 6000) >= 10) tryTemp('teary', 3000, 'annoyed', '6 秒内删了 10 次');
    else if (recent(mood.bksp, t, 2000) >= 4) setTemp('annoyed', 2500, '2 秒内连删 4 次');
  }
  if (k.label === 'Esc') { mood.esc = mood.esc || []; mood.esc.push(t); if (recent(mood.esc, t, 2000) >= 4) tryTemp('angry', 2200, 'annoyed', '连按 Esc'); }
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
  if (idle > 30000 && idle < 33000 && !mood.pouted && hasFace('pout')) { why('被冷落 30 秒'); return 'pout'; }
  if (idle >= 33000) mood.pouted = true;
  const sf = speedFace(t);
  if (sf) { why(`打字速度 ${kpm()} 键/分`); return sf; }
  if (claude.state === 'working' && idle > 3000 && now() - (mouse.movedAt || 0) > 4000) { why('在看 Claude 干活'); return 'focus'; }
  const hr = curHour();
  if (hr >= 2 && hr < 5) { why('凌晨 2–5 点'); return 'yandere'; }
  if (hr < 2 && idle > 5000) { why('过了午夜，犯困'); return 'half'; }
  why('');
  return 'neutral';
}

const POP_KIND = { surprised: 'up', sparkle: 'up', angry: 'up', teary: 'down', half: 'down', sleep: 'down', pout: 'down', sweat: 'down', yawn: 'down', deadpan: 'down' };
const POP_GAIN = { neutral: 0.6, focus: 0.7, yandere: 0.7 };
const facePop = { t0: -1e9, dur: 300, g: 1, kind: 'tilt', dir: 1 };

function startPop(from, to, t) {
  if (t - facePop.t0 < 200) return;
  const slow = from === 'sleep' || to === 'sleep' || from === 'half' || to === 'half';
  const g = (POP_GAIN[to] || 1) * (slow ? 0.55 : 1), kind = POP_KIND[to] || 'tilt', nd = kind === 'up' ? -1 : kind === 'down' ? 1 : 0;
  facePop.t0 = t; facePop.dur = slow ? 520 : 300; facePop.g = g; facePop.kind = kind; facePop.dir = -facePop.dir;
  const d = facePop.dir, tk = nd ? -nd * 1.1 : -d * 0.9;
  tails.L.v += tk * g; tails.R.v += tk * g; fhair.v += (nd ? d * 45 : -d * 70) * g;
}

function popVals(t) {
  const u = window.__popU !== undefined ? window.__popU : (t - facePop.t0) / facePop.dur;
  if (!(u >= 0 && u < 1)) return null;
  const g = facePop.g, k = facePop.kind, w = -Math.sin(u * 2 * Math.PI) * (1 - u * u), h = Math.sin(Math.PI * u) * (1 - 0.4 * u);
  return { sy: 1 + 0.04 * g * w, sx: 1 - 0.025 * g * w, dy: (k === 'up' ? -6 : k === 'down' ? 7 : 0) * g * h, rot: (k === 'tilt' ? 0.04 : 0.012) * g * h * facePop.dir };
}

function updateMood(t) {
  updateKForm(t);
  let f = baseFace(t);
  const HOLD = 1200;
  if (f !== mood.open && f !== 'sleep' && t - (mood.openT || 0) < HOLD && facePri(f) <= facePri(mood.open)) { f = mood.open; }
  else if (f !== mood.open) { startPop(mood.open, f, t); mood.open = f; mood.openT = t; mood.why = mood.baseWhy; }
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
    mood.fadeT = 0;
  }
}

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
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.stroke();
  ctx.fillStyle = '#4a2338'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(nag.text, bx + bw / 2, by + bh / 2 + 2);
  ctx.restore();
}

function drawZzz() {
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
