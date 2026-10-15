'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const RUNTIME = Object.freeze([
  'package.json', 'cli-connections.cjs', 'desktop.cjs', 'external-browser.cjs',
  'mail.cjs', 'markdown-exchange.cjs', 'preload.cjs', 'provider-policy.cjs',
  'providers.cjs', 'security.cjs', 'server.cjs', 'source-access.cjs', 'sources.cjs',
  'storage.cjs', 'team.cjs', 'terminal-launch.cjs', 'vault.cjs',
  'ui/index.html', 'ui/app.js', 'ui/styles.css', 'ui/i18n.js', 'ui/mail.js', 'ui/logo.png'
]);
const FILES = Object.freeze([...RUNTIME,
  'LICENSE.txt', 'README.md', 'README.zh-Hant.md', 'README.zh-Hans.md', 'CONTRIBUTING.md', 'SECURITY.md', '.gitignore',
  '.github/workflows/ci.yml', 'docs/DESIGN.md', 'docs/ARCHITECTURE.md', 'docs/ROADMAP.md', 'docs/VALIDATION.md',
  'docs/TUTORIAL.md', 'docs/TUTORIAL.zh-Hant.md', 'docs/TUTORIAL.zh-Hans.md',
  'docs/screenshots/home.png', 'docs/screenshots/project-workspace.png', 'docs/screenshots/design-team.png',
  'scripts/package-source.cjs',
  ...['archive-markdown-integration', 'cli-connections', 'desktop-bridge', 'external-browser',
    'mail', 'manager-integration', 'markdown-exchange', 'providers', 'release', 'server',
    'source-access', 'sources', 'storage', 'team', 'terminal-launch', 'ui', 'vault',
    'community'].map(name => `test/${name}.test.cjs`)
].sort());
const LOGO_HASH = 'b9a37a3c00690a2849440d56967e5ef428de066e2ba706593639df2c81f1eb9c';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inspect(file, bytes) {
  if (file === 'ui/logo.png') {
    if (hash(bytes) !== LOGO_HASH) throw Error('Unapproved binary asset');
    return;
  }
  const text = bytes.toString();
  const rules = [/(?:sk-|nvapi-|hf_|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
  if (RUNTIME.includes(file)) rules.push(/antigravity|astrollm|claude-oauth/i,
    /\/(?:Users|home)\/[A-Za-z0-9_.-]+|\/Volumes\/SSD\//,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (rules.some(rule => rule.test(text))) throw Error(`Release scan blocked: ${file} (value withheld)`);
}
function stage({ root = path.resolve(__dirname, '..'), destination } = {}) {
  if (!destination) throw Error('Destination required');
  fs.mkdirSync(destination, { recursive: true });
  if (fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length) throw Error('Staging destination must be empty and regular');
  const files = [];
  for (const file of FILES) {
    let source = root;
    for (const part of file.split('/')) {
      source = path.join(source, part);
      if (fs.lstatSync(source).isSymbolicLink()) throw Error('Symlink build input rejected');
    }
    if (!fs.statSync(source).isFile()) throw Error('Non-regular build input');
    const bytes = fs.readFileSync(source); inspect(file, bytes);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    files.push({ file, sha256: hash(bytes), bytes: bytes.length });
  }
  const sourceSnapshot = hash(JSON.stringify(files));
  fs.writeFileSync(path.join(destination, 'release-manifest.json'), JSON.stringify({ format: 1, sourceSnapshot, files }, null, 2) + '\n', { flag: 'wx' });
  return { sourceSnapshot, files: files.length };
}
function verify(directory, expectedSnapshot) {
  const entries = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      const file = prefix + name, full = path.join(dir, name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw Error('Symlink artifact entry');
      if (stat.isDirectory()) walk(full, file + '/');
      else if (stat.isFile()) entries.push(file);
      else throw Error('Non-regular artifact entry');
    }
  }
  walk(directory);
  const expected = [...FILES, 'release-manifest.json'].sort();
  if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) throw Error('Unexpected artifact entry');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || hash(JSON.stringify(manifest.files)) !== expectedSnapshot || manifest.sourceSnapshot !== expectedSnapshot) throw Error('Artifact differs from reviewed source');
  if (JSON.stringify(manifest.files.map(entry => entry.file)) !== JSON.stringify(FILES)) throw Error('Manifest allowlist mismatch');
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(directory, entry.file)); inspect(entry.file, bytes);
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw Error('Artifact bytes changed');
  }
  return { verified: true, files: FILES.length };
}
function pack(root = path.resolve(__dirname, '..')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  if (!/^[0-9A-Za-z.-]+$/.test(version)) throw Error('Invalid release version');
  const name = `mmm-community-${version}`, temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-source-'));
  try {
    const destination = path.join(temp, name), staged = stage({ root, destination });
    verify(destination, staged.sourceSnapshot);
    const archive = path.join(temp, name + '.tar.gz');
    const bsdTar = /bsdtar/i.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
    const ownerFlags = bsdTar ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'] : ['--owner=0', '--group=0', '--numeric-owner'];
    // Do not disclose local usernames, group names, or Apple extended metadata.
    execFileSync('tar', ['--format=ustar', ...ownerFlags, '-czf', archive, '-C', temp, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    // Check extracted bytes, not only pre-archive input.
    const unpacked = path.join(temp, 'unpacked'); fs.mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    verify(path.join(unpacked, name), staged.sourceSnapshot);
    const output = path.join(root, 'dist'); fs.mkdirSync(output, { recursive: true });
    const target = path.join(output, name + '.tar.gz'); fs.copyFileSync(archive, target);
    const sha256 = hash(fs.readFileSync(target));
    fs.writeFileSync(target + '.sha256', `${sha256}  ${path.basename(target)}\n`);
    return { archive: target, sha256, ...staged };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) { try { console.log(JSON.stringify(pack(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { RUNTIME, FILES, stage, inspect, verify, pack };
