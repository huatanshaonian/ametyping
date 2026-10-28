'use strict';
// Namespace at ingress so identical upstream IDs cannot share permissions or chat state. Claude Code's ids stay
// bare (they always have); Codex and OpenCode sessions carry their provider's prefix.
const PREFIX = { codex: 'codex:', opencode: 'opencode:' };
const PROVIDERS = new Set(['claude', 'codex', 'opencode']);
function providerOf(id) {
  const s = String(id || '');
  if (s.startsWith(PREFIX.codex)) return 'codex';
  if (s.startsWith(PREFIX.opencode)) return 'opencode';
  return 'claude';
}
const rawOf = (id) => String(id || '').replace(/^(codex|opencode):/, '');
const nsId = (provider, raw) => (raw && PREFIX[provider] ? PREFIX[provider] + raw : raw);
function normalizeSession(d) {
  const provider = PROVIDERS.has(d.provider) ? d.provider : 'claude';
  const rawSession = typeof d.session === 'string' ? d.session : '';
  return { ...d, provider, rawSession, session: nsId(provider, rawSession) };
}
module.exports = { normalizeSession, providerOf, rawOf, nsId, PREFIX };
