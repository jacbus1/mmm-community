'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { catalog, discoverExecutable, safeEnv, launchPlan, status } = require('../cli-connections.cjs');

// All subprocesses and executable filesystem checks are synthetic. No account
// files, real auth commands, provider endpoints, or login flows are accessed.
const profileDirectory = '/tmp/mmm-synthetic-cli-profile';
const workspace = path.join(profileDirectory, 'workspace');
const executable = kind => '/usr/local/bin/' + kind;
function fakeSpawn(run) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false;
    child.kill = signal => { child.killed = signal; return true; };
    calls.push({ command, args, options, child });
    if (run) queueMicrotask(() => run(child));
    return child;
  };
  return { calls, spawnImpl };
}
function check(kind, fixture, overrides = {}) {
  return status(kind, { executable: executable(kind), profileDirectory, spawnImpl: fixture.spawnImpl, ...overrides });
}
test('catalog explicitly separates CLI from web/API and makes no binary attestation', () => {
  assert.deepEqual(catalog().map(value => value.kind), ['codex', 'claude', 'grok']);
  for (const value of catalog()) {
    assert.equal(value.official, true);
    assert.equal(value.automaticGeneration, false);
    assert.equal(value.binaryAuthenticityVerified, false);
    assert.equal(value.credentialOwner, 'provider-cli');
    assert.deepEqual(value.supportedPlatforms, ['darwin']);
  }
  const copy = catalog(); copy[0].kind = 'changed';
  assert.equal(catalog()[0].kind, 'codex');
});
test('executable discovery only uses fixed absolute locations, never PATH or cwd', () => {
  const seen = [];
  const fsImpl = {
    statSync(value) { seen.push(value); return { isFile: () => value === '/usr/local/bin/codex' }; },
    accessSync(value) { assert.equal(value, '/usr/local/bin/codex'); },
  };
  assert.equal(discoverExecutable('codex', { fsImpl, pathDirs: ['/tmp/malicious'] }), '/usr/local/bin/codex');
  assert.deepEqual(seen, ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']);
  assert.equal(discoverExecutable('claude', { fsImpl: { statSync() { throw Error('private path'); } } }), null);
  assert.throws(() => discoverExecutable('../../shell'), { code: 'CLI_KIND_INVALID' });
});
test('environment is rebuilt, with isolated homes and no inherited secrets or hooks', () => {
  const hostile = Object.fromEntries(['HOME', 'PATH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'XAI_API_KEY', 'CODEX_HOME', 'GROK_HOME', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'SSH_AUTH_SOCK', 'TERM', 'LANG'].map(key => [key, 'PRIVATE_CANARY']));
  for (const kind of ['codex', 'claude', 'grok']) {
    const env = safeEnv(hostile, { kind, profileDirectory });
    assert.equal(env.HOME, path.join(profileDirectory, 'home'));
    assert.ok(!JSON.stringify(env).includes('PRIVATE_CANARY'));
    assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    assert.equal(env[kind === 'codex' ? 'CODEX_HOME' : kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'GROK_HOME'], path.join(profileDirectory, kind));
  }
  assert.throws(() => safeEnv({}, { kind: 'codex', profileDirectory: os.homedir() }), { code: 'CLI_PROFILE_INVALID' });
});
test('fixed argv-only launch plans use OAuth and normal interactive permissions', () => {
  const expected = {
    codex: { login: ['-c', "cli_auth_credentials_store='keyring'", 'login'], interactive: ['-c', "cli_auth_credentials_store='keyring'"], status: ['-c', "cli_auth_credentials_store='keyring'", 'login', 'status'] },
    claude: { login: ['auth', 'login', '--claudeai'], interactive: [], status: ['auth', 'status', '--json'] },
    grok: { login: ['login', '--oauth'], interactive: [] },
  };
  for (const [kind, actions] of Object.entries(expected)) for (const [action, args] of Object.entries(actions)) {
    const plan = launchPlan(kind, action, executable(kind), workspace, { profileDirectory });
    assert.deepEqual(plan.args, args); assert.equal(plan.command, executable(kind)); assert.equal(plan.cwd, workspace);
    assert.ok(!JSON.stringify(plan).includes('skip-permissions'));
  }
  assert.throws(() => launchPlan('grok', 'status', executable('grok'), workspace, { profileDirectory }), { code: 'CLI_STATUS_UNSUPPORTED' });
  for (const action of ['logout', 'exec', 'shell', 'models', 'login; echo secret']) assert.throws(() => launchPlan('codex', action, executable('codex'), workspace, { profileDirectory }), { code: 'CLI_ACTION_INVALID' });
  assert.throws(() => launchPlan('codex', 'login', '/tmp/codex', workspace, { profileDirectory }), { code: 'CLI_EXECUTABLE_INVALID' });
  assert.throws(() => launchPlan('codex', 'interactive', executable('codex'), '/tmp/user-project', { profileDirectory }), { code: 'CLI_WORKSPACE_INVALID' });
  assert.throws(() => launchPlan('codex', 'login', executable('codex'), workspace + '\n', { profileDirectory }), { code: 'CLI_WORKSPACE_INVALID' });
});
test('Codex status recognizes mode without returning email, key or raw output', async () => {
  const fixture = fakeSpawn(child => { child.stderr.end('Logged in using ChatGPT\nEmail: person@example.invalid\nPRIVATE_CANARY'); child.emit('close', 0); });
  const actual = await check('codex', fixture);
  assert.equal(actual.status, 'authenticated'); assert.equal(actual.authMethod, 'oauth'); assert.equal(actual.available, null);
  assert.ok(!JSON.stringify(actual).includes('person')); assert.ok(!JSON.stringify(actual).includes('CANARY'));
  assert.equal(fixture.calls[0].options.shell, false); assert.deepEqual(fixture.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  const api = await check('codex', fakeSpawn(child => { child.stdout.end('Logged in using an API key - PRIVATE_CANARY'); child.emit('close', 0); }));
  assert.equal(api.authMethod, 'api_key');
  const failed = await check('codex', fakeSpawn(child => { child.stdout.end('Logged in using ChatGPT'); child.emit('close', 2); }));
  assert.equal(failed.authenticated, null); assert.equal(failed.status, 'failed');
});
test('Claude structured status strictly parses boolean and discards account fields', async () => {
  for (const [loggedIn, code, expected] of [[true, 0, true], [false, 1, false], ['true', 0, null], [true, 1, null]]) {
    const actual = await check('claude', fakeSpawn(child => { child.stdout.end(JSON.stringify({ loggedIn, authMethod: 'claude.ai', email: 'person@example.invalid', apiKey: 'PRIVATE_CANARY' })); child.emit('close', code); }));
    assert.equal(actual.authenticated, expected);
    assert.ok(!JSON.stringify(actual).includes('person')); assert.ok(!JSON.stringify(actual).includes('CANARY'));
  }
  const malformed = await check('claude', fakeSpawn(child => { child.stdout.end('PRIVATE_CANARY is logged in'); child.emit('close', 0); }));
  assert.equal(malformed.status, 'unknown');
});
test('missing executables and undocumented Grok status never spawn or infer web auth', async () => {
  const fixture = fakeSpawn(() => { throw Error('must not run'); });
  assert.equal((await status('codex', { spawnImpl: fixture.spawnImpl })).status, 'not_installed');
  const actual = await check('grok', fixture);
  assert.equal(actual.status, 'unsupported'); assert.equal(actual.authenticated, null); assert.equal(actual.available, null);
  assert.equal(fixture.calls.length, 0);
});
test('status output limit, timeout, cancellation and spawn errors are finite and sanitized', async () => {
  const oversized = fakeSpawn(child => { child.stdout.end(Buffer.alloc(32769, 65)); });
  assert.equal((await check('codex', oversized)).status, 'output_limit'); assert.equal(oversized.calls[0].child.killed, 'SIGKILL');
  const quiet = fakeSpawn();
  assert.equal((await check('codex', quiet, { timeoutMs: 10 })).status, 'timed_out'); assert.equal(quiet.calls[0].child.killed, 'SIGKILL');
  const controller = new AbortController(); const waiting = fakeSpawn();
  const pending = check('claude', waiting, { signal: controller.signal }); controller.abort();
  assert.equal((await pending).status, 'cancelled'); assert.equal(waiting.calls[0].child.killed, 'SIGKILL');
  const never = fakeSpawn();
  assert.equal((await check('codex', never, { signal: controller.signal })).status, 'cancelled'); assert.equal(never.calls.length, 0);
  const errored = fakeSpawn(child => child.emit('error', Error('person@example.invalid PRIVATE_CANARY')));
  const actual = await check('codex', errored); assert.equal(actual.status, 'failed'); assert.ok(!JSON.stringify(actual).includes('CANARY'));
  assert.equal((await status('codex', { executable: executable('codex'), profileDirectory, spawnImpl() { throw Error('PRIVATE_CANARY'); } })).status, 'failed');
});
test('Windows support is explicitly unavailable rather than launching a batch wrapper', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    assert.equal(catalog()[0].platformSupported, false);
    assert.equal(discoverExecutable('codex', { fsImpl: { statSync() { throw Error('must not inspect'); } } }), null);
    assert.equal((await status('codex')).status, 'unsupported_platform');
    assert.throws(() => launchPlan('codex', 'login', 'C:\\tools\\codex.cmd', 'C:\\workspace', { profileDirectory: 'C:\\profile' }), { code: 'CLI_PLATFORM_UNSUPPORTED' });
  } finally { Object.defineProperty(process, 'platform', original); }
});
