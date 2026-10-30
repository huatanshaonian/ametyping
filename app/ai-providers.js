// Which AI provider a session runs on, and the icon that stands for it (the OpenCode badge shows the provider's
// mark next to OpenCode's own). OpenCode reports a Model.Ref { providerID, id }; custom OpenAI-compatible providers
// often name the real model in the id, so the id is used as a fallback.
'use strict';

// providerID (models.dev / OpenCode) -> [icon slug, name shown in the tooltip]
const PROVIDERS = {
  deepseek: ['deepseek', 'DeepSeek'],
  anthropic: ['anthropic', 'Anthropic'],
  openai: ['openai', 'OpenAI'],
  google: ['google', 'Google'],
  'google-vertex': ['google', 'Google Vertex'],
  'google-vertex-anthropic': ['google', 'Google Vertex'],
  xai: ['xai', 'xAI'],
  alibaba: ['alibaba', 'Qwen'],
  'alibaba-cn': ['alibaba', 'Qwen'],
  'alibaba-coding-plan': ['alibaba', 'Qwen'],
  'alibaba-coding-plan-cn': ['alibaba', 'Qwen'],
  'alibaba-token-plan': ['alibaba', 'Qwen'],
  'alibaba-token-plan-cn': ['alibaba', 'Qwen'],
  qwen: ['alibaba', 'Qwen'],
  moonshotai: ['moonshotai', 'Moonshot'],
  'moonshotai-cn': ['moonshotai', 'Moonshot'],
  'kimi-code-plan-global': ['moonshotai', 'Kimi'],
  'kimi-code-plan-cn': ['moonshotai', 'Kimi'],
  zhipuai: ['zhipuai', 'Zhipu'],
  'zhipuai-coding-plan': ['zhipuai', 'Zhipu'],
  zai: ['zhipuai', 'Z.ai'],
  'zai-coding-plan': ['zhipuai', 'Z.ai'],
  minimax: ['minimax', 'MiniMax'],
  'minimax-cn': ['minimax', 'MiniMax'],
  'minimax-coding-plan': ['minimax', 'MiniMax'],
  'minimax-cn-coding-plan': ['minimax', 'MiniMax'],
  mistral: ['mistral', 'Mistral'],
  meta: ['meta', 'Meta'],
  cohere: ['cohere', 'Cohere'],
  groq: ['groq', 'Groq'],
  openrouter: ['openrouter', 'OpenRouter'],
  'ollama-cloud': ['ollama-cloud', 'Ollama'],
  ollama: ['ollama-cloud', 'Ollama'],
  'github-copilot': ['github-copilot', 'GitHub Copilot'],
  nvidia: ['nvidia', 'NVIDIA'],
  perplexity: ['perplexity', 'Perplexity'],
  huggingface: ['huggingface', 'Hugging Face'],
  cerebras: ['cerebras', 'Cerebras'],
  togetherai: ['togetherai', 'Together'],
  xiaomi: ['xiaomi', 'Xiaomi'],
  'xiaomi-token-plan-cn': ['xiaomi', 'Xiaomi'],
  'xiaomi-token-plan-sgp': ['xiaomi', 'Xiaomi'],
  'xiaomi-token-plan-ams': ['xiaomi', 'Xiaomi'],
  volcengine: ['volcengine', 'Volcengine'],
  'volcengine-coding-plan': ['volcengine', 'Volcengine'],
  tencent: ['tencent', 'Tencent'],
  'tencent-tokenhub': ['tencent', 'Tencent'],
  'tencent-coding-plan': ['tencent', 'Tencent'],
  'tencent-token-plan': ['tencent', 'Tencent'],
  stepfun: ['stepfun', 'StepFun'],
  'stepfun-ai': ['stepfun', 'StepFun'],
  'stepfun-ai-step-plan': ['stepfun', 'StepFun'],
  'stepfun-step-plan': ['stepfun', 'StepFun'],
  siliconflow: ['siliconflow', 'SiliconFlow'],
  'siliconflow-cn': ['siliconflow', 'SiliconFlow'],
  deepinfra: ['deepinfra', 'DeepInfra'],
  cloudflare: ['cloudflare', 'Cloudflare'],
  'cloudflare-ai-gateway': ['cloudflare', 'Cloudflare'],
  'cloudflare-workers-ai': ['cloudflare', 'Cloudflare'],
  azure: ['azure', 'Azure'],
  'azure-cognitive-services': ['azure', 'Azure'],
  'amazon-bedrock': ['amazon-bedrock', 'Amazon Bedrock'],
  opencode: ['', 'OpenCode'],
  'opencode-go': ['', 'OpenCode'],
};
// a custom provider: the model name usually says whose model it is
const MODELS = [
  [/deepseek/i, 'deepseek', 'DeepSeek'],
  [/claude|anthropic/i, 'anthropic', 'Anthropic'],
  [/gpt|chatgpt|codex|(^|[-_/])o[1-9](-|$)|davinci/i, 'openai', 'OpenAI'],
  [/gemini|gemma|argon/i, 'google', 'Google'],
  [/grok/i, 'xai', 'xAI'],
  [/qwen|qwq|tongyi/i, 'alibaba', 'Qwen'],
  [/kimi|moonshot/i, 'moonshotai', 'Moonshot'],
  [/glm|zhipu/i, 'zhipuai', 'Zhipu'],
  [/minimax|abab/i, 'minimax', 'MiniMax'],
  [/mistral|mixtral|codestral|magistral/i, 'mistral', 'Mistral'],
  [/llama/i, 'meta', 'Meta'],
  [/command|cohere/i, 'cohere', 'Cohere'],
  [/sonar/i, 'perplexity', 'Perplexity'],
  [/hunyuan/i, 'tencent', 'Tencent'],
  [/doubao|volc/i, 'volcengine', 'Volcengine'],
  [/step[-_]/i, 'stepfun', 'StepFun'],
  [/mimo/i, 'xiaomi', 'Xiaomi'],
];

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// a Model.Ref (or the raw hook fields) -> { providerID, id } | null
function modelOf(v) {
  if (!v || typeof v !== 'object') return null;
  const id = clean(v.id || v.modelID || v.modelName || (typeof v.model === 'string' ? v.model : ''), 80);
  let providerID = clean(v.providerID || v.provider || v.modelProvider, 40);
  if (!providerID && id) {
    for (const [re, slug] of MODELS) if (re.test(id)) { providerID = slug; break; }
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(providerID)) return null;
  return { providerID, id };
}

// -> { slug, name } for the badge's second mark; null when there is no separate provider mark (OpenCode itself,
// or a provider we have no icon for)
function aiOf(model) {
  const m = typeof model === 'string' ? { providerID: model, id: model } : model;
  if (!m || typeof m !== 'object') return null;
  const p = clean(m.providerID, 40).toLowerCase();
  const hit = PROVIDERS[p];
  if (hit) return hit[0] ? { slug: hit[0], name: hit[1] } : null;
  const id = clean(m.id, 120);
  for (const [re, slug, name] of MODELS) if (re.test(id)) return { slug, name };
  return null;
}

module.exports = { modelOf, aiOf, PROVIDERS };
