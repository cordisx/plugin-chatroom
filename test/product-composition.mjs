import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  CHATROOM_MANAGER_CONTENT_DECLARATIONS,
  CHATROOM_PLUGIN_ID,
  CHATROOM_SESSION_DETAIL_ROUTE,
  ChatroomApprovalCoordinator,
  TEAM_ARCHITECTURE_DETAIL_ROUTE_IDS,
  addRoomRun,
  apply,
  bindRoomRunSession,
  createRoom,
  inject,
  projectTeamEntities,
} from '../dist/index.js';

test('exports one activatable Cordis composition over only public Agent and Session services', () => {
  assert.equal(typeof apply, 'function');
  assert.equal(CHATROOM_PLUGIN_ID, 'org.cordisx.chatroom');
  assert.equal(CHATROOM_SESSION_DETAIL_ROUTE.id, 'room-session-detail');
  assert.equal(new Set(inject).size, inject.length);
  for (const service of ['agents', 'sessions', 'approvals']) assert.equal(inject.includes(service), true);
  assert.equal(inject.some(service => /backend|transport|fixture/i.test(service)), false);
});

test('ships three Manager chat tabs and five Team entity detail tabs', () => {
  assert.deepEqual(CHATROOM_MANAGER_CONTENT_DECLARATIONS.map(item => item.id), [
    'rooms', 'archived', 'settings',
  ]);
  assert.deepEqual(Object.keys(TEAM_ARCHITECTURE_DETAIL_ROUTE_IDS), [
    'overview', 'prompts', 'relationships', 'capabilities', 'sessions',
  ]);
});

test('projects five truthful Team entities and exact Session detail routes', () => {
  let room = createRoom({
    id: 'room-one',
    title: 'Room one',
    configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  });
  room = addRoomRun(room, {
    runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'running',
  });
  room = bindRoomRunSession(room, 'lead-run', 'session-one');
  const entities = projectTeamEntities(CHATROOM_DEFAULT_AGENT_CONFIGURATION, [room]);

  assert.equal(entities.length, 5);
  assert.deepEqual(entities.map(entity => entity.memberId), [
    'leader', 'reviewer', 'integrator', 'documentation', 'qa',
  ]);
  assert.deepEqual(entities[0].activeSessions[0].route, {
    id: 'room-session-detail',
    params: { roomId: 'room-one', runId: 'lead-run', sessionId: 'session-one' },
  });
  assert.equal(entities[0].declaredCapabilities.promptSections.every(
    section => section.provenance === 'direct',
  ), true);
});

test('answers approvals only through the exact Room run and Session fence', async () => {
  const coordinator = new ChatroomApprovalCoordinator();
  let room = createRoom({ id: 'room-one', title: 'Room one', configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION });
  room = addRoomRun(room, { runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'running' });
  room = bindRoomRunSession(room, 'review-run', 'session-one');
  const run = room.runs[0];
  const member = room.memberships.find(candidate => candidate.memberId === 'reviewer');
  const question = {
    id: 'approval-one', sessionId: 'session-one', agentId: 'session-one', agentGeneration: 1,
  };
  const outcome = coordinator.policy({
    room, run, member, authorityMemberIds: ['leader'], question,
  });

  assert.equal(coordinator.decide(
    'room-one', 'review-run', 'session-two', 'approval-one', 'allowed-once',
  ), false);
  assert.equal(coordinator.decide(
    'room-one', 'review-run', 'session-one', 'approval-one', 'allowed-once',
  ), true);
  assert.equal(await outcome, 'allowed-once');
  coordinator.dispose();
});
