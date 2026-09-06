import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION, parseChatroomAgentConfiguration } from '../dist/agent-definition.js';
import { buildTeamArchitectureViewModel, createTeamArchitectureDataSource } from '../dist/team-entity-view-model.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const fixture = () => {
  const configuration = parseChatroomAgentConfiguration(CHATROOM_DEFAULT_AGENT_CONFIGURATION);
  const member = configuration.members[0];
  const room = Object.freeze({
    id: 'room-1',
    title: 'Room one',
    memberships: Object.freeze([Object.freeze({
      memberId: member.memberId,
      participantId: 'participant-1',
      definition: member.definition,
    })]),
    runs: Object.freeze([Object.freeze({
      memberId: member.memberId,
      runId: 'run-1',
      title: 'Run one',
      status: 'active',
      sessionId: 'session-1',
      presence: Object.freeze({ state: 'ready' }),
    })]),
  });
  return { configuration, member, room };
};

test('uses only an exact durable SessionId to get and open an opaque detail target', async () => {
  const { configuration, member, room } = fixture();
  const target = Object.freeze({ opaque: 'host-issued-detail' });
  const calls = [];
  const registry = { snapshot: () => [room], subscribe: () => () => {} };
  const source = createTeamArchitectureDataSource(configuration, registry, {
    references: {
      get: async request => {
        calls.push(['get', request]);
        return { status: 'accepted', sessionId: 'session-1', target };
      },
    },
    navigation: {
      open: async request => {
        calls.push(['open', request]);
        return { status: 'accepted', code: 'opened' };
      },
    },
  });
  await tick();
  const entity = buildTeamArchitectureViewModel(source.getSnapshot()).entities
    .find(candidate => candidate.memberId === member.memberId);
  assert.equal(entity?.activeSessions[0]?.sessionId, 'session-1');
  assert.equal(entity?.activeSessions[0]?.detail, target);
  assert.deepEqual(calls, [['get', { sessionId: 'session-1' }]]);
  assert.equal(await source.openSessionDetail('session-1'), true);
  assert.deepEqual(calls.at(-1), ['open', { target }]);
  source.dispose();
});

test('keeps nonaccepted Session detail reads and opens unavailable', async () => {
  const { configuration, room } = fixture();
  const registry = { snapshot: () => [room], subscribe: () => () => {} };
  const source = createTeamArchitectureDataSource(configuration, registry, {
    references: { get: async () => ({ status: 'unavailable', code: 'detail-unavailable' }) },
    navigation: {
      open: async () => {
        throw new Error('must not open');
      },
    },
  });
  await tick();
  const entity = buildTeamArchitectureViewModel(source.getSnapshot()).entities[0];
  assert.equal(entity.activeSessions[0]?.detail, undefined);
  assert.equal(await source.openSessionDetail('session-1'), false);
  source.dispose();
});

test('declares both Host detail services before injecting them into the Team source', async () => {
  const entry = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');
  assert.match(entry, /'agentSessionDetailReferences'/u);
  assert.match(entry, /'agentDetailNavigation'/u);
  assert.match(
    entry,
    /createTeamArchitectureDataSource\(agent, product\.store\.rooms, \{[\s\S]*?references: ctx\.agentSessionDetailReferences,[\s\S]*?navigation: ctx\.agentDetailNavigation,/u,
  );
});
