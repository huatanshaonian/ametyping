// The pet starting up (after a restart, an update, the computer waking): Claude Code sessions that are already open
// are taken onto the list at once (running-sessions.js), instead of only appearing with their next hook event. Each
// record's pid must still be a Claude process (not a reused pid); what started it says whether it sits in a terminal
// we can type into. The state is "idle" until the session's own hooks say more.
'use strict';
const { listRunning, transcriptOf, projectOf } = require('./running-sessions');

// deps: sessions (the pet's Map), bridge (ancestors), home, isClaude(name), isTerminal(name), onChange()
async function adoptRunning({ sessions, bridge, home, isClaude, isTerminal, onChange }) {
  let n = 0;
  for (const r of listRunning(home)) {
    if (sessions.has(r.sessionId)) continue;
    const chain = await bridge.ancestors(r.pid);
    if (!chain.length || chain[0].pid !== r.pid || !isClaude(chain[0].name)) continue;       // gone, or the pid is reused
    const t = Date.now(), parent = chain[1];
    sessions.set(r.sessionId, {
      id: r.sessionId, provider: 'claude', rawSession: r.sessionId, project: projectOf(r.cwd), title: r.name || undefined, cwd: r.cwd,
      transcript: transcriptOf(home, r.cwd, r.sessionId) || undefined, state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t,
      claudePid: r.pid, fromPid: null, headless: false, terminal: !!parent && isTerminal(parent.name) && r.entrypoint !== 'ide',
    });
    n++;
  }
  if (n) onChange();
  return n;
}

module.exports = { adoptRunning };
