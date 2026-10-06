// Types a reply into a Claude Code session running in a tmux pane: the input box emptied first (what was typed there by
// hand would otherwise be sent along -- Ctrl+E Ctrl+U, then Backspace Ctrl+U for the lines above; Ctrl+Y there brings
// it back), the text as one bracketed paste (so newlines stay part of the message instead of submitting it early),
// then Enter submits it.
'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const { marksFromAnsi } = require('../app/screen-text');

function tmux(socket, args, input) {
  return new Promise((resolve) => {
    const p = execFile('tmux', ['-S', socket, ...args], { timeout: 5000 }, (err, out, stderr) =>
      resolve(err ? { ok: false, err: String(stderr || err.message).trim().slice(0, 200) } : { ok: true, out: String(out || '') }));
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLEAR = ['C-e', 'C-u', ...Array.from({ length: 20 }, () => ['BSpace', 'C-u']).flat()];
async function send(target, text) {
  let r = await tmux(target.socket, ['send-keys', '-t', target.pane, ...CLEAR]);
  if (!r.ok) return r;
  await sleep(100);
  const buf = 'ame-' + crypto.randomBytes(6).toString('hex');
  r = await tmux(target.socket, ['load-buffer', '-b', buf, '-'], text);
  if (!r.ok) return r;
  r = await tmux(target.socket, ['paste-buffer', '-p', '-d', '-b', buf, '-t', target.pane]);
  if (!r.ok) { await tmux(target.socket, ['delete-buffer', '-b', buf]); return r; }
  await sleep(150);                                                // let the TUI take in the paste before submitting
  return tmux(target.socket, ['send-keys', '-t', target.pane, 'Enter']);
}

// one navigation key (the terminal's own menus: /model, /resume, prompts); btab = Shift+Tab (permission mode);
// Claude Code's Ctrl combinations: the running command to the background, stash the draft, send what is queued now
// (send-keys goes to the pane itself: tmux's own C-b prefix is not in the way)
const KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', esc: 'Escape', tab: 'Tab', btab: 'BTab',
  bksp: 'BSpace', ctrlxs: ['C-x', 'C-s'] };
// the other Ctrl combinations Claude Code's menus name (Ctrl+A in /resume ...): never C, D or Z (interrupt / end)
for (const c of 'abefghijklmnopqrstuvwxy') KEYS['ctrl' + c] = 'C-' + c;
// "c:text": typed as it is, without Enter (the letter a menu takes, what goes into its search box, a path)
const CHAR = /^c:([^\x00-\x1f\x7f]{1,200})$/;
function key(target, name) {
  const ch = CHAR.exec(name);
  if (ch) return tmux(target.socket, ['send-keys', '-t', target.pane, '-l', '--', ch[1]]);
  if (!KEYS[name]) return Promise.resolve({ ok: false, err: 'unknown key' });
  return tmux(target.socket, ['send-keys', '-t', target.pane, ...[].concat(KEYS[name])]);
}

// the visible text of the pane (null when it cannot be read)
// hl: captured with its colours, and what is highlighted (a menu's current tab) left marked in the text
// (app/screen-text.js)
async function screen(target, hl = false) {
  const r = await tmux(target.socket, ['capture-pane', '-p', ...(hl ? ['-e'] : []), '-t', target.pane]);
  return !r.ok ? null : hl ? marksFromAnsi(r.out) : r.out;
}

module.exports = { send, key, screen, KEYS, CHAR };
