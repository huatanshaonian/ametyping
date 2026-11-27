// Reconnects already-running Claude / Codex / Antigravity / Kiro / OpenCode sessions on startup.
'use strict';
const { listRunning, lineage, transcriptOf, projectOf } = require('./running-sessions');
const { inTerminal } = require('./session-terminal');
const codexSessions = require('./codex-sessions');
const codexCli = require('./codex-cli');
const codexRecords = require('./codex-records');
const agySessions = require('./agy-sessions');
const agyCli = require('./agy-cli');
const agyRecords = require('./agy-records');
const kiroSessions = require('./kiro-sessions');
const kiroCli = require('./kiro-cli');
const kiroRecords = require('./kiro-records');
const opencode = require('./opencode');
const opencodeRecords = require('./opencode-records');
const { aiOf } = require('./ai-providers');

const CLI_PROVIDERS = [
  { provider: 'codex', registry: codexSessions, find: codexCli.findCodex, records: codexRecords, withMeta: false },
  { provider: 'agy', registry: agySessions, find: agyCli.findAgy, records: agyRecords, withMeta: true },
  { provider: 'kiro', registry: kiroSessions, find: kiroCli.findKiro, records: kiroRecords, withMeta: true },
];

async function adoptRunning({ sessions, bridge, home, isClaude, isTerminal, onChange }) {
  let n = 0;
  const { parked } = lineage(home);
  for (const r of listRunning(home)) {
    if (sessions.has(r.sessionId) || parked.has(r.sessionId)) continue;
    const chain = await bridge.ancestors(r.pid);
    if (!chain.length || chain[0].pid !== r.pid || !isClaude(chain[0].name)) continue;
    const t = Date.now(), parent = chain[1];
    const terminal = r.entrypoint !== 'ide' && await inTerminal({ parent, pid: r.pid, isTermHost: isTerminal, screen: (p) => bridge.screen(p) });
    if (sessions.has(r.sessionId)) continue;
    sessions.set(r.sessionId, {
      id: r.sessionId, provider: 'claude', rawSession: r.sessionId, project: projectOf(r.cwd), title: r.name || undefined, cwd: r.cwd,
      transcript: transcriptOf(home, r.cwd, r.sessionId) || undefined, state: 'idle', lines: [], steps: 0, t0: t, last: t, born: t,
      claudePid: r.pid, fromPid: null, headless: false, terminal,
    });
    n++;
  }

  for (const spec of CLI_PROVIDERS) {
    for (const r of spec.registry.list(home)) {
      const id = `${spec.provider}:${r.id}`;
      if (sessions.has(id)) continue;
      const chain = await bridge.ancestors(r.pid);
      if (!chain.length) continue;
      const c = spec.find(chain, process.pid);
      if (!c || c.pid !== r.pid) { spec.registry.forget(r.id, home); continue; }
      const identity = bridge.identity ? await bridge.identity(c.pid) : null;
      if (!identity) continue;
      if (r.identity && identity !== r.identity) { spec.registry.forget(r.id, home); continue; }
      if (sessions.has(id)) continue;
      const t = Date.now();
      const transcript = r.transcript || spec.records.fileOf(r.id) || undefined;
      const meta = spec.withMeta && transcript ? spec.records.metaOf(transcript) : null;
      const cwd = r.cwd || (meta && meta.cwd) || '';
      const model = (meta && meta.model) || undefined;
      sessions.set(id, {
        id,
        provider: spec.provider,
        rawSession: r.id,
        project: projectOf(cwd),
        cwd,
        title: spec.records.titleOf(r.id) || r.title || (meta && meta.title) || undefined,
        transcript,
        ...(model ? { model, ai: (meta && meta.ai) || aiOf(model) || undefined } : {}),
        state: 'idle',
        lines: [],
        steps: 0,
        t0: t,
        last: t,
        born: t,
        claudePid: c.pid,
        processIdentity: identity,
        fromPid: null,
        headless: c.own,
        terminal: !c.own && !!c.parent && isTerminal(c.parent.name),
      });
      n++;
    }
  }

  for (const m of opencode.listLive()) {
    const id = 'opencode:' + m.id;
    if (sessions.has(id)) continue;
    const t = Date.now();
    const cwd = m.cwd || m.directory || '';
    const model = m.modelProvider ? { providerID: m.modelProvider, id: m.modelID || '' } : undefined;
    sessions.set(id, {
      id, provider: 'opencode', rawSession: m.id, project: projectOf(cwd), cwd,
      title: opencodeRecords.titleOf(m.id) || m.title || undefined,
      transcript: m.transcript || opencodeRecords.fileOf(m.id) || undefined,
      model, ai: model ? aiOf(model) : undefined,
      state: 'idle', lines: [], steps: 0, t0: t, last: m.updated || t, born: t,
      claudePid: m.pid, fromPid: null, headless: false, terminal: true,
    });
    n++;
  }
  if (n) onChange();
  return n;
}

module.exports = { adoptRunning };
