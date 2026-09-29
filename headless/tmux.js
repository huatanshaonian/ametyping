// Types a reply into a Claude Code session running in a tmux pane: the text goes in as one bracketed paste
// (so newlines stay part of the message instead of submitting it early), then Enter submits it.
'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');

function tmux(socket, args, input) {
  return new Promise((resolve) => {
    const p = execFile('tmux', ['-S', socket, ...args], { timeout: 5000 }, (err, out, stderr) =>
      resolve(err ? { ok: false, err: String(stderr || err.message).trim().slice(0, 200) } : { ok: true, out: String(out || '') }));
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(target, text) {
  const buf = 'ame-' + crypto.randomBytes(6).toString('hex');
  let r = await tmux(target.socket, ['load-buffer', '-b', buf, '-'], text);
  if (!r.ok) return r;
  r = await tmux(target.socket, ['paste-buffer', '-p', '-d', '-b', buf, '-t', target.pane]);
  if (!r.ok) { await tmux(target.socket, ['delete-buffer', '-b', buf]); return r; }
  await sleep(150);                                                // let the TUI take in the paste before submitting
  return tmux(target.socket, ['send-keys', '-t', target.pane, 'Enter']);
}

// one navigation key (the terminal's own menus: /model, /resume, prompts); btab = Shift+Tab (permission mode)
const KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', esc: 'Escape', tab: 'Tab', btab: 'BTab' };
function key(target, name) {
  if (!KEYS[name]) return Promise.resolve({ ok: false, err: 'unknown key' });
  return tmux(target.socket, ['send-keys', '-t', target.pane, KEYS[name]]);
}

// the visible text of the pane (null when it cannot be read)
async function screen(target) {
  const r = await tmux(target.socket, ['capture-pane', '-p', '-t', target.pane]);
  return r.ok ? r.out : null;
}

module.exports = { send, key, screen, KEYS };
