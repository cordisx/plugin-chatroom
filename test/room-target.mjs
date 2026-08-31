import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoomMessageDispatch } from '../dist/room-target.js';
import { addRoomRun, createRoom } from '../dist/room.js';

const identity = agentId => ({ agentId, revision: 'v1' });
const memberships = [
  { memberId: 'root-a', label: 'Root A', definition: identity('root-a'), role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'root-b', label: 'Root B', definition: identity('root-b'), role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'review', label: 'Review', definition: identity('review'), role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'root-a' },
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

test('unions multiple mentions and delegation with ambient recipients, then dedupes mailboxes', () => {
  const room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  const result = resolveRoomMessageDispatch(room, '@review @root-a @review Inspect', ['review']);
  assert.equal(result.status, 'resolved');
  assert.equal(result.content, 'Inspect');
  assert.deepEqual(result.recipients, [
    { memberId: 'root-a', createRun: true, reason: 'mention' },
    { memberId: 'root-b', createRun: true, reason: 'ambient' },
    { memberId: 'review', createRun: true, reason: 'delegation' },
  ]);
});

test('exact run mention overrides the same ambient member mailbox without suppressing other ambient members', () => {
  let room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['root-a', 'root-b'] });
  room = addRoomRun(room, { runId: 'root-a-special', memberId: 'root-a', title: 'Special', status: 'creating' });
  const result = resolveRoomMessageDispatch(room, '@root-a/root-a-special Exact');
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.recipients, [
    { memberId: 'root-b', createRun: true, reason: 'ambient' },
    { memberId: 'root-a', runId: 'root-a-special', createRun: false, reason: 'mention' },
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
