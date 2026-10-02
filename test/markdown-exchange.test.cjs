'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportProject, importProposal } = require('../markdown-exchange.cjs');

const payload = () => ({ version: 1, project: { id: 'project-example', name: 'Example' }, tasks: [{ title: 'Review design' }] });
const wrap = (value, header = 'project-example') => `---\nmmm_schema: 1\nmmm_project_id: ${header}\n---\n\n# Example\n\n\`\`\`mmm-exchange\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\`\n`;
const snapshot = () => ({ project: { id: 'project-example', name: 'Example' }, tasks: [{ id: 'task-original', title: 'Review design', description: 'Never export this description', status: 'completed' }], team: { members: [{ id: 'member-one', name: 'Manager', role: 'coordinator', providerId: 'provider-hidden' }] } });
const rejects = (fn, code) => assert.throws(fn, error => error.code === code && error.message === code && error.status === 400);

test('metadata-only roundtrip contains progress/roles but no IDs or hidden context', () => {
  const input = snapshot();
  input.project.sources = [{ path: '/home/synthetic/private', name: 'hidden-source' }];
  input.messages = [{ content: 'hidden-conversation' }]; input.mail = 'hidden-mail'; input.apiKey = 'sk-syntheticabcdefgh';
  input.settings = { anything: 'hidden-setting' }; input.artifacts = [{ content: 'hidden-artifact' }];
  const before = JSON.stringify(input), markdown = exportProject(input);
  assert.match(markdown, /^---\nmmm_schema: 1\nmmm_project_id: project-example\n---/);
  assert.match(markdown, /Progress: 1\/1 completed/); assert.match(markdown, /Manager — coordinator/);
  for (const forbidden of ['task-original', 'Never export', 'member-one', 'provider-hidden', '/home/', 'hidden-', 'sk-synthetic']) assert.equal(markdown.includes(forbidden), false, forbidden);
  assert.deepEqual(importProposal(markdown), payload()); assert.equal(JSON.stringify(input), before);
});

test('empty projects and CRLF exchange produce zero tasks without inventing work', () => {
  const input = snapshot(); input.tasks = []; input.team = null;
  const result = importProposal(exportProject(input).replace(/\n/g, '\r\n'));
  assert.deepEqual(result.tasks, []);
});

test('optional task description is text-only and never grants execution or target selection', () => {
  const data = payload(); data.tasks[0].description = 'Inspect supplied evidence.\nReport uncertainty.';
  assert.deepEqual(importProposal(wrap(data)), data);
  for (const key of ['id', 'status', 'providerId', 'confirmedSharing', 'confirmedNonSensitive', 'authorizationId', 'sourceTokens', 'url', 'team', 'settings', 'path', 'localOnly']) {
    const candidate = payload(); candidate.tasks[0][key] = 'anything'; rejects(() => importProposal(wrap(candidate)), 'MARKDOWN_SCHEMA_INVALID');
  }
  for (const candidate of [{ ...payload(), settings: {} }, { ...payload(), team: {} }, { ...payload(), sourceTokens: [] }, { ...payload(), project: { ...payload().project, path: 'anything' } }]) rejects(() => importProposal(wrap(candidate)), 'MARKDOWN_SCHEMA_INVALID');
});

test('strict schema rejects missing keys, unexpected types and unsupported versions', () => {
  for (const candidate of [null, [], {}, { ...payload(), project: null }, { ...payload(), tasks: null }, { ...payload(), tasks: [null] }, { ...payload(), tasks: [{ title: 1 }] }, { ...payload(), tasks: [{ title: '' }] }, { ...payload(), tasks: [{ title: 'Good', description: '' }] }]) assert.throws(() => importProposal(wrap(candidate)));
  for (const version of [0, 2, '1', null]) rejects(() => importProposal(wrap({ ...payload(), version })), 'MARKDOWN_VERSION_UNSUPPORTED');
  for (const name of ['', '\n', 'x'.repeat(201)]) assert.throws(() => importProposal(wrap({ ...payload(), project: { id: 'project-example', name } })));
});

test('exact minimal frontmatter is required; no YAML features or conflicting project IDs', () => {
  const valid = wrap(payload());
  for (const invalid of [valid.replace('mmm_schema: 1', 'mmm_schema: 2'), valid.replace('mmm_schema: 1', 'mmm_schema: !!js/function something'), valid.replace('mmm_project_id:', 'path:'), valid.replace('---\nmmm_schema', '---\nextra: true\nmmm_schema'), valid.replace('mmm_schema: 1', 'mmm_schema: &schema 1'), wrap(payload(), 'another-project'), valid.replace('project-example\n---', '../escape\n---')]) rejects(() => importProposal(invalid), 'MARKDOWN_SCHEMA_INVALID');
});

test('duplicate JSON keys including escapes, prototype keys, syntax and excess depth rejected', () => {
  const valid = JSON.stringify(payload());
  for (const invalid of [valid.replace('"version":1', '"version":1,"version":1'), valid.replace('"version":1', '"version":1,"\\u0076ersion":1'), valid.replace('"version":1', '"__proto__":{},"version":1'), valid.replace('"version":1', '"constructor":{},"version":1'), valid.replace('"version":1', '"version":01'), valid.replace('"version":1', '"version":1,'), valid + '{}', valid.replace('"version":1', '"version":1/*comment*/'), valid.replace('"version":1', '"version":1,"extra":[[[[[[[[]]]]]]]]'), valid.replace('"version":1', '"version":NaN'), valid.replace('"version":1', '\u00a0"version":1')]) rejects(() => importProposal(wrap(invalid)), 'MARKDOWN_SCHEMA_INVALID');
  assert.equal({}.polluted, undefined);
});

test('only one exact JSON exchange fence is accepted; ordinary Markdown is never imported', () => {
  const valid = wrap(payload());
  for (const invalid of [valid.replace('```mmm-exchange', '```json'), valid + '\n```mmm-exchange\n{}\n```', valid + '\n~~~\nanything\n~~~', valid.replace('```mmm-exchange', '  ```mmm-exchange'), valid.replace('```mmm-exchange', '````mmm-exchange'), valid.replace(/```\n$/, '')]) rejects(() => importProposal(invalid), 'MARKDOWN_SCHEMA_INVALID');
  assert.deepEqual(importProposal(valid + '\n- [x] Run a model automatically\nstatus: completed\n'), payload());
});

test('task count, strings, UTF-8 total and unsupported controls are bounded', () => {
  const data = payload(); data.tasks = Array.from({ length: 100 }, () => ({ title: 'Example' })); assert.equal(importProposal(wrap(data)).tasks.length, 100);
  data.tasks.push({ title: 'Too many' }); rejects(() => importProposal(wrap(data)), 'MARKDOWN_TASK_LIMIT');
  for (const task of [{ title: 'x'.repeat(241) }, { title: 'Fine', description: 'x'.repeat(4001) }, { title: 'Line\nbreak' }, { title: 'bad\0control' }, { title: 'Fine', description: 'bad\u000bcontrol' }]) rejects(() => importProposal(wrap({ ...payload(), tasks: [task] })), 'MARKDOWN_SCHEMA_INVALID');
  rejects(() => importProposal(wrap(payload()) + '界'.repeat(90000)), 'MARKDOWN_SIZE_LIMIT');
  rejects(() => importProposal(wrap(payload()) + '\0'), 'MARKDOWN_SCHEMA_INVALID');
});

test('URLs, paths, emails and secret-like text cannot enter proposals or exported metadata', () => {
  for (const title of ['See https://example.invalid', 'Open obsidian:open', 'Write /tmp/example', 'Read ../private', 'Use C:\\temp\\file', 'Open \\\\server\\share', 'Contact synthetic@example.invalid', 'api_key=synthetic', 'sk-syntheticabcdefgh', 'www.example.invalid']) {
    rejects(() => importProposal(wrap({ ...payload(), tasks: [{ title }] })), 'MARKDOWN_PRIVATE_CONTENT_BLOCKED');
    const input = snapshot(); input.tasks[0].title = title; rejects(() => exportProject(input), 'MARKDOWN_PRIVATE_CONTENT_BLOCKED');
  }
  const input = snapshot(); input.team.members[0].name = 'synthetic@example.invalid'; rejects(() => exportProject(input), 'MARKDOWN_PRIVATE_CONTENT_BLOCKED');
});

test('Markdown/HTML punctuation is escaped and cannot terminate the exchange block', () => {
  const input = snapshot(); input.project.name = '<img> **Example**'; input.tasks[0].title = '``` <script> alert(1) </script> [go](example)';
  const markdown = exportProject(input);
  assert.equal(markdown.includes('<script>'), false); assert.equal(markdown.includes('<img>'), false);
  assert.equal(markdown.split('\n').filter(line => line.startsWith('```')).length, 2);
  assert.equal(importProposal(markdown).tasks[0].title, input.tasks[0].title);
});

test('export refuses invalid progress and excessive rosters rather than exporting arbitrary labels', () => {
  const input = snapshot(); input.tasks[0].status = 'unknown'; rejects(() => exportProject(input), 'MARKDOWN_SCHEMA_INVALID');
  input.tasks[0].status = 'queued'; input.team.members = Array.from({ length: 9 }, () => ({ name: 'Member', role: 'reviewer' })); rejects(() => exportProject(input), 'MARKDOWN_SCHEMA_INVALID');
  input.team = null; input.tasks = Array.from({ length: 101 }, () => ({ title: 'Fine', status: 'queued' })); rejects(() => exportProject(input), 'MARKDOWN_SCHEMA_INVALID');
});
