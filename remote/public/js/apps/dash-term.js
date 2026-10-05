// 终端画面 in the dashboard: what the session's terminal shows right now, as text. Claude Code's own menus (/model,
// /resume, /config, a prompt) are drawn on the terminal's screen and never reach the conversation -- here they can be
// seen, and worked with the key buttons (each key press brings the screen after it). Read when you ask (opening it,
// 刷新, a key, a command sent that opens a menu), never polled.
import { h } from '../util.js';

// Claude Code's commands that open a menu or a screen of their own in the terminal (the panel opens by itself for
// these only; others -- /compact, /clear, a skill -- just run). The first group only when sent bare: with an
// argument ("/model opus") they act at once.
const MENU_BARE = new Set(['model', 'effort', 'resume', 'theme', 'output-style', 'rename', 'export', 'add-dir', 'fast']);
const MENU = new Set(['config', 'permissions', 'mcp', 'agents', 'hooks', 'plugin', 'memory', 'status', 'usage', 'help', 'rewind', 'login', 'logout',
  'ide', 'tasks', 'bashes', 'statusline', 'terminal-setup', 'doctor', 'privacy-settings', 'tui']);
export function opensMenu(text) {
  const m = /^\s*\/([\w-]+)(\s+\S)?/.exec(String(text || ''));
  return !!m && (MENU.has(m[1]) || (MENU_BARE.has(m[1]) && !m[2]));
}

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// read(): asks for the current session's screen -> { ok, screen, msg }; press(key): a key into the terminal
export function createTerm({ read, press = () => {}, onToggle = () => {} }) {
  const pre = h('pre', { class: 'tscr', tabindex: '0' });
  const st = h('span', { class: 'tst' });
  // a letter or a digit as a key: some menus take them ("s to use this session only", "2" for the second entry)
  const one = h('input', { class: 'field tkey', maxlength: '1', placeholder: '字母/数字键', title: '按一个字母或数字键（有的菜单用它们选择，例如 s、2）', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  one.addEventListener('input', () => { const c = one.value.toLowerCase(); one.value = ''; if (/^[a-z0-9]$/.test(c)) press('c:' + c); });
  one.addEventListener('keydown', (e) => e.stopPropagation());       // (not the dashboard's own keys)
  const el = h('div', { class: 'term', hidden: true },
    h('div', { class: 'tbar' }, h('b', { text: '终端画面' }), st, one,
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => load() }),
      h('button', { class: 'btn', type: 'button', text: '×', title: '收起', onclick: () => show(false) })),
    pre);
  let open = false, cur = null, seq = 0;

  // the screen as just read (also the one that came back with a key press)
  function set(text) {
    seq++;                                            // (a slower read still under way is out of date)
    pre.textContent = text || '（画面是空的）';
    pre.scrollTop = pre.scrollHeight;                 // the input box and the menus are at the bottom
    const d = new Date();
    st.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 读的`;
  }
  // wait: let the terminal draw first (a command just sent)
  async function load(wait = 0) {
    const key = cur; if (!key || !open) return;
    const n = ++seq;
    st.textContent = '读取中…';
    if (wait) await sleep(wait);
    const r = await read();
    if (n !== seq || key !== cur || !open) return;
    if (r && r.ok) set(r.screen); else st.textContent = (r && r.msg) || '读不到画面';
  }
  function show(on) {
    if (on === open) return;
    open = !!on && !!cur; el.hidden = !open;
    onToggle(open);
    if (open) { pre.textContent = ''; load(); }
  }
  // key: the session shown ("machine|id"), null when it has no terminal to read: the panel closes
  function target(key) {
    if (key === cur) return;
    cur = key; seq++;
    if (!key) { open = false; el.hidden = true; onToggle(false); } else if (open) { pre.textContent = ''; load(); }
  }
  return { el, show, set, load, target, get open() { return open; } };
}
