'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-ipc-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map(), opened = [], grants = [], dialogs = [], launches = [];
  const executable = path.join(directory, 'synthetic-cli'); fs.writeFileSync(executable, 'synthetic executable, never run');
  const cliMock = { discoverExecutable: () => executable, status: async () => ({ installed: true, authenticated: null }),
    launchPlan: (...args) => { launches.push(args); return {}; } };
  const origin = 'http://127.0.0.1:49111';
  let window, answer = async () => ({ response: 1 });
  class Window {
    constructor() { window = this; this.webContents = { mainFrame: { url: origin + '/' }, on() {}, setWindowOpenHandler() {} }; }
    async loadURL() {} show() {}
  }
  const service = { origin, launchUrl: origin,
    describeSource: (projectId, sourceId) => { assert.equal(projectId, 'project'); assert.equal(sourceId, 'source'); return { name: 'synthetic.md', path: path.join(directory, 'synthetic.md') }; },
    grantSourceRead: (...ids) => { grants.push(ids); return { permission: { granted: true } }; } };
  const electron = { BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { setName() {}, setPath() {}, getPath: () => directory, requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} } }, safeStorage: {},
    shell: { openExternal: async url => { opened.push(url); } },
    dialog: { showErrorBox: () => { throw Error('unexpected boot failure'); }, showOpenDialog: async () => answer(), showSaveDialog: async () => answer(),
      showMessageBox: async (_window, options) => { dialogs.push(options); return answer(); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === './server.cjs' ? { createApplication: async () => service } : name === './cli-connections.cjs' ? cliMock : name === './terminal-launch.cjs' ? { openTerminal: async () => ({ opened: true, authenticated: 'unknown' }) } : require(name.startsWith('./') ? path.resolve(__dirname, '..', name) : name),
    __dirname: path.resolve(__dirname, '..'), process: { platform: process.platform }, URL, Buffer
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { handlers, opened, grants, dialogs, launches, executable, directory, event, window, setAnswer: value => { answer = value; } };
}
test('CLI native dialog is default-deny, validates identity and never marks terminal as authenticated', async t => {
  const f = await fixture(t), open = f.handlers.get('public:open-cli');
  f.setAnswer(async () => ({ response: 0 }));
  assert.equal((await open(f.event(), { kind: 'codex', action: 'login' })).cancelled, true);
  assert.equal(f.launches.length, 0); assert.equal(f.dialogs[0].defaultId, 0);
  f.setAnswer(async () => ({ response: 1 }));
  assert.equal((await open(f.event(), { kind: 'codex', action: 'login' })).authenticated, 'unknown');
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0][2], f.executable);
  for (const child of ['home', 'config', 'cache', 'data', 'codex', 'workspace']) assert.ok(fs.statSync(path.join(f.directory, 'cli-profiles', 'codex', child)).isDirectory());
  assert.equal((await open(f.event(), { kind: 'codex', action: 'arbitrary command' })).error, 'INVALID_CLI_ACTION');
  f.setAnswer(async () => { fs.appendFileSync(f.executable, 'changed'); return { response: 1 }; });
  assert.equal((await open(f.event(), { kind: 'codex', action: 'login' })).error, 'CLI_EXECUTABLE_CHANGED');
  assert.equal(f.launches.length, 1);
});
test('CLI native launch rechecks frame after authorization and rejects profile symlinks', async t => {
  const f = await fixture(t), open = f.handlers.get('public:open-cli');
  f.setAnswer(async () => { f.window.webContents.mainFrame.url = 'https://untrusted.invalid/'; return { response: 1 }; });
  assert.equal((await open(f.event(), { kind: 'codex', action: 'terminal' })).error, 'CLI_TERMINAL_OPEN_FAILED');
  assert.equal(f.launches.length, 0);
  f.window.webContents.mainFrame.url = 'http://127.0.0.1:49111/';
  fs.symlinkSync(f.directory, path.join(f.directory, 'cli-profiles', 'claude'));
  assert.equal((await open(f.event(), { kind: 'claude', action: 'login' })).error, 'CLI_TERMINAL_OPEN_FAILED');
  assert.equal(f.launches.length, 0);
});
test('CLI profile child replacement during confirmation stops launch', async t => {
  const f = await fixture(t), open = f.handlers.get('public:open-cli');
  f.setAnswer(async () => {
    const home = path.join(f.directory, 'cli-profiles', 'codex', 'home');
    fs.renameSync(home, home + '-original'); fs.symlinkSync(f.directory, home);
    return { response: 1 };
  });
  assert.equal((await open(f.event(), { kind: 'codex', action: 'login' })).error, 'CLI_PROFILE_CHANGED');
  assert.equal(f.launches.length, 0);
});
test('web sign-in IPC opens only fixed official destinations and does not claim authentication', async t => {
  const f = await fixture(t), open = f.handlers.get('public:open-service');
  for (const kind of ['chatgpt', 'claude', 'grok']) assert.equal((await open(f.event(), kind)).authenticated, 'unknown');
  assert.deepEqual(f.opened, ['https://chatgpt.com/', 'https://claude.ai/', 'https://grok.com/']);
  for (const kind of ['https://untrusted.invalid', 'file:///secret', '__proto__', 'constructor']) assert.equal((await open(f.event(), kind)).error, 'INVALID_WEB_SERVICE');
  assert.equal(f.opened.length, 3);
  await assert.rejects(open({ sender: {}, senderFrame: f.window.webContents.mainFrame }, 'chatgpt'), /UNTRUSTED_IPC/);
});
test('read grant IPC requires native confirmation and checks the sender again after the dialog', async t => {
  const f = await fixture(t), grant = f.handlers.get('public:grant-source-read'), input = { projectId: 'project', sourceId: 'source' };
  f.setAnswer(async () => ({ response: 0 })); assert.equal((await grant(f.event(), input)).cancelled, true); assert.equal(f.grants.length, 0);
  f.setAnswer(async () => ({ response: 1 })); assert.equal((await grant(f.event(), input)).permission.granted, true); assert.equal(f.grants.length, 1);
  assert.equal(f.dialogs[0].defaultId, 0); assert.match(f.dialogs[0].detail, /No upload, AI access or write permission/);
  f.setAnswer(async () => { f.window.webContents.mainFrame.url = 'https://untrusted.invalid/'; return { response: 1 }; });
  assert.equal((await grant(f.event(), input)).error, 'SOURCE_READ_GRANT_FAILED'); assert.equal(f.grants.length, 1);
});
test('Claude-proposed post-dialog sender checks protect source selection, storage selection and exports', async t => {
  const f = await fixture(t);
  for (const [channel, value] of [['public:choose-sources', 'file'], ['public:choose-storage', undefined], ['public:save-text', { name: 'synthetic', content: 'Public synthetic test' }]]) {
    f.window.webContents.mainFrame.url = 'http://127.0.0.1:49111/';
    f.setAnswer(async () => { f.window.webContents.mainFrame.url = 'https://untrusted.invalid/'; return { canceled: true }; });
    await assert.rejects(f.handlers.get(channel)(f.event(), value), /UNTRUSTED_IPC/);
  }
});
