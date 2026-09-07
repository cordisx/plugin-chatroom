import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomPageSource } from '../dist/chatroom-page-source.js';
import { ChatroomComposerSettings } from '../dist/composer-settings.js';
import { ChatroomConversationController } from '../dist/conversation-source.js';
import { createRoom } from '../dist/room.js';

function harness(rooms = [], items = [], admittedRoomItemIds = []) {
  const conversation = new ChatroomConversationController(rooms);
  const projectionListeners = new Set();
  let commitSettings;
  const settings = new ChatroomComposerSettings({
    get: () => ({ shortcutPolicy: 'enter' }),
    watch(listener) {
      commitSettings = listener;
      return () => {};
    },
  });
  const sessions = {
    hydrateRoom: async () => {},
    isRunLocallyUnavailable: () => false,
    projectionForRoom: () => ({ activeRuns: [], items, admittedRoomItemIds }),
    subscribeProjection(listener) {
      projectionListeners.add(listener);
      return () => projectionListeners.delete(listener);
    },
  };
  const mount = () => new ChatroomPageSource(conversation, sessions, settings);
  return { conversation, settings, commitSettings, projectionListeners, mount };
}

test('page subscriptions observe Room and committed composer changes and detach independently', () => {
  const h = harness([createRoom({ id: 'room', title: 'Before' })]);
  const source = h.mount();
  const observations = [[], []];
  const unsubscribers = observations.map(values => source.subscribe(() => values.push(source.getSnapshot('room'))));
  const before = source.getSnapshot('room');
  h.conversation.rooms.upsert(createRoom({ ...before.room, title: 'After' }));
  h.commitSettings({ shortcutPolicy: 'mod-enter' });
  assert.deepEqual(observations[0].map(snapshot => [snapshot.room.title, snapshot.shortcutPolicy]), [
    ['After', 'enter'],
    ['After', 'mod-enter'],
  ]);
  assert.deepEqual(observations[0], observations[1]);
  unsubscribers[0]();
  h.commitSettings({ shortcutPolicy: 'enter' });
  assert.equal(observations[0].length, 2);
  assert.equal(observations[1].length, 3);
  source.dispose();
  source.dispose();
  assert.equal(h.projectionListeners.size, 0);
  h.commitSettings({ shortcutPolicy: 'mod-enter' });
  h.conversation.rooms.upsert(createRoom({ id: 'room', title: 'Disposed' }));
  assert.equal(observations[1].length, 3);
  unsubscribers[1]();
  h.settings.dispose();
  h.conversation.dispose();
});

test('page has distinct new-room and missing-room state without any Shell binding', () => {
  const h = harness();
  const source = h.mount();
  assert.equal(source.getSnapshot(undefined).missing, false);
  assert.equal(source.getSnapshot(undefined).room, undefined);
  assert.deepEqual(source.getSnapshot(undefined).items, []);
  assert.equal(source.getSnapshot('missing').missing, true);
  h.conversation.rooms.upsert(createRoom({
    id: 'missing',
    title: 'Restored',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
  }));
  const restored = source.getSnapshot('missing');
  assert.equal(restored.missing, false);
  assert.equal(restored.room.title, 'Restored');
  assert.equal(restored.participants[0].role, 'human');
  source.dispose();
  h.settings.dispose();
  h.conversation.dispose();
});

test('page keeps acknowledgement chronology and exact Session deduplication across remount', () => {
  const message = (id, timestamp, sequence, source = 'agent-loop') => ({
    kind: 'message',
    itemId: id,
    messageId: id,
    sequence,
    source,
    author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { key: 'body', fallback: id } }],
    reactions: [],
    timestamp,
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'off',
    actions: [],
  });
  const earlier = message('session-earlier', '2026-09-03T00:00:00Z', 70);
  const later = message('session-later', '2026-09-03T00:02:00Z', 71);
  const acknowledgement = {
    ...message('ack', '2026-09-03T00:01:00Z', 1, 'chatroom-acknowledgement'),
    semantic: { purpose: 'chatroom-acknowledgement' },
  };
  const room = createRoom({
    id: 'room',
    title: 'Room',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
    items: [acknowledgement, { ...later, sequence: 2 }],
  });
  // Equality of text or IDs alone is not proof that a Room fact was admitted.
  const unlinked = harness([room], [earlier, later]);
  const unlinkedSource = unlinked.mount();
  assert.equal(unlinkedSource.getSnapshot('room').items.length, 4);
  unlinkedSource.dispose();
  unlinked.settings.dispose();
  unlinked.conversation.dispose();
  // Production supplies this mapping from the exact Session event's durable Room display.
  const h = harness([room], [earlier, later], ['session-later']);
  const source = h.mount();
  const expected = ['session-earlier', 'ack', 'session-later'];
  assert.deepEqual(source.getSnapshot('room').items.map(item => item.itemId), expected);
  h.projectionListeners.forEach(listener => listener('room'));
  assert.deepEqual(source.getSnapshot('room').items.map(item => item.itemId), expected);
  source.dispose();
  const remounted = h.mount();
  assert.deepEqual(remounted.getSnapshot('room').items.map(item => item.itemId), expected);
  remounted.dispose();
  h.settings.dispose();
  h.conversation.dispose();
});
