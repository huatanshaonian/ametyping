'use strict';
const { randomUUID } = require('crypto');

// A pending response is the authority: once it is gone, no UI action can decide it again.
function createPermissions(onChange, timeout = 105000) {
  const pending = new Map();
  function finish(id, choice) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.res.removeListener('close', p.close);
    const live = !p.res.destroyed && !p.res.writableEnded;
    if (live) {
      p.res.writeHead(200, { 'Content-Type': 'application/json' });
      p.res.end(JSON.stringify(choice ? { choice } : {}));
    }
    onChange(p.session);
    return live;
  }
  return {
    add(d, res) {
      if (res.destroyed) return;
      const id = randomUUID();
      const p = { id, session: d.session, provider: d.provider || 'claude', tool: d.tool, input: d.input || {},
        cwd: d.cwd || '', agentId: d.agentId || '', subagent: d.subagent || '',
        started: Date.now(), res };
      p.close = () => finish(id);
      p.timer = setTimeout(() => finish(id), timeout);
      pending.set(id, p);
      res.once('close', p.close);
      onChange(p.session);
      return id;
    },
    list(session) {
      return [...pending.values()].filter((p) => p.session === session)
        .map(({ id, provider, tool, input, cwd, subagent }) => ({ id, provider, tool, input, cwd, subagent }));
    },
    decide(id, choice) {
      if (choice === 'defer' && pending.get(id)?.provider === 'codex') return finish(id);
      return ['allow', 'deny'].includes(choice) && finish(id, choice);
    },
    advance(d) {
      if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', 'Interrupt'].includes(d.hookEvent)) return;
      for (const p of [...pending.values()]) {
        if (p.session !== d.session) continue;
        if (d.hookEvent !== 'SessionEnd' && p.agentId !== (d.agentId || '')) continue;
        // Async relays can arrive out of order: the PreToolUse that preceded this prompt must not dismiss it.
        if (d.eventAt && d.eventAt < p.started) continue;
        finish(p.id);
      }
    },
    clear() { for (const id of [...pending.keys()]) finish(id); },
  };
}
module.exports = { createPermissions };
