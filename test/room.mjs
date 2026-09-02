import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addRoomRun,
  approvalAuthorityMemberIds,
  bindRoomRunSession,
  createRoom,
  recordRoomMemberSelfIntroduction,
} from '../dist/room.js';

const identity = agentId => ({ agentId, revision: 'v1' });
const memberships = [
  { memberId: 'lead', label: 'Lead', definition: identity('lead'), role: 'leader', attentionPolicy: 'ambient' },
  { memberId: 'review', label: 'Review', definition: identity('review'), role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'lead' },
];

test('RoomRun persists only domain identity, SessionId, presence, and intent correlation', () => {
  let room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['lead'] });
  room = addRoomRun(room, { runId: 'review-run', memberId: 'review', title: 'Review', status: 'creating' });
  room = bindRoomRunSession(room, 'review-run', 'session-review');
  room = recordRoomMemberSelfIntroduction(room, 'review-run', {
    requestMessageId: 'intro-message', correlationId: 'intro-correlation', requestedAt: '2026-09-02T00:00:00.000Z',
  });

  assert.deepEqual(Object.keys(room.runs[0]).sort(), [
    'memberId', 'presence', 'runId', 'selfIntroduction', 'sessionId', 'status', 'title',
  ]);
  assert.equal(room.runs[0].sessionId, 'session-review');
  assert.equal(JSON.stringify(room).includes('taskBinding'), false);
  assert.equal(JSON.stringify(room).includes('agentLoopCursor'), false);
  assert.equal(JSON.stringify(room).includes('publicProjections'), false);
  assert.equal(JSON.stringify(room).includes('delivery'), false);
});

test('one Session belongs to only one Room run and cannot be rebound', () => {
  let room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['lead'] });
  room = addRoomRun(room, { runId: 'lead-run', memberId: 'lead', title: 'Lead', status: 'creating' });
  room = addRoomRun(room, { runId: 'review-run', memberId: 'review', title: 'Review', status: 'creating' });
  room = bindRoomRunSession(room, 'lead-run', 'session-one');
  assert.throws(() => bindRoomRunSession(room, 'lead-run', 'session-two'), /different Session/);
  assert.throws(() => bindRoomRunSession(room, 'review-run', 'session-one'), /another Room run/);
});

test('approval authority follows reports-to hierarchy without runtime state', () => {
  const room = createRoom({ id: 'room', title: 'Room', memberships, seedLeaderIds: ['lead'] });
  assert.deepEqual(approvalAuthorityMemberIds(room, 'review'), ['lead']);
  assert.deepEqual(approvalAuthorityMemberIds(room, 'lead'), []);
});
