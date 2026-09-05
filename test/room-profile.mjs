import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH,
  CHATROOM_ROOM_NAME_MAX_LENGTH,
  executeRoomProfileCommand,
  replaceRoomProfile,
} from '../dist/room-profile.js';
import { createRoom } from '../dist/room.js';
import { ChatroomRoomStoreError, DurableChatroomRoomStore } from '../dist/room-store.js';

const room = () =>
  createRoom({
    id: 'room-profile',
    title: 'Original',
    description: 'Original description',
    participants: [
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
  });

test('persists Room name and description without changing frozen participant or membership order', async () => {
  const original = room();
  const participantIds = original.participants.map(participant => participant.id);
  const memberIds = original.memberships.map(member => member.memberId);
  const store = DurableChatroomRoomStore.memory([original]);
  const current = store.document(original.id);
  const committed = await executeRoomProfileCommand(store, {
    type: 'replace-room-profile',
    roomId: original.id,
    expectedRevision: current.revision,
    name: '  Renamed Room  ',
    description: '  Durable description  ',
  });

  assert.equal(committed.room.title, 'Renamed Room');
  assert.equal(committed.room.description, 'Durable description');
  assert.deepEqual(committed.room.participants.map(participant => participant.id), participantIds);
  assert.deepEqual(committed.room.memberships.map(member => member.memberId), memberIds);
  const replayed = await executeRoomProfileCommand(store, {
    type: 'replace-room-profile',
    roomId: original.id,
    expectedRevision: committed.revision,
    name: 'Renamed Room',
    description: 'Durable description',
  });
  assert.equal(replayed.revision, committed.revision, 'an exact no-op does not advance the CAS revision');
  await assert.rejects(
    executeRoomProfileCommand(store, {
      type: 'replace-room-profile',
      roomId: original.id,
      expectedRevision: current.revision,
      name: 'Renamed Room',
      description: 'Durable description',
    }),
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict' && error.recoverable,
    'a stale same-value command must not bypass the CAS fence',
  );

  const reopened = DurableChatroomRoomStore.memory(JSON.parse(JSON.stringify([committed.room])));
  assert.deepEqual(reopened.rooms.get(original.id).participants.map(participant => participant.id), participantIds);
  assert.equal(reopened.rooms.get(original.id).title, 'Renamed Room');
  assert.equal(reopened.rooms.get(original.id).description, 'Durable description');
  store.dispose();
  reopened.dispose();
});

test('uses the whole-registry revision as a fail-closed Room profile CAS fence', async () => {
  const store = DurableChatroomRoomStore.memory([room()]);
  const revision = store.document('room-profile').revision;
  await executeRoomProfileCommand(store, {
    type: 'replace-room-profile',
    roomId: 'room-profile',
    expectedRevision: revision,
    name: 'First',
    description: 'First description',
  });
  await assert.rejects(
    executeRoomProfileCommand(store, {
      type: 'replace-room-profile',
      roomId: 'room-profile',
      expectedRevision: revision,
      name: 'Stale',
      description: 'Must not overwrite',
    }),
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict' && error.recoverable,
  );
  assert.equal(store.rooms.get('room-profile').title, 'First');
  store.dispose();
});

test('normalizes empty description and bounds user-owned Room profile values', () => {
  const original = room();
  const cleared = replaceRoomProfile(original, { name: 'Room', description: '   ' });
  assert.equal(cleared.description, undefined);
  assert.throws(() => replaceRoomProfile(original, { name: '   ' }), /Room name must be non-empty/);
  assert.throws(() =>
    replaceRoomProfile(original, {
      name: 'x'.repeat(CHATROOM_ROOM_NAME_MAX_LENGTH + 1),
    }), /Room name exceeds/);
  assert.throws(() =>
    replaceRoomProfile(original, {
      name: 'Room',
      description: 'x'.repeat(CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH + 1),
    }), /Room description exceeds/);
});
