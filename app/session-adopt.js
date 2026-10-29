// The pet starting up (after a restart, an update, the computer waking): Claude Code sessions that are already open
// are taken onto the list at once (running-sessions.js), instead of only appearing with their next hook event. Each
// record's pid must still be a Claude process (not a reused pid); what started it says whether it sits in a terminal
// we can type into. The state is "idle" until the session's own hooks say more.
'use strict';
const { listRunning, lineage, transcriptOf, projectOf } = require('./running-sessions');
const { inTerminal } = require('./session-terminal');
const codexSessions = require('./codex-sessions');
const codexCli = require('./codex-cli');
const codexRecords = require('./codex-records');
const agySessions = require('./agy-sessions');
const agyCli = require('./agy-cli');
const agyRecords = require('./agy-records');

// deps: sessions (the pet's Map), bridge (ancestors, screen), home, isClaude(name), isTerminal(name), onChange()
async function adoptRunning({ sessions, bridge, home, isClaude, isTerminal, onChange }) {
  let n = 0;
  const { parked } = lineage(home);
  for (const r of listRunning(home)) {
    if (sessions.has(r.sessionId) || parked.has(r.sessionId)) continue;       // (a terminal parked on a background session: its window)
    const chain = await bridge.ancestors(r.pid);
    if (!chain.length || chain[0].pid !== r.pid || !isClaude(chain[0].name)) continue;       // gone, or the pid is reused
    const t = Date.now(), parent = chain[1];
    const terminal = r.entrypoint !== 'ide' && await inTerminal({ parent, pid: r.pid, isTermHost: isTerminal, screen: (p) => bridge.screen(p) });
    if (sessions.has(r.sessionId)) continue;                                                // (its own hook came in meanwhile)
    sessions.set(r.sessionId, {
      id: r.sessionId, provider: 'claude', rawSession: r.sessionId, project: projectOf(r.cwd), title: r.name || undefined, cwd: r.cwd,
      transcript: transcriptOf(home, r.cwd, r.sessionId) || undefined, state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t,
      claudePid: r.pid, fromPid: null, headless: false, terminal,
    });
    n++;
  }
  for (const r of codexSessions.list(home)) {
    const id = 'codex:' + r.id;
    if (sessions.has(id)) continue;
    const chain = await bridge.ancestors(r.pid);
    if (!chain.length) continue; // A slow bridge is not proof that the process ended.
    const c = codexCli.findCodex(chain, process.pid);
    if (!c || c.pid !== r.pid) { codexSessions.forget(r.id, home); continue; }
    const identity = bridge.identity ? await bridge.identity(c.pid) : null;
    if (!identity) continue;
    if (identity !== r.identity) { codexSessions.forget(r.id, home); continue; }
    if (sessions.has(id)) continue;
    const t = Date.now();
    sessions.set(id, {
      id, provider: 'codex', rawSession: r.id, project: projectOf(r.cwd), cwd: r.cwd,
      title: codexRecords.titleOf(r.id) || r.title || undefined, transcript: r.transcript || codexRecords.fileOf(r.id) || undefined,
      state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t,
      claudePid: c.pid, processIdentity: identity, fromPid: null, headless: c.own, terminal: !c.own && !!c.parent && isTerminal(c.parent.name),
    });
    n++;
  }
  for (const r of agySessions.list(home)) {
    const id = 'agy:' + r.id;
    if (sessions.has(id)) continue;
    const chain = await bridge.ancestors(r.pid);
    if (!chain.length) continue;
    const c = agyCli.findAgy(chain, process.pid);
    if (!c || c.pid !== r.pid) { agySessions.forget(r.id, home); continue; }
    const identity = bridge.identity ? await bridge.identity(c.pid) : null;
    if (!identity) continue;
    if (identity !== r.identity) { agySessions.forget(r.id, home); continue; }
    if (sessions.has(id)) continue;
    const t = Date.now();
    const transcript = r.transcript || agyRecords.fileOf(r.id) || undefined;
    const meta = transcript ? agyRecords.metaOf(transcript) : null;
    sessions.set(id, {
      id, provider: 'agy', rawSession: r.id, project: projectOf(r.cwd || (meta && meta.cwd)), cwd: r.cwd || (meta && meta.cwd) || '',
      title: agyRecords.titleOf(r.id) || r.title || (meta && meta.title) || undefined, transcript,
      model: (meta && meta.model) || undefined, ai: (meta && meta.ai) || undefined,
      state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t,
      claudePid: c.pid, processIdentity: identity, fromPid: null, headless: c.own, terminal: !c.own && !!c.parent && isTerminal(c.parent.name),
    });
    n++;
  }
  if (n) onChange();
  return n;
}

module.exports = { adoptRunning };
