// The slash commands this machine's Claude Code offers besides the built-in ones, for the dashboard's suggestions
// (sent to the server as { t: 'cmds' }):
//   ~/.claude/commands/**/*.md        /name (a sub-folder is a namespace: tools/x.md -> /tools:x)
//   ~/.claude/skills/<name>/SKILL.md  /name
//   installed plugins' commands/*.md and skills/<name>/SKILL.md   /plugin:name
// The description is the front matter's `description:`, else the first heading or line. Project folders' own
// .claude/commands are not looked at.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX = 300;

function head(file) {
  try { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(4096), n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString('utf8', 0, n); } catch { return ''; }
}
function describe(file) {
  const s = head(file).replace(/^﻿/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s);
  const field = (k) => { const m = fm && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(fm[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  let desc = field('description');
  if (!desc) {
    const body = fm ? s.slice(fm[0].length) : s;
    desc = (body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[-=]+$/.test(l)) || '').replace(/^#+\s*/, '');
  }
  return { name: field('name'), desc: desc.replace(/\s+/g, ' ').slice(0, 120) };
}
const ls = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

function commandsIn(dir, prefix, out, depth = 0) {
  for (const e of ls(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) commandsIn(p, prefix + e.name + ':', out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) out.push({ name: prefix + e.name.slice(0, -3), desc: describe(p).desc, src: prefix ? 'command' : 'user' });
  }
}
function skillsIn(dir, prefix, out) {
  for (const e of ls(dir)) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const d = describe(f);
    out.push({ name: prefix + (d.name || e.name), desc: d.desc, src: 'skill' });
  }
}

function scan(home) {
  const base = path.join(home, '.claude'), out = [];
  commandsIn(path.join(base, 'commands'), '', out);
  skillsIn(path.join(base, 'skills'), '', out);
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(base, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch {}
  for (const [id, installs] of Object.entries(installed)) {
    const plugin = id.split('@')[0];
    const at = Array.isArray(installs) && installs[0] && installs[0].installPath;
    if (!plugin || !at) continue;
    commandsIn(path.join(at, 'commands'), plugin + ':', out);
    skillsIn(path.join(at, 'skills'), plugin + ':', out);
  }
  const seen = new Set();
  return out.filter((c) => /^[\w.:-]{1,80}$/.test(c.name) && !seen.has(c.name) && seen.add(c.name)).slice(0, MAX);
}

module.exports = { scan };
