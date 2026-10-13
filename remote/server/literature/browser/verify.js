// One normal click on the visible Cloudflare Turnstile checkbox, only on a page the caller already identified as
// a challenge. The widget may be inside a shadow root: DevTools supplies its iframe's visible box. No responses,
// tokens or browser identity are changed. Unknown widgets/layouts are left for the user.
'use strict';

function turnstileFrames(root) {
  const found = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeName === 'IFRAME') {
      const attrs = node.attributes || [];
      let srcAt = -1;
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'src') { srcAt = i; break; }
      if (srcAt >= 0) {
        try {
          const url = new URL(attrs[srcAt + 1]);
          if (url.protocol === 'https:' && url.hostname === 'challenges.cloudflare.com' &&
            url.pathname.startsWith('/cdn-cgi/challenge-platform/') && url.pathname.includes('/turnstile/')) found.push(node);
        } catch {}
      }
      // Coordinates of nested documents are not necessarily in the top page's viewport.
      return;
    }
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
  }
  walk(root);
  return found;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkboxes(root) {
  const found = [];
  function walk(node) {
    if (!node || node.nodeName === 'IFRAME') return;
    const attrs = node.attributes || [];
    const typeAt = attrs.findIndex((a, i) => i % 2 === 0 && a === 'type');
    if (node.nodeName === 'INPUT' && typeAt >= 0 && attrs[typeAt + 1] === 'checkbox' &&
      !attrs.some((a, i) => i % 2 === 0 && ['disabled', 'checked'].includes(a))) found.push(node);
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
  }
  walk(root);
  return found;
}

async function readyCheckbox(c, sid) {
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const visible = [];
  const frames = turnstileFrames(root);
  if (!frames.length) return null;                           // the challenge script has not rendered its iframe yet
  for (const frame of frames) {
    try {
      const { model } = await c.send('DOM.getBoxModel', { backendNodeId: frame.backendNodeId }, sid);
      const q = model.content;
      if (!q || q.length !== 8 || !q.every(Number.isFinite)) continue;
      const width = q[2] - q[0], height = q[7] - q[1];
      // The normal checkbox widget is 300 x 65 CSS pixels. Compact, invisible, rotated, or other layouts need a person.
      if (width < 290 || width > 310 || height < 60 || height > 75 || Math.abs(q[1] - q[3]) > 1 || Math.abs(q[0] - q[6]) > 1) continue;
      if (frame.frameId) visible.push({ frame, origin: { x: q[0], y: q[1] }, width, height });
    } catch {} // hidden or removed while loading
  }
  if (visible.length !== 1) return false;
  const { frame, origin, width, height } = visible[0];
  // Chromium only permits attaching to an OOPIF after it has been discovered by this DevTools connection.
  const targets = (await c.send('Target.getTargets')).targetInfos || [];
  if (!targets.some(t => t.targetId === frame.frameId && t.type === 'iframe')) return null;
  const child = await c.attach(frame.frameId);
  const doc = await c.send('DOM.getDocument', { depth: -1, pierce: true }, child);
  const inputs = checkboxes(doc.root);
  if (inputs.length !== 1) return null;                         // still checking/loading, or not a checkbox challenge
  const box = (await c.send('DOM.getBoxModel', { backendNodeId: inputs[0].backendNodeId }, child)).model.content;
  if (!box || box.length !== 8 || !box.every(Number.isFinite)) return null;
  const w = box[2] - box[0], h = box[7] - box[1];
  if (w < 12 || h < 12 || box[0] < 0 || box[1] < 0 || box[2] > width || box[7] > height) return null;
  const at = { x: origin.x + box[0] + Math.min(w, h) / 2, y: origin.y + box[1] + h / 2 };
  const { cssVisualViewport: view, visualViewport } = await c.send('Page.getLayoutMetrics', {}, sid);
  const viewport = view || visualViewport;
  if (!viewport || at.x < 0 || at.y < 0 || at.x >= viewport.clientWidth || at.y >= viewport.clientHeight) return false;
  return at;
}

async function clickTurnstile(c, sid, { waitMs = 15e3, pollMs = 1000, sleepFn = sleep } = {}) {
  let at;
  const until = Date.now() + waitMs;
  for (;;) {
    at = await readyCheckbox(c, sid).catch(() => null);
    if (at) break;
    if (at === false || Date.now() >= until) return false;
    await sleepFn(Math.max(1, Math.min(pollMs, until - Date.now())));
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, sid);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 }, sid);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 }, sid);
  return true;
}

module.exports = { clickTurnstile };
