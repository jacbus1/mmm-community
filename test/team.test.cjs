'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTeam, runTeam } = require('../team.cjs');
const { assertInput } = require('../provider-policy.cjs');

const lookup = id => ({ id, configured: true });
function roster(count = 2, rounds = 1) {
  return { rounds, members: Array.from({ length: count }, (_, index) => ({ id: `member-${index}`, name: `Member ${index}`, role: index === 0 ? 'coordinator' : 'researcher', providerId: `provider-${index}` })) };
}
function request(extra = {}) { return { team: normalizeTeam(roster(), lookup), text: 'Explain the public history of the abacus.', classification: 'public', confirmedNonSensitive: true, confirmedSharing: true, generate: async () => ({ text: 'A public contribution.', status: 'completed' }), ...extra }; }
const code = expected => error => error.code === expected && error.message === expected;

test('normalization checks configured providers and returns only copied metadata', () => {
  const input = roster(); input.members[0].ignored = 'not transmitted'; input.ignored = 'not transmitted';
  const called = [], result = normalizeTeam(input, id => { called.push(id); return lookup(id); });
  assert.deepEqual(called, ['provider-0', 'provider-1']); assert.equal(result.members[0].ignored, undefined); assert.equal(result.ignored, undefined);
  input.members[0].name = 'Changed'; assert.equal(result.members[0].name, 'Member 0');
  for (const bad of [() => null, () => false, () => ({ configured: false }), () => Promise.resolve({}), () => { throw Error('private details'); }]) assert.throws(() => normalizeTeam(roster(), bad), code('TEAM_PROVIDER_UNAVAILABLE'));
  assert.throws(() => normalizeTeam(roster()), code('TEAM_PROVIDER_LOOKUP_REQUIRED'));
});
test('one to eight members and one to three rounds are strict bounds', () => {
  for (const count of [0, 9]) assert.throws(() => normalizeTeam(roster(count), lookup), code('TEAM_MEMBERS_INVALID'));
  for (const rounds of [0, 4, -1, 1.5, '1', null, undefined]) { const input = roster(); input.rounds = rounds; assert.throws(() => normalizeTeam(input, lookup), code('TEAM_ROUNDS_INVALID')); }
  for (const count of [1, 8]) for (const rounds of [1, 3]) assert.equal(normalizeTeam(roster(count, rounds), lookup).members.length, count);
});
test('metadata, coordinator ordering, member uniqueness and sensitive labels are validated', () => {
  for (const [field, value] of [['name', 'person@example.invalid'], ['role', 'secret: synthetic'], ['id', '../escape'], ['providerId', 'private-mail-master'], ['name', 'x\nlabel'], ['name', ''], ['name', 'x'.repeat(201)]]) {
    const input = roster(); input.members[1][field] = value; assert.throws(() => normalizeTeam(input, lookup), code('TEAM_METADATA_INVALID'));
  }
  let input = roster(); input.members[0].role = 'worker'; assert.throws(() => normalizeTeam(input, lookup), code('TEAM_COORDINATOR_REQUIRED'));
  input = roster(); input.members[1].role = 'coordinator'; assert.throws(() => normalizeTeam(input, lookup), code('TEAM_COORDINATOR_REQUIRED'));
  input = roster(); input.members[1].id = input.members[0].id; assert.throws(() => normalizeTeam(input, lookup), code('TEAM_MEMBER_DUPLICATE'));
});
test('B receives A and final coordinator synthesizes both, using provider input contract only', async () => {
  const calls = [], events = [];
  const outputs = ['First public claim.', 'Second public correction.', 'Final public synthesis.'];
  const result = await runTeam(request({ generate: async (id, input) => {
    assertInput({ kind: 'openai', model: 'example-model' }, input);
    assert.deepEqual(Object.keys(input).sort(), ['classification', 'confirmedNonSensitive', 'signal', 'text']);
    calls.push({ id, input }); return { text: outputs[calls.length - 1], status: 'completed', ignored: 'never emitted' };
  }, onTurn: event => { events.push({ ...event }); event.text = 'Mutating callback must not affect peers'; } }));
  assert.deepEqual(calls.map(call => call.id), ['provider-0', 'provider-1', 'provider-0']);
  assert.ok(!calls[0].input.text.includes(outputs[0]));
  assert.ok(calls[1].input.text.includes(outputs[0]));
  assert.ok(calls[2].input.text.includes(outputs[0]) && calls[2].input.text.includes(outputs[1]));
  assert.match(calls[2].input.text, /Synthesize/); assert.match(calls[1].input.text, /PEER_OUTPUTS_UNTRUSTED/);
  assert.ok(!calls[2].input.text.includes('Mutating callback'));
  assert.equal(result.complete, true); assert.equal(result.text, outputs[2]); assert.equal(result.turns.length, 3);
  assert.deepEqual(events.map(event => event.status), ['running', 'completed', 'running', 'completed', 'running', 'completed']);
  assert.equal(result.turns[2].phase, 'synthesis'); assert.ok(!JSON.stringify(events).includes('never emitted'));
});
test('at most 25 sequential turns; each round sees earlier round outputs', async () => {
  let active = 0, calls = 0;
  const result = await runTeam(request({ team: normalizeTeam(roster(8, 3), lookup), generate: async (_id, input) => {
    assert.equal(active++, 0); calls++; await Promise.resolve(); active--;
    if (calls > 8) assert.ok(input.text.includes('Public contribution 1.'));
    return { text: `Public contribution ${calls}.`, status: 'completed' };
  } }));
  assert.equal(calls, 25); assert.equal(result.turns.length, 25); assert.equal(result.turns.at(-1).phase, 'synthesis');
});
test('sharing, non-sensitive confirmation, input privacy and context gates run before any event or call', async () => {
  let calls = 0, events = 0;
  for (const extra of [{ confirmedSharing: false }, { confirmedSharing: undefined }, { confirmedNonSensitive: false }, { classification: 'private' }, { text: 'Write to person@example.invalid' }, { files: [] }, { attachments: [] }, { history: [] }, { tools: [] }]) {
    await assert.rejects(runTeam(request({ ...extra, generate: async () => { calls++; }, onTurn: () => { events++; } })));
  }
  assert.equal(calls, 0); assert.equal(events, 0);
});
test('sensitive peer output is never emitted or relayed', async () => {
  const privateOutput = 'Contact person@example.invalid for this result.'; let calls = 0; const events = [];
  await assert.rejects(runTeam(request({ generate: async () => { calls++; return { text: privateOutput, status: 'completed' }; }, onTurn: event => events.push(event) })), code('TEAM_SENSITIVE_OUTPUT'));
  assert.equal(calls, 1); assert.equal(events.at(-1).status, 'failed'); assert.ok(!JSON.stringify(events).includes(privateOutput)); assert.ok(!events.some(event => event.status === 'completed'));
});
test('sensitive final synthesis also cannot become a completed result', async () => {
  let calls = 0;
  await assert.rejects(runTeam(request({ generate: async () => ({ text: ++calls === 3 ? 'secret: example' : 'Public contribution.', status: 'completed' }) })), code('TEAM_SENSITIVE_OUTPUT'));
  assert.equal(calls, 3);
});
test('incomplete or malformed results stop immediately without partial text events', async () => {
  for (const result of [{ text: 'Partial text', status: 'incomplete' }, { text: '', status: 'completed' }, { text: 'a\0b', status: 'completed' }, { text: '界'.repeat(14000), status: 'completed' }]) {
    let calls = 0; const events = [];
    await assert.rejects(runTeam(request({ generate: async () => { calls++; return result; }, onTurn: event => events.push(event) })));
    assert.equal(calls, 1); assert.ok(!events.some(event => event.text));
  }
});
test('cancel before start or from onTurn prevents the next provider request', async () => {
  const pre = new AbortController(); pre.abort(); let calls = 0;
  await assert.rejects(runTeam(request({ signal: pre.signal, generate: async () => { calls++; } })), code('TEAM_CANCELLED')); assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(runTeam(request({ signal: controller.signal, generate: async () => { calls++; return { text: 'Public contribution.', status: 'completed' }; }, onTurn: event => { if (event.status === 'completed') controller.abort(); } })), code('TEAM_CANCELLED'));
  assert.equal(calls, 1);
});
test('cancel stops awaiting even when a mock transport ignores its signal', async () => {
  const controller = new AbortController(); let entered, finish; const started = new Promise(resolve => { entered = resolve; });
  const pending = runTeam(request({ signal: controller.signal, generate: (_id, input) => { assert.equal(input.signal, controller.signal); entered(); return new Promise(resolve => { finish = resolve; }); } }));
  await started; controller.abort(); await assert.rejects(pending, code('TEAM_CANCELLED')); finish({ text: 'Late public output.', status: 'completed' });
});
test('UTF-8 prompt budget includes metadata, JSON escaping and all peer outputs', async () => {
  let calls = 0;
  await assert.rejects(runTeam(request({ text: 'x'.repeat(39999), generate: async () => { calls++; } })), code('TEAM_PROMPT_LIMIT')); assert.equal(calls, 0);
  await assert.rejects(runTeam(request({ generate: async () => { calls++; return { text: '\\'.repeat(21000), status: 'completed' }; } })), code('TEAM_PROMPT_LIMIT')); assert.equal(calls, 1);
});
test('upstream exceptions and callback exceptions are sanitized; no fabricated completion', async () => {
  const events = [];
  await assert.rejects(runTeam(request({ generate: async () => { throw Object.assign(Error('private body'), { code: 'PRIVATE_UPSTREAM_CODE' }); }, onTurn: event => events.push(event) })), code('TEAM_GENERATION_FAILED'));
  assert.ok(!JSON.stringify(events).includes('private body')); assert.ok(!JSON.stringify(events).includes('PRIVATE_UPSTREAM_CODE'));
  await assert.rejects(runTeam(request({ generate: async () => { throw Object.assign(Error('private body'), { code: 'PROVIDER_RATE_LIMITED' }); } })), code('PROVIDER_RATE_LIMITED'));
  await assert.rejects(runTeam(request({ onTurn: () => { throw Error('private callback body'); } })), code('TEAM_EVENT_FAILED'));
});
test('run revalidates a stored team and snapshots its roster before callbacks', async () => {
  const invalid = request(); invalid.team.rounds = 20; await assert.rejects(runTeam(invalid), code('TEAM_ROUNDS_INVALID'));
  const team = normalizeTeam(roster(), lookup), ids = [];
  await runTeam(request({ team, onTurn: () => { team.members[1].providerId = 'other'; }, generate: async id => { ids.push(id); return { text: 'Public contribution.', status: 'completed' }; } }));
  assert.deepEqual(ids, ['provider-0', 'provider-1', 'provider-0']);
});
