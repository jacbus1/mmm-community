'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const MAX_BATCH = 100;
const MAX_PROJECT = 1000;
const MAX_PENDING = 2000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DARWIN_ALIASES = Object.freeze({ '/var': '/private/var', '/tmp': '/private/tmp' });
function fault(code) { return Object.assign(new Error(code), { code, status: 400 }); }
function list(value, limit = MAX_PROJECT) {
  if (!Array.isArray(value) || value.length > limit) throw fault('SOURCE_SELECTION_INVALID');
  return value;
}
function inspect(input) {
  if (typeof input !== 'string' || input.length > 4096 || !path.isAbsolute(input) || /[\0\r\n]/.test(input)) throw fault('SOURCE_PATH_INVALID');
  // Do not normalize away parent traversal through a symlink before checking it.
  if (input.split(path.sep).some(part => part === '.' || part === '..')) throw fault('SOURCE_PATH_INVALID');
  const requested = path.resolve(input);
  if (requested === path.parse(requested).root || requested === path.resolve(os.homedir()) || /^\/Volumes\/[^/]+$/.test(requested)
    || (process.platform === 'darwin' && [...Object.keys(DARWIN_ALIASES), ...Object.values(DARWIN_ALIASES)].includes(requested))) throw fault('SOURCE_SCOPE_TOO_BROAD');
  try {
    // Metadata only: check each component to reject symlinked ancestors as well
    // as a symlink selected directly. No file reads or directory enumeration.
    let cursor = requested;
    for (;;) {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        const aliasTarget = process.platform === 'darwin' && cursor !== requested && DARWIN_ALIASES[cursor];
        // Finder, Electron and os.tmpdir use these macOS system aliases. The
        // exception applies only to exact root ancestors with verified targets.
        if (!aliasTarget || fs.realpathSync(cursor) !== aliasTarget
          || !fs.lstatSync(aliasTarget).isDirectory() || fs.lstatSync(aliasTarget).isSymbolicLink()
          || !fs.lstatSync('/private').isDirectory() || fs.lstatSync('/private').isSymbolicLink()) throw fault('SOURCE_SYMLINK_REJECTED');
      }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const canonical = fs.realpathSync(requested);
    const stat = fs.lstatSync(canonical);
    if (stat.isSymbolicLink()) throw fault('SOURCE_SYMLINK_REJECTED');
    if (!stat.isFile() && !stat.isDirectory()) throw fault('SOURCE_TYPE_UNSUPPORTED');
    return { path: canonical, name: path.basename(canonical), kind: stat.isDirectory() ? 'folder' : 'file', dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (['SOURCE_SYMLINK_REJECTED', 'SOURCE_TYPE_UNSUPPORTED'].includes(error.code)) throw error;
    throw fault('SOURCE_UNAVAILABLE');
  }
}

// Enroll only from native user-selected paths. There is deliberately no HTTP,
// content extraction, directory traversal, model context or persistence here.
class SourceSelections {
  #pending = new Map();
  constructor({ now = Date.now } = {}) { this.now = now; }
  #time() { const now = this.now(); if (!Number.isFinite(now)) throw fault('SOURCE_CLOCK_UNAVAILABLE'); return now; }
  #prune(now) { for (const [token, source] of this.#pending) if (source.expiresAt <= now) this.#pending.delete(token); }
  #entries(tokens) {
    list(tokens);
    if (tokens.some(token => typeof token !== 'string' || !TOKEN.test(token)) || new Set(tokens).size !== tokens.length) throw fault('SOURCE_TOKEN_INVALID');
    const now = this.#time(); this.#prune(now);
    return tokens.map(token => {
      const source = this.#pending.get(token);
      if (!source) throw fault('SOURCE_TOKEN_UNAVAILABLE');
      return { token, source };
    });
  }
  register(paths) {
    list(paths, MAX_BATCH);
    const now = this.#time(); this.#prune(now);
    if (this.#pending.size + paths.length > MAX_PENDING) throw fault('SOURCE_SELECTION_LIMIT');
    const selected = paths.map(inspect);
    if (new Set(selected.map(source => source.path)).size !== selected.length) throw fault('SOURCE_SELECTION_DUPLICATE');
    const sources = selected.map(source => {
      let token; do { token = crypto.randomBytes(32).toString('base64url'); } while (this.#pending.has(token));
      this.#pending.set(token, { ...source, id: crypto.randomUUID(), expiresAt: now + TTL_MS });
      return { token, name: source.name, path: source.path, kind: source.kind };
    });
    return { sources };
  }
  resolve(tokens) {
    return this.#entries(tokens).map(({ source }) => {
      const current = inspect(source.path);
      if (current.dev !== source.dev || current.ino !== source.ino || current.kind !== source.kind || current.path !== source.path) throw fault('SOURCE_TARGET_CHANGED');
      return { id: source.id, name: source.name, path: source.path, kind: source.kind, access: 'reference-only' };
    });
  }
  consume(tokens) {
    // Validate the whole set before removal; call only after the Store commit.
    const entries = this.#entries(tokens);
    for (const { token } of entries) this.#pending.delete(token);
  }
  discard(tokens) {
    list(tokens);
    if (tokens.some(token => typeof token !== 'string' || !TOKEN.test(token))) throw fault('SOURCE_TOKEN_INVALID');
    // Idempotent cancellation/commit cleanup, including already-expired grants.
    // No filesystem access and no ability to create a selection.
    for (const token of tokens) this.#pending.delete(token);
  }
  clear() { this.#pending.clear(); }
}
module.exports = { SourceSelections, MAX_BATCH, MAX_PROJECT };
