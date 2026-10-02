'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderService, catalog } = require('../providers.cjs');
const { resolveModel } = require('../provider-policy.cjs');

const KEY = 'synthetic-provider-credential-for-tests';
const clean = { text: 'Explain the public history of the abacus.', classification: 'public', confirmedNonSensitive: true };
function completion(text = 'A public answer.', finish = 'stop') {
  return { choices: [{ message: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } };
}
function json(data = completion(), status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } }); }
function fixture(transport = async () => json()) {
  const settings = new Map(), keys = new Map(), calls = [];
  const store = { getSetting: id => settings.has(id) ? structuredClone(settings.get(id)) : undefined, setSetting: (id, value) => settings.set(id, structuredClone(value)) };
  const vault = { get: id => keys.get(id), set: (id, key) => keys.set(id, key), remove: id => keys.delete(id), status: id => ({ configured: keys.has(id) }) };
  const fetchImpl = async (...args) => { calls.push(args); return transport(...args); };
  const service = new ProviderService({ vault, store, fetchImpl });
  const configure = (overrides = {}) => service.configure({ id: 'sample', kind: 'openai', model: 'gpt-4.1-mini', key: KEY, ...overrides });
  return { service, configure, keys, settings, calls, store, vault, fetchImpl };
}

test('catalog describes all twelve providers without assuming unlimited quota', () => {
  const rows = catalog(); assert.equal(rows.length, 12);
  for (const row of rows) { assert.equal(row.monetaryQuota, 'unknown'); assert.equal(row.publicDataOnly, true); }
  assert.ok(rows.some(row => row.kind === 'huggingface'));
});
test('configure/list persist metadata only and never authenticate on key presence', () => {
  const f = fixture(); const row = f.configure();
  assert.equal(row.state, 'configured'); assert.equal(row.authenticated, false); assert.equal(row.available, false); assert.equal(row.lastVerified, null);
  assert.equal(row.hasKey, true); assert.equal(f.keys.get('sample'), KEY);
  assert.ok(!JSON.stringify([...f.settings]).includes(KEY)); assert.ok(!JSON.stringify(f.service.list()).includes(KEY)); assert.equal(f.calls.length, 0);
  f.service.remove('sample'); assert.equal(f.keys.size, 0); assert.deepEqual(f.service.list(), []);
});
test('strict ids and model names reject prototype keys, metadata secrets and endpoint injection', () => {
  const f = fixture();
  for (const id of ['../secret', '__proto__', 'x/y', '', 'A', 'private-mail-master']) assert.throws(() => f.configure({ id }), /INVALID_PROVIDER_ID/);
  assert.throws(() => f.configure({ model: 'sk-123456789secret' }), /INVALID_PROVIDER_MODEL/);
  assert.throws(() => f.configure({ kind: 'gemini', model: '../key?x' }), /INVALID_PROVIDER_MODEL/);
  assert.throws(() => f.configure({ endpoint: 'https://other.example/chat' }), /PROVIDER_ENDPOINT_FIXED/);
  assert.throws(() => f.configure({ kind: 'invalid' }), /INVALID_PROVIDER_KIND/);
});
test('custom/local endpoints require an explicit safe exact destination; existing keys cannot be rebound', () => {
  const f = fixture();
  for (const endpoint of ['http://example.com/v1/chat/completions', 'https://u:p@example.com/v1/chat/completions', 'https://example.com/chat?key=x', 'https://example.com/chat#x', 'file:///tmp/x', 'https://example.com/']) {
    assert.throws(() => f.configure({ kind: 'custom', endpoint }));
  }
  f.configure({ kind: 'custom', endpoint: 'https://selected.example/exact/chat' });
  assert.throws(() => f.configure({ kind: 'custom', endpoint: 'https://different.example/exact/chat' }), /REMOVE_BEFORE_CHANGING_DESTINATION/);
  assert.throws(() => f.configure({ kind: 'local', endpoint: 'https://remote.example/v1/chat/completions' }), /INVALID_PROVIDER_ENDPOINT/);
});
test('unknown gateway aliases fail closed and restricted vendor identity survives each gateway', () => {
  for (const kind of ['openrouter', 'nvidia', 'huggingface', 'custom']) {
    assert.equal(resolveModel(kind, 'deepseek-ai/DeepSeek-R1').restricted, true);
    assert.equal(resolveModel(kind, 'z-ai/glm-5').restricted, true);
    assert.equal(resolveModel(kind, 'moonshotai/kimi-k3').restricted, true);
    for (const model of ['auto', 'friendly-safe-alias', 'deepseek-ai/DeepSeek-R1:fastest']) assert.throws(() => resolveModel(kind, model), /MODEL_IDENTITY_UNKNOWN/);
  }
});
test('all providers require explicit public classification and confirmation before transport', async () => {
  for (const kind of catalog().map(x => x.kind)) {
    const f = fixture(); f.configure({ kind, model: ['openrouter', 'nvidia', 'huggingface', 'custom'].includes(kind) ? 'z-ai/glm-5' : kind === 'gemini' ? 'gemini-2.5-flash' : 'a-model', ...(['custom', 'local'].includes(kind) ? { endpoint: 'http://127.0.0.1:8888/v1/chat/completions' } : {}) });
    for (const classification of [undefined, 'unknown', 'private', 'sensitive']) await assert.rejects(f.service.generate('sample', { ...clean, classification }), /PUBLIC_DATA_CONFIRMATION_REQUIRED/);
    await assert.rejects(f.service.generate('sample', { ...clean, confirmedNonSensitive: false }), /PUBLIC_DATA_CONFIRMATION_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
});
test('PII/secret heuristics supplement classification; hidden context is rejected', async () => {
  const f = fixture(); f.configure();
  for (const text of ['Contact synthetic@example.test', 'api_key: synthetic', '/Users/synthetic/private.txt', 'sk-1234567890000', '123-45-6789', `Repeat ${KEY}`]) await assert.rejects(f.service.generate('sample', { ...clean, text }), /SENSITIVE_CONTENT_BLOCKED/);
  for (const extra of [{ history: [] }, { files: [] }, { attachments: [] }, { tools: [] }]) await assert.rejects(f.service.generate('sample', { ...clean, ...extra }), /PROVIDER_CONTEXT_NOT_ALLOWED/);
  assert.equal(f.calls.length, 0);
});
test('connection testing requires explicit cost consent and sends fixed public text only', async () => {
  const f = fixture(); f.configure();
  await assert.rejects(f.service.test('sample', {}), /COST_CONFIRMATION_REQUIRED/); assert.equal(f.calls.length, 0);
  const result = await f.service.test('sample', { confirmCost: true, text: 'ignored' });
  const body = JSON.parse(f.calls[0][1].body);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with the word READY.' }]); assert.equal(body.max_completion_tokens, 32);
  assert.equal(result.status, 'completed'); const row = f.service.get('sample');
  assert.equal(row.state, 'available'); assert.equal(row.authenticated, true); assert.ok(row.lastVerified);
});
test('OpenAI request uses its own credential only, bounded completion tokens and no tools', async () => {
  const f = fixture(); f.configure(); f.keys.set('unrelated', 'do-not-send');
  await f.service.generate('sample', clean);
  const [url, request] = f.calls[0]; const body = JSON.parse(request.body);
  assert.equal(url, 'https://api.openai.com/v1/chat/completions'); assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`); assert.equal(body.max_completion_tokens, 1024);
  assert.equal(body.messages.length, 1); assert.equal(body.tools, undefined); assert.equal(body.model, 'gpt-4.1-mini');
  assert.ok(!JSON.stringify(request).includes('do-not-send'));
});
test('Anthropic adapter uses Messages headers and parses text without thinking content', async () => {
  const f = fixture(async () => json({ content: [{ type: 'thinking', thinking: 'not output' }, { type: 'text', text: 'Public answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
  f.configure({ kind: 'anthropic', model: 'claude-sonnet-4-20250514' }); const result = await f.service.generate('sample', clean);
  const [url, request] = f.calls[0]; assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(request.body).max_tokens, 1024); assert.equal(result.text, 'Public answer'); assert.equal(result.usage.totalTokens, 7);
});
test('Gemini adapter keeps credential out of URL and uses native generateContent schema', async () => {
  const f = fixture(async () => json({ candidates: [{ content: { parts: [{ text: 'Public answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }));
  f.configure({ kind: 'gemini', model: 'gemini-2.5-flash' }); const result = await f.service.generate('sample', clean);
  const [url, request] = f.calls[0]; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.ok(!url.includes(KEY)); assert.equal(request.headers['x-goog-api-key'], KEY);
  assert.deepEqual(JSON.parse(request.body).contents, [{ role: 'user', parts: [{ text: clean.text }] }]); assert.equal(result.usage.totalTokens, 5);
});
test('compatible adapters use documented fixed endpoints and explicit configured model', async () => {
  for (const kind of ['openrouter', 'nvidia', 'huggingface', 'glm', 'deepseek', 'kimi', 'xai']) {
    const f = fixture(); const model = ['openrouter', 'nvidia', 'huggingface'].includes(kind) ? 'z-ai/glm-5' : 'model-name';
    f.configure({ kind, model }); await f.service.generate('sample', clean);
    assert.equal(f.calls[0][0], catalog().find(row => row.kind === kind).endpoint);
    const body = JSON.parse(f.calls[0][1].body); assert.equal(body.model, model); assert.equal(body.max_tokens, 1024);
    if (kind === 'openrouter') assert.deepEqual(body.provider, { allow_fallbacks: false, data_collection: 'deny' });
  }
});
test('local endpoint uses exact path and permits no-key configuration', async () => {
  const f = fixture(); f.configure({ kind: 'local', model: 'local-model', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', key: undefined });
  await f.service.generate('sample', clean);
  assert.equal(f.calls[0][0], 'http://127.0.0.1:11434/v1/chat/completions'); assert.equal(f.calls[0][1].headers.Authorization, undefined);
  assert.equal(f.service.get('sample').available, true); assert.equal(f.service.get('sample').authenticated, false);
});
test('request budget persists across service recreation and model configuration', async () => {
  const f = fixture(); f.configure({ requestBudget: 1 }); await f.service.generate('sample', clean);
  const next = new ProviderService({ store: f.store, vault: f.vault, fetchImpl: f.fetchImpl });
  next.configure({ id: 'sample', kind: 'openai', model: 'gpt-4.1' });
  await assert.rejects(next.generate('sample', clean), /PROVIDER_REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(f.calls.length, 1); assert.equal(next.get('sample').requestsUsed, 1); assert.equal(next.get('sample').observedTokens, 12);
  assert.ok(next.get('sample').reservedTokens >= 1024);
});
test('429 retries at most once with bounded Retry-After and counts both requests', async () => {
  const f = fixture(async () => json({}, 429, { 'retry-after': '0' })); f.configure();
  await assert.rejects(f.service.generate('sample', clean), /PROVIDER_RATE_LIMITED/);
  assert.equal(f.calls.length, 2); assert.equal(f.service.get('sample').state, 'rate_limited'); assert.equal(f.service.get('sample').requestsUsed, 2);
  const long = fixture(async () => json({}, 429, { 'retry-after': '120' })); long.configure();
  await assert.rejects(long.service.generate('sample', clean), /PROVIDER_RATE_LIMITED/); assert.equal(long.calls.length, 1);
});
test('abort during 429 retry wait prevents another request', async () => {
  const controller = new AbortController(); const f = fixture(async () => { setTimeout(() => controller.abort(), 10); return json({}, 429, { 'retry-after': '3' }); }); f.configure();
  await assert.rejects(f.service.generate('sample', { ...clean, signal: controller.signal }), /PROVIDER_CANCELLED/); assert.equal(f.calls.length, 1);
});
test('cancellation aborts hanging transport and pre-abort makes no request', async () => {
  const f = fixture(async () => new Promise(() => {})); f.configure(); const controller = new AbortController();
  const pending = f.service.generate('sample', { ...clean, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /PROVIDER_CANCELLED/); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.generate('sample', { ...clean, signal: controller.signal }), /PROVIDER_CANCELLED/); assert.equal(f.calls.length, 1);
});
test('timeout aborts transport without leaking the underlying exception', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => new Promise(() => {})); f.configure();
  const pending = f.service.generate('sample', clean);
  const rejection = assert.rejects(pending, /PROVIDER_TIMEOUT/);
  t.mock.timers.tick(60001); await rejection;
  assert.equal(f.calls[0][1].signal.aborted, true); assert.equal(f.service.get('sample').available, false);
});
test('underlying arbitrary error codes cannot become public error strings', async () => {
  const f = fixture(async () => { throw Object.assign(Error(KEY), { code: 'PROVIDER_PRIVATE_CREDENTIAL_VALUE' }); }); f.configure();
  await assert.rejects(f.service.generate('sample', clean), { message: 'PROVIDER_REQUEST_FAILED' });
});
test('redirects are not followed or reported as a successful model response', async () => {
  const f = fixture(async () => new Response('', { status: 307, headers: { location: 'https://other.example/credential-capture' } })); f.configure();
  await assert.rejects(f.service.generate('sample', clean), /PROVIDER_HTTP_FAILED/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].redirect, 'error'); assert.equal(f.service.get('sample').authenticated, false);
});
test('provider errors and credential echoes are sanitized and do not claim availability', async () => {
  for (const transport of [async () => { throw Error(KEY); }, async () => json({ error: { message: KEY } }, 401), async () => json(completion(KEY))]) {
    const f = fixture(transport); f.configure();
    await assert.rejects(f.service.generate('sample', clean), error => !error.message.includes(KEY));
    const row = f.service.get('sample'); assert.equal(row.available, false); assert.equal(row.lastVerified, null); assert.ok(!JSON.stringify(row).includes(KEY));
  }
});
test('tool calls, empty output, malformed output and truncation never produce false completion', async () => {
  for (const data of [{ choices: [{ message: { tool_calls: [{ function: { name: 'steal' } }], content: 'text' }, finish_reason: 'tool_calls' }] }, completion(''), { error: { message: 'error' } }, completion('x'.repeat(64001))]) {
    const f = fixture(async () => json(data)); f.configure(); await assert.rejects(f.service.generate('sample', clean)); assert.equal(f.service.get('sample').available, false);
  }
  const f = fixture(async () => json(completion('partial', 'length'))); f.configure(); assert.equal((await f.service.generate('sample', clean)).status, 'incomplete'); assert.equal(f.service.get('sample').lastVerified, null);
});
function sse(frames, chunkSize = 7) {
  const bytes = new TextEncoder().encode(frames); let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(index, index += chunkSize)); } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('bounded SSE accepts split UTF-8, CRLF, usage and DONE; callback runs only after validation', async () => {
  const frames = ': heartbeat\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"公"}}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"開"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\ndata: [DONE]\n\n';
  const f = fixture(async () => sse(frames, 1)); f.configure(); const deltas = [];
  const result = await f.service.generate('sample', { ...clean, onDelta: text => deltas.push(text) });
  assert.equal(JSON.parse(f.calls[0][1].body).stream, true); assert.equal(result.text, '公開'); assert.equal(result.usage.totalTokens, 4); assert.deepEqual(deltas, ['公開']);
});
test('SSE missing DONE, late tool calls and split credential echo are rejected without delta leakage', async () => {
  const cases = [
    'data: {"choices":[{"delta":{"content":"text"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[{"delta":{"content":"text"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: KEY.slice(0, 10) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: KEY.slice(10) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  ];
  for (const frames of cases) { const f = fixture(async () => sse(frames)); f.configure(); const deltas = []; await assert.rejects(f.service.generate('sample', { ...clean, onDelta: text => deltas.push(text) })); assert.deepEqual(deltas, []); }
});
test('oversized wire response cancels its stream', async () => {
  let cancelled = false;
  const f = fixture(async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }))); f.configure();
  await assert.rejects(f.service.generate('sample', clean), /PROVIDER_OUTPUT_LIMIT/); assert.equal(cancelled, true);
});
test('an in-flight request prevents destination removal and concurrent budget races', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; })); f.configure();
  const pending = f.service.generate('sample', clean);
  assert.throws(() => f.service.remove('sample'), /PROVIDER_BUSY/); assert.throws(() => f.configure(), /PROVIDER_BUSY/);
  await assert.rejects(f.service.generate('sample', clean), /PROVIDER_BUSY/); resolve(json()); await pending;
  assert.equal(f.calls.length, 1);
});
