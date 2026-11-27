// Ame typing pet — main simulation step, DPI resize, render loop, and startup loader.
// Scene/rig kinematics live in renderer-rig.js; expressions & KAngel in renderer-mood.js;
// idle actions, P-chan & pointer interaction in renderer-idle-ui.js.
'use strict';

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
  const busyHands = [hands.L, hands.R].filter((h) => h.state !== 'hover' && !h.homing && h.gy > farY);
  const lookDown = busyHands.length > 0;
  const side = busyHands.length ? Math.sign(busyHands[0].gx - NECK.x) : 0;
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
  // front hair: quicker, lighter spring than tails
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

function drawEffects() {
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
  requestAnimationFrame(frame);
  if (ctx.reset) ctx.reset(); else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; }
  try { drawFrame(); } catch (e) {
    const msg = 'frame error: ' + ((e && e.stack) || e);
    if (msg !== lastFrameErr) { lastFrameErr = msg; console.error(msg); }
  }
}

function drawFrame() {
  const t = now(), dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  update(dt);
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== sizedForDpr) resize();
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -VX * scale * dpr, 0);
  ctx.clearRect(VX, 0, ART_W, ART_H);
  ctx.imageSmoothingQuality = 'high';

  if (kbOnly) { drawKeyboard(ctx, scale * dpr, 0); return; }
  drawKeyboardShadow(ctx, breathPhase);
  drawTails();
  withCharacterClip(() => drawRig('torso'));
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

window.pet.onConfig((c) => {
  scale = c.scale; debug = c.debug; nagOn = c.breakNag !== false; touchMode = !!c.touchMode;
  if (c.facing && c.facing !== facing) { facing = c.facing; buildKeys(); }
  if (c.kbTheme && c.kbTheme !== KB_PAINT.theme) loadKbTheme(c.kbTheme);
  const kl = !!c.kangel;
  if (kl !== KA.lock) { KA.lock = kl; if (KA.ready) { if (kl) setKForm(true, 0); else if (!KA.until) setKForm(false); } }
  legs = c.legs !== false; ART_H = legs ? 1190 : 1080; PCH.y = ART_H - 10;
  resize();
});
window.pet.onKey(onKey);

(async () => {
  buildKeys();
  RIG = window.RIG_DATA;
  if (RIG.floatScale) HS = RIG.floatScale;
  NECK = toScene(RIG.neck);
  HIP = { x: NECK.x, y: DESK_Y };
  TIE = { L: toScene(RIG.tie.L), R: toScene(RIG.tie.R) };
  if (RIG.props && RIG.props.mug) loadImg('mug', 'assets/rig/mug_hands.png').catch(() => {});
  if (GS) for (const n of ['gaze_white', 'gaze_iris', 'gaze_lid']) loadImg(n, `assets/rig/${n}.png`).catch(() => {});
  const names = [
    'head', 'tailL', 'tailR', 'torso',
    ...Object.keys(RIG.faces || {}).map((f) => 'face_' + f),
    ...Object.keys(RIG.gaze || {}).map((g) => 'gaze_' + g),
    ...(RIG.faceTop || []).map((f) => 'face_' + f + '_top'),
    ...(RIG.frontHair ? ['front_hair'] : []),
  ];
  for (const k of Object.keys(RIG.float)) names.push(`float_${k}`);
  await Promise.all(names.map((n) => loadImg(n, `assets/rig/${n}.png`)));
  await loadKangel().catch(() => {});
  if (KA.lock) setKForm(true, 0, true);
  for (const s of ['L', 'R']) { const r = restPoint(s); Object.assign(hands[s], { gx: r.x, gy: r.y }); }
  for (const s of ['idle', 'alert', 'sleep', 'blink']) loadImg('pchan_' + s, `assets/pchan/pchan_${s}.png`).catch(() => {});
  if (RIG.tail) loadTailTextures();
  resize();
  requestAnimationFrame(frame);
  setTimeout(() => wave('L', 1600), 700);
})();
