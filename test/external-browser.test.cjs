'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openService } = require('../external-browser.cjs');
test('external default browser uses only provider allowlist and reports no connection', async () => {
  const opened = [], options = { openExternal: async url => opened.push(url) };
  for (const kind of ['chatgpt', 'claude', 'grok']) {
    const result = await openService({ kind, browser: 'default' }, options);
    assert.equal(result.authenticated, 'unknown'); assert.equal(result.automationConnected, false);
  }
  assert.deepEqual(opened, ['https://chatgpt.com/', 'https://claude.ai/', 'https://grok.com/']);
  assert.equal((await openService({ kind: 'file:///secret' }, options)).error, 'INVALID_WEB_SERVICE');
  assert.equal((await openService({ kind: 'grok', browser: 'sh' }, options)).error, 'INVALID_BROWSER');
});
test('Chrome opens fixed argv with no profile, debug port, shell or inherited credentials', async () => {
  const calls = [];
  const spawnImpl = (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0); }); return child; };
  assert.equal((await openService({ kind: 'grok', browser: 'chrome' }, { platform: 'darwin', spawnImpl })).opened, true);
  assert.deepEqual(calls[0][0], '/usr/bin/open'); assert.deepEqual(calls[0][1], ['-a', 'Google Chrome', 'https://grok.com/']);
  assert.equal(calls[0][2].shell, false); assert.deepEqual(calls[0][2].env, { PATH: '/usr/bin:/bin' });
  const result = await openService({ kind: 'claude', browser: 'chrome' }, { platform: 'win32', exists: () => true, spawnImpl });
  assert.equal(result.authenticated, 'unknown'); assert.deepEqual(calls[1][1], ['--new-window', 'https://claude.ai/']);
  assert.deepEqual(calls[1][2].env, {});
  assert.equal((await openService({ kind: 'grok', browser: 'chrome' }, { platform: 'win32', exists: () => false })).error, 'CHROME_NOT_FOUND');
});
