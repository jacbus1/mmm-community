'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, headers, authorizeSource, authorize, readBody, text, id, json } = require('./security.cjs');
const { Store } = require('./storage.cjs');
const { CredentialVault } = require('./vault.cjs');
const { ProviderService, catalog } = require('./providers.cjs');
const { LocalMailArchive } = require('./mail.cjs');
const { SourceSelections, MAX_BATCH, MAX_PROJECT } = require('./sources.cjs');
const { SourceAccess } = require('./source-access.cjs');
const { normalizeTeam, runTeam } = require('./team.cjs');
const { exportProject, importProposal } = require('./markdown-exchange.cjs');
const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/i18n.js', ['i18n.js', 'text/javascript']], ['/mail.js', ['mail.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']]]);
assets.set('/logo.png', ['logo.png', 'image/png']);
function defaultDirectory() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MMM-Community');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'MMM-Community');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'MMM-Community');
}
async function createApplication({ directory, safeStorage, fetchImpl, port = 0 } = {}) {
  if (!directory) { directory = defaultDirectory(); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  let store = new Store({ directory });
  let sourceAccess = new SourceAccess({ store });
  const health = () => { const state = store.checkHealth(); if (!state.ok) throw new AppError('STORAGE_UNAVAILABLE', 503); };
  let vault = new CredentialVault({ directory, safeStorage, health });
  let providers = new ProviderService({ store, vault, fetchImpl });
  let mail = new LocalMailArchive({ directory, vault, health });
  const session = crypto.randomBytes(32).toString('base64url');
  let origin = '', closing = false, migrating = false;
  const controllers = new Map();
  const probes = new Set();
  const sources = new SourceSelections();
  const providerBinding = providerId => { const row = providers.get(providerId); return { id: row.id, kind: row.kind, model: row.model, endpoint: row.endpoint }; };
  const archiveKey = projectId => 'archived:' + crypto.createHash('sha256').update(projectId).digest('hex');
  const archived = projectId => store.getSetting(archiveKey(projectId)) === true;
  const requireActive = projectId => { if (archived(projectId)) throw new AppError('PROJECT_ARCHIVED', 409); };
  const event = (projectId, type, taskId, detail) => store.addEvent(projectId, { type, taskId, detail });
  function projectSnapshot(projectId) {
    const project = store.getProject(id(projectId)); if (!project) throw new AppError('PROJECT_NOT_FOUND', 404);
    return { project: { ...project, archived: archived(projectId) }, team: store.getSetting('team:' + projectId), messages: store.listMessages(projectId), tasks: store.listTasks(projectId), artifacts: store.listArtifacts(projectId), events: store.listEvents(projectId) };
  }
  async function execute(taskId) {
    if (closing || migrating || controllers.has(taskId)) return;
    const task = store.getTask(taskId); if (!task || task.status !== 'queued') return;
    if (archived(task.projectId)) return;
    const controller = new AbortController(); controllers.set(taskId, controller);
    try {
      store.updateTask(taskId, { status: 'running' }); event(task.projectId, 'worker_started', taskId, 'AI research; no filesystem, email or tools access.');
      const input = { text: task.description || task.title, classification: task.classification, confirmedNonSensitive: task.confirmedNonSensitive === true, signal: controller.signal };
      const turns = [];
      const result = task.team ? await runTeam({ ...input, team: normalizeTeam(task.team, providerId => providers.get(providerId)), confirmedSharing: task.confirmedSharing === true,
        generate: (providerId, request) => {
          const expected = task.team.bindings?.find(row => row.id === providerId);
          if (!expected || JSON.stringify(expected) !== JSON.stringify(providerBinding(providerId))) throw new AppError('TEAM_PROVIDER_CHANGED', 409);
          return providers.generate(providerId, request);
        },
        onTurn: turn => {
          if (controller.signal.aborted) return;
          const existing = turns.findIndex(value => value.index === turn.index);
          if (existing < 0) turns.push(turn); else turns[existing] = turn;
          store.updateTask(taskId, { turns });
          event(task.projectId, 'agent_' + turn.status, taskId, { memberId: turn.memberId, name: turn.name, role: turn.role, round: turn.round, phase: turn.phase });
        } }) : await providers.generate(task.providerId, input);
      if (controller.signal.aborted) return;
      const artifact = store.addArtifact(task.projectId, { taskId, name: 'Research result', content: text(result.text, 200000) });
      if (result.status !== 'completed' && result.complete !== true) {
        store.updateTask(taskId, { status: 'blocked', blockedReason: 'PROVIDER_INCOMPLETE', usage: result.usage || null });
        event(task.projectId, 'worker_incomplete', taskId, 'Partial result saved; not eligible for completion.'); return;
      }
      store.updateTask(taskId, { status: 'awaiting_review', usage: result.usage || null });
      store.addMessage(task.projectId, { role: 'assistant', content: result.text });
      event(task.projectId, 'review_required', taskId, 'Result saved locally. User acceptance is required before completion.');
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = /^[A-Z0-9_:-]{1,80}$/.test(error.code || '') ? error.code : 'PROVIDER_REQUEST_FAILED';
        try { store.updateTask(taskId, { status: 'failed', error: code }); event(task.projectId, 'worker_failed', taskId, code); } catch { /* Missing disk: never create fallback state. */ }
      }
    } finally { controllers.delete(taskId); }
  }
  async function route(req, res) {
    headers(res);
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    // Bootstrap contains no secrets. Session capability arrives only via trusted launch fragment.
    if (req.method === 'GET' && assets.has(url.pathname)) {
      authorizeSource(req, origin);
      const [file, type] = assets.get(url.pathname); res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : type + '; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'ui', file)));
    }
    authorize(req, origin, session, ['POST', 'PATCH', 'PUT'].includes(req.method));
    if (migrating) throw new AppError('STORAGE_MIGRATING', 503);
    health();
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'archive' && parts.length === 4 && req.method === 'POST') {
      const projectId = id(parts[2]); if (!store.getProject(projectId)) throw new AppError('PROJECT_NOT_FOUND', 404);
      const body = await readBody(req, 1024);
      if (typeof body.archived !== 'boolean') throw new AppError('INVALID_ARCHIVE_STATE');
      if (body.archived && store.listTasks(projectId).some(task => controllers.has(task.id) || task.status === 'running')) throw new AppError('STOP_TASKS_BEFORE_ARCHIVE', 409);
      store.setSetting(archiveKey(projectId), body.archived);
      event(projectId, body.archived ? 'project_archived' : 'project_restored', null, 'Local reversible project visibility change');
      return json(res, 200, { archived: body.archived });
    }
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'markdown' && [4, 5].includes(parts.length)) {
      const projectId = id(parts[2]), snapshot = projectSnapshot(projectId);
      if (req.method === 'GET' && parts.length === 4) return json(res, 200, { name: 'MMM-project.md', content: exportProject(snapshot) });
      if (req.method === 'POST' && parts.length === 5 && ['preview', 'import'].includes(parts[4])) {
        const body = await readBody(req, 2 * 1024 * 1024), proposal = importProposal(body.content);
        if (parts[4] === 'preview') return json(res, 200, { tasks: proposal.tasks, warnings: [] });
        requireActive(projectId);
        if (body.confirmLocalOnly !== true) throw new AppError('LOCAL_IMPORT_CONFIRMATION_REQUIRED', 403);
        return json(res, 200, store.importLocalTaskProposals(projectId, proposal.tasks, crypto.createHash('sha256').update(body.content).digest('hex')));
      }
    }
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'team' && parts.length === 4) {
      const projectId = id(parts[2]); if (!store.getProject(projectId)) throw new AppError('PROJECT_NOT_FOUND', 404);
      if (req.method === 'GET') return json(res, 200, store.getSetting('team:' + projectId));
      if (req.method === 'PUT') {
        requireActive(projectId);
        const team = normalizeTeam(await readBody(req, 20000), providerId => providers.get(providerId));
        store.setSetting('team:' + projectId, team); return json(res, 200, team);
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { projects: store.listProjects().filter(project => !archived(project.id)), archivedProjects: store.listProjects().filter(project => archived(project.id)), providers: providers.list(), providerCatalog: catalog(), storage: { directory, status: 'ready', credentials: vault.publicStatus() }, capabilities: { sourceLimits: { maxBatch: MAX_BATCH, maxProject: MAX_PROJECT }, offline: true, api: true, localModel: true, localMail: vault.persistent(), cli: false, gmail: false, mcp: false, ssh: false, browser: false, remotePairing: false, updates: false } });
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sources' && parts.length === 4) {
      const projectId = id(parts[2]); if (!store.getProject(projectId)) throw new AppError('PROJECT_NOT_FOUND', 404);
      requireActive(projectId);
      const body = await readBody(req, 16384);
      if (Object.keys(body).some(key => key !== 'sourceTokens')) throw new AppError('NATIVE_SOURCE_SELECTION_REQUIRED', 403);
      const tokens = body.sourceTokens;
      if (!Array.isArray(tokens) || !tokens.length || tokens.length > MAX_BATCH) throw new AppError('SOURCE_SELECTION_INVALID');
      const selected = sources.resolve(tokens);
      const project = store.addProjectSources(projectId, selected);
      sources.discard(tokens); return json(res, 200, project);
    }
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sources' && parts.length === 6) {
      const projectId = id(parts[2]), sourceId = id(parts[4]);
      if (req.method === 'GET' && parts[5] === 'access') return json(res, 200, sourceAccess.describe(projectId, sourceId));
      if (req.method === 'GET' && parts[5] === 'entries') return json(res, 200, sourceAccess.list(projectId, sourceId, url.searchParams.get('relative') || ''));
      if (req.method === 'GET' && parts[5] === 'content') return json(res, 200, sourceAccess.read(projectId, sourceId, url.searchParams.get('relative') || ''));
      if (req.method === 'POST' && parts[5] === 'revoke') { await readBody(req); return json(res, 200, sourceAccess.revoke(projectId, sourceId)); }
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 3) return json(res, 200, projectSnapshot(parts[2]));
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const body = await readBody(req);
      // Raw renderer paths/legacy imports are not native source-selection grants.
      if (body.sources !== undefined || body.sourcePaths !== undefined) throw new AppError('NATIVE_SOURCE_SELECTION_REQUIRED', 403);
      const tokens = body.sourceTokens ?? [];
      const selected = sources.resolve(tokens);
      const project = store.createProject({ name: text(body.name, 120), sources: selected });
      sources.discard(tokens); return json(res, 201, project);
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4) {
      const projectId = id(parts[2]); if (!store.getProject(projectId)) throw new AppError('PROJECT_NOT_FOUND', 404);
      requireActive(projectId);
      const body = await readBody(req);
      if (parts[3] === 'messages') return json(res, 201, store.addMessage(projectId, { role: 'user', content: text(body.content) }));
      if (parts[3] === 'tasks') {
        const title = text(body.title, 240), description = text(body.description || title);
        if (body.localOnly === true) {
          const task = store.createTask(projectId, { title, description }); event(projectId, 'local_task_created', task.id, title); return json(res, 201, task);
        }
        const team = body.teamDiscussion === true ? normalizeTeam(store.getSetting('team:' + projectId), providerId => providers.get(providerId)) : null;
        if (team && body.confirmedSharing !== true) throw new AppError('PEER_SHARING_CONFIRMATION_REQUIRED', 403);
        if (team) team.bindings = [...new Set(team.members.map(member => member.providerId))].map(providerBinding);
        const providerId = team ? team.members[0].providerId : body.providerId;
        if (!providerId) throw new AppError('CONNECT_AI_FIRST', 409);
        if (!providers.get(id(providerId))) throw new AppError('PROVIDER_NOT_CONFIGURED', 409);
        if (!['public', 'classical', 'non_sensitive'].includes(body.classification) || body.confirmedNonSensitive !== true) throw new AppError('NON_SENSITIVE_CONFIRMATION_REQUIRED', 403);
        if ([...controllers.keys()].length >= 4) throw new AppError('WORKER_LIMIT', 429);
        const task = store.createTask(projectId, { title, description, providerId, classification: body.classification, confirmedNonSensitive: true, ...(team ? { team, confirmedSharing: true } : {}) });
        store.addMessage(projectId, { role: 'user', content: description }); event(projectId, 'requirement_created', task.id, title);
        // Reserve the controller synchronously before accepting another task.
        void execute(task.id).catch(() => {}); return json(res, 202, task);
      }
    }
    if (req.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 3) {
      const taskId = id(parts[2]), task = store.getTask(taskId); if (!task) throw new AppError('TASK_NOT_FOUND', 404);
      const body = await readBody(req);
      if (['pause', 'cancel'].includes(body.action)) {
        if (!['queued', 'running', 'blocked', 'awaiting_authorization', 'paused'].includes(task.status)) throw new AppError('INVALID_TASK_TRANSITION', 409);
        controllers.get(taskId)?.abort(); store.updateTask(taskId, { status: body.action === 'pause' ? 'paused' : 'cancelled',
          ...(task.team ? { turns: (task.turns || []).map(turn => turn.status === 'running' ? { ...turn, status: 'cancelled' } : turn) } : {}) });
      } else if (body.action === 'submit') {
        requireActive(task.projectId);
        if (task.providerId || !['queued', 'paused', 'blocked'].includes(task.status)) throw new AppError('INVALID_TASK_TRANSITION', 409);
        store.addArtifact(task.projectId, { taskId, name: 'Local result', content: text(body.content, 100000) });
        store.updateTask(taskId, { status: 'awaiting_review' });
      } else if (body.action === 'retry') {
        requireActive(task.projectId);
        if (!['failed', 'blocked', 'paused', 'cancelled'].includes(task.status) || controllers.has(taskId)) throw new AppError('INVALID_TASK_TRANSITION', 409);
        if (controllers.size >= 4) throw new AppError('WORKER_LIMIT', 429);
        if (task.providerId) {
          if (task.team && body.confirmedSharing !== true) throw new AppError('PEER_SHARING_CONFIRMATION_REQUIRED', 403);
          if (body.confirmedNonSensitive !== true || !['public', 'classical', 'non_sensitive'].includes(body.classification)) throw new AppError('FRESH_CONSENT_REQUIRED', 403);
          store.updateTask(taskId, { classification: body.classification, confirmedNonSensitive: true, ...(task.team ? { confirmedSharing: true, turns: [] } : {}) });
        }
        store.updateTask(taskId, { status: 'queued', error: '' }); if (task.providerId) void execute(taskId).catch(() => {});
      } else if (body.action === 'approve') {
        requireActive(task.projectId);
        if (task.status !== 'awaiting_review') throw new AppError('INVALID_TASK_TRANSITION', 409);
        store.updateTask(taskId, { status: 'completed', acceptanceEvidence: text(body.acceptanceEvidence || 'User reviewed the saved artifact and accepted the result.', 2000) });
      } else throw new AppError('INVALID_ACTION');
      event(task.projectId, 'task_' + body.action, taskId, body.action); return json(res, 200, store.getTask(taskId));
    }
    if (req.method === 'POST' && url.pathname === '/api/providers') return json(res, 200, providers.configure(await readBody(req, 16384)));
    if (parts[0] === 'api' && parts[1] === 'providers' && parts.length >= 3) {
      const providerId = id(parts[2]);
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'test') {
        const body = await readBody(req, 2048), controller = new AbortController(); probes.add(controller);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', disconnect);
        try { return json(res, 200, await providers.test(providerId, { confirmCost: body.confirmCost === true, signal: controller.signal })); }
        finally { probes.delete(controller); res.off('close', disconnect); }
      }
      if (req.method === 'DELETE' && parts.length === 3) { providers.remove(providerId); return json(res, 200, { ok: true }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/import') { const body = await readBody(req, 2 * 1024 * 1024); return json(res, 200, store.importLegacy(body.payload)); }
    // This archive is deliberately not part of projectSnapshot or provider context.
    if (req.method === 'GET' && url.pathname === '/api/private-mail') return json(res, 200, { records: mail.list() });
    if (req.method === 'POST' && url.pathname === '/api/private-mail') { const body = await readBody(req, 3 * 1024 * 1024); if (body.confirmLocalOnly !== true) throw new AppError('LOCAL_MAIL_CONFIRMATION_REQUIRED'); return json(res, 201, mail.import({ name: body.name, content: body.content })); }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'private-mail' && parts.length === 3) return json(res, 200, mail.read(parts[2]));
    throw new AppError('NOT_FOUND', 404);
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      // Never echo upstream errors, request bodies, credentials or filesystem paths.
      const known = /^[A-Z0-9_:-]{1,80}$/.test(error.code || '');
      json(res, error.status || 400, { error: known ? error.code : 'OPERATION_FAILED' });
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, session, launchUrl: `${origin}/#session=${session}`,
    // Only Electron's sender-validated native picker/drop IPC calls this method.
    // Selection records local references, not read/write or model-context grants.
    registerSources(paths) { if (closing || migrating) throw new AppError('STORAGE_UNAVAILABLE', 503); health(); return sources.register(paths); },
    releaseSources(tokens) { sources.discard(tokens); return { ok: true }; },
    describeSource(projectId, sourceId) { health(); return sourceAccess.describe(id(projectId), id(sourceId)); },
    grantSourceRead(projectId, sourceId) { if (closing || migrating) throw new AppError('STORAGE_UNAVAILABLE', 503); health(); return sourceAccess.grantRead(id(projectId), id(sourceId)); },
    async migrate(target, commit = () => {}) {
      if (controllers.size || providers.active.size || migrating) throw new AppError('STOP_TASKS_BEFORE_MIGRATION', 409);
      migrating = true;
      try {
        const replacement = store.migrate(target); try { commit(target); } catch (error) { replacement.close(); throw error; }
        const previousVault = vault; store.close(); store = replacement; directory = target; sourceAccess = new SourceAccess({ store });
        vault = new CredentialVault({ directory, safeStorage, health }); previousVault.transferSessionTo(vault); previousVault.close();
        providers = new ProviderService({ store, vault, fetchImpl }); mail = new LocalMailArchive({ directory, vault, health }); return { directory, status: 'ready' };
      }
      finally { migrating = false; }
    },
    async close() { closing = true; sources.clear(); for (const controller of [...controllers.values(), ...probes]) controller.abort(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); vault.close(); store.close(); }
  };
}
if (require.main === module) createApplication().then(app => {
  // Launch capability is deliberately shown only to the local operator, never returned over HTTP.
  process.stdout.write(`MMM Community (local only): ${app.launchUrl}\n`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => app.close().then(() => process.exit(0)));
}).catch(() => { process.stderr.write('MMM could not open its selected local storage. No alternate storage was created.\n'); process.exitCode = 1; });
module.exports = { createApplication, defaultDirectory };
