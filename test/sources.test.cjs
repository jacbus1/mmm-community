'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SourceSelections } = require('../sources.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mmm-sources-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'selected directory'); fs.mkdirSync(directory);
  const file = path.join(root, 'selected.txt'); fs.writeFileSync(file, 'SYNTHETIC_CONTENT_NEVER_READ');
  let now = 1000;
  const selections = new SourceSelections({ now: () => now });
  return { root, directory, file, selections, advance: ms => { now += ms; } };
}
function codes(fn, code) { assert.throws(fn, error => error.code === code && error.message === code); }

test('native selection returns opaque tokens and stable reference-only records, without content reads', t => {
  const f = fixture(t);
  for (const method of ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'opendirSync', 'opendir']) t.mock.method(fs, method, () => { throw Error('Content/directory reading forbidden'); });
  const registered = f.selections.register([f.directory, f.file]);
  assert.equal(registered.sources.length, 2);
  assert.deepEqual(Object.keys(registered.sources[0]), ['token', 'name', 'path', 'kind']);
  assert.equal(registered.sources[0].kind, 'folder'); assert.equal(registered.sources[1].kind, 'file');
  const tokens = registered.sources.map(source => source.token);
  assert.ok(tokens.every(token => /^[A-Za-z0-9_-]{43}$/.test(token))); assert.notEqual(tokens[0], tokens[1]);
  const records = f.selections.resolve(tokens);
  assert.deepEqual(records.map(row => row.kind), ['folder', 'file']);
  assert.deepEqual(f.selections.resolve(tokens), records);
  for (const row of records) {
    assert.match(row.id, /^[0-9a-f-]{36}$/); assert.equal(row.access, 'reference-only'); assert.equal(row.content, undefined); assert.equal(row.token, undefined);
  }
  assert.ok(!JSON.stringify(registered).includes('SYNTHETIC_CONTENT_NEVER_READ'));
  f.selections.consume(tokens); codes(() => f.selections.resolve(tokens), 'SOURCE_TOKEN_UNAVAILABLE');
});
test('tokens expire at thirty minutes, cannot be forged, duplicated, reused or revived by resolving', t => {
  const f = fixture(t); const token = f.selections.register([f.file]).sources[0].token;
  codes(() => f.selections.resolve([crypto.randomBytes(32).toString('base64url')]), 'SOURCE_TOKEN_UNAVAILABLE');
  codes(() => f.selections.resolve([token, token]), 'SOURCE_TOKEN_INVALID');
  for (const value of ['', '../x', {}, 42]) codes(() => f.selections.resolve([value]), 'SOURCE_TOKEN_INVALID');
  f.advance(30 * 60 * 1000 - 1); assert.equal(f.selections.resolve([token]).length, 1);
  f.advance(1); codes(() => f.selections.resolve([token]), 'SOURCE_TOKEN_UNAVAILABLE');
  codes(() => f.selections.consume([token]), 'SOURCE_TOKEN_UNAVAILABLE');
});
test('clear invalidates pending tokens and consume validates complete sets atomically', t => {
  const f = fixture(t); const token = f.selections.register([f.file]).sources[0].token;
  codes(() => f.selections.consume([token, crypto.randomBytes(32).toString('base64url')]), 'SOURCE_TOKEN_UNAVAILABLE');
  assert.equal(f.selections.resolve([token]).length, 1);
  f.selections.clear(); codes(() => f.selections.resolve([token]), 'SOURCE_TOKEN_UNAVAILABLE');
});
test('discard frees cancelled selections, is idempotent after expiry and cannot create grants', t => {
  const f = fixture(t);
  for (let i = 0; i < 120; i++) {
    const token = f.selections.register([f.file]).sources[0].token;
    f.selections.discard([token]); f.selections.discard([token]);
    codes(() => f.selections.resolve([token]), 'SOURCE_TOKEN_UNAVAILABLE');
  }
  const token = f.selections.register([f.file]).sources[0].token;
  f.advance(30 * 60 * 1000 - 1); assert.equal(f.selections.resolve([token]).length, 1);
  f.advance(2); assert.doesNotThrow(() => f.selections.discard([token]));
  const forged = crypto.randomBytes(32).toString('base64url'); f.selections.discard([forged]);
  codes(() => f.selections.resolve([forged]), 'SOURCE_TOKEN_UNAVAILABLE');
  codes(() => f.selections.discard(['malformed']), 'SOURCE_TOKEN_INVALID');
});
test('changed inode, missing target, changed type and symlink substitution are rejected', t => {
  const f = fixture(t); const token = f.selections.register([f.file]).sources[0].token;
  const original = path.join(f.root, 'original.txt'); fs.renameSync(f.file, original);
  codes(() => f.selections.resolve([token]), 'SOURCE_UNAVAILABLE');
  fs.writeFileSync(f.file, 'new file'); codes(() => f.selections.resolve([token]), 'SOURCE_TARGET_CHANGED');
  fs.unlinkSync(f.file); fs.mkdirSync(f.file); codes(() => f.selections.resolve([token]), 'SOURCE_TARGET_CHANGED');
  fs.rmdirSync(f.file); fs.symlinkSync(original, f.file); codes(() => f.selections.resolve([token]), 'SOURCE_SYMLINK_REJECTED');
});
test('directory replacement and parent symlinks do not pass target revalidation', t => {
  const f = fixture(t); const token = f.selections.register([f.directory]).sources[0].token;
  fs.renameSync(f.directory, path.join(f.root, 'original-dir')); fs.mkdirSync(f.directory);
  codes(() => f.selections.resolve([token]), 'SOURCE_TARGET_CHANGED');
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.root, link);
  codes(() => f.selections.register([path.join(link, 'selected.txt')]), 'SOURCE_SYMLINK_REJECTED');
});
test('absolute explicit paths only; root, home, volume roots and unsafe inputs fail generically', t => {
  const f = fixture(t);
  for (const input of ['relative.txt', '', 1, null, `${f.file}\0`, `${f.root}/../selected.txt`, `${f.root}/./selected.txt`]) codes(() => f.selections.register([input]), 'SOURCE_PATH_INVALID');
  for (const input of [path.parse(f.root).root, os.homedir(), '/Volumes/ExampleExternalDrive']) codes(() => f.selections.register([input]), 'SOURCE_SCOPE_TOO_BROAD');
  for (const input of [null, {}, 'path']) codes(() => f.selections.register(input), 'SOURCE_SELECTION_INVALID');
  assert.deepEqual(f.selections.register([]), { sources: [] }); assert.deepEqual(f.selections.resolve([]), []);
});
test('filename metacharacters remain display text, never shell execution or path rewriting', t => {
  const f = fixture(t); const name = 'quoted "; $(touch SHOULD_NOT_EXIST) & `command`.txt';
  const selected = path.join(f.root, name); fs.writeFileSync(selected, 'invented text');
  const registered = f.selections.register([selected]).sources[0]; const record = f.selections.resolve([registered.token])[0];
  assert.equal(record.name, name); assert.equal(record.path, selected); assert.equal(fs.existsSync(path.join(f.root, 'SHOULD_NOT_EXIST')), false);
});
test('limits enforce max 100 per batch and 2000 pending; expired tokens release capacity', t => {
  const f = fixture(t);
  codes(() => f.selections.register(Array(101).fill(f.file)), 'SOURCE_SELECTION_INVALID');
  codes(() => f.selections.register([f.file, f.file]), 'SOURCE_SELECTION_DUPLICATE');
  for (let i = 0; i < 2000; i++) f.selections.register([f.file]);
  codes(() => f.selections.register([f.file]), 'SOURCE_SELECTION_LIMIT');
  f.advance(30 * 60 * 1000); assert.equal(f.selections.register([f.file]).sources.length, 1);
});
test('missing external directories are not recreated and error messages do not expose their path', t => {
  const f = fixture(t); const missing = path.join(f.root, 'absent-external-drive', 'project');
  codes(() => f.selections.register([missing]), 'SOURCE_UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(f.root, 'absent-external-drive')), false);
});
test('failed batch enrollment creates no hidden partial pending tokens', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) codes(() => f.selections.register([f.file, path.join(f.root, 'missing')]), 'SOURCE_UNAVAILABLE');
  for (let i = 0; i < 2000; i++) f.selections.register([f.file]);
  codes(() => f.selections.register([f.file]), 'SOURCE_SELECTION_LIMIT');
});
test('macOS native /var and /tmp aliases allow explicit child selections only', { skip: process.platform !== 'darwin' }, t => {
  for (const parent of [os.tmpdir(), '/tmp']) {
    const root = fs.mkdtempSync(path.join(parent, 'mmm-native-sources-test-'));
    const canonical = fs.realpathSync(root);
    t.after(() => fs.rmSync(canonical, { recursive: true, force: true }));
    const file = path.join(root, 'native-drop.txt'); fs.writeFileSync(file, 'Synthetic native drop');
    const selections = new SourceSelections();
    const registered = selections.register([root, file]);
    assert.deepEqual(registered.sources.map(row => row.kind), ['folder', 'file']);
    assert.equal(registered.sources[0].path, canonical);
    const records = selections.resolve(registered.sources.map(row => row.token));
    assert.deepEqual(records.map(row => row.kind), ['folder', 'file']);
    const link = path.join(root, 'ordinary-link'); fs.symlinkSync(file, link);
    codes(() => selections.register([link]), 'SOURCE_SYMLINK_REJECTED');
    const linkedFolder = path.join(root, 'ordinary-folder-link'); fs.symlinkSync(root, linkedFolder);
    codes(() => selections.register([path.join(linkedFolder, 'native-drop.txt')]), 'SOURCE_SYMLINK_REJECTED');
  }
  const selections = new SourceSelections();
  for (const root of ['/var', '/tmp', '/private/var', '/private/tmp']) codes(() => selections.register([root]), 'SOURCE_SCOPE_TOO_BROAD');
});
test('macOS alias exception requires the expected canonical target', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t);
  const native = f.file.replace(/^\/private\/var\//, '/var/');
  assert.ok(native.startsWith('/var/'));
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', input => input === '/var' ? '/private/unexpected' : realpath(input));
  codes(() => f.selections.register([native]), 'SOURCE_SYMLINK_REJECTED');
});
