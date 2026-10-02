// The context window of this machine's Claude Code sessions, which their transcripts do not record: 1M when the
// configured model asks for it ("opus[1m]" in ~/.claude/settings.json or ANTHROPIC_MODEL), else 200k.
// (A session switched with /model is not seen; one that has gone past 200k is taken as 1M by the reader.)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let cached = null, at = 0;
function claudeWindow() {
  if (cached && Date.now() - at < 60e3) return cached;
  let model = process.env.ANTHROPIC_MODEL || '';                    // (the environment wins over settings, as in Claude Code)
  if (!model) try { model = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).model || ''; } catch {}
  cached = /\[1m\]/i.test(String(model)) ? 1e6 : 200e3; at = Date.now();
  return cached;
}

module.exports = { claudeWindow };
