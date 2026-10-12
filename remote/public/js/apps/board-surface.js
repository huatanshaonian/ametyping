// 画板's surface: an endless sheet you draw on. It owns the strokes, the view (where you are and how far in), what
// the pen / mouse / fingers do, and undo; the ink itself is board-ink.js, the window around it board.js.
//   a pen draws with the tool chosen; its eraser end erases, its side button moves the sheet
//   a mouse: left = the tool, middle / right = move; the wheel moves, Ctrl + wheel zooms (so does a touchpad's pinch)
//   fingers: two always move and zoom; one draws until a pen has been seen, moves the sheet after that (the palm
//     resting while you write is then ignored) -- 「手指画」 in the toolbar sets it either way
// Two canvases: `base` holds the strokes as last drawn for the view, `live` the stroke under the pen (laid over the
// base with the same blending the ink uses, so it looks the same before and after the pen lifts). While the sheet is
// being moved a busy board is not redrawn for every frame: the picture is shifted and scaled, then drawn again when
// the movement pauses.
import { h } from '../util.js';
import { TOOLS, NO_PRESSURE, bounds, drawStroke, hit, extent, picture } from './board-ink.js';

const MIN_S = 0.1, MAX_S = 8;
const ERASE_R = 9;                                 // the eraser's reach, in screen pixels
const SLOW_MS = 9;                                 // a redraw taking longer than this is not done for every frame
const PAD = 28;                                    // around the drawing in the picture given to the model

export function createSurface({ onInk = () => {}, onUi = () => {} } = {}) {
  const base = h('canvas', { class: 'bd-base' }), live = h('canvas', { class: 'bd-live' });
  const selEl = h('div', { class: 'bd-sel', hidden: true });
  const el = h('div', { class: 'bd-surface', tabindex: '0' }, base, live, selEl);
  const bctx = base.getContext('2d'), lctx = live.getContext('2d', { desynchronized: true });

  let strokes = [], undone = [], history = [];     // history: { k: 'add', s } | { k: 'del', list: [{ i, s }] }
  let tool = 'pencil', color = '#222222';
  const widths = { pencil: TOOLS.pencil.w, marker: TOOLS.marker.w };
  const view = { s: 1, x: 0, y: 0 };               // screen = board * s + (x, y), in layout pixels
  let W = 0, H = 0, k = 1, z = 1;                  // size in layout pixels; canvas pixels per layout pixel; page zoom
  let drawn = null, cost = 0, raf = 0, later = 0;  // the view the base shows; how long the last redraw took
  let sel = null;                                  // the framed part of the board [x0, y0, x1, y1], or null
  let fingerDraws = null;                          // null = until a pen is seen
  let penSeen = false;
  let act = null, cur = null;                      // what the pointer is doing; the stroke under the pen
  const touches = new Map();                       // pointerId -> { x, y } (layout pixels within the surface)

  // ---------- drawing the board ----------
  const toBoard = (x, y) => [(x - view.x) / view.s, (y - view.y) / view.s];
  const setBoard = (ctx) => ctx.setTransform(view.s * k, 0, 0, view.s * k, view.x * k, view.y * k);
  function render() {
    cancelAnimationFrame(raf); clearTimeout(later); raf = later = 0;
    if (!W || !H) return;
    const t0 = performance.now();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, base.width, base.height);
    setBoard(bctx);
    const [x0, y0] = toBoard(0, 0), [x1, y1] = toBoard(W, H);
    for (const s of strokes) if (s.bb[2] >= x0 && s.bb[0] <= x1 && s.bb[3] >= y0 && s.bb[1] <= y1) drawStroke(bctx, s);
    drawn = { ...view }; base.style.transform = '';
    cost = performance.now() - t0;
    placeSel();
  }
  // the view changed: redraw at the next frame, or -- a busy board -- move the picture now and redraw when it rests
  function moved() {
    placeSel();
    if (cost < SLOW_MS || !drawn) { if (!raf) raf = requestAnimationFrame(render); return; }
    const r = view.s / drawn.s;
    base.style.transform = `translate(${view.x - drawn.x * r}px, ${view.y - drawn.y * r}px) scale(${r})`;
    clearTimeout(later); later = setTimeout(render, 110);
  }
  function placeSel() {
    selEl.hidden = !sel;
    if (sel) Object.assign(selEl.style, { left: sel[0] * view.s + view.x + 'px', top: sel[1] * view.s + view.y + 'px', width: (sel[2] - sel[0]) * view.s + 'px', height: (sel[3] - sel[1]) * view.s + 'px' });
  }
  function resize() {
    const r = el.getBoundingClientRect();
    W = el.clientWidth; H = el.clientHeight;
    if (!W || !H) return;
    z = r.width / W || 1; k = (window.devicePixelRatio || 1) * z;
    for (const c of [base, live]) { c.width = Math.round(W * k); c.height = Math.round(H * k); }
    render();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  // ---------- the view ----------
  function zoomAt(x, y, f) {
    const s = Math.min(MAX_S, Math.max(MIN_S, view.s * f)), [bx, by] = toBoard(x, y);
    view.s = s; view.x = x - bx * s; view.y = y - by * s;
    moved(); onUi();
  }
  // everything drawn, in the middle (never enlarged past its real size); an empty board: the corner as it starts
  function fit() {
    const e = extent(strokes);
    if (!e || !W) Object.assign(view, { s: 1, x: 0, y: 0 });
    else {
      const s = Math.min(1, Math.max(MIN_S, Math.min((W - 40) / (e[2] - e[0]), (H - 40) / (e[3] - e[1]))));
      Object.assign(view, { s, x: (W - (e[2] + e[0]) * s) / 2, y: (H - (e[3] + e[1]) * s) / 2 });
    }
    render(); onUi();
  }

  // ---------- ink ----------
  function begin(x, y, pr) {
    const [bx, by] = toBoard(x, y);
    cur = { t: tool, c: color, w: widths[tool], p: [round(bx), round(by), pr] };
    live.style.mixBlendMode = TOOLS[tool].blend;
    drawLive(0);
  }
  const round = (v) => Math.round(v * 100) / 100;
  function drawLive(from) {
    if (cur.t === 'marker') { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height); from = 0; }
    setBoard(lctx);
    drawStroke(lctx, cur, from);
  }
  function extend(x, y, pr) {
    const [bx, by] = toBoard(x, y), p = cur.p, n = p.length;
    const min = 0.7 / view.s;
    if ((bx - p[n - 3]) ** 2 + (by - p[n - 2]) ** 2 < min * min) return false;
    p.push(round(bx), round(by), pr);
    return true;
  }
  function finish(keep) {
    const s = cur; cur = null;
    lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height);
    if (!keep || !s) return;
    s.bb = bounds(s);
    strokes.push(s); history.push({ k: 'add', s }); undone = [];
    if (base.style.transform) render(); else { setBoard(bctx); drawStroke(bctx, s); }
    onInk();
  }
  function eraseAt(x, y) {
    const [bx, by] = toBoard(x, y), r = ERASE_R / view.s;
    let any = false;
    for (let i = strokes.length - 1; i >= 0; i--) if (hit(strokes[i], bx, by, r)) { act.list.push({ i, s: strokes[i] }); strokes.splice(i, 1); any = true; }
    if (any) render();
  }
  function undo() {
    const o = history.pop();
    if (!o) return;
    if (o.k === 'add') strokes.splice(strokes.lastIndexOf(o.s), 1);
    else for (let j = o.list.length - 1; j >= 0; j--) strokes.splice(o.list[j].i, 0, o.list[j].s);     // (back in, last out first)
    undone.push(o); render(); onInk();
  }
  function redo() {
    const o = undone.pop();
    if (!o) return;
    if (o.k === 'add') strokes.push(o.s);
    else for (const d of o.list) strokes.splice(strokes.indexOf(d.s), 1);
    history.push(o); render(); onInk();
  }
  function clear() {
    if (!strokes.length) return;
    const list = []; for (let i = strokes.length - 1; i >= 0; i--) list.push({ i, s: strokes[i] });
    strokes = []; history.push({ k: 'del', list }); undone = []; sel = null;
    render(); onInk(); onUi();
  }

  // ---------- pointers ----------
  let box = null;                                  // the surface's place on screen, read when a pointer goes down
  const at = (e) => ({ x: (e.clientX - box.left) / z, y: (e.clientY - box.top) / z });
  const pressure = (e) => (e.pointerType === 'pen' ? Math.round(Math.max(0.05, e.pressure || 0) * 100) / 100 : NO_PRESSURE);
  const fingerDrawsNow = () => (fingerDraws == null ? !penSeen : fingerDraws);
  // which of draw / erase / pan / frame this pointer starts
  function kindOf(e) {
    if (e.pointerType === 'pen') { if (e.button === 5 || (e.buttons & 32)) return 'erase'; if (e.button === 2 || (e.buttons & 2)) return 'pan'; }
    else if (e.pointerType === 'mouse') { if (e.button !== 0) return 'pan'; }
    else if (!fingerDrawsNow()) return 'pan';
    return tool === 'hand' ? 'pan' : tool === 'eraser' ? 'erase' : tool === 'frame' ? 'frame' : 'draw';
  }
  function pinchStart() {
    const [a, b] = [...touches.values()];
    act = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, v: { ...view } };
  }
  function drop() {                                  // what was going on is given up (a second finger, the pen taking over)
    if (act && act.kind === 'draw') finish(false);
    if (act && act.kind === 'erase' && act.list.length) { history.push({ k: 'del', list: act.list }); undone = []; onInk(); }
    act = null;
  }
  function down(e) {
    box = el.getBoundingClientRect();
    el.focus({ preventScroll: true });
    const p = at(e);
    if (e.pointerType === 'pen' && !penSeen) { penSeen = true; onUi(); }
    try { el.setPointerCapture(e.pointerId); } catch {}       // (every finger: one lifted outside the board must still be heard)
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, p);
      if (act && act.type !== 'touch') return;       // the pen or the mouse is at work: a hand resting on the screen
      if (touches.size === 2) { drop(); pinchStart(); act.type = 'touch'; }
      if (touches.size !== 1) return;
    } else if (act) { if (act.type !== 'touch') return; drop(); }
    const kind = kindOf(e);
    act = { kind, id: e.pointerId, type: e.pointerType, x: p.x, y: p.y, v: { ...view }, list: [] };
    if (kind === 'draw') begin(p.x, p.y, pressure(e));
    else if (kind === 'erase') eraseAt(p.x, p.y);
    else if (kind === 'frame') { const [bx, by] = toBoard(p.x, p.y); act.a = [bx, by]; sel = null; placeSel(); }
    e.preventDefault();
  }
  function move(e) {
    if (!box) return;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, at(e));
    if (!act) return;
    if (act.kind === 'pinch') {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const s = Math.min(MAX_S, Math.max(MIN_S, act.v.s * d / act.d));
      // what was under the middle of the two fingers stays under it
      Object.assign(view, { s, x: cx - (act.cx - act.v.x) / act.v.s * s, y: cy - (act.cy - act.v.y) / act.v.s * s });
      moved(); onUi();
      return;
    }
    if (e.pointerId !== act.id) return;
    const p = at(e);
    if (act.kind === 'draw') {
      const from = cur.p.length / 3;
      let any = false;
      for (const c of (e.getCoalescedEvents && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e])) { const q = at(c); if (extend(q.x, q.y, pressure(c))) any = true; }
      if (any) drawLive(from);
    } else if (act.kind === 'erase') eraseAt(p.x, p.y);
    else if (act.kind === 'pan') { view.x = act.v.x + p.x - act.x; view.y = act.v.y + p.y - act.y; moved(); }
    else if (act.kind === 'frame') {
      const [bx, by] = toBoard(p.x, p.y);
      sel = [Math.min(act.a[0], bx), Math.min(act.a[1], by), Math.max(act.a[0], bx), Math.max(act.a[1], by)];
      placeSel();
    }
  }
  function up(e, cancelled) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (!act) return;
    if (act.kind === 'pinch') { if (touches.size < 2) act = touches.size ? { kind: 'rest', type: 'touch' } : null; return; }
    if (act.kind === 'rest') { if (!touches.size) act = null; return; }
    if (e.pointerId !== act.id) return;
    const a = act; act = null;
    if (a.kind === 'draw') finish(!cancelled);
    else if (a.kind === 'erase' && a.list.length) { history.push({ k: 'del', list: a.list }); undone = []; onInk(); }
    else if (a.kind === 'frame') { if (sel && (sel[2] - sel[0]) * view.s < 12 && (sel[3] - sel[1]) * view.s < 12) sel = null; placeSel(); onUi(); }
  }
  function wheel(e) {
    e.preventDefault();
    box = el.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1, p = at(e);
    if (e.ctrlKey || e.metaKey) return zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * 0.0022));
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit, dy = (e.shiftKey ? 0 : e.deltaY) * unit;
    view.x -= dx; view.y -= dy; moved();
  }
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', (e) => up(e, false));
  el.addEventListener('pointercancel', (e) => up(e, true));
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.dataset.tool = tool;

  return {
    el,
    setTool(t) { tool = t; el.dataset.tool = t; }, tool: () => tool,
    setColor(c) { color = c; }, color: () => color,
    setWidth(t, w) { widths[t] = w; }, width: (t) => widths[t],
    // true / false, or null: fingers draw until a pen is seen
    setFinger(v) { fingerDraws = v; }, fingerDraws: fingerDrawsNow,
    load(doc) {
      strokes = ((doc && doc.strokes) || []).map((s) => { const x = { t: s.t, c: s.c, w: s.w, p: s.p }; x.bb = bounds(x); return x; });
      history = []; undone = []; sel = null; cur = null; act = null;
      fit();
    },
    doc: () => ({ v: 1, strokes: strokes.map(({ t, c, w, p }) => ({ t, c, w, p })) }),
    count: () => strokes.length,
    undo, redo, clear, canUndo: () => history.length > 0, canRedo: () => undone.length > 0,
    fit, zoomBy(f) { zoomAt(W / 2, H / 2, f); }, scale: () => view.s,
    framed: () => !!sel, unframe() { sel = null; placeSel(); onUi(); },
    // the framed part (or everything drawn, with a margin) as a picture: { canvas, rect } -- null when there is nothing
    picture(maxSide) {
      const e = sel || extent(strokes);
      if (!e || !strokes.length) return null;
      const rect = sel ? sel : [e[0] - PAD, e[1] - PAD, e[2] + PAD, e[3] + PAD];
      if (!strokes.some((s) => s.bb[2] >= rect[0] && s.bb[0] <= rect[2] && s.bb[3] >= rect[1] && s.bb[1] <= rect[3])) return null;
      return { canvas: picture(strokes, rect, maxSide), rect };
    },
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(later); },
  };
}
