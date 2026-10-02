'use strict';

// Native-main only. These plans never submit prompts or expose provider credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI_DEFINITIONS = Object.freeze([
  Object.freeze({ kind: 'codex', name: 'Codex CLI', official: true, documentation: 'https://developers.openai.com/codex/auth', statusSupported: true, credentialStorage: 'os-keyring-required' }),
  Object.freeze({ kind: 'claude', name: 'Claude Code', official: true, documentation: 'https://code.claude.com/docs/en/authentication', statusSupported: true, credentialStorage: 'provider-managed-may-use-files' }),
  Object.freeze({ kind: 'grok', name: 'Grok Build', official: true, documentation: 'https://docs.x.ai/build/cli/reference', statusSupported: false, credentialStorage: 'provider-managed-may-use-files' }),
]);
const SYSTEM_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
const MAX_OUTPUT = 32768;
function fault(code) { return Object.assign(new Error(code), { code }); }
function definition(kind) {
  const value = CLI_DEFINITIONS.find(entry => entry.kind === kind);
  if (!value) throw fault('CLI_KIND_INVALID');
  return value;
}
function supportedPlatform() { return process.platform === 'darwin'; }
function catalog() { return CLI_DEFINITIONS.map(entry => ({ ...entry, supportedPlatforms: ['darwin'], platformSupported: supportedPlatform(), credentialOwner: 'provider-cli', automaticGeneration: false, binaryAuthenticityVerified: false })); }
function absolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096 || path.normalize(value) !== value) throw fault(code);
  return value;
}
function candidates(kind) {
  definition(kind);
  if (!supportedPlatform()) return []; // No cmd.exe/batch/shell fallback.
  const dirs = [...SYSTEM_DIRS, path.join(os.homedir(), '.local', 'bin')];
  if (kind === 'grok') dirs.push(path.join(os.homedir(), '.grok', 'bin'));
  const values = dirs.map(dir => path.join(dir, kind));
  if (kind === 'codex' && process.platform === 'darwin') {
    values.push('/Applications/Codex.app/Contents/Resources/codex');
    values.push('/Applications/ChatGPT.app/Contents/Resources/codex');
  }
  return values;
}
function discoverExecutable(kind, { fsImpl = fs } = {}) {
  for (const candidate of candidates(kind)) {
    try {
      if (!fsImpl.statSync(candidate).isFile()) continue;
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* A missing CLI is not an authentication failure. */ }
  }
  return null;
}
function profileRoot(value) {
  absolute(value, 'CLI_PROFILE_INVALID');
  if (value === path.parse(value).root || value === os.homedir()) throw fault('CLI_PROFILE_INVALID');
  return value;
}
function safeEnv(_baseEnv, { kind, profileDirectory } = {}) {
  definition(kind);
  if (!supportedPlatform()) throw fault('CLI_PLATFORM_UNSUPPORTED');
  const root = profileRoot(profileDirectory);
  // Construct afresh: no inherited API keys, proxy/base URLs, runtime loaders,
  // shell hooks, SSH agents, cookies, user configs, or telemetry credentials.
  const env = {
    PATH: SYSTEM_DIRS.join(path.delimiter),
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
  };
  if (kind === 'codex') env.CODEX_HOME = path.join(root, 'codex');
  if (kind === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  if (kind === 'grok') env.GROK_HOME = path.join(root, 'grok');
  return env;
}
function launchPlan(kind, action, executable, workspace, { profileDirectory, baseEnv } = {}) {
  definition(kind);
  if (!supportedPlatform()) throw fault('CLI_PLATFORM_UNSUPPORTED');
  if (!['login', 'interactive', 'status'].includes(action)) throw fault('CLI_ACTION_INVALID');
  absolute(executable, 'CLI_EXECUTABLE_INVALID');
  if (!candidates(kind).includes(executable)) throw fault('CLI_EXECUTABLE_INVALID');
  const root = profileRoot(profileDirectory);
  absolute(workspace, 'CLI_WORKSPACE_INVALID');
  if (workspace !== path.join(root, 'workspace')) throw fault('CLI_WORKSPACE_INVALID');
  let args;
  if (kind === 'codex') {
    args = ['-c', "cli_auth_credentials_store='keyring'"];
    if (action === 'login') args.push('login');
    if (action === 'status') args.push('login', 'status');
  } else if (kind === 'claude') {
    args = action === 'login' ? ['auth', 'login', '--claudeai'] : action === 'status' ? ['auth', 'status', '--json'] : [];
  } else {
    if (action === 'status') throw fault('CLI_STATUS_UNSUPPORTED');
    // --oauth is documented by the installed Grok Build login --help.
    args = action === 'login' ? ['login', '--oauth'] : [];
  }
  return { command: executable, args, cwd: workspace, env: safeEnv(baseEnv, { kind, profileDirectory: root }) };
}
function result(kind, state, authenticated = null, authMethod = 'unknown') {
  return { kind, installed: !['not_installed', 'unsupported_platform'].includes(state), authenticated, status: state, authMethod, available: null, credentialOwner: 'provider-cli', platformSupported: supportedPlatform() };
}
function parseStatus(kind, code, stdout, stderr) {
  if (kind === 'claude') {
    try {
      const value = JSON.parse(stdout);
      if (value && value.loggedIn === true && code === 0) {
        const method = ['oauth', 'claude.ai', 'claudeai'].includes(value.authMethod) ? 'oauth' : ['api_key', 'apiKey', 'console'].includes(value.authMethod) ? 'api_key' : 'unknown';
        return result(kind, 'authenticated', true, method);
      }
      if (value && value.loggedIn === false && (code === 0 || code === 1)) return result(kind, 'unauthenticated', false);
    } catch { /* Never expose raw JSON, account email, tokens, or stderr. */ }
  } else if (kind === 'codex') {
    const text = (stdout + '\n' + stderr).trim();
    if (code === 0 && /^Logged in using ChatGPT\b/m.test(text)) return result(kind, 'authenticated', true, 'oauth');
    if (code === 0 && /^Logged in using (?:an )?API key\b/m.test(text)) return result(kind, 'authenticated', true, 'api_key');
    if (code === 1 && /^Not logged in\s*$/m.test(text)) return result(kind, 'unauthenticated', false);
  }
  return result(kind, code === 0 ? 'unknown' : 'failed');
}
async function status(kind, { executable, profileDirectory, spawnImpl = spawn, signal, timeoutMs = 5000 } = {}) {
  const entry = definition(kind);
  if (!supportedPlatform()) return result(kind, 'unsupported_platform');
  if (!executable) return result(kind, 'not_installed');
  if (!entry.statusSupported) return result(kind, 'unsupported');
  const plan = launchPlan(kind, 'status', executable, path.join(profileRoot(profileDirectory), 'workspace'), { profileDirectory });
  if (signal?.aborted) return result(kind, 'cancelled');
  const duration = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(timeoutMs, 10000)) : 5000;
  return new Promise(resolve => {
    let child, timer, complete = false, count = 0, stdout = '', stderr = '';
    const finish = value => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      stdout = ''; stderr = '';
      resolve(value);
    };
    const stop = state => {
      try { child?.kill('SIGKILL'); } catch { /* No child error is public. */ }
      finish(result(kind, state));
    };
    const cancel = () => stop('cancelled');
    try {
      child = spawnImpl(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = field => chunk => {
        if (complete) return;
        count += Buffer.byteLength(chunk);
        if (count > MAX_OUTPUT) return stop('output_limit');
        if (field === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', () => finish(result(kind, 'failed')));
      child.once('close', code => finish(parseStatus(kind, code, stdout, stderr)));
      timer = setTimeout(() => stop('timed_out'), duration);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    } catch { stop('failed'); }
  });
}

module.exports = { CLI_DEFINITIONS, catalog, discoverExecutable, safeEnv, launchPlan, status };
