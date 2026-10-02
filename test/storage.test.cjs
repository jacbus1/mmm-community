'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../storage.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-store-test-'));
  const directory = path.join(base, 'storage'); fs.mkdirSync(directory);
  const stores = [];
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } fs.rmSync(base, { recursive: true, force: true }); });
  const open = (selected = directory) => { const store = new Store({ directory: selected }); stores.push(store); return store; };
  return { base, directory, open, stores };
}

test('source references are local metadata, atomic with project creation and survive restart/migration', t => {
  const f = fixture(t), store = f.open();
  const sources = [{ id: 'source-one', name: 'Synthetic source.txt', path: path.join(f.base, 'not-read.txt'), kind: 'file', access: 'reference-only' }];
  const project = store.createProject({ name: 'With local source', sources });
  assert.deepEqual(project.sources, sources);
  assert.equal(fs.existsSync(sources[0].path), false); // Store does not open/create a source.
  assert.throws(() => store.createProject({ name: 'Invalid', sources: [{ ...sources[0], access: 'read-write' }] }), /INVALID_PROJECT_SOURCES/);
  assert.throws(() => store.createProject({ name: 'Duplicate', sources: [sources[0], sources[0]] }), /DUPLICATE_PROJECT_SOURCE/);
  assert.equal(store.listProjects().length, 1);
  store.close(); const reopened = f.open();
  assert.deepEqual(reopened.getProject(project.id), project);
  const target = path.join(f.base, 'migration'); fs.mkdirSync(target);
  const migrated = reopened.migrate(target); f.stores.push(migrated);
  assert.deepEqual(migrated.getProject(project.id).sources, sources);
});

test('project conversations, messages, tasks, settings and evidence survive reopen', t => {
  const f = fixture(t), store = f.open();
  const project = store.createProject({ id: 'p1', name: "Project '); DROP TABLE projects;--" });
  const message = store.addMessage(project.id, { role: 'user', content: 'Synthetic request with Unicode 中文', id: 'm1' });
  const task = store.createTask(project.id, { id: 't1', title: 'Draft', description: 'Only synthetic content', providerId: 'fake-provider', classification: 'non-sensitive', confirmedNonSensitive: true });
  store.addEvent(project.id, { type: 'queued', taskId: task.id, detail: { source: 'test' } });
  const artifact = store.addArtifact(project.id, { taskId: task.id, name: '../../metadata-only.md', content: 'Synthetic output' });
  store.updateTask(task.id, { status: 'completed', acceptanceEvidence: 'Verified synthetic output', usage: { inputTokens: 1 } });
  store.setSetting('preferences', { language: 'en' });
  assert.equal(store.getSetting('absent'), null);
  assert.equal(store.checkHealth().ok, true);
  store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getProject('p1'), project);
  assert.equal(reopened.listProjects().length, 1);
  assert.equal(reopened.listMessages('p1')[0].conversationId, project.conversationId);
  assert.deepEqual(reopened.listMessages('p1')[0], message);
  assert.equal(reopened.getTask('t1').status, 'completed');
  assert.equal(reopened.getTask('t1').providerId, 'fake-provider');
  assert.equal(reopened.getTask('t1').confirmedNonSensitive, true);
  assert.deepEqual(reopened.getTask('t1').artifactIds, [artifact.id]);
  assert.deepEqual(reopened.getTask('t1').usage, { inputTokens: 1 });
  assert.deepEqual(reopened.listEvents('p1')[0].detail, { source: 'test' });
  assert.equal(reopened.listArtifacts('p1')[0].content, 'Synthetic output');
  assert.deepEqual(reopened.getSetting('preferences'), { language: 'en' });
  assert.equal(fs.existsSync(path.join(f.base, 'metadata-only.md')), false);
});

test('append project sources is atomic, preserves existing IDs and conversations, and survives restart', t => {
  const f = fixture(t), store = f.open();
  const source = (id, name) => ({ id, name, path: path.join(f.base, name), kind: 'file', access: 'reference-only' });
  const first = source('append-first', 'first.txt'), second = source('append-second', 'second.txt');
  const project = store.createProject({ name: 'Append source project', sources: [first] });
  const updated = store.addProjectSources(project.id, [{ ...first, id: 'reselected-first' }, second]);
  assert.equal(updated.conversationId, project.conversationId); assert.deepEqual(updated.sources, [first, second]);
  assert.deepEqual(store.addProjectSources(project.id, [{ ...second, id: 'reselected-second' }]), updated);
  assert.equal(fs.existsSync(first.path), false); // Metadata operation does not open sources.
  assert.throws(() => store.addProjectSources(project.id, [source('valid-third', 'third.txt'), { ...second, path: 'relative' }]), /INVALID_PROJECT_SOURCES/);
  assert.deepEqual(store.getProject(project.id), updated);
  store.createProject({ name: 'Other project', sources: [source('global-collision', 'other.txt')] });
  assert.throws(() => store.addProjectSources(project.id, [source('valid-third', 'third.txt'), source('global-collision', 'collision.txt')]));
  assert.deepEqual(store.getProject(project.id), updated); // First INSERT rolled back.
  store.close(); const reopened = f.open(); assert.deepEqual(reopened.getProject(project.id), updated);
});

test('source append enforces batch/total limits without counting reselected paths twice', t => {
  const f = fixture(t), store = f.open();
  const sources = Array.from({ length: 1000 }, (_, index) => ({ id: `limit-source-${index}`, name: `${index}.txt`, path: path.join(f.base, `${index}.txt`), kind: 'file', access: 'reference-only' }));
  const project = store.createProject({ name: 'Source limit', sources });
  assert.equal(store.addProjectSources(project.id, [{ ...sources[0], id: 'reselected' }]).sources.length, 1000);
  assert.throws(() => store.addProjectSources(project.id, [{ ...sources[0], id: 'over-limit', path: path.join(f.base, 'new.txt') }]), /PROJECT_SOURCE_LIMIT/);
  for (const batch of [[], sources.slice(0, 101), [{ ...sources[0], access: 'read-write' }]]) assert.throws(() => store.addProjectSources(project.id, batch), /INVALID_PROJECT_SOURCES/);
  assert.deepEqual(store.getProject(project.id), project);
});

test('completion needs both task-linked artifact and meaningful acceptance evidence', t => {
  const store = fixture(t).open(), project = store.createProject({ name: 'Test' });
  const task = store.createTask(project.id, { title: 'Complete only after review' });
  assert.throws(() => store.updateTask(task.id, { status: 'completed' }), /COMPLETION_EVIDENCE_REQUIRED/);
  assert.throws(() => store.updateTask(task.id, { status: 'completed', acceptanceEvidence: 'Checked' }), /COMPLETION_EVIDENCE_REQUIRED/);
  store.addArtifact(project.id, { name: 'unlinked.txt', content: 'Not task evidence' });
  assert.throws(() => store.updateTask(task.id, { status: 'completed', acceptanceEvidence: 'Checked' }), /COMPLETION_EVIDENCE_REQUIRED/);
  store.addArtifact(project.id, { taskId: task.id, name: 'output.txt', content: 'Task evidence' });
  assert.throws(() => store.updateTask(task.id, { status: 'completed', acceptanceEvidence: {} }), /COMPLETION_EVIDENCE_REQUIRED/);
  const complete = store.updateTask(task.id, { status: 'completed', acceptanceEvidence: { summary: 'Reviewed the artifact' } });
  assert.equal(complete.status, 'completed');
  assert.throws(() => store.updateTask(task.id, { acceptanceEvidence: '' }), /COMPLETION_EVIDENCE_REQUIRED/);
  assert.equal(store.getTask(task.id).status, 'completed');
});

test('restart blocks running work and never replays it', t => {
  const f = fixture(t), store = f.open(), project = store.createProject({ name: 'Recovery' });
  const running = store.createTask(project.id, { title: 'Interrupted' });
  const queued = store.createTask(project.id, { title: 'Queued' });
  store.updateTask(running.id, { status: 'running' }); store.close();
  const reopened = f.open();
  assert.equal(reopened.getTask(running.id).status, 'blocked');
  assert.equal(reopened.getTask(running.id).blockedReason, 'interrupted_restart');
  assert.equal(reopened.getTask(queued.id).status, 'queued');
  assert.equal(reopened.listEvents(project.id).length, 0);
});

test('project relationships and immutable identity reject cross-project writes', t => {
  const store = fixture(t).open(), p1 = store.createProject({ name: 'One' }), p2 = store.createProject({ name: 'Two' });
  const task = store.createTask(p1.id, { title: 'Owned by one' });
  assert.throws(() => store.addMessage('unknown', { role: 'user', content: 'No' }), /PROJECT_NOT_FOUND/);
  assert.throws(() => store.addArtifact(p2.id, { taskId: task.id, name: 'No', content: 'No' }), /TASK_PROJECT_MISMATCH/);
  assert.throws(() => store.addEvent(p2.id, { taskId: task.id, type: 'wrong', detail: '' }), /TASK_PROJECT_MISMATCH/);
  assert.throws(() => store.updateTask(task.id, { projectId: p2.id }), /INVALID_TASK_PATCH/);
  assert.throws(() => store.updateTask(task.id, { status: 'invented' }), /INVALID_TASK_STATUS/);
  assert.throws(() => store.addMessage(p1.id, { role: 'invented', content: 'No' }), /INVALID_ROLE/);
  assert.equal(store.listArtifacts(p2.id).length, 0);
  assert.equal(store.listTasks(p1.id)[0].id, task.id);
  assert.equal(store.listTasks(p2.id).length, 0);
  store.updateTask(task.id, { error: 'Retryable failure', blockedReason: 'Waiting' });
  assert.equal(store.updateTask(task.id, { error: null, blockedReason: null }).error, '');
});

test('directory and all SQLite sidecars remain private', t => {
  const f = fixture(t), store = f.open(); store.createProject({ name: 'Private' });
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(f.directory)) assert.equal(fs.statSync(path.join(f.directory, name)).mode & 0o777, 0o600, name);
});

test('missing paths are never created and unsafe files are rejected', t => {
  const f = fixture(t), missing = path.join(f.base, 'absent-mount', 'storage');
  assert.throws(() => new Store({ directory: missing }), /STORAGE_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(f.base, 'absent-mount')), false);
  assert.throws(() => new Store({ directory: 'relative' }), /EXISTING_STORAGE_DIRECTORY_REQUIRED/);
  assert.throws(() => new Store({ directory: '/' }), /DEDICATED_STORAGE_DIRECTORY_REQUIRED/);
  const other = path.join(f.base, 'other.sqlite'); fs.writeFileSync(other, 'Do not touch');
  fs.symlinkSync(other, path.join(f.directory, 'mmm.sqlite'));
  assert.throws(() => f.open(), /UNSAFE_STORAGE_FILE/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'Do not touch');
});

test('directory disappearance or replacement blocks reads and writes without fallback', t => {
  const f = fixture(t), store = f.open(); store.createProject({ name: 'Original' });
  const moved = path.join(f.base, 'original'); fs.renameSync(f.directory, moved);
  assert.equal(store.checkHealth().ok, false);
  assert.throws(() => store.createProject({ name: 'No recreate' }), /STORAGE_UNAVAILABLE/);
  assert.equal(fs.existsSync(f.directory), false);
  fs.mkdirSync(f.directory);
  assert.throws(() => store.setSetting('no', true), /STORAGE_UNAVAILABLE/);
  assert.throws(() => store.listProjects(), /STORAGE_UNAVAILABLE/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  // Restore the original path before closing the live SQLite connection.
  fs.rmdirSync(f.directory); fs.renameSync(moved, f.directory);
});

test('database replacement is detected even if the selected directory survives', t => {
  const f = fixture(t), store = f.open(); store.createProject({ name: 'Original' });
  const source = path.join(f.directory, 'mmm.sqlite'), moved = path.join(f.directory, 'old.sqlite');
  fs.renameSync(source, moved); fs.writeFileSync(source, 'replacement', { mode: 0o600 });
  assert.throws(() => store.setSetting('no', 1), /STORAGE_UNAVAILABLE/);
  assert.equal(store.checkHealth().ok, false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'replacement');
  fs.unlinkSync(source); fs.renameSync(moved, source);
});

function legacy() {
  return {
    projects: [{ id: 'legacy-project', name: 'Synthetic legacy' }],
    conversations: [{ id: 'legacy-conversation', projectId: 'legacy-project', messages: [{ id: 'legacy-message', role: 'user', content: 'Synthetic historical request' }] }],
    tasks: [{ id: 'legacy-task', projectId: 'legacy-project', title: 'Old task', message: 'Synthetic task body', status: 'running' }],
  };
}

test('legacy import validates, creates a private checksummed backup, and preserves IDs', t => {
  const f = fixture(t), store = f.open(), payload = legacy();
  const result = store.importLegacy(payload);
  assert.equal(result.projects, 1); assert.equal(result.messages, 1); assert.equal(result.tasks, 1);
  assert.equal(store.getProject('legacy-project').conversationId, 'legacy-conversation');
  assert.equal(store.listMessages('legacy-project')[0].id, 'legacy-message');
  assert.equal(store.getTask('legacy-task').status, 'blocked');
  assert.equal(store.getTask('legacy-task').description, 'Synthetic task body');
  const backup = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
  assert.deepEqual(backup.payload, payload);
  assert.equal(backup.sha256, crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  assert.throws(() => store.importLegacy(payload), /IMPORT_ID_COLLISION/);
  assert.equal(store.listProjects().length, 1);
});

test('invalid imports fail before creating backups or partial rows', t => {
  const f = fixture(t), store = f.open(), initial = fs.readdirSync(f.directory).sort();
  const bad = legacy(); bad.tasks.push({ id: 'bad-task', projectId: 'missing-project', title: 'Invalid relation' });
  assert.throws(() => store.importLegacy(bad), /INVALID_LEGACY_TASK/);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), initial);
  assert.deepEqual(store.listProjects(), []);
  const many = legacy(); many.conversations.push({ id: 'second-conversation', projectId: 'legacy-project', messages: [] });
  assert.throws(() => store.importLegacy(many), /INVALID_LEGACY_CONVERSATION/);
  assert.deepEqual(store.listProjects(), []);
  const done = legacy(); done.tasks[0].status = 'completed'; store.importLegacy(done);
  assert.equal(store.getTask('legacy-task').status, 'blocked');
  assert.equal(store.getTask('legacy-task').blockedReason, 'legacy_completion_unverified');
});

test('failed import transaction rolls back all rows and retains its backup', t => {
  const f = fixture(t), store = f.open();
  // A synthetic database trigger injects a late write failure after projects/messages insert.
  const db = new DatabaseSync(path.join(f.directory, 'mmm.sqlite'));
  db.exec("CREATE TRIGGER test_reject BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END;"); db.close();
  assert.throws(() => store.importLegacy(legacy()), /synthetic_failure/);
  assert.deepEqual(store.listProjects(), []);
  assert.equal(fs.readdirSync(f.directory).filter(name => name.startsWith('legacy-import-')).length, 1);
});

test('migration checkpoints WAL, verifies copy and retains the original database', t => {
  const f = fixture(t), source = f.open(), project = source.createProject({ name: 'Migration' });
  source.addMessage(project.id, { role: 'user', content: 'From WAL to target' });
  source.setSetting('retained', { yes: true });
  const target = path.join(f.base, 'destination'); fs.mkdirSync(target);
  const replacement = source.migrate(target); f.stores.push(replacement);
  assert.equal(replacement.checkHealth().ok, true);
  assert.deepEqual(replacement.getProject(project.id), project);
  assert.equal(replacement.listMessages(project.id)[0].content, 'From WAL to target');
  assert.deepEqual(replacement.getSetting('retained'), { yes: true });
  assert.equal(source.getProject(project.id).id, project.id);
  assert.equal(source.checkHealth().ok, true);
  assert.equal(fs.statSync(path.join(target, 'mmm.sqlite')).mode & 0o777, 0o600);
  replacement.createProject({ name: 'Only target' });
  assert.equal(source.listProjects().length, 1);
  assert.equal(replacement.listProjects().length, 2);
});

test('migration rejects same, missing and nonempty targets without overwriting', t => {
  const f = fixture(t), store = f.open(); store.createProject({ name: 'Source' });
  assert.throws(() => store.migrate(f.directory), /MIGRATION_SAME_DIRECTORY/);
  const missing = path.join(f.base, 'missing');
  assert.throws(() => store.migrate(missing), /STORAGE_UNAVAILABLE/);
  assert.equal(fs.existsSync(missing), false);
  const occupied = path.join(f.base, 'occupied'); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep'), 'unrelated');
  assert.throws(() => store.migrate(occupied), /MIGRATION_TARGET_NOT_EMPTY/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep'), 'utf8'), 'unrelated');
  assert.equal(store.listProjects().length, 1);
});

test('migration includes only encrypted credentials, encrypted mail and legacy backups', t => {
  const f = fixture(t), store = f.open();
  const imported = store.importLegacy(legacy());
  fs.writeFileSync(path.join(f.directory, 'credentials.enc.json'), JSON.stringify({ fake: 'synthetic-ciphertext' }), { mode: 0o600 });
  fs.mkdirSync(path.join(f.directory, 'private-mail'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.directory, 'private-mail', 'message.enc'), 'synthetic-encrypted-mail', { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'private-mail', 'excluded.txt'), 'not copied');
  fs.writeFileSync(path.join(f.directory, 'unrelated.txt'), 'not copied');
  fs.writeFileSync(path.join(f.directory, '.env'), 'SYNTHETIC_FIXTURE_ONLY=not-a-secret');
  const target = path.join(f.base, 'destination'); fs.mkdirSync(target);
  const replacement = store.migrate(target); f.stores.push(replacement);
  const relativeFiles = ['credentials.enc.json', path.join('private-mail', 'message.enc'), path.basename(imported.backupPath)];
  for (const relative of relativeFiles) {
    assert.deepEqual(fs.readFileSync(path.join(target, relative)), fs.readFileSync(path.join(f.directory, relative)));
    assert.equal(fs.statSync(path.join(target, relative)).mode & 0o777, 0o600);
    assert.ok(replacement.migration.copies.find(item => item.name === relative && /^[a-f0-9]{64}$/.test(item.sha256)));
  }
  assert.equal(fs.statSync(path.join(target, 'private-mail')).mode & 0o777, 0o700);
  for (const relative of ['.env', 'unrelated.txt', 'private-mail/excluded.txt']) assert.equal(fs.existsSync(path.join(target, relative)), false);
});

test('migration rejects symlinked ancillary files and directories before any copy', t => {
  const f = fixture(t), store = f.open(), other = path.join(f.base, 'other'); fs.writeFileSync(other, 'synthetic');
  const target = path.join(f.base, 'destination'); fs.mkdirSync(target);
  const credentials = path.join(f.directory, 'credentials.enc.json'); fs.symlinkSync(other, credentials);
  assert.throws(() => store.migrate(target), /UNSAFE_MIGRATION_FILE/);
  assert.deepEqual(fs.readdirSync(target), []); fs.unlinkSync(credentials);
  const otherDirectory = path.join(f.base, 'other-directory'); fs.mkdirSync(otherDirectory);
  const mail = path.join(f.directory, 'private-mail'); fs.symlinkSync(otherDirectory, mail);
  assert.throws(() => store.migrate(target), /UNSAFE_MIGRATION_FILE/);
  assert.deepEqual(fs.readdirSync(target), []); fs.unlinkSync(mail); fs.mkdirSync(mail);
  fs.symlinkSync(other, path.join(mail, 'item.enc'));
  assert.throws(() => store.migrate(target), /UNSAFE_MIGRATION_FILE/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('readonly directory errors fail health and writes without fallback state', t => {
  const f = fixture(t), store = f.open(); store.createProject({ name: 'Before readonly' });
  const original = fs.accessSync;
  fs.accessSync = (filename, flags) => {
    if (filename === store.directory && (flags & fs.constants.W_OK)) throw Object.assign(Error('synthetic readonly disk'), { code: 'EROFS' });
    return original(filename, flags);
  };
  try {
    assert.equal(store.checkHealth().ok, false);
    assert.throws(() => store.createProject({ name: 'Rejected' }), /STORAGE_UNAVAILABLE/);
  } finally { fs.accessSync = original; }
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.checkHealth().ok, true);
});

test('a migration checksum failure never switches or modifies the source', t => {
  const f = fixture(t), store = f.open(), project = store.createProject({ name: 'Retain original' });
  const target = path.join(f.base, 'corrupted-copy'); fs.mkdirSync(target);
  const original = fs.copyFileSync;
  fs.copyFileSync = (from, to, flags) => {
    original(from, to, flags);
    if (path.basename(to) === 'mmm.sqlite') fs.appendFileSync(to, 'synthetic corruption');
  };
  try { assert.throws(() => store.migrate(target), /MIGRATION_CHECKSUM_FAILED/); }
  finally { fs.copyFileSync = original; }
  assert.equal(store.checkHealth().ok, true);
  assert.equal(store.getProject(project.id).name, 'Retain original');
  assert.equal(store.directory, fs.realpathSync(f.directory));
  assert.equal(fs.existsSync(path.join(target, 'mmm.sqlite')), true);
});
