'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CredentialVault } = require('../vault.cjs');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-vault-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('without OS encryption or basic_text vault is memory only', t => {
  const directory = temporary(t); const vault = new CredentialVault({ directory, safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  vault.set('test', 'synthetic-canary-key'); assert.equal(vault.get('test'), 'synthetic-canary-key'); assert.equal(fs.readdirSync(directory).length, 0); assert.equal(vault.status('test').storage, 'memory'); vault.close(); assert.equal(vault.get('test'), undefined);
});
test('OS adapter persistence contains ciphertext only and status never key', t => {
  const directory = temporary(t), key = crypto.randomBytes(32);
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => { const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); const body = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]); }, decryptString: blob => { const cipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); cipher.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString(); } };
  const vault = new CredentialVault({ directory, safeStorage }); vault.set('test', 'synthetic-canary-key');
  assert.ok(!fs.readFileSync(vault.file, 'utf8').includes('synthetic-canary-key'));
  assert.equal(new CredentialVault({ directory, safeStorage }).get('test'), 'synthetic-canary-key');
  assert.ok(!JSON.stringify(vault.status('test')).includes('synthetic-canary-key'));
  vault.remove('test'); assert.equal(vault.get('test'), undefined);
});
