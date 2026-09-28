'use strict';
// Namespace at ingress so identical upstream IDs cannot share permissions or chat state.
function normalizeSession(d) {
  const provider = d.provider === 'codex' ? 'codex' : 'claude';
  const rawSession = typeof d.session === 'string' ? d.session : '';
  return { ...d, provider, rawSession,
    session: provider === 'codex' && rawSession ? `codex:${rawSession}` : rawSession };
}
module.exports = { normalizeSession };
