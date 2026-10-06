'use strict';
const { randomUUID } = require('crypto');
const { alwaysLabel } = require('./permission-rules');

// A pending response is the authority: once it is gone, no UI action can decide it again.
// How long a card waits: Claude Code shows its own terminal prompt at the same time, so its hook can wait
// long (answered either way; permission-hook.js gives up after 60 min) -- the card must not vanish while the
// terminal still asks. Codex waits for the hook before it asks itself, so its cards stay short.
const WAIT = { claude: 3590e3, codex: 105e3 };

// Claude asking you something (its AskUserQuestion tool: up to four questions, each with options, some with several
// answers allowed) comes through the same hook as a permission prompt. It is answered by handing the tool's own input
// back with the answers filled in -- { "<the question>": "<the option's label, labels joined with ", ", or your own
// words>" } -- which Claude Code takes exactly like an answer given in its terminal. An "allow" without answers it
// ignores (the terminal keeps asking), so such a card has no 允许.
const isAsk = (p) => p.provider !== 'codex' && p.tool === 'AskUserQuestion' && Array.isArray(p.input.questions) && p.input.questions.length > 0 &&
  p.input.questions.every((q) => q && typeof q.question === 'string' && q.question);
function answersFor(p, a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  for (const q of p.input.questions) {
    const v = a[q.question];
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) return null;       // (every question answered)
    out[q.question] = v.trim();
  }
  return out;
}
// "Chat about this" in the terminal: the questions are put aside and Claude asks what you want to clarify
const CHAT = 'The user wants to talk about these questions before answering them. Do not ask them again yet: ask the user what they would like to clarify.';

// onChange(session, end): end says why a card went away -- { why: 'decided' (choice from the panel / dashboard) | 'defer'
// | 'closed' (the hook process ended: answered or interrupted in the terminal) | 'advanced' (a later hook event: it was
// answered in the terminal) | 'timeout', choice, tool }; no end when a card was added
function createPermissions(onChange, timeout = WAIT) {
  const waitFor = (provider) => (typeof timeout === 'number' ? timeout : timeout[provider] || timeout.claude);
  const pending = new Map();
  // body: what the hook is told when it is not simply the choice (an answer: the tool's input with the answers)
  function finish(id, choice, why, body) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.res.removeListener('close', p.close);
    const live = !p.res.destroyed && !p.res.writableEnded;
    if (live) {
      p.res.writeHead(200, { 'Content-Type': 'application/json' });
      p.res.end(JSON.stringify(body || (choice ? { choice } : {})));
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
      p.ask = isAsk(p);                                              // Claude's questions: answered, not allowed
      if (p.ask) p.always = '';
      p.close = () => finish(id, undefined, 'closed');
      p.timer = setTimeout(() => finish(id, undefined, 'timeout'), waitFor(p.provider));
      pending.set(id, p);
      res.once('close', p.close);
      onChange(p.session);
      return id;
    },
    list(session) {
      return [...pending.values()].filter((p) => p.session === session)
        .map(({ id, provider, tool, input, cwd, subagent, always, ask }) => ({ id, provider, tool, input, cwd, subagent, always, ask }));
    },
    // extra: { answers } with choice 'answer'
    decide(id, choice, extra) {
      const p = pending.get(id);
      if (choice === 'defer' && p && p.provider === 'codex') return finish(id, undefined, 'defer');
      if (p && p.ask) {
        if (choice === 'answer') {
          const answers = answersFor(p, extra && extra.answers);
          return !!answers && finish(id, 'answer', 'decided', { choice: 'allow', updatedInput: { ...p.input, answers } });
        }
        if (choice === 'chat') return finish(id, 'chat', 'decided', { choice: 'deny', message: CHAT });
        return choice === 'deny' && finish(id, 'deny', 'decided');
      }
      if (choice === 'always' && !(p && p.always)) return false;                     // (nothing it could add)
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
