// The one WebSocket to the server: session list, conversations, and actions (send / key / decide) with results.
import { askCode } from './gate.js';

const handlers = new Map();
let ws = null, ridN = 0;
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

export function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { state.online = true; emit('status', true); emit('open'); };
  ws.onclose = (e) => {
    if (e.code === 4401) { location.href = '/login'; return; }
    state.online = false; emit('status', false);
    setTimeout(connect, 2000);
    for (const [rid, f] of waiting) { waiting.delete(rid); f({ ok: false, msg: '连接断了，结果不确定，请看对话确认' }); }
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.t === 'sessions') { state.sessions = d.data || []; emit('sessions', state.sessions); }
    else if (d.t === 'conv') emit('conv', d);
    else if (d.t === 'result') { const f = waiting.get(d.rid); if (f) { waiting.delete(d.rid); f(d); } }
  };
}

// an action on a machine; acting needs a recently entered code: ask for it and retry
export function act(o) {
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

export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
}
