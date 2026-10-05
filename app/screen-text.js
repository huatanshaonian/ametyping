// The terminal's visible text as the dashboard shows it (终端画面: Claude Code's own menus -- /model, /resume,
// /config, a prompt -- are drawn on the screen and never reach the transcript): the lines without their trailing
// blanks, empty lines at both ends dropped, the last 60 lines at most.
'use strict';
const MAX_LINES = 60, MAX_COLS = 240, MAX_CHARS = 9000;

function tidyScreen(text) {
  if (text == null) return null;
  const ls = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '').slice(0, MAX_COLS));
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  while (ls.length && !ls[0]) ls.shift();
  return ls.slice(-MAX_LINES).join('\n').slice(-MAX_CHARS);
}

module.exports = { tidyScreen, MAX_CHARS };
