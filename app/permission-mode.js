// Claude Code's permission mode, read from its status line under the input box (Shift+Tab cycles it):
//   ⏵⏵ auto mode on · ⏸ manual mode on · ⏵⏵ accept edits on · ⏸ plan mode on · ⏵⏵ bypass permissions on
// (as Claude Code 2.1 prints them). Only the bottom lines are looked at, so the words inside the conversation above
// never count. null when the status line shows none of them.
'use strict';

const MODES = { 'auto mode': 'auto', 'manual mode': 'manual', 'accept edits': 'acceptEdits', 'plan mode': 'plan', 'bypass permissions': 'bypassPermissions' };
const LINE = /^\s*(?:⏵⏵|⏵|⏸)\s*(auto mode|manual mode|accept edits|plan mode|bypass permissions) on\b/;

function modeFromScreen(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim()).slice(-6).reverse();
  for (const l of lines) { const m = LINE.exec(l); if (m) return MODES[m[1]]; }
  return null;
}

module.exports = { modeFromScreen, MODES: Object.values(MODES) };
