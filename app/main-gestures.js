'use strict';
// Bubble panel window, P-chan fold state, and main-process cursor/touch drag & resize controllers.

const fs = require('fs');
const path = require('path');

function createPanelAndGestures({
  app,
  BrowserWindow,
  ipcMain,
  screen,
  settings,
  save,
  ART_W,
  winSize,
  setScale,
  buildMenu,
  bridge,
  getWin,
  getSessions,
  onPushBubble,
}) {
  const chatMode = () => settings.panelMode === 'chat';
  const pchanMode = () => settings.panelMode === 'pchan';
  const sizeKeys = () => (chatMode() ? ['chatW', 'chatH', 680, 460] : ['panelW', 'panelH', 600, 280]);

  if (settings.panelCollapsed) {
    if (settings.panelMode === 'popup') settings.panelMode = 'pchan';
    delete settings.panelCollapsed;
  }

  let bubW, bubH;
  function loadPanelSize() {
    const [kw, kh, dw, dh] = sizeKeys();
    bubW = settings[kw] || dw;
    bubH = settings[kh] || dh;
  }
  loadPanelSize();

  let panelPeek = false;
  let panelUnread = 0;
  let bubbleWin = null;
  const folded = () => pchanMode() && !panelPeek;
  const getBubbleWin = () => bubbleWin;

  function clampToScreen(x, y, w, h) {
    const d = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    return {
      x: Math.round(Math.max(d.x, Math.min(d.x + d.width - w, x))),
      y: Math.round(Math.max(d.y, Math.min(d.y + d.height - h, y))),
    };
  }

  const maxPanelDX = (b) => bubW / 2 + b.width / 2;
  const minPanelDY = () => 6 - bubH;
  const clampDY = (dy) => Math.max(minPanelDY(), Math.min(0, dy || 0));

  function keepAmeOnTop() {
    const win = getWin();
    if (win && !win.isDestroyed() && bubbleWin && bubbleWin.isVisible()) win.moveTop();
  }

  function sendPanel() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const all = [...getSessions().values()];
    win.webContents.send('panel', {
      collapsed: folded(),
      unread: all.length ? panelUnread : 0,
      waiting: all.some((s) => s.state === 'waiting'),
      n: all.length,
    });
  }

  function sendFolded() {
    if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.webContents.send('bubble-collapsed', folded());
    sendPanel();
  }

  function placeBubble() {
    const win = getWin();
    if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return;
    const b = win.getBounds(), wa = screen.getDisplayMatching(b).workArea;
    const m = maxPanelDX(b);
    settings.panelDX = Math.max(-m, Math.min(m, settings.panelDX || 0));
    settings.panelDY = clampDY(settings.panelDY);
    const hang = b.y + b.height - 6;
    let x = Math.round(b.x + b.width / 2 - bubW / 2 + settings.panelDX);
    let y = hang + settings.panelDY;
    if (y + bubH > wa.y + wa.height) y = wa.y + wa.height - bubH;
    x = Math.max(wa.x, Math.min(wa.x + wa.width - bubW, x));
    y = Math.max(wa.y, y);
    settings.panelDX = x + bubW / 2 - (b.x + b.width / 2);
    settings.panelDY = clampDY(y - hang);
    bubbleWin.setBounds({ x, y: Math.round(y), width: bubW, height: bubH });
    keepAmeOnTop();
  }

  function hideBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) bubbleWin.hide();
    if (panelPeek) { panelPeek = false; sendFolded(); }
  }

  function expandPanel() {
    if ((!getSessions().size && !chatMode()) || !bubbleWin || bubbleWin.isDestroyed()) return;
    if (pchanMode()) { panelPeek = true; sendFolded(); }
    onPushBubble(null);
    placeBubble();
    bubbleWin.showInactive();
    keepAmeOnTop();
  }

  function setPanelMode(v) {
    settings.panelMode = v;
    save();
    buildMenu();
    loadPanelSize();
    if (chatMode()) bridge.start();
    panelPeek = false;
    sendFolded();
    onPushBubble(null);
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    if (chatMode()) { placeBubble(); bubbleWin.showInactive(); }
    else if (v === 'off' || v === 'pchan') hideBubble();
    else if (bubbleWin.isVisible()) placeBubble();
  }

  function createBubble() {
    bubbleWin = new BrowserWindow({
      width: bubW, height: bubH, transparent: true, frame: false, resizable: false, thickFrame: false,
      hasShadow: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), backgroundThrottling: false },
    });
    bubbleWin.setAlwaysOnTop(true, 'floating');
    bubbleWin.loadFile('bubble.html');
    bubbleWin.webContents.on('did-finish-load', () => { onPushBubble(null); sendFolded(); });
    bubbleWin.on('focus', keepAmeOnTop);
    bubbleWin.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level < 1) return;
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'renderer.log'),
          `${new Date().toISOString()} [panel] ${message} (${path.basename(source || '')}:${line})\n`
        );
      } catch {}
    });
    return bubbleWin;
  }

  // ---- Bubble panel drag & resize ----
  let panelGest = null, panelTimer = null;
  function endPanelResize() {
    if (!panelGest) return;
    const wasDrag = panelGest.drag;
    clearInterval(panelTimer);
    panelGest = null;
    const win = getWin();
    if (wasDrag) {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        settings.x = x; settings.y = y; save();
      }
      return;
    }
    const [kw, kh] = sizeKeys();
    settings[kw] = bubW; settings[kh] = bubH; save();
  }

  ipcMain.on('bubble-close', () => hideBubble());
  ipcMain.on('bubble-collapse', (_e, v) => {
    if (!v) expandPanel();
    else if (!pchanMode()) setPanelMode('pchan');
    else hideBubble();
  });
  ipcMain.on('panel-expand', () => expandPanel());
  ipcMain.on('bubble-unread', (_e, n) => { panelUnread = n | 0; sendPanel(); });
  ipcMain.on('bubble-size', () => {});

  ipcMain.on('bubble-gesture', (_e, kind) => {
    const win = getWin();
    if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return;
    if (kind === 'resize-start') {
      const p = screen.getCursorScreenPoint();
      panelGest = { x0: p.x, y0: p.y, w0: bubW, h0: bubH };
      clearInterval(panelTimer);
      panelTimer = setInterval(() => {
        const c = screen.getCursorScreenPoint();
        const w = Math.max(380, Math.min(1400, panelGest.w0 + c.x - panelGest.x0));
        const h = Math.max(180, Math.min(1000, panelGest.h0 + c.y - panelGest.y0));
        if (w !== bubW || h !== bubH) { bubW = w; bubH = h; placeBubble(); }
      }, 16);
    } else if (kind === 'resize-end') {
      endPanelResize();
    } else if (kind === 'drag-start') {
      const p = screen.getCursorScreenPoint(), wb = win.getBounds();
      panelGest = { drag: true, x0: p.x, y0: p.y, dx0: settings.panelDX || 0, dy0: clampDY(settings.panelDY), px: wb.x, py: wb.y, w: wb.width, h: wb.height };
      clearInterval(panelTimer);
      panelTimer = setInterval(() => {
        const wNow = getWin();
        if (!wNow || wNow.isDestroyed() || !panelGest) return;
        const c = screen.getCursorScreenPoint(), g = panelGest;
        const m = maxPanelDX({ width: g.w });
        const want = g.dx0 + (c.x - g.x0), wantY = g.dy0 + (c.y - g.y0);
        const dx = Math.max(-m, Math.min(m, want)), dy = clampDY(wantY);
        const pull = want - dx, pullY = wantY - dy;
        const pos = clampToScreen(g.px + pull, g.py + pullY, g.w, g.h);
        settings.panelDX = dx; settings.panelDY = dy;
        const curB = wNow.getBounds();
        if (pos.x !== curB.x || pos.y !== curB.y) wNow.setBounds({ x: pos.x, y: pos.y, width: g.w, height: g.h });
        else placeBubble();
      }, 8);
    } else if (kind === 'drag-end') {
      endPanelResize();
    }
  });

  // ---- Ame character window drag & resize (mouse cursor polling + touch coordinate forwarding) ----
  let gest = null, gestTimer = null;
  const fingerOnScreen = (x, y) => {
    const b = getWin().getBounds();
    return { x: b.x + x, y: b.y + y };
  };

  function stepGesture() {
    const win = getWin();
    if (!win || win.isDestroyed() || !gest) return;
    const p = gest.touch ? gest.at : screen.getCursorScreenPoint();
    if (gest.kind === 'drag') {
      const c = clampToScreen(p.x - gest.dx, p.y - gest.dy, gest.w, gest.h);
      if (c.x !== gest.lx || c.y !== gest.ly) {
        win.webContents.send('winmove', c.x - gest.lx, c.y - gest.ly);
        gest.lx = c.x; gest.ly = c.y;
        if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) {
          const cx = c.x + gest.w / 2, m = maxPanelDX({ width: gest.w });
          if (gest.panelCX == null) { const pb = bubbleWin.getBounds(); gest.panelCX = pb.x + pb.width / 2; }
          gest.panelCX = Math.max(cx - m, Math.min(cx + m, gest.panelCX));
          settings.panelDX = gest.panelCX - cx;
          const hang = c.y + gest.h - 6;
          if (gest.panelTY == null) gest.panelTY = bubbleWin.getBounds().y;
          gest.panelTY = Math.max(hang + minPanelDY(), Math.min(hang, gest.panelTY));
          settings.panelDY = gest.panelTY - hang;
        }
        win.setBounds({ x: c.x, y: c.y, width: gest.w, height: gest.h });
      }
    } else {
      const s = Math.max(0.16, Math.min(0.9, (gest.w + p.x - gest.x0) / ART_W));
      if (Math.abs(s - settings.scale) > 0.002) setScale(s, false);
    }
  }

  function endGesture() {
    if (!gest) return;
    clearInterval(gestTimer);
    gestTimer = null;
    const kind = gest.kind;
    gest = null;
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (kind === 'drag') {
      const [x, y] = win.getPosition();
      settings.x = x; settings.y = y; save();
    } else {
      setScale(settings.scale, true);
    }
  }

  const isTouchGestureActive = () => Boolean(gest && gest.touch);

  ipcMain.on('gesture', (_e, kind, x, y) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (kind === 'drag-start' || kind === 'resize-start') {
      endGesture();
      const touch = Number.isFinite(x) && Number.isFinite(y);
      const p = touch ? fingerOnScreen(x, y) : screen.getCursorScreenPoint(), b = win.getBounds();
      const sz = winSize();
      gest = { kind: kind === 'drag-start' ? 'drag' : 'resize', dx: p.x - b.x, dy: p.y - b.y, x0: p.x, w: sz.width, h: sz.height, lx: b.x, ly: b.y, touch, at: p };
      gestTimer = setInterval(stepGesture, 8);
    } else if (kind === 'drag-end' || kind === 'resize-end') {
      endGesture();
    }
  });

  ipcMain.on('gesture-at', (_e, x, y) => {
    const win = getWin();
    if (win && !win.isDestroyed() && gest && gest.touch && Number.isFinite(x) && Number.isFinite(y)) {
      gest.at = fingerOnScreen(x, y);
      stepGesture();
    }
  });

  ipcMain.on('drag-by', (_e, dx, dy) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const c = clampToScreen(b.x + dx, b.y + dy, b.width, b.height);
    win.setPosition(c.x, c.y);
  });

  return {
    chatMode,
    pchanMode,
    folded,
    getBubbleWin,
    clampToScreen,
    createBubble,
    placeBubble,
    hideBubble,
    expandPanel,
    setPanelMode,
    sendPanel,
    keepAmeOnTop,
    endGesture,
    endPanelResize,
    isTouchGestureActive,
  };
}

module.exports = { createPanelAndGestures };
