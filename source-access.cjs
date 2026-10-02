'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;
const MAX_SCANNED = 1000;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.js', '.ts', '.py', '.cjs', '.html', '.css']);
function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fault('SOURCE_ID_INVALID'); return value; }
function settingKey(projectId, sourceId) { return 'source-access:' + crypto.createHash('sha256').update(JSON.stringify([projectId, sourceId])).digest('hex'); }
function relativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw fault('SOURCE_RELATIVE_PATH_INVALID');
  if (value && value.split('/').some(part => !part || part === '.' || part === '..')) throw fault('SOURCE_RELATIVE_PATH_INVALID');
  return value;
}
function blocked(name) {
  return /^\.env/i.test(name) || /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.netrc|\.pypirc)$/i.test(name)
    || /credential|token|password|secret|private[-_]?key/i.test(name)
    || /(?:^|[._ -])(?:mail|maildir|profiles?|caches?)(?:$|[._ -])/i.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(name);
}
function safeName(name) { return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 512 && !/[\x00-\x1f\x7f]/.test(name) && !blocked(name); }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a, b) { return same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function metadata(source, grant) {
  return { id: source.id, name: source.name, path: source.path, kind: source.kind, access: 'reference-only',
    permission: { mode: grant ? 'read-local' : 'reference-only', granted: Boolean(grant) } };
}
function checkedStat(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw fault('SOURCE_SYMLINK_REJECTED', 403);
  if (!stat.isFile() && !stat.isDirectory()) throw fault('SOURCE_TYPE_UNSUPPORTED', 403);
  return stat;
}
function generic(action) {
  try { return action(); }
  catch (error) {
    // Never relay OS paths, imported metadata, Store exceptions or file bytes.
    if (error && error.constructor === Error && /^SOURCE_[A-Z_]+$/.test(error.code || '') && error.message === error.code) throw error;
    throw fault('SOURCE_UNAVAILABLE', 503);
  }
}

// Only sender-validated native confirmation may call grantRead. This module
// deliberately has no network, model, project-write or content-persistence API.
class SourceAccess {
  constructor({ store }) { this.store = store; }
  _source(projectId, sourceId) {
    validId(projectId); validId(sourceId);
    const project = this.store.getProject(projectId);
    const source = project?.sources?.find(row => row.id === sourceId);
    if (!source) throw fault('SOURCE_NOT_FOUND', 404);
    if (!['folder', 'file'].includes(source.kind) || typeof source.path !== 'string' || !path.isAbsolute(source.path) || /[\x00-\x1f\x7f]/.test(source.path) || path.resolve(source.path) !== source.path) throw fault('SOURCE_REFERENCE_INVALID');
    return { id: source.id, name: String(source.name || '').slice(0, 512), path: source.path, kind: source.kind };
  }
  _grant(projectId, source) {
    const grant = this.store.getSetting(settingKey(projectId, source.id));
    return grant?.mode === 'read-local' && grant.projectId === projectId && grant.sourceId === source.id && grant.rootPath === source.path && grant.kind === source.kind
      && Number.isSafeInteger(grant.dev) && Number.isSafeInteger(grant.ino) ? grant : null;
  }
  _root(source) {
    if (source.path === path.parse(source.path).root || source.path === path.resolve(os.homedir()) || /^\/Volumes\/[^/]+$/.test(source.path)) throw fault('SOURCE_SCOPE_TOO_BROAD', 403);
    let cursor = source.path;
    // Stored references must already be canonical. Unlike the native selector,
    // this permission reader never resolves user-supplied aliases into grants.
    for (;;) {
      if (blocked(path.basename(cursor))) throw fault('SOURCE_SENSITIVE_PATH_BLOCKED', 403);
      checkedStat(cursor);
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    if (fs.realpathSync(source.path) !== source.path) throw fault('SOURCE_REFERENCE_INVALID', 403);
    const root = checkedStat(source.path);
    if ((source.kind === 'folder') !== root.isDirectory()) throw fault('SOURCE_TARGET_CHANGED', 403);
    return root;
  }
  _authorized(projectId, sourceId) {
    const source = this._source(projectId, sourceId), grant = this._grant(projectId, source);
    if (!grant) throw fault('SOURCE_READ_PERMISSION_REQUIRED', 403);
    const root = this._root(source);
    if (!same(root, grant)) throw fault('SOURCE_TARGET_CHANGED', 403);
    return { source, grant, root };
  }
  _target(context, relative) {
    if (context.source.kind === 'file' && relative) throw fault('SOURCE_RELATIVE_PATH_INVALID');
    const filename = relative ? path.join(context.source.path, ...relative.split('/')) : context.source.path;
    const escaped = path.relative(context.source.path, filename);
    if (escaped.startsWith('..' + path.sep) || escaped === '..' || path.isAbsolute(escaped)) throw fault('SOURCE_OUTSIDE_REFERENCE', 403);
    let cursor = context.source.path;
    for (const component of relative ? relative.split('/') : []) {
      if (!safeName(component)) throw fault('SOURCE_SENSITIVE_PATH_BLOCKED', 403);
      cursor = path.join(cursor, component); checkedStat(cursor);
    }
    if (fs.realpathSync(filename) !== filename) throw fault('SOURCE_SYMLINK_REJECTED', 403);
    return { filename, stat: checkedStat(filename) };
  }
  _recheck(projectId, sourceId, context, relative, target) {
    const latest = this._authorized(projectId, sourceId);
    if (latest.source.path !== context.source.path || !same(latest.root, context.root)) throw fault('SOURCE_TARGET_CHANGED', 403);
    const current = this._target(latest, relative);
    if (!same(current.stat, target.stat)) throw fault('SOURCE_TARGET_CHANGED', 403);
    return current.stat;
  }
  describe(projectId, sourceId) {
    return generic(() => { const source = this._source(projectId, sourceId); return metadata(source, this._grant(projectId, source)); });
  }
  grantRead(projectId, sourceId) {
    return generic(() => {
      const source = this._source(projectId, sourceId), root = this._root(source);
      const grant = { mode: 'read-local', projectId, sourceId, rootPath: source.path, kind: source.kind, dev: root.dev, ino: root.ino };
      this.store.setSetting(settingKey(projectId, sourceId), grant);
      return metadata(source, grant);
    });
  }
  revoke(projectId, sourceId) {
    return generic(() => { const source = this._source(projectId, sourceId); this.store.setSetting(settingKey(projectId, sourceId), null); return metadata(source, null); });
  }
  list(projectId, sourceId, relative = '') {
    return generic(() => {
      relativePath(relative);
      const context = this._authorized(projectId, sourceId), target = this._target(context, relative);
      if (!target.stat.isDirectory()) throw fault('SOURCE_FOLDER_REQUIRED');
      const directory = fs.opendirSync(target.filename, { bufferSize: 32 });
      const entries = []; let scanned = 0, truncated = false;
      try {
        let entry;
        while ((entry = directory.readSync())) {
          scanned++;
          if (scanned > MAX_SCANNED || entries.length >= MAX_ENTRIES) { truncated = true; break; }
          if (!safeName(entry.name) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
          const childRelative = relative ? relative + '/' + entry.name : entry.name;
          let child;
          try { child = this._target(context, childRelative); } catch { continue; }
          if (child.stat.isFile() && child.stat.nlink !== 1) continue;
          entries.push({ name: entry.name, relative: childRelative, kind: child.stat.isDirectory() ? 'folder' : 'file', bytes: child.stat.isFile() ? child.stat.size : null });
        }
        this._recheck(projectId, sourceId, context, relative, target);
        return { sourceId, relative, entries, truncated };
      } finally { directory.closeSync(); }
    });
  }
  read(projectId, sourceId, relative = '') {
    return generic(() => {
      relativePath(relative);
      const context = this._authorized(projectId, sourceId), target = this._target(context, relative);
      if (!target.stat.isFile() || target.stat.nlink !== 1) throw fault('SOURCE_FILE_REQUIRED');
      if (!TEXT_EXTENSIONS.has(path.extname(target.filename).toLowerCase())) throw fault('SOURCE_TEXT_TYPE_REQUIRED', 403);
      if (target.stat.size > MAX_BYTES) throw fault('SOURCE_FILE_TOO_LARGE', 413);
      let fd, bytes;
      try {
        fd = fs.openSync(target.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || !unchanged(before, target.stat)) throw fault('SOURCE_TARGET_CHANGED', 403);
        if (before.size > MAX_BYTES) throw fault('SOURCE_FILE_TOO_LARGE', 413);
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw fault('SOURCE_TARGET_CHANGED', 403); offset += count; }
        const after = fs.fstatSync(fd), current = this._recheck(projectId, sourceId, context, relative, target);
        if (!unchanged(before, after) || !unchanged(before, current)) throw fault('SOURCE_TARGET_CHANGED', 403);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fault('SOURCE_BINARY_BLOCKED', 403); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw fault('SOURCE_BINARY_BLOCKED', 403);
        return { sourceId, relative, name: path.basename(target.filename), content, bytes: before.size, encoding: 'utf-8', access: 'read-local' };
      } finally { if (fd !== undefined) fs.closeSync(fd); bytes?.fill(0); }
    });
  }
}
module.exports = { SourceAccess };
