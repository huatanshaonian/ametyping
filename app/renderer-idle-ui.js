// Ame typing pet — idle actions (yawn/stretch/sip), P-chan companion, Claude reaction, and pointer/touch interaction.
'use strict';

// ---------- idle little actions: yawn / stretch / sip ----------
const ACTS = { yawn: 2600, stretch: 2600, sip: 4300 };
const SIP = { gather: 450, swap: 700, atMouth: 1250, sip1: [1450, 2000], sip2: [2150, 2700], down: 3000, onDesk: 3550, unswap: 3800, end: 4300 };
const act = { kind: null, t0: 0, dur: 0, next: now() + 30000 };

function startAct(kind) {
  if (act.kind || mood.sleeping || mood.carried || claude.state === 'waiting') return;
  if (kind === 'sip' && !img.mug) kind = 'yawn';
  Object.assign(act, { kind, t0: now(), dur: ACTS[kind] });
  const face = { yawn: ['yawn', 'half'], stretch: ['stretch', 'happy'], sip: ['sip', 'happy'] }[kind];
  if (kind === 'sip') {
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
    startAct(Math.random() < (lateNight() ? 0.8 : 0.5) ? 'yawn' : 'sip');
  }
}

const actP = () => (act.kind ? Math.min(1, (now() - act.t0) / act.dur) : 0);
const actEnv = () => { const p = actP(); return p < 0.18 ? p / 0.18 : p > 0.82 ? (1 - p) / 0.18 : 1; };

function actHand(side) {
  if (!act.kind) return null;
  const e = easeIO(actEnv()), t = now();
  if (act.kind === 'sip') return null;
  if (act.kind === 'yawn' && side === 'R') return null;
  const home = restPoint(side);
  let tx, ty, rot;
  if (act.kind === 'yawn') { tx = NECK.x - 20; ty = NECK.y + 100; rot = 0.4; }
  else { tx = NECK.x + (side === 'L' ? -300 : 300); ty = NECK.y - 250 + actBodyDy() + Math.sin(t / 160) * 6; rot = side === 'L' ? -0.5 : 0.5; }
  return { x: home.x + (tx - home.x) * e, y: home.y + (ty - home.y) * e, rot: rot * e, e };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (t, a, b) => easeIO(clamp01((t - a) / (b - a)));
const sipT = () => (act.kind === 'sip' ? now() - act.t0 : -1);
function sipBeat() {
  const t = sipT(), pulse = ([a, b]) => (t > a && t < b ? Math.sin((t - a) / (b - a) * Math.PI) : 0);
  return t < 0 ? 0 : Math.max(pulse(SIP.sip1), pulse(SIP.sip2));
}
function sipState() {
  const t = sipT();
  const lift = t < SIP.down ? seg(t, SIP.swap, SIP.atMouth) : 1 - seg(t, SIP.down, SIP.onDesk);
  const mugA = t < SIP.down ? seg(t, SIP.gather, SIP.swap) : 1 - seg(t, SIP.onDesk, SIP.unswap);
  const gather = t < SIP.down ? seg(t, 0, SIP.gather) : 1 - seg(t, SIP.unswap, SIP.end);
  return { t, lift, mugA, gather };
}
function mugPose(st) {
  const m = RIG.props.mug, sc = RIG.props.mugScale, w = m.w * sc, h = m.h * sc, beat = sipBeat();
  const deskX = (restPoint('L').x + restPoint('R').x) / 2, deskY = KB.y + 6 - h / 2 + 30;
  const mouthY = RIG.props.mouthY * CS + OY + head.dy + actHeadDy();
  const holdX = NECK.x + body.x, holdY = mouthY + 12 - RIG.props.rimY * sc + h / 2 - beat * 6;
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
  ctx.rotate(-0.09 * p.beat);
  ctx.drawImage(img.mug, -p.w / 2, -p.h / 2, p.w, p.h);
  ctx.restore();
}
function sipHand(side) {
  const st = sipState(), p = mugPose({ ...st, lift: 0 });
  const home = restPoint(side), gx = p.x + (side === 'L' ? -p.w * 0.36 : p.w * 0.36), gy = KB.y + 40;
  return { x: home.x + (gx - home.x) * st.gather, y: home.y + (gy - home.y) * st.gather, alpha: 1 - st.mugA };
}

// ---------- P-chan (ピーちゃん) ----------
const PCH = { x: 1105, y: 1180, h: 118 };
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
function overPchan(e) {
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
  const br = Math.sin(t / (st === 'sleep' ? 1100 : 750));
  let sy = 1 + br * (st === 'sleep' ? 0.025 : 0.016), dy = 0;
  const rot = st === 'sleep' ? 0 : Math.sin(t / 1700) * 0.018;
  if (st === 'alert') {
    const p = (t % 2000) / 2000;
    if (p < 0.3) dy = -22 * Math.sin(Math.PI * p / 0.3);
    else if (p < 0.4) sy *= 1 - 0.08 * Math.sin(Math.PI * (p - 0.3) / 0.1);
  }
  const hp = (t - pch.hop) / 380;
  if (hp >= 0 && hp < 1) dy -= 16 * Math.sin(Math.PI * hp);
  const hs = 1 + 0.08 * pch.hover, sx = (1 - (sy - 1) * 0.6) * hs;
  ctx.save();
  ctx.fillStyle = 'rgba(30,20,40,0.16)';
  ctx.beginPath(); ctx.ellipse(PCH.x, PCH.y - 3, r.w * 0.3 * (1 + dy / 150), 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(PCH.x, PCH.y + dy); ctx.rotate(rot); ctx.scale(sx, sy * hs);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(im, -r.w / 2, -r.h, r.w, r.h);
  ctx.restore();
  if (st === 'sleep') {
    ctx.save(); ctx.font = 'bold 34px "Segoe UI", sans-serif'; ctx.lineWidth = 6; ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      const p = ((t / 2600) + i / 2) % 1;
      ctx.globalAlpha = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
      const x = PCH.x + 52 + p * 22, y = PCH.y - r.h * 0.55 - p * 46, z = 0.7 + p * 0.5;
      ctx.save(); ctx.translate(x, y); ctx.scale(z, z); ctx.strokeStyle = '#fff'; ctx.strokeText('z', 0, 0); ctx.fillStyle = '#6d5a67'; ctx.fillText('z', 0, 0); ctx.restore();
    }
    ctx.restore();
  }
  if (st === 'alert' && panel.unread > 0) {
    const bx = PCH.x + r.w * 0.36, by = PCH.y + dy - r.h * 0.84, txt = panel.unread > 9 ? '9+' : String(panel.unread);
    ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#e0243d';
    ctx.beginPath(); ctx.arc(bx, by, 25, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 32px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx, by + 2); ctx.restore();
  }
}

// ---------- window drag + resize grip + per-pixel click-through ----------
const GRIP_R = 16;
let drag = null, sizing = null, hover = false, overGrip = false, downAt = null, hit = false, lastProbe = 0;
let touchMode = false;
const readOutline = createOutline(canvas);
let shapeSent = '[]';
setInterval(() => {
  let rects = [];
  if (touchMode && !sizing) {
    try { rects = readOutline(canvas.clientWidth, canvas.clientHeight); } catch { rects = []; }
    if (rects.length) {
      const g = gripCss();
      rects.push([Math.round(g.x - GRIP_R), Math.round(g.y - GRIP_R), GRIP_R * 2, GRIP_R * 2]);
    }
  }
  const key = JSON.stringify(rects);
  if (key !== shapeSent) { shapeSent = key; window.pet.setShape(rects); }
}, 150);
canvas.style.touchAction = 'none';

function gripCss() {
  return { x: (KB.x + KB.w - 30 - VX) * scale, y: (KB.y + KB.h + KB_FRONT - 20) * scale };
}
const inGrip = (e) => { const g = gripCss(); return Math.hypot(e.offsetX - g.x, e.offsetY - g.y) < GRIP_R; };
function opaqueAt(e) {
  const dpr = window.devicePixelRatio || 1;
  const x = Math.round(e.offsetX * dpr), y = Math.round(e.offsetY * dpr);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  return ctx.getImageData(x, y, 1, 1).data[3] > 110;
}
function setHit(v) { if (v !== hit) { hit = v; window.pet.setHit(v); } }

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

const HOLD_MS = 500, HOLD_SLOP = 10;
let lastClickAt = 0, stroking = false, holdTimer = null, picked = false;
let fingerAt = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !(touchMode ? inGrip(e) || opaqueAt(e) : hit)) return;
  downAt = { x: e.screenX, y: e.screenY, ox: e.offsetX, oy: e.offsetY };
  canvas.setPointerCapture(e.pointerId);
  const finger = e.pointerType === 'touch';
  if (finger) fingerAt = { x: e.clientX, y: e.clientY };
  if (inGrip(e)) {
    sizing = true;
    if (finger) window.pet.gesture('resize-start', e.clientX, e.clientY); else window.pet.gesture('resize-start');
  } else if (finger) {
    stroking = true; picked = false;
    holdTimer = setTimeout(() => {
      if (!stroking) return;
      stroking = false; picked = true; pat.px = null; drag = true; head.nodUntil = now() + 200;
      window.pet.gesture('drag-start', fingerAt.x, fingerAt.y);
    }, HOLD_MS);
  } else {
    drag = true;
    window.pet.gesture('drag-start');
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    fingerAt = { x: e.clientX, y: e.clientY };
    if (drag || sizing) window.pet.gestureAt(e.clientX, e.clientY);
  }
  if (!stroking) return;
  if (downAt && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > HOLD_SLOP) clearTimeout(holdTimer);
  detectPat({ x: e.offsetX / scale + VX, y: e.offsetY / scale }, true);
});

const endGesture = () => { if (drag || sizing) window.pet.gesture(sizing ? 'resize-end' : 'drag-end'); drag = null; sizing = null; };
canvas.addEventListener('pointercancel', () => { endGesture(); downAt = null; stroking = false; clearTimeout(holdTimer); });
canvas.addEventListener('pointerup', (e) => {
  const far = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : 99;
  const moved = picked ? 99 : e.pointerType === 'touch' && far < HOLD_SLOP ? 0 : far;
  const wasSizing = !!sizing;
  clearTimeout(holdTimer);
  if (sizing) window.pet.gesture('resize-end');
  else if (drag) window.pet.gesture('drag-end');
  if (!wasSizing && moved < 4 && downAt && downAt.oy / scale < NECK.y + 20) {
    tryTemp('blush', 2000, 'happy', '被点了一下头'); head.nodUntil = now() + 200;
  }
  if (!wasSizing && moved < 4) {
    if (downAt && overPchan({ offsetX: downAt.ox, offsetY: downAt.oy })) { pch.hop = now(); window.pet.panelExpand(); }
    else {
      const t = performance.now();
      if (t - lastClickAt < 400) { lastClickAt = 0; window.pet.openDashboard(); } else lastClickAt = t;
    }
  }
  downAt = null; drag = null; sizing = null; stroking = false; picked = false;
});

function drawGrip() {
  if (!hover && !sizing && !touchMode) return;
  const dpr = window.devicePixelRatio || 1, g = gripCss();
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = overGrip || sizing ? 'rgba(210,80,140,.95)' : 'rgba(110,90,105,.6)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const o of [5, 10, 15]) { ctx.beginPath(); ctx.moveTo(g.x + 8, g.y + 8 - o); ctx.lineTo(g.x + 8 - o, g.y + 8); ctx.stroke(); }
  ctx.restore();
}

let mouseFrozen = false;
window.pet.onMouse((m) => {
  if (mouseFrozen) return;
  if (Math.hypot(m.x - mouse.x, m.y - mouse.y) > 3) mouse.movedAt = now();
  mouse.x = m.x; mouse.y = m.y; mouse.seen = true;
  if (!stroking) detectPat(m);
});

function detectPat(m, touch = false) {
  const t = now(), hx = NECK.x + body.x;
  const onHead = !drag && (touch || (Math.abs(m.x - hx) < 240 && m.y > 60 && m.y < NECK.y - 230));
  if (!onHead) { pat.px = null; if (pat.on && t - pat.last > 700) pat.on = false; return; }
  if (pat.px !== null) {
    const dx = m.x - pat.px;
    if (Math.abs(dx) > 5) {
      const d = Math.sign(dx);
      if (pat.dir && d !== pat.dir) pat.revs.push(t);
      pat.dir = d;
      fhair.v += dx * 1.2;
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

// ---------- carried around & Claude Code companion ----------
window.pet.onWinMove((dx, dy) => {
  const k = 1 / Math.max(scale, 0.1);
  carry.vx += dx * k; carry.vy += dy * k; carry.t = now();
  for (const s of ['L', 'R']) tails[s].v -= dx * k * 0.004 + (s === 'L' ? 1 : -1) * dy * k * 0.002;
  fhair.v -= dx * k * 0.5;
  if (!mood.carried) { mood.carried = true; tryTemp('surprised', 1600, null, '被拖着走'); }
});

const claude = { state: 'idle', t: 0 };
window.pet.onClaude((type) => {
  const t = now();
  if (type === 'message') { claude.state = 'working'; head.nodUntil = t + 220; }
  else if (type === 'thinking' || type === 'reading') claude.state = 'working';
  else if (type === 'error') { claude.state = 'working'; tryTemp('sweat', 1800, null, 'Claude 报错了'); }
  else if (type === 'waiting') { claude.state = 'waiting'; tryTemp('surprised', 1600, null, 'Claude 在等你确认'); wave('R', 1500); }
  else if (type === 'done') { claude.state = 'idle'; tryTemp('happy', 2500, null, 'Claude 做完了'); head.nodUntil = t + 260; }
  else if (type === 'done-partial') { head.nodUntil = t + 200; }
  else if (type === 'idle' || type === 'quit') claude.state = 'idle';
  claude.t = t;
});
