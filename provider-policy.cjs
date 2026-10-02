'use strict';

// Exact reviewed model identities. Gateways must never infer identity from an
// arbitrary alias or choose a model automatically. Add entries deliberately.
const GATEWAY_MODELS = Object.freeze({
  'openai/gpt-4.1-mini': 'openai', 'openai/gpt-4.1': 'openai',
  'openai/gpt-oss-120b': 'openai', 'openai/gpt-oss-20b': 'openai',
  'anthropic/claude-sonnet-4': 'anthropic',
  'google/gemini-2.5-flash': 'google',
  'meta-llama/llama-3.3-70b-instruct': 'meta',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': 'nvidia',
  'nvidia/nemotron-3-ultra-550b-a55b': 'nvidia',
  'deepseek/deepseek-chat': 'deepseek', 'deepseek/deepseek-r1': 'deepseek',
  'deepseek-ai/DeepSeek-R1': 'deepseek',
  'deepseek-ai/deepseek-v4-flash': 'deepseek',
  'deepseek-ai/deepseek-v4-flash-0731': 'deepseek',
  'z-ai/glm-4.5': 'glm', 'z-ai/glm-5': 'glm', 'z-ai/glm-5.3-flash': 'glm',
  'moonshotai/kimi-k2': 'kimi', 'moonshotai/kimi-k3': 'kimi',
  'moonshotai/Kimi-K2-Instruct': 'kimi',
  'Qwen/Qwen3-235B-A22B': 'qwen', 'qwen/qwen3-235b-a22b': 'qwen',
  'gpt-4.1-mini': 'openai', 'claude-sonnet-4-20250514': 'anthropic',
  'gemini-2.5-flash': 'google', 'deepseek-chat': 'deepseek',
  'deepseek-reasoner': 'deepseek', 'glm-4.5': 'glm', 'glm-5': 'glm', 'kimi-k3': 'kimi',
});
const RESTRICTED = new Set(['deepseek', 'glm', 'kimi', 'qwen']);
function policyError(code) { const error = new Error(code); error.code = code; error.status = 400; return error; }
function resolveModel(kind, model) {
  const gateway = ['openrouter', 'nvidia', 'huggingface', 'custom'].includes(kind);
  const vendor = gateway ? GATEWAY_MODELS[model] : kind;
  if (!vendor || (gateway && !Object.hasOwn(GATEWAY_MODELS, model))) throw policyError('MODEL_IDENTITY_UNKNOWN');
  return { vendor, restricted: RESTRICTED.has(vendor) };
}
function sensitive(text) {
  return /(?:nvapi-|xai-|hf_|sk-(?:ant-|or-)?|gh[pousr]_|AIza)[A-Za-z0-9_-]{8,}/i.test(text)
    || /\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|cookie)\b\s*[:=]/i.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/i.test(text)
    || /\b(?:\d{3}-\d{2}-\d{4}|(?:\d[ -]*?){13,19})\b/.test(text)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text);
}
function assertInput(config, input) {
  resolveModel(config.kind, config.model);
  if (!['public', 'classical', 'non_sensitive'].includes(input.classification) || input.confirmedNonSensitive !== true) throw policyError('PUBLIC_DATA_CONFIRMATION_REQUIRED');
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 40000 || input.text.includes('\0')) throw policyError('INVALID_PROVIDER_INPUT');
  if (sensitive(input.text)) throw policyError('SENSITIVE_CONTENT_BLOCKED');
  if (input.files || input.attachments || input.history || input.tools) throw policyError('PROVIDER_CONTEXT_NOT_ALLOWED');
}
module.exports = { GATEWAY_MODELS, resolveModel, sensitive, assertInput, policyError };
