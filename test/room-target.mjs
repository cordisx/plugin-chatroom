import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoomMessageDispatch } from '../dist/room-target.js';
import { addRoomRun, createRoom } from '../dist/room.js';

const identity = agentId => ({ agentId, revision: 'v1' });
const memberships = [
  { memberId: 'root-a', label: 'Root A', definition: identity('root-a'), role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'root-b', label: 'Root B', definition: identity('root-b'), role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'review', label: 'Review', definition: identity('review'), role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'root-a' },
  { memberId: 'integrator', label: 'Integrator', definition: identity('integrator'), role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'root-a' },
];

test('dispatches ordinary messages to every ambient member, independent of role', () => {
  const room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  const result = resolveRoomMessageDispatch(room, 'Hello team');
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.recipients, [
    { memberId: 'root-a', createRun: true, reason: 'ambient' },
    { memberId: 'root-b', createRun: true, reason: 'ambient' },
  ]);
});

test('explicit mentions and delegation replace ambient recipients, then dedupe mailboxes', () => {
  const room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  const result = resolveRoomMessageDispatch(room, '@review @root-a @review Inspect', ['review']);
  assert.equal(result.status, 'resolved');
  assert.equal(result.content, 'Inspect');
  assert.deepEqual(result.recipients, [
    { memberId: 'review', createRun: true, reason: 'delegation' },
    { memberId: 'root-a', createRun: true, reason: 'mention' },
  ]);
});

test('exact run mention replaces ambient delivery and overrides the same member mailbox', () => {
  let room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  room = addRoomRun(room, { runId: 'root-a-special', memberId: 'root-a', title: 'Special', status: 'creating' });
  const result = resolveRoomMessageDispatch(room, '@root-a/root-a-special Exact');
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.recipients, [
    { memberId: 'root-a', runId: 'root-a-special', createRun: false, reason: 'mention' },
  ]);
});

test('reads back plain, single mention, multiple mentions, and delegation-only routing', () => {
  const room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  assert.deepEqual(resolveRoomMessageDispatch(room, 'Plain').recipients, [
    { memberId: 'root-a', createRun: true, reason: 'ambient' },
    { memberId: 'root-b', createRun: true, reason: 'ambient' },
  ]);
  assert.deepEqual(resolveRoomMessageDispatch(room, '@review Review').recipients, [
    { memberId: 'review', createRun: true, reason: 'mention' },
  ]);
  assert.deepEqual(resolveRoomMessageDispatch(room, '@review @integrator Coordinate').recipients, [
    { memberId: 'review', createRun: true, reason: 'mention' },
    { memberId: 'integrator', createRun: true, reason: 'mention' },
  ]);
  assert.deepEqual(resolveRoomMessageDispatch(room, 'Delegated', ['integrator']).recipients, [
    { memberId: 'integrator', createRun: true, reason: 'delegation' },
  ]);
});

test('mention-only members receive nothing until mentioned or delegated', () => {
  const room = createRoom({
    id: 'room', title: 'Room', memberships: memberships.map(member => ({ ...member, attentionPolicy: 'mention-only' })),
    seedLeaderIds: ['root-a', 'root-b'],
  });
  assert.deepEqual(resolveRoomMessageDispatch(room, 'No target'), { status: 'no-recipients' });
  assert.equal(resolveRoomMessageDispatch(room, '@review Targeted').status, 'resolved');
  assert.equal(resolveRoomMessageDispatch(room, 'Delegated', ['review']).status, 'resolved');
});
