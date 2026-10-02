'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { FILES, stage, inspect, verify, pack } = require('../scripts/package-source.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return temp;
}
test('runtime scan rejects private capabilities, paths, emails and credentials without echoing values', () => {
  for (const value of ['antigravity', '/Users/synthetic/private', 'synthetic@example.invalid', 'sk-' + 'x'.repeat(24)]) {
    assert.throws(() => inspect('ui/app.js', value), /value withheld/);
  }
  assert.throws(() => inspect('README.md', 'ghp_' + 'x'.repeat(30)), /value withheld/);
});
test('source staging ignores all unlisted files and verifies exact released bytes', t => {
  const temp = fixture(t), source = path.join(temp, 'source'), output = path.join(temp, 'output');
  fs.mkdirSync(source);
  for (const file of FILES) { const target = path.join(source, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(__dirname, '..', file), target); }
  for (const file of ['.env', 'mail.json', 'aws.pem', 'private.sqlite']) fs.writeFileSync(path.join(source, file), 'NEVER_PACKAGE');
  const staged = stage({ root: source, destination: output });
  assert.equal(fs.existsSync(path.join(output, '.env')), false);
  assert.equal(fs.existsSync(path.join(output, 'mail.json')), false);
  assert.equal(verify(output, staged.sourceSnapshot).verified, true);
  assert.throws(() => verify(output, 'wrong-reviewed-digest'), /reviewed source/);
  fs.appendFileSync(path.join(output, 'ui/app.js'), '\n// changed');
  assert.throws(() => verify(output, staged.sourceSnapshot), /bytes changed/);
  fs.writeFileSync(path.join(output, 'unexpected.txt'), 'unexpected');
  assert.throws(() => verify(output, staged.sourceSnapshot), /Unexpected artifact entry/);
});
test('source staging rejects symlink inputs including directory links', t => {
  const temp = fixture(t), source = path.join(temp, 'source'), output = path.join(temp, 'output');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'fixture'), 'safe');
  fs.mkdirSync(path.dirname(path.join(source, FILES[0])), { recursive: true });
  try { fs.symlinkSync(path.join(source, 'fixture'), path.join(source, FILES[0])); }
  catch (error) { if (error.code === 'EPERM') return t.skip('OS denies creation of test symlinks'); throw error; }
  assert.throws(() => stage({ root: source, destination: output }), /Symlink/);
  fs.rmSync(path.join(source, '.github'), { recursive: true });
  fs.mkdirSync(path.join(source, 'linked-directory'));
  fs.symlinkSync(path.join(source, 'linked-directory'), path.join(source, '.github'), 'junction');
  assert.throws(() => stage({ root: source, destination: output }), /Symlink/);
});
test('only approved logo bytes may enter the source artifact', () => {
  const logo = fs.readFileSync(path.join(__dirname, '../ui/logo.png'));
  assert.doesNotThrow(() => inspect('ui/logo.png', logo));
  assert.throws(() => inspect('ui/logo.png', Buffer.concat([logo, Buffer.from('hidden metadata')])), /Unapproved binary/);
});
test('tar source release is standalone and inspected after extraction', t => {
  const source = path.join(fixture(t), 'source');
  stage({ destination: source });
  const result = pack(source);
  assert.ok(fs.statSync(result.archive).size > 0);
  assert.match(fs.readFileSync(result.archive + '.sha256', 'utf8'), new RegExp('^' + result.sha256));
  assert.equal(result.files, FILES.length);
  const tar = require('node:zlib').gunzipSync(fs.readFileSync(result.archive));
  let entries = 0;
  for (let offset = 0; offset < tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    for (const start of [265, 297]) assert.ok(['', 'root'].includes(header.subarray(start, start + 32).toString().replace(/\0.*$/s, '')));
    for (const start of [108, 116]) assert.equal(parseInt(header.subarray(start, start + 8).toString(), 8), 0);
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    offset += 512 + Math.ceil(size / 512) * 512; entries++;
  }
  assert.ok(entries >= FILES.length);
});
