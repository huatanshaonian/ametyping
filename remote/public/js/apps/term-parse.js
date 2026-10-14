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
//         | { type: 'input', text, search, empty } | { type: 'code', text, art } | { type: 'bar', pct, word }
//           (art: a picture drawn with blocks -- /mobile's QR code -- to be shown with its lines touching)
//         | { type: 'slider', labels, at, ends, aside }
//         | { type: 'link', url }                      an address, whole: one the screen broke over several lines
//           (/login's sign-in link) is put together again exactly, character for character
//   an input block may be a question to type an answer to ("Paste code here if prompted >"): then it has label and
//   ask: true, and the dialog says ask: true -- what is typed goes in followed by Enter; typed: how many characters
//   the terminal shows as typed already when it hides what they are ("*****…": at least that many)
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
const KEYTOK = /^([Ee]nter|[Ee]sc|Tab|tab|[Ss]pace|Type|[Cc]trl\+[A-Za-z]|Shift\+Tab|[↑↓←→]|[A-Za-z0-9\/])$/;
// what the terminal's highlight is carried in (app/screen-text.js): U+E000 ... U+E001 around what is drawn on another
// background -- the tab a menu is on
const MARKS = /[\uE000\uE001]/g;
export const plainScreen = (text) => String(text || '').replace(MARKS, '');
const ARROWS = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };
// what the menus call their keys' effects, said the way the rest of the dashboard talks (anything else stays as it is)
const SAY = { preview: '预览', rename: '改名', 'only show current repo': '只看当前仓库', cancel: '取消', confirm: '确认', select: '选择', close: '关闭', back: '返回', 'go back': '返回', continue: '继续', navigate: '移动',
  adjust: '调整', retry: '重试', submit: '提交', cycle: '切换', sort: '排序', disable: '关闭', enable: '开启', save: '保存', edit: '编辑', delete: '删除', remove: '移除', open: '打开', copy: '复制', expand: '展开', switch: '切换', toggle: '切换', view: '查看', search: '搜索', add: '添加', complete: '补全', clear: '清除', change: '修改',
  filter: '筛选', return: '返回', tabs: '到标签页', favorite: '收藏', 'set as default': '设为默认', 'use this session only': '只用于本会话',
  'for this session only': '只用于本会话', 'show all projects': '显示所有项目', 'only show current branch': '只看当前分支', day: '按天', week: '按周' };

function keyOf(tok) {
  if (/^enter$/i.test(tok)) return { cap: '回车', key: 'enter' };
  if (/^esc$/i.test(tok)) return { cap: 'Esc', key: 'esc' };
  if (/^tab$/i.test(tok)) return { cap: 'Tab', key: 'tab' };
  if (tok === 'Shift+Tab') return { cap: '⇧Tab', key: 'btab' };
  if (/^space$/i.test(tok)) return { cap: '空格', key: 'c: ' };
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
  // (some put their keys after a comma: "13 skills · enter/space to cycle, / to search, t to sort, Esc to close")
  const out = [], segs = s.split(/\s+·\s+|,\s+(?=\S+ (?:to|for) )/);
  let known = 0;
  for (const seg of segs) {
    if (/\s{2,}/.test(seg)) return null;                              // (columns: a table of shortcuts, not a key line)
    // ("Press Enter to continue…": the same thing said in a sentence)
    const m = /^(\S+) (to|for) (.+)$/.exec(seg.replace(/^Press (?=\S+ to )/, '').replace(/[.…]+$/, ''));
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
  const framed = unframe(lines);
  if (framed) return dialog(framed, hot);
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
  return dialog(body, hot, Math.max(...lines.map((l) => l.length)));
}

// A menu drawn inside a box of its own (/permissions: "Delete allowed tool?", the built-in rules of auto mode): the
// box's bottom edge ends the screen, but for the key line under it; its top edge may have scrolled away. Not a box to
// type into: that is one line, or a few with neither a blank line nor a cursor among them. -> the lines inside the box
// with the key lines after them, or null
function unframe(lines) {
  let e = lines.length - 1;
  const tail = [];
  while (e >= 0 && (!lines[e].trim() || hintLine(lines[e]))) tail.unshift(lines[e--]);
  const bottom = e >= 0 ? /^(\s*)╰─{38,}╯$/.exec(lines[e]) : null;
  if (!bottom) return null;
  const col = bottom[1].length, side = (l) => l[col] === '│' && /│$/.test(l);
  let k = e - 1;
  while (k >= 0 && side(lines[k])) k--;
  if (k >= 0 && !new RegExp('^\\s{' + col + '}╭─+╮$').test(lines[k])) return null;
  const inner = lines.slice(k + 1, e).map((l) => l.slice(col + 1, -1).replace(/^ /, '').replace(/\s+$/, ''));
  if (inner.length < 3 || !inner.some((l) => !l || /^\s*❯ /.test(l))) return null;
  return inner.concat(tail);
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
  // (how long the line is on the screen and where it starts: whether a line under it goes on with it -- withDetails)
  Object.defineProperties(r, { w: { value: l.length }, ind: { value: indentOf(l) } });
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
  t = t.replace(/^-\s{2,}/, '');                                    // (/permissions' workspace: "-  the folder it began in")
  m = GLYPH.exec(t);
  if (m) { r.glyph = m[1]; t = t.slice(m[0].length); }
  m = /^\[([ xX✔✓])\]\s+/.exec(t);                                // a box to tick (a question with several answers)
  if (m) { r.glyph = m[1] === ' ' ? '☐' : '☑'; t = t.slice(m[0].length); }
  const cells = t.split(/\s{2,}/);
  if (/\s✔$/.test(cells[0])) { r.current = true; cells[0] = cells[0].replace(/\s*✔$/, ''); }
  r.label = cells[0];
  r.rest = cells.slice(1).join('  ');
  // (the column the second cell starts in: a line under the row starting there may be that cell going on)
  if (r.rest) Object.defineProperty(r, 'restAt', { value: l.indexOf(cells[1], l.indexOf(cells[0]) + cells[0].length) });
  return r;
}

// A list drawn as pairs with a blank line between them (/resume: a conversation and "4 minutes ago · main · 3MB";
// /rewind: a point and what it would undo): the second line of each pair says more about the first -- it becomes that
// row's detail, not a row of its own. Told by the shape alone: every group one or two lines, a marked row (the cursor,
// ↑ ↓) always the first of its group, at least one pair.
function withDetails(rows, width = 0) {
  // (numbered options, each with a line under it saying more: "1. 面条" / "   快"; several lines under it are one
  // sentence the terminal broke at its right edge, or lines of their own -- /permissions' "5. Environment" and the
  // first lines of its document, some cut short with "…": where lines are cut, none is broken)
  if (rows.some((r) => r.num)) {
    const out = [], under = new Map();
    for (const r of rows) {
      const prev = out[out.length - 1];
      if (prev && prev.num && !r.num && !r.cur && !r.scroll && !r.more && !r.gap && r.col > prev.col) under.set(prev, (under.get(prev) || []).concat(r));
      else out.push(r);
    }
    for (const [r, ds] of under) {
      const cut = ds.some((d) => /…$/.test(d.text));
      const text = ds.map((d, n) => (n ? (!cut && ds[n - 1].w >= width - 14 ? ' ' : '\n') : '') + d.text).join('');
      // (the row's second cell broken at the right edge goes on in its own column: /export's "Save the conversation to
      // a file in the current" / "directory")
      if (!cut && r.rest && ds[0].ind === r.restAt && r.w >= width - 14) r.rest += ' ' + text.replace(/\n/g, ' ');
      else r.detail = text;
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

// cols0: how wide the screen is (0: not known -- the menu's own width is used)
function dialog(src, hot = new Map(), cols0 = 0) {
  const hints = [];
  const addHints = (hs, note) => { for (const x of hs) { const label = note ? `${x.label}（${note}）` : x.label; const sig = (h) => h.keys.map((k) => k.cap).join('/') + '|' + h.label; const y = { ...x, label }; if (!hints.some((h) => sig(h) === sig(y))) hints.push(y); } };
  // (the key lines first: some are drawn a column off the rest, which would hide where the menu's own margin is;
  // a long one runs on into the next line, breaking anywhere: "... · Type" / "to search · Esc to cancel")
  let kept = [];
  for (let n = 0; n < src.length; n++) {
    let h = hintLine(src[n]);
    const both = src[n] && src[n + 1] && / · /.test(src[n]) ? hintLine(src[n].trim() + ' ' + src[n + 1].trim()) : null;
    const words = (x) => x.filter((y) => y.words).length;
    if (both && (!h || (h[h.length - 1].words && words(both) < words(h)))) { h = both; n++; }
    if (h) addHints(h); else kept.push(src[n]);
  }
  if (!kept.some(Boolean)) return { kind: 'dialog', title: '', tabs: null, tab: -1, sub: '', blocks: [], hints, typing: hints.some((h) => h.type), loading: false, ask: false };
  // (a link's lines start in the first column whatever the menu's margin is: not counted for it)
  kept = joinLinks(kept);
  const isLink = (l) => l.startsWith(LINK);
  const inds = kept.filter((l) => l && !isLink(l)).map(indentOf);
  const ind = inds.length ? Math.min(...inds) : 0;
  const ls = kept.map((l) => (isLink(l) ? l : l.slice(ind)));
  const width = Math.max(0, ...ls.filter((l) => !isLink(l)).map((l) => l.length));

  let i = 0;
  while (i < ls.length && !ls[i]) i++;
  let title = '', tabs = null, tab = -1;
  const special = (l) => isLink(l) || ASK.test(l) || /^\s*([╭│╰❯]|╌{8,})/.test(l) || /[─▲]{8,}/.test(l) || /^\s*\d+\.\s/.test(l) || KV.test(l) || BAR.test(l);
  if (i < ls.length && indentOf(ls[i]) === 0 && !special(ls[i])) {
    let parts = ls[i].trim().split(/\s{2,}/);
    const on = hot.get(ls[i].trim()) || [];
    // (Claude's questions: "←  ☐ one  ☐ two  ✔ Submit  →" -- all of them tabs, no title)
    const arrows = parts[0] === '←' || parts[parts.length - 1] === '→';
    if (arrows) parts = parts.filter((x) => x !== '←' && x !== '→');
    // (a title and one tab: told by the tab being highlighted -- /sandbox "Sandbox  Dependencies")
    const one = parts.length === 2 && on.some((o) => o === parts[1]);
    if ((arrows && parts.length >= 2) || one || (parts.length >= 3 && parts.every((x) => x.length <= 24))) {
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
    return marked(l) || n >= mc + 2;
  };
  const marked = (l) => mc >= 0 && indentOf(l) === mc && '❯↓↑'.includes(l[mc]) && (l[mc + 1] === ' ' || l[mc + 1] === undefined);
  // the list the cursor is in: the rows next to it, blank lines between them allowed. A line indented as deep
  // elsewhere on such a screen says more about what is asked ("Delete allowed tool?" and the rule under it; the folder
  // to be taken off the workspace): text, not a row to choose -- unless it is numbered
  const inList = new Set();
  rest.forEach((l, k0) => {
    if (!marked(l) || inList.has(k0)) return;
    inList.add(k0);
    for (const dir of [-1, 1]) {
      for (let k = k0; ;) {
        let n = k + dir;
        while (rest[n] === '') n += dir;
        if (n < 0 || n >= rest.length || !isRow(rest[n]) || isLink(rest[n])) break;
        for (let x = Math.min(k, n); x <= Math.max(k, n); x++) inList.add(x);
        k = n;
      }
    }
  });
  const choice = (l, j) => isRow(l) && (mc < 0 || inList.has(j) || /^\s*\d+\.\s/.test(l));
  const blocks = [];
  let gap = false;
  const last = () => blocks[blocks.length - 1];
  for (let j = 0; j < rest.length; j++) {
    const l = rest[j];
    if (!l) { gap = true; continue; }
    const wasGap = gap; gap = false;
    if (isLink(l)) { blocks.push({ type: 'link', url: l.slice(LINK.length) }); continue; }
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
    // a question answered by typing, on its own line: "Paste code here if prompted >"
    const ask = mc < 0 && !/^\s*\d+\.\s/.test(l) ? ASK.exec(l) : null;
    if (ask) {
      const t = ask[2] || ask[3] || '', stars = !!ask[2];
      blocks.push({ type: 'input', label: ask[1].trim(), text: stars ? '' : t, typed: stars ? t.replace('…', '').length : 0, more: stars && t.endsWith('…'), search: false, empty: !t, ask: true });
      continue;
    }
    // (with no cursor on the screen, a line deeper than the numbered row just above it is still that row's: its detail)
    const b0 = last(), numbered = b0 && b0.type === 'list' ? b0.rows.filter((r) => r.num).pop() : null;
    const under = mc < 0 && !wasGap && numbered && indentOf(l) > numbered.ind + 2;
    if (choice(l, j) || under) {
      const r = row(l, mc);
      const b = last();
      if (b && b.type === 'list') { r.gap = wasGap; b.rows.push(r); } else blocks.push({ type: 'list', rows: [r] });
      continue;
    }
    // "Name:   value" (a value too long for the line goes on under itself); the longest name of a few leaves one blank
    // before its value, which still starts where the others' do ("Total duration (wall): 10m 23s")
    const kb = last(), kv = KV.exec(l) || (kb && kb.type === 'kv' && !wasGap ? alignedKv(l, kb.at) : null);
    if (kv) {
      let v = kv[2];
      const at = l.indexOf(kv[2], kv[1].length + 1);
      let prev = l;
      // (no blank put back where a line ran to the right edge in the middle of a word -- but after a comma there is one)
      while (j + 1 < rest.length && rest[j + 1] && indentOf(rest[j + 1]) >= at && !KV.test(rest[j + 1])) { v += (prev.length >= width - 1 && !/[,;]$/.test(prev) ? '' : ' ') + rest[j + 1].trim(); prev = rest[++j]; }
      if (kb && kb.type === 'kv' && !wasGap) kb.rows.push([kv[1].trim(), v]);
      else blocks.push(Object.defineProperty({ type: 'kv', rows: [[kv[1].trim(), v]] }, 'at', { value: at, writable: true }));
      continue;
    }
    // a picture drawn with blocks (/mobile's QR code): kept line for line, to be shown as it is drawn
    if (ART.test(l) && ART.test(rest[j + 1] || '') && ART.test(rest[j + 2] || '')) {
      const art = [l];
      while (j + 1 < rest.length && ART.test(rest[j + 1])) art.push(rest[++j]);
      const n = Math.min(...art.map(indentOf));
      blocks.push({ type: 'code', art: true, text: art.map((x) => x.slice(n)).join('\n') });
      continue;
    }
    // a key named at the end of a line of text ("◐ Medium effort (default) ←/→ to adjust", "Syntax theme: Monokai
    // Extended (ctrl+t to disable)"): a key of the menu's, said what it is for
    let t = l;
    const inl = INLINE_KEY.exec(l), ih = inl ? hintLine(inl[2]) : null;
    if (ih && ih.every((x) => !x.words && !x.type)) { addHints(ih, inl[1].trim().replace(/^[◐◑◒◓●○]\s*/, '').replace(/:.*$/, '')); t = inl[1]; }
    // (lines laid out in columns -- /help's shortcuts -- are a block of their own: they are shown with their columns)
    const b = last();
    if (b && b.type === 'text' && !wasGap && cols(b.lines[b.lines.length - 1]) === cols(t)) b.lines.push(t); else blocks.push({ type: 'text', lines: [t] });
  }
  for (const b of blocks) {
    if (b.type === 'list') { b.rows = withDetails(b.rows, width); markHeads(b.rows); }
    if (b.type === 'text') {
      // (a sentence the terminal broke at its right edge is one line again; not one that ends with a colon or is cut
      // short ("…"), and not into a line that starts with a mark of its own: "⚠ This folder adds …")
      // A line is full when it reaches near the right edge of the screen, not of the menu: a menu of a few short lines
      // (/sandbox: "socat: not installed" / "· apt install socat") is no paragraph. Lines in columns are left as they are.
      const out = [], edge = Math.max(width, cols0 - ind - 2);
      let was = 0;                                     // how long the line before was on the screen
      for (const x of b.lines) {
        if (out.length && was >= edge - 14 && !cols(x) && !cols(out[out.length - 1]) && !/[:…]$/.test(out[out.length - 1]) && !GLYPH.test(x.trim())) out[out.length - 1] += ' ' + x.trim();
        else out.push(x);
        was = x.length;
      }
      const n = Math.min(...out.map(indentOf));
      b.lines = out.map((x) => x.slice(n));
    }
  }
  const all = src.join('\n');
  // (a question to type an answer to is ended with Enter, which such a screen does not name among its keys)
  const asks = blocks.some((b) => b.ask);
  if (asks && !hints.some((x) => x.keys.some((k) => k.key === 'enter'))) hints.unshift({ keys: [keyOf('Enter')], label: SAY.confirm });
  return { kind: 'dialog', title, tabs, tab, sub: subs.join(' '), blocks, hints, ask: asks,
    typing: blocks.some((b) => b.type === 'input') || hints.some((h) => h.type),
    loading: /Loading|Refreshing…/.test(all) };
}
const BAR = /^\s*[█▉▊▋▌▍▎▏░▒▓]+\s+(\d+)%\s*(\w*)/;
// a line that is an address and nothing else; one line of a menu standing for a whole link (dialog)
const URL_LINE = /^\s*(https?:\/\/\S+)$/;
const LINK = '\uE002';
// "Paste code here if prompted >" and what has been typed after it
// (a code is shown as stars, right against the ">": "prompted >*********…")
// Told from a sentence with a ">" in it by what follows: nothing, the stars, or one unbroken word typed so far.
const ASK = /^\s*([^>\s]+ [^>]*[^>\s]) >(?:(\*+…?)| (\S+))?$/;

// An address longer than the screen is wide is drawn broken at the right edge, from the first column, with nothing to
// say the lines belong together: read as text it came out with spaces (or line breaks) in it, and a sign-in link
// copied that way is not the link. Its lines are one address again here: a line that is only an address and reaches
// the right edge goes on in the lines under it, as long as each is unbroken text from the first column and the one
// before it was full.
function joinLinks(ls) {
  const full = Math.max(0, ...ls.map((l) => l.length)), out = [];
  for (let n = 0; n < ls.length; n++) {
    const m = URL_LINE.exec(ls[n]);
    if (!m) { out.push(ls[n]); continue; }
    let url = m[1];
    while (ls[n].length >= full && ls[n + 1] && /^\S+$/.test(ls[n + 1])) url += ls[++n];
    out.push(LINK + url);
  }
  return out;
}
const KV = /^\s*(\S[^:]{0,28}):\s{2,}(\S.*)$/;
// "Name: value" with one blank only, its value where the block's values start ("at": the column, kept on the block)
function alignedKv(l, at) {
  const m = /^\s*(\S[^:]{0,28}): (\S.*)$/.exec(l);
  return m && l.length - m[2].length === at ? m : null;
}
// lines laid out in columns (/help's shortcuts)
const cols = (x) => /\S {3,}\S/.test(x) || /^ {12,}\S/.test(x);
// a line of a picture drawn with blocks
const ART = /^\s*[█▀▄▌▐▖▗▘▝▚▞]+(?: +[█▀▄▌▐▖▗▘▝▚▞]+)*\s*$/;
// a key at the end of a line of text, bare or in brackets; only keys that are not also words (an arrow, Ctrl+x, Tab,
// Space, Enter, Esc): "go to sleep" is no key
const INLINE_KEY = /^(\s*.*?\S)\s+\(?((?:[←→↑↓](?:\/[←→↑↓])?|[Cc]trl\+[A-Za-z]|Tab|Space|Enter|Esc) (?:to|for) [^()·]+?)\)?$/;

// the row under the cursor (the first, when a menu shows two), and where a row known by its text is now
export function cursorOf(p) {
  if (!p || p.kind !== 'dialog') return null;
  for (const b of p.blocks) if (b.type === 'list') { const n = b.rows.findIndex((r) => r.cur); if (n >= 0) return { block: b, index: n, row: b.rows[n] }; }
  return null;
}
