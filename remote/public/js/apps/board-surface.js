// 画板's surface: an endless sheet you draw on. It owns the strokes, the view (where you are and how far in), what
// the pen / mouse / fingers do, and undo; the ink itself is board-ink.js, the window around it board.js.
//   a pen draws with the tool chosen; its eraser end erases; its side button picks (below)
//   a mouse: left = the tool, right = pick, middle = move the sheet; the wheel moves, Ctrl + wheel zooms
//   fingers: two always move and zoom; one moves the sheet once a pen has been seen on this device (remembered: the
//     palm resting while you write is then ignored) and draws before that -- 「手指画」 in the toolbar sets it either way
//   picking (the 选中 tool, or the right button / the pen's side button with any tool): a line drawn around strokes
//     picks those mostly inside it, a tap picks the stroke under it (or nothing). What is picked can be deleted, given
//     to the model on its own, or dragged to another place: a press on it drags it, with any tool, button or finger.
// Two canvases: `base` holds the strokes as last drawn for the view, `live` the stroke under the pen (laid over the
// base with the same blending the ink uses, so it looks the same before and after the pen lifts). While the sheet is
// being moved a busy board is not redrawn for every frame: the picture is shifted and scaled, then drawn again when
// the movement pauses.
import { h, prefs } from '../util.js';
import { TOOLS, NO_PRESSURE, bounds, drawStroke, hit, extent, picture } from './board-ink.js';

const MIN_S = 0.1, MAX_S = 8;
const ERASE_R = 9;                                 // the eraser's reach, in screen pixels
const SLOW_MS = 9;                                 // a redraw taking longer than this is not done for every frame
const PAD = 28;                                    // around the drawing in the picture given to the model

export function createSurface({ onInk = () => {}, onUi = () => {} } = {}) {
  const base = h('canvas', { class: 'bd-base' }), live = h('canvas', { class: 'bd-live' });
  const selEl = h('div', { class: 'bd-sel', hidden: true });
  const NS = 'http://www.w3.org/2000/svg';
  const lassoEl = document.createElementNS(NS, 'svg'), lassoLine = document.createElementNS(NS, 'polygon');
  lassoEl.setAttribute('class', 'bd-lasso'); lassoEl.append(lassoLine);
  const el = h('div', { class: 'bd-surface', tabindex: '0' }, base, live, selEl, lassoEl);
  const bctx = base.getContext('2d'), lctx = live.getContext('2d', { desynchronized: true });

  let strokes = [], undone = [], history = [];     // history: { k: 'add', s } | { k: 'del', list: [{ i, s }] } | { k: 'move', list: [s], dx, dy }
  let tool = 'pencil', color = '#222222';
  const widths = { pencil: TOOLS.pencil.w, marker: TOOLS.marker.w };
  const view = { s: 1, x: 0, y: 0 };               // screen = board * s + (x, y), in layout pixels
  let W = 0, H = 0, k = 1, z = 1;                  // size in layout pixels; canvas pixels per layout pixel; page zoom
  let drawn = null, cost = 0, raf = 0, later = 0;  // the view the base shows; how long the last redraw took
  const picked = new Set();                        // the strokes picked
  let sel = null;                                  // the rectangle around them [x0, y0, x1, y1], or null
  let fingerDraws = prefs.get('board.finger', null);   // true / false as set in the toolbar; null = until a pen is seen
  let penSeen = !!prefs.get('board.pen', false);
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
    sel = picked.size ? extent([...picked]) : null;
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
  function shift(list, dx, dy) {
    for (const s of list) { for (let i = 0; i < s.p.length; i += 3) { s.p[i] = round(s.p[i] + dx); s.p[i + 1] = round(s.p[i + 1] + dy); } s.bb = bounds(s); }
  }
  function unpick() { if (!picked.size) return; picked.clear(); placeSel(); onUi(); }
  // the strokes a line drawn round them holds (most of each one's samples inside); pts: the line, in board coordinates
  function inside(pts) {
    const within = (x, y) => {
      let on = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) on = !on;
      }
      return on;
    };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return strokes.filter((s) => {
      if (s.bb[2] < x0 || s.bb[0] > x1 || s.bb[3] < y0 || s.bb[1] > y1) return false;
      let n = 0; const all = s.p.length / 3;
      for (let i = 0; i < s.p.length; i += 3) if (within(s.p[i], s.p[i + 1])) n++;
      return n * 2 > all;
    });
  }
  function removePicked() {
    if (!picked.size) return;
    const list = []; for (let i = strokes.length - 1; i >= 0; i--) if (picked.has(strokes[i])) { list.push({ i, s: strokes[i] }); strokes.splice(i, 1); }
    history.push({ k: 'del', list }); undone = []; picked.clear();
    render(); onInk(); onUi();
  }
  function undo() {
    const o = history.pop();
    if (!o) return;
    picked.clear();
    if (o.k === 'add') strokes.splice(strokes.lastIndexOf(o.s), 1);
    else if (o.k === 'move') shift(o.list, -o.dx, -o.dy);
    else for (let j = o.list.length - 1; j >= 0; j--) strokes.splice(o.list[j].i, 0, o.list[j].s);     // (back in, last out first)
    undone.push(o); render(); onInk();
  }
  function redo() {
    const o = undone.pop();
    if (!o) return;
    picked.clear();
    if (o.k === 'add') strokes.push(o.s);
    else if (o.k === 'move') shift(o.list, o.dx, o.dy);
    else for (const d of o.list) strokes.splice(strokes.indexOf(d.s), 1);
    history.push(o); render(); onInk();
  }
  function clear() {
    if (!strokes.length) return;
    const list = []; for (let i = strokes.length - 1; i >= 0; i--) list.push({ i, s: strokes[i] });
    strokes = []; history.push({ k: 'del', list }); undone = []; picked.clear();
    render(); onInk(); onUi();
  }

  // ---------- pointers ----------
  let box = null;                                  // the surface's place on screen, read when a pointer goes down
  const at = (e) => ({ x: (e.clientX - box.left) / z, y: (e.clientY - box.top) / z });
  const pressure = (e) => (e.pointerType === 'pen' ? Math.round(Math.max(0.05, e.pressure || 0) * 100) / 100 : NO_PRESSURE);
  const fingerDrawsNow = () => (fingerDraws == null ? !penSeen : fingerDraws);
  // which of draw / erase / pan / lasso / move this pointer starts (p: where, on the surface)
  const onPicked = (p) => { if (!sel) return false; const [bx, by] = toBoard(p.x, p.y); return bx >= sel[0] && bx <= sel[2] && by >= sel[1] && by <= sel[3]; };
  function kindOf(e, p) {
    let pick = tool === 'lasso';
    if (e.pointerType === 'pen') { if (e.button === 5 || (e.buttons & 32)) return 'erase'; if (e.button === 2 || (e.buttons & 2)) pick = true; }
    else if (e.pointerType === 'mouse') { if (e.button === 1) return 'pan'; if (e.button === 2) pick = true; }
    // on what is picked: it is dragged, whatever the tool and whatever presses (a finger too); to draw there, let go of
    // it first (a tap anywhere else with the 选中 tool, Esc, or simply drawing outside it)
    if (onPicked(p)) return 'move';
    if (e.pointerType === 'touch' && !fingerDrawsNow()) return 'pan';
    if (pick) return 'lasso';
    return tool === 'hand' ? 'pan' : tool === 'eraser' ? 'erase' : 'draw';
  }
  function lassoShow(pts) {
    lassoEl.style.display = pts ? 'block' : 'none';
    if (pts) lassoLine.setAttribute('points', pts.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' '));
  }
  function pinchStart() {
    const [a, b] = [...touches.values()];
    act = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, v: { ...view } };
  }
  function drop() {                                  // what was going on is given up (a second finger, the pen taking over)
    if (act && act.kind === 'draw') finish(false);
    if (act && act.kind === 'lasso') lassoShow(null);
    if (act && act.kind === 'move' && (act.dx || act.dy)) { history.push({ k: 'move', list: [...picked], dx: act.dx, dy: act.dy }); undone = []; onInk(); }
    if (act && act.kind === 'erase' && act.list.length) { history.push({ k: 'del', list: act.list }); undone = []; onInk(); }
    act = null;
  }
  function down(e) {
    box = el.getBoundingClientRect();
    el.focus({ preventScroll: true });
    const p = at(e);
    if (e.pointerType === 'pen' && !penSeen) { penSeen = true; prefs.set('board.pen', true); onUi(); }
    try { el.setPointerCapture(e.pointerId); } catch {}       // (every finger: one lifted outside the board must still be heard)
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, p);
      if (act && act.type !== 'touch') return;       // the pen or the mouse is at work: a hand resting on the screen
      if (touches.size === 2) { drop(); pinchStart(); act.type = 'touch'; }
      if (touches.size !== 1) return;
    } else if (act) { if (act.type !== 'touch') return; drop(); }
    const kind = kindOf(e, p);
    act = { kind, id: e.pointerId, type: e.pointerType, x: p.x, y: p.y, v: { ...view }, list: [], had: picked.size > 0 };
    if (kind === 'draw' || kind === 'erase') unpick();
    if (kind === 'draw') begin(p.x, p.y, pressure(e));
    else if (kind === 'erase') eraseAt(p.x, p.y);
    else if (kind === 'lasso') { act.pts = [[p.x, p.y]]; lassoShow(act.pts); }
    else if (kind === 'move') { act.b = toBoard(p.x, p.y); act.dx = act.dy = 0; }
    e.preventDefault();
  }
  function move(e) {
    if (!act && e.pointerType !== 'touch') {         // hovering: the cursor says what a press here would do
      box = el.getBoundingClientRect();
      el.classList.toggle('bd-over', onPicked(at(e)));
      return;
    }
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
    else if (act.kind === 'lasso') { act.pts.push([p.x, p.y]); lassoShow(act.pts); }
    else if (act.kind === 'move') {
      const [bx, by] = toBoard(p.x, p.y), dx = round(bx - act.b[0] - act.dx), dy = round(by - act.b[1] - act.dy);
      if (!dx && !dy) return;
      shift(picked, dx, dy); act.dx = round(act.dx + dx); act.dy = round(act.dy + dy);
      render();
    }
  }
  function up(e, cancelled) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (!act) return;
    if (act.kind === 'pinch') { if (touches.size < 2) act = touches.size ? { kind: 'rest', type: 'touch' } : null; return; }
    if (act.kind === 'rest') { if (!touches.size) act = null; return; }
    if (e.pointerId !== act.id) return;
    const a = act; act = null;
    if (a.kind === 'draw') finish(!cancelled && !(a.had && cur && cur.p.length === 3));     // (a tap that only let go of what was picked leaves no dot)
    else if (a.kind === 'erase' && a.list.length) { history.push({ k: 'del', list: a.list }); undone = []; onInk(); }
    else if (a.kind === 'move' && (a.dx || a.dy)) { history.push({ k: 'move', list: [...picked], dx: a.dx, dy: a.dy }); undone = []; onInk(); }
    else if (a.kind === 'lasso') {
      lassoShow(null);
      picked.clear();
      if (!cancelled) {
        const span = a.pts.reduce((m, q) => Math.max(m, Math.hypot(q[0] - a.x, q[1] - a.y)), 0);
        if (span < 6) {                              // a tap: the stroke under it (the one drawn last, when several)
          const [bx, by] = toBoard(a.x, a.y);
          for (let i = strokes.length - 1; i >= 0; i--) if (hit(strokes[i], bx, by, 6 / view.s)) { picked.add(strokes[i]); break; }
        } else for (const s of inside(a.pts.map(([x, y]) => toBoard(x, y)))) picked.add(s);
      }
      placeSel(); onUi();
    }
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
    setFinger(v) { fingerDraws = v; prefs.set('board.finger', v); }, fingerDraws: fingerDrawsNow,
    load(doc) {
      strokes = ((doc && doc.strokes) || []).map((s) => { const x = { t: s.t, c: s.c, w: s.w, p: s.p }; x.bb = bounds(x); return x; });
      history = []; undone = []; picked.clear(); cur = null; act = null;
      fit();
    },
    doc: () => ({ v: 1, strokes: strokes.map(({ t, c, w, p }) => ({ t, c, w, p })) }),
    count: () => strokes.length,
    undo, redo, clear, canUndo: () => history.length > 0, canRedo: () => undone.length > 0,
    fit, zoomBy(f) { zoomAt(W / 2, H / 2, f); }, scale: () => view.s,
    picked: () => picked.size, unpick, removePicked,
    // what is picked (or everything drawn) with a margin, as a picture: { canvas, rect } -- null when there is nothing
    picture(maxSide) {
      const list = picked.size ? strokes.filter((s) => picked.has(s)) : strokes, e = extent(list);
      if (!e) return null;
      const rect = [e[0] - PAD, e[1] - PAD, e[2] + PAD, e[3] + PAD];
      return { canvas: picture(list, rect, maxSide), rect };
    },
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(later); },
  };
}
