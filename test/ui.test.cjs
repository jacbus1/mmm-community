'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = path.join(__dirname, '..', 'ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
const translations = fs.readFileSync(path.join(ui, 'i18n.js'), 'utf8');

test('prototype fixture is explicitly fictional, inert and separate from the live workspace', () => {
  const fixture = html.match(/<template id="synthetic-prototype">([\s\S]*?)<\/template>/)?.[1];
  assert.ok(fixture);
  assert.match(fixture, /synthetic-only/);
  assert.match(fixture, /fictional project/);
  assert.match(fixture, /data-status="draft"/);
  assert.doesNotMatch(app, /synthetic-prototype|Weekend reading plan/);
  assert.match(app, /localOnly: true/);
  assert.match(app, /action: 'submit', content:/);
});

test('all fixed UI copy resolves in each supported language', () => {
  const context = { window: {}, document: { querySelectorAll: () => [], documentElement: {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(translations, context);
  const keys = new Set([
    ...Array.from(html.matchAll(/data-i18n(?:-aria|-placeholder)?="([\w]+)"/g), match => match[1]),
    ...Array.from(app.matchAll(/\bt\('([\w]+)'/g), match => match[1]),
    ...Array.from(app.matchAll(/localized\('\w+', '([\w]+)'/g), match => match[1]),
  ]);
  for (const language of ['zh-Hant', 'zh-Hans', 'en']) {
    context.window.MMM_I18N.setLocale(language);
    assert.equal(context.document.documentElement.lang, language);
    for (const key of keys) assert.notEqual(context.window.MMM_I18N.t(key), key, `${language}: ${key}`);
    assert.match(context.window.MMM_I18N.t('invalidJson'), /1 MB/);
  }
});

test('browser code uses safe text rendering and external CSP-compatible assets', () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(|\beval\(/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\son\w+\s*=|\sstyle\s*=/i);
  assert.match(html, /<script src="\/mail.js" defer><\/script>/);
  new vm.Script(app);
});

test('preferences do not persist provider credentials or conversations', () => {
  const storedKeys = [...app.matchAll(/(?:localStorage|sessionStorage)\.setItem\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(storedKeys)].sort(), ['mmm.onboarded', 'mmm.session']);
  assert.match(app, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
  assert.match(app, /sessionStorage\.removeItem\('mmm.session'\)/);
  assert.match(app, /\$\('provider-key'\)\.value = ''/);
});

test('AI submission and local result acceptance require explicit user input', () => {
  assert.match(app, /setMode\('note'\)/);
  assert.match(app, /classification: 'non_sensitive', confirmedNonSensitive: true/);
  assert.match(app, /confirmCost: true/);
  assert.match(html, /id="acceptance-evidence"[^>]*maxlength="2000"[^>]*required/);
  assert.match(html, /id="approval-confirm" type="checkbox" required/);
  assert.doesNotMatch(html, /id="non-sensitive-confirm"[^>]*\schecked/);
});

test('AI retries renew content consent while local retries remain offline', () => {
  assert.match(app, /if \(isLocalTask\(task\)\) return taskAction\(task, 'retry'\)/);
  assert.match(app, /ask\('retryTitle', 'retryDescription', 'retryConsent'\)/);
  assert.match(app, /node\('pre', task\.description \|\| task\.title \|\| '', 'artifact-preview'\)/);
  assert.match(app, /if \(task.team && !await askTeamSharing\(\)\) return/);
  assert.match(app, /taskAction\(task, 'retry', \{ classification: 'non_sensitive', confirmedNonSensitive: true, .*confirmedSharing: true/);
  assert.match(app, /FRESH_CONSENT_REQUIRED/);
  assert.match(app, /confirmCost: true \}, timeoutMs: 65000/);
  assert.match(app, /AbortSignal\.timeout\(options\.timeoutMs \|\| 20000\)/);
  const context = { window: {}, document: { querySelectorAll: () => [], documentElement: {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(translations, context);
  for (const language of ['zh-Hant', 'zh-Hans', 'en']) {
    context.window.MMM_I18N.setLocale(language);
    for (const key of ['retryConsent', 'freshConsentRequired']) assert.notEqual(context.window.MMM_I18N.t(key), key);
  }
  context.window.MMM_I18N.setLocale('en');
  assert.match(context.window.MMM_I18N.t('retryDescription'), /no keys, personal information, or private data/);
});

test('optional project sources use only desktop grants and do not read source bytes', () => {
  const sourceCode = app.slice(app.indexOf('const sourceZone ='), app.indexOf("$('new-project').addEventListener"));
  assert.match(sourceCode, /window\.mmm\.chooseSources\(kind\)/);
  assert.match(sourceCode, /window\.mmm\.dropSources\(files\)/);
  assert.doesNotMatch(sourceCode, /FileReader|\.text\(|\.arrayBuffer\(|readAs|fetch\(/);
  assert.match(app, /sourceTokens: sourceTokensForRequest\(\)/);
  assert.match(sourceCode, /if \(!\$\('project-name'\)\.value\.trim\(\) && sourceSelections\.length\)/);
  assert.match(sourceCode, /sourceSelections\.length \+ added\.length > sourceLimits\(\)\.maxProject/);
  assert.match(sourceCode, /30 \* 60 \* 1000/);
  assert.match(sourceCode, /'close', resetSources/);
  assert.match(sourceCode, /document\.addEventListener\('drop'/);
  assert.match(sourceCode, /window\.mmm\.releaseSources\(unused\)/);
  assert.match(sourceCode, /!retained\.has\(token\)/);
  assert.match(sourceCode, /sourceSelections\.splice\(index, 1\); releaseSourceTokens\(\[source\.token\]\)/);
  assert.match(sourceCode, /sourceSelections = \[\]; releaseSourceTokens\(unused\)/);
  assert.match(sourceCode, /result\?\.cancelled\) \{ releaseSourceTokens\(incomingTokens\); return; \}/);
  assert.match(sourceCode, /sourceSelections\.length \+ added\.length > sourceLimits\(\)\.maxProject\) \{ releaseSourceTokens\(incomingTokens\)/);
  assert.match(sourceCode, /valid\.length > sourceLimits\(\)\.maxBatch/);
  assert.match(sourceCode, /files\.length > sourceLimits\(\)\.maxBatch/);
});

test('same-provider connections receive distinct IDs and retain per-connection actions', () => {
  const factory = app.match(/function newProviderId\(kind\) \{[^\n]+\}/)?.[0];
  assert.ok(factory);
  const context = { crypto: require('node:crypto').webcrypto };
  vm.runInNewContext(factory, context);
  const ids = Array.from({ length: 100 }, () => context.newProviderId('HuggingFace'));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) { assert.match(id, /^huggingface-[a-f0-9-]{36}$/); assert.ok(id.length <= 48); }
  assert.match(app, /id: newProviderId\(kind\)/);
  assert.match(app, /label: providerLabelInput\.value\.trim\(\)/);
  assert.match(app, /encodeURIComponent\(provider\.id\)\}\/test/);
  assert.match(app, /provider\.label \|\| provider\.name/);
});

test('source limits accept capability values and default to 100 per batch, 1000 per project', () => {
  const source = app.match(/function sourceLimits\(\) \{[\s\S]*?\n  \}/)?.[0];
  const context = { state: { capabilities: {} } };
  vm.runInNewContext(source, context);
  assert.equal(context.sourceLimits().maxBatch, 100);
  assert.equal(context.sourceLimits().maxProject, 1000);
  context.state.capabilities.sourceLimits = { maxBatch: 50, maxProject: 500 };
  assert.equal(context.sourceLimits().maxBatch, 50);
  assert.equal(context.sourceLimits().maxProject, 500);
  context.state.capabilities.sourceLimits = { maxBatch: -1, maxProject: 'invalid' };
  assert.equal(context.sourceLimits().maxBatch, 100);
  assert.equal(context.sourceLimits().maxProject, 1000);
});

test('manual website sign-in is separate from API configuration with fixed destinations', () => {
  const webCode = app.slice(app.indexOf('const webServices ='), app.indexOf('function newProviderId'));
  for (const url of ['https://chatgpt.com/', 'https://claude.ai/', 'https://grok.com/']) assert.ok(webCode.includes(url));
  assert.match(webCode, /window\.mmm\.openService\(kind, browser\)/);
  assert.match(webCode, /\['chrome', 'webOpenChrome'\], \['default', 'webOpenDefault'\]/);
  assert.match(webCode, /else if \(browser === 'default'\)/);
  assert.match(webCode, /link.disabled = true; link.title = t\('webChromeDesktopRequired'\)/);
  assert.match(webCode, /link\.target = '_blank'; link\.rel = 'noopener noreferrer'/);
  assert.doesNotMatch(webCode, /api\(|state\.providers|localStorage|sessionStorage|window\.open/);
  const context = { window: {}, document: { querySelectorAll: () => [], documentElement: {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(translations, context);
  for (const language of ['en', 'zh-Hant', 'zh-Hans']) { context.window.MMM_I18N.setLocale(language); for (const key of ['webOpenChrome', 'webOpenDefault', 'webChromeDesktopRequired']) assert.notEqual(context.window.MMM_I18N.t(key), key); }
});

test('source previews require explicit access actions and never enter the task payload', () => {
  const open = app.match(/function openSourceAccess\(source\) \{[\s\S]*?\n  \}/)?.[0];
  assert.match(open, /\/access/);
  assert.doesNotMatch(open, /\/content|\/entries/);
  assert.match(app, /view\.permission\?\.mode === 'read-local' && view\.permission\?\.granted/);
  assert.match(app, /window\.mmm\.grantSourceRead\(activeSource.projectId, activeSource.id\)/);
  assert.match(app, /\/revoke.*method: 'POST'/);
  assert.match(app, /sourceDialog.addEventListener\('close',.*sourceAccessEpoch\+\+.*sourceResults.replaceChildren/);
  const payload = app.match(/const body = mode === 'note'[^\n]+/)?.[0];
  assert.doesNotMatch(payload, /source|path|permission|preview/i);
});

test('team tasks use separate unchecked sharing consent and bounded configuration', () => {
  assert.match(app, /teamDraft.members.length >= 8/);
  assert.match(app, /for \(const value of \[1, 2, 3\]\)/);
  assert.match(app, /input.readOnly = field === 'role' && index === 0/);
  assert.match(app, /teamDiscussion.checked && !teamSharing.checked/);
  assert.match(app, /teamDiscussion: true, confirmedSharing: true/);
  assert.doesNotMatch(app, /teamSharing.checked = true/);
  assert.match(app, /confirmedNonSensitive: true/);
  assert.match(app, /method: 'PUT', body: teamDraft/);
  assert.match(app, /teamDirty \|\| teamSignature === signature/);
  assert.match(app, /turn.memberId === member.id/);
});

test('archive and restore use reversible project state without delete calls', () => {
  assert.match(app, /state.archivedProjects = list\(data.archivedProjects\)/);
  assert.match(app, /body: \{ archived: true \}/);
  assert.match(app, /body: \{ archived: false \}/);
  assert.match(app, /ask\('archiveProject', 'archiveDescription', 'archiveProject'\)/);
  assert.doesNotMatch(app, /api\(`\/api\/projects\/[^\n]+method: 'DELETE'/);
});

test('Markdown exchange requires selected bounded file, preview and explicit local-only confirmation', () => {
  const markdown = app.slice(app.indexOf('const projectTools ='), app.indexOf('function teamTaskDetails'));
  assert.match(markdown, /file.size > 256 \* 1024/);
  assert.match(markdown, /const content = await file.text\(\), preview = await api/);
  assert.match(markdown, /\/markdown\/preview.*method: 'POST', body: \{ content \}/);
  assert.match(markdown, /if \(!await confirmation\) return/);
  assert.match(markdown, /\/markdown\/import.*confirmLocalOnly: true/);
  assert.match(markdown, /window.mmm.saveText\(\{ name, content: result.content, format: 'md' \}\)/);
  assert.doesNotMatch(markdown, /confirmedNonSensitive|confirmedSharing|teamDiscussion|providerId|localStorage|sessionStorage|\/tasks/);
  const preview = markdown.indexOf('/markdown/preview'), confirmation = markdown.indexOf('if (!await confirmation) return'), imported = markdown.indexOf('/markdown/import');
  assert.ok(preview < confirmation && confirmation < imported);
});

test('CLI account connections use only native manual actions, not API provider state', () => {
  const cli = app.slice(app.indexOf('const cliStates ='), app.indexOf('const archivedSection ='));
  assert.match(cli, /window.mmm.cliStatus\(kind\)/);
  assert.match(cli, /window.mmm.openCli\(kind, action\)/);
  assert.match(cli, /authenticated: 'unknown'/);
  assert.match(cli, /result.authenticated === true \? true/);
  assert.match(cli, /cliDesktopRequired/);
  assert.match(cli, /cliDedicatedProfile/);
  assert.match(cli, /\.drawer-content \.settings-section'\).before\(cliSection\)/);
  assert.doesNotMatch(cli, /api\(|state.providers|providerId|localStorage|sessionStorage|fetch\(|window.open/);
  const context = { window: {}, document: { querySelectorAll: () => [], documentElement: {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(translations, context);
  for (const language of ['en', 'zh-Hant', 'zh-Hans']) {
    context.window.MMM_I18N.setLocale(language);
    for (const key of ['cliAccountsTitle', 'cliAccountsDescription', 'cliPermissions', 'cliManualOnly', 'cliDesktopRequired', 'cliInstalled', 'cliNotInstalled', 'cliInstallationUnknown', 'cliAccountAuthenticated', 'cliAccountNotAuthenticated', 'cliAccountUnknown', 'cliQuotaUnknown', 'cliOfficialUnverified', 'cliDetect', 'cliLogin', 'cliOpenTerminal', 'cliCheckStatus', 'cliOpened', 'cliActionFailed']) assert.notEqual(context.window.MMM_I18N.t(key), key);
  }
  context.window.MMM_I18N.setLocale('en');
  assert.match(context.window.MMM_I18N.t('cliPermissions'), /outside the MMM sandbox/);
  assert.match(context.window.MMM_I18N.t('cliOpened'), /does not confirm authentication/);
  assert.match(context.window.MMM_I18N.t('cliDedicatedProfile'), /existing login files are not copied/);
  const rendered = cli.slice(cli.indexOf('function renderCliConnections()'));
  assert.doesNotMatch(rendered, /await window.mmm.cliStatus|await window.mmm.openCli/);
});

test('workflow hierarchy contains recorded turns and artifacts, never planned member turns', () => {
  const implementation = app.match(/function workflowRecords\(task, artifacts\) \{[\s\S]*?\n  \}/)?.[0];
  const context = {}; vm.runInNewContext(implementation, context);
  const task = { id: 'task-1', team: { rounds: 3, members: [{ id: 'a' }, { id: 'b' }] }, artifactIds: ['output-1'], turns: [{ index: 0, round: 1, phase: 'discussion', memberId: 'a', status: 'failed' }] };
  const result = context.workflowRecords(task, [{ id: 'output-1', name: 'Actual artifact' }, { id: 'other' }]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].turns.length, 1);
  assert.equal(result.groups[0].turns[0].status, 'failed');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.evidence, null);
  assert.equal(context.workflowRecords({ id: 'empty', team: task.team }, []).groups.length, 0);
  const renderer = app.slice(app.indexOf('function renderWorkflow'), app.indexOf('function artifactContent'));
  assert.doesNotMatch(renderer, /role.*tree|progressbar|percent|setInterval|\/api/);
  assert.match(renderer, /expanded.has\(key\)/);
  assert.match(renderer, /\['running', 'awaiting_review'\]\.includes\(task.status\)/);
});

test('website services stay last and collapsed while composer grows within bounds', () => {
  const web = app.slice(app.indexOf('const webServices ='), app.indexOf('function newProviderId'));
  assert.match(web, /const webDetails = node\('details'\)/);
  assert.doesNotMatch(web, /webDetails.open = true/);
  assert.match(web, /querySelector\('\.drawer-content'\).append\(webServices\)/);
  assert.match(web, /DOMContentLoaded', placeWebServicesLast/);
  assert.match(app, /function openSettings\(\) \{ placeWebServicesLast\(\)/);
  assert.match(app, /input.rows = Math.min\(10, Math.max\(2,/);
  assert.match(app, /'input', resizeComposer/);
  assert.match(app, /if \(wasHidden\) requestAnimationFrame\(resizeComposer\)/);
  assert.match(app, /cliAdvanced.append\(cliAdvancedTitle, cliProfile, cliPermissions\)/);
  assert.match(app, /result.platformSupported !== false && result.state !== 'unsupported_platform'/);
  const css = fs.readFileSync(path.join(ui, 'styles.css'), 'utf8');
  assert.match(css, /\.composer #message-input \{ min-height: 0; height: auto; max-height: 240px/);
});

test('conversation uses viewport flex docking, not a fixed composer overlay', () => {
  const css = fs.readFileSync(path.join(ui, 'styles.css'), 'utf8');
  assert.match(app, /Boolean\(state.detail\) && state.tab === 'conversation'/);
  assert.match(app, /visualViewport\?\.addEventListener\('resize'/);
  assert.match(css, /body.conversation-view \.messages \{ flex: 1 1 0; min-height: 0; max-height: none; overflow-y: auto/);
  assert.match(css, /body.conversation-view \.conversation-main \{ display: flex; flex-direction: column; min-height: 0; height: 100%/);
  assert.doesNotMatch(css, /(?:#composer|\.composer)\s*\{[^}]*position:\s*fixed/);
});

test('composer source attachments target the captured project and never read file content', () => {
  const source = app.slice(app.indexOf('async function attachProjectSources'), app.indexOf('function sourceLimits'));
  assert.match(source, /const projectId = state.selected/);
  assert.match(source, /state.selected !== projectId\) return/);
  assert.match(source, /encodeURIComponent\(projectId\)\}\/sources/);
  assert.match(source, /body: \{ sourceTokens: tokens \}/);
  assert.match(source, /finally \{ releaseSourceTokens\(tokens\)/);
  assert.match(source, /files.length > sourceLimits\(\).maxBatch/);
  assert.match(source, /window.mmm.dropSources\(files\)/);
  assert.doesNotMatch(source, /FileReader|\.text\(|\.arrayBuffer\(|confirmedSharing|providerId|\/tasks|\/content/);
});
