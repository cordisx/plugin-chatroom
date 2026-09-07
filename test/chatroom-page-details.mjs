import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatroomPageDetails, memberSessions } from '../dist/chatroom-page-details.js';

const room = {
  id: 'room-a',
  memberships: [{
    memberId: 'member-a',
    participantId: 'person-a',
    definition: { agentId: 'entity-a', revision: 'exact' },
  }],
  runs: [
    { runId: 'r1', memberId: 'member-a', sessionId: 's1', title: 'First task', status: 'running' },
    { runId: 'r2', memberId: 'member-a', sessionId: 's1', title: 'Same conversation', status: 'running' },
    { runId: 'r3', memberId: 'member-a', sessionId: 's2', title: 'History', status: 'active' },
    { runId: 'r4', memberId: 'other-member', sessionId: 'foreign', title: 'Other', status: 'running' },
  ],
};

test('one session list deduplicates durable relationships and never promotes stale running state', () => {
  assert.deepEqual(memberSessions(room, 'person-a', []), [
    { sessionId: 's1', title: 'Same conversation' },
    { sessionId: 's2', title: 'History' },
  ]);
  const active = {
    runId: 'r1',
    memberId: 'member-a',
    participantId: 'person-a',
    sessionId: 's1',
    lifecycle: { phase: 'waiting' },
  };
  assert.equal(memberSessions(room, 'person-a', [active])[0].phase, 'waiting');
  assert.equal(memberSessions(room, 'person-a', [{ ...active, runId: 'wrong' }])[0].phase, undefined);
  assert.equal(memberSessions(room, 'person-a', [{ ...active, participantId: 'other' }])[0].phase, undefined);
  assert.deepEqual(memberSessions(room, 'unrelated', [active]), []);
});

test('entity details use exact persisted identity without requiring an Agent or Session', async () => {
  const requests = [];
  const details = new ChatroomPageDetails({
    entities: {
      async get(identity) {
        requests.push(identity);
        return { status: 'found', entity: { identity, definition: { name: 'Persistent entity' } } };
      },
    },
  });
  assert.equal((await details.entity(room, 'person-a')).definition.name, 'Persistent entity');
  assert.deepEqual(requests, [room.memberships[0].definition]);
  assert.equal(await details.entity(room, 'unrelated'), undefined);
  assert.equal(requests.length, 1);
  const wrongRevision = new ChatroomPageDetails({
    entities: {
      async get() {
        return { status: 'found', entity: { identity: { agentId: 'entity-a', revision: 'newer' } } };
      },
    },
  });
  assert.equal(await wrongRevision.entity(room, 'person-a'), undefined);
});

test('history navigation relays an authorized opaque reference and rejects unrelated sessions', async () => {
  const opaqueTarget = Object.freeze({ opaque: 'host-returned-reference' });
  const calls = [];
  const details = new ChatroomPageDetails({
    references: {
      async getV2(request) {
        calls.push(['getV2', request]);
        return { status: 'accepted', sessionId: request.sessionId, target: opaqueTarget };
      },
    },
    navigation: {
      async openV2(request) {
        assert.equal(request.target, opaqueTarget);
        calls.push(['openV2']);
        return { status: 'accepted', code: 'opened' };
      },
    },
  });
  assert.equal(await details.openSession(room, 'person-a', 'foreign'), false);
  assert.deepEqual(calls, []);
  assert.equal(await details.openSession(room, 'person-a', 's2'), true);
  assert.deepEqual(calls, [['getV2', { sessionId: 's2' }], ['openV2']]);
});

test('missing historical capability cannot silently use current-only navigation', async () => {
  const details = new ChatroomPageDetails({
    references: { get: () => assert.fail('v1 lookup cannot stand in for history') },
    navigation: { open: () => assert.fail('v1 open cannot stand in for history') },
  });
  assert.equal(await details.openSession(room, 'person-a', 's2'), false);
});
