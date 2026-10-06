// The one WebSocket to the server: session list, conversations, and actions (send / key / decide) with results.
// Kept alive across what phones do to a page in the background: the system freezes it and drops the socket, often
// without telling the page -- back on screen it would look connected and show old data. So whenever the page comes
// back (visible, focused, the network back) and every 30 s while it is on screen, the socket is checked: gone ->
// connect at once; there -> a ping that must be answered within 4 s, or it is replaced. Back from more than a few
// seconds out of sight (a phone's background), the socket is not even asked: a new one right away -- asking a dead
// one only costs the 4 s.
import { askCode } from './gate.js';
import * as sound from './sound.js';

const handlers = new Map();
let ws = null, ridN = 0;
let retryT = null, tries = 0, lastMsg = 0, probeT = null;
const RETRY = [1000, 2000, 4000, 8000, 15000], PROBE_MS = 4000, BEAT_MS = 30000, AWAY_MS = 5000;
let hiddenAt = 0;
const waiting = new Map();                 // rid -> callback
export const state = { sessions: [], online: false };

// subscribe; returns an unsubscribe function
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}
function emit(type, d) { for (const fn of handlers.get(type) || []) { try { fn(d); } catch (e) { console.error(e); } } }

export function send(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} }

// this socket is no more (closed, or it stopped answering): tell everyone, try again -- sooner at first
function lost(s) {
  if (s !== ws) return;                              // (an older one: already replaced)
  ws = null; clearTimeout(probeT);
  if (state.online) { state.online = false; emit('status', false); }
  for (const [rid, f] of waiting) { waiting.delete(rid); f({ ok: false, msg: '连接断了，结果不确定，请看对话确认' }); }
  clearTimeout(retryT);
  retryT = setTimeout(connect, RETRY[Math.min(tries++, RETRY.length - 1)]);
}
export function connect() {
  clearTimeout(retryT);
  if (ws && ws.readyState <= 1) return;              // there already, or on its way
  const s = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  s.onopen = () => { if (s !== ws) return; tries = 0; lastMsg = Date.now(); state.online = true; emit('status', true); emit('open'); };
  s.onclose = (e) => {
    if (e.code === 4401) { location.href = '/login'; return; }
    lost(s);
  };
  s.onerror = () => { try { s.close(); } catch {} };
  s.onmessage = (e) => {
    if (s !== ws) return;
    lastMsg = Date.now();
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'pong') return;
    if (d.t === 'sessions') { state.sessions = d.data || []; emit('sessions', state.sessions); }
    else if (d.t === 'conv') emit('conv', d);
    else if (d.t === 'result') { const f = waiting.get(d.rid); if (f) { waiting.delete(d.rid); f(d); } }
    else if (typeof d.t === 'string' && d.t.startsWith('fs-')) emit('fs', d);     // file explorer (fs.js)
    else if (d.t === 'todos') emit('todos');                                       // the important list changed
    else if (d.t === 'notes') emit('notes');                                       // a note was saved / deleted
    else if (d.t === 'marks') emit('marks');                                       // 看板 marks / groups changed
    else if (typeof d.t === 'string') emit(d.t, d);                                // anything else by its name (google, mail, ...)
  };
}

// Is the socket still good? Asked when the page comes back on screen and now and then while it is there.
// a new socket in place of this one, without a word to the rest of the page unless connecting fails
function replace(s) {
  s.onclose = s.onmessage = s.onopen = null; try { s.close(); } catch {}
  ws = null; clearTimeout(probeT); clearTimeout(retryT); tries = 0;
  for (const [rid, f] of waiting) { waiting.delete(rid); f({ ok: false, msg: '连接断了，结果不确定，请看对话确认' }); }
  connect();
}
export function check() {
  if (document.hidden) { if (!hiddenAt) hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (!ws || ws.readyState > 1) { tries = 0; return connect(); }
  if (ws.readyState !== 1) return;                   // still connecting
  if (away >= AWAY_MS) return replace(ws);           // out of sight for a while: most likely dead, not worth asking
  const s = ws, at = Date.now();
  send({ t: 'ping' });
  clearTimeout(probeT);
  // no word back: it is dead without having said so (closing it properly could take minutes) -- replaced now
  probeT = setTimeout(() => { if (s === ws && lastMsg < at) replace(s); }, PROBE_MS);
}
// 「重新连接」 (the connection mark in the tray): a new socket now, whatever the one there looks like
export function reconnect() {
  if (state.online) { state.online = false; emit('status', false); }
  if (ws && ws.readyState <= 1) replace(ws); else { clearTimeout(retryT); tries = 0; connect(); }
}
document.addEventListener('visibilitychange', check);
for (const ev of ['pageshow', 'focus', 'online']) addEventListener(ev, check);
setInterval(check, BEAT_MS);

// an action on a machine; acting needs a recently entered code: ask for it and retry. A failure plays the error sound.
export async function act(o) {
  const r = await actOnce(o);
  if (!r.ok && r.msg !== '已取消') sound.play('error');
  return r;
}
function actOnce(o) {
  return new Promise((resolve) => {
    const go = () => {
      if (!ws || ws.readyState !== 1) return resolve({ ok: false, msg: '还没连上服务器' });
      const rid = 'r' + (++ridN) + '-' + Date.now().toString(36);
      waiting.set(rid, (r) => {
        if (r.need !== 'totp') return resolve(r);
        askCode().then((ok) => (ok ? go() : resolve({ ok: false, msg: '已取消' })));
      });
      send({ ...o, rid });
      setTimeout(() => { const f = waiting.get(rid); if (f) { waiting.delete(rid); f({ ok: false, msg: '没有回应，结果不确定，请看对话确认' }); } }, 25000);
    };
    go();
  });
}

// a POST to the server that may need a recently entered code ({ need: 'totp' }): ask for it and retry
export async function post(url, body) {
  for (;;) {
    let r;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (res.status === 401) { location.href = '/login'; return { ok: false, msg: '需要重新登录' }; }
      r = await res.json();
    } catch { r = { ok: false, msg: '请求失败' }; }
    if (r.need === 'totp') { if (await askCode()) continue; return { ok: false, msg: '已取消' }; }
    if (!r.ok) sound.play('error');
    return r;
  }
}

export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
}
