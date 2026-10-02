'use strict';

const { sensitive, policyError } = require('./provider-policy.cjs');
const MAX_BYTES = 256 * 1024;
const STATES = new Set(['queued', 'running', 'awaiting_authorization', 'blocked', 'awaiting_review', 'completed', 'failed', 'cancelled', 'paused']);
function fail(code = 'MARKDOWN_SCHEMA_INVALID') { throw policyError(code); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value) || sensitive(value)) fail(); return value; }
function safeText(value, max, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Buffer.byteLength(value) > max * 4
    || (multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail();
  // Exchange is a metadata/task proposal surface, not a URI, path, or secret
  // transport. This is conservative screening, not comprehensive DLP.
  if (sensitive(value) || /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:mailto|data|javascript|obsidian|file):|\bwww\.|(?:^|\s)(?:\/{1,2}|~\/|\.\.?\/|[A-Za-z]:[\\/])\S|\\\\/i.test(value)) fail('MARKDOWN_PRIVATE_CONTENT_BLOCKED');
  return value.trim();
}
function proposal(value) {
  keys(value, ['version', 'project', 'tasks']);
  if (value.version !== 1) fail('MARKDOWN_VERSION_UNSUPPORTED');
  keys(value.project, ['id', 'name']);
  if (!Array.isArray(value.tasks) || value.tasks.length > 100) fail('MARKDOWN_TASK_LIMIT');
  return { version: 1, project: { id: id(value.project.id), name: safeText(value.project.name, 200) }, tasks: value.tasks.map(task => {
    keys(task, ['title', 'description']);
    const result = { title: safeText(task.title, 240) };
    if (Object.hasOwn(task, 'description')) result.description = safeText(task.description, 4000, true);
    return result;
  }) };
}
function escapeMarkdown(value) { return value.replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&'); }
function exportProject(snapshot) {
  if (!object(snapshot) || !object(snapshot.project) || !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 100) fail();
  // Positively select fields. Never serialize the snapshot itself: it may also
  // contain mail, paths, credentials, team provider IDs and conversation text.
  const data = proposal({ version: 1, project: { id: snapshot.project.id, name: snapshot.project.name }, tasks: snapshot.tasks.map(task => ({ title: task?.title })) });
  const tasks = snapshot.tasks.map((task, index) => {
    if (!STATES.has(task.status)) fail();
    return { title: data.tasks[index].title, status: task.status };
  });
  let members = [];
  if (snapshot.team != null) {
    if (!object(snapshot.team) || !Array.isArray(snapshot.team.members) || snapshot.team.members.length > 8) fail();
    members = snapshot.team.members.map(member => {
      if (!object(member)) fail();
      return { name: safeText(member.name, 200), role: safeText(member.role, 100) };
    });
  }
  const json = JSON.stringify(data, null, 2).replace(/[<>&`]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const lines = ['---', 'mmm_schema: 1', `mmm_project_id: ${data.project.id}`, '---', '', `# ${escapeMarkdown(data.project.name)}`, '',
    'Metadata-only MMM export. Import creates new local task proposals; it cannot update existing tasks, authorize actions, or run models.', '',
    `Progress: ${tasks.filter(task => task.status === 'completed').length}/${tasks.length} completed.`, '', '## Team responsibilities', ''];
  lines.push(...(members.length ? members.map(member => `- ${escapeMarkdown(member.name)} — ${escapeMarkdown(member.role)}`) : ['No team configured.']));
  lines.push('', '## Task progress', '', ...(tasks.length ? tasks.map(task => `- ${escapeMarkdown(task.title)} — ${task.status}`) : ['No tasks.']), '',
    '## Editable task proposals', '', 'Only the versioned JSON block below is imported. Other Markdown text and displayed progress are informational.', '', '```mmm-exchange', json, '```', '');
  const markdown = lines.join('\n');
  if (Buffer.byteLength(markdown) > MAX_BYTES) fail('MARKDOWN_SIZE_LIMIT');
  return markdown;
}

// JSON.parse accepts duplicate keys. This small bounded JSON reader rejects
// them (including escaped equivalents), prototype keys and excess nesting.
// It supports JSON only, never YAML tags, aliases, expressions or evaluation.
function strictJSON(source) {
  let offset = 0;
  function ws() { while (/[ \t\n\r]/.test(source[offset] || '') && offset < source.length) offset++; }
  function string() {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === '\\') { offset += 2; continue; }
      if (source[offset++] === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch { fail(); }
      }
    }
    fail();
  }
  function read(depth) {
    if (depth > 6) fail();
    ws(); const current = source[offset];
    if (current === '"') return string();
    if (current === '{') {
      offset++; ws(); const result = {}, seen = new Set();
      if (source[offset] === '}') { offset++; return result; }
      while (offset < source.length) {
        ws(); if (source[offset] !== '"') fail();
        const key = string();
        if (seen.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        seen.add(key); ws(); if (source[offset++] !== ':') fail(); result[key] = read(depth + 1); ws();
        const end = source[offset++]; if (end === '}') return result; if (end !== ',') fail();
      }
      fail();
    }
    if (current === '[') {
      offset++; ws(); const result = [];
      if (source[offset] === ']') { offset++; return result; }
      while (offset < source.length) {
        result.push(read(depth + 1)); if (result.length > 100) fail('MARKDOWN_TASK_LIMIT'); ws();
        const end = source[offset++]; if (end === ']') return result; if (end !== ',') fail();
      }
      fail();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset));
    if (!match) fail(); offset += match[0].length; return JSON.parse(match[0]);
  }
  const result = read(0); ws(); if (offset !== source.length) fail(); return result;
}
function importProposal(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.includes('\0')) fail();
  if (Buffer.byteLength(markdown) > MAX_BYTES) fail('MARKDOWN_SIZE_LIMIT');
  const source = markdown.replace(/\r\n/g, '\n');
  const header = /^---\nmmm_schema: 1\nmmm_project_id: ([A-Za-z0-9_-]{1,100})\n---\n/.exec(source);
  if (!header) fail();
  const lines = source.slice(header[0].length).split('\n');
  // Reject other/duplicate fences instead of guessing which payload was meant.
  const fences = lines.map((line, index) => ({ line, index })).filter(row => /^\s*(?:`{3,}|~{3,})/.test(row.line));
  if (fences.length !== 2 || fences[0].line !== '```mmm-exchange' || fences[1].line !== '```') fail();
  const data = proposal(strictJSON(lines.slice(fences[0].index + 1, fences[1].index).join('\n')));
  if (data.project.id !== header[1]) fail();
  // Caller must preview and explicitly confirm creation in a locally selected
  // project. The imported project ID is informational, never an update target.
  return data;
}

module.exports = { exportProject, importProposal };
