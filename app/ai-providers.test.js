'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelOf, aiOf } = require('../app/ai-providers');
const { normalizeSession } = require('../app/session-source');

test('a hook event keeps its model and gets the provider mark', () => {
  const s = normalizeSession({ provider: 'opencode', session: 'ses_x', modelProvider: 'deepseek', modelID: 'deepseek-chat' });
  assert.deepEqual(s.model, { providerID: 'deepseek', id: 'deepseek-chat' });
  assert.deepEqual(s.ai, { slug: 'deepseek', name: 'DeepSeek' });
  assert.equal(s.session, 'opencode:ses_x');

  const agy = normalizeSession({ provider: 'agy', session: '787c15ac-2977-40c9-ba34-e59b64506264', modelName: 'gemini-3.1-pro' });
  assert.deepEqual(agy.model, { providerID: 'google', id: 'gemini-3.1-pro' });
  assert.deepEqual(agy.ai, { slug: 'google', name: 'Google' });
  assert.equal(agy.session, 'agy:787c15ac-2977-40c9-ba34-e59b64506264');
  assert.equal(agy.rawSession, '787c15ac-2977-40c9-ba34-e59b64506264');
});

test('the provider a session runs on, from the model ref', () => {
  assert.deepEqual(modelOf({ providerID: 'deepseek', id: 'deepseek-chat' }), { providerID: 'deepseek', id: 'deepseek-chat' });
  assert.deepEqual(modelOf({ modelProvider: 'openai', modelID: 'gpt-5' }), { providerID: 'openai', id: 'gpt-5' });
  assert.equal(modelOf({ providerID: 'not a provider!' }), null);
  assert.equal(modelOf(null), null);
});

test('provider marks: the mainstream ones, aliases, and a model-name fallback for custom providers', () => {
  assert.deepEqual(aiOf({ providerID: 'deepseek', id: 'deepseek-chat' }), { slug: 'deepseek', name: 'DeepSeek' });
  assert.deepEqual(aiOf({ providerID: 'anthropic', id: 'claude-sonnet-5' }), { slug: 'anthropic', name: 'Anthropic' });
  assert.deepEqual(aiOf({ providerID: 'openai', id: 'gpt-5' }), { slug: 'openai', name: 'OpenAI' });
  assert.deepEqual(aiOf({ providerID: 'google', id: 'gemini-3-pro' }), { slug: 'google', name: 'Google' });
  assert.deepEqual(aiOf({ providerID: 'google-vertex', id: 'gemini-3-pro' }), { slug: 'google', name: 'Google Vertex' });
  assert.deepEqual(aiOf({ providerID: 'xai', id: 'grok-4' }), { slug: 'xai', name: 'xAI' });
  assert.deepEqual(aiOf({ providerID: 'alibaba-cn', id: 'qwen3-coder' }), { slug: 'alibaba', name: 'Qwen' });
  assert.deepEqual(aiOf({ providerID: 'moonshotai-cn', id: 'kimi-k2' }), { slug: 'moonshotai', name: 'Moonshot' });
  assert.deepEqual(aiOf({ providerID: 'zai', id: 'glm-5' }), { slug: 'zhipuai', name: 'Z.ai' });
  assert.deepEqual(aiOf({ providerID: 'minimax-cn', id: 'minimax-m2' }), { slug: 'minimax', name: 'MiniMax' });
  assert.deepEqual(aiOf({ providerID: 'ollama', id: 'llama4' }), { slug: 'ollama-cloud', name: 'Ollama' });
  assert.deepEqual(aiOf({ providerID: 'opencode', id: 'qwen3' }), null);           // OpenCode itself: one mark is enough
  assert.deepEqual(aiOf({ providerID: 'my-gateway', id: 'deepseek-v3.2' }), { slug: 'deepseek', name: 'DeepSeek' });
  assert.deepEqual(aiOf({ providerID: 'my-gateway', id: 'claude-opus-5-5' }), { slug: 'anthropic', name: 'Anthropic' });
  assert.deepEqual(aiOf({ providerID: 'my-gateway', id: 'gemini-3-flash' }), { slug: 'google', name: 'Google' });
  assert.equal(aiOf({ providerID: 'my-gateway', id: 'unknown-model' }), null);
});
