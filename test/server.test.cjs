'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../server.cjs');
const { safeEqual } = require('../security.cjs');
async function fixture(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-public-test-'));
  const app = await createApplication({ directory, fetchImpl });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (url, method = 'GET', body) => { const response = await fetch(app.origin + url, { method, headers: { 'x-mmm-session': app.session, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  return { app, directory, call };
}
test('session required, cross origin rejected, malformed UTF8 capability does not crash', async t => {
  const { app, call } = await fixture(t);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  assert.equal((await fetch(app.origin + '/api/state', { headers: { 'x-mmm-session': app.session, Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal(safeEqual('é'.repeat(43), app.session), false);
  assert.equal((await call('/api/projects/%')).status, 400);
  assert.equal((await call('/api/state')).status, 200);
  assert.equal((await call('/.env')).status, 404);
  assert.equal((await call('/api/antigravity')).status, 404);
});
test('projects attach only native selected references; selections never enter model requests', async t => {
  const sent = [];
  const { app, directory, call } = await fixture(t, async (_url, options) => {
    sent.push(options.body);
    return Response.json({ choices: [{ message: { content: 'Public output' }, finish_reason: 'stop' }] });
  });
  const source = path.join(directory, 'SYNTHETIC_PRIVATE_SOURCE.txt');
  fs.writeFileSync(source, 'SYNTHETIC_FILE_CONTENT_MUST_NEVER_LEAVE');
  assert.equal((await call('/api/projects', 'POST', { name: 'Forged path', sources: [{ path: source }] })).status, 403);
  assert.notEqual((await call('/api/projects', 'POST', { name: 'Forged token', sourceTokens: ['forged-source-token'] })).status, 201);
  assert.equal((await call('/api/sources/register', 'POST', { paths: [source] })).status, 404);
  const selection = app.registerSources([source]);
  const project = (await call('/api/projects', 'POST', { name: 'Local source project', sourceTokens: selection.sources.map(item => item.token) })).data;
  assert.equal(project.sources[0].path, fs.realpathSync(source));
  assert.equal(project.sources[0].access, 'reference-only');
  assert.notEqual((await call('/api/projects', 'POST', { name: 'Reused token', sourceTokens: selection.sources.map(item => item.token) })).status, 201);
  await call('/api/providers', 'POST', { id: 'source-test', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-source-key' });
  await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Review a public text', providerId: 'source-test', classification: 'public', confirmedNonSensitive: true });
  for (let i = 0; i < 40 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes('SYNTHETIC_PRIVATE_SOURCE'));
  assert.ok(!sent[0].includes('SYNTHETIC_FILE_CONTENT'));
  assert.ok(!sent[0].includes(directory));
  const reopened = await createApplication({ directory });
  try {
    const response = await fetch(`${reopened.origin}/api/projects/${project.id}`, { headers: { 'x-mmm-session': reopened.session } });
    assert.deepEqual((await response.json()).project.sources, project.sources);
  } finally { await reopened.close(); }
});
test('offline project, notes, local task, result and acceptance survive restart', async t => {
  const { directory, call } = await fixture(t);
  const project = (await call('/api/projects', 'POST', { name: 'Synthetic project' })).data;
  await call(`/api/projects/${project.id}/messages`, 'POST', { content: 'Private local note is not sent to a provider.' });
  const task = (await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Offline task', localOnly: true })).data;
  assert.equal(task.status, 'queued');
  assert.equal((await call(`/api/tasks/${task.id}`, 'PATCH', { action: 'approve' })).status, 409);
  assert.equal((await call(`/api/tasks/${task.id}`, 'PATCH', { action: 'submit', content: 'Local evidence' })).data.status, 'awaiting_review');
  assert.equal((await call(`/api/tasks/${task.id}`, 'PATCH', { action: 'approve' })).data.status, 'completed');
  const other = await createApplication({ directory });
  try { const response = await fetch(`${other.origin}/api/projects/${project.id}`, { headers: { 'x-mmm-session': other.session } }); const saved = await response.json(); assert.equal(saved.project.conversationId, project.conversationId); assert.equal(saved.messages.length, 1); assert.equal(saved.tasks[0].status, 'completed'); }
  finally { await other.close(); }
});
test('AI does not succeed without connection or leak notes, provider key or body', async t => {
  const sent = [];
  const { call } = await fixture(t, async (url, options) => { sent.push({ url, options }); return Response.json({ choices: [{ message: { content: 'Public research result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }); });
  const project = (await call('/api/projects', 'POST', { name: 'Synthetic project' })).data;
  await call(`/api/projects/${project.id}/messages`, 'POST', { content: 'Synthetic private note NEVER-FORWARD' });
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Research' })).status, 409);
  const key = 'synthetic-provider-key-value';
  const configured = await call('/api/providers', 'POST', { id: 'test', kind: 'openai', model: 'gpt-4.1-mini', key });
  assert.equal(configured.status, 200); assert.ok(!JSON.stringify(configured.data).includes(key));
  assert.equal((await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Research', providerId: 'test', classification: 'private', confirmedNonSensitive: true })).status, 403);
  const task = (await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Public research', providerId: 'test', classification: 'public', confirmedNonSensitive: true })).data;
  let view;
  for (let i = 0; i < 50; i++) { view = (await call(`/api/projects/${project.id}`)).data; if (view.tasks[0]?.status !== 'queued' && view.tasks[0]?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(view.tasks[0].id, task.id); assert.equal(view.tasks[0].status, 'awaiting_review'); assert.equal(view.artifacts.length, 1);
  assert.equal(sent.length, 1); assert.ok(!sent[0].options.body.includes('NEVER-FORWARD'));
  assert.ok(!JSON.stringify((await call('/api/state')).data).includes(key));
});
test('oversized request rejected and storage disappearance fails closed', async t => {
  const { app, directory, call } = await fixture(t);
  assert.equal((await call('/api/projects', 'POST', { name: 'x'.repeat(300000) })).status, 413);
  const moved = directory + '-detached'; fs.renameSync(directory, moved);
  try { assert.equal((await call('/api/state')).status, 503); assert.equal(fs.existsSync(directory), false); }
  finally { fs.renameSync(moved, directory); }
  assert.equal((await call('/api/state')).status, 200);
});
test('untrusted legacy tasks cannot import authorization; retry requires fresh explicit consent', async t => {
  const sent = [];
  const { call, app } = await fixture(t, async (_url, options) => { sent.push(options); return Response.json({ choices: [{ message: { content: 'Synthetic public output' }, finish_reason: 'stop' }] }); });
  await call('/api/providers', 'POST', { id: 'test', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-import-key' });
  const imported = await call('/api/import', 'POST', { payload: { projects: [{ id: 'legacy-project', name: 'Synthetic legacy' }], tasks: [{ id: 'legacy-task', projectId: 'legacy-project', title: 'Review imported text', description: 'Synthetic internal planning note', providerId: 'test', status: 'running', classification: 'public', confirmedNonSensitive: true }] } });
  assert.equal(imported.status, 200);
  const task = (await call('/api/projects/legacy-project')).data.tasks[0];
  assert.equal(task.confirmedNonSensitive, false); assert.equal(task.classification, 'unknown'); assert.equal(task.status, 'blocked');
  assert.equal((await call('/api/tasks/legacy-task', 'PATCH', { action: 'retry' })).status, 403); assert.equal(sent.length, 0);
  assert.equal((await call('/api/tasks/legacy-task', 'PATCH', { action: 'retry', confirmedNonSensitive: true, classification: 'non_sensitive' })).status, 200);
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal((await fetch(app.origin + '/app.js', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});
test('truncated provider result is saved as partial evidence but cannot be approved', async t => {
  const { call } = await fixture(t, async () => Response.json({ choices: [{ message: { content: 'Partial synthetic answer' }, finish_reason: 'length' }] }));
  await call('/api/providers', 'POST', { id: 'partial', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-partial-key' });
  const project = (await call('/api/projects', 'POST', { name: 'Partial response regression' })).data;
  const task = (await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Public research', providerId: 'partial', classification: 'public', confirmedNonSensitive: true })).data;
  let view;
  for (let attempt = 0; attempt < 100; attempt++) {
    view = (await call(`/api/projects/${project.id}`)).data;
    if (!['queued', 'running'].includes(view.tasks[0]?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(view.tasks[0].status, 'blocked');
  assert.equal(view.tasks[0].blockedReason, 'PROVIDER_INCOMPLETE');
  assert.equal(view.artifacts.length, 1);
  assert.equal(view.artifacts[0].content, 'Partial synthetic answer');
  assert.ok(view.events.some(event => event.type === 'worker_incomplete'));
  assert.ok(!view.events.some(event => event.type === 'review_required'));
  assert.equal((await call(`/api/tasks/${task.id}`, 'PATCH', { action: 'approve', acceptanceEvidence: 'Attempted approval of incomplete output' })).status, 409);
});
test('storage migration preserves session-only provider keys without a plaintext file', async t => {
  const sent = [];
  const { app, directory, call } = await fixture(t, async (_url, options) => {
    sent.push(options.headers.Authorization);
    return Response.json({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] });
  });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-public-migrate-test-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const key = 'synthetic-session-migration-key';
  assert.equal((await call('/api/providers', 'POST', { id: 'memory', kind: 'openai', model: 'gpt-4.1-mini', key })).status, 200);
  assert.equal((await call('/api/state')).data.storage.credentials.persistent, false);
  await app.migrate(target);
  const state = (await call('/api/state')).data;
  assert.equal(state.storage.directory, target);
  assert.equal(state.providers[0].hasKey, true);
  assert.ok(!JSON.stringify(state).includes(key));
  assert.equal((await call('/api/providers/memory/test', 'POST', { confirmCost: true })).status, 200);
  assert.deepEqual(sent, [`Bearer ${key}`]);
  assert.equal(fs.existsSync(path.join(directory, 'credentials.enc.json')), false);
  assert.equal(fs.existsSync(path.join(target, 'credentials.enc.json')), false);
});
test('active provider connection test blocks migration until it finishes', async t => {
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { app, directory, call } = await fixture(t, async () => {
    started(); await gate;
    return Response.json({ choices: [{ message: { content: 'READY' }, finish_reason: 'stop' }] });
  });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-public-active-test-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  await call('/api/providers', 'POST', { id: 'active', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-active-test-key' });
  const pending = call('/api/providers/active/test', 'POST', { confirmCost: true });
  await began;
  try {
    await assert.rejects(app.migrate(target), error => error.code === 'STOP_TASKS_BEFORE_MIGRATION');
    assert.equal((await call('/api/state')).data.storage.directory, directory);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  await app.migrate(target);
  assert.equal((await call('/api/state')).data.storage.directory, target);
});

test('existing projects append native sources with dedupe, separate read permission and no model egress', async t => {
  const sent = [];
  const { app, directory, call } = await fixture(t, async (_url, options) => { sent.push(options.body); return Response.json({ choices: [{ message: { content: 'Public response' }, finish_reason: 'stop' }] }); });
  const file = path.join(directory, 'SYNTHETIC_SOURCE_FILE.txt'), folder = path.join(directory, 'SYNTHETIC_SOURCE_FOLDER');
  fs.writeFileSync(file, 'SYNTHETIC_SOURCE_CONTENT_MUST_NOT_LEAVE'); fs.mkdirSync(folder);
  const project = (await call('/api/projects', 'POST', { name: 'Existing project' })).data;
  const selection = app.registerSources([file, folder]), tokens = selection.sources.map(source => source.token);
  const attached = await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: tokens });
  assert.equal(attached.status, 200); assert.equal(attached.data.sources.length, 2); assert.equal(attached.data.conversationId, project.conversationId);
  const source = attached.data.sources.find(row => row.kind === 'file'); assert.equal(source.access, 'reference-only');
  assert.equal((await call(`/api/projects/${project.id}/sources/${source.id}/content`)).status, 403);
  assert.equal((await call(`/api/projects/${project.id}/sources/${source.id}/access`)).data.permission.granted, false);
  app.grantSourceRead(project.id, source.id);
  const second = app.registerSources([file]);
  const deduped = await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: second.sources.map(row => row.token) });
  assert.equal(deduped.status, 200); assert.deepEqual(deduped.data.sources, attached.data.sources);
  assert.equal((await call(`/api/projects/${project.id}/sources/${source.id}/access`)).data.permission.granted, true);
  assert.notEqual((await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: tokens })).status, 200);
  assert.notEqual((await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: second.sources.map(row => row.token) })).status, 200);
  await call('/api/providers', 'POST', { id: 'append-test', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-append-key' });
  await call(`/api/projects/${project.id}/tasks`, 'POST', { title: 'Public text analysis', providerId: 'append-test', classification: 'public', confirmedNonSensitive: true });
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  for (const value of ['SYNTHETIC_SOURCE', file, folder, directory]) assert.equal(sent[0].includes(value), false);
});

test('source append rejects forged paths, permissions, changed files and partial batches; failed selection is not consumed', async t => {
  const { app, directory, call } = await fixture(t);
  const project = (await call('/api/projects', 'POST', { name: 'Safe source append' })).data;
  const route = `/api/projects/${project.id}/sources`, file = path.join(directory, 'synthetic.txt'), another = path.join(directory, 'another.txt');
  fs.writeFileSync(file, 'Synthetic'); fs.writeFileSync(another, 'Synthetic second');
  const selection = app.registerSources([file]), token = selection.sources[0].token;
  for (const body of [{ sources: [{ path: file }] }, { sourcePaths: [file] }, { sourceTokens: [token], read: true }, { sourceTokens: [token], files: [] }]) assert.equal((await call(route, 'POST', body)).status, 403);
  for (const tokens of [[], ['forged'], [token, token], Array.from({ length: 101 }, () => token), [token, 'a'.repeat(43)]]) assert.equal((await call(route, 'POST', { sourceTokens: tokens })).status, 400);
  assert.equal((await call(`/api/projects/${project.id}`)).data.project.sources.length, 0);
  assert.equal((await call(route, 'POST', { sourceTokens: [token] })).status, 200);
  const changed = app.registerSources([another]); fs.renameSync(another, another + '.old'); fs.writeFileSync(another, 'Replacement file');
  assert.equal((await call(route, 'POST', { sourceTokens: changed.sources.map(row => row.token) })).data.error, 'SOURCE_TARGET_CHANGED');
  assert.equal((await call(`/api/projects/${project.id}`)).data.project.sources.length, 1);
  assert.equal((await fetch(app.origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceTokens: [] }) })).status, 401);
});

test('archived or missing project cannot consume an existing native source token', async t => {
  const { app, directory, call } = await fixture(t);
  const project = (await call('/api/projects', 'POST', { name: 'Archive source append' })).data;
  const file = path.join(directory, 'archived-synthetic.txt'); fs.writeFileSync(file, 'Synthetic');
  const tokens = app.registerSources([file]).sources.map(row => row.token);
  assert.equal((await call('/api/projects/missing-project/sources', 'POST', { sourceTokens: tokens })).status, 404);
  await call(`/api/projects/${project.id}/archive`, 'POST', { archived: true });
  assert.equal((await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: tokens })).status, 409);
  await call(`/api/projects/${project.id}/archive`, 'POST', { archived: false });
  assert.equal((await call(`/api/projects/${project.id}/sources`, 'POST', { sourceTokens: tokens })).status, 200);
});
