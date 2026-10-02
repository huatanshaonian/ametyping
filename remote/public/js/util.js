// Small shared helpers for the desktop modules.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
export const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}秒前` : s < 3600 ? `${Math.floor(s / 60)}分前` : s < 86400 ? `${Math.floor(s / 3600)}小时前` : `${Math.floor(s / 86400)}天前`;
};
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
  const left = s.id.startsWith('codex:') ? (c.win - c.used) / (c.win - 12000) : (c.win - 33000 - c.used) / (c.win - 33000);
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}
export const CTX_LOW = 20;                // the dashboard warns from here down

// session states as the dashboard names them
const STATE = { message: ['working', '进行中'], thinking: ['working', '进行中'], reading: ['working', '进行中'],
  error: ['working', '出错'], working: ['working', '进行中'], waiting: ['waiting', '等你确认'], done: ['done', '完成'], idle: ['idle', '空闲'], ended: ['idle', '已关闭'],
  history: ['idle', '历史'] };
export const stateOf = (s) => STATE[s] || ['idle', s || '空闲'];
export const isWorking = (s) => stateOf(s)[0] === 'working';
