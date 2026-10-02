'use strict';
(() => {
  const { t, translate, setLocale } = window.MMM_I18N;
  const $ = id => document.getElementById(id);
  const state = { projects: [], archivedProjects: [], providers: [], providerCatalog: [], storage: {}, capabilities: {}, selected: null, detail: null, tab: 'conversation', mode: 'note', connected: false };
  let session = '', loadingProject = false, approvalTask = null, resultTask = null, noticeTimer, confirmResolve;
  let sourceSelections = [], sourceEpoch = 0;
  let attachmentBusy = false;
  const fingerprints = new Map();
  const drawerNotice = document.createElement('div'); drawerNotice.id = 'drawer-notice'; drawerNotice.className = 'notice success'; drawerNotice.setAttribute('role', 'status'); drawerNotice.hidden = true;
  const drawerError = document.createElement('div'); drawerError.id = 'drawer-error'; drawerError.className = 'notice error'; drawerError.setAttribute('role', 'alert'); drawerError.hidden = true;
  document.querySelector('.drawer-content').prepend(drawerError, drawerNotice);
  // The per-run local capability is not an AI credential. Keep it only for this
  // origin's tab session so refresh works; never store provider keys here.
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    session = fragment.get('session') || sessionStorage.getItem('mmm.session') || '';
    if (fragment.has('session')) {
      history.replaceState(null, '', location.pathname + location.search);
      sessionStorage.setItem('mmm.session', session);
    }
  } catch { history.replaceState(null, '', location.pathname + location.search); }
  const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([id, row]) => ({ id, ...(typeof row === 'object' ? row : { name: String(row) }) })) : [];
  function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = String(text); if (className) element.className = className; return element; }
  function button(label, action, className = 'button secondary') { const element = node('button', t(label), className); element.type = 'button'; element.addEventListener('click', action); return element; }
  function text(id, value) { $(id).textContent = value; }
  function date(value) { if (!value || Number.isNaN(Date.parse(value))) return ''; return new Intl.DateTimeFormat(window.MMM_I18N.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  function showError(error, target = 'global-error') {
    if (target === 'global-error' && $('settings-dialog').open) target = 'drawer-error';
    if (String(error?.code || '').toUpperCase() === 'FRESH_CONSENT_REQUIRED') error = { uiKey: 'freshConsentRequired' };
    if (String(error?.code || '').toUpperCase().startsWith('TEAM_')) error = { uiKey: String(error.code).includes('SHARING') ? 'teamSharingRequired' : 'teamConfigurationError' };
    if (String(error?.code || '').toUpperCase().startsWith('MARKDOWN_')) error = { uiKey: 'markdownInvalid' };
    const known = { unauthorized: 'sessionRequired', invalid_session: 'sessionRequired', session_required: 'sessionRequired', forbidden: 'sessionRequired', connect_ai_first: 'providerRequired', provider_not_configured: 'providerRequired', provider_not_found: 'providerRequired', provider_required: 'providerRequired', non_sensitive_confirmation_required: 'sensitiveBlocked', sensitive_content: 'sensitiveBlocked', sensitive_content_blocked: 'sensitiveBlocked', artifact_required: 'approvalNeedsEvidence', acceptance_evidence_required: 'approvalNeedsEvidence', completion_evidence_required: 'approvalNeedsEvidence', unavailable: 'unavailableAction', provider_key_required: 'keyRequired', provider_auth_failed: 'providerAuthFailed', provider_rate_limited: 'providerRateLimited', provider_request_budget_exhausted: 'providerBudgetExhausted', invalid_provider_model: 'invalidModel', provider_busy: 'providerBusy', storage_unavailable: 'storageUnavailable', invalid_provider_endpoint: 'invalidEndpoint', provider_endpoint_fixed: 'invalidEndpoint' };
    const code = typeof error === 'string' ? error : error.uiKey || known[String(error.code || '').toLowerCase()] || 'requestFailed';
    text(target, t(code, sourceLimits())); $(target).hidden = false;
  }
  function notice(key) { clearTimeout(noticeTimer); text('global-notice', t(key)); $('global-notice').hidden = false; if ($('settings-dialog').open) { drawerNotice.textContent = t(key); drawerNotice.hidden = false; drawerError.hidden = true; } noticeTimer = setTimeout(() => { $('global-notice').hidden = true; drawerNotice.hidden = true; }, 7000); }
  function connection(online) { state.connected = online; text('connection-status', t(online ? 'online' : 'offline')); $('connection-status').className = `connection-status ${online ? 'online' : 'offline'}`; }
  async function api(path, options = {}) {
    if (!session) throw { uiKey: 'sessionRequired' };
    let response;
    try { response = await fetch(path, { method: options.method || 'GET', headers: { 'x-mmm-session': session, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(options.timeoutMs || 20000) }); }
    catch { connection(false); throw { uiKey: 'connectionError' }; }
    let payload = {}; try { payload = await response.json(); } catch {}
    if (response.status === 401) { session = ''; try { sessionStorage.removeItem('mmm.session'); } catch {} connection(false); throw { uiKey: 'sessionRequired' }; }
    if (!response.ok || payload.ok === false) throw { code: payload.error };
    connection(true); return payload;
  }
  async function busy(form, work, errorTarget = 'global-error') {
    if (form.dataset.busy === 'true') return;
    form.dataset.busy = 'true';
    const controls = [...form.querySelectorAll('button[type="submit"]')];
    controls.forEach(control => { control.disabled = true; control.setAttribute('aria-busy', 'true'); });
    $(errorTarget).hidden = true;
    try { await work(); } catch (error) { showError(error, errorTarget); }
    finally { form.dataset.busy = 'false'; controls.forEach(control => { control.disabled = false; control.removeAttribute('aria-busy'); }); }
  }
  function openDialog(id) { if (!$(id).open) $(id).showModal(); }
  function closeDialog(id) { $(id).close(); }
  function ask(title, description, action = 'confirm') {
    if (confirmResolve) confirmResolve(false);
    text('confirm-title', t(title)); text('confirm-description', t(description)); text('confirm-action', t(action));
    openDialog('confirm-dialog');
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  $('confirm-action').addEventListener('click', () => { const resolve = confirmResolve; confirmResolve = null; closeDialog('confirm-dialog'); resolve?.(true); });
  $('confirm-dialog').addEventListener('close', () => { confirmResolve?.(false); confirmResolve = null; });
  document.querySelectorAll('[data-close]').forEach(element => element.addEventListener('click', () => closeDialog(element.dataset.close)));
  function empty(title, description, symbol = '✧') { const wrap = node('div', undefined, 'empty-state'); const icon = node('span', symbol, 'empty-icon'); icon.setAttribute('aria-hidden', 'true'); wrap.append(icon, node('h3', t(title)), node('p', t(description))); return wrap; }
  function updateRegion(id, value, render, force = false) {
    const key = `${window.MMM_I18N.locale}:${JSON.stringify(value)}`;
    if (!force && (fingerprints.get(id) === key || $(id).contains(document.activeElement))) return;
    render($(id)); fingerprints.set(id, key);
  }
  function badge(status) { const value = String(status || 'unknown'); const safe = ['running', 'queued', 'awaiting_review', 'awaiting_approval', 'completed', 'connected', 'ready', 'failed', 'error'].includes(value) ? value : ''; return node('span', t(value in statusLabels ? value : 'statusUnknown'), `status-badge ${safe}`); }
  const statusLabels = Object.fromEntries(['unknown', 'configured', 'failed', 'completed', 'cancelled', 'paused', 'running', 'queued', 'draft', 'pending', 'awaiting_review', 'awaiting_approval', 'awaiting_authorization', 'approved', 'blocked', 'ready', 'connected', 'disconnected', 'stopping', 'pausing', 'error', 'submitted', 'needs_key', 'not_tested', 'available', 'authenticated', 'rate_limited'].map(key => [key, true]));
  function renderSidebar(force = false) {
    text('project-count', state.projects.length);
    $('project-list-empty').hidden = state.projects.length > 0;
    updateRegion('project-list', [state.projects, state.selected], container => {
      container.replaceChildren();
      for (const project of state.projects) {
        const item = button('unknown', () => selectProject(project.id), `project-nav-item${project.id === state.selected ? ' active' : ''}`);
        item.replaceChildren(node('span', '▧', 'project-nav-icon'), node('span', project.name || project.title || t('projects'), 'project-nav-name'));
        item.title = project.name || project.title || '';
        if (project.id === state.selected) item.setAttribute('aria-current', 'page');
        container.append(item);
      }
    }, force);
  }
  const teamTab = node('button', t('teamTitle'), 'tab'); teamTab.id = 'tab-team'; teamTab.type = 'button'; teamTab.dataset.tab = 'team'; teamTab.dataset.i18n = 'teamTitle'; teamTab.setAttribute('role', 'tab'); teamTab.setAttribute('aria-controls', 'panel-team'); teamTab.setAttribute('aria-selected', 'false'); teamTab.tabIndex = -1; document.querySelector('#project-workspace .tabs').append(teamTab);
  const teamPanel = node('section', undefined, 'tab-panel'); teamPanel.id = 'panel-team'; teamPanel.hidden = true; teamPanel.setAttribute('role', 'tabpanel'); teamPanel.setAttribute('aria-labelledby', 'tab-team'); $('project-workspace').append(teamPanel);
  const workflowSection = node('section', undefined, 'workflow-section'); workflowSection.id = 'workflow-section'; workflowSection.setAttribute('aria-labelledby', 'workflow-title');
  const workflowHeading = node('h2', t('workflowTitle')); workflowHeading.id = 'workflow-title'; workflowHeading.dataset.i18n = 'workflowTitle';
  const workflowHint = node('p', t('workflowRecordedOnly'), 'helper'); workflowHint.dataset.i18n = 'workflowRecordedOnly';
  const workflowList = node('ul', undefined, 'workflow-list'); workflowList.id = 'workflow-list'; workflowSection.append(workflowHeading, workflowHint, workflowList); $('tasks-list').before(workflowSection);
  function switchTab(tab, focus = false) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(item => { const active = item.dataset.tab === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; });
    for (const name of ['conversation', 'tasks', 'artifacts', 'activity', 'team']) $(`panel-${name}`).hidden = name !== tab;
    if (focus) $(`tab-${tab}`).focus();
    updateConversationViewport();
    if (tab === 'conversation') requestAnimationFrame(resizeComposer);
  }
  document.querySelectorAll('[data-tab]').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
    item.addEventListener('keydown', event => { const tabs = ['conversation', 'tasks', 'artifacts', 'activity', 'team']; let index = tabs.indexOf(state.tab); if (event.key === 'ArrowRight') index = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return; event.preventDefault(); switchTab(tabs[index], true); });
  });
  function taskArtifacts(task) { const ids = Array.isArray(task.artifactIds) ? task.artifactIds : []; return list(state.detail?.artifacts).filter(artifact => ids.includes(artifact.id) || artifact.taskId === task.id); }
  function isLocalTask(task) { return !task.team && (task.localOnly === true || task.kind === 'local' || !task.providerId); }
  function renderProject(force = false) {
    const detail = state.detail, wasHidden = $('project-workspace').hidden;
    $('welcome').hidden = Boolean(detail);
    $('project-workspace').hidden = !detail;
    updateConversationViewport();
    if (!detail) { text('breadcrumb-project', t('home')); return; }
    if (wasHidden) requestAnimationFrame(resizeComposer);
    const project = detail.project || state.projects.find(row => row.id === state.selected) || {};
    text('project-title', project.name || project.title || t('projects')); text('breadcrumb-project', project.name || project.title || t('projects'));
    renderProjectSources(project.sources);
    renderTeam();
    const messages = list(detail.messages), tasks = list(detail.tasks), artifacts = list(detail.artifacts), events = list(detail.events);
    renderWorkflow(tasks, artifacts, force);
    text('tasks-count', tasks.length); text('artifacts-count', artifacts.length);
    updateRegion('messages', messages, container => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
      container.replaceChildren();
      if (!messages.length) container.append(empty('noMessagesTitle', 'noMessagesText', '✎'));
      for (const message of messages) { const card = node('article', undefined, 'message'); const meta = node('div', undefined, 'message-meta'); meta.append(node('span', t(['assistant', 'coordinator', 'agent'].includes(message.role) ? 'coordinator' : 'you'), 'message-author'), node('span', '·'), node('time', date(message.createdAt || message.at))); card.append(meta, node('p', message.content || message.text || '', 'message-content')); container.append(card); }
      if (nearBottom) container.scrollTop = container.scrollHeight;
    }, force);
    updateRegion('tasks-list', [tasks, artifacts], container => {
      const expandedTeams = new Set([...container.querySelectorAll('.team-task-detail[open]')].map(element => element.dataset.taskId));
      container.replaceChildren();
      if (!tasks.length) container.append(empty('noTasksTitle', 'noTasksText', '☷'));
      for (const task of [...tasks].reverse()) {
        const card = node('article', undefined, 'task-card'); const top = node('div', undefined, 'card-top'); top.append(node('h3', task.title || t('tasks')), badge(task.status)); card.append(top);
        if (task.description) card.append(node('p', task.description, 'task-description'));
        const meta = node('div', undefined, 'card-meta'); meta.append(node('span', t(isLocalTask(task) ? 'localTask' : 'aiTask')), node('span', date(task.createdAt))); card.append(meta);
        if (task.error) card.append(node('p', t('requestFailed'), 'form-error'));
        if (task.acceptanceEvidence) card.append(node('p', `${t('evidenceLabel')}: ${typeof task.acceptanceEvidence === 'string' ? task.acceptanceEvidence : JSON.stringify(task.acceptanceEvidence)}`, 'task-description'));
        const actions = node('div', undefined, 'card-actions');
        if (isLocalTask(task) && ['queued', 'paused', 'blocked'].includes(task.status)) actions.append(button('submitResult', () => openResult(task), 'button primary'));
        if (['awaiting_review', 'awaiting_approval', 'needs_review'].includes(task.status)) actions.append(button('approve', () => openApproval(task), 'button primary'));
        if (!isLocalTask(task) && ['queued', 'running'].includes(task.status)) actions.append(button('pause', () => taskAction(task, 'pause')));
        if (['failed', 'paused', 'blocked', 'cancelled'].includes(task.status)) actions.append(button('retry', async () => {
          if (isLocalTask(task)) return taskAction(task, 'retry');
          const consent = ask('retryTitle', 'retryDescription', 'retryConsent');
          $('confirm-description').append(node('pre', task.description || task.title || '', 'artifact-preview'));
          if (await consent) {
            if (task.team && !await askTeamSharing()) return;
            taskAction(task, 'retry', { classification: 'non_sensitive', confirmedNonSensitive: true, ...(task.team ? { confirmedSharing: true } : {}) });
          }
        }));
        if (['queued', 'running', 'blocked', 'awaiting_authorization', 'paused'].includes(task.status)) actions.append(button('cancel', async () => { if (await ask('cancelTaskTitle', 'cancelTaskDescription', 'cancel')) taskAction(task, 'cancel'); }, 'button danger-button'));
        if (taskArtifacts(task).length) actions.append(button('viewOutput', () => switchTab('artifacts', true)));
        if (task.team) { const details = teamTaskDetails(task); details.dataset.taskId = task.id; details.open = expandedTeams.has(task.id); card.append(details); }
        card.append(actions); container.append(card);
      }
    }, force);
    updateRegion('artifacts-list', artifacts, container => {
      const opened = new Set([...container.querySelectorAll('details[open]')].map(element => element.dataset.id)); container.replaceChildren();
      if (!artifacts.length) container.append(empty('noArtifactsTitle', 'noArtifactsText', '▧'));
      for (const artifact of [...artifacts].reverse()) { const card = node('article', undefined, 'artifact-card'); card.append(node('h3', artifact.title || artifact.name || t('taskResult'))); const preview = artifactPreview(artifact); if (opened.has(String(artifact.id))) preview.open = true; card.append(preview, button('download', () => downloadArtifact(artifact))); container.append(card); }
    }, force);
    updateRegion('activity-list', events, container => {
      container.replaceChildren(); if (!events.length) { const item = node('li'); item.append(empty('noActivityTitle', 'noActivityText', '◷')); container.append(item); }
      for (const event of [...events].reverse()) { const item = node('li', undefined, 'activity-item'); const content = node('div'); const detailText = typeof event.detail === 'string' ? event.detail : event.detail?.message; content.append(node('p', event.message || detailText || event.title || String(event.type || t('eventUpdated')).replace(/[_.:-]/g, ' ')), node('time', date(event.createdAt || event.at))); const marker = node('span', '', 'activity-marker'); marker.setAttribute('aria-hidden', 'true'); item.append(marker, content); container.append(item); }
    }, force);
  }
  function workflowRecords(task, artifacts) {
    const groups = [];
    for (const turn of Array.isArray(task.turns) ? task.turns : []) {
      const key = `${turn.round}:${turn.phase}`;
      let group = groups.find(value => value.key === key);
      if (!group) { group = { key, round: turn.round, phase: turn.phase, turns: [] }; groups.push(group); }
      group.turns.push(turn);
    }
    const ids = Array.isArray(task.artifactIds) ? task.artifactIds : [];
    return { groups, artifacts: artifacts.filter(artifact => ids.includes(artifact.id) || artifact.taskId === task.id), evidence: task.acceptanceEvidence || null };
  }
  function renderWorkflow(tasks, artifacts, force) {
    updateRegion('workflow-list', [tasks, artifacts], container => {
      const expanded = new Map([...container.querySelectorAll('details[data-workflow-key]')].map(element => [element.dataset.workflowKey, element.open])); container.replaceChildren();
      if (!tasks.length) { container.append(node('li', t('workflowEmpty'), 'helper')); return; }
      const branch = (key, label, initiallyOpen = false) => { const detail = node('details'); detail.dataset.workflowKey = key; detail.open = expanded.has(key) ? expanded.get(key) : initiallyOpen; detail.append(node('summary', label)); return detail; };
      for (const task of tasks) {
        const records = workflowRecords(task, artifacts), item = node('li', undefined, 'workflow-task');
        const detail = branch(`task:${task.id}`, task.title || t('tasks'), ['running', 'awaiting_review'].includes(task.status));
        const summary = detail.querySelector('summary'); summary.append(badge(task.status), node('span', t(isLocalTask(task) ? 'localOnly' : task.team ? 'workflowTeamApi' : 'workflowSingleApi'), 'workflow-mode'));
        const children = node('ul', undefined, 'workflow-branches');
        if (task.providerId) children.append(node('li', `${t('workflowConnection')}: ${task.providerId}`, 'helper'));
        if (!records.groups.length) children.append(node('li', t('workflowNoTurns'), 'helper'));
        for (const group of records.groups) {
          const groupItem = node('li'), groupLabel = `${t('workflowRound', { round: group.round ?? '?' })} · ${t(group.phase === 'synthesis' ? 'teamSynthesis' : group.phase === 'discussion' ? 'workflowDiscussion' : 'statusUnknown')}`;
          const groupDetail = branch(`turns:${task.id}:${group.key}`, groupLabel, group.turns.some(turn => turn.status === 'running')), turns = node('ul', undefined, 'workflow-branches');
          for (const turn of group.turns) {
            const turnItem = node('li', undefined, 'workflow-turn'), line = node('div', undefined, 'workflow-turn-line'); line.append(node('strong', turn.name || turn.memberId || t('coordinator')), badge(turn.status)); turnItem.append(line);
            if (turn.role || turn.providerId) turnItem.append(node('p', [turn.role, turn.providerId].filter(Boolean).join(' · '), 'helper'));
            if (turn.text) { const reply = branch(`reply:${task.id}:${turn.index}`, t('workflowRecordedReply')); reply.append(node('pre', turn.text, 'artifact-preview')); turnItem.append(reply); }
            turns.append(turnItem);
          }
          groupDetail.append(turns); groupItem.append(groupDetail); children.append(groupItem);
        }
        if (records.artifacts.length) { const artifactItem = node('li'), artifactDetails = branch(`artifacts:${task.id}`, t('workflowArtifacts', { count: records.artifacts.length })), artifactList = node('ul', undefined, 'workflow-branches'); for (const artifact of records.artifacts) artifactList.append(node('li', artifact.name || artifact.title || artifact.id)); artifactDetails.append(artifactList, button('viewOutput', () => switchTab('artifacts', true), 'text-button')); artifactItem.append(artifactDetails); children.append(artifactItem); }
        if (records.evidence) { const evidenceItem = node('li'), evidence = branch(`evidence:${task.id}`, t('evidenceLabel')); evidence.append(node('pre', typeof records.evidence === 'string' ? records.evidence : JSON.stringify(records.evidence), 'artifact-preview')); evidenceItem.append(evidence); children.append(evidenceItem); }
        detail.append(children); item.append(detail); container.append(item);
      }
    }, force);
  }
  function artifactContent(artifact) { const value = artifact.content ?? artifact.text ?? artifact.body; return typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : t('outputUnavailable'); }
  function artifactPreview(artifact) { const preview = node('details'); preview.dataset.id = artifact.id; preview.append(node('summary', t('viewOutput')), node('pre', artifactContent(artifact), 'artifact-preview')); return preview; }
  async function downloadArtifact(artifact) {
    const name = `${String(artifact.title || artifact.name || 'mmm-artifact').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 100)}.txt`, content = artifactContent(artifact);
    if (typeof window.mmm?.saveText === 'function') {
      try { const result = await window.mmm.saveText({ name, content }); if (result?.error || result?.saved === false) throw { uiKey: 'requestFailed' }; } catch (error) { showError(error); } return;
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function selectProject(id) { if (state.selected !== id) teamSharing.checked = false; state.selected = id; state.detail = null; fingerprints.clear(); renderSidebar(true); renderProject(true); try { const detail = await api(`/api/projects/${encodeURIComponent(id)}`); if (state.selected !== id) return; state.detail = detail; renderProject(true); } catch (error) { showError(error); } }
  async function refreshProject(force = false) { if (!state.selected || loadingProject) return; const id = state.selected; loadingProject = true; try { const detail = await api(`/api/projects/${encodeURIComponent(id)}`); if (state.selected === id) { state.detail = detail; renderProject(force); } } catch (error) { showError(error); } finally { loadingProject = false; } }
  async function loadState() {
    const data = await api('/api/state'); state.projects = list(data.projects); state.archivedProjects = list(data.archivedProjects); state.providers = list(data.providers); state.providerCatalog = list(data.providerCatalog); state.storage = data.storage || {}; state.capabilities = data.capabilities || {};
    renderSidebar(); renderSettings(); renderProviderOptions(); renderSourceSelections();
    if (state.selected && !state.projects.some(project => project.id === state.selected)) { state.selected = null; state.detail = null; }
    const preferred = data.selectedProjectId || state.projects[0]?.id;
    if (!state.selected && preferred && state.projects.some(project => project.id === preferred)) await selectProject(preferred);
    else renderProject();
  }
  function setMode(mode) {
    state.mode = mode;
    for (const name of ['note', 'local', 'ai']) { const item = $(`mode-${name}`); item.classList.toggle('active', name === mode); item.setAttribute('aria-pressed', String(name === mode)); }
    $('ai-options').hidden = mode !== 'ai'; $('non-sensitive-confirm').required = mode === 'ai';
    updateTeamComposer();
    $('message-input').placeholder = t(mode === 'ai' ? 'aiPlaceholder' : mode === 'local' ? 'localPlaceholder' : 'notePlaceholder');
    text('composer-hint', t(mode === 'ai' ? 'aiHint' : mode === 'local' ? 'localHintComposer' : 'noteHint'));
    text('send-message', t(mode === 'ai' ? 'createAiTask' : mode === 'local' ? 'createLocalTask' : 'saveNote'));
    resizeComposer();
  }
  function resizeComposer() {
    const input = $('message-input'); if (!input.offsetParent) return;
    input.rows = 2; const layout = getComputedStyle(input), lineHeight = parseFloat(layout.lineHeight) || 22;
    const padding = (parseFloat(layout.paddingTop) || 0) + (parseFloat(layout.paddingBottom) || 0);
    input.rows = Math.min(10, Math.max(2, Math.ceil((input.scrollHeight - padding) / lineHeight)));
  }
  function updateConversationViewport() {
    const active = Boolean(state.detail) && state.tab === 'conversation'; document.body.classList.toggle('conversation-view', active);
    if (!active || !window.visualViewport) return;
    // Update the trusted external stylesheet rather than creating inline styles.
    for (const sheet of document.styleSheets) {
      if (!sheet.href || !sheet.href.endsWith('/styles.css')) continue;
      try { const rule = [...sheet.cssRules].find(value => value.selectorText === 'body.conversation-view .app-shell'); if (rule) rule.style.height = `${Math.round(window.visualViewport.height)}px`; } catch { /* 100dvh remains the CSS fallback. */ }
    }
  }
  window.visualViewport?.addEventListener('resize', () => { updateConversationViewport(); resizeComposer(); });
  $('message-input').addEventListener('input', resizeComposer); window.addEventListener('resize', resizeComposer);
  // Local work remains useful before any service is configured.
  const localMode = button('localMode', () => setMode('local'), 'mode-button'); localMode.id = 'mode-local'; localMode.setAttribute('aria-pressed', 'false'); localMode.dataset.i18n = 'localMode'; $('mode-ai').before(localMode);
  $('mode-note').addEventListener('click', () => setMode('note')); $('mode-ai').addEventListener('click', () => setMode('ai'));
  $('composer').addEventListener('submit', event => { event.preventDefault(); busy($('composer'), async () => {
    const content = $('message-input').value.trim(), projectId = state.selected, mode = state.mode;
    if (!content) throw { uiKey: 'emptyContent' };
    if (mode === 'ai' && (!state.providers.length || (!teamDiscussion.checked && !$('task-provider').value))) { openSettings(); throw { uiKey: 'providerRequired' }; }
    if (mode === 'ai' && ($('task-classification').value !== 'non-sensitive' || !$('non-sensitive-confirm').checked)) throw { uiKey: 'sensitiveBlocked' };
    if (mode === 'ai' && teamDiscussion.checked && !teamSharing.checked) throw { uiKey: 'teamSharingRequired' };
    if (mode === 'ai' && teamDiscussion.checked && (!state.detail?.team?.members?.length || teamDirty)) throw { uiKey: 'teamConfigurationError' };
    const base = `/api/projects/${encodeURIComponent(projectId)}`;
    const body = mode === 'note' ? { content } : { title: content.split('\n')[0].slice(0, 120), description: content, ...(mode === 'local' ? { localOnly: true } : { providerId: $('task-provider').value, classification: 'non_sensitive', confirmedNonSensitive: true, ...(teamDiscussion.checked ? { teamDiscussion: true, confirmedSharing: true } : {}) }) };
    await api(`${base}/${mode === 'note' ? 'messages' : 'tasks'}`, { method: 'POST', body });
    // A pending response must not erase a newer draft.
    if ($('message-input').value.trim() === content) $('message-input').value = '';
    resizeComposer();
    $('non-sensitive-confirm').checked = false; teamSharing.checked = false; notice(mode === 'note' ? 'noteSaved' : 'taskCreated');
    if (mode !== 'note') switchTab('tasks'); await refreshProject(true);
  }); });
  function startTask(mode) { switchTab('conversation'); setMode(mode); $('message-input').focus(); }
  $('new-ai-task').addEventListener('click', () => startTask('ai'));
  const newLocal = button('newLocalTask', () => startTask('local')); newLocal.id = 'new-local-task'; newLocal.dataset.i18n = 'newLocalTask'; $('new-ai-task').before(newLocal);
  async function taskAction(task, action, extra = {}) { try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { action, ...extra } }); notice('taskUpdated'); await refreshProject(true); } catch (error) { showError(error); } }
  function openApproval(task) {
    approvalTask = task; $('approval-form').reset(); $('approval-error').hidden = true; $('approval-artifacts').replaceChildren();
    const artifacts = taskArtifacts(task); for (const artifact of artifacts) { const item = node('div', undefined, 'approval-evidence'); item.append(node('strong', artifact.title || artifact.name || t('artifact')), artifactPreview(artifact)); $('approval-artifacts').append(item); }
    if (!artifacts.length) $('approval-artifacts').append(node('p', t('artifactMissing'), 'form-error'));
    $('approval-form').querySelector('button[type="submit"]').disabled = !artifacts.length;
    openDialog('approval-dialog');
  }
  $('approval-form').addEventListener('submit', event => { event.preventDefault(); busy($('approval-form'), async () => {
    const evidence = $('acceptance-evidence').value.trim(); if (!approvalTask || !taskArtifacts(approvalTask).length || !evidence || !$('approval-confirm').checked) throw { uiKey: 'approvalNeedsEvidence' };
    await api(`/api/tasks/${encodeURIComponent(approvalTask.id)}`, { method: 'PATCH', body: { action: 'approve', acceptanceEvidence: evidence } }); closeDialog('approval-dialog'); notice('taskUpdated'); await refreshProject(true);
  }, 'approval-error'); });
  const resultDialog = node('dialog'); resultDialog.id = 'result-dialog'; resultDialog.setAttribute('aria-labelledby', 'result-title'); const resultForm = node('form', undefined, 'dialog-body'); resultForm.id = 'result-form';
  const resultHeading = node('h2', t('resultTitle')); resultHeading.id = 'result-title'; resultHeading.dataset.i18n = 'resultTitle'; const resultDescription = node('p', t('resultDescription')); resultDescription.dataset.i18n = 'resultDescription'; const resultLabel = node('label', t('resultLabel')); resultLabel.htmlFor = 'result-content'; resultLabel.dataset.i18n = 'resultLabel'; const resultInput = node('textarea'); resultInput.id = 'result-content'; resultInput.rows = 7; resultInput.required = true; resultInput.maxLength = 50000; resultInput.placeholder = t('resultPlaceholder'); resultInput.dataset.i18nPlaceholder = 'resultPlaceholder';
  const resultActions = node('div', undefined, 'dialog-actions'); const resultCancel = button('cancel', () => closeDialog('result-dialog')); resultCancel.dataset.i18n = 'cancel'; const resultSubmit = node('button', t('resultSubmit'), 'button primary'); resultSubmit.type = 'submit'; resultSubmit.dataset.i18n = 'resultSubmit'; resultActions.append(resultCancel, resultSubmit); const resultError = node('p', undefined, 'form-error'); resultError.id = 'result-error'; resultError.setAttribute('role', 'alert'); resultError.hidden = true; resultForm.append(resultHeading, resultDescription, resultLabel, resultInput, resultError, resultActions); resultDialog.append(resultForm); document.body.append(resultDialog);
  function openResult(task) { resultTask = task; resultForm.reset(); resultError.hidden = true; openDialog('result-dialog'); }
  resultForm.addEventListener('submit', event => { event.preventDefault(); busy(resultForm, async () => { await api(`/api/tasks/${encodeURIComponent(resultTask.id)}`, { method: 'PATCH', body: { action: 'submit', content: resultInput.value.trim() } }); closeDialog('result-dialog'); notice('resultSaved'); await refreshProject(true); }, 'result-error'); });
  function renderProviderOptions() {
    const selected = $('task-provider').value; $('task-provider').replaceChildren();
    if (!state.providers.length) { const option = node('option', t('noProviderOption')); option.value = ''; $('task-provider').append(option); }
    for (const provider of state.providers) { const option = node('option', `${provider.label || provider.name || provider.kind || provider.id} · ${provider.kind || ''} / ${provider.model || t('model')}`); option.value = provider.id; $('task-provider').append(option); }
    if (state.providers.some(provider => provider.id === selected)) $('task-provider').value = selected;
    text('service-summary', t(state.providers.length ? 'providersCount' : 'noProviders', { count: state.providers.length }));
    for (const id of ['sidebar-connections', 'home-connections']) text(id, t('connectionCount', { count: state.providers.length }));
  }
  function catalogSelected() { return state.providerCatalog.find(provider => String(provider.kind || provider.id) === $('provider-kind').value); }
  function providerDefaults() { const row = catalogSelected(); $('model-options').replaceChildren(); const models = listModels(row?.models || row?.knownModels); for (const model of models) { const option = node('option'); option.value = model; $('model-options').append(option); } $('provider-model').value = row?.defaultModel || models[0] || ''; $('provider-endpoint').value = row?.endpoint || row?.defaultEndpoint || ''; $('provider-endpoint').readOnly = Boolean(row?.endpoint); $('provider-key').required = row?.requiresKey === true; }
  function listModels(models) { return (Array.isArray(models) ? models : []).map(model => typeof model === 'string' ? model : model.id || model.name).filter(Boolean); }
  function renderSettings() {
    renderCliConnections();
    renderWebServices();
    renderArchivedProjects();
    const container = $('providers-list'); container.replaceChildren();
    if (!state.providers.length) container.append(node('p', t('noProviders'), 'helper'));
    for (const provider of state.providers) {
      const row = node('div', undefined, 'provider-row'); const top = node('div', undefined, 'card-top'); top.append(node('h4', provider.label || provider.name || provider.kind || provider.id), badge(provider.state || provider.status || 'configured')); const meta = node('p', `${provider.kind || ''} · ${provider.model || ''}`, 'card-meta'); const actions = node('div', undefined, 'card-actions');
      actions.append(button('test', async () => {
        if (!await ask('providerTestTitle', 'providerTestDescription', 'confirmTest')) return;
        try { const result = await api(`/api/providers/${encodeURIComponent(provider.id)}/test`, { method: 'POST', body: { confirmCost: true }, timeoutMs: 65000 }); await loadState(); if (result.status !== 'completed') throw { uiKey: 'testFailed' }; notice('testSucceeded'); } catch (error) { showError(error, 'provider-error'); $('provider-details').open = true; }
      }), button('disconnect', async () => { if (!await ask('disconnectTitle', 'disconnectDescription', 'disconnect')) return; try { await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' }); notice('providerRemoved'); await loadState(); } catch (error) { showError(error, 'provider-error'); $('provider-details').open = true; } }, 'button danger-button'));
      row.append(top, meta, actions); container.append(row);
    }
    const kind = $('provider-kind').value, signature = JSON.stringify(state.providerCatalog);
    if ($('provider-kind').dataset.catalog !== signature) {
      $('provider-kind').replaceChildren();
      for (const provider of state.providerCatalog) { const option = node('option', provider.label || provider.name || provider.kind || provider.id); option.value = provider.kind || provider.id; $('provider-kind').append(option); }
      if (state.providerCatalog.some(provider => String(provider.kind || provider.id) === kind)) $('provider-kind').value = kind;
      $('provider-kind').dataset.catalog = signature; providerDefaults();
    }
    $('provider-form').querySelector('button[type="submit"]').disabled = state.providerCatalog.length === 0;
    if (!state.providerCatalog.length) text('model-help', t('serviceCatalogEmpty')); else text('model-help', t('modelHelp'));
    text('storage-status', t(state.storage.status && !['error', 'unavailable'].includes(state.storage.status) ? 'storageReady' : 'storageUnavailable'));
    text('storage-directory', state.storage.directory || '');
    const chooseAvailable = typeof window.mmm?.chooseStorage === 'function'; $('choose-storage').disabled = !chooseAvailable; text('storage-availability', t(chooseAvailable ? 'desktopStorageHelp' : 'browserStorageHelp'));
    $('integrations-list').replaceChildren();
    for (const key of ['gmailLabel', 'mcpLabel', 'sshLabel']) { const item = node('div', undefined, 'integration-row'); item.append(node('span', t(key)), node('span', t('unavailable'), 'status-badge')); $('integrations-list').append(item); }
  }
  function openSettings() { placeWebServicesLast(); renderSettings(); openDialog('settings-dialog'); }
  const cliStates = new Map(), cliPending = new Set();
  const cliSection = node('section', undefined, 'settings-section'); cliSection.id = 'cli-connections';
  const cliHeading = node('h3', t('cliAccountsTitle')); cliHeading.dataset.i18n = 'cliAccountsTitle';
  const cliDescription = node('p', t('cliAccountsDescription'), 'muted-copy'); cliDescription.dataset.i18n = 'cliAccountsDescription';
  const cliPermissions = node('p', t('cliPermissions'), 'helper'); cliPermissions.dataset.i18n = 'cliPermissions';
  const cliProfile = node('p', t('cliDedicatedProfile'), 'helper'); cliProfile.dataset.i18n = 'cliDedicatedProfile';
  const cliAdvanced = node('details', undefined, 'advanced-settings'), cliAdvancedTitle = node('summary', t('cliAdvancedDetails')); cliAdvancedTitle.dataset.i18n = 'cliAdvancedDetails'; cliAdvanced.append(cliAdvancedTitle, cliProfile, cliPermissions);
  const cliCards = node('div', undefined, 'providers-list'); cliCards.id = 'cli-cards';
  const cliManualNote = node('p', t('cliManualOnly'), 'helper'); cliManualNote.dataset.i18n = 'cliManualOnly';
  cliSection.append(cliHeading, cliDescription, cliCards, cliManualNote, cliAdvanced); document.querySelector('.drawer-content .settings-section').before(cliSection);
  function cliBridgeAvailable() { return typeof window.mmm?.cliStatus === 'function' && typeof window.mmm?.openCli === 'function'; }
  async function cliAction(kind, action) {
    if (!cliBridgeAvailable() || cliPending.has(kind)) return; cliPending.add(kind); renderCliConnections();
    try {
      if (action === 'status') {
        const result = await window.mmm.cliStatus(kind); if (result?.error || result?.kind !== kind) throw new Error();
        cliStates.set(kind, { platformSupported: result.platformSupported !== false && result.state !== 'unsupported_platform', installed: result.installed === true ? true : result.installed === false ? false : 'unknown', authenticated: result.authenticated === true ? true : result.authenticated === false ? false : 'unknown', official: result.official === true ? true : result.official === false ? false : 'unknown' });
      } else {
        const result = await window.mmm.openCli(kind, action); if (result?.cancelled || result?.canceled) return;
        if (result?.error || result?.opened !== true) throw new Error();
        cliStates.set(kind, { ...cliStates.get(kind), authenticated: 'unknown' }); notice('cliOpened');
      }
    } catch { showError('cliActionFailed'); }
    finally { cliPending.delete(kind); renderCliConnections(); cliCards.querySelector(`[data-cli="${kind}"] button`)?.focus(); }
  }
  function renderCliConnections() {
    cliCards.replaceChildren(); const available = cliBridgeAvailable();
    if (!available) cliCards.append(node('p', t('cliDesktopRequired'), 'helper'));
    for (const [kind, name] of [['codex', 'Codex CLI'], ['claude', 'Claude Code'], ['grok', 'Grok CLI']]) {
      const current = cliStates.get(kind) || {}, pending = cliPending.has(kind), row = node('div', undefined, 'provider-row'); row.dataset.cli = kind;
      const top = node('div', undefined, 'card-top'); top.append(node('h4', name), node('span', t('cliManualBadge'), 'status-badge')); row.append(top);
      const installed = current.platformSupported === false ? 'cliPlatformUnsupported' : current.installed === true ? 'cliInstalled' : current.installed === false ? 'cliNotInstalled' : 'cliInstallationUnknown';
      const authenticated = current.authenticated === true ? 'cliAccountAuthenticated' : current.authenticated === false ? 'cliAccountNotAuthenticated' : 'cliAccountUnknown';
      const status = node('p', `${t(installed)} · ${t(authenticated)}`, 'card-meta'); status.setAttribute('role', 'status'); row.append(status);
      const accountDetails = node('details', undefined, 'advanced-settings'); accountDetails.append(node('summary', t('cliAccountDetails')), node('p', t('cliQuotaUnknown'), 'helper')); row.append(accountDetails);
      if (current.official === false) row.append(node('p', t('cliOfficialUnverified'), 'helper'));
      const actions = node('div', undefined, 'card-actions');
      for (const [label, action] of [['cliDetect', 'status'], ['cliLogin', 'login'], ['cliOpenTerminal', 'terminal'], ['cliCheckStatus', 'status']]) {
        const control = button(label, () => cliAction(kind, action)); control.disabled = !available || pending || ((current.installed === false || current.platformSupported === false) && action !== 'status'); if (pending) control.setAttribute('aria-busy', 'true'); actions.append(control);
      }
      row.append(actions); cliCards.append(row);
    }
  }
  const archivedSection = node('section', undefined, 'settings-section'), archivedDetails = node('details'), archivedSummary = node('summary'), archivedList = node('div', undefined, 'card-list'); archivedList.id = 'archived-projects'; archivedDetails.append(archivedSummary, archivedList); archivedSection.append(archivedDetails); document.querySelector('.drawer-content').append(archivedSection);
  function renderArchivedProjects() {
    archivedSummary.textContent = t('archivedProjects', { count: state.archivedProjects.length }); archivedList.replaceChildren();
    if (!state.archivedProjects.length) archivedList.append(node('p', t('noArchivedProjects'), 'helper'));
    for (const project of state.archivedProjects) {
      const row = node('div', undefined, 'provider-row'); row.append(node('h4', project.name || project.title || t('projects')));
      const restore = button('restoreProject', async () => { restore.disabled = true; try { await api(`/api/projects/${encodeURIComponent(project.id)}/archive`, { method: 'POST', body: { archived: false } }); await loadState(); notice('projectRestored'); } catch (error) { showError(error); } finally { restore.disabled = false; } }); row.append(restore); archivedList.append(row);
    }
  }
  const providerLabelField = node('div', undefined, 'field');
  const providerLabelCaption = node('label', t('connectionLabel')); providerLabelCaption.htmlFor = 'provider-label'; providerLabelCaption.dataset.i18n = 'connectionLabel';
  const providerLabelInput = node('input'); providerLabelInput.id = 'provider-label'; providerLabelInput.maxLength = 80; providerLabelInput.autocomplete = 'off'; providerLabelInput.setAttribute('aria-describedby', 'provider-label-help');
  const providerLabelHelp = node('p', t('connectionLabelHelp'), 'helper'); providerLabelHelp.id = 'provider-label-help'; providerLabelHelp.dataset.i18n = 'connectionLabelHelp';
  providerLabelField.append(providerLabelCaption, providerLabelInput, providerLabelHelp); $('provider-form').prepend(providerLabelField);
  for (const [id, target] of [['sidebar-connections', '.local-card > div'], ['home-connections', '.welcome-footnote']]) {
    const summary = node('p', '', 'connection-summary'); summary.id = id;
    if (id === 'home-connections') document.querySelector(target).after(summary); else document.querySelector(target).append(summary);
  }
  const webServices = node('section', undefined, 'settings-section'); webServices.id = 'web-services';
  const webDetails = node('details'); webDetails.id = 'web-services-details';
  const webTitle = node('summary', t('webServicesTitle')); webTitle.dataset.i18n = 'webServicesTitle';
  const webDescription = node('p', t('webServicesDescription'), 'muted-copy'); webDescription.dataset.i18n = 'webServicesDescription';
  const webLinks = node('div', undefined, 'providers-list');
  const webDestinations = { chatgpt: ['ChatGPT', 'https://chatgpt.com/'], claude: ['Claude', 'https://claude.ai/'], grok: ['Grok', 'https://grok.com/'] };
  function renderWebServices() {
    webLinks.replaceChildren();
    for (const [kind, [name, url]] of Object.entries(webDestinations)) {
      const card = node('div', undefined, 'provider-row'), top = node('div', undefined, 'card-top'); top.append(node('h4', `${name} · ${t('webMode')}`), node('span', t('webManualBadge'), 'status-badge')); card.append(top, node('p', t('webAccountUnknown'), 'helper'));
      const actions = node('div', undefined, 'card-actions');
      for (const [browser, key] of [['chrome', 'webOpenChrome'], ['default', 'webOpenDefault']]) {
        let link;
        if (window.mmm) {
          link = node('button', t(key), 'button secondary'); link.type = 'button'; link.disabled = typeof window.mmm.openService !== 'function';
          link.addEventListener('click', async () => { link.disabled = true; try { const result = await window.mmm.openService(kind, browser); if (result?.error || result?.ok === false) throw new Error(); } catch { showError('webServiceFailed'); } finally { link.disabled = false; } });
        } else if (browser === 'default') { link = node('a', t(key), 'button secondary'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        else { link = node('button', t(key), 'button secondary'); link.type = 'button'; link.disabled = true; link.title = t('webChromeDesktopRequired'); }
        link.setAttribute('aria-label', `${t(key)} · ${name}`); actions.append(link);
      }
      card.append(actions); if (!window.mmm) card.append(node('p', t('webChromeDesktopRequired'), 'helper')); webLinks.append(card);
    }
  }
  webDetails.append(webTitle, webDescription, webLinks); webServices.append(webDetails);
  function placeWebServicesLast() { document.querySelector('.drawer-content').append(webServices); }
  placeWebServicesLast(); document.addEventListener('DOMContentLoaded', placeWebServicesLast, { once: true });
  function newProviderId(kind) { return `${kind.toLowerCase()}-${crypto.randomUUID()}`; }
  $('open-settings').addEventListener('click', openSettings); $('connect-services').addEventListener('click', openSettings); $('provider-kind').addEventListener('change', providerDefaults);
  $('provider-form').addEventListener('submit', event => { event.preventDefault(); busy($('provider-form'), async () => {
    const kind = $('provider-kind').value, key = $('provider-key').value;
    $('provider-key').value = '';
    if (!kind) throw { uiKey: 'unavailableAction' };
    const body = { id: newProviderId(kind), kind, model: $('provider-model').value.trim(), ...(providerLabelInput.value.trim() ? { label: providerLabelInput.value.trim() } : {}), ...(key ? { key } : {}), ...($('provider-endpoint').value.trim() ? { endpoint: $('provider-endpoint').value.trim() } : {}) };
    await api('/api/providers', { method: 'POST', body }); providerLabelInput.value = ''; notice('providerSaved'); $('provider-details').open = false; await loadState();
  }, 'provider-error'); });
  $('settings-dialog').addEventListener('close', () => { $('provider-key').value = ''; });
  $('choose-storage').addEventListener('click', async () => { if (typeof window.mmm?.chooseStorage !== 'function') return; if (!await ask('chooseStorageTitle', 'chooseStorageDescription')) return; try { const result = await window.mmm.chooseStorage(); if (result?.cancelled || result?.canceled) return; if (result?.ok === false || result?.error) throw { uiKey: 'requestFailed' }; notice('storageChanged'); await loadState(); if (state.selected) await refreshProject(true); } catch (error) { showError(error); } });
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files?.[0]; $('import-file').value = ''; if (!file) return;
    if (file.size > 1024 * 1024 || !file.name.toLowerCase().endsWith('.json')) return showError('invalidJson');
    if (!await ask('importTitle', 'importDescription', 'importConfirm')) return;
    try { let payload; try { payload = JSON.parse(await file.text()); } catch { throw { uiKey: 'invalidJson' }; } await api('/api/import', { method: 'POST', body: { payload } }); notice('importSucceeded'); await loadState(); if (state.selected) await refreshProject(true); } catch (error) { showError(error); }
  });
  function localized(tag, key, className) { const element = node(tag, t(key), className); element.dataset.i18n = key; return element; }
  const teamChoice = node('label', undefined, 'checkbox-label'), teamDiscussion = node('input'); teamDiscussion.type = 'checkbox'; teamDiscussion.id = 'team-discussion'; teamChoice.append(teamDiscussion, localized('span', 'teamDiscussion'));
  const teamSharingLabel = node('label', undefined, 'checkbox-label'), teamSharing = node('input'); teamSharing.type = 'checkbox'; teamSharing.id = 'team-sharing'; teamSharingLabel.append(teamSharing, localized('span', 'teamSharingConsent'));
  const teamDisclosure = localized('p', 'teamDisclosure', 'helper');
  const teamConfigure = button('configureTeam', () => switchTab('team', true), 'text-button'); teamConfigure.dataset.i18n = 'configureTeam';
  $('ai-options').append(teamChoice, teamDisclosure, teamConfigure, teamSharingLabel);
  function updateTeamComposer() { const enabled = state.mode === 'ai' && teamDiscussion.checked; teamSharingLabel.hidden = !enabled; teamSharing.required = enabled; teamDisclosure.hidden = !enabled; teamConfigure.hidden = !enabled; $('task-provider').disabled = enabled; }
  teamDiscussion.addEventListener('change', () => { teamSharing.checked = false; updateTeamComposer(); });
  async function askTeamSharing() {
    const consent = ask('teamDiscussion', 'teamDisclosure', 'confirm');
    const label = node('label', undefined, 'checkbox-label'), checkbox = node('input'); checkbox.type = 'checkbox'; label.append(checkbox, node('span', t('teamSharingConsent'))); $('confirm-description').append(label); $('confirm-action').disabled = true;
    checkbox.addEventListener('change', () => { $('confirm-action').disabled = !checkbox.checked; });
    try { return await consent && checkbox.checked; } finally { $('confirm-action').disabled = false; }
  }
  let teamDraft = null, teamProject = null, teamDirty = false, teamSignature = '';
  const teamForm = node('form', undefined, 'team-form'); teamForm.id = 'team-form';
  const teamRows = node('div', undefined, 'team-rows'); teamRows.id = 'team-rows';
  const roundsField = node('label', undefined, 'field'); roundsField.append(localized('span', 'teamRounds')); const teamRounds = node('select'); teamRounds.id = 'team-rounds';
  for (const value of [1, 2, 3]) { const option = node('option', value); option.value = value; teamRounds.append(option); } roundsField.append(teamRounds);
  const teamAdd = button('addAgent', () => { if (teamDraft.members.length >= 8) return; readTeamDraft(); teamDraft.members.push({ id: crypto.randomUUID(), name: '', role: '', providerId: state.providers[0]?.id || '' }); teamDirty = true; renderTeamRows(); }); teamAdd.dataset.i18n = 'addAgent';
  const teamSave = localized('button', 'saveTeam', 'button primary'); teamSave.type = 'submit';
  const teamError = node('p', undefined, 'form-error'); teamError.id = 'team-error'; teamError.hidden = true; teamError.setAttribute('role', 'alert');
  const teamSaved = localized('p', 'teamSaved', 'helper'); teamSaved.id = 'team-saved'; teamSaved.hidden = true; teamSaved.setAttribute('role', 'status');
  const teamActions = node('div', undefined, 'card-actions'); teamActions.append(teamAdd, teamSave);
  function designTeamDraft(providerId, names) {
    return { rounds: 1, members: ['coordinator', 'UI/UX designer', 'engineer', 'reviewer'].map((role, index) => ({ id: crypto.randomUUID(), name: names[index], role, providerId })) };
  }
  const designPreset = button('designPreset', async () => {
    const projectId = state.selected;
    if (!await ask('designPreset', 'designPresetReplace', 'confirm') || state.selected !== projectId) return;
    teamDraft = designTeamDraft('', [t('coordinator'), t('designRole'), t('engineerRole'), t('reviewerRole')]);
    teamDirty = true; teamSaved.hidden = true; teamError.hidden = true; teamSharing.checked = false;
    renderTeamRows(); teamRows.querySelector('input')?.focus();
  }, 'button secondary'); designPreset.id = 'design-team-preset'; designPreset.dataset.i18n = 'designPreset';
  const designPresetPanel = node('div', undefined, 'design-preset');
  designPresetPanel.append(designPreset, localized('p', 'designPresetHint', 'helper'));
  teamForm.append(localized('h2', 'teamTitle'), localized('p', 'teamDescription', 'muted-copy'), designPresetPanel, teamRows, roundsField, localized('p', 'teamDisclosure', 'helper'), teamActions, teamError, teamSaved); teamPanel.append(teamForm);
  function readTeamDraft() {
    if (!teamDraft) return;
    teamDraft.rounds = Number(teamRounds.value);
    for (const row of teamRows.children) { const member = teamDraft.members.find(value => value.id === row.dataset.member); if (!member) continue; member.name = row.querySelector('[data-field="name"]').value.trim(); member.role = row.querySelector('[data-field="role"]').value.trim(); member.providerId = row.querySelector('[data-field="providerId"]').value; }
  }
  function renderTeamRows() {
    teamRows.replaceChildren(); teamRounds.value = teamDraft.rounds; teamAdd.disabled = teamDraft.members.length >= 8;
    teamDraft.members.forEach((member, index) => {
      const row = node('fieldset', undefined, 'team-member'); row.dataset.member = member.id; row.append(node('legend', t('agentNumber', { number: index + 1 })));
      for (const [field, key, limit] of [['name', 'agentName', 64], ['role', 'agentRole', 32]]) { const label = node('label', undefined, 'field'), input = node('input'); input.dataset.field = field; input.maxLength = limit; input.required = true; input.value = field === 'role' && index === 0 ? 'coordinator' : member[field] || ''; input.readOnly = field === 'role' && index === 0; label.append(node('span', t(key)), input); row.append(label); }
      const providerLabel = node('label', undefined, 'field'), select = node('select'); select.dataset.field = 'providerId'; select.required = true;
      const placeholder = node('option', t('noProviderOption')); placeholder.value = ''; select.append(placeholder);
      for (const provider of state.providers) { const option = node('option', `${provider.label || provider.kind} · ${provider.model}`); option.value = provider.id; select.append(option); } select.value = member.providerId || '';
      providerLabel.append(node('span', t('service')), select); row.append(providerLabel);
      if (index) row.append(button('removeAgent', () => { readTeamDraft(); teamDraft.members.splice(index, 1); teamDirty = true; renderTeamRows(); teamAdd.focus(); }, 'button danger-button'));
      teamRows.append(row);
    });
  }
  function renderTeam() {
    const saved = state.detail?.team, signature = JSON.stringify([saved, state.providers, window.MMM_I18N.locale]);
    if (teamProject === state.selected && (teamDirty || teamSignature === signature)) return;
    teamProject = state.selected; teamDirty = false; teamSignature = signature;
    teamDraft = saved?.members?.length ? { rounds: saved.rounds || 1, members: saved.members.map(member => ({ ...member })) } : { rounds: 1, members: [{ id: crypto.randomUUID(), name: t('coordinator'), role: 'coordinator', providerId: state.providers[0]?.id || '' }] };
    teamError.hidden = true; teamSaved.hidden = true; renderTeamRows();
  }
  teamForm.addEventListener('input', () => { teamDirty = true; teamSaved.hidden = true; }); teamForm.addEventListener('change', () => { teamDirty = true; teamSaved.hidden = true; });
  teamForm.addEventListener('submit', event => { event.preventDefault(); busy(teamForm, async () => {
    if (!state.providers.length) throw { uiKey: 'providerRequired' }; readTeamDraft();
    const projectId = state.selected; await api(`/api/projects/${encodeURIComponent(projectId)}/team`, { method: 'PUT', body: teamDraft });
    if (state.selected !== projectId) return; teamDirty = false; teamSignature = ''; await refreshProject(true); teamSaved.hidden = false;
  }, 'team-error'); });
  const projectTools = node('section', undefined, 'settings-section'); projectTools.id = 'project-tools';
  const projectToolActions = node('div', undefined, 'card-actions');
  const exportMarkdown = button('exportMarkdown', async () => {
    const projectId = state.selected; if (!projectId) return; exportMarkdown.disabled = true;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}/markdown`);
      if (typeof result.content !== 'string') throw { uiKey: 'requestFailed' };
      const name = `${String(result.name || 'mmm-project').replace(/\.md$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 100)}.md`;
      if (typeof window.mmm?.saveText === 'function') { const saved = await window.mmm.saveText({ name, content: result.content, format: 'md' }); if (saved?.error || saved?.saved === false) throw { uiKey: 'requestFailed' }; }
      else { const url = URL.createObjectURL(new Blob([result.content], { type: 'text/markdown;charset=utf-8' })), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { showError(error); } finally { exportMarkdown.disabled = false; }
  }); exportMarkdown.id = 'export-markdown'; exportMarkdown.dataset.i18n = 'exportMarkdown';
  const importMarkdown = localized('label', 'importMarkdown', 'button secondary import-button'); importMarkdown.htmlFor = 'import-markdown';
  const markdownInput = node('input', undefined, 'sr-only'); markdownInput.id = 'import-markdown'; markdownInput.type = 'file'; markdownInput.accept = '.md,text/markdown';
  markdownInput.addEventListener('change', async () => {
    const file = markdownInput.files?.[0], projectId = state.selected; markdownInput.value = ''; if (!file || !projectId) return;
    if (file.size > 256 * 1024 || !/\.md$/i.test(file.name)) return showError('markdownInvalid');
    try {
      const content = await file.text(), preview = await api(`/api/projects/${encodeURIComponent(projectId)}/markdown/preview`, { method: 'POST', body: { content } });
      if (!Array.isArray(preview.tasks) || !preview.tasks.length) throw { uiKey: 'markdownNoTasks' };
      if (state.selected !== projectId) return;
      const confirmation = ask('markdownPreviewTitle', 'markdownPreviewDescription', 'markdownConfirm');
      const taskPreview = node('pre', preview.tasks.map((task, index) => `${index + 1}. ${task.title || ''}${task.description ? `\n${task.description}` : ''}`).join('\n\n'), 'artifact-preview'); $('confirm-description').append(taskPreview);
      for (const warning of list(preview.warnings)) if (typeof warning === 'string') $('confirm-description').append(node('span', warning, 'form-error'));
      if (!await confirmation) return;
      await api(`/api/projects/${encodeURIComponent(projectId)}/markdown/import`, { method: 'POST', body: { content, confirmLocalOnly: true } });
      notice('markdownImported'); if (state.selected === projectId) { await refreshProject(true); switchTab('tasks', true); }
    } catch (error) { showError(error); }
  });
  const archiveProject = button('archiveProject', async () => {
    const projectId = state.selected; if (!projectId || !await ask('archiveProject', 'archiveDescription', 'archiveProject')) return;
    archiveProject.disabled = true; try { await api(`/api/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST', body: { archived: true } }); await loadState(); notice('projectArchived'); } catch (error) { showError(error); } finally { archiveProject.disabled = false; }
  }, 'button danger-button'); archiveProject.id = 'archive-project'; archiveProject.dataset.i18n = 'archiveProject';
  projectToolActions.append(exportMarkdown, importMarkdown, markdownInput, archiveProject);
  projectTools.append(localized('h3', 'projectTools'), localized('p', 'markdownHelp', 'helper'), projectToolActions); teamPanel.append(projectTools);
  function teamTaskDetails(task) {
    const detail = node('details', undefined, 'team-task-detail'); detail.append(node('summary', t('teamProgress')));
    const members = list(task.team?.members), turns = list(task.turns);
    detail.append(node('p', t('teamRoundCount', { rounds: task.team?.rounds || 1 }), 'helper'));
    for (const member of members) { const latest = turns.filter(turn => turn.memberId === member.id).at(-1), row = node('div', undefined, 'team-turn'); row.append(node('strong', member.name || member.role), badge(latest?.status || 'pending')); if (latest) row.append(node('p', `${t('teamRoundCount', { rounds: latest.round })} · ${t(latest.phase === 'synthesis' ? 'teamSynthesis' : 'teamDiscussion')}`, 'helper')); if (latest?.text) { const output = node('details'); output.append(node('summary', t('viewOutput')), node('pre', latest.text, 'artifact-preview')); row.append(output); } detail.append(row); }
    return detail;
  }
  const sourceZone = node('div', undefined, 'source-picker'); sourceZone.id = 'source-picker'; sourceZone.setAttribute('role', 'group'); sourceZone.setAttribute('aria-labelledby', 'source-picker-title');
  const sourceTitle = node('h3', t('sourceTitle')); sourceTitle.id = 'source-picker-title'; sourceTitle.dataset.i18n = 'sourceTitle';
  const sourceDescription = node('p', t('sourceDescription'), 'helper'); sourceDescription.dataset.i18n = 'sourceDescription';
  const sourceDropHint = node('p', t('sourceDropHint'), 'source-drop-hint'); sourceDropHint.dataset.i18n = 'sourceDropHint';
  const sourceActions = node('div', undefined, 'source-picker-actions');
  const fileSourceButton = button('chooseSourceFiles', () => chooseSources('file')); fileSourceButton.id = 'choose-source-files'; fileSourceButton.dataset.i18n = 'chooseSourceFiles';
  const folderSourceButton = button('chooseSourceFolders', () => chooseSources('folder')); folderSourceButton.id = 'choose-source-folders'; folderSourceButton.dataset.i18n = 'chooseSourceFolders';
  sourceActions.append(fileSourceButton, folderSourceButton);
  const sourceAvailability = node('p', '', 'helper'); sourceAvailability.id = 'source-availability';
  const sourceCount = node('p', '', 'source-count'); sourceCount.id = 'source-count'; sourceCount.setAttribute('role', 'status');
  const sourceList = node('ul', undefined, 'source-selection-list'); sourceList.id = 'source-selection-list';
  sourceZone.append(sourceTitle, sourceDescription, sourceDropHint, sourceActions, sourceAvailability, sourceCount, sourceList);
  $('project-name').after(sourceZone);
  const projectSources = node('details', undefined, 'project-sources'); projectSources.id = 'project-sources'; projectSources.hidden = true;
  document.querySelector('#project-workspace .tabs').before(projectSources);
  function sourceBridgeAvailable() { return typeof window.mmm?.chooseSources === 'function' && typeof window.mmm?.dropSources === 'function'; }
  const attachmentControls = node('div', undefined, 'composer-attachments');
  const attachFiles = button('attachFiles', () => attachProjectSources('file'), 'button secondary'); attachFiles.id = 'attach-files'; attachFiles.dataset.i18n = 'attachFiles';
  const attachFolders = button('attachFolders', () => attachProjectSources('folder'), 'button secondary'); attachFolders.id = 'attach-folders'; attachFolders.dataset.i18n = 'attachFolders';
  const attachmentHint = node('span', '', 'helper'); attachmentHint.id = 'attachment-hint'; attachmentHint.dataset.i18n = sourceBridgeAvailable() ? 'attachmentReferenceHint' : 'attachmentDesktopRequired'; attachmentHint.textContent = t(attachmentHint.dataset.i18n);
  attachFiles.disabled = attachFolders.disabled = !sourceBridgeAvailable(); attachmentControls.append(attachFiles, attachFolders, attachmentHint); $('message-input').before(attachmentControls); $('composer').setAttribute('aria-describedby', 'attachment-hint');
  async function attachProjectSources(kind, files) {
    const projectId = state.selected; if (!projectId || attachmentBusy) return;
    if (!sourceBridgeAvailable()) return showError('attachmentDesktopRequired');
    if (files && files.length > sourceLimits().maxBatch) return showError('sourceBatchLimit');
    attachmentBusy = true; attachFiles.disabled = attachFolders.disabled = true; let tokens = [];
    try {
      const result = files ? await window.mmm.dropSources(files) : await window.mmm.chooseSources(kind);
      tokens = Array.isArray(result?.sources) ? result.sources.map(source => source?.token).filter(token => typeof token === 'string') : [];
      if (result?.cancelled || result?.canceled || state.selected !== projectId) return;
      if (result?.error || !Array.isArray(result?.sources) || tokens.length !== result.sources.length || !tokens.length) throw { uiKey: 'sourceSelectionFailed' };
      if (tokens.length > sourceLimits().maxBatch) throw { uiKey: 'sourceBatchLimit' };
      await api(`/api/projects/${encodeURIComponent(projectId)}/sources`, { method: 'POST', body: { sourceTokens: tokens } });
      if (state.selected === projectId) { await refreshProject(true); notice('sourceAttached'); }
    } catch (error) { showError(error?.uiKey || 'sourceSelectionFailed'); }
    finally { releaseSourceTokens(tokens); attachmentBusy = false; attachFiles.disabled = attachFolders.disabled = !sourceBridgeAvailable(); }
  }
  $('composer').addEventListener('dragover', event => { if (!hasDraggedFiles(event)) return; event.preventDefault(); event.stopPropagation(); $('composer').classList.add('drag-active'); if (event.dataTransfer) event.dataTransfer.dropEffect = sourceBridgeAvailable() ? 'copy' : 'none'; });
  $('composer').addEventListener('dragleave', event => { if (!$('composer').contains(event.relatedTarget)) $('composer').classList.remove('drag-active'); });
  $('composer').addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); $('composer').classList.remove('drag-active'); const files = [...(event.dataTransfer?.files || [])]; if (files.length) attachProjectSources(null, files); });
  function sourceLimits() {
    const limits = state.capabilities.sourceLimits || {};
    return { maxBatch: Number.isSafeInteger(limits.maxBatch) && limits.maxBatch > 0 ? limits.maxBatch : 100, maxProject: Number.isSafeInteger(limits.maxProject) && limits.maxProject > 0 ? limits.maxProject : 1000 };
  }
  function renderSourceSelections() {
    const available = sourceBridgeAvailable(); fileSourceButton.disabled = !available; folderSourceButton.disabled = !available;
    sourceDropHint.hidden = !available; sourceAvailability.textContent = t(available ? 'sourceReferenceOnly' : 'sourceDesktopRequired');
    sourceCount.textContent = t('sourceCount', { count: sourceSelections.length, ...sourceLimits() }); sourceList.replaceChildren();
    sourceSelections.forEach((source, index) => {
      const item = node('li', undefined, 'source-selection-item'), info = node('div'); info.append(node('strong', source.name), node('span', t(source.kind === 'folder' ? 'sourceFolder' : 'sourceFile'), 'source-kind'), node('p', source.path, 'source-path'));
      const remove = button('removeSource', () => { sourceSelections.splice(index, 1); releaseSourceTokens([source.token]); renderSourceSelections(); const next = sourceList.querySelectorAll('button')[Math.min(index, sourceSelections.length - 1)]; (next || fileSourceButton).focus(); }, 'icon-button'); remove.textContent = '×'; remove.setAttribute('aria-label', t('removeSourceNamed', { name: source.name })); item.append(info, remove); sourceList.append(item);
    });
  }
  function releaseSourceTokens(tokens) {
    if (typeof window.mmm?.releaseSources !== 'function') return;
    const retained = new Set(sourceSelections.map(source => source.token));
    const unused = [...new Set(tokens.filter(token => typeof token === 'string' && !retained.has(token)))];
    if (!unused.length) return;
    try { Promise.resolve(window.mmm.releaseSources(unused)).catch(() => {}); } catch { /* Expiration still bounds grants when native cleanup is unavailable. */ }
  }
  function resetSources() { sourceEpoch++; const unused = sourceSelections.map(source => source.token); sourceSelections = []; releaseSourceTokens(unused); sourceZone.classList.remove('drag-active'); renderSourceSelections(); }
  function acceptSources(result, epoch) {
    const incomingTokens = Array.isArray(result?.sources) ? result.sources.map(source => source?.token) : [];
    if (epoch !== sourceEpoch || !$('project-dialog').open || result?.cancelled) { releaseSourceTokens(incomingTokens); return; }
    if (result?.error || !Array.isArray(result?.sources)) { releaseSourceTokens(incomingTokens); throw { uiKey: 'sourceSelectionFailed' }; }
    const valid = result.sources.filter(source => source && typeof source.token === 'string' && typeof source.name === 'string' && typeof source.path === 'string' && ['file', 'folder'].includes(source.kind));
    if (valid.length !== result.sources.length) { releaseSourceTokens(incomingTokens); throw { uiKey: 'sourceSelectionFailed' }; }
    if (valid.length > sourceLimits().maxBatch) { releaseSourceTokens(incomingTokens); throw { uiKey: 'sourceBatchLimit' }; }
    const seen = new Set(sourceSelections.map(source => source.path));
    const added = valid.filter(source => { if (seen.has(source.path)) return false; seen.add(source.path); return true; });
    if (sourceSelections.length + added.length > sourceLimits().maxProject) { releaseSourceTokens(incomingTokens); throw { uiKey: 'sourceLimit' }; }
    sourceSelections.push(...added.map(source => ({ ...source, selectedAt: Date.now() })));
    releaseSourceTokens(incomingTokens);
    if (!$('project-name').value.trim() && sourceSelections.length) { const first = sourceSelections[0]; $('project-name').value = (first.kind === 'file' ? first.name.replace(/\.[^.]+$/, '') : first.name).slice(0, 120); }
    renderSourceSelections();
  }
  async function chooseSources(kind) {
    if (!sourceBridgeAvailable()) return showError('sourceDesktopRequired', 'project-error');
    const epoch = sourceEpoch; $('project-error').hidden = true;
    try { acceptSources(await window.mmm.chooseSources(kind), epoch); } catch (error) { if (epoch === sourceEpoch) showError(error.uiKey || 'sourceSelectionFailed', 'project-error'); }
  }
  function hasDraggedFiles(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
  document.addEventListener('dragover', event => { if (hasDraggedFiles(event)) event.preventDefault(); });
  document.addEventListener('drop', event => { if (hasDraggedFiles(event)) event.preventDefault(); });
  sourceZone.addEventListener('dragover', event => { if (!hasDraggedFiles(event)) return; event.preventDefault(); event.stopPropagation(); sourceZone.classList.add('drag-active'); if (event.dataTransfer) event.dataTransfer.dropEffect = sourceBridgeAvailable() ? 'copy' : 'none'; });
  sourceZone.addEventListener('dragleave', event => { if (!sourceZone.contains(event.relatedTarget)) sourceZone.classList.remove('drag-active'); });
  sourceZone.addEventListener('drop', async event => {
    event.preventDefault(); event.stopPropagation(); sourceZone.classList.remove('drag-active');
    if (!sourceBridgeAvailable()) return showError('sourceDesktopRequired', 'project-error');
    const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return;
    if (files.length > sourceLimits().maxBatch) return showError('sourceBatchLimit', 'project-error');
    const epoch = sourceEpoch; $('project-error').hidden = true;
    try { acceptSources(await window.mmm.dropSources(files), epoch); } catch (error) { if (epoch === sourceEpoch) showError(error.uiKey || 'sourceSelectionFailed', 'project-error'); }
  });
  function sourceTokensForRequest() {
    if (sourceSelections.some(source => Date.now() - source.selectedAt >= 30 * 60 * 1000)) { resetSources(); throw { uiKey: 'sourceSelectionExpired' }; }
    return sourceSelections.map(source => source.token);
  }
  const sourceDialog = node('dialog', undefined, 'source-access-dialog'); sourceDialog.id = 'source-access-dialog'; sourceDialog.setAttribute('aria-labelledby', 'source-access-title');
  const sourceBody = node('div', undefined, 'dialog-body'), sourceHeader = node('div', undefined, 'dialog-header'), sourceHeading = node('h2'); sourceHeading.id = 'source-access-title';
  const sourceClose = button('close', () => sourceDialog.close(), 'icon-button'); sourceClose.textContent = '×'; sourceClose.dataset.i18nAria = 'close'; sourceClose.setAttribute('aria-label', t('close')); sourceHeader.append(sourceHeading, sourceClose);
  const sourcePermission = node('p', '', 'helper'), sourceControls = node('div', undefined, 'card-actions'), sourceResults = node('div', undefined, 'source-results'), sourceAccessError = node('p', undefined, 'form-error'); sourceAccessError.id = 'source-access-error'; sourceAccessError.setAttribute('role', 'alert'); sourceAccessError.hidden = true;
  sourceBody.append(sourceHeader, localized('p', 'sourcePreviewPrivacy', 'muted-copy'), sourcePermission, sourceControls, sourceAccessError, sourceResults); sourceDialog.append(sourceBody); document.body.append(sourceDialog);
  let activeSource = null, sourceAccessEpoch = 0;
  function sourceApiPath() { return `/api/projects/${encodeURIComponent(activeSource.projectId)}/sources/${encodeURIComponent(activeSource.id)}`; }
  async function sourceOperation(work, display) {
    const epoch = ++sourceAccessEpoch; sourceAccessError.hidden = true;
    try { const result = await work(); if (epoch !== sourceAccessEpoch || !sourceDialog.open) return; display(result); }
    catch { if (epoch === sourceAccessEpoch && sourceDialog.open) showError('sourceReadFailed', 'source-access-error'); }
  }
  function renderSourceAccess(view) {
    activeSource = { ...activeSource, ...view }; sourceResults.replaceChildren(); sourceControls.replaceChildren();
    const granted = view.permission?.mode === 'read-local' && view.permission?.granted;
    sourcePermission.textContent = t(granted ? 'sourceReadGranted' : 'sourceReferenceOnly');
    if (granted) {
      sourceControls.append(button('revokeSourceRead', () => { sourceResults.replaceChildren(); sourceOperation(() => api(`${sourceApiPath()}/revoke`, { method: 'POST', body: {} }), () => renderSourceAccess({ permission: { mode: 'reference-only', granted: false } })); }, 'button danger-button'));
      sourceControls.append(button(activeSource.kind === 'folder' ? 'listSourceEntries' : 'previewSource', () => activeSource.kind === 'folder' ? listSourceEntries('') : previewSource('')));
    } else {
      const grant = button('grantSourceRead', () => sourceOperation(async () => { const result = await window.mmm.grantSourceRead(activeSource.projectId, activeSource.id); if (result?.error) throw new Error(); return result; }, result => { if (!result?.cancelled && !result?.canceled) renderSourceAccess(result); }));
      grant.disabled = typeof window.mmm?.grantSourceRead !== 'function'; sourceControls.append(grant);
      if (grant.disabled) sourceControls.append(node('p', t('sourceGrantDesktop'), 'helper'));
    }
  }
  function listSourceEntries(relative) {
    sourceResults.replaceChildren(); sourceOperation(() => api(`${sourceApiPath()}/entries?relative=${encodeURIComponent(relative)}`), result => {
      if (relative) sourceResults.append(button('sourceRoot', () => listSourceEntries('')));
      const entries = node('ul', undefined, 'source-entry-list');
      for (const entry of list(result.entries)) { const row = node('li'); row.append(node('span', entry.name)); const folder = ['folder', 'directory'].includes(entry.kind); row.append(button(folder ? 'listSourceEntries' : 'previewSource', () => folder ? listSourceEntries(entry.relative) : previewSource(entry.relative))); entries.append(row); }
      sourceResults.append(entries); if (!result.entries?.length) sourceResults.append(node('p', t('sourceEmpty'), 'helper')); if (result.truncated) sourceResults.append(node('p', t('sourceTruncated'), 'helper'));
    });
  }
  function previewSource(relative) {
    sourceResults.replaceChildren(); sourceOperation(() => api(`${sourceApiPath()}/content?relative=${encodeURIComponent(relative)}`), result => {
      if (activeSource.kind === 'folder') sourceResults.append(button('sourceRoot', () => listSourceEntries('')));
      sourceResults.append(node('pre', typeof result.content === 'string' ? result.content : '', 'artifact-preview'));
    });
  }
  function openSourceAccess(source) {
    activeSource = { ...source, projectId: state.selected }; sourceHeading.textContent = source.name || t('sourceFile'); sourceControls.replaceChildren(); sourceResults.replaceChildren(); sourcePermission.textContent = t('sourcePermissionLoading'); sourceAccessError.hidden = true; sourceDialog.showModal();
    sourceOperation(() => api(`${sourceApiPath()}/access`), renderSourceAccess);
  }
  sourceDialog.addEventListener('close', () => { sourceAccessEpoch++; activeSource = null; sourceResults.replaceChildren(); sourceControls.replaceChildren(); });
  function renderProjectSources(sources) {
    const rows = Array.isArray(sources) ? sources : []; projectSources.hidden = !rows.length;
    const signature = `${window.MMM_I18N.locale}:${JSON.stringify(rows)}`; if (projectSources.dataset.signature === signature) return;
    projectSources.dataset.signature = signature; projectSources.replaceChildren(node('summary', t('projectSources', { count: rows.length })), node('p', t('sourcePreviewPrivacy'), 'helper'));
    const container = node('ul', undefined, 'source-selection-list');
    for (const source of rows) { const item = node('li', undefined, 'source-reference-item'); item.append(node('strong', source.name || t('sourceFile')), node('span', t(source.kind === 'folder' ? 'sourceFolder' : 'sourceFile'), 'source-kind'), node('p', source.path || '', 'source-path'), button('sourceAccess', () => openSourceAccess(source))); container.append(item); }
    projectSources.append(container);
  }
  $('project-dialog').addEventListener('close', resetSources);
  function newProject() { $('project-form').reset(); resetSources(); $('project-error').hidden = true; openDialog('project-dialog'); $('project-name').focus(); }
  $('new-project').addEventListener('click', newProject); $('welcome-create').addEventListener('click', newProject);
  $('project-form').addEventListener('submit', event => { event.preventDefault(); busy($('project-form'), async () => { const name = $('project-name').value.trim(); if (!name) return; const result = await api('/api/projects', { method: 'POST', body: { name, sourceTokens: sourceTokensForRequest() } }); closeDialog('project-dialog'); await loadState(); const id = result.project?.id || result.id; if (id) await selectProject(id); switchTab('conversation'); notice('projectCreated'); }, 'project-error'); });
  $('home-link').addEventListener('click', event => { event.preventDefault(); state.selected = null; state.detail = null; renderSidebar(true); renderProject(true); });
  function finishOnboarding(settings = false) { try { localStorage.setItem('mmm.onboarded', 'true'); } catch {} closeDialog('onboarding-dialog'); if (settings) openSettings(); }
  $('onboarding-start').addEventListener('click', () => finishOnboarding()); $('onboarding-skip').addEventListener('click', () => finishOnboarding()); $('onboarding-connect').addEventListener('click', () => finishOnboarding(true)); $('onboarding-dialog').addEventListener('cancel', () => { try { localStorage.setItem('mmm.onboarded', 'true'); } catch {} });
  $('show-onboarding').addEventListener('click', () => { closeDialog('settings-dialog'); openDialog('onboarding-dialog'); });
  function changeLanguage(value) { readTeamDraft(); setLocale(value); $('language').value = value; $('onboarding-language').value = value; fingerprints.clear(); renderSidebar(true); renderProject(true); if (teamDraft) renderTeamRows(); renderSettings(); renderProviderOptions(); renderSourceSelections(); setMode(state.mode); connection(state.connected); }
  $('language').addEventListener('change', event => changeLanguage(event.target.value)); $('onboarding-language').addEventListener('change', event => changeLanguage(event.target.value));
  document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); newProject(); } });
  translate(); $('language').value = window.MMM_I18N.locale; $('onboarding-language').value = window.MMM_I18N.locale; setMode('note'); renderSettings(); renderProviderOptions(); renderSourceSelections();
  let firstVisit = true; try { firstVisit = localStorage.getItem('mmm.onboarded') !== 'true'; } catch {} if (firstVisit) openDialog('onboarding-dialog');
  loadState().catch(error => showError(error));
  setInterval(() => { if (!document.hidden && session && state.selected) refreshProject(); }, 2000);
})();
