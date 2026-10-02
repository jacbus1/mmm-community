'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MASTER = 'private-mail-master';
const MAGIC = Buffer.from('MMMMail1');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ENCRYPTED = MAX_BODY * 6 + 4096; // JSON escaping can expand a control character sixfold.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fault(code) { return Object.assign(new Error(code), { code, status: 400 }); }
function identity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function validateRecord(record) {
  if (!record || typeof record.name !== 'string' || !record.name.trim() || Buffer.byteLength(record.name) > 512 || /[\0\r\n]/.test(record.name)) throw fault('MAIL_INVALID_NAME');
  if (typeof record.content !== 'string' || !record.content.trim() || record.content.includes('\0') || Buffer.byteLength(record.content) > MAX_BODY) throw fault('MAIL_INVALID_CONTENT');
}
class LocalMailArchive {
  constructor({ directory, vault, health = () => {} }) {
    this.vault = vault; this.health = health;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fault('MAIL_STORAGE_UNAVAILABLE');
    this.requestedDirectory = directory;
    try {
      health(); this.directory = fs.realpathSync(directory);
      const root = fs.statSync(this.directory); if (!root.isDirectory()) throw Error();
      this.rootIdentity = identity(root); this.archive = path.join(this.directory, 'private-mail');
    } catch { throw fault('MAIL_STORAGE_UNAVAILABLE'); }
    this.archiveIdentity = null;
  }
  _ready(create = false) {
    try {
      const health = this.health(); if (health === false || health?.ok === false) throw Error();
      if (fs.realpathSync(this.requestedDirectory) !== this.directory || !same(fs.statSync(this.directory), this.rootIdentity)) throw Error();
      let stat;
      try { stat = fs.lstatSync(this.archive); }
      catch (error) {
        if (error.code !== 'ENOENT' || this.archiveIdentity) throw error;
        if (!create) return false;
        fs.mkdirSync(this.archive, { mode: 0o700 }); stat = fs.lstatSync(this.archive);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.archive) !== this.archive) throw Error();
      if (this.archiveIdentity && !same(stat, this.archiveIdentity)) throw Error();
      this.archiveIdentity = identity(stat);
      fs.chmodSync(this.archive, 0o700); return true;
    } catch { throw fault('MAIL_STORAGE_UNAVAILABLE'); }
  }
  _secure() {
    try { if (this.vault.persistent() !== true) throw Error(); }
    catch { throw fault('MAIL_SECURE_STORAGE_REQUIRED'); }
  }
  _names() {
    if (!this._ready()) return [];
    try {
      const names = fs.readdirSync(this.archive);
      if (names.length > 1000) throw fault('MAIL_ARCHIVE_LIMIT');
      for (const name of names) {
        if (!name.endsWith('.enc') || !UUID.test(name.slice(0, -4))) throw fault('MAIL_UNSAFE_FILE');
        const stat = fs.lstatSync(path.join(this.archive, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_ENCRYPTED || stat.size < 36) throw fault('MAIL_UNSAFE_FILE');
      }
      return names;
    } catch (error) { if (['MAIL_ARCHIVE_LIMIT', 'MAIL_UNSAFE_FILE'].includes(error.code)) throw error; throw fault('MAIL_STORAGE_UNAVAILABLE'); }
  }
  _key(create = false) {
    this._secure(); this._ready();
    let value;
    try {
      value = this.vault.get(MASTER);
      if (!value && create) {
        if (this._names().length) throw fault('MAIL_KEY_UNAVAILABLE');
        const fresh = crypto.randomBytes(32);
        try { this.vault.set(MASTER, fresh.toString('base64')); } finally { fresh.fill(0); }
        value = this.vault.get(MASTER);
      }
      if (this.vault.status(MASTER)?.storage !== 'os-protected') throw fault('MAIL_SECURE_STORAGE_REQUIRED');
    } catch (error) { if (['MAIL_KEY_UNAVAILABLE', 'MAIL_SECURE_STORAGE_REQUIRED'].includes(error.code)) throw error; throw fault('MAIL_KEY_UNAVAILABLE'); }
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw fault('MAIL_KEY_UNAVAILABLE');
    const key = Buffer.from(value, 'base64'); if (key.length !== 32) throw fault('MAIL_KEY_UNAVAILABLE'); return key;
  }
  _read(id, key) {
    if (!UUID.test(id)) throw fault('MAIL_INVALID_ID');
    this._ready(); const filename = path.join(this.archive, `${id}.enc`);
    let fd, plaintext;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size < 36 || stat.size > MAX_ENCRYPTED) throw Error();
      const encrypted = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < encrypted.length) { const read = fs.readSync(fd, encrypted, offset, encrypted.length - offset, offset); if (!read) throw Error(); offset += read; }
      if (fs.fstatSync(fd).size !== stat.size || !encrypted.subarray(0, 8).equals(MAGIC)) throw Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(8, 20));
      decipher.setAAD(Buffer.from(`MMM_PRIVATE_MAIL_V1:${id}`)); decipher.setAuthTag(encrypted.subarray(20, 36));
      plaintext = Buffer.concat([decipher.update(encrypted.subarray(36)), decipher.final()]);
      const record = JSON.parse(plaintext.toString('utf8')); validateRecord(record);
      this._ready(); return { id, name: record.name, content: record.content };
    } catch { throw fault('MAIL_RECORD_UNAVAILABLE'); }
    finally { if (fd !== undefined) fs.closeSync(fd); plaintext?.fill(0); }
  }
  import(input) {
    validateRecord(input); this._secure(); this._ready();
    if (this._names().length >= 1000) throw fault('MAIL_ARCHIVE_LIMIT');
    const key = this._key(true), id = crypto.randomUUID();
    const nonce = crypto.randomBytes(12); let plaintext, fd;
    try {
      this._ready(true);
      plaintext = Buffer.from(JSON.stringify({ name: input.name, content: input.content }));
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`MMM_PRIVATE_MAIL_V1:${id}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const record = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
      // Exclusive creation: never replace existing records or follow a symlink.
      fd = fs.openSync(path.join(this.archive, `${id}.enc`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, record); fs.fsyncSync(fd); this._ready();
      return { id };
    } catch { throw fault('MAIL_IMPORT_FAILED'); }
    finally { if (fd !== undefined) fs.closeSync(fd); plaintext?.fill(0); key.fill(0); }
  }
  list() {
    this._secure(); const names = this._names(); if (!names.length) return [];
    const key = this._key();
    try { return names.sort().map(name => { const record = this._read(name.slice(0, -4), key); return { id: record.id, name: record.name }; }); }
    finally { key.fill(0); }
  }
  read(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fault('MAIL_INVALID_ID');
    this._secure(); this._ready(); const key = this._key();
    try { return this._read(id, key); } finally { key.fill(0); }
  }
  status() {
    const ready = this._ready();
    let secure = false; try { secure = this.vault.persistent() === true; } catch {}
    return { storage: secure ? 'os-protected' : 'unavailable', supported: secure, count: ready ? this._names().length : 0, localOnly: true };
  }
}
module.exports = { LocalMailArchive };
