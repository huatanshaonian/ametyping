// OpenCode configuration from the NAS gateway's model list (used by opencode-guide.js; no DOM, unit-tested).
// A model the base configuration already has keeps its entry as it is; another gets one built from the
// gateway's data: the Anthropic package when the gateway serves it on /v1/messages, the OpenAI-compatible one otherwise.
const ANTHROPIC = '@opencode/ai/providers/anthropic-compatible';
const OPENAI = '@opencode/ai/providers/openai-compatible';
const clone = (v) => JSON.parse(JSON.stringify(v));

// '<model> · <provider>' for a model with no name of its own: the gateway's label without its routing suffixes
export function displayName(m) {
  const label = String(m.name || m.id).replace(/\s*·\s*routing group$/i, '');
  return label || m.id;
}

export function entryFor(m, name) {
  const input = Array.isArray(m.modalities) && m.modalities.length ? m.modalities.filter((x) => x === 'text' || x === 'image') : ['text'];
  const entry = {
    name: name || displayName(m),
    modelID: m.id,
    package: m.anthropic ? ANTHROPIC : OPENAI,
    limit: { context: m.context || 128000, input: m.input || m.context || 128000, output: m.output || 32000 },
    capabilities: { tools: m.tools !== false, input: input.length ? input : ['text'], output: ['text'] },
  };
  if (Array.isArray(m.efforts) && m.efforts.length) entry.capabilities.reasoning = { supported: true, effort: [...m.efforts] };
  return entry;
}

// picks: [{ id, name }] in the order shown; main / general / explore: model ids among the picks
export function buildConfig(base, gateway, picks, { main, general, explore } = {}) {
  const known = base.providers.magpie.models;
  const byId = new Map(gateway.map((m) => [m.id, m]));
  const models = {};
  for (const { id, name } of picks) {
    if (known[id]) { models[id] = clone(known[id]); if (name) models[id].name = name; }
    else if (byId.has(id)) models[id] = entryFor(byId.get(id), name);
  }
  const ids = Object.keys(models);
  const pick = (want, fallback) => (ids.includes(want) ? want : fallback);
  const mainId = pick(main, ids[0]);
  const cfg = { $schema: base.$schema, model: mainId ? 'magpie/' + mainId : undefined, agents: {}, providers: {
    magpie: { ...clone(base.providers.magpie), models } } };
  for (const [agent, want] of [['general', general], ['explore', explore]]) {
    const id = pick(want, mainId);
    if (id) cfg.agents[agent] = { model: 'magpie/' + id };
  }
  if (!cfg.model) delete cfg.model;
  return cfg;
}

// the rows the generator lists: the base's models first (ticked, in its order), then everything else the gateway has
export function rows(base, gateway) {
  const known = base.providers.magpie.models;
  const seen = new Set(), out = [];
  const byId = new Map(gateway.map((m) => [m.id, m]));
  for (const [id, e] of Object.entries(known)) {
    seen.add(id);
    const g = byId.get(id);
    out.push({ id, name: e.name, source: sourceOf(id, g), group: g ? !!g.group : /^(group|auto)\//.test(id), inBase: true, offered: !!g, gateway: g || null });
  }
  for (const g of gateway) if (!seen.has(g.id)) out.push({ id: g.id, name: displayName(g), source: sourceOf(g.id, g), group: !!g.group, inBase: false, offered: true, gateway: g });
  return out;
}

export function sourceOf(id, g) {
  if (/^(group|auto)\//.test(id) || (g && g.group)) return '路由组';
  return id.split('/')[0];
}
