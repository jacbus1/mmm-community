'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scriptFor, openTerminal } = require('../terminal-launch.cjs');
const plan = () => ({ command: '/opt/bin/cli', cwd: '/tmp/workspace', args: ['login'], env: { HOME: '/tmp/profile', PATH: '/usr/bin:/bin' } });
test('macOS launcher clears inherited environment and quotes every value', () => {
  const value = plan(); value.args = ["a'b", '$(touch /tmp/should-never-run)'];
  const script = scriptFor(value, 'darwin');
  assert.match(script, /exec \/usr\/bin\/env -i/);
  assert.ok(script.includes("'a'\\''b'"));
  assert.ok(script.includes("'$(touch /tmp/should-never-run)'"));
  assert.doesNotMatch(script, /exec \$SHELL|source |\.env/);
});
test('launcher rejects control characters, relative executables, invalid environment and unsupported OS', () => {
  for (const value of [{ ...plan(), command: 'cli' }, { ...plan(), args: ['x\ny'] }, { ...plan(), env: { 'X=bad': 'value' } }]) assert.throws(() => scriptFor(value, 'darwin'), /INVALID/);
  assert.throws(() => scriptFor(plan(), 'linux'), /UNSUPPORTED/);
  for (const unsafe of ['%PATH%', '!PATH!', 'x&y', 'x"y', 'x|y', 'x(y)']) assert.throws(() => scriptFor({ ...plan(), args: [unsafe] }, 'win32'), /INVALID/);
});
test('Windows launcher clears environment and disables delayed expansion', () => {
  const script = scriptFor(plan(), 'win32');
  assert.match(script, /setlocal DisableDelayedExpansion/);
  assert.match(script, /do set "%%G="/);
  assert.match(script, /call "\/opt\/bin\/cli" "login"/);
});
test('opening a terminal reports only opened, never authenticated or unlimited', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-terminal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let opened;
  const result = await openTerminal(plan(), directory, async file => { opened = file; return ''; }, 'darwin');
  assert.equal(result.opened, true); assert.equal(result.authenticated, 'unknown'); assert.equal(result.quota, 'unknown');
  assert.equal(path.dirname(opened), directory); assert.match(opened, /\.command$/);
  assert.equal(fs.statSync(opened).mode & 0o777, 0o700);
  await assert.rejects(openTerminal(plan(), directory, async () => 'cannot open', 'darwin'), /OPEN_FAILED/);
  const link = path.join(directory, 'linked'); fs.symlinkSync(directory, link);
  await assert.rejects(openTerminal(plan(), link, async () => '', 'darwin'), /INVALID/);
});
