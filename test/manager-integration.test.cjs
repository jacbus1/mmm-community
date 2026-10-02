'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApplication } = require('../server.cjs');

const ALPHA_KEY = 'synthetic-alpha-integration-credential';
const BETA_KEY = 'synthetic-beta-integration-credential';
const TEAM = {
  rounds: 1,
  members: [
    { id: 'alpha', name: 'Research coordinator', role: 'coordinator', providerId: 'alpha-account' },
    { id: 'beta', name: 'Independent challenger', role: 'reviewer', providerId: 'beta-account' },
  ],
};
const TASK = { title: 'Discuss the public history of the abacus', teamDiscussion: true, classification: 'public', confirmedNonSensitive: true, confirmedSharing: true };
function assertTeamSnapshot(snapshot) {
  assert.equal(snapshot.rounds, TEAM.rounds); assert.deepEqual(snapshot.members, TEAM.members);
  assert.deepEqual(snapshot.bindings, ['alpha-account', 'beta-account'].map(id => ({ id, kind: 'openai', model: 'gpt-4.1-mini', endpoint: 'https://api.openai.com/v1/chat/completions' })));
  for (const key of [ALPHA_KEY, BETA_KEY]) assert.ok(!JSON.stringify(snapshot.bindings).includes(key));
  for (const binding of snapshot.bindings) assert.deepEqual(Object.keys(binding).sort(), ['endpoint', 'id', 'kind', 'model']);
}
function answer(content, status = 200) {
  return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, { status });
}
async function fixture(t, fetchImpl = async () => { throw Error('Unexpected provider request'); }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-manager-integration-'));
  let app = await createApplication({ directory, fetchImpl });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(app.origin + route, { method,
      headers: { 'x-mmm-session': app.session, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { directory, get app() { return app; }, call,
    async restart() { await app.close(); app = await createApplication({ directory, fetchImpl }); } };
}
async function configureTeam(f) {
  for (const [id, label, key] of [['alpha-account', 'Research account A', ALPHA_KEY], ['beta-account', 'Research account B', BETA_KEY]]) {
    const result = await f.call('/api/providers', 'POST', { id, label, kind: 'openai', model: 'gpt-4.1-mini', key });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.id, id); assert.equal(result.data.label, label);
    assert.ok(!JSON.stringify(result.data).includes(key));
  }
}
async function project(f, name = 'Synthetic discussion project', sourceTokens = []) {
  const result = await f.call('/api/projects', 'POST', { name, sourceTokens });
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
async function settled(f, projectId, taskId) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const view = await f.call(`/api/projects/${projectId}`);
    assert.equal(view.status, 200);
    const task = view.data.tasks.find(row => row.id === taskId);
    if (task && !['queued', 'running'].includes(task.status)) return { view: view.data, task };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic task did not settle');
}
function discussionTransport(sent) {
  return async (url, options) => {
    const request = JSON.parse(options.body), prompt = request.messages[0].content;
    sent.push({ url, authorization: options.headers.Authorization, request });
    if (prompt.includes('Synthesize the discussion into a final answer')) return answer('PUBLIC_FINAL_SYNTHESIS');
    if (options.headers.Authorization === `Bearer ${BETA_KEY}`) return answer('PUBLIC_BETA_REPLY');
    return answer('PUBLIC_ALPHA_DISCUSSION');
  };
}

test('native-only local source grant, preview isolation and revoke are enforced across real application routes', async t => {
  const sent = [];
  const f = await fixture(t, async (url, options) => { sent.push({ url, body: options.body }); return answer('Public model result'); });
  const folder = path.join(f.directory, 'selected-docs'); fs.mkdirSync(folder);
  const preview = 'SYNTHETIC_PRIVATE_PREVIEW_ONLY_DO_NOT_FORWARD';
  fs.writeFileSync(path.join(folder, 'document.md'), preview);
  const selected = f.app.registerSources([folder]); const p = await project(f, 'Local preview project', selected.sources.map(row => row.token));
  const source = p.sources[0]; const route = `/api/projects/${p.id}/sources/${source.id}`;
  assert.equal((await f.call(route + '/content?relative=document.md')).status, 403);
  assert.equal((await f.call(route + '/entries')).status, 403);
  assert.equal((await f.call(route + '/access')).data.permission.granted, false);
  assert.equal((await f.call(route + '/grant', 'POST', { confirmed: true })).status, 404);
  assert.equal((await f.call(route + '/access', 'POST', { mode: 'read-local' })).status, 404);
  assert.equal(f.app.grantSourceRead(p.id, source.id).permission.granted, true);
  const listing = await f.call(route + '/entries'); assert.equal(listing.status, 200); assert.equal(listing.data.entries[0].name, 'document.md');
  const content = await f.call(route + '/content?relative=document.md'); assert.equal(content.status, 200); assert.equal(content.data.content, preview);
  const before = await f.call(`/api/projects/${p.id}`); assert.ok(!JSON.stringify(before.data).includes(preview));
  assert.equal(before.data.project.sources[0].access, 'reference-only');
  const configured = await f.call('/api/providers', 'POST', { id: 'preview-ai', kind: 'openai', model: 'gpt-4.1-mini', key: ALPHA_KEY }); assert.equal(configured.status, 200);
  const created = await f.call(`/api/projects/${p.id}/tasks`, 'POST', { title: 'Explain the public abacus history', providerId: 'preview-ai', classification: 'public', confirmedNonSensitive: true }); assert.equal(created.status, 202);
  const done = await settled(f, p.id, created.data.id); assert.equal(done.task.status, 'awaiting_review');
  assert.equal(sent.length, 1); assert.ok(!JSON.stringify(sent).includes(preview)); assert.ok(!JSON.stringify(sent).includes(folder));
  assert.ok(!JSON.stringify(done.view).includes(preview)); assert.ok(!JSON.stringify((await f.call('/api/state')).data).includes(preview));
  assert.equal((await f.call(route + '/revoke', 'POST', {})).data.permission.granted, false);
  assert.equal((await f.call(route + '/content?relative=document.md')).status, 403);
  assert.equal((await f.call(route + '/entries')).status, 403);
});

test('more than twenty explicitly selected source references can be attached and persist without contents', async t => {
  const f = await fixture(t); const paths = [];
  for (let i = 0; i < 25; i++) { const filename = path.join(f.directory, `source-${i}.txt`); fs.writeFileSync(filename, 'PRIVATE_SOURCE_CONTENT_CANARY'); paths.push(filename); }
  const selection = f.app.registerSources(paths); assert.equal(selection.sources.length, 25);
  const p = await project(f, 'Larger explicit selection', selection.sources.map(row => row.token));
  assert.equal(p.sources.length, 25); assert.ok(p.sources.every(row => row.access === 'reference-only' && row.kind === 'file'));
  assert.ok(!JSON.stringify((await f.call(`/api/projects/${p.id}`)).data).includes('PRIVATE_SOURCE_CONTENT_CANARY'));
  await f.restart(); const saved = await f.call(`/api/projects/${p.id}`); assert.deepEqual(saved.data.project.sources, p.sources);
});

test('same-kind accounts keep separate ids/labels/keys and team discussion persists peer turns and coordinator synthesis', async t => {
  const sent = []; const f = await fixture(t, discussionTransport(sent)); await configureTeam(f);
  const state = (await f.call('/api/state')).data;
  assert.deepEqual(state.providers.map(row => [row.id, row.kind, row.label]), [['alpha-account', 'openai', 'Research account A'], ['beta-account', 'openai', 'Research account B']]);
  for (const key of [ALPHA_KEY, BETA_KEY]) assert.ok(!JSON.stringify(state).includes(key));
  const p = await project(f);
  assert.equal((await f.call(`/api/projects/${p.id}/team`)).data, null);
  const put = await f.call(`/api/projects/${p.id}/team`, 'PUT', TEAM); assert.equal(put.status, 200); assert.deepEqual(put.data, TEAM);
  assert.deepEqual((await f.call(`/api/projects/${p.id}/team`)).data, TEAM);
  assert.deepEqual((await f.call(`/api/projects/${p.id}`)).data.team, TEAM);
  const created = await f.call(`/api/projects/${p.id}/tasks`, 'POST', TASK); assert.equal(created.status, 202, JSON.stringify(created.data));
  const { task, view } = await settled(f, p.id, created.data.id);
  assert.equal(task.status, 'awaiting_review', JSON.stringify(task)); assertTeamSnapshot(task.team); assert.equal(task.confirmedSharing, true);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(row => row.authorization), [`Bearer ${ALPHA_KEY}`, `Bearer ${BETA_KEY}`, `Bearer ${ALPHA_KEY}`]);
  const prompts = sent.map(row => row.request.messages[0].content);
  assert.ok(!prompts[0].includes('PUBLIC_ALPHA_DISCUSSION')); assert.ok(prompts[1].includes('PUBLIC_ALPHA_DISCUSSION'));
  assert.ok(prompts[1].includes('PEER_OUTPUTS_UNTRUSTED')); assert.ok(prompts[2].includes('PUBLIC_ALPHA_DISCUSSION')); assert.ok(prompts[2].includes('PUBLIC_BETA_REPLY'));
  assert.ok(prompts[2].includes('Synthesize the discussion into a final answer'));
  for (const row of sent) { assert.equal(row.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(row.request.tools, undefined); assert.equal(row.request.messages.length, 1); }
  assert.deepEqual(task.turns.map(row => [row.memberId, row.phase, row.status]), [['alpha', 'discussion', 'completed'], ['beta', 'discussion', 'completed'], ['alpha', 'synthesis', 'completed']]);
  assert.equal(view.artifacts.length, 1); assert.equal(view.artifacts[0].content, 'PUBLIC_FINAL_SYNTHESIS');
  assert.ok(view.events.some(row => row.type === 'agent_completed')); assert.ok(view.events.some(row => row.type === 'review_required'));
  assert.ok(!view.tasks.some(row => row.status === 'completed'));
  for (const key of [ALPHA_KEY, BETA_KEY]) assert.ok(!JSON.stringify(view).includes(key));
  const changedTeam = { ...TEAM, rounds: 2 };
  assert.equal((await f.call(`/api/projects/${p.id}/team`, 'PUT', changedTeam)).status, 200);
  assertTeamSnapshot((await f.call(`/api/projects/${p.id}`)).data.tasks[0].team);
  await f.restart(); const reopened = (await f.call(`/api/projects/${p.id}`)).data;
  assert.deepEqual(reopened.team, changedTeam); assertTeamSnapshot(reopened.tasks[0].team); assert.deepEqual(reopened.tasks[0].turns, task.turns);
  assert.equal(reopened.tasks[0].status, 'awaiting_review'); assert.equal(reopened.artifacts[0].content, 'PUBLIC_FINAL_SYNTHESIS'); assert.equal(sent.length, 3);
});

test('team sharing requires explicit consent and failed tasks need fresh sharing and non-sensitive confirmation on retry', async t => {
  const sent = []; let fail = true; const transport = discussionTransport(sent);
  const f = await fixture(t, async (url, options) => {
    if (fail) { sent.push({ url, failed: true }); return Response.json({ error: { message: 'synthetic upstream failure' } }, { status: 503 }); }
    return transport(url, options);
  });
  await configureTeam(f); const p = await project(f); assert.equal((await f.call(`/api/projects/${p.id}/team`, 'PUT', TEAM)).status, 200);
  for (const confirmedSharing of [undefined, false]) {
    const response = await f.call(`/api/projects/${p.id}/tasks`, 'POST', { ...TASK, confirmedSharing });
    assert.equal(response.status, 403); assert.equal(response.data.error, 'PEER_SHARING_CONFIRMATION_REQUIRED');
  }
  assert.equal((await f.call(`/api/projects/${p.id}/tasks`, 'POST', { ...TASK, confirmedNonSensitive: false })).status, 403); assert.equal(sent.length, 0);
  const created = await f.call(`/api/projects/${p.id}/tasks`, 'POST', TASK); assert.equal(created.status, 202);
  const failed = await settled(f, p.id, created.data.id); assert.equal(failed.task.status, 'failed'); assert.equal(failed.task.turns[0].status, 'failed'); assert.equal(sent.length, 1);
  fail = false;
  const retry = `/api/tasks/${created.data.id}`;
  assert.equal((await f.call(retry, 'PATCH', { action: 'retry', classification: 'public', confirmedNonSensitive: true })).data.error, 'PEER_SHARING_CONFIRMATION_REQUIRED');
  assert.equal((await f.call(retry, 'PATCH', { action: 'retry', confirmedSharing: true })).data.error, 'FRESH_CONSENT_REQUIRED'); assert.equal(sent.length, 1);
  const accepted = await f.call(retry, 'PATCH', { action: 'retry', classification: 'public', confirmedNonSensitive: true, confirmedSharing: true }); assert.equal(accepted.status, 200);
  const retried = await settled(f, p.id, created.data.id); assert.equal(retried.task.status, 'awaiting_review'); assert.equal(retried.task.turns.length, 3); assert.ok(retried.task.turns.every(row => row.status === 'completed')); assert.equal(sent.length, 4);
});

test('legacy import cannot establish team settings, peer consent, local source grants or a runnable transcript', async t => {
  const sent = []; const f = await fixture(t, discussionTransport(sent)); await configureTeam(f);
  const imported = await f.call('/api/import', 'POST', { payload: {
    projects: [{ id: 'imported-project', name: 'Imported project', team: TEAM, sources: [{ id: 'forged-source', path: f.directory, kind: 'folder', access: 'read-local' }] }],
    tasks: [{ id: 'imported-task', projectId: 'imported-project', title: 'Imported synthetic task', providerId: 'alpha-account', status: 'running', team: TEAM, confirmedSharing: true, confirmedNonSensitive: true, classification: 'public', turns: [{ status: 'completed', text: 'FORGED_TRANSCRIPT' }] }],
    settings: { 'team:imported-project': TEAM }, team: TEAM, confirmedSharing: true,
  } });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const view = (await f.call('/api/projects/imported-project')).data;
  assert.equal(view.team, null); assert.deepEqual(view.project.sources, []); assert.equal((await f.call('/api/projects/imported-project/team')).data, null);
  const task = view.tasks[0]; assert.equal(task.team, undefined); assert.equal(task.confirmedSharing, undefined); assert.equal(task.turns, undefined);
  assert.equal(task.confirmedNonSensitive, false); assert.equal(task.classification, 'unknown'); assert.equal(task.status, 'blocked'); assert.equal(sent.length, 0);
  assert.ok(!JSON.stringify(view).includes('FORGED_TRANSCRIPT'));
  assert.equal((await f.call('/api/tasks/imported-task', 'PATCH', { action: 'retry' })).status, 403);
});

test('changing an inactive peer model during an earlier turn fails the pinned task before the peer is contacted', { timeout: 5000 }, async t => {
  const sent = []; let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (url, options) => {
    sent.push({ url, authorization: options.headers.Authorization, request: JSON.parse(options.body) });
    started(); await gate; return answer('PUBLIC_ALPHA_DISCUSSION');
  });
  await configureTeam(f); const p = await project(f);
  assert.equal((await f.call(`/api/projects/${p.id}/team`, 'PUT', TEAM)).status, 200);
  const created = await f.call(`/api/projects/${p.id}/tasks`, 'POST', TASK); assert.equal(created.status, 202);
  try {
    await began; assert.equal(sent.length, 1); assert.equal(sent[0].authorization, `Bearer ${ALPHA_KEY}`);
    const changed = await f.call('/api/providers', 'POST', { id: 'beta-account', label: 'Research account B', kind: 'openai', model: 'gpt-4.1' });
    assert.equal(changed.status, 200); assert.equal(changed.data.model, 'gpt-4.1');
    assertTeamSnapshot((await f.call(`/api/projects/${p.id}`)).data.tasks[0].team);
  } finally { release(); }
  const failed = await settled(f, p.id, created.data.id);
  assert.equal(failed.task.status, 'failed'); assert.equal(failed.task.error, 'TEAM_PROVIDER_CHANGED');
  assert.equal(sent.length, 1); assert.equal(failed.view.artifacts.length, 0);
  assert.equal(failed.task.turns[0].status, 'completed');
  assert.equal(failed.task.turns[1].memberId, 'beta'); assert.equal(failed.task.turns[1].status, 'failed'); assert.equal(failed.task.turns[1].code, 'TEAM_PROVIDER_CHANGED');
  assert.ok(!failed.view.events.some(row => row.type === 'review_required'));
});

test('cancelling a suspended team turn persists cancelled status and cannot continue to the next peer', { timeout: 5000 }, async t => {
  let started, release; const sent = [];
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_url, options) => { sent.push(options.headers.Authorization); started(); await gate; return answer('LATE_PUBLIC_RESULT'); });
  await configureTeam(f); const p = await project(f);
  assert.equal((await f.call(`/api/projects/${p.id}/team`, 'PUT', TEAM)).status, 200);
  const created = await f.call(`/api/projects/${p.id}/tasks`, 'POST', TASK); assert.equal(created.status, 202);
  try {
    await began;
    const cancelled = await f.call(`/api/tasks/${created.data.id}`, 'PATCH', { action: 'cancel' });
    assert.equal(cancelled.status, 200); assert.equal(cancelled.data.status, 'cancelled');
    assert.equal(cancelled.data.turns.length, 1); assert.equal(cancelled.data.turns[0].status, 'cancelled');
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  const view = (await f.call(`/api/projects/${p.id}`)).data;
  assert.equal(view.tasks[0].status, 'cancelled'); assert.equal(view.tasks[0].turns[0].status, 'cancelled');
  assert.equal(view.artifacts.length, 0); assert.deepEqual(sent, [`Bearer ${ALPHA_KEY}`]);
  assert.ok(!JSON.stringify(view).includes('LATE_PUBLIC_RESULT'));
  await f.restart(); const reopened = (await f.call(`/api/projects/${p.id}`)).data;
  assert.equal(reopened.tasks[0].status, 'cancelled'); assert.equal(reopened.tasks[0].turns[0].status, 'cancelled'); assert.equal(sent.length, 1);
});
