// OpenCode subagent scanner.
// Reads ~/.ametyping/opencode/subagents/<parentID>.json written by opencode-plugin/index.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const STALE = 15 * 60e3, RECENT = 6 * 3600e3;
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function subagentsDir() {
  const root = process.env.OPENCODE_AME_HOME || path.join(os.homedir(), '.ametyping', 'opencode');
  return path.join(root, 'subagents');
}

function scan(now = Date.now()) {
  const groups = new Map();
  const dir = subagentsDir();
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return groups; }
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const parentId = e.name.slice(0, -5);
    if (!/^ses_[A-Za-z0-9]{6,100}$/.test(parentId)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')); } catch { continue; }
    const list = Array.isArray(doc && doc.agents) ? doc.agents : [];
    const rows = [];
    for (const a of list) {
      if (!a || typeof a.id !== 'string') continue;
      let state = ['run', 'done', 'stop'].includes(a.state) ? a.state : 'run';
      const t0 = Number(a.t0) || now;
      const last = Number(a.last) || t0;
      let act = a.act ? short(a.act, 120) : undefined;
      if (state === 'run' && now - last > STALE) { state = 'stop'; act = '没有动静'; }
      if (state !== 'run' && now - last >= RECENT) continue;
      rows.push({
        id: short(a.id, 64),
        type: short(a.type || 'subagent', 40),
        name: a.name ? short(a.name, 40) : undefined,
        desc: short(a.desc || '', 120),
        state,
        act,
        t0,
        last,
        end: state === 'run' ? undefined : (Number(a.end) || last),
      });
    }
    if (rows.length) {
      groups.set('opencode:' + parentId, rows.sort((a, b) => (b.state === 'run') - (a.state === 'run') || b.t0 - a.t0).slice(0, 12));
    }
  }
  return groups;
}

module.exports = { scan, subagentsDir };
