'use strict';
const { randomUUID } = require('crypto');
const { alwaysLabel } = require('./permission-rules');

// A pending response is the authority: once it is gone, no UI action can decide it again.
// How long a card waits: Claude Code shows its own terminal prompt at the same time, so its hook can wait
// long (answered either way; permission-hook.js gives up after 60 min) -- the card must not vanish while the
// terminal still asks. Codex waits for the hook before it asks itself, so its cards stay short.
const WAIT = { claude: 3590e3, codex: 105e3 };
// onChange(session, end): end says why a card went away -- { why: 'decided' (choice from the panel / dashboard) | 'defer'
// | 'closed' (the hook process ended: answered or interrupted in the terminal) | 'advanced' (a later hook event: it was
// answered in the terminal) | 'timeout', choice, tool }; no end when a card was added
function createPermissions(onChange, timeout = WAIT) {
  const waitFor = (provider) => (typeof timeout === 'number' ? timeout : timeout[provider] || timeout.claude);
  const pending = new Map();
  function finish(id, choice, why) {
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
    onChange(p.session, { why, choice, tool: p.tool });
    return live;
  }
  return {
    add(d, res) {
      if (res.destroyed) return;
      const id = randomUUID();
      const p = { id, session: d.session, provider: d.provider || 'claude', tool: d.tool, input: d.input || {},
        cwd: d.cwd || '', agentId: d.agentId || '', subagent: d.subagent || '',
        // what 总是允许 would add (Claude Code's own "don't ask again" suggestions), as one line; '' = no such option
        always: d.provider === 'codex' ? '' : alwaysLabel(d.suggestions),
        started: Date.now(), res };
      p.close = () => finish(id, undefined, 'closed');
      p.timer = setTimeout(() => finish(id, undefined, 'timeout'), waitFor(p.provider));
      pending.set(id, p);
      res.once('close', p.close);
      onChange(p.session);
      return id;
    },
    list(session) {
      return [...pending.values()].filter((p) => p.session === session)
        .map(({ id, provider, tool, input, cwd, subagent, always }) => ({ id, provider, tool, input, cwd, subagent, always }));
    },
    decide(id, choice) {
      if (choice === 'defer' && pending.get(id)?.provider === 'codex') return finish(id, undefined, 'defer');
      if (choice === 'always' && !pending.get(id)?.always) return false;              // (nothing it could add)
      return ['allow', 'always', 'deny'].includes(choice) && finish(id, choice, 'decided');
    },
    advance(d) {
      if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', 'Interrupt'].includes(d.hookEvent)) return;
      for (const p of [...pending.values()]) {
        if (p.session !== d.session) continue;
        if (d.hookEvent !== 'SessionEnd' && p.agentId !== (d.agentId || '')) continue;
        // Async relays can arrive out of order: the PreToolUse that preceded this prompt must not dismiss it.
        if (d.eventAt && d.eventAt < p.started) continue;
        finish(p.id, undefined, 'advanced');
      }
    },
    clear() { for (const id of [...pending.keys()]) finish(id, undefined, 'clear'); },
  };
}
module.exports = { createPermissions };
