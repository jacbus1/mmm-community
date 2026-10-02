'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const SITES = Object.freeze({ chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/', grok: 'https://grok.com/' });
async function openService(value, { openExternal, home, platform = process.platform, spawnImpl = spawn, exists = fs.existsSync }) {
  const kind = typeof value === 'string' ? value : value?.kind;
  const browser = typeof value === 'string' ? 'default' : value?.browser || 'default';
  if (typeof kind !== 'string' || !Object.hasOwn(SITES, kind)) return { error: 'INVALID_WEB_SERVICE' };
  if (!['default', 'chrome'].includes(browser)) return { error: 'INVALID_BROWSER' };
  const url = SITES[kind];
  try {
    if (browser === 'default') await openExternal(url);
    else {
      let command, args;
      if (platform === 'darwin') { command = '/usr/bin/open'; args = ['-a', 'Google Chrome', url]; }
      else if (platform === 'win32') {
        const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
        if (typeof home === 'string' && path.win32.isAbsolute(home)) candidates.push(path.win32.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'));
        command = candidates.find(exists); if (!command) return { error: 'CHROME_NOT_FOUND' };
        args = ['--new-window', url];
      } else return { error: 'CHROME_PLATFORM_UNSUPPORTED' };
      // No shell interpolation, profile selection, debugging port, credential
      // extraction or inherited API-key environment. Browser owns its login.
      await new Promise((resolve, reject) => {
        const child = spawnImpl(command, args, { shell: false, detached: platform === 'win32', stdio: 'ignore', env: platform === 'darwin' ? { PATH: '/usr/bin:/bin' } : {} });
        child.once('error', reject);
        if (platform === 'win32') child.once('spawn', () => { child.unref(); resolve(); });
        else child.once('close', code => code === 0 ? resolve() : reject(Error('CHROME_OPEN_FAILED')));
      });
    }
    return { opened: true, browser, authenticated: 'unknown', automationConnected: false };
  } catch { return { error: 'WEB_SERVICE_OPEN_FAILED' }; }
}
module.exports = { openService };
