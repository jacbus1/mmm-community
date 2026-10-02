'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function fail() { throw Object.assign(new Error('CLI_LAUNCH_PLAN_INVALID'), { code: 'CLI_LAUNCH_PLAN_INVALID' }); }
function quote(value) { if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail(); return "'" + value.replace(/'/g, "'\\''") + "'"; }
function windowsQuote(value) {
  // cmd expands percent and delayed-expansion sequences even inside quotes.
  // Refuse unsupported paths rather than attempting a second shell expansion.
  if (typeof value !== 'string' || /[\x00-\x1f\x7f"%!&|<>^()]/.test(value)) fail();
  return '"' + value + '"';
}
function scriptFor(plan, platform = process.platform) {
  if (!plan || !path.isAbsolute(plan.command) || !path.isAbsolute(plan.cwd) || !Array.isArray(plan.args) || !plan.env || Object.keys(plan.env).length > 40) fail();
  const entries = Object.entries(plan.env);
  if (entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) fail();
  if (platform === 'darwin') return '#!/bin/sh\ncd ' + quote(plan.cwd) + ' || exit 1\nexec /usr/bin/env -i ' + entries.map(([key, value]) => quote(key + '=' + value)).join(' ') + ' ' + [plan.command, ...plan.args].map(quote).join(' ') + '\n';
  if (platform === 'win32') return '@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=1 delims==" %%G in (\'set\') do set "%%G="\r\n'
    + entries.map(([key, value]) => 'set ' + windowsQuote(key + '=' + value)).join('\r\n')
    + '\r\ncd /d ' + windowsQuote(plan.cwd) + ' || exit /b 1\r\ncall ' + [plan.command, ...plan.args].map(windowsQuote).join(' ') + '\r\npause\r\n';
  throw Object.assign(new Error('CLI_PLATFORM_UNSUPPORTED'), { code: 'CLI_PLATFORM_UNSUPPORTED' });
}
async function openTerminal(plan, directory, openPath, platform = process.platform) {
  const content = scriptFor(plan, platform);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const filename = path.join(directory, crypto.randomUUID() + (platform === 'win32' ? '.cmd' : '.command'));
  fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o700 });
  const error = await openPath(filename);
  if (error) throw Object.assign(new Error('CLI_TERMINAL_OPEN_FAILED'), { code: 'CLI_TERMINAL_OPEN_FAILED' });
  return { opened: true, authenticated: 'unknown', execution: 'manual-terminal', quota: 'unknown' };
}
module.exports = { scriptFor, openTerminal };
