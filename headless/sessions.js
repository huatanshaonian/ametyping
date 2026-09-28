// Session table for the headless service: the same bookkeeping as the pet's main.js (state per Claude Code
// session, fed by hook events), minus everything about windows. Always in "chat mode": an ended session is
// kept for a while so it can still be resumed from the dashboard.
'use strict';

const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const STALE_WORK_MS = 10 * 60e3, WAIT_SHOW_MS = 10 * 60e3, KEEP_MS = 12 * 3600e3;

function createSessions() {
  const map = new Map();   // id -> { id, provider, rawSession, project, title, state, lines[], steps, t0, last, born, cwd, transcript,
                           //         claudePid, claudeComm, fromPid, target:{socket,pane}|null, headless }

  function ensure(id, d) {
    let s = map.get(id);
    if (!s) {
      const t = Date.now();
      s = { id, provider: d.provider || 'claude', rawSession: d.rawSession || id, project: '', state: 'idle',
        lines: [], steps: 0, t0: t, last: t, born: t };
      map.set(id, s);
    }
    return s;
  }

  // one hook event (type = the /event/<type> the relay posted)
  function event(type, d) {
    const id = d.session || 'unknown', t = Date.now();
    if (type === 'quit') {
      const q = map.get(id);
      if (q) Object.assign(q, { state: 'ended', claudePid: null, claudeComm: null, fromPid: null, target: null, headless: false, last: t });
      return;
    }
    const s = ensure(id, d);
    if (d.project) s.project = String(d.project).slice(0, 40);
    if (d.title) s.title = String(d.title).slice(0, 60);
    if (d.transcript) s.transcript = String(d.transcript);
    if (d.cwd) s.cwd = String(d.cwd);
    if (type === 'idle') { s.last = t; if (s.state === 'ended') s.state = 'idle'; return; }   // SessionStart
    if (type === 'message' || s.state === 'done') { s.steps = 0; s.t0 = t; }
    if (type === 'thinking' || type === 'reading') s.steps++;
    s.state = type; s.last = t;
    const text = d.text ? String(d.text).slice(0, 300) : '';
    const lastLine = s.lines[s.lines.length - 1];
    if (text && !(lastLine && lastLine.text === text)) s.lines.push({ text, t, type });
    s.lines = s.lines.slice(-60);
  }

  // expire stale states and drop long-inactive sessions
  function expire() {
    const t = Date.now();
    for (const [id, s] of map) {
      if (WORKING.has(s.state) && t - s.last > STALE_WORK_MS) s.state = 'idle';
      if (s.state === 'waiting' && t - s.last > WAIT_SHOW_MS) s.state = 'idle';
      if (t - s.last > KEEP_MS) map.delete(id);
    }
  }

  function label(s) {
    if (s.title) return s.title;
    const same = [...map.values()].filter((o) => o.provider === s.provider && o.project === s.project && !o.title);
    const base = s.project || (s.provider === 'codex' ? 'Codex' : 'Claude');
    return same.length > 1 ? `${base} #${String(s.rawSession || s.id).slice(0, 4)}` : base;
  }

  // how a reply from the dashboard reaches this session (same values as the pet: the server knows them)
  function via(s) {
    if (s.provider === 'codex') return 'codex';
    if (s.state === 'ended') return 'resume';
    if (s.headless) return 'busy';
    if (s.claudePid && s.target) return 'terminal';
    return s.claudePid ? 'none' : 'unknown';
  }

  const list = () => [...map.values()].sort((x, y) => x.born - y.born);
  return { map, ensure, event, expire, label, via, list };
}

module.exports = { createSessions };
