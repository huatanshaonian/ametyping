// The terminal's screen read as what it is (dash-term.js draws the result as a card): Claude Code's own menus --
// /model, /config, /mcp, /resume, a prompt -- are only ever drawn on the screen, as plain text; here that text is
// taken apart again into a title, tabs, a list with its cursor, a slider, name/value lines, an input box and the keys
// the menu says it takes. Nothing here knows a particular command: only the shapes Claude Code draws with. What is not
// recognised stays text, and a screen that is no menu at all comes back as 'idle' (the input box) or 'raw'.
//   parseScreen(text) -> { kind: 'empty' }
//                      | { kind: 'raw', text }
//                      | { kind: 'idle', input, status: [..], tail }         the input box; tail: the lines above it
//                      | { kind: 'dialog', title, tabs: [..] | null, sub, blocks: [..], hints: [..], typing, loading }
//   blocks: { type: 'text', lines } | { type: 'list', rows } | { type: 'kv', rows: [[name, value]] }
//         | { type: 'input', text, search, empty } | { type: 'code', text } | { type: 'bar', pct, word }
//         | { type: 'slider', labels, at, ends, aside }
//   a list row: { cur, head, more, scroll, num, glyph, label, rest, current, gap, text, detail }   (text: the row as
//         drawn, without the cursor -- what a row is known by from one reading of the screen to the next; detail: a
//         second line that belongs to it)
//   tab: which of the tabs the menu is on (-1: the screen was read without its highlights)
//   hints: { keys: [{ cap, key }], label }   key: what goes to the terminal (null: cannot be sent from here);
//         a hint whose key is typing itself ("Type to search") has keys [] and type: true; a part of the key line
//         that names no key known here has keys [] and words: true
// No imports: the tests load this file as it is.

// a full-width line; a renamed session's name sits in it ("──── my-session ──")
const RULE = /^─{12,}(\s\S.{0,80}\s─+)?$/;
const GLYPHS = '✔✘⚠✓✗○●◯☐☑☒◉';
const GLYPH = new RegExp('^([' + GLYPHS + '])\\s+');
const MORE = /^[↓↑…]\s*\+?\d*\s*(more|models?)\b/;
const KEYTOK = /^(Enter|Esc|Tab|tab|Space|Type|[Cc]trl\+[A-Za-z]|Shift\+Tab|[↑↓←→]|[A-Za-z0-9\/])$/;
// what the terminal's highlight is carried in (app/screen-text.js): U+E000 ... U+E001 around what is drawn on another
// background -- the tab a menu is on
const MARKS = /[\uE000\uE001]/g;
export const plainScreen = (text) => String(text || '').replace(MARKS, '');
const ARROWS = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };
// what the menus call their keys' effects, said the way the rest of the dashboard talks (anything else stays as it is)
const SAY = { preview: '预览', rename: '改名', 'only show current repo': '只看当前仓库', cancel: '取消', confirm: '确认', select: '选择', close: '关闭', back: '返回', 'go back': '返回', continue: '继续', navigate: '移动',
  adjust: '调整', switch: '切换', toggle: '切换', view: '查看', search: '搜索', add: '添加', complete: '补全', clear: '清除', change: '修改',
  filter: '筛选', return: '返回', tabs: '到标签页', favorite: '收藏', 'set as default': '设为默认', 'use this session only': '只用于本会话',
  'for this session only': '只用于本会话', 'show all projects': '显示所有项目', 'only show current branch': '只看当前分支', day: '按天', week: '按周' };

function keyOf(tok) {
  if (tok === 'Enter') return { cap: '回车', key: 'enter' };
  if (tok === 'Esc') return { cap: 'Esc', key: 'esc' };
  if (/^tab$/i.test(tok)) return { cap: 'Tab', key: 'tab' };
  if (tok === 'Shift+Tab') return { cap: '⇧Tab', key: 'btab' };
  if (tok === 'Space') return { cap: '空格', key: 'c: ' };
  if (ARROWS[tok]) return { cap: tok, key: ARROWS[tok] };
  const c = /^[Cc]trl\+([A-Za-z])$/.exec(tok);
  // (Ctrl+C / D / Z would interrupt or end the session: never sent from a card)
  if (c) { const l = c[1].toLowerCase(); return { cap: 'Ctrl+' + l.toUpperCase(), key: 'cdz'.includes(l) ? null : 'ctrl' + l }; }
  return { cap: tok, key: 'c:' + tok };
}

// "Enter to confirm · s for this session only · Esc to cancel" -> hints; null when the line is not such a line
export function hintLine(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const out = [], segs = s.split(/\s+·\s+/);
  let known = 0;
  for (const seg of segs) {
    if (/\s{2,}/.test(seg)) return null;                              // (columns: a table of shortcuts, not a key line)
    const m = /^(\S+) (to|for) (.+)$/.exec(seg);
    const toks = m ? (m[1] === '/' ? ['/'] : m[1].split('/')) : [];
    // a part that names no key known here ("Tab/Arrow keys to navigate"): kept as the words it is
    if (!m || !toks.every((t) => KEYTOK.test(t))) { out.push({ keys: [], words: true, label: seg }); continue; }
    known++;
    const label = m[2] === 'for' ? 'for ' + m[3] : m[3], say = SAY[label.toLowerCase()] || label;
    if (toks[0] === 'Type') out.push({ keys: [], type: true, label: say });
    else out.push({ keys: toks.map(keyOf), label: say });
  }
  // every part a key, or at least two of them among other words
  return known === segs.length || known >= 2 ? out : null;
}

export function parseScreen(text) {
  // what is highlighted in a line, by the line's own text (the lines are moved about below; a tab line is found again)
  const marked = String(text || '').replace(/\r/g, '').split('\n'), hot = new Map();
  for (const l of marked) {
    if (!l.includes('\uE000')) continue;
    const on = [...l.matchAll(/\uE000([^\uE001]*)/g)].map((m) => m[1].trim()).filter(Boolean);
    if (on.length) hot.set(l.replace(MARKS, '').trim(), on);
  }
  const lines = marked.map((l) => l.replace(MARKS, '').replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return { kind: 'empty' };
  const rules = [];
  lines.forEach((l, i) => { if (RULE.test(l.trim())) rules.push(i); });
  // the input box: a rule, "❯ what is typed", a rule, and the status lines under it
  if (rules.length >= 2) {
    const r2 = rules[rules.length - 1], r1 = rules[rules.length - 2];
    if (r1 + 1 < r2 && lines[r1 + 1].startsWith('❯') && r2 - r1 <= 14 && lines.length - r2 <= 8) return idle(lines, r1, r2);
  }
  // a menu: under the last rule (some close with a rule of their own); on a screen too short for it the rule above
  // has scrolled away -- then all of the screen is the menu, if it ends the way menus do
  let end = lines.length;
  while (end > 0 && (!lines[end - 1] || RULE.test(lines[end - 1].trim()))) end--;
  const above = rules.filter((r) => r < end);
  const start = above.length ? above[above.length - 1] + 1 : 0;
  let body = lines.slice(start, end);
  // a rule inside a menu (Claude's questions: the options, a rule, then "5. Chat about this"): the numbered rows go on
  // across it, so the menu starts at the rule before
  if (above.length >= 2) {
    const r0 = above[above.length - 2], r1 = above[above.length - 1];
    const before = lines.slice(r0 + 1, r1).filter(Boolean).pop() || '', after = body.find(Boolean) || '';
    if (/^\s*(❯ )?\d+\.\s/.test(after) && /^\s*(❯ )?\d+\.\s|^\s{4,}\S/.test(before)) body = lines.slice(r0 + 1, r1).concat(body);
  }
  if (!body.some(Boolean)) return { kind: 'raw', text: lines.join('\n') };
  if (!rules.length && !body.some((l) => hintLine(l))) return { kind: 'raw', text: lines.join('\n') };
  return dialog(body, hot);
}

function idle(lines, r1, r2) {
  const input = lines.slice(r1 + 1, r2).map((l, i) => (i ? l.replace(/^ {2}/, '') : l.replace(/^❯ ?/, ''))).join('\n').trim();
  const status = lines.slice(r2 + 1).map((l) => l.trim()).filter(Boolean);
  let top = r1;
  while (top > 0 && !lines[top - 1]) top--;
  const tail = lines.slice(Math.max(0, top - 16), top);
  while (tail.length && !tail[0]) tail.shift();
  return { kind: 'idle', input, status, tail: tail.join('\n') };
}

const indentOf = (l) => l.search(/\S/);

function row(l, mc) {
  const r = { type: 'row', cur: false, head: false, more: false, scroll: '', num: '', glyph: '', label: '', rest: '', current: false, gap: false, col: 0, text: '' };
  let rest = l;
  if (mc >= 0 && indentOf(l) === mc && '❯↓↑'.includes(l[mc]) && (l[mc + 1] === ' ' || l[mc + 1] === undefined)) {
    if (l[mc] === '❯') r.cur = true;
    else if (MORE.test(l.slice(mc))) { r.more = true; r.label = r.text = l.trim(); return r; }
    else r.scroll = l[mc];
    rest = ' '.repeat(mc + 2) + l.slice(mc + 2);
  }
  let t = rest.trim();
  r.col = Math.max(0, indentOf(rest) - (mc >= 0 ? mc + 2 : 0));
  r.text = t;
  if (MORE.test(t) || /^more (below|above)/.test(t)) { r.more = true; r.label = t; return r; }
  let m = /^(\d+)\.\s+/.exec(t);
  if (m) { r.num = m[1]; t = t.slice(m[0].length); }
  m = GLYPH.exec(t);
  if (m) { r.glyph = m[1]; t = t.slice(m[0].length); }
  m = /^\[([ xX✔✓])\]\s+/.exec(t);                                // a box to tick (a question with several answers)
  if (m) { r.glyph = m[1] === ' ' ? '☐' : '☑'; t = t.slice(m[0].length); }
  const cells = t.split(/\s{2,}/);
  if (/\s✔$/.test(cells[0])) { r.current = true; cells[0] = cells[0].replace(/\s*✔$/, ''); }
  r.label = cells[0];
  r.rest = cells.slice(1).join('  ');
  return r;
}

// A list drawn as pairs with a blank line between them (/resume: a conversation and "4 minutes ago · main · 3MB";
// /rewind: a point and what it would undo): the second line of each pair says more about the first -- it becomes that
// row's detail, not a row of its own. Told by the shape alone: every group one or two lines, a marked row (the cursor,
// ↑ ↓) always the first of its group, at least one pair.
function withDetails(rows) {
  // (numbered options, each with a line under it saying more: "1. 面条" / "   快")
  if (rows.some((r) => r.num)) {
    const out = [];
    for (const r of rows) {
      const prev = out[out.length - 1];
      if (prev && prev.num && !r.num && !r.cur && !r.scroll && !r.more && !r.gap && r.col > prev.col) prev.detail = prev.detail ? prev.detail + ' ' + r.text : r.text;
      else out.push(r);
    }
    rows = out;
  }
  const groups = [];
  for (const r of rows) { const g = groups[groups.length - 1]; if (r.gap || !g || r.more || g[0].more) groups.push([r]); else g.push(r); }   // ("↑ 1 more" stands alone)
  const body = groups.filter((g) => !g[0].more);
  // (/help's commands: "/name" and what it does, line after line with no blank between -- told by the slashes)
  if (body.length === 1 && body[0].length >= 4 && body[0].every((r, i) => (i % 2 === 0) === r.label.startsWith('/')) && !body[0].some((r, i) => i % 2 && (r.cur || r.scroll))) {
    const out = [];
    for (const r of rows) { if (r.more || r.label.startsWith('/')) out.push(r); else out[out.length - 1].detail = r.text; }
    return out;
  }
  if (body.length < 2 || !body.some((g) => g.length === 2) || !body.some((g) => g[0].cur || g[0].scroll)) return rows;
  if (!body.every((g) => g.length <= 2 && !(g[1] && (g[1].cur || g[1].scroll || g[1].num || g[1].glyph)))) return rows;
  return groups.map((g) => { if (g[1] && !g[0].more) { g[0].detail = g[1].text; return g[0]; } return g; }).flat();
}

// which rows of a list are only headings: told by what the row under the cursor looks like (numbered, with a mark
// in front, in brackets) -- a row of another make at the same depth is a heading
function markHeads(rows) {
  const c = rows.find((r) => r.cur);
  if (!c) return;
  const sig = c.num ? 'n' : c.glyph ? 'g' : c.label.startsWith('[') ? 'b' : '';
  for (const r of rows) {
    if (r.cur || r.more) continue;
    if (sig === 'n') r.head = !r.num;
    else if (sig === 'g') r.head = !(r.glyph || r.col >= c.col + 2);
    else if (sig === 'b') r.head = !r.label.startsWith('[');
    else r.head = r.col < c.col && !r.glyph;
  }
}

function dialog(src, hot = new Map()) {
  const hints = [];
  const addHints = (hs, note) => { for (const x of hs) { const label = note ? `${x.label}（${note}）` : x.label; const sig = (h) => h.keys.map((k) => k.cap).join('/') + '|' + h.label; const y = { ...x, label }; if (!hints.some((h) => sig(h) === sig(y))) hints.push(y); } };
  // (the key lines first: some are drawn a column off the rest, which would hide where the menu's own margin is;
  // a long one runs on into the next line, breaking anywhere: "... · Type" / "to search · Esc to cancel")
  const kept = [];
  for (let n = 0; n < src.length; n++) {
    let h = hintLine(src[n]);
    const both = src[n] && src[n + 1] && / · /.test(src[n]) ? hintLine(src[n].trim() + ' ' + src[n + 1].trim()) : null;
    const words = (x) => x.filter((y) => y.words).length;
    if (both && (!h || (h[h.length - 1].words && words(both) < words(h)))) { h = both; n++; }
    if (h) addHints(h); else kept.push(src[n]);
  }
  if (!kept.some(Boolean)) return { kind: 'dialog', title: '', tabs: null, tab: -1, sub: '', blocks: [], hints, typing: hints.some((h) => h.type), loading: false };
  const ind = Math.min(...kept.filter(Boolean).map(indentOf));
  const ls = kept.map((l) => l.slice(ind));
  const width = Math.max(...ls.map((l) => l.length));

  let i = 0;
  while (i < ls.length && !ls[i]) i++;
  let title = '', tabs = null, tab = -1;
  const special = (l) => /^\s*([╭│╰❯]|╌{8,})/.test(l) || /[─▲]{8,}/.test(l) || /^\s*\d+\.\s/.test(l) || KV.test(l) || BAR.test(l);
  if (i < ls.length && indentOf(ls[i]) === 0 && !special(ls[i])) {
    let parts = ls[i].trim().split(/\s{2,}/);
    const on = hot.get(ls[i].trim()) || [];
    // (Claude's questions: "←  ☐ one  ☐ two  ✔ Submit  →" -- all of them tabs, no title)
    const arrows = parts[0] === '←' || parts[parts.length - 1] === '→';
    if (arrows) parts = parts.filter((x) => x !== '←' && x !== '→');
    if ((arrows && parts.length >= 2) || (parts.length >= 3 && parts.every((x) => x.length <= 24))) {
      if (arrows) tabs = parts; else { title = parts[0]; tabs = parts.slice(1); }
      tab = tabs.findIndex((t) => on.some((o) => o === t || o.includes(t) || t.includes(o)));
    } else title = ls[i].trim();
    i++;
  }
  const subs = [];
  while (i < ls.length && ls[i] && indentOf(ls[i]) === 0 && !special(ls[i])) subs.push(ls[i++].trim());

  const rest = ls.slice(i);
  // the column the cursor is drawn in; a list the cursor is not in (it is in the search box) still shows there what
  // lies above and below its window (↑ ↓)
  let curs = rest.map((l) => /^(\s*)❯(\s|$)/.exec(l)).filter(Boolean).map((m) => m[1].length);
  if (!curs.length) curs = rest.filter((l) => !MORE.test(l.trim())).map((l) => /^(\s*)[↑↓] \S/.exec(l)).filter(Boolean).map((m) => m[1].length);
  const mc = curs.length ? Math.min(...curs) : -1;
  const isRow = (l) => {
    const n = indentOf(l);
    if (mc < 0) return /^\s*\d+\.\s+\S/.test(l);
    return (n === mc && '❯↓↑'.includes(l[mc]) && (l[mc + 1] === ' ' || l[mc + 1] === undefined)) || n >= mc + 2;
  };
  const blocks = [];
  let gap = false;
  const last = () => blocks[blocks.length - 1];
  for (let j = 0; j < rest.length; j++) {
    const l = rest[j];
    if (!l) { gap = true; continue; }
    const wasGap = gap; gap = false;
    // an input box: ╭──╮ / │ what is typed │ / ╰──╯
    if (/^\s*╭─/.test(l)) {
      const inner = [];
      while (j + 1 < rest.length && /^\s*│/.test(rest[j + 1])) inner.push(rest[++j].replace(/^\s*│\s?/, '').replace(/\s*│?$/, ''));
      if (j + 1 < rest.length && /^\s*╰─/.test(rest[j + 1])) j++;
      let t = inner.join('\n').trim();
      const search = t.startsWith('⌕');
      if (search) t = t.replace(/^⌕\s*/, '');
      blocks.push({ type: 'input', text: t, search, empty: /…$/.test(t) });
      continue;
    }
    // a preview between two dashed lines (a diff, a command)
    if (/^\s*╌{8,}/.test(l)) {
      const code = [];
      while (j + 1 < rest.length && !/^\s*╌{8,}/.test(rest[j + 1])) code.push(rest[++j]);
      if (j + 1 < rest.length) j++;
      const n = Math.min(...code.filter(Boolean).map(indentOf));
      blocks.push({ type: 'code', text: code.map((x) => x.slice(Number.isFinite(n) ? n : 0)).join('\n') });
      continue;
    }
    // a slider: ────▲──── over its labels
    const tr = /[─▲]{8,}/.exec(l);
    if (tr && tr[0].includes('▲')) {
      const s = tr.index, e = s + tr[0].length, at = l.indexOf('▲');
      const lab = rest[j + 1] || '', labels = [], re = /\S+/g;
      let k;
      while ((k = re.exec(lab.slice(0, e + 2)))) if (k.index >= s - 2) labels.push({ text: k[0], mid: k.index + k[0].length / 2 });
      if (labels.length >= 2) {
        let cur = 0;
        labels.forEach((x, n) => { if (Math.abs(x.mid - at) < Math.abs(labels[cur].mid - at)) cur = n; });
        // the two ends' names on the line above, anything to the right of the track (another setting and its key)
        let ends = [];
        const b = last();
        if (b && b.type === 'text' && !wasGap && indentOf(rest[j - 1] || '') >= s - 2) ends = b.lines.pop().trim().split(/\s{2,}/);
        if (b && b.type === 'text' && !b.lines.length) blocks.pop();
        const a1 = l.slice(e).trim().replace(/\s{2,}/g, ' '), a2 = lab.slice(e + 2).trim();
        const ah = hintLine(a2);
        if (ah) addHints(ah, a1.replace(/\s+\S+$/, ''));
        blocks.push({ type: 'slider', labels: labels.map((x) => x.text), at: cur, ends, aside: [a1, ah ? '' : a2].filter(Boolean).join(' · ') });
        j++;
        continue;
      }
    }
    // a usage bar: ███████▌      31% used
    const bar = BAR.exec(l);
    if (bar) { blocks.push({ type: 'bar', pct: +bar[1], word: bar[2] || '' }); continue; }
    if (isRow(l)) {
      const r = row(l, mc);
      const b = last();
      if (b && b.type === 'list') { r.gap = wasGap; b.rows.push(r); } else blocks.push({ type: 'list', rows: [r] });
      continue;
    }
    // "Name:   value" (a value too long for the line goes on under itself)
    const kv = KV.exec(l);
    if (kv) {
      let v = kv[2];
      const at = l.indexOf(kv[2], kv[1].length + 1);
      let prev = l;
      while (j + 1 < rest.length && rest[j + 1] && indentOf(rest[j + 1]) >= at && !KV.test(rest[j + 1])) { v += (prev.length >= width - 1 ? '' : ' ') + rest[j + 1].trim(); prev = rest[++j]; }
      const b = last();
      if (b && b.type === 'kv' && !wasGap) b.rows.push([kv[1].trim(), v]); else blocks.push({ type: 'kv', rows: [[kv[1].trim(), v]] });
      continue;
    }
    // (lines laid out in columns -- /help's shortcuts -- are a block of their own: they are shown with their columns)
    const b = last(), cols = (x) => /\S {3,}\S/.test(x) || /^ {12,}\S/.test(x);
    if (b && b.type === 'text' && !wasGap && cols(b.lines[b.lines.length - 1]) === cols(l)) b.lines.push(l); else blocks.push({ type: 'text', lines: [l] });
  }
  for (const b of blocks) {
    if (b.type === 'list') { b.rows = withDetails(b.rows); markHeads(b.rows); }
    if (b.type === 'text') {
      // (a sentence the terminal broke at its right edge is one line again)
      const out = [];
      let was = 0;                                     // how long the line before was on the screen
      for (const x of b.lines) { if (out.length && was >= width - 14 && !/\S {3,}\S/.test(x)) out[out.length - 1] += ' ' + x.trim(); else out.push(x); was = x.length; }
      const n = Math.min(...out.map(indentOf));
      b.lines = out.map((x) => x.slice(n));
    }
  }
  const all = src.join('\n');
  return { kind: 'dialog', title, tabs, tab, sub: subs.join(' '), blocks, hints,
    typing: blocks.some((b) => b.type === 'input') || hints.some((h) => h.type),
    loading: /Loading|Refreshing…/.test(all) };
}
const BAR = /^\s*[█▉▊▋▌▍▎▏░▒▓]+\s+(\d+)%\s*(\w*)/;
const KV = /^\s*(\S[^:]{0,28}):\s{2,}(\S.*)$/;

// the row under the cursor (the first, when a menu shows two), and where a row known by its text is now
export function cursorOf(p) {
  if (!p || p.kind !== 'dialog') return null;
  for (const b of p.blocks) if (b.type === 'list') { const n = b.rows.findIndex((r) => r.cur); if (n >= 0) return { block: b, index: n, row: b.rows[n] }; }
  return null;
}
