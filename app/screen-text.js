// The terminal's visible text as the dashboard shows it (终端画面: Claude Code's own menus -- /model, /resume,
// /config, a prompt -- are drawn on the screen and never reach the transcript): the lines without their trailing
// blanks, empty lines at both ends dropped, the last 60 lines at most.
// Asked for with its highlights, the text carries what is drawn on another background (the tab a menu is on) between
// U+E000 and U+E001: the words alone do not say which of "Status  Config  Usage" is the current one.
'use strict';
const MAX_LINES = 60, MAX_COLS = 240, MAX_CHARS = 9000;
const ON = '\uE000', OFF = '\uE001';

function tidyScreen(text) {
  if (text == null) return null;
  const ls = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '').slice(0, MAX_COLS));
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  while (ls.length && !ls[0]) ls.shift();
  return ls.slice(-MAX_LINES).join('\n').slice(-MAX_CHARS);
}

// the text alone (for what reads the screen as words: the permission mode, the folder-trust prompt)
const plainScreen = (text) => (text == null ? null : String(text).replace(/[\uE000\uE001]/g, ''));

// A screen captured with its colours (tmux capture-pane -e: SGR escape sequences) -> the text, with what is drawn in
// reverse video or on a background of its own between the two marks. Everything else about the colours is dropped.
function marksFromAnsi(text) {
  if (text == null) return null;
  return String(text).split('\n').map((line) => {
    let out = '', rev = false, bg = false, on = false, last = 0;
    const mark = () => { const m = rev || bg; if (m !== on) { out += m ? ON : OFF; on = m; } };
    const re = /\u001b\[([0-9;:]*)m|\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) { mark(); out += line.slice(last, m.index); }
      last = re.lastIndex;
      if (m[1] === undefined) continue;                              // (not a colour: cursor moves, titles)
      const ps = m[1] === '' ? [0] : m[1].split(/[;:]/).map((x) => +x || 0);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (p === 0) { rev = false; bg = false; }
        else if (p === 7) rev = true;
        else if (p === 27) rev = false;
        else if (p === 49) bg = false;
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) bg = true;
        else if (p === 48) { bg = true; i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0; }
        else if (p === 38) i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0;        // (a foreground colour's own numbers)
      }
    }
    if (last < line.length) { mark(); out += line.slice(last); }
    // (a mark opened over the blanks at the end of a line marks nothing)
    out = out.replace(/\uE000(\s*)$/, '$1');
    if (on && out.includes(ON) && out.lastIndexOf(ON) > out.lastIndexOf(OFF)) out = out.replace(/\s+$/, '') + OFF;
    return out;
  }).join('\n');
}

module.exports = { tidyScreen, plainScreen, marksFromAnsi, MAX_CHARS };
