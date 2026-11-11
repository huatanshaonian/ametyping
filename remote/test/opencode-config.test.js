'use strict';
// OpenCode 配置指南's generator (public/js/apps/opencode-config.js) and the gateway fields it reads.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('path'), fs = require('fs');
const { pathToFileURL } = require('url');
const { catalog } = require('../server/magpie/normalize');
const { createMagpie } = require('../server/magpie');
const pub = (f) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'apps', f)).href);

const GATEWAY = { data: [
  { id: 'group/opus-main', magpie_label: 'opus-main · routing group', owned_by: 'kiro', context_window: 1000000, max_input_tokens: 1000000, max_output_tokens: 128000, modalities: { input: ['text', 'image'] }, reasoning_levels: ['low', 'medium', 'high'], tool_call: true },
  { id: 'devin/gpt-6-astra', magpie_label: 'GPT-6 Astra · Devin', owned_by: 'devin', context_window: 1000000, max_input_tokens: 1000000, max_output_tokens: 128000, native_endpoints: ['/v1/chat/completions'], modalities: { input: ['text', 'image'] }, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], tool_call: true },
  { id: 'devin/swe-2', magpie_label: 'SWE-2 · Devin', owned_by: 'devin', context_window: 262000, max_input_tokens: 262000, max_output_tokens: 128000, native_endpoints: ['/v1/chat/completions'], modalities: { input: ['text', 'image'] }, reasoning_levels: ['medium', 'high', 'max'], tool_call: true },
  { id: 'cc-ubuntu/claude/claude-fable-5-2', magpie_label: 'Claude Fable 5.2 · Claude Code · cc-ubuntu', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 128000, native_endpoints: ['/v1/chat/completions', '/v1/responses', '/v1/messages'], modalities: { input: ['text', 'image', 'pdf'] }, reasoning_levels: ['low', 'max'], tool_call: true },
  { id: 'auto/claude-opus-5-5', magpie_label: 'Claude Opus 5.5 · routing group', owned_by: 'cc-ubuntu', context_window: 1000000, max_output_tokens: 128000 },
] };

test('gateway catalogue keeps what a config entry needs: limits, modalities, tools, groups', () => {
  const c = catalog(GATEWAY);
  const swe = c.find((m) => m.id === 'devin/swe-2'), fable = c.find((m) => m.id.endsWith('fable-5-2'));
  assert.deepEqual([swe.context, swe.input, swe.output, swe.tools, swe.nativeMessages, swe.group], [262000, 262000, 128000, true, false, false]);
  assert.deepEqual(fable.modalities, ['text', 'image', 'pdf']); assert.equal(fable.nativeMessages, true);
  assert.equal(c.find((m) => m.id === 'group/opus-main').group, true); assert.equal(c.find((m) => m.id === 'auto/claude-opus-5-5').group, true);
});

test('opencodeModels exposes the catalogue only, never a key', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'windose-ocm-'));
  try {
    const client = { enabled: true, request: async (ep) => ep === 'models' ? GATEWAY : ep === 'magpie/quotas' ? { data: [] } : {}, connection: () => ({ key: 'sk-SECRET-key', baseURL: 'x' }) };
    const m = createMagpie({ dataDir: dir, client, autoStart: false });
    await m.poll();
    const r = m.opencodeModels();
    assert.equal(r.models.length, 5); assert.equal(r.models.find((x) => x.id === 'devin/swe-2').anthropic, false);
    assert.ok(!JSON.stringify(r).includes('SECRET'));
    m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generator: base entries kept as they are, new ones built from gateway data, roles fall back sensibly', async () => {
  const { buildConfig, entryFor, rows } = await pub('opencode-config.js');
  const { BASE_CONFIG } = await pub('opencode-base.js');
  const gw = catalog(GATEWAY).map(({ id, name, provider, efforts, nativeMessages, context, input, output, modalities, tools, group }) => ({ id, name, provider, efforts, anthropic: nativeMessages, context, input, output, modalities, tools, group }));
  // the base is the configuration in use: magpie file key reference, no drive path or literal key
  const baseText = JSON.stringify(BASE_CONFIG);
  assert.equal(BASE_CONFIG.providers.magpie.settings.apiKey, '{file:~/.config/opencode/.secrets/magpie-nas.key}');
  assert.ok(!/[A-Z]:[\\/]|sk-[A-Za-z0-9]{8}/.test(baseText));
  assert.ok(BASE_CONFIG.providers.magpie.models['devin/swe-2'] && BASE_CONFIG.providers.magpie.models['devin/gemini-4-carbon']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'downloads', 'opencode-magpie.json'), 'utf8')), BASE_CONFIG);

  const e = entryFor(gw.find((m) => m.id.endsWith('fable-5-2')), 'Fable');
  assert.equal(e.package, '@opencode/ai/providers/anthropic-compatible');
  assert.deepEqual(e.capabilities.input, ['text', 'image']); // pdf is not an OpenCode input kind
  assert.deepEqual(e.capabilities.reasoning, { supported: true, effort: ['low', 'max'] });
  assert.deepEqual(entryFor(gw.find((m) => m.id === 'auto/claude-opus-5-5')).capabilities.reasoning, undefined);

  const list = rows(BASE_CONFIG, gw);
  assert.ok(list.slice(0, Object.keys(BASE_CONFIG.providers.magpie.models).length).every((r) => r.inBase));
  assert.equal(list.find((r) => r.id === 'cc-ubuntu/claude/claude-fable-5-2').source, 'cc-ubuntu');
  assert.equal(list.find((r) => r.id === 'auto/claude-opus-5-5').source, '路由组');

  const cfg = buildConfig(BASE_CONFIG, gw, [{ id: 'devin/swe-2', name: '' }, { id: 'cc-ubuntu/claude/claude-fable-5-2', name: 'Fable · VM' }], { main: 'cc-ubuntu/claude/claude-fable-5-2', general: 'group/deepseek-worker' });
  assert.deepEqual(Object.keys(cfg.providers.magpie.models), ['devin/swe-2', 'cc-ubuntu/claude/claude-fable-5-2']);
  assert.deepEqual(cfg.providers.magpie.models['devin/swe-2'], BASE_CONFIG.providers.magpie.models['devin/swe-2']);
  assert.equal(cfg.providers.magpie.models['cc-ubuntu/claude/claude-fable-5-2'].name, 'Fable · VM');
  assert.equal(cfg.model, 'magpie/cc-ubuntu/claude/claude-fable-5-2');
  assert.equal(cfg.agents.general.model, 'magpie/cc-ubuntu/claude/claude-fable-5-2'); // not ticked -> main
  assert.equal(cfg.providers.magpie.settings.baseURL, 'https://magapi.huatan.org/v1');
  assert.deepEqual(Object.keys(buildConfig(BASE_CONFIG, gw, []).providers.magpie.models), []);
});
