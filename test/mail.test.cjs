'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LocalMailArchive } = require('../mail.cjs');
const { CredentialVault } = require('../vault.cjs');

const NAME = 'SYNTHETIC_PRIVATE_MAIL_NAME_CANARY.eml';
const CONTENT = 'From: synthetic-person@example.test\nSubject: SYNTHETIC_BODY_CANARY_6247\n\nThis is invented mail data, never a real mailbox.';
function fixture(t, { secure = true, health = () => {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-mail-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Synthetic OS key wrapper. Never invoke OS keychain or access real secrets.
  const wrapper = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => secure, getSelectedStorageBackend: () => secure ? 'keychain' : 'basic_text',
    encryptString(value) { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrapper, nonce); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), data]); },
    decryptString(value) { const cipher = crypto.createDecipheriv('aes-256-gcm', wrapper, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
  };
  const vault = new CredentialVault({ directory, safeStorage, health });
  const archive = new LocalMailArchive({ directory, vault, health });
  const filename = id => path.join(directory, 'private-mail', `${id}.enc`);
  return { directory, archive, vault, safeStorage, filename };
}
test('explicit text import encrypts full name/body; only read returns body and list returns id/name', t => {
  const f = fixture(t); const imported = f.archive.import({ name: NAME, content: CONTENT });
  assert.deepEqual(Object.keys(imported), ['id']);
  assert.deepEqual(f.archive.list(), [{ id: imported.id, name: NAME }]);
  assert.deepEqual(f.archive.read(imported.id), { id: imported.id, name: NAME, content: CONTENT });
  assert.equal(f.archive.status().count, 1); assert.equal(f.archive.status().localOnly, true);
  const ciphertext = fs.readFileSync(f.filename(imported.id));
  for (const canary of [NAME, CONTENT, 'synthetic-person@example.test', 'SYNTHETIC_BODY_CANARY_6247']) assert.equal(ciphertext.includes(Buffer.from(canary)), false);
  const vaultText = fs.readFileSync(path.join(f.directory, 'credentials.enc.json'), 'utf8');
  assert.equal(vaultText.includes(NAME), false); assert.equal(vaultText.includes(CONTENT), false);
  assert.equal(vaultText.includes(f.vault.get('private-mail-master')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'private-mail')), [`${imported.id}.enc`]);
  assert.equal(fs.statSync(path.join(f.directory, 'private-mail')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.filename(imported.id)).mode & 0o777, 0o600);
});
test('records reopen with durable vault key and independent random nonces', t => {
  const f = fixture(t); const one = f.archive.import({ name: NAME, content: CONTENT }); const two = f.archive.import({ name: NAME, content: CONTENT });
  assert.notEqual(one.id, two.id);
  assert.notDeepEqual(fs.readFileSync(f.filename(one.id)).subarray(8, 20), fs.readFileSync(f.filename(two.id)).subarray(8, 20));
  f.vault.close();
  const vault = new CredentialVault({ directory: f.directory, safeStorage: f.safeStorage });
  const reopened = new LocalMailArchive({ directory: f.directory, vault });
  assert.equal(reopened.read(one.id).content, CONTENT); assert.equal(reopened.list().length, 2);
});
test('OS secure storage is required; memory fallback does not create archive/key', t => {
  const f = fixture(t, { secure: false });
  assert.equal(f.archive.status().supported, false);
  assert.throws(() => f.archive.import({ name: NAME, content: CONTENT }), /MAIL_SECURE_STORAGE_REQUIRED/);
  assert.throws(() => f.archive.list(), /MAIL_SECURE_STORAGE_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.directory, 'private-mail')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'credentials.enc.json')), false);
});
test('secure-storage downgrade after key write prevents a plaintext or ephemeral archive', t => {
  const f = fixture(t); const set = f.vault.set.bind(f.vault);
  t.mock.method(f.vault, 'set', (...args) => { set(...args); f.safeStorage.isEncryptionAvailable = () => false; });
  assert.throws(() => f.archive.import({ name: NAME, content: CONTENT }), /MAIL_SECURE_STORAGE_REQUIRED/);
  assert.equal(fs.existsSync(path.join(f.directory, 'private-mail')), false);
});
test('missing master key never regenerates over an existing archive', t => {
  const f = fixture(t); f.archive.import({ name: NAME, content: CONTENT }); f.vault.remove('private-mail-master');
  assert.throws(() => f.archive.import({ name: NAME, content: CONTENT }), /MAIL_KEY_UNAVAILABLE/);
  assert.throws(() => f.archive.list(), /MAIL_KEY_UNAVAILABLE/);
  assert.equal(f.vault.get('private-mail-master'), undefined);
});
test('authentication binds ciphertext to its UUID and detects tampering', t => {
  const f = fixture(t); const one = f.archive.import({ name: NAME, content: CONTENT }); const two = f.archive.import({ name: 'Other', content: 'Synthetic second body' });
  fs.copyFileSync(f.filename(one.id), f.filename(two.id));
  assert.throws(() => f.archive.read(two.id), /MAIL_RECORD_UNAVAILABLE/);
  const data = fs.readFileSync(f.filename(one.id)); data[data.length - 1] ^= 1; fs.writeFileSync(f.filename(one.id), data);
  assert.throws(() => f.archive.read(one.id), /MAIL_RECORD_UNAVAILABLE/);
});
test('random UUID collisions never overwrite an existing record', t => {
  const f = fixture(t); const one = f.archive.import({ name: NAME, content: CONTENT }); const original = fs.readFileSync(f.filename(one.id));
  t.mock.method(crypto, 'randomUUID', () => one.id);
  assert.throws(() => f.archive.import({ name: 'different', content: 'Different body' }), /MAIL_IMPORT_FAILED/);
  assert.deepEqual(fs.readFileSync(f.filename(one.id)), original); assert.equal(f.archive.read(one.id).content, CONTENT);
});
test('record symlinks and hardlinks are rejected without reading or writing targets', t => {
  const f = fixture(t); const one = f.archive.import({ name: NAME, content: CONTENT });
  const outside = path.join(f.directory, 'outside.txt'); fs.writeFileSync(outside, 'SYNTHETIC_TARGET', { mode: 0o600 });
  fs.unlinkSync(f.filename(one.id)); fs.symlinkSync(outside, f.filename(one.id));
  assert.throws(() => f.archive.read(one.id), /MAIL_RECORD_UNAVAILABLE/); assert.throws(() => f.archive.list(), /MAIL_UNSAFE_FILE/);
  assert.throws(() => f.archive.import({ name: NAME, content: CONTENT }), /MAIL_UNSAFE_FILE/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SYNTHETIC_TARGET');
  fs.unlinkSync(f.filename(one.id)); fs.linkSync(outside, f.filename(one.id));
  assert.throws(() => f.archive.read(one.id), /MAIL_RECORD_UNAVAILABLE/);
});
test('symlinked/replaced archive directory is refused and missing mounts are never recreated', t => {
  const f = fixture(t); const one = f.archive.import({ name: NAME, content: CONTENT });
  const original = path.join(f.directory, 'private-mail'), moved = path.join(f.directory, 'moved'); fs.renameSync(original, moved); fs.symlinkSync(moved, original);
  assert.throws(() => f.archive.read(one.id), /MAIL_STORAGE_UNAVAILABLE/);
  fs.unlinkSync(original); fs.mkdirSync(original);
  assert.throws(() => f.archive.list(), /MAIL_STORAGE_UNAVAILABLE/);
  assert.throws(() => new LocalMailArchive({ directory: path.join(f.directory, 'absent', 'storage'), vault: f.vault }), /MAIL_STORAGE_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(f.directory, 'absent')), false);
});
test('failed health check stops reads, lists and imports without new files', t => {
  let healthy = true; const f = fixture(t, { health: () => { if (!healthy) throw Error('Underlying path should never leak'); } });
  const one = f.archive.import({ name: NAME, content: CONTENT }); healthy = false;
  for (const action of [() => f.archive.read(one.id), () => f.archive.list(), () => f.archive.import({ name: NAME, content: CONTENT })]) assert.throws(action, { message: 'MAIL_STORAGE_UNAVAILABLE' });
  assert.equal(fs.readdirSync(path.join(f.directory, 'private-mail')).length, 1);
});
test('content/filename/ID and encrypted-file size checks reject invalid inputs', t => {
  const f = fixture(t);
  for (const content of ['', ' ', '\0', 'x'.repeat(2 * 1024 * 1024 + 1)]) assert.throws(() => f.archive.import({ name: NAME, content }), /MAIL_INVALID_CONTENT/);
  for (const name of ['', 'bad\nname', 'x'.repeat(513)]) assert.throws(() => f.archive.import({ name, content: CONTENT }), /MAIL_INVALID_NAME/);
  for (const id of ['../outside', '__proto__', '', 42]) assert.throws(() => f.archive.read(id), /MAIL_INVALID_ID/);
  const one = f.archive.import({ name: NAME, content: CONTENT }); fs.truncateSync(f.filename(one.id), 13 * 1024 * 1024);
  assert.throws(() => f.archive.read(one.id), /MAIL_RECORD_UNAVAILABLE/); assert.throws(() => f.archive.list(), /MAIL_UNSAFE_FILE/);
});
test('name is encrypted metadata and cannot select a disk filename', t => {
  const f = fixture(t); const one = f.archive.import({ name: '../../outside.eml', content: CONTENT });
  assert.equal(f.archive.read(one.id).name, '../../outside.eml');
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'private-mail')), [`${one.id}.enc`]);
  assert.equal(fs.existsSync(path.join(f.directory, 'outside.eml')), false);
});
