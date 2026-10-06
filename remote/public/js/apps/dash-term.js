// 终端画面 in the dashboard: what the session's terminal shows right now. Claude Code's own menus (/model, /resume,
// /config, a prompt) are drawn on the terminal's screen and never reach the conversation -- here the screen is read as
// text (when you ask: opening it, 刷新, a key, a command sent that opens a menu; never polled), taken apart
// (term-parse.js) and shown as a card like the dashboard's others: the menu's title and tabs, its rows with the one
// under the cursor marked, a slider, name / value lines, and the keys the menu says it takes as buttons. A click on a
// row moves the terminal's cursor there (arrow keys, the screen read back after each); a click on the row under the
// cursor is Enter. What is not recognised is shown as the text it is; 「原文」 shows the whole screen that way.
import { h } from '../util.js';
import { parseScreen, cursorOf, plainScreen } from './term-parse.js';

// Claude Code's commands that open a menu or a screen of their own in the terminal (the panel opens by itself for
// these only; others -- /compact, /clear, /context, a skill -- just run and print into the conversation). The first
// group only when sent bare: with an argument ("/model opus") they act at once.
const MENU_BARE = new Set(['model', 'effort', 'resume', 'theme', 'export', 'add-dir', 'fast']);
const MENU = new Set(['config', 'permissions', 'mcp', 'hooks', 'plugin', 'plugins', 'memory', 'status', 'usage', 'stats', 'help', 'rewind', 'login', 'logout',
  'ide', 'tasks', 'bashes', 'statusline', 'terminal-setup', 'privacy-settings', 'tui']);
export function opensMenu(text) {
  const m = /^\s*\/([\w-]+)(\s+\S)?/.exec(String(text || ''));
  return !!m && (MENU.has(m[1]) || (MENU_BARE.has(m[1]) && !m[2]));
}

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RELOADS = 4;                  // a menu still loading is read again by itself, this many times at most

// read(): asks for the current session's screen -> { ok, screen, msg }; press(key): a key into the terminal, resolves
// true once the screen after it has been shown (set), false when the key could not be sent
export function createTerm({ read, press = async () => false, onToggle = () => {} }) {
  const pre = h('pre', { class: 'tscr', hidden: true });
  const card = h('div', { class: 'tcard' });
  const st = h('span', { class: 'tst' });
  const rawBtn = h('button', { class: 'btn', type: 'button', text: '原文', title: '按终端里的原样显示整个画面' });
  const body = h('div', { class: 'tbody', tabindex: '0' }, card, pre);
  const el = h('div', { class: 'term', hidden: true },
    h('div', { class: 'tbar' }, h('b', { text: '终端画面' }), st, rawBtn,
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => load() }),
      h('button', { class: 'btn', type: 'button', text: '×', title: '收起', onclick: () => show(false) })),
    body);
  let open = false, cur = null, seq = 0, raw = false, busy = false, parsed = { kind: 'empty' }, reloads = 0, draft = '';
  rawBtn.addEventListener('click', () => { raw = !raw; draw(); });

  // one key (or "c:text"); while a row is being walked to, other clicks wait
  async function send(key) {
    if (busy) return false;
    busy = true; el.classList.add('busy');
    try { return await press(key); } finally { busy = false; el.classList.remove('busy'); }
  }
  async function many(key, n) {
    if (busy) return;
    busy = true; el.classList.add('busy');
    try { for (let i = 0; i < n; i++) if (!(await press(key))) break; } finally { busy = false; el.classList.remove('busy'); }
  }
  // move the terminal's cursor to a row: one arrow at a time, the screen read back after each, until the row under
  // the cursor is that row (known by its text, and which of the rows with that text it is) or the cursor stops moving
  const nth = (rows, i) => rows.slice(0, i).filter((r) => r.text === rows[i].text).length;
  async function goTo(text, n) {
    if (busy) return;
    busy = true; el.classList.add('busy');
    try {
      let dir = '', first = '';
      for (let step = 0; step < 40; step++) {
        const c = cursorOf(parsed);
        // the cursor is not in the list (it is in the menu's search box): ↓ once takes it there
        if (!c) { if (step || !(await press('down')) || !cursorOf(parsed)) break; continue; }
        if (c.row.text === text && nth(c.block.rows, c.index) === n) break;
        const at = c.block.rows.findIndex((r, i) => r.text === text && nth(c.block.rows, i) === n);
        if (at >= 0) dir = at > c.index ? 'down' : 'up';
        if (!dir) break;
        if (!first) first = dir; else if (dir !== first) break;        // (gone past it: a row the cursor does not stop on)
        const was = c.row.text + '|' + c.index;
        if (!(await press(dir))) break;
        const c2 = cursorOf(parsed);
        if (!c2 || c2.row.text + '|' + c2.index === was) break;        // (a heading, or the end of the list)
      }
    } finally { busy = false; el.classList.remove('busy'); }
  }

  // ---- the card ----
  const keyBtn = (k, label, cls = 'btn') => h('button', { class: cls, type: 'button', disabled: !k.key, title: k.key ? '' : '这个组合键没法从这里发', text: label,
    onclick: () => send(k.key) });
  function hintEl(x) {
    if (x.type) return null;
    if (x.words) return h('span', { class: 'tword', text: x.label });      // (a key the card cannot press: said as the menu says it)
    const cls = (k) => 'btn' + (k.key === 'enter' ? ' go' : k.key === 'esc' ? ' no' : '');
    if (x.keys.length === 1) return keyBtn(x.keys[0], `${x.keys[0].cap} ${x.label}`, cls(x.keys[0]));
    return h('span', { class: 'tgrp' }, ...x.keys.map((k) => keyBtn(k, k.cap, cls(k))), h('span', { text: x.label }));
  }
  function rowEl(r, rows, i) {
    if (r.more) return h('div', { class: 'trow mo' + (r.gap ? ' gap' : ''), text: r.label });
    const d = h('div', { class: 'trow' + (r.cur ? ' cur' : '') + (r.head ? ' hd' : '') + (r.gap ? ' gap' : ''),
      title: r.head ? '' : r.cur ? '光标在这一行：再点一次 = 回车' : '点一下把终端里的光标移到这一行' },
      h('span', { class: 'tc', text: r.cur ? '❯' : r.scroll || '' }),
      r.num ? h('span', { class: 'tn', text: r.num + '.' }) : null,
      r.glyph ? h('span', { class: 'tg', dataset: { g: r.glyph }, text: r.glyph }) : null,
      h('span', { class: 'tl' }, r.label, r.detail ? h('span', { class: 'td', text: r.detail }) : null),
      r.current ? h('span', { class: 'tnow', text: '当前' }) : null,
      r.rest ? h('span', { class: 'tr', text: r.rest }) : null);
    if (!r.head) d.addEventListener('click', () => (r.cur ? send('enter') : goTo(r.text, nth(rows, i))));
    return d;
  }
  function blockEl(b) {
    if (b.type === 'list') return h('div', { class: 'tlist' }, ...b.rows.map((r, i) => rowEl(r, b.rows, i)));
    if (b.type === 'kv') return h('div', { class: 'tkv' }, ...b.rows.flatMap(([k, v]) => [h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v })]));
    if (b.type === 'code') return h('pre', { class: 'tcode', text: b.text });
    if (b.type === 'bar') return h('div', { class: 'tprog' }, h('span', { class: 'bar' }, h('i', { style: `width:${Math.max(0, Math.min(100, b.pct))}%` })), h('span', { text: `${b.pct}% ${b.word}`.trim() }));
    if (b.type === 'input') return h('div', { class: 'tin' + (b.empty ? ' empty' : '') }, b.search ? h('span', { class: 'tic', text: '⌕' }) : null, h('span', { text: b.text || ' ' }));
    if (b.type === 'slider') {
      return h('div', { class: 'tslide' },
        b.ends[0] ? h('span', { class: 'te', text: b.ends[0] }) : null,
        h('span', { class: 'segs' }, ...b.labels.map((l, i) => h('button', { class: 'seg' + (i === b.at ? ' on' : ''), type: 'button', text: l,
          onclick: () => { if (i !== b.at) many(i > b.at ? 'right' : 'left', Math.abs(i - b.at)); } }))),
        b.ends[1] ? h('span', { class: 'te', text: b.ends[1] }) : null,
        b.aside ? h('span', { class: 'ta', text: b.aside }) : null);
    }
    // (text laid out in columns -- /help's shortcuts -- keeps its columns)
    return h('div', { class: 'ttext' + (b.lines.some((l) => /\S {3,}\S.* {3,}\S/.test(l)) ? ' cols' : ''), text: b.lines.join('\n') });
  }
  // what is typed here goes into the menu as it is, without Enter (a search box, a path, the letter a menu takes)
  function typeEl(p) {
    const hint = (p.hints.find((x) => x.type) || {}).label;
    const inp = h('input', { class: 'field ttype', placeholder: hint ? `输入文字${hint}（不带回车）` : '往菜单里输入文字（不带回车）', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: draft });
    const go = async () => { const v = inp.value; if (!v) return; draft = ''; inp.value = ''; await send('c:' + v.slice(0, 200)); };
    inp.addEventListener('input', () => { draft = inp.value; });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });   // (not the dashboard's own keys)
    return h('div', { class: 'ttyper' + (p.typing ? ' want' : '') }, inp,
      h('button', { class: 'btn', type: 'button', text: '输入', onclick: go }),
      h('button', { class: 'btn', type: 'button', text: '⌫', title: '退格：删掉菜单输入框里的一个字', onclick: () => send('bksp') }));
  }
  // a menu's tabs: the one it is on marked (the terminal highlights it); a click on another walks there with ← / →,
  // when the menu says those switch tabs (in /config the list has the keys first: ↑ goes up to the tabs)
  function tabEl(p, t, i) {
    const arrows = p.tab >= 0 && p.hints.some((x) => x.keys.some((k) => k.key === 'left') && x.keys.some((k) => k.key === 'right'));
    const el = h('span', { class: 'ttab' + (i === p.tab ? ' on' : '') + (arrows && i !== p.tab ? ' go' : ''), text: t,
      title: i === p.tab ? '现在在这一页' : arrows ? '点一下切到这一页' : '' });
    if (arrows && i !== p.tab) el.addEventListener('click', () => many(i > p.tab ? 'right' : 'left', Math.abs(i - p.tab)));
    return el;
  }
  function draw() {
    rawBtn.classList.toggle('on', raw);
    pre.hidden = !raw; card.hidden = raw;
    if (raw) return;
    const p = parsed;
    const put = (...kids) => card.replaceChildren(...kids.filter(Boolean));       // (the parts a menu does not have are left out)
    if (p.kind === 'dialog') {
      put(
        p.title || p.tabs ? h('div', { class: 'thead' }, p.title ? h('b', { text: p.title }) : null, ...(p.tabs || []).map((t, i) => tabEl(p, t, i))) : null,
        p.sub ? h('div', { class: 'tsub', text: p.sub }) : null,
        ...p.blocks.map(blockEl),
        p.loading ? h('div', { class: 'tsub', text: '菜单还在加载，稍等会自动再读一次…' }) : null,
        p.hints.some((x) => !x.type) ? h('div', { class: 'tact' }, ...p.hints.map(hintEl)) : null,
        typeEl(p));
    } else if (p.kind === 'idle') {
      put(h('div', { class: 'tsub', text: '终端里现在没有打开菜单。下面是输入框上方最后的内容：' }),
        p.tail ? h('pre', { class: 'tcode', text: p.tail }) : null,
        p.input ? h('div', { class: 'tin', title: '终端输入框里的内容' }, h('span', { class: 'tic', text: '❯' }), h('span', { text: p.input })) : null,
        p.status.length ? h('div', { class: 'tstat', text: p.status.join('\n') }) : null);
    } else put(p.kind === 'raw' ? h('pre', { class: 'tcode', text: p.text }) : h('div', { class: 'tsub', text: '（画面是空的）' }));
  }

  // the screen as just read (also the one that came back with a key press)
  function set(text) {
    seq++;                                            // (a slower read still under way is out of date)
    pre.textContent = plainScreen(text) || '（画面是空的）';
    parsed = parseScreen(text);
    const keepFocus = document.activeElement && document.activeElement.classList.contains('ttype') && card.contains(document.activeElement);
    draw();
    if (keepFocus) { const i = card.querySelector('.ttype'); if (i) i.focus(); }
    body.scrollTop = raw || parsed.kind === 'idle' ? body.scrollHeight : 0;   // (raw: the input box and the menus are at the bottom)
    const d = new Date();
    st.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} 读的`;
    // a menu that was still loading its content: looked at again a moment later
    if (parsed.kind === 'dialog' && parsed.loading && reloads < RELOADS) { reloads++; load(1200, true); } else if (!(parsed.kind === 'dialog' && parsed.loading)) reloads = 0;
  }
  // wait: let the terminal draw first (a command just sent)
  async function load(wait = 0, again = false) {
    const key = cur; if (!key || !open) return;
    if (!again) reloads = 0;
    const n = ++seq;
    st.textContent = '读取中…';
    if (wait) await sleep(wait);
    if (n !== seq) return;
    const r = await read();
    if (n !== seq || key !== cur || !open) return;
    if (r && r.ok) set(r.screen); else st.textContent = (r && r.msg) || '读不到画面';
  }
  function show(on) {
    if (on === open) return;
    open = !!on && !!cur; el.hidden = !open;
    onToggle(open);
    if (open) { pre.textContent = ''; parsed = { kind: 'empty' }; card.replaceChildren(); load(); }
  }
  // key: the session shown ("machine|id"), null when it has no terminal to read: the panel closes
  function target(key) {
    if (key === cur) return;
    cur = key; seq++; draft = '';
    if (!key) { open = false; el.hidden = true; onToggle(false); } else if (open) { pre.textContent = ''; parsed = { kind: 'empty' }; card.replaceChildren(); load(); }
  }
  return { el, show, set, load, target, get open() { return open; } };
}
