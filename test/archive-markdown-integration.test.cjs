'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApplication } = require('../server.cjs');
const { Store } = require('../storage.cjs');
const { exportProject } = require('../markdown-exchange.cjs');

async function fixture(t, fetchImpl = async () => { throw new Error('Unexpected synthetic provider request'); }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-archive-markdown-test-'));
  let app = await createApplication({ directory, fetchImpl });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, get app() { return app; },
    async restart() { await app.close(); app = await createApplication({ directory, fetchImpl }); },
    async call(route, method = 'GET', body) {
      const response = await fetch(app.origin + route, { method, headers: { 'x-mmm-session': app.session, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    }
  };
}
async function project(f, name = 'Synthetic project') { const result = await f.call('/api/projects', 'POST', { name }); assert.equal(result.status, 201); return result.data; }
async function localTask(f, p, title = 'Local task') { const result = await f.call(`/api/projects/${p.id}/tasks`, 'POST', { title, localOnly: true }); assert.equal(result.status, 201); return result.data; }
function markdown() { return exportProject({ project: { id: 'informational-project', name: 'Proposal source' }, tasks: [{ title: 'First proposal', status: 'queued' }, { title: 'Second proposal', status: 'completed' }] }); }
async function waitFor(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Synthetic operation did not reach expected state'); }

test('archive changes visibility, retains conversation/history/artifacts, survives restart and restores', async t => {
  const f = await fixture(t), p = await project(f), task = await localTask(f, p);
  await f.call(`/api/projects/${p.id}/messages`, 'POST', { content: 'Synthetic retained local note' });
  await f.call(`/api/tasks/${task.id}`, 'PATCH', { action: 'submit', content: 'Synthetic saved evidence' });
  await f.call(`/api/tasks/${task.id}`, 'PATCH', { action: 'approve' });
  const before = (await f.call(`/api/projects/${p.id}`)).data;
  assert.equal((await f.call(`/api/projects/${p.id}/archive`, 'POST', { archived: true })).status, 200);
  let state = (await f.call('/api/state')).data;
  assert.equal(state.projects.some(row => row.id === p.id), false); assert.equal(state.archivedProjects.some(row => row.id === p.id), true);
  await f.restart();
  const after = (await f.call(`/api/projects/${p.id}`)).data;
  assert.equal(after.project.archived, true); assert.equal(after.project.conversationId, before.project.conversationId);
  for (const field of ['messages', 'tasks', 'artifacts']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.at(-1).type, 'project_archived');
  state = (await f.call('/api/state')).data; assert.equal(state.archivedProjects[0].id, p.id);
  assert.equal((await f.call(`/api/projects/${p.id}/archive`, 'POST', { archived: false })).status, 200);
  state = (await f.call('/api/state')).data; assert.equal(state.projects[0].id, p.id); assert.equal(state.archivedProjects.length, 0);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.archived, false);
  await localTask(f, p, 'Restored project task');
});

test('archived projects reject new tasks, retries, team edits, notes and Markdown imports', async t => {
  const f = await fixture(t), p = await project(f), task = await localTask(f, p);
  await f.call(`/api/tasks/${task.id}`, 'PATCH', { action: 'pause' });
  await f.call(`/api/projects/${p.id}/archive`, 'POST', { archived: true });
  const before = (await f.call(`/api/projects/${p.id}`)).data;
  for (const [route, method, body] of [
    [`/api/projects/${p.id}/tasks`, 'POST', { title: 'Forbidden', localOnly: true }],
    [`/api/tasks/${task.id}`, 'PATCH', { action: 'retry' }],
    [`/api/projects/${p.id}/team`, 'PUT', { rounds: 1, members: [] }],
    [`/api/projects/${p.id}/messages`, 'POST', { content: 'Forbidden note' }],
    [`/api/projects/${p.id}/markdown/import`, 'POST', { content: markdown(), confirmLocalOnly: true }]
  ]) { const result = await f.call(route, method, body); assert.equal(result.status, 409); assert.equal(result.data.error, 'PROJECT_ARCHIVED'); }
  assert.deepEqual((await f.call(`/api/projects/${p.id}`)).data, before);
  assert.equal((await f.call(`/api/projects/${p.id}/markdown`)).status, 200);
  assert.equal((await f.call(`/api/projects/${p.id}/markdown/preview`, 'POST', { content: markdown() })).status, 200);
});

test('an active synthetic worker blocks archive until it is cancelled', async t => {
  let started = false;
  const f = await fixture(t, async (_url, options) => { started = true; return new Promise((_resolve, reject) => { const stop = () => reject(new Error('Synthetic cancellation')); options.signal.addEventListener('abort', stop, { once: true }); if (options.signal.aborted) stop(); }); });
  const p = await project(f);
  assert.equal((await f.call('/api/providers', 'POST', { id: 'archive-worker', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-archive-worker-key' })).status, 200);
  const task = (await f.call(`/api/projects/${p.id}/tasks`, 'POST', { title: 'Public discussion', providerId: 'archive-worker', classification: 'public', confirmedNonSensitive: true })).data;
  await waitFor(() => started);
  const blocked = await f.call(`/api/projects/${p.id}/archive`, 'POST', { archived: true });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error, 'STOP_TASKS_BEFORE_ARCHIVE');
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.project.archived, false);
  assert.equal((await f.call(`/api/tasks/${task.id}`, 'PATCH', { action: 'cancel' })).status, 200);
  await waitFor(async () => (await f.call(`/api/projects/${p.id}/archive`, 'POST', { archived: true })).status === 200);
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.tasks[0].status, 'cancelled');
});

test('Markdown GET exports metadata, never notes, provider keys, source paths or result content', async t => {
  const f = await fixture(t), source = path.join(f.directory, 'SYNTHETIC_SOURCE.txt');
  fs.writeFileSync(source, 'SYNTHETIC_SOURCE_CONTENT');
  const selected = f.app.registerSources([source]);
  const p = (await f.call('/api/projects', 'POST', { name: 'Export project', sourceTokens: selected.sources.map(row => row.token) })).data;
  await f.call('/api/providers', 'POST', { id: 'export-provider', kind: 'openai', model: 'gpt-4.1-mini', key: 'synthetic-key-never-export' });
  await f.call(`/api/projects/${p.id}/messages`, 'POST', { content: 'SYNTHETIC_PRIVATE_NOTE' });
  const task = (await f.call(`/api/projects/${p.id}/tasks`, 'POST', { title: 'Visible task title', description: 'SYNTHETIC_PRIVATE_DESCRIPTION', localOnly: true })).data;
  await f.call(`/api/tasks/${task.id}`, 'PATCH', { action: 'submit', content: 'SYNTHETIC_PRIVATE_ARTIFACT' });
  const exported = await f.call(`/api/projects/${p.id}/markdown`);
  assert.equal(exported.status, 200); assert.equal(exported.data.name, 'MMM-project.md');
  assert.match(exported.data.content, /Visible task title/); assert.match(exported.data.content, /awaiting_review/);
  for (const secret of ['SYNTHETIC_SOURCE', 'SYNTHETIC_PRIVATE', 'synthetic-key-never-export', 'export-provider', f.directory, source]) assert.equal(exported.data.content.includes(secret), false, secret);
});

test('preview is read-only; confirmed import is local, new-ID, target-scoped and persistently idempotent', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('Unexpected model call'); }), p = await project(f), existing = await localTask(f, p, 'First proposal');
  const content = markdown(), route = `/api/projects/${p.id}/markdown`;
  const before = (await f.call(`/api/projects/${p.id}`)).data;
  const preview = await f.call(route + '/preview', 'POST', { content });
  assert.equal(preview.status, 200); assert.equal(preview.data.tasks.length, 2); assert.deepEqual(preview.data.warnings, []);
  assert.deepEqual((await f.call(`/api/projects/${p.id}`)).data, before);
  for (const confirmLocalOnly of [undefined, false, 'true']) {
    const result = await f.call(route + '/import', 'POST', { content, confirmLocalOnly });
    assert.equal(result.status, 403); assert.equal(result.data.error, 'LOCAL_IMPORT_CONFIRMATION_REQUIRED');
  }
  assert.deepEqual((await f.call(`/api/projects/${p.id}`)).data, before);
  const first = (await f.call(route + '/import', 'POST', { content, confirmLocalOnly: true })).data;
  assert.equal(first.duplicate, false); assert.equal(first.count, 2);
  for (const task of first.tasks) { assert.notEqual(task.id, existing.id); assert.equal(task.projectId, p.id); assert.equal(task.providerId, ''); assert.equal(task.classification, 'local'); assert.equal(task.confirmedNonSensitive, false); assert.equal(task.status, 'queued'); assert.equal(task.team, undefined); }
  assert.equal(new Set(first.tasks.map(task => task.id)).size, 2);
  const after = (await f.call(`/api/projects/${p.id}`)).data;
  assert.deepEqual(after.tasks.find(task => task.id === existing.id), existing); assert.equal(after.tasks.length, 3); assert.deepEqual(after.messages, before.messages);
  await f.restart();
  const duplicate = (await f.call(route + '/import', 'POST', { content, confirmLocalOnly: true })).data;
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.tasks.map(task => task.id), first.tasks.map(task => task.id));
  assert.equal((await f.call(`/api/projects/${p.id}`)).data.tasks.length, 3);
  const other = await project(f, 'Another target');
  const second = (await f.call(`/api/projects/${other.id}/markdown/import`, 'POST', { content, confirmLocalOnly: true })).data;
  assert.equal(second.duplicate, false); assert.ok(second.tasks.every(task => task.projectId === other.id && !first.tasks.some(prior => prior.id === task.id)));
  assert.equal(calls, 0);
});

test('invalid batch cannot partially import or consume an idempotency receipt; SQL failure rolls back too', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-markdown-batch-test-')), store = new Store({ directory });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const p = store.createProject({ name: 'Atomic proposal test' }), digest = 'a'.repeat(64);
  const existing = store.createTask(p.id, { title: 'Retained existing task' });
  assert.throws(() => store.importLocalTaskProposals(p.id, [{ title: 'Valid first' }, { title: '' }], digest));
  assert.deepEqual(store.listTasks(p.id), [existing]);
  assert.throws(() => store.importLocalTaskProposals(p.id, [{ title: 'Valid first' }, { title: 'Injected', providerId: 'forged' }], digest));
  assert.deepEqual(store.listTasks(p.id), [existing]);
  store.db.exec("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON tasks WHEN json_extract(NEW.data, '$.title') = 'Fail second' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => store.importLocalTaskProposals(p.id, [{ title: 'Inserted then rolled back' }, { title: 'Fail second' }], digest));
  assert.deepEqual(store.listTasks(p.id), [existing]);
  store.db.exec('DROP TRIGGER synthetic_import_failure');
  const valid = store.importLocalTaskProposals(p.id, [{ title: 'Valid first' }, { title: 'Valid second' }], digest);
  assert.equal(valid.duplicate, false); assert.equal(valid.count, 2); assert.equal(store.listTasks(p.id).length, 3);
  assert.equal(store.importLocalTaskProposals(p.id, [{ title: 'Not another task' }], digest).duplicate, true);
});

test('logo response preserves exact packaged PNG bytes and rejects cross-origin loading', async t => {
  const f = await fixture(t), expected = fs.readFileSync(path.join(__dirname, '..', 'ui', 'logo.png'));
  const response = await fetch(f.app.origin + '/logo.png'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^image\/png/);
  const actual = Buffer.from(await response.arrayBuffer()), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(actual.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); assert.equal(hash(actual), hash(expected));
  assert.equal((await fetch(f.app.origin + '/logo.png', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await fetch(f.app.origin + '/logo.png', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});
