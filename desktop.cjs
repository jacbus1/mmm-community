'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApplication } = require('./server.cjs');
const cli = require('./cli-connections.cjs');
const { openTerminal } = require('./terminal-launch.cjs');
const { openService } = require('./external-browser.cjs');
// Fixed public identity: never open the private application's data directory.
app.setName('MMM-Community');
app.setPath('userData', path.join(app.getPath('appData'), 'MMM-Community'));
if (process.platform === 'win32') app.setAppUserModelId('app.mmm.community');
let service, window, quitting = false;
const bootstrap = path.join(app.getPath('userData'), 'storage-location.json');
function saveLocation(directory) {
  const file = bootstrap + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(file, JSON.stringify({ directory }), { mode: 0o600, flag: 'wx' }); fs.renameSync(file, bootstrap);
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== service.origin) throw Error('UNTRUSTED_IPC');
}
function cliContext(kind) {
  if (!['codex', 'claude', 'grok'].includes(kind)) throw Error('INVALID_CLI_KIND');
  let directory = app.getPath('userData');
  const directories = [directory];
  for (const part of ['cli-profiles', kind]) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('UNSAFE_CLI_PROFILE');
    directories.push(directory);
  }
  for (const part of ['workspace', 'home', 'config', 'cache', 'data', kind]) {
    const child = path.join(directory, part);
    if (!fs.existsSync(child)) fs.mkdirSync(child, { mode: 0o700 });
    const stat = fs.lstatSync(child); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('UNSAFE_CLI_PROFILE');
    directories.push(child);
  }
  const workspace = path.join(directory, 'workspace');
  const identities = directories.map(filename => {
    const stat = fs.lstatSync(filename); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('UNSAFE_CLI_PROFILE');
    return { filename, dev: stat.dev, ino: stat.ino };
  });
  return { executable: cli.discoverExecutable(kind), profileDirectory: directory, workspace, identities };
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
    let directory = path.join(app.getPath('userData'), 'data');
    if (fs.existsSync(bootstrap)) {
      if (fs.lstatSync(bootstrap).isSymbolicLink()) throw Error('UNSAFE_STORAGE_POINTER');
      const selected = JSON.parse(fs.readFileSync(bootstrap, 'utf8')).directory;
      if (!path.isAbsolute(selected) || !fs.existsSync(selected)) throw Error('SELECTED_STORAGE_UNAVAILABLE');
      directory = selected;
    } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    service = await createApplication({ directory, safeStorage });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    window = new BrowserWindow({ width: 1280, height: 880, minWidth: 480, minHeight: 480, backgroundColor: '#f7f8fc', show: false, icon: path.join(__dirname, 'ui/logo.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== service.origin) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    ipcMain.handle('public:cli-status', async (event, kind) => {
      trusted(event);
      try {
        const context = cliContext(kind);
        const result = await cli.status(kind, context); trusted(event);
        return { ...result, authenticated: result.authenticated ?? 'unknown', execution: 'manual-terminal', quota: 'unknown', binaryAuthenticityVerified: false };
      } catch { return { kind, installed: false, authenticated: 'unknown', error: 'CLI_STATUS_UNAVAILABLE' }; }
    });
    ipcMain.handle('public:open-cli', async (event, value) => {
      trusted(event);
      try {
        if (!['login', 'terminal'].includes(value?.action)) return { error: 'INVALID_CLI_ACTION' };
        const context = cliContext(value.kind);
        if (!context.executable) return { error: 'CLI_NOT_INSTALLED' };
        const executable = fs.realpathSync(context.executable), before = fs.statSync(executable);
        const choice = await dialog.showMessageBox(window, { type: 'warning', title: 'Local CLI / 本機 CLI',
          message: `${value.kind}: ${value.action === 'login' ? 'Account login / 帳戶登入' : 'Terminal'}`,
          detail: `${executable}\n\nThis opens your installed CLI in an isolated MMM profile, not an MMM filesystem sandbox. CLI actions may access local files or the network after its own prompts. Credentials are managed by the CLI; some platforms use local credential files. No existing login files are copied. No API key is required for supported account login.\n\n使用獨立設定，不會複製原有登入檔。這不是檔案系統沙箱；請自行審核 CLI 權限。憑證由 CLI 管理，部分平台會使用本機憑證檔。`,
          buttons: ['Cancel / 取消', 'Open Terminal / 開啟終端機'], defaultId: 0, cancelId: 0 });
        trusted(event); if (choice.response !== 1) return { cancelled: true };
        for (const identity of context.identities) {
          const current = fs.lstatSync(identity.filename);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return { error: 'CLI_PROFILE_CHANGED' };
        }
        const after = fs.statSync(executable);
        if (fs.realpathSync(context.executable) !== executable || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) return { error: 'CLI_EXECUTABLE_CHANGED' };
        const plan = cli.launchPlan(value.kind, value.action === 'terminal' ? 'interactive' : 'login', context.executable, context.workspace, { profileDirectory: context.profileDirectory });
        // Execute the confirmed target, not a launcher symlink that can be retargeted.
        plan.command = executable;
        return await openTerminal(plan, context.profileDirectory, filename => shell.openPath(filename));
      } catch { return { error: 'CLI_TERMINAL_OPEN_FAILED' }; }
    });
    ipcMain.handle('public:open-service', async (event, value) => {
      trusted(event);
      return openService(value, { openExternal: url => shell.openExternal(url), home: app.getPath('home') });
    });
    ipcMain.handle('public:grant-source-read', async (event, value) => {
      trusted(event);
      try {
        const source = service.describeSource(value?.projectId, value?.sourceId);
        const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Allow local read / 允許本機讀取',
          message: source.name, detail: `${source.path}\n\nRead-only local previews. No upload, AI access or write permission.\n僅允許本機唯讀預覽，不會上傳、交給 AI 或修改來源。`,
          buttons: ['Cancel / 取消', 'Allow local read / 允許本機讀取'], defaultId: 0, cancelId: 0 });
        trusted(event);
        if (answer.response !== 1) return { cancelled: true };
        return service.grantSourceRead(value.projectId, value.sourceId);
      } catch { return { error: 'SOURCE_READ_GRANT_FAILED' }; }
    });
    ipcMain.handle('public:choose-sources', async (event, kind) => {
      trusted(event);
      if (!['file', 'folder'].includes(kind)) return { error: 'INVALID_SOURCE_SELECTION' };
      const selection = await dialog.showOpenDialog(window, {
        title: kind === 'folder' ? 'Select project source folders' : 'Select project source files',
        properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections']
      });
      trusted(event);
      if (selection.canceled) return { cancelled: true };
      try { return service.registerSources(selection.filePaths); }
      catch (error) { return { error: /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'SOURCE_SELECTION_FAILED' }; }
    });
    ipcMain.handle('public:drop-sources', (event, paths) => {
      trusted(event);
      try { return service.registerSources(paths); }
      catch (error) { return { error: /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'SOURCE_SELECTION_FAILED' }; }
    });
    ipcMain.handle('public:release-sources', (event, tokens) => {
      trusted(event);
      try { return service.releaseSources(tokens); }
      catch { return { error: 'SOURCE_TOKEN_INVALID' }; }
    });
    ipcMain.handle('public:choose-storage', async event => {
      trusted(event);
      const selection = await dialog.showOpenDialog(window, { title: 'Select a storage parent folder', properties: ['openDirectory'] });
      trusted(event);
      if (selection.canceled) return { cancelled: true };
      const target = path.join(selection.filePaths[0], 'MMM-Community-data');
      try {
        // Parent comes from an explicit native selection; never recreate an absent parent/mount.
        if (!fs.statSync(selection.filePaths[0]).isDirectory()) throw Error();
        if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
        return await service.migrate(target, saveLocation);
      } catch { return { error: 'STORAGE_MIGRATION_FAILED_OR_BUSY' }; }
    });
    ipcMain.handle('public:save-text', async (event, value) => {
      trusted(event);
      if (!value || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 1024 * 1024 || typeof value.name !== 'string') return { error: 'INVALID_EXPORT' };
      const name = path.basename(value.name).replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 100) || 'MMM-result';
      const extension = value.format === 'md' ? 'md' : 'txt';
      const choice = await dialog.showSaveDialog(window, { title: 'Save local text copy', defaultPath: `${name.replace(/\.(?:txt|md)$/i, '')}.${extension}`, filters: [{ name: extension === 'md' ? 'Markdown' : 'Text', extensions: [extension] }] });
      trusted(event);
      if (choice.canceled || !choice.filePath) return { cancelled: true };
      try { fs.writeFileSync(choice.filePath, value.content, { flag: 'wx', mode: 0o600 }); return { saved: true }; }
      catch { return { error: 'EXPORT_FAILED_CHOOSE_NEW_NAME' }; }
    });
    await window.loadURL(service.launchUrl); window.show();
    app.on('activate', () => window?.show());
  }).catch(() => { dialog.showErrorBox('MMM storage unavailable', 'The selected storage could not be opened. Reconnect the disk or restore its permissions. No fallback database was created.'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!service || quitting) return;
    event.preventDefault(); quitting = true; service.close().finally(() => app.quit());
  });
}
