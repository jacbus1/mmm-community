'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
test('community identity and MIT license remain independent', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'MIT'); assert.equal(pkg.name, 'mmm-community');
  assert.equal(Object.keys(pkg.dependencies).length, 0);
  assert.match(read('LICENSE.txt'), /Permission is hereby granted/);
  assert.match(require('../server.cjs').defaultDirectory(), /MMM-Community$/);
  assert.doesNotMatch(read('desktop.cjs'), /MMM-Public|app\.mmm\.public/);
});
test('design preset has four distinct roles, fresh IDs, and never preselects paid providers', () => {
  const app = read('ui/app.js');
  const fn = app.slice(app.indexOf('function designTeamDraft('), app.indexOf('  const designPreset ='));
  const context = { crypto }; vm.runInNewContext(fn, context);
  const names = ['Coordinate', 'Design', 'Build', 'Review'];
  const first = context.designTeamDraft('', names), second = context.designTeamDraft('', names);
  assert.equal(first.rounds, 1); assert.equal(first.members.length, 4);
  assert.equal(first.members[0].role, 'coordinator');
  assert.equal(first.members[1].role, 'UI/UX designer');
  assert.equal(new Set([...first.members, ...second.members].map(m => m.id)).size, 8);
  assert.ok(first.members.every(m => m.providerId === ''));
  const handler = app.slice(app.indexOf('const designPreset ='), app.indexOf('const designPresetPanel ='));
  assert.match(handler, /await ask/); assert.match(handler, /state.selected !== projectId/);
  assert.match(handler, /teamSharing.checked = false/);
  assert.doesNotMatch(handler, /api\(|fetch\(|\/tasks/);
});
test('design preset copy is translated in every locale', () => {
  const context = { window: {}, document: { querySelectorAll: () => [], documentElement: {} }, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(read('ui/i18n.js'), context);
  const labels = [];
  for (const language of ['en', 'zh-Hant', 'zh-Hans']) {
    context.window.MMM_I18N.setLocale(language);
    for (const key of ['designPreset', 'designPresetHint', 'designPresetReplace', 'designRole', 'engineerRole', 'reviewerRole', 'studioLabel']) assert.notEqual(context.window.MMM_I18N.t(key), key);
    labels.push(context.window.MMM_I18N.t('designPreset'));
  }
  assert.equal(new Set(labels).size, 3);
});
