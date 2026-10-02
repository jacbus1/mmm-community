'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SourceAccess } = require('../source-access.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mmm-source-access-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const file = path.join(root, 'README.md'); fs.writeFileSync(file, 'Synthetic public text 中文\n');
  const sources = [{ id: 'folder-1', name: 'Example folder', path: root, kind: 'folder', access: 'reference-only' }, { id: 'file-1', name: 'Example file', path: file, kind: 'file', access: 'reference-only' }];
  const projects = new Map([['project-1', { id: 'project-1', sources }], ['project-2', { id: 'project-2', sources: [] }]]), settings = new Map();
  const store = { getProject: id => structuredClone(projects.get(id)), getSetting: key => structuredClone(settings.get(key)), setSetting: (key, value) => { assert.ok(key.length <= 100); settings.set(key, structuredClone(value)); } };
  const access = new SourceAccess({ store });
  return { base, root, file, sources, projects, settings, store, access };
}
function code(fn, expected, status) { assert.throws(fn, error => error.code === expected && error.message === expected && (status === undefined || error.status === status)); }

test('reference metadata never grants read; explicit grant persists identity only and revoke stops reads', t => {
  const f = fixture(t); const snapshot = JSON.stringify(f.projects.get('project-1'));
  const described = f.access.describe('project-1', 'folder-1');
  assert.deepEqual(described.permission, { mode: 'reference-only', granted: false }); assert.equal(described.content, undefined);
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
  code(() => f.access.read('project-1', 'file-1'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
  const granted = f.access.grantRead('project-1', 'folder-1'); assert.deepEqual(granted.permission, { mode: 'read-local', granted: true });
  assert.equal(f.access.read('project-1', 'folder-1', 'README.md').content, 'Synthetic public text 中文\n');
  assert.equal(f.settings.size, 1); const grant = [...f.settings.values()][0];
  assert.equal(grant.rootPath, f.root); assert.equal(grant.dev, fs.statSync(f.root).dev); assert.equal(grant.ino, fs.statSync(f.root).ino);
  assert.equal(JSON.stringify(f.projects.get('project-1')), snapshot); assert.ok(!JSON.stringify([...f.settings]).includes('Synthetic public text'));
  const next = new SourceAccess({ store: f.store }); assert.equal(next.describe('project-1', 'folder-1').permission.granted, true);
  assert.equal(next.revoke('project-1', 'folder-1').permission.granted, false);
  code(() => next.read('project-1', 'folder-1', 'README.md'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
});
test('project scope and imported access fields cannot impersonate a native grant', t => {
  const f = fixture(t); f.sources[0].access = 'read-local';
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
  f.access.grantRead('project-1', 'folder-1');
  f.projects.get('project-2').sources = [structuredClone(f.sources[0])];
  code(() => f.access.list('project-2', 'folder-1'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
  code(() => f.access.read('project-1', f.file), 'SOURCE_ID_INVALID');
  code(() => f.access.read('project-2', 'file-1'), 'SOURCE_NOT_FOUND', 404);
});
test('describe and grant read metadata only, never contents or directory listings', t => {
  const f = fixture(t);
  for (const method of ['readFileSync', 'readFile', 'readSync', 'readdirSync', 'readdir', 'opendirSync', 'opendir']) t.mock.method(fs, method, () => { throw Error('No read during consent'); });
  assert.equal(f.access.describe('project-1', 'folder-1').permission.granted, false);
  assert.equal(f.access.grantRead('project-1', 'folder-1').permission.granted, true);
});
test('list returns only bounded immediate metadata and excludes sensitive paths and links', t => {
  const f = fixture(t); const sub = path.join(f.root, 'subfolder'); fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'nested.txt'), 'Not recursively listed');
  const blockedFiles = ['.env', '.env.production', 'credentials.json', 'auth-token.txt', 'passwords.txt', 'private-key.txt', 'id_rsa', 'certificate.pem'];
  const blockedDirs = ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.cache', 'cache', 'profiles', 'private-mail'];
  for (const name of blockedFiles) fs.writeFileSync(path.join(f.root, name), 'Sensitive synthetic content');
  for (const name of blockedDirs) fs.mkdirSync(path.join(f.root, name));
  fs.symlinkSync(f.file, path.join(f.root, 'linked.md'));
  f.access.grantRead('project-1', 'folder-1');
  const listed = f.access.list('project-1', 'folder-1');
  assert.deepEqual(listed.entries.map(row => row.name).sort(), ['README.md', 'subfolder']);
  for (const row of listed.entries) assert.deepEqual(Object.keys(row), ['name', 'relative', 'kind', 'bytes']);
  assert.equal(listed.truncated, false); assert.ok(!JSON.stringify(listed).includes('Sensitive synthetic content'));
  assert.equal(f.access.list('project-1', 'folder-1', 'subfolder').entries[0].relative, 'subfolder/nested.txt');
  for (const name of [...blockedFiles, ...blockedDirs]) code(() => f.access.read('project-1', 'folder-1', name), 'SOURCE_SENSITIVE_PATH_BLOCKED', 403);
});
test('list never reads file content and returns at most two hundred entries', t => {
  const f = fixture(t); for (let i = 0; i < 210; i++) fs.writeFileSync(path.join(f.root, `entry-${i}.txt`), 'canary');
  f.access.grantRead('project-1', 'folder-1');
  for (const method of ['readFileSync', 'readFile', 'readSync']) t.mock.method(fs, method, () => { throw Error('No content in list'); });
  const listed = f.access.list('project-1', 'folder-1'); assert.equal(listed.entries.length, 200); assert.equal(listed.truncated, true);
});
test('relative traversal, absolute paths, control characters and drive forms are rejected', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1');
  for (const relative of ['../README.md', 'x/../README.md', './README.md', '/etc/passwd', 'C:/outside.txt', 'x\\outside.txt', 'x//y', 'x/', 'x\0y', 'x\ny', {}, null]) {
    code(() => f.access.read('project-1', 'folder-1', relative), 'SOURCE_RELATIVE_PATH_INVALID');
    code(() => f.access.list('project-1', 'folder-1', relative), 'SOURCE_RELATIVE_PATH_INVALID');
  }
});
test('file sources read only themselves; granted root and child symlinks are blocked', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'file-1');
  assert.equal(f.access.read('project-1', 'file-1').encoding, 'utf-8');
  code(() => f.access.read('project-1', 'file-1', 'README.md'), 'SOURCE_RELATIVE_PATH_INVALID');
  code(() => f.access.list('project-1', 'file-1'), 'SOURCE_FOLDER_REQUIRED');
  f.access.grantRead('project-1', 'folder-1'); const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'safe.txt'), 'Outside canary');
  fs.symlinkSync(outside, path.join(f.root, 'link'));
  code(() => f.access.read('project-1', 'folder-1', 'link/safe.txt'), 'SOURCE_SYMLINK_REJECTED', 403);
  fs.renameSync(f.root, path.join(f.base, 'original')); fs.symlinkSync(outside, f.root);
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_SYMLINK_REJECTED', 403);
});
test('changed source reference or root inode invalidates a persisted grant', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1');
  const original = path.join(f.base, 'original'); fs.renameSync(f.root, original); fs.mkdirSync(f.root);
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_TARGET_CHANGED', 403);
  f.sources[0].path = original;
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_READ_PERMISSION_REQUIRED', 403);
});
test('sensitive selected roots and canonical-reference violations cannot be granted', t => {
  const f = fixture(t); const secret = path.join(f.base, '.env.local'); fs.writeFileSync(secret, 'Synthetic only');
  f.sources[1].path = secret; code(() => f.access.grantRead('project-1', 'file-1'), 'SOURCE_SENSITIVE_PATH_BLOCKED', 403);
  const link = path.join(f.base, 'alias'); fs.symlinkSync(f.root, link); f.sources[0].path = link;
  code(() => f.access.grantRead('project-1', 'folder-1'), 'SOURCE_SYMLINK_REJECTED', 403);
  for (const broad of ['/', os.homedir(), '/Volumes/Synthetic']) { f.sources[0].path = broad; code(() => f.access.grantRead('project-1', 'folder-1'), 'SOURCE_SCOPE_TOO_BROAD', 403); }
});
test('only listed UTF-8 plain text extensions can be read, with 256KiB boundary', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1');
  for (const extension of ['md', 'txt', 'json', 'csv', 'js', 'ts', 'py', 'cjs', 'html', 'css']) {
    fs.writeFileSync(path.join(f.root, 'example.' + extension), 'Synthetic UTF-8 中文\n\t');
    assert.equal(f.access.read('project-1', 'folder-1', 'example.' + extension).content, 'Synthetic UTF-8 中文\n\t');
  }
  fs.writeFileSync(path.join(f.root, 'image.png'), 'Pretend image'); code(() => f.access.read('project-1', 'folder-1', 'image.png'), 'SOURCE_TEXT_TYPE_REQUIRED', 403);
  fs.writeFileSync(path.join(f.root, 'limit.txt'), 'a'.repeat(256 * 1024)); assert.equal(f.access.read('project-1', 'folder-1', 'limit.txt').bytes, 256 * 1024);
  fs.appendFileSync(path.join(f.root, 'limit.txt'), 'b'); code(() => f.access.read('project-1', 'folder-1', 'limit.txt'), 'SOURCE_FILE_TOO_LARGE', 413);
  fs.writeFileSync(path.join(f.root, 'binary.txt'), Buffer.from([0xff, 0xfe, 0xff])); code(() => f.access.read('project-1', 'folder-1', 'binary.txt'), 'SOURCE_BINARY_BLOCKED', 403);
  fs.writeFileSync(path.join(f.root, 'binary.txt'), Buffer.from([0x61, 0, 0x62])); code(() => f.access.read('project-1', 'folder-1', 'binary.txt'), 'SOURCE_BINARY_BLOCKED', 403);
});
test('hard-linked files are excluded and cannot be read through references', t => {
  const f = fixture(t); const outside = path.join(f.base, 'outside.txt'); fs.writeFileSync(outside, 'Synthetic external text');
  fs.linkSync(outside, path.join(f.root, 'hardlink.txt')); f.access.grantRead('project-1', 'folder-1');
  assert.ok(!f.access.list('project-1', 'folder-1').entries.some(row => row.name === 'hardlink.txt'));
  code(() => f.access.read('project-1', 'folder-1', 'hardlink.txt'), 'SOURCE_FILE_REQUIRED');
});
test('no-follow descriptor flag is used and changed bytes during read fail closed', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'file-1'); const open = fs.openSync, read = fs.readSync; let sawNoFollow = false, changed = false;
  t.mock.method(fs, 'openSync', (filename, flags, ...rest) => { if (filename === f.file && typeof flags === 'number') sawNoFollow = (flags & fs.constants.O_NOFOLLOW) !== 0; return open(filename, flags, ...rest); });
  t.mock.method(fs, 'readSync', (...args) => { const size = read(...args); if (!changed) { changed = true; fs.appendFileSync(f.file, 'changed'); } return size; });
  code(() => f.access.read('project-1', 'file-1'), 'SOURCE_TARGET_CHANGED', 403); assert.equal(sawNoFollow, true);
});
test('target replacement between stat and descriptor open cannot return substituted bytes', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1'); const open = fs.openSync; let changed = false;
  t.mock.method(fs, 'openSync', (filename, flags, ...rest) => {
    if (filename === f.file && typeof flags === 'number' && !changed) { changed = true; fs.renameSync(f.file, path.join(f.root, 'saved.md')); fs.writeFileSync(f.file, 'SUBSTITUTED_CANARY'); }
    return open(filename, flags, ...rest);
  });
  code(() => f.access.read('project-1', 'folder-1', 'README.md'), 'SOURCE_TARGET_CHANGED', 403);
});
test('directory substitution during enumeration fails revalidation', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1'); const open = fs.opendirSync;
  t.mock.method(fs, 'opendirSync', (...args) => { fs.renameSync(f.root, path.join(f.base, 'old-root')); fs.mkdirSync(f.root); return open(...args); });
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_TARGET_CHANGED', 403);
});
test('missing targets and Store failures return generic errors with no paths or content', t => {
  const f = fixture(t); f.access.grantRead('project-1', 'folder-1');
  code(() => f.access.read('project-1', 'folder-1', 'missing.txt'), 'SOURCE_UNAVAILABLE', 503);
  fs.renameSync(f.root, path.join(f.base, 'offline-volume'));
  code(() => f.access.list('project-1', 'folder-1'), 'SOURCE_UNAVAILABLE', 503); assert.equal(fs.existsSync(f.root), false);
  t.mock.method(f.store, 'getProject', () => { throw Error('SECRET_PATH_AND_BODY_CANARY'); });
  code(() => f.access.describe('project-1', 'folder-1'), 'SOURCE_UNAVAILABLE', 503);
});
test('metacharacter filenames remain metadata strings; no execution or project mutation', t => {
  const f = fixture(t); const name = 'quote "; $(command) & `example`.txt'; fs.writeFileSync(path.join(f.root, name), 'Synthetic display text');
  f.access.grantRead('project-1', 'folder-1');
  assert.ok(f.access.list('project-1', 'folder-1').entries.some(row => row.name === name));
  assert.equal(f.access.read('project-1', 'folder-1', name).content, 'Synthetic display text');
  assert.equal(f.projects.get('project-1').sources[0].access, 'reference-only');
});
