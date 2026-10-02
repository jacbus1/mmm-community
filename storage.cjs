'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const STATES = new Set(['queued', 'running', 'awaiting_authorization', 'blocked', 'awaiting_review', 'completed', 'failed', 'cancelled', 'paused']);
const ROLES = new Set(['user', 'assistant', 'system', 'tool', 'agent']);
const DATABASE = 'mmm.sqlite';
function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function text(value, max = 16000, empty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw fault('INVALID_TEXT');
  return value;
}
function identifier(value = crypto.randomUUID()) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fault('INVALID_ID');
  return value;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw fault('INVALID_OBJECT');
  return value;
}
function encoded(value, limit = 1024 * 1024) {
  let result;
  try { result = JSON.stringify(value); } catch { throw fault('INVALID_JSON'); }
  if (typeof result !== 'string' || Buffer.byteLength(result) > limit) throw fault('INVALID_JSON');
  return result;
}
function hasEvidence(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0 && value.every(hasEvidence);
  if (value && typeof value === 'object') return Object.values(value).some(hasEvidence);
  return false;
}
function existingDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw fault('EXISTING_STORAGE_DIRECTORY_REQUIRED');
  let directory, stat;
  try { directory = fs.realpathSync(input); stat = fs.statSync(directory); } catch { throw fault('STORAGE_UNAVAILABLE', 503); }
  if (!stat.isDirectory() || directory === path.parse(directory).root || directory === os.homedir() || /^\/Volumes\/[^/]+$/.test(directory)) throw fault('DEDICATED_STORAGE_DIRECTORY_REQUIRED');
  return { directory, stat, requested: path.resolve(input) };
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

class Store {
  constructor({ directory } = {}) {
    const selected = existingDirectory(directory);
    this.directory = selected.directory;
    this.requestedDirectory = selected.requested;
    this.identity = { dev: selected.stat.dev, ino: selected.stat.ino };
    this.filename = path.join(this.directory, DATABASE);
    this.closed = false;
    // Require an explicit existing directory: never recreate an absent external mount.
    fs.chmodSync(this.directory, 0o700);
    this._checkDirectory();
    this._checkFiles();
    if (!fs.existsSync(this.filename)) {
      const fd = fs.openSync(this.filename, 'wx', 0o600);
      fs.closeSync(fd);
    }
    fs.chmodSync(this.filename, 0o600);
    try {
      this.db = new DatabaseSync(this.filename);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this._schema();
      this.fileIdentity = fs.statSync(this.filename);
      this._write(() => {
        this.db.prepare("UPDATE tasks SET status='blocked', data=json_set(data, '$.blockedReason', 'interrupted_restart'), updated_at=? WHERE status='running'").run(new Date().toISOString());
      });
    } catch (error) { this.db?.close(); this.closed = true; throw error; }
  }

  _schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool','agent')),
        content TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_sources (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
        access TEXT NOT NULL CHECK(access='reference-only'),
        UNIQUE(project_id, path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_authorization','blocked','awaiting_review','completed','failed','cancelled','paused')),
        data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT,
        type TEXT NOT NULL, detail TEXT NOT NULL CHECK(json_valid(detail)), created_at TEXT NOT NULL,
        FOREIGN KEY(task_id, project_id) REFERENCES tasks(id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT,
        name TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id, project_id) REFERENCES tasks(id, project_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
      CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id);
      CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id);
      CREATE INDEX IF NOT EXISTS sources_project ON project_sources(project_id);
      PRAGMA user_version=2;
    `);
  }

  _checkDirectory() {
    try {
      const resolved = fs.realpathSync(this.requestedDirectory);
      const stat = fs.statSync(this.directory);
      if (resolved !== this.directory || !stat.isDirectory() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw Error();
      fs.accessSync(this.directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch { throw fault('STORAGE_UNAVAILABLE', 503); }
  }
  _checkFiles() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = this.filename + suffix;
      try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw fault('UNSAFE_STORAGE_FILE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  _ready() {
    if (this.closed) throw fault('STORAGE_CLOSED', 503);
    this._checkDirectory();
    this._checkFiles();
    if (this.fileIdentity) {
      let stat;
      try { stat = fs.statSync(this.filename); } catch { throw fault('STORAGE_UNAVAILABLE', 503); }
      if (stat.dev !== this.fileIdentity.dev || stat.ino !== this.fileIdentity.ino) throw fault('STORAGE_UNAVAILABLE', 503);
    }
  }
  _permissions() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.chmodSync(this.filename + suffix, 0o600); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  _write(action) {
    this._ready();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this._ready();
      this.db.exec('COMMIT');
      this._permissions();
      return result;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  _project(id) { const project = this.getProject(id); if (!project) throw fault('PROJECT_NOT_FOUND', 404); return project; }
  _taskInProject(projectId, taskId) {
    if (taskId == null || taskId === '') return null;
    const task = this.getTask(identifier(taskId));
    if (!task || task.projectId !== projectId) throw fault('TASK_PROJECT_MISMATCH', 409);
    return task.id;
  }
  _projectView(row) { return row ? { id: row.id, name: row.name, conversationId: row.conversation_id, createdAt: row.created_at,
    sources: this.db.prepare('SELECT id,name,path,kind,access FROM project_sources WHERE project_id=? ORDER BY rowid').all(row.id).map(source => ({ ...source })) } : null; }
  _taskView(row) {
    return row ? { ...JSON.parse(row.data), id: row.id, projectId: row.project_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      artifactIds: this.db.prepare('SELECT id FROM artifacts WHERE task_id=? ORDER BY rowid').all(row.id).map(item => item.id) } : null;
  }
  listProjects() { this._ready(); return this.db.prepare('SELECT * FROM projects ORDER BY rowid').all().map(row => this._projectView(row)); }
  getProject(id) { this._ready(); return this._projectView(this.db.prepare('SELECT * FROM projects WHERE id=?').get(identifier(id))); }
  createProject(input) {
    object(input);
    const sources = input.sources ?? [];
    if (!Array.isArray(sources) || sources.length > 1000) throw fault('INVALID_PROJECT_SOURCES');
    const normalized = sources.map(source => {
      object(source);
      if (!['file', 'folder'].includes(source.kind) || source.access !== 'reference-only' || !path.isAbsolute(source.path || '')) throw fault('INVALID_PROJECT_SOURCES');
      return { id: identifier(source.id), name: text(source.name, 500), path: text(source.path, 4096), kind: source.kind, access: 'reference-only' };
    });
    if (new Set(normalized.map(source => source.path)).size !== normalized.length || new Set(normalized.map(source => source.id)).size !== normalized.length) throw fault('DUPLICATE_PROJECT_SOURCE');
    const row = { id: identifier(input.id), name: text(input.name, 200).trim(), conversationId: crypto.randomUUID(), createdAt: new Date().toISOString(), sources: normalized };
    this._write(() => {
      this.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(row.id, row.name, row.conversationId, row.createdAt);
      for (const source of normalized) this.db.prepare('INSERT INTO project_sources VALUES (?,?,?,?,?,?)').run(source.id, row.id, source.name, source.path, source.kind, source.access);
    });
    return row;
  }
  addProjectSources(projectId, sources) {
    identifier(projectId); this._project(projectId);
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 100) throw fault('INVALID_PROJECT_SOURCES');
    const normalized = sources.map(source => {
      object(source);
      if (!['file', 'folder'].includes(source.kind) || source.access !== 'reference-only' || !path.isAbsolute(source.path || '')) throw fault('INVALID_PROJECT_SOURCES');
      return { id: identifier(source.id), name: text(source.name, 500), path: text(source.path, 4096), kind: source.kind, access: 'reference-only' };
    });
    if (new Set(normalized.map(source => source.path)).size !== normalized.length || new Set(normalized.map(source => source.id)).size !== normalized.length) throw fault('DUPLICATE_PROJECT_SOURCE');
    this._write(() => {
      const existing = this.getProject(projectId).sources;
      const paths = new Set(existing.map(source => source.path));
      // Re-selection is idempotent by canonical path. Keep the original source
      // ID and its independently managed read grant; never upgrade permissions.
      const added = normalized.filter(source => !paths.has(source.path));
      if (existing.length + added.length > 1000) throw fault('PROJECT_SOURCE_LIMIT');
      for (const source of added) this.db.prepare('INSERT INTO project_sources VALUES (?,?,?,?,?,?)').run(source.id, projectId, source.name, source.path, source.kind, source.access);
    });
    return this.getProject(projectId);
  }
  listMessages(projectId) {
    const project = this._project(identifier(projectId));
    return this.db.prepare('SELECT * FROM messages WHERE project_id=? ORDER BY rowid').all(project.id).map(row => ({ id: row.id, projectId: row.project_id, conversationId: project.conversationId, role: row.role, content: row.content, createdAt: row.created_at }));
  }
  addMessage(projectId, input) {
    object(input); const project = this._project(identifier(projectId));
    if (!ROLES.has(input.role)) throw fault('INVALID_ROLE');
    const row = { id: identifier(input.id), projectId: project.id, conversationId: project.conversationId, role: input.role, content: text(input.content, 1000000), createdAt: new Date().toISOString() };
    this._write(() => this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(row.id, row.projectId, row.role, row.content, row.createdAt));
    return row;
  }
  _taskData(input) {
    if (input.confirmedNonSensitive !== undefined && typeof input.confirmedNonSensitive !== 'boolean') throw fault('INVALID_TASK_CONFIRMATION');
    return { title: text(input.title, 500).trim(), description: text(input.description ?? '', 100000, true), providerId: input.providerId == null || input.providerId === '' ? '' : identifier(input.providerId), classification: text(input.classification ?? 'local', 100), acceptanceEvidence: '', confirmedNonSensitive: input.confirmedNonSensitive === true, ...(input.retryOf ? { retryOf: identifier(input.retryOf) } : {}) };
  }
  listTasks(projectId) { this._project(identifier(projectId)); return this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY rowid').all(projectId).map(row => this._taskView(row)); }
  getTask(id) { this._ready(); return this._taskView(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(identifier(id))); }
  createTask(projectId, input) {
    object(input); this._project(identifier(projectId));
    const id = identifier(input.id), data = this._taskData(input), now = new Date().toISOString();
    // Only the application creates team snapshots. Legacy _taskData imports
    // deliberately cannot import a team, peer-sharing consent or turns.
    if (input.team) { encoded(input.team, 20000); data.team = input.team; data.confirmedSharing = input.confirmedSharing === true; data.turns = []; }
    this._write(() => this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(id, projectId, 'queued', encoded(data), now, now));
    return this.getTask(id);
  }
  updateTask(id, patch) {
    object(patch); identifier(id);
    const allowed = new Set(['title', 'description', 'providerId', 'classification', 'status', 'acceptanceEvidence', 'error', 'blockedReason', 'result', 'authorizationId', 'confirmedNonSensitive', 'confirmedSharing', 'turns', 'usage', 'retryOf']);
    if (Object.keys(patch).some(key => !allowed.has(key))) throw fault('INVALID_TASK_PATCH');
    this._write(() => {
      const task = this.getTask(id); if (!task) throw fault('TASK_NOT_FOUND', 404);
      const status = patch.status ?? task.status; if (!STATES.has(status)) throw fault('INVALID_TASK_STATUS');
      const data = JSON.parse(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id).data);
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'status') continue;
        if (key === 'providerId' || key === 'authorizationId' || key === 'retryOf') data[key] = value === '' || value === null ? '' : identifier(value);
        else if (key === 'confirmedNonSensitive' || key === 'confirmedSharing') { if (typeof value !== 'boolean') throw fault('INVALID_TASK_CONFIRMATION'); data[key] = value; }
        else if (key === 'acceptanceEvidence' || key === 'result' || key === 'usage' || key === 'turns') { encoded(value, 1000000); data[key] = value; }
        else data[key] = text(value == null && ['error', 'blockedReason'].includes(key) ? '' : value, key === 'title' ? 500 : key === 'classification' ? 100 : 100000, !['title', 'classification'].includes(key));
      }
      if (status === 'completed' && (!hasEvidence(data.acceptanceEvidence) || !this.db.prepare('SELECT 1 FROM artifacts WHERE task_id=? LIMIT 1').get(id))) throw fault('COMPLETION_EVIDENCE_REQUIRED', 409);
      this.db.prepare('UPDATE tasks SET status=?, data=?, updated_at=? WHERE id=?').run(status, encoded(data), new Date().toISOString(), id);
    });
    return this.getTask(id);
  }
  importLocalTaskProposals(projectId, proposals, digest) {
    this._project(identifier(projectId));
    if (!Array.isArray(proposals) || proposals.length > 100 || !/^[a-f0-9]{64}$/.test(digest)) throw fault('INVALID_LOCAL_PROPOSALS');
    const key = 'markdown-import:' + sha256(projectId + ':' + digest);
    const previous = this.getSetting(key);
    if (previous) return { duplicate: true, count: previous.length, tasks: previous.map(id => this.getTask(id)) };
    const rows = proposals.map(input => {
      object(input);
      if (Object.keys(input).some(key => !['title', 'description'].includes(key))) throw fault('INVALID_LOCAL_PROPOSALS');
      return { id: crypto.randomUUID(), data: this._taskData({ title: input.title, description: input.description || '', classification: 'local', confirmedNonSensitive: false }) };
    });
    const now = new Date().toISOString();
    this._write(() => {
      for (const row of rows) this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(row.id, projectId, 'queued', encoded(row.data), now, now);
      this.db.prepare('INSERT INTO settings VALUES (?,?)').run(key, encoded(rows.map(row => row.id)));
    });
    return { duplicate: false, count: rows.length, tasks: rows.map(row => this.getTask(row.id)) };
  }
  listEvents(projectId) {
    this._project(identifier(projectId));
    return this.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY rowid').all(projectId).map(row => ({ id: row.id, projectId: row.project_id, taskId: row.task_id, type: row.type, detail: JSON.parse(row.detail), createdAt: row.created_at }));
  }
  addEvent(projectId, input) {
    object(input); this._project(identifier(projectId));
    const row = { id: crypto.randomUUID(), projectId, taskId: this._taskInProject(projectId, input.taskId), type: text(input.type, 100), detail: input.detail ?? '', createdAt: new Date().toISOString() };
    const detail = encoded(row.detail);
    this._write(() => this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(row.id, projectId, row.taskId, row.type, detail, row.createdAt));
    return row;
  }
  listArtifacts(projectId) {
    this._project(identifier(projectId));
    return this.db.prepare('SELECT * FROM artifacts WHERE project_id=? ORDER BY rowid').all(projectId).map(row => ({ id: row.id, projectId: row.project_id, taskId: row.task_id, name: row.name, content: row.content, sha256: row.sha256, createdAt: row.created_at }));
  }
  addArtifact(projectId, input) {
    object(input); this._project(identifier(projectId));
    const content = text(input.content, 1000000), name = text(input.name, 300).trim();
    // Artifact names are display metadata; content lives in SQLite, never at this path.
    const row = { id: crypto.randomUUID(), projectId, taskId: this._taskInProject(projectId, input.taskId), name, content, sha256: sha256(content), createdAt: new Date().toISOString() };
    this._write(() => this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?)').run(row.id, projectId, row.taskId, name, content, row.sha256, row.createdAt));
    return row;
  }
  getSetting(key) { this._ready(); const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(text(key, 100)); return row ? JSON.parse(row.value) : null; }
  setSetting(key, value) {
    text(key, 100); const serialized = encoded(value);
    this._write(() => this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialized));
    return value;
  }
  checkHealth() {
    try { this._ready(); const result = this.db.prepare('PRAGMA quick_check').get(); if (result.quick_check !== 'ok') throw fault('STORAGE_CORRUPT', 503); return { ok: true, directory: this.directory }; }
    catch (error) { return { ok: false, directory: this.directory, error: error.code || 'STORAGE_UNAVAILABLE' }; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }

  importLegacy(payload) {
    this._ready(); object(payload);
    const source = encoded(payload, 25 * 1024 * 1024), checksum = sha256(source);
    for (const field of ['projects', 'conversations', 'tasks']) if (payload[field] !== undefined && !Array.isArray(payload[field])) throw fault('INVALID_LEGACY_IMPORT');
    const projects = [], messages = [], tasks = [], projectIds = new Set(), conversationIds = new Set(), messageIds = new Set(), taskIds = new Set();
    const now = new Date().toISOString();
    for (const input of payload.projects || []) {
      object(input); const id = identifier(input.id);
      if (projectIds.has(id) || this.getProject(id)) throw fault('IMPORT_ID_COLLISION', 409);
      projectIds.add(id); projects.push({ id, name: text(input.name, 200), conversationId: input.conversationId ? identifier(input.conversationId) : null });
    }
    for (const input of payload.conversations || []) {
      object(input); const id = identifier(input.id), projectId = identifier(input.projectId);
      const project = projects.find(item => item.id === projectId);
      if (!project || project.importedConversation || (project.conversationId && project.conversationId !== id) || conversationIds.has(id)) throw fault('INVALID_LEGACY_CONVERSATION');
      if (this.db.prepare('SELECT 1 FROM projects WHERE conversation_id=?').get(id)) throw fault('IMPORT_ID_COLLISION', 409);
      project.conversationId = id; project.importedConversation = true; conversationIds.add(id);
      if (!Array.isArray(input.messages)) throw fault('INVALID_LEGACY_MESSAGES');
      for (const message of input.messages) {
        object(message); const messageId = identifier(message.id);
        if (!ROLES.has(message.role) || messageIds.has(messageId) || this.db.prepare('SELECT 1 FROM messages WHERE id=?').get(messageId)) throw fault('INVALID_LEGACY_MESSAGE');
        messageIds.add(messageId); messages.push({ id: messageId, projectId, role: message.role, content: text(message.content, 1000000) });
      }
    }
    const allConversationIds = new Set();
    for (const project of projects) {
      project.conversationId ||= crypto.randomUUID();
      if (allConversationIds.has(project.conversationId) || this.db.prepare('SELECT 1 FROM projects WHERE conversation_id=?').get(project.conversationId)) throw fault('IMPORT_ID_COLLISION', 409);
      allConversationIds.add(project.conversationId);
    }
    for (const input of payload.tasks || []) {
      object(input); const id = identifier(input.id), projectId = identifier(input.projectId);
      if (!projectIds.has(projectId) || taskIds.has(id) || this.getTask(id)) throw fault('INVALID_LEGACY_TASK');
      const originalStatus = input.status ?? 'queued';
      if (!STATES.has(originalStatus)) throw fault('INVALID_TASK_STATUS');
      const data = this._taskData({ ...input, description: input.description ?? input.message ?? '' });
      // A file is untrusted data, not user authorization to send its contents.
      data.confirmedNonSensitive = false;
      data.classification = 'unknown';
      // Import never starts work; old completion labels are not fresh acceptance evidence.
      const status = ['queued', 'running', 'completed'].includes(originalStatus) ? 'blocked' : originalStatus;
      data.legacyStatus = originalStatus;
      if (status === 'blocked') data.blockedReason = originalStatus === 'completed' ? 'legacy_completion_unverified' : 'legacy_import_requires_review';
      encoded(data); taskIds.add(id); tasks.push({ id, projectId, status, data });
    }
    // No backup or database mutation takes place until the entire payload is validated.
    this._ready();
    const backupName = `legacy-import-${crypto.randomUUID()}.json`;
    const backupPath = path.join(this.directory, backupName);
    const backup = encoded({ format: 'mmm-legacy-backup-v1', sha256: checksum, payload: JSON.parse(source) }, 30 * 1024 * 1024);
    const fd = fs.openSync(backupPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, backup); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const verified = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (sha256(encoded(verified.payload, 25 * 1024 * 1024)) !== checksum) throw fault('IMPORT_BACKUP_CHECKSUM_FAILED', 503);
    this._write(() => {
      for (const row of projects) this.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(row.id, row.name, row.conversationId, now);
      for (const row of messages) this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(row.id, row.projectId, row.role, row.content, now);
      for (const row of tasks) this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(row.id, row.projectId, row.status, encoded(row.data), now, now);
    });
    return { projects: projects.length, conversations: (payload.conversations || []).length, messages: messages.length, tasks: tasks.length, backupPath, checksum };
  }

  _migrationAncillary() {
    this._ready();
    const manifest = [];
    const include = relative => {
      const filename = path.join(this.directory, relative), stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fault('UNSAFE_MIGRATION_FILE');
      manifest.push({ relative, stat });
    };
    const entries = fs.readdirSync(this.directory);
    if (entries.includes('credentials.enc.json')) include('credentials.enc.json');
    for (const name of entries) if (/^legacy-import-[A-Za-z0-9_-]+\.json$/.test(name)) include(name);
    let mailIdentity;
    if (entries.includes('private-mail')) {
      const mailDirectory = path.join(this.directory, 'private-mail');
      mailIdentity = fs.lstatSync(mailDirectory);
      if (!mailIdentity.isDirectory() || mailIdentity.isSymbolicLink()) throw fault('UNSAFE_MIGRATION_FILE');
      for (const name of fs.readdirSync(mailDirectory)) if (name.endsWith('.enc')) include(path.join('private-mail', name));
    }
    return { manifest, mailIdentity };
  }

  migrate(target) {
    this._ready();
    const destination = existingDirectory(typeof target === 'string' ? target : target?.directory);
    if (destination.directory === this.directory || (destination.stat.ino === this.identity.ino && destination.stat.dev === this.identity.dev)) throw fault('MIGRATION_SAME_DIRECTORY');
    // A dedicated empty target avoids accidentally adopting or overwriting unrelated data.
    if (fs.readdirSync(destination.directory).length) throw fault('MIGRATION_TARGET_NOT_EMPTY', 409);
    fs.chmodSync(destination.directory, 0o700);
    const targetFile = path.join(destination.directory, DATABASE);
    let copied = false;
    const copies = [];
    const destinationReady = () => {
      const current = existingDirectory(destination.requested);
      if (current.directory !== destination.directory || current.stat.dev !== destination.stat.dev || current.stat.ino !== destination.stat.ino) throw fault('MIGRATION_TARGET_CHANGED', 409);
      fs.accessSync(destination.directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    };
    try {
      const ancillary = this._migrationAncillary();
      const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint.busy) throw fault('MIGRATION_SOURCE_BUSY', 409);
      // Hold an exclusive transaction so another connection cannot write between checksum and copy.
      this.db.exec('BEGIN EXCLUSIVE');
      try {
        this._ready();
        // A concurrent connection might commit between checkpoint and lock acquisition.
        // Fail rather than silently leave that WAL-only commit out of the copy.
        if (fs.existsSync(this.filename + '-wal') && fs.statSync(this.filename + '-wal').size > 0) throw fault('MIGRATION_SOURCE_BUSY', 409);
        destinationReady();
        if (fs.readdirSync(destination.directory).length) throw fault('MIGRATION_TARGET_CHANGED', 409);
        const sourceHash = sha256(fs.readFileSync(this.filename));
        fs.copyFileSync(this.filename, targetFile, fs.constants.COPYFILE_EXCL); copied = true;
        fs.chmodSync(targetFile, 0o600);
        const fd = fs.openSync(targetFile, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (sha256(fs.readFileSync(targetFile)) !== sourceHash) throw fault('MIGRATION_CHECKSUM_FAILED', 503);
        copies.push({ name: DATABASE, sha256: sourceHash });
        if (ancillary.mailIdentity) {
          destinationReady();
          fs.mkdirSync(path.join(destination.directory, 'private-mail'), { mode: 0o700 });
        }
        for (const item of ancillary.manifest) {
          this._ready(); destinationReady();
          if (item.relative.startsWith('private-mail' + path.sep)) {
            const mailStat = fs.lstatSync(path.join(this.directory, 'private-mail'));
            if (!mailStat.isDirectory() || mailStat.isSymbolicLink() || mailStat.ino !== ancillary.mailIdentity.ino || mailStat.dev !== ancillary.mailIdentity.dev) throw fault('MIGRATION_SOURCE_CHANGED', 409);
          }
          const from = path.join(this.directory, item.relative), to = path.join(destination.directory, item.relative);
          const current = fs.lstatSync(from);
          if (!current.isFile() || current.isSymbolicLink() || current.ino !== item.stat.ino || current.dev !== item.stat.dev || current.size !== item.stat.size || current.mtimeMs !== item.stat.mtimeMs) throw fault('MIGRATION_SOURCE_CHANGED', 409);
          const checksum = sha256(fs.readFileSync(from));
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(to, 0o600);
          const copiedFd = fs.openSync(to, 'r'); try { fs.fsyncSync(copiedFd); } finally { fs.closeSync(copiedFd); }
          if (sha256(fs.readFileSync(to)) !== checksum || sha256(fs.readFileSync(from)) !== checksum) throw fault('MIGRATION_CHECKSUM_FAILED', 503);
          copies.push({ name: item.relative, sha256: checksum });
        }
        this._ready(); destinationReady();
      } finally { this.db.exec('ROLLBACK'); }
      destinationReady();
      const replacement = new Store({ directory: destination.requested });
      if (!replacement.checkHealth().ok) { replacement.close(); throw fault('MIGRATION_CHECK_FAILED', 503); }
      replacement.migration = { source: this.directory, destination: replacement.directory, originalRetained: true, copies };
      return replacement;
    } catch (error) {
      // Keep any successfully copied file for investigation; never delete pre-existing content.
      if (copied) error.partialMigrationPath = targetFile;
      throw error;
    }
  }
}

module.exports = { Store, STATES };
