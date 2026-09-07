import assert from 'node:assert/strict';
import test from 'node:test';
import { roomAssociatedSessions } from '../dist/room-associated-sessions.js';

const room = () => ({
  id: 'original-room',
  memberships: [{ memberId: 'member', participantId: 'participant', definition: { agentId: 'agent', revision: 'v1' } }],
  participants: [{ id: 'participant', kind: 'agent' }],
  runs: [
    { memberId: 'member', runId: 'original-run', sessionId: 'original-session', status: 'active' },
    { memberId: 'member', runId: 'second-run', sessionId: 'second-session', status: 'completed' },
    { memberId: 'member', runId: 'duplicate-input', sessionId: 'original-session' },
    { memberId: 'member', runId: 'no-session' },
  ],
});

test('unloaded associations retain exact Room identity and only accepted same-Session opaque references', async () => {
  const value = room();
  const before = JSON.stringify(value);
  const calls = [];
  const target = { kind: 'host', ref: 'opaque-detail' };
  const rows = await roomAssociatedSessions(value, [{ sessionId: 'second-session' }], {
    get: async request => {
      calls.push(request);
      return { status: 'accepted', sessionId: request.sessionId, target };
    },
  });
  assert.deepEqual(rows, [{
    participantId: 'participant',
    memberId: 'member',
    runId: 'original-run',
    sessionId: 'original-session',
    state: 'unloaded',
    details: target,
  }]);
  assert.deepEqual(calls, [{ sessionId: 'original-session' }]);
  assert.equal(JSON.stringify(value), before);
});

test('missing, denied, unavailable, thrown, or mismatched detail lookup keeps an unloaded row without a navigation target', async () => {
  const responses = [
    undefined,
    { get: async () => ({ status: 'denied', code: 'permission-denied' }) },
    { get: async () => ({ status: 'unavailable', code: 'session-unavailable' }) },
    {
      get: async () => {
        throw new Error('connection replaced');
      },
    },
    {
      get: async () => ({
        status: 'accepted',
        sessionId: 'foreign-session',
        target: { kind: 'host', ref: 'foreign-ref' },
      }),
    },
  ];
  for (const references of responses) {
    const rows = await roomAssociatedSessions(room(), [{ sessionId: 'second-session' }], references);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'unloaded');
    assert.equal(rows[0].details, undefined);
  }
});

test('association is removed once the exact Session appears in activeRuns and absent Room participants are not invented', async () => {
  assert.deepEqual(
    await roomAssociatedSessions(room(), [{ sessionId: 'original-session' }, { sessionId: 'second-session' }]),
    [],
  );
  assert.deepEqual(await roomAssociatedSessions({ ...room(), participants: [] }, []), []);
  assert.deepEqual(
    await roomAssociatedSessions({
      ...room(),
      memberships: [{ memberId: 'member', participantId: 'participant', definition: { agentId: '', revision: 'v1' } }],
    }, []),
    [],
  );
});

test('associated Sessions respect the public 64-row snapshot bound without modifying Room history', async () => {
  const value = {
    ...room(),
    runs: Array.from({ length: 65 }, (_, index) => ({
      memberId: 'member',
      runId: `run-${index}`,
      sessionId: `session-${index}`,
    })),
  };
  const rows = await roomAssociatedSessions(value, []);
  assert.equal(rows.length, 64);
  assert.equal(rows[0].sessionId, 'session-1');
  assert.equal(value.runs.length, 65);
});
