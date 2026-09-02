import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomRoomNavigationCollection } from '../dist/room-navigation.js';
import { ChatroomRoomRegistry, createRoom } from '../dist/room.js';

const avatar = participantId => ({
  kind: 'asset', ref: `room-avatar:${participantId}`, revision: 'room-avatar:v1',
});

const participants = count => Array.from({ length: count }, (_, index) => ({
  id: `participant-${index}`,
  name: `Participant ${index}`,
  kind: index === 0 ? 'human' : 'agent',
  ...(index % 2 === 0 ? {} : { avatar: avatar(`participant-${index}`) }),
}));

const visualFor = (collection, roomId) => collection.snapshot().items
  .find(item => item.route.params?.roomId === roomId)?.leadingVisual;

test('projects exact ordered Room participants for 0/1/2/3/4+/16 layouts', () => {
  for (const count of [0, 1, 2, 3, 4, 7, 16]) {
    const roomId = `room-${count}`;
    const collection = new ChatroomRoomNavigationCollection(new ChatroomRoomRegistry([
      createRoom({ id: roomId, title: `Room ${count}`, participants: participants(count) }),
    ]));
    const visual = visualFor(collection, roomId);
    assert.equal(visual.kind, 'room-composite-avatar');
    assert.deepEqual(visual.participants.map(participant => participant.participantId),
      participants(count).map(participant => participant.id));
    assert.deepEqual(visual.participants.map(participant => participant.avatar?.ref),
      participants(count).map(participant => participant.avatar?.ref));
    assert.equal(Object.hasOwn(collection.snapshot().items[0], 'icon'), false);
    collection.dispose();
  }
});

test('bounds a Room visual to the formal 16-participant maximum', () => {
  const room = createRoom({ id: 'bounded', title: 'Bounded', participants: participants(17) });
  const collection = new ChatroomRoomNavigationCollection(new ChatroomRoomRegistry([room]));
  assert.equal(visualFor(collection, 'bounded').participants.length, 16);
  assert.equal(visualFor(collection, 'bounded').participants.at(-1).participantId, 'participant-15');
  collection.dispose();
});

test('keeps first-seen participant order while enforcing unique opaque identities', () => {
  const room = createRoom({
    id: 'deduplicated', title: 'Deduplicated', participants: [
      { id: 'agent-a', name: 'Agent A', kind: 'agent', avatar: avatar('agent-a-first') },
      { id: 'agent-b', name: 'Agent B', kind: 'agent', avatar: avatar('agent-b') },
      { id: 'agent-a', name: 'Agent A duplicate', kind: 'agent', avatar: avatar('agent-a-later') },
    ],
  });
  const collection = new ChatroomRoomNavigationCollection(new ChatroomRoomRegistry([room]));
  assert.deepEqual(visualFor(collection, 'deduplicated').participants.map(participant => ({
    participantId: participant.participantId, avatar: participant.avatar.ref,
  })), [
    { participantId: 'agent-a', avatar: 'room-avatar:agent-a-first' },
    { participantId: 'agent-b', avatar: 'room-avatar:agent-b' },
  ]);
  collection.dispose();
});

test('keeps same-title Room visuals keyed by exact roomId and updates only that snapshot', () => {
  const registry = new ChatroomRoomRegistry([
    createRoom({ id: 'room-a', title: 'New room', participants: [{
      id: 'agent-a', name: 'Agent A', kind: 'agent', avatar: avatar('agent-a'),
    }] }),
    createRoom({ id: 'room-b', title: 'New room', participants: [{
      id: 'agent-b', name: 'Agent B', kind: 'agent', avatar: avatar('agent-b'),
    }] }),
  ]);
  const collection = new ChatroomRoomNavigationCollection(registry);
  const before = collection.snapshot();
  const itemIdA = before.items.find(item => item.route.params.roomId === 'room-a').id;
  const itemIdB = before.items.find(item => item.route.params.roomId === 'room-b').id;
  assert.equal(visualFor(collection, 'room-a').participants[0].avatar.ref, 'room-avatar:agent-a');
  assert.equal(visualFor(collection, 'room-b').participants[0].avatar.ref, 'room-avatar:agent-b');

  registry.upsert(createRoom({ id: 'room-a', title: 'New room', participants: [{
    id: 'agent-a2', name: 'Agent A2', kind: 'agent', avatar: avatar('agent-a2'),
  }] }));
  const after = collection.snapshot();
  assert.equal(after.revision, 1);
  assert.equal(after.items.find(item => item.route.params.roomId === 'room-a').id, itemIdA);
  assert.equal(after.items.find(item => item.route.params.roomId === 'room-b').id, itemIdB);
  assert.equal(visualFor(collection, 'room-a').participants[0].avatar.ref, 'room-avatar:agent-a2');
  assert.equal(visualFor(collection, 'room-b').participants[0].avatar.ref, 'room-avatar:agent-b');
  assert.deepEqual(after.items.find(item => item.route.params.roomId === 'room-a').route,
    { id: 'room', params: { roomId: 'room-a' } });
  collection.dispose();
});

test('detaches and freezes the projected leading visual from mutable input', () => {
  const mutableAvatar = avatar('stable');
  const room = createRoom({
    id: 'frozen', title: 'Frozen',
    participants: [{ id: 'stable', name: 'Stable', kind: 'agent', avatar: mutableAvatar }],
  });
  mutableAvatar.ref = 'room-avatar:mutated-after-room';
  const collection = new ChatroomRoomNavigationCollection(new ChatroomRoomRegistry([room]));
  const visual = visualFor(collection, 'frozen');
  assert.equal(visual.participants[0].avatar.ref, 'room-avatar:stable');
  assert.equal(Object.isFrozen(visual), true);
  assert.equal(Object.isFrozen(visual.participants), true);
  assert.equal(Object.isFrozen(visual.participants[0]), true);
  assert.equal(Object.isFrozen(visual.participants[0].avatar), true);
  assert.throws(() => { visual.participants[0].avatar.ref = 'room-avatar:mutation'; }, TypeError);
  collection.dispose();
});
