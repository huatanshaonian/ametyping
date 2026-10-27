// Session table for the Windows headless service: the bookkeeping of sessions.js (hook events, labels), with what is
// different on Windows. A session's terminal is a console window (s.terminal, found by ../app/session-locate.js), not a
// tmux pane; and whether its process is still there is asked through the console bridge, which is slow -- so, as the
// pet does, only a session quiet for a minute is looked at, every two minutes, not every pass.
'use strict';
const { createSessions } = require('./sessions');

const WORKING = new Set(['message', 'thinking', 'reading', 'error']);
const STALE_WORK_MS = 10 * 60e3, WAIT_SHOW_MS = 10 * 60e3, KEEP_MS = 12 * 3600e3;
const QUIET_MS = 60e3, GONE_CHECK_MS = 2 * 60e3;

// procAlive(pid) -> Promise<boolean>; cards(id) -> the session's open permission cards; onGone(id): its process ended
// without a word (killed, crashed, a Codex window closed)
function createWinSessions({ procAlive, cards, onGone }) {
  const base = createSessions();
  const { map } = base;

  function expire() {
    const t = Date.now();
    for (const [id, s] of map) {
      if (WORKING.has(s.state) && t - s.last > STALE_WORK_MS) s.state = 'idle';
      if (s.state === 'waiting' && t - s.last > WAIT_SHOW_MS && !cards(id).length) s.state = 'idle';   // (a card still up: still waiting)
      if (s.claudePid && !s.headless && !s.checking && s.state !== 'ended' && t - s.last > QUIET_MS && t - (s.aliveAt || 0) > GONE_CHECK_MS) {
        s.checking = true; s.aliveAt = t;
        procAlive(s.claudePid).then((alive) => { s.checking = false; if (!alive && map.get(id) === s) onGone(id); }, () => { s.checking = false; });
      }
      // long quiet: off the list once nothing runs it any more (one still open in its terminal is checked above)
      if (t - s.last > KEEP_MS && !s.claudePid && !s.checking) map.delete(id);
    }
  }

  // how a reply from the dashboard reaches this session (the same values as the pet's)
  function via(s) {
    if (s.state === 'ended') return 'resume';
    if (s.headless) return 'busy';
    if (s.claudePid && s.terminal) return 'terminal';
    return s.claudePid ? 'none' : 'unknown';
  }

  return { map, ensure: base.ensure, event: base.event, label: base.label, list: base.list, expire, via };
}

module.exports = { createWinSessions };
