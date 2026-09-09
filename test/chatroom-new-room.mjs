import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatroomNewRooms } from '../dist/chatroom-new-room-model.js';
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';

test('unselected first message targets the real configured default global Leader without a guessed project', async () => {
  const requests = [];
  const entities = { get: async identity => ({ status: 'found', entity: { identity } }) };
  const flow = new ChatroomNewRooms(CHATROOM_DEFAULT_AGENT_CONFIGURATION, entities, {
    start: async (...args) => {
      requests.push(args);
      return { status: 'unavailable', code: 'failed', reason: 'context-required' };
    },
  });
  assert.equal(flow.leaders.length, 1);
  assert.equal(flow.leaders[0].defaultGlobal, true);
  assert.deepEqual(await flow.start('hello'), { status: 'unavailable', code: 'failed', reason: 'context-required' });
  assert.deepEqual(requests, [[undefined, { text: 'hello', to: 'leader', projectless: true }]]);
  assert.equal((await flow.start('hello', 'unknown')).code, 'leader-unavailable');
  assert.equal(requests.length, 1);
});

test('an explicit configured Leader is kept separate from default selection and stale entity revisions are rejected', async () => {
  const base = CHATROOM_DEFAULT_AGENT_CONFIGURATION;
  const alternate = { ...base.members[1], memberId: 'alternate', role: 'leader' };
  const calls = [];
  let stale = false;
  const flow = new ChatroomNewRooms({ ...base, members: [...base.members, alternate] }, {
    get: async identity => ({
      status: 'found',
      entity: { identity: stale ? { ...identity, revision: 'other' } : identity },
    }),
  }, {
    start: async (...args) => {
      calls.push(args);
      return { status: 'unavailable', code: 'failed', reason: 'context-required' };
    },
  });
  await flow.start('chosen', 'alternate');
  assert.deepEqual(calls, [[undefined, { text: 'chosen', to: 'alternate' }]]);
  stale = true;
  assert.equal((await flow.start('again', 'alternate')).reason, 'definition-unavailable');
  assert.equal(calls.length, 1);
});
