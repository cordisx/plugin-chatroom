import assert from 'node:assert/strict';
import test from 'node:test';

import { roomAvatarFingerprint } from '../dist/avatar-fingerprint.js';
import { ChatroomRoomNavigationCollection } from '../dist/room-navigation.js';
import { ChatroomRoomRegistry, createRoom } from '../dist/room.js';
import {
  CHATROOM_SIDEBAR_IMAGE_CONTRACT,
  CHATROOM_SIDEBAR_IMAGE_SCHEMA,
  ChatroomSidebarImageCache,
} from '../dist/sidebar-image-cache.js';

const png = Object.freeze({
  $schema: CHATROOM_SIDEBAR_IMAGE_SCHEMA,
  contract: CHATROOM_SIDEBAR_IMAGE_CONTRACT,
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  width: 1,
  height: 1,
});

const avatar = participantId => ({
  kind: 'asset',
  ref: `room-avatar:${participantId}`,
  revision: 'room-avatar:v1',
});

const room = createRoom({
  id: 'room-a',
  title: 'Room A',
  participants: [
    { id: 'user', name: 'You', kind: 'human' },
    { id: 'agent-a', name: 'Agent A', kind: 'agent', avatar: avatar('agent-a') },
  ],
});

const itemFor = collection => collection.snapshot().items[0];

test('uses a semantic fallback until a completed generic Room image is published', () => {
  const registry = new ChatroomRoomRegistry([room]);
  const images = new ChatroomSidebarImageCache();
  const collection = new ChatroomRoomNavigationCollection(registry, 'active', images);
  const fallback = itemFor(collection);
  assert.equal(fallback.icon, 'host:layers');
  assert.equal(Object.hasOwn(fallback, 'leadingVisual'), false);

  const fingerprint = roomAvatarFingerprint(room.participants.map(participant => ({
    id: participant.id,
    name: participant.name,
    ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
  })));
  const beforeRevision = collection.snapshot().revision;
  assert.equal(images.begin(room.id, fingerprint).publish(png), true);
  const projected = itemFor(collection);
  assert.equal(collection.snapshot().revision, beforeRevision + 1);
  assert.equal(Object.hasOwn(projected, 'icon'), false);
  assert.equal(projected.leadingVisual.kind, 'image');
  assert.deepEqual(projected.leadingVisual.image, png);
  assert.equal(Object.isFrozen(projected.leadingVisual), true);
  assert.equal(Object.isFrozen(projected.leadingVisual.image), true);
  collection.dispose();
  images.dispose();
});

test('does not reuse a cached PNG after the Room avatar fingerprint changes', () => {
  const registry = new ChatroomRoomRegistry([room]);
  const images = new ChatroomSidebarImageCache();
  const collection = new ChatroomRoomNavigationCollection(registry, 'active', images);
  const firstFingerprint = roomAvatarFingerprint(room.participants.map(participant => ({
    id: participant.id,
    name: participant.name,
    ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
  })));
  images.begin(room.id, firstFingerprint).publish(png);
  assert.equal(itemFor(collection).leadingVisual.kind, 'image');

  registry.upsert(createRoom({
    ...room,
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      { id: 'agent-b', name: 'Agent B', kind: 'agent', avatar: avatar('agent-b') },
    ],
  }));
  const changed = itemFor(collection);
  assert.equal(changed.icon, 'host:layers');
  assert.equal(Object.hasOwn(changed, 'leadingVisual'), false);
  collection.dispose();
  images.dispose();
});

test('preserves exact Room identity and ordering independently of image availability', () => {
  const registry = new ChatroomRoomRegistry([
    createRoom({ id: 'room-a', title: 'Same', pinned: false }),
    createRoom({ id: 'room-b', title: 'Same', pinned: true }),
  ]);
  const collection = new ChatroomRoomNavigationCollection(registry);
  assert.deepEqual(collection.snapshot().items.map(item => item.route), [
    { id: 'room', params: { roomId: 'room-b' } },
    { id: 'room', params: { roomId: 'room-a' } },
  ]);
  assert.equal(new Set(collection.snapshot().items.map(item => item.id)).size, 2);
  collection.dispose();
});
