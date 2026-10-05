// Does a Claude Code session sit in a terminal we can type into? By what started its process:
//   - a shell or a terminal program: yes;
//   - Claude Code itself: a background session (`claude daemon` -> `claude --bg-pty-host` -> the session). It has no
//     window, but it runs in a pseudo-terminal of its own that the console bridge reaches like any other -- told
//     apart from a session without one (the desktop app is "Claude.exe" too, the IDE plugin starts it with pipes) by
//     reading its screen once: Claude Code's interface drawn there, or nothing;
//   - anything else (an IDE, the desktop app): no.
'use strict';

const CLAUDE = /^claude\.exe$/i;
// what Claude Code's terminal interface always shows: its prompt, the rules around the input box, the mode line
const TUI = /❯|─{20}|shift\+tab to cycle/;

// parent: { pid, name } of what started the session's process (null: unknown); pid: the session's process;
// isTermHost(name); screen(pid) -> the console's visible text or null
async function inTerminal({ parent, pid, isTermHost, screen }) {
  if (!parent) return false;
  if (isTermHost(parent.name)) return true;
  if (!CLAUDE.test(parent.name)) return false;
  let text = null;
  try { text = await screen(pid); } catch {}
  return !!text && TUI.test(text);
}

module.exports = { inTerminal };
