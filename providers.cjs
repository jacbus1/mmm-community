'use strict';

const { GATEWAY_MODELS, resolveModel, sensitive, assertInput, policyError } = require('./provider-policy.cjs');
// Transport references (no SDK, environment credentials or legacy imports):
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// https://platform.claude.com/docs/en/api/messages/create
// https://ai.google.dev/api/generate-content
// https://openrouter.ai/docs/quickstart
// https://docs.api.nvidia.com/nim/re/reference/llm-apis
// https://huggingface.co/docs/inference-providers/en/index
// https://docs.z.ai/api-reference/llm/chat-completion
// https://api-docs.deepseek.com/api/create-chat-completion/
// https://platform.kimi.ai/docs/api/chat
const DEFINITIONS = Object.freeze({
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', format: 'openai' },
  anthropic: { name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1/messages', format: 'anthropic' },
  // https://docs.x.ai/developers/rest-api-reference/inference/chat-completions
  xai: { name: 'xAI (Grok API)', endpoint: 'https://api.x.ai/v1/chat/completions', format: 'compatible' },
  gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', format: 'gemini' },
  openrouter: { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', format: 'compatible' },
  nvidia: { name: 'NVIDIA NIM', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', format: 'compatible' },
  huggingface: { name: 'Hugging Face', endpoint: 'https://router.huggingface.co/v1/chat/completions', format: 'compatible' },
  glm: { name: 'GLM (Z.AI)', endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', format: 'compatible' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', format: 'compatible' },
  kimi: { name: 'Kimi', endpoint: 'https://api.moonshot.ai/v1/chat/completions', format: 'compatible' },
  custom: { name: 'Custom OpenAI-compatible', endpoint: null, format: 'compatible' },
  local: { name: 'Local OpenAI-compatible', endpoint: null, format: 'compatible' },
});
const SETTING = 'providers';
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 64000;
const SAFE_ERRORS = new Set(['PROVIDER_CANCELLED', 'PROVIDER_REQUEST_BUDGET_EXHAUSTED', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_AUTH_FAILED', 'PROVIDER_HTTP_FAILED', 'PROVIDER_INVALID_RESPONSE', 'PROVIDER_OUTPUT_LIMIT',
  'PROVIDER_STREAM_INCOMPLETE', 'PROVIDER_TOOLS_REJECTED', 'PROVIDER_EMPTY_RESPONSE', 'PROVIDER_CREDENTIAL_ECHO_BLOCKED']);
function validId(id) { if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(id) || id === 'private-mail-master') throw policyError('INVALID_PROVIDER_ID'); return id; }
function integer(value, fallback, max) { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || value < 1 || value > max) throw policyError('INVALID_PROVIDER_LIMIT'); return value; }
function endpointFor(kind, endpoint) {
  const fixed = DEFINITIONS[kind]?.endpoint;
  if (fixed) { if (endpoint !== undefined && endpoint !== fixed) throw policyError('PROVIDER_ENDPOINT_FIXED'); return fixed; }
  if (typeof endpoint !== 'string' || endpoint.length > 512 || /[\s\\]/.test(endpoint)) throw policyError('INVALID_PROVIDER_ENDPOINT');
  let url; try { url = new URL(endpoint); } catch { throw policyError('INVALID_PROVIDER_ENDPOINT'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  let decodedPath; try { decodedPath = decodeURIComponent(url.pathname); } catch { throw policyError('INVALID_PROVIDER_ENDPOINT'); }
  if (url.username || url.password || url.search || url.hash || sensitive(decodedPath)) throw policyError('INVALID_PROVIDER_ENDPOINT');
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || (kind === 'local' && !loopback)) throw policyError('INVALID_PROVIDER_ENDPOINT');
  // Keep the exact explicit completion endpoint. Never append paths or probe.
  if (url.pathname === '/') throw policyError('COMPLETION_ENDPOINT_REQUIRED');
  return endpoint;
}
function catalog() {
  return Object.entries(DEFINITIONS).map(([kind, d]) => ({ kind, id: kind, name: d.name, endpoint: d.endpoint, requiresKey: kind !== 'local',
    format: d.format, monetaryQuota: 'unknown', publicDataOnly: true,
    knownModels: ['openrouter', 'nvidia', 'huggingface', 'custom'].includes(kind) ? Object.keys(GATEWAY_MODELS) : [] }));
}
function usageFrom(data, format) {
  const u = format === 'gemini' ? data.usageMetadata : data.usage;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = count(u?.prompt_tokens ?? u?.input_tokens ?? u?.promptTokenCount);
  const outputTokens = count(u?.completion_tokens ?? u?.output_tokens ?? u?.candidatesTokenCount);
  return { inputTokens, outputTokens, totalTokens: count(u?.total_tokens ?? u?.totalTokenCount) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null), source: u ? 'provider' : 'unknown', monetaryQuota: 'unknown' };
}
function parseResult(data, format) {
  if (!data || typeof data !== 'object' || data.error) throw policyError('PROVIDER_INVALID_RESPONSE');
  let text, finish;
  if (format === 'anthropic') {
    if (!Array.isArray(data.content) || data.content.some(c => c.type !== 'text' && c.type !== 'thinking' && c.type !== 'redacted_thinking')) throw policyError('PROVIDER_TOOLS_REJECTED');
    text = data.content.filter(c => c.type === 'text').map(c => c.text).join(''); finish = data.stop_reason;
    if (!['end_turn', 'stop_sequence', 'max_tokens'].includes(finish)) throw policyError('PROVIDER_INVALID_RESPONSE');
  } else if (format === 'gemini') {
    const candidate = data.candidates?.[0]; const parts = candidate?.content?.parts;
    if (!Array.isArray(parts) || parts.some(p => p.functionCall || p.executableCode || p.codeExecutionResult)) throw policyError('PROVIDER_TOOLS_REJECTED');
    text = parts.filter(p => !p.thought).map(p => p.text || '').join(''); finish = candidate.finishReason;
    if (!['STOP', 'MAX_TOKENS'].includes(finish)) throw policyError('PROVIDER_INVALID_RESPONSE');
  } else {
    const choice = data.choices?.[0];
    if (choice?.message?.tool_calls?.length || choice?.message?.function_call) throw policyError('PROVIDER_TOOLS_REJECTED');
    text = choice?.message?.content; finish = choice?.finish_reason;
    if (!['stop', 'length'].includes(finish)) throw policyError('PROVIDER_INVALID_RESPONSE');
  }
  if (typeof text !== 'string' || !text.trim()) throw policyError('PROVIDER_EMPTY_RESPONSE');
  if (text.length > MAX_TEXT) throw policyError('PROVIDER_OUTPUT_LIMIT');
  return { text, usage: usageFrom(data, format), status: ['length', 'max_tokens', 'MAX_TOKENS'].includes(finish) ? 'incomplete' : 'completed' };
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(policyError('PROVIDER_CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(policyError('PROVIDER_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function delay(ms, signal) {
  let timer;
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
function retryDelay(value) {
  if (!value) return 1000;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  // Do not retry early when the provider asks for a longer wait.
  return Number.isFinite(ms) && ms >= 0 && ms <= 5000 ? ms : null;
}
async function boundedResponse(response, signal, stream) {
  if (!response.body?.getReader) throw policyError('PROVIDER_INVALID_RESPONSE');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw policyError('PROVIDER_OUTPUT_LIMIT'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, buffer = '', output = '', finished = false, doneMarker = false, usage;
  function event(frame) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload) return;
    if (payload === '[DONE]') { doneMarker = true; return; }
    if (doneMarker) throw policyError('PROVIDER_INVALID_RESPONSE');
    const data = JSON.parse(payload);
    if (data.error) throw policyError('PROVIDER_INVALID_RESPONSE');
    if (data.usage) usage = data.usage;
    for (const choice of data.choices || []) {
      if (choice.index !== undefined && choice.index !== 0) throw policyError('PROVIDER_INVALID_RESPONSE');
      if (choice.delta?.tool_calls?.length || choice.delta?.function_call) throw policyError('PROVIDER_TOOLS_REJECTED');
      if (choice.delta?.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content !== 'string' || finished) throw policyError('PROVIDER_INVALID_RESPONSE');
        output += choice.delta.content;
        if (output.length > MAX_TEXT) throw policyError('PROVIDER_OUTPUT_LIMIT');
      }
      if (choice.finish_reason) { if (!['stop', 'length'].includes(choice.finish_reason)) throw policyError('PROVIDER_TOOLS_REJECTED'); finished = choice.finish_reason; }
    }
  }
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength; if (bytes > MAX_BYTES) throw policyError('PROVIDER_OUTPUT_LIMIT');
      buffer += decoder.decode(value, { stream: true });
      if (stream) {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) { event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
        if (buffer.length > 128000) throw policyError('PROVIDER_OUTPUT_LIMIT');
      }
    }
    if (!stream) return JSON.parse(buffer);
    if (buffer.trim()) event(buffer);
    if (!finished || !doneMarker) throw policyError('PROVIDER_STREAM_INCOMPLETE');
    return { choices: [{ message: { content: output }, finish_reason: finished }], usage };
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
class ProviderService {
  constructor({ vault, store, fetchImpl = globalThis.fetch }) { this.vault = vault; this.store = store; this.fetch = fetchImpl; this.active = new Set(); }
  _rows() { return this.store.getSetting(SETTING) || []; }
  _row(id) { validId(id); const row = this._rows().find(item => item.id === id); if (!row) throw policyError('PROVIDER_NOT_FOUND'); return row; }
  _save(row) { const rows = this._rows(); this.store.setSetting(SETTING, [...rows.filter(item => item.id !== row.id), row]); }
  list() { return this._rows().map(row => this.get(row.id)); }
  get(id) {
    const row = this._row(id);
    // Configured means a saved connection, not a successful authentication or
    // the outcome of its last request. Keep those independent UI states.
    return { ...row, configured: true, authenticated: row.authenticated === true, available: row.state === 'available',
      hasKey: Boolean(this.vault.get(id)), monetaryQuota: 'unknown', remainingRequests: Math.max(0, row.requestBudget - row.requestsUsed), publicDataOnly: true };
  }
  configure(input) {
    const id = validId(input.id); if (this.active.has(id)) throw policyError('PROVIDER_BUSY');
    if (!Object.hasOwn(DEFINITIONS, input.kind)) throw policyError('INVALID_PROVIDER_KIND');
    const model = input.model;
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model) || sensitive(model)) throw policyError('INVALID_PROVIDER_MODEL');
    const endpoint = endpointFor(input.kind, input.endpoint);
    if (input.kind === 'gemini' && !/^[A-Za-z0-9._-]+$/.test(model)) throw policyError('INVALID_PROVIDER_MODEL');
    const identity = resolveModel(input.kind, model);
    const old = this._rows().find(row => row.id === id);
    const label = input.label ?? old?.label ?? '';
    if (typeof label !== 'string' || label.length > 80 || /[\x00-\x1f\x7f]/.test(label) || sensitive(label)) throw policyError('INVALID_PROVIDER_LABEL');
    if (old && (old.kind !== input.kind || old.endpoint !== endpoint)) throw policyError('REMOVE_BEFORE_CHANGING_DESTINATION');
    const maxTokens = integer(input.maxTokens, old?.maxTokens || 1024, 8192);
    const requestBudget = integer(input.requestBudget, old?.requestBudget || 20, 10000);
    if (input.key !== undefined && (typeof input.key !== 'string' || !input.key || input.key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input.key))) throw policyError('INVALID_PROVIDER_KEY');
    const key = input.key ?? this.vault.get(id);
    if (key && (endpoint.includes(key) || model.includes(key) || id.includes(key) || label.includes(key))) throw policyError('CREDENTIAL_IN_METADATA');
    if (input.key !== undefined) this.vault.set(id, input.key);
    const row = { id, label, kind: input.kind, model, endpoint, ...identity, maxTokens, requestBudget,
      requestsUsed: old?.requestsUsed || 0, reservedTokens: old?.reservedTokens || 0, observedTokens: old?.observedTokens || 0,
      state: 'configured', authenticated: false, lastVerified: null, lastError: null };
    this._save(row); return this.get(id);
  }
  remove(id) { this._row(id); if (this.active.has(id)) throw policyError('PROVIDER_BUSY'); this.vault.remove(id); this.store.setSetting(SETTING, this._rows().filter(row => row.id !== id)); return { removed: true }; }
  async test(id, options = {}) {
    if (options.confirmCost !== true) throw policyError('COST_CONFIRMATION_REQUIRED');
    return this.generate(id, { text: 'Reply with the word READY.', classification: 'public', confirmedNonSensitive: true, signal: options.signal, _test: true });
  }
  async generate(id, input = {}) {
    const row = this._row(id); assertInput(row, input);
    if (this.active.has(id)) throw policyError('PROVIDER_BUSY');
    if (input.signal?.aborted) throw policyError('PROVIDER_CANCELLED');
    const key = this.vault.get(id);
    if (!key && row.kind !== 'local') throw policyError('PROVIDER_KEY_REQUIRED');
    if (key && input.text.includes(key)) throw policyError('SENSITIVE_CONTENT_BLOCKED');
    this.active.add(id);
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
    const signal = controller.signal; const format = DEFINITIONS[row.kind].format;
    const stream = typeof input.onDelta === 'function' && ['openai', 'compatible'].includes(format);
    const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
    if (key) { if (format === 'anthropic') headers['x-api-key'] = key; else if (format === 'gemini') headers['x-goog-api-key'] = key; else headers.Authorization = `Bearer ${key}`; }
    if (format === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    const maxTokens = input._test ? Math.min(32, row.maxTokens) : row.maxTokens;
    const body = format === 'gemini'
      ? { contents: [{ role: 'user', parts: [{ text: input.text }] }], generationConfig: { maxOutputTokens: maxTokens } }
      : { model: row.model, messages: [{ role: 'user', content: input.text }], [format === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokens, stream };
    if (stream && row.kind === 'openai') body.stream_options = { include_usage: true };
    if (row.kind === 'openrouter') body.provider = { allow_fallbacks: false, data_collection: 'deny' };
    const endpoint = format === 'gemini' ? `${row.endpoint}/${row.model}:generateContent` : row.endpoint;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw policyError('PROVIDER_CANCELLED');
        if (row.requestsUsed >= row.requestBudget) throw policyError('PROVIDER_REQUEST_BUDGET_EXHAUSTED');
        row.requestsUsed++; row.reservedTokens += Buffer.byteLength(input.text) + maxTokens; this._save(row);
        const response = await abortable(this.fetch(endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal }), signal);
        if (response.status === 429) {
          await response.body?.cancel(); row.state = 'rate_limited'; row.lastError = 'PROVIDER_RATE_LIMITED'; this._save(row);
          const wait = retryDelay(response.headers.get('retry-after'));
          if (attempt === 0 && wait !== null) { await delay(wait, signal); continue; }
          throw policyError('PROVIDER_RATE_LIMITED');
        }
        if (!response.ok || response.redirected) { await response.body?.cancel();
          if ([401, 403].includes(response.status)) { row.authenticated = false; throw policyError('PROVIDER_AUTH_FAILED'); }
          throw policyError('PROVIDER_HTTP_FAILED');
        }
        row.authenticated = Boolean(key); row.state = key ? 'authenticated' : 'configured'; this._save(row);
        const isSse = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
        if (isSse && !stream) { await response.body?.cancel(); throw policyError('PROVIDER_INVALID_RESPONSE'); }
        const data = await boundedResponse(response, signal, isSse);
        const result = parseResult(data, format);
        if (key && result.text.includes(key)) throw policyError('PROVIDER_CREDENTIAL_ECHO_BLOCKED');
        if (signal.aborted) throw policyError('PROVIDER_CANCELLED');
        row.observedTokens += result.usage.totalTokens || 0;
        row.state = result.status === 'completed' ? 'available' : 'authenticated';
        row.lastVerified = result.status === 'completed' ? new Date().toISOString() : row.lastVerified;
        row.lastError = result.status === 'completed' ? null : 'PROVIDER_INCOMPLETE'; this._save(row);
        // Buffer until the stream terminates and passes tool/credential checks.
        // This prevents partial credentials or rejected tool output reaching UI.
        if (typeof input.onDelta === 'function') input.onDelta(result.text);
        return result;
      }
    } catch (error) {
      const code = timedOut ? 'PROVIDER_TIMEOUT' : signal.aborted ? 'PROVIDER_CANCELLED' : SAFE_ERRORS.has(error?.code) ? error.code : 'PROVIDER_REQUEST_FAILED';
      row.state = code === 'PROVIDER_RATE_LIMITED' ? 'rate_limited' : 'failed'; row.lastError = code; this._save(row);
      throw policyError(code);
    } finally { clearTimeout(timer); controller.abort(); input.signal?.removeEventListener('abort', abort); this.active.delete(id); }
  }
}
module.exports = { ProviderService, catalog };
