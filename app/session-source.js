'use strict';
// Namespace at ingress so identical upstream IDs cannot share permissions or chat state. Claude Code's ids stay
// bare (they always have); Codex and OpenCode sessions carry their provider's prefix.
const { modelOf, aiOf } = require('./ai-providers');
const PREFIX = { codex: 'codex:', opencode: 'opencode:', agy: 'agy:' };
const PROVIDERS = new Set(['claude', 'codex', 'opencode', 'agy']);
function providerOf(id) {
  const s = String(id || '');
  if (s.startsWith(PREFIX.codex)) return 'codex';
  if (s.startsWith(PREFIX.opencode)) return 'opencode';
  if (s.startsWith(PREFIX.agy)) return 'agy';
  return 'claude';
}
const rawOf = (id) => String(id || '').replace(/^(codex|opencode|agy):/, '');
const nsId = (provider, raw) => (raw && PREFIX[provider] ? PREFIX[provider] + raw : raw);
function normalizeSession(d) {
  const provider = PROVIDERS.has(d.provider) ? d.provider : 'claude';
  const rawSession = typeof d.session === 'string' ? d.session : '';
  // OpenCode and Antigravity events carry the model the session runs on (providerID + model id): its badge shows the provider's mark
  const model = modelOf({ providerID: d.modelProvider, modelID: d.modelID || d.modelName });
  return { ...d, provider, rawSession, model, ai: aiOf(model),
    session: nsId(provider, rawSession) };
}
module.exports = { normalizeSession, providerOf, rawOf, nsId, PREFIX };
