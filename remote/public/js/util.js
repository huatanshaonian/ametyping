// Small shared helpers for the desktop modules.
export const $ = (sel, root = document) => root.querySelector(sel);

// h('div', { class: 'x', text: '...', dataset: {}, onclick }, child, ...) -- never takes HTML
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

// one line of Markdown as plain text (a card's last line): no **, `, #, >, list marks, link targets
export const plain = (s) => String(s || '')
  .replace(/`{3}[^\n]*\n?/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`|~~)/g, '')
  .replace(/^\s*(#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '').replace(/\s+/g, ' ').trim();
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const mdhm = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const ago = (t) => {
  const ts = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}秒前` : s < 3600 ? `${Math.floor(s / 60)}分前` : s < 86400 ? `${Math.floor(s / 3600)}小时前` : `${Math.floor(s / 86400)}天前`;
};
export function fmtUptime(sec) {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${hr}小时`;
  if (hr > 0) return `${hr}小时 ${m}分`;
  return `${m}分钟`;
}
export function fmtBytes(b) {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}
export function formatResetAt(resetAt) {
  if (!resetAt) return '';
  const ms = Date.parse(resetAt) - Date.now();
  if (!Number.isFinite(ms)) return String(resetAt);
  if (ms <= 0) return '即将恢复';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} 分钟后`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr} 小时 ${rem} 分后` : `${hr} 小时后`;
}
export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
export function codeBlock(title, text, btnText = '复制') {
  const pre = h('pre', { tabindex: '0' }, h('code', { text }));
  const status = h('span', { class: 'ocg-copy-note', 'aria-live': 'polite' });
  const copy = h('button', { class: 'btn', type: 'button', text: btnText, onclick: async () => {
    try { await navigator.clipboard.writeText(text); status.textContent = '已复制'; }
    catch {
      const r = document.createRange();
      r.selectNodeContents(pre);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      status.textContent = '已选中，按 Ctrl+C 复制';
    }
  } });
  return h('div', { class: 'ocg-code' }, h('div', { class: 'ocg-code-head' }, h('b', { text: title }), copy, status), pre);
}
export const icon = (name, small) => `/icons/${name}${small ? '-16' : ''}.png`;
export const narrow = () => matchMedia('(max-width: 700px)').matches;
// the page zoom set by the size setting (js/theme.js): pointer movements are in screen pixels, layout in page pixels
export const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;

// per-browser preferences (selected machine, wallpaper...): never required, so storage failures are ignored
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('ame.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ame.' + k, JSON.stringify(v)); } catch {} },
};

// how much context a session has left, in percent (null when not known yet). Claude Code compacts on its own about
// 33k tokens before the window is full ("Context left until auto-compact"); Codex counts from a 12k baseline.
export function ctxLeft(s) {
  const c = s && s.ctx;
  if (!c || !(c.win > 0)) return null;
  const id = String(s.id || '');
  const left = id.startsWith('codex:') ? (c.win - c.used) / Math.max(1, c.win - 12000)
    : /^(opencode|agy|kiro):/.test(id) ? (c.win - c.used) / c.win
    : (c.win - 33000 - c.used) / Math.max(1, c.win - 33000);
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}
export const CTX_LOW = 20;                // the dashboard warns from here down

// the AI provider mark a session's OpenCode badge shows next to OpenCode's own ({ slug, name } or null); the name
// carries the session's model too when it is known ("Anthropic · Claude Opus 5.5 (Medium)"), for the tooltips
const modelName = (s) => String((s && s.model && typeof s.model === 'object' ? s.model.id : s && s.model) || '').trim().slice(0, 80);
export const aiMark = (s) => {
  if (!(s && s.ai && /^[a-z0-9-]{1,32}$/.test(String(s.ai.slug || '')))) return null;
  const name = String(s.ai.name || ''), model = modelName(s);
  return { slug: String(s.ai.slug), name: model && model.toLowerCase() !== name.toLowerCase() ? (name ? name + ' · ' : '') + model : name };
};

// session states as the dashboard names them
const STATE = { message: ['working', '进行中'], thinking: ['working', '进行中'], reading: ['working', '进行中'],
  error: ['working', '出错'], working: ['working', '进行中'], waiting: ['waiting', '等你确认'], done: ['done', '完成'], idle: ['idle', '空闲'], ended: ['idle', '已关闭'],
  history: ['idle', '历史'] };
export const stateOf = (s) => STATE[s] || ['idle', s || '空闲'];
// "waiting" is two things: a permission asked (a card, or a 确认 line when the card has gone) -- 等你确认; and Claude
// Code's notice that it has stopped and waits for the next message -- 等你回复. s: a session of the snapshot.
export function stateName(s) {
  const [cls, name] = stateOf(s.state);
  if (s.state !== 'waiting') return [cls, name];
  const last = [...(s.lines || [])].reverse().find((l) => l.text);
  return [cls, (s.perms || []).length || /确认/.test(last ? last.text : '') ? '等你确认' : '等你回复'];
}
export const isWorking = (s) => stateOf(s)[0] === 'working';
