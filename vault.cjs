'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError, id } = require('./security.cjs');
class CredentialVault {
  constructor({ directory, safeStorage, health = () => {} }) {
    this.directory = directory; this.safeStorage = safeStorage; this.health = health; this.memory = new Map();
    this.file = path.join(directory, 'credentials.enc.json');
  }
  persistent() {
    try { return Boolean(this.safeStorage?.isEncryptionAvailable()) && this.safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }
  read() {
    this.health();
    if (!fs.existsSync(this.file)) return {};
    if (fs.lstatSync(this.file).isSymbolicLink()) throw new AppError('UNSAFE_CREDENTIAL_STORE');
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
    catch { throw new AppError('CREDENTIAL_STORE_UNAVAILABLE', 503); }
  }
  write(data) {
    this.health(); const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  set(providerId, key) {
    id(providerId); if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\0]/.test(key)) throw new AppError('INVALID_KEY');
    if (this.persistent()) { const data = this.read(); data[providerId] = this.safeStorage.encryptString(key.trim()).toString('base64'); this.write(data); this.memory.delete(providerId); }
    else this.memory.set(providerId, key.trim());
    return this.status(providerId);
  }
  get(providerId) {
    id(providerId); if (this.memory.has(providerId)) return this.memory.get(providerId);
    if (!this.persistent()) return undefined;
    const value = this.read()[providerId]; if (!value) return undefined;
    try { return this.safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { throw new AppError('CREDENTIAL_UNLOCK_FAILED', 503); }
  }
  remove(providerId) { id(providerId); this.memory.delete(providerId); const data = this.read(); delete data[providerId]; this.write(data); }
  status(providerId) { id(providerId); return { configured: this.memory.has(providerId) || (this.persistent() && Boolean(this.read()[providerId])), storage: this.memory.has(providerId) ? 'memory' : this.persistent() ? 'os-protected' : 'memory', credentialRef: providerId }; }
  publicStatus() { return { storage: this.persistent() ? 'os-protected' : 'memory', persistent: this.persistent() }; }
  transferSessionTo(other) { for (const [reference, secret] of this.memory) other.memory.set(reference, secret); }
  close() { this.memory.clear(); }
}
module.exports = { CredentialVault };
