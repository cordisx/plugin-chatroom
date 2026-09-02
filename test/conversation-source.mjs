import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_COMMAND_SUBMIT,
} from '../dist/conversation-model.js';
import { ChatroomConversationController } from '../dist/conversation-source.js';
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { addRoomRun, createRoom } from '../dist/room.js';
import { failRoomRunPresence } from '../dist/room-engagement.js';

const binding = Object.freeze({
  bindingId: 'binding-1', shell: 'agent-desktop', ownerGeneration: 'owner-1',
  routeSelection: { scope: 'room-or-new' },
});

test('projects an empty no-room conversation with an available Host composer', async () => {
  const controller = new ChatroomConversationController();
  const source = controller.createSource(binding);
  const snapshot = await source.snapshot();

  assert.deepEqual(snapshot.selection, { kind: 'no-room' });
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(snapshot.headerActions, []);
  assert.equal(snapshot.composer.submit.id, CHATROOM_COMMAND_SUBMIT);
  assert.equal(snapshot.composer.availability, 'available');
  assert.equal(snapshot.composer.disabled.value, false);
  assert.equal('draft' in snapshot.composer, false);
  assert.equal(JSON.stringify(snapshot).includes('conversation'), false);
});

test('serializes a terminal page when the Host disposes the source', async () => {
  const source = new ChatroomConversationController().createSource(binding);
  const subscribed = await source.subscribe((await source.snapshot()).snapshotSequence);
  assert.equal('handle' in subscribed, true);
  if (!('handle' in subscribed)) return;

  const iterator = subscribed.handle.pages[Symbol.asyncIterator]();
  source.dispose();
  const page = await iterator.next();

  assert.equal(page.done, false);
  assert.equal(page.value.phase, 'live');
  assert.deepEqual(page.value.updates, [{ kind: 'disposed', sequence: 501, reason: 'owner-disposed' }]);
  assert.equal(page.value.hasMore, false);
});

test('gives concurrent subscriptions distinct identities', async () => {
  const source = new ChatroomConversationController().createSource(binding);
  const afterSequence = (await source.snapshot()).snapshotSequence;
  const first = await source.subscribe(afterSequence);
  const second = await source.subscribe(afterSequence);

  assert.equal('handle' in first, true);
  assert.equal('handle' in second, true);
  if (!('handle' in first) || !('handle' in second)) return;
  assert.notEqual(first.handle.subscription.subscriptionId, second.handle.subscription.subscriptionId);
  assert.match(first.handle.subscription.subscriptionId, /^[A-Za-z0-9._~-]+$/);
  first.handle.unsubscribe();
  second.handle.unsubscribe();
});

test('rejects a stale cursor instead of emitting a discontinuous replay page', async () => {
  const source = new ChatroomConversationController().createSource(binding);
  const subscribed = await source.subscribe(0);

  assert.deepEqual(subscribed, {
    result: { type: 'subscribe', status: 'unavailable', code: 'generation-replaced' },
  });
});

test('maps a selected multi-participant Room into structured shell data', async () => {
  const room = createRoom({
    id: 'review',
    title: 'Review',
    participants: [{
      id: 'agent-a', name: 'Architecture', kind: 'agent',
      avatar: { kind: 'asset', ref: 'avatar-assets:architecture' },
    }],
    participantPresentation: { multiParticipant: true, participantPresentation: 'host-initials' },
    items: [{
      kind: 'status', itemId: 'status-1', sequence: 1,
      label: { namespace: 'chatroom', key: 'status.running', fallback: 'Working' },
      state: 'working', ariaLive: 'off',
    }],
  });
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(room);
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-2',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'review' },
  });
  const snapshot = await source.snapshot();

  assert.deepEqual(snapshot.selection, {
    kind: 'room', roomId: 'review',
    title: { namespace: 'chatroom', key: 'room.title', fallback: 'Review' },
    multiParticipant: true, participantPresentation: 'host-initials',
    participants: [{
      participantId: 'agent-a', role: 'agent',
      displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'Architecture' },
      avatar: { kind: 'asset', ref: 'avatar-assets:architecture' },
    }],
  });
  assert.equal(snapshot.items[0].kind, 'status');
  assert.equal(snapshot.items[0].sequence, 1);
  assert.equal(JSON.stringify(snapshot).includes('avatar-assets:architecture'), true);
});

test('bounds and re-numbers Room history for the snapshot sequence fence', async () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({
    id: 'history', title: 'History',
    items: Array.from({ length: 501 }, (_, index) => ({
      kind: 'status', itemId: `status-${index}`, sequence: index + 900,
      label: { namespace: 'chatroom', key: `status.${index}`, fallback: `Status ${index}` },
      state: 'info', ariaLive: 'off',
    })),
  }));
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-history',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'history' },
  });
  const snapshot = await source.snapshot();

  assert.equal(snapshot.items.length, 500);
  assert.equal(snapshot.items[0].sequence, 1);
  assert.equal(snapshot.items.at(-1)?.sequence, 500);
  assert.equal(snapshot.snapshotSequence, 500);
});

test('projects a human author only when explicitly present in the Room participants', async () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({
    id: 'with-human', title: 'With human',
    participants: [
      { id: 'user-1', name: 'You', kind: 'human' },
      { id: 'agent-1', name: 'Research', kind: 'agent' },
    ],
    items: [
      {
        kind: 'message', itemId: 'message-user', messageId: 'message-user', sequence: 99,
        author: {
          participantId: 'user-1', role: 'agent',
          displayName: { namespace: 'ignored', key: 'ignored', fallback: 'Ignored' },
        },
        body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: 'Hello' } }],
        timestamp: '2026-08-29T00:00:00.000Z', deliveryState: 'delivered', runState: 'idle',
        ariaLive: 'off', actions: [],
      },
      {
        kind: 'message', itemId: 'message-unknown', messageId: 'message-unknown', sequence: 100,
        author: {
          participantId: 'unknown', role: 'agent',
          displayName: { namespace: 'ignored', key: 'ignored', fallback: 'Ignored' },
        },
        body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.unknown', fallback: 'Skip' } }],
        timestamp: '2026-08-29T00:00:01.000Z', deliveryState: 'delivered', runState: 'idle',
        ariaLive: 'off', actions: [],
      },
    ],
  }));
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-human',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'with-human' },
  });
  const snapshot = await source.snapshot();

  assert.equal(snapshot.selection.kind, 'room');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].kind, 'message');
  if (snapshot.items[0].kind === 'message') {
    assert.deepEqual(snapshot.items[0].author, {
      participantId: 'user-1', role: 'human',
      displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'You' },
    });
  }
});

test('replaces an active selected Room snapshot after registry state changes', async () => {
  const controller = new ChatroomConversationController();
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-3',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'review' },
  });
  const subscribed = await source.subscribe((await source.snapshot()).snapshotSequence);
  assert.equal('handle' in subscribed, true);
  if (!('handle' in subscribed)) return;

  const iterator = subscribed.handle.pages[Symbol.asyncIterator]();
  controller.rooms.upsert(createRoom({ id: 'review', title: 'Review' }));
  const page = await iterator.next();

  assert.equal(page.value.phase, 'live');
  assert.equal(page.value.afterSequence, 500);
  assert.equal(page.value.nextAfterSequence, 501);
  assert.equal(page.value.updates[0].kind, 'snapshot-replaced');
  if (page.value.updates[0].kind === 'snapshot-replaced') {
    assert.equal(page.value.updates[0].snapshot.selection.kind, 'room');
  }
  source.dispose();
});

test('publishes one stable member presence lifecycle as item-updated', async () => {
  let room = createRoom({ id: 'presence-room', title: 'Presence' });
  room = addRoomRun(room, {
    runId: 'presence-run', memberId: 'leader', title: 'Lead', status: 'creating',
  });
  const controller = new ChatroomConversationController([room]);
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-presence',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'presence-room' },
  });
  const before = await source.snapshot();
  const presence = before.items.find(item => item.kind === 'member-presence');
  const subscribed = await source.subscribe(before.snapshotSequence);
  assert.equal('handle' in subscribed, true);
  if (!('handle' in subscribed)) return;
  const iterator = subscribed.handle.pages[Symbol.asyncIterator]();

  controller.rooms.upsert(failRoomRunPresence(room, 'presence-run', {
    code: 'provider-unavailable', retryable: true,
  }));
  const page = await iterator.next();
  const update = page.value.updates[0];
  assert.equal(update.kind, 'item-updated');
  assert.equal(update.item.itemId, presence.itemId);
  assert.equal(update.item.kind, 'member-presence');
  assert.equal(update.item.state, 'failed');
  assert.equal(update.item.retryable, true);
  source.dispose();
});

test('creates and projects a Room only from the first Host-generated composer submit', async () => {
  const controller = new ChatroomConversationController();
  const source = controller.createSource(binding);
  const intent = controller.handle({
    binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload: 'bounded host text',
  });
  assert.deepEqual(intent, {
    kind: 'send-message', roomId: 'room-1', roomCreated: true,
    deliveries: [{ memberId: 'leader', runId: 'run-1', runCreated: true, reason: 'ambient' }],
    userItemId: 'message-1',
    bindingId: 'binding-1', generation: 'owner-1', dispatchText: 'bounded host text',
  });
  assert.deepEqual(controller.takePendingIntents(), [
    intent,
  ]);
  const snapshot = await source.snapshot();
  assert.equal(snapshot.selection.kind, 'room');
  if (snapshot.selection.kind === 'room') {
    const lead = snapshot.selection.participants.find(participant => participant.participantId === 'leader');
    assert.deepEqual(lead?.avatar, {
      kind: 'asset', ref: 'oneworks-avatar:asset.red-fox.v1',
      revision: 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
    });
  }
  assert.equal(snapshot.selection.roomId, 'room-1');
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].kind, 'member-presence');
  const userMessage = snapshot.items.find(item => item.kind === 'message');
  assert.equal(userMessage.kind, 'message');
  if (userMessage.kind === 'message') {
    assert.equal(userMessage.source, 'agent-loop');
    assert.equal(userMessage.author.role, 'human');
    assert.equal(userMessage.body[0].text.fallback, 'bounded host text');
    assert.equal(userMessage.deliveryState, 'pending');
    assert.equal(userMessage.runState, 'idle');
  }
  const room = controller.rooms.get('room-1');
  assert.equal(room.memberships.length, 5);
  assert.deepEqual(room.seedLeaderIds, ['leader']);
  assert.deepEqual(room.runs.map(run => [run.memberId, run.status]), [['leader', 'creating']]);
});

test('restores Room, run, and message id watermarks from the hydrated registry', () => {
  let hydrated = createRoom({
    id: 'room-9', title: 'Hydrated',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
    items: [{
      kind: 'message', itemId: 'message-20', messageId: 'message-21', sequence: 1,
      source: 'agent-loop',
      author: {
        participantId: 'user', role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: 'Old' } }],
      reactions: [], timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'delivered', runState: 'idle', ariaLive: 'off', actions: [],
    }],
    timelineSequence: 1,
  });
  hydrated = addRoomRun(hydrated, {
    runId: 'run-12', memberId: 'leader', title: 'Lead', status: 'creating',
  });
  const controller = new ChatroomConversationController([hydrated]);
  controller.createSource({
    ...binding, bindingId: 'binding-hydrated-ids', routeSelection: { scope: 'room-or-new' },
  });
  const intent = controller.handle({
    binding: { bindingId: 'binding-hydrated-ids', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload: 'New',
  });
  assert.equal(intent.roomId, 'room-10');
  assert.equal(intent.userItemId, 'message-22');
  assert.equal(intent.deliveries[0].runId, 'run-13');
  const created = controller.rooms.get('room-10');
  assert.equal(created.items[0].messageId, 'message-23');
  assert.equal(new Set(controller.rooms.snapshot().map(room => room.id)).size, 2);
});

test('atomically creates one run per ambient leader on the first message', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    seedLeaderIds: ['leader', 'reviewer'],
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => ({
      ...member, role: 'leader', attentionPolicy: 'ambient', reportsToMemberId: undefined,
    })),
  };
  const controller = new ChatroomConversationController([], configuration);
  controller.createSource({ ...binding, bindingId: 'binding-multi-leader' });
  const intent = controller.handle({
    binding: { bindingId: 'binding-multi-leader', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload: 'Hello leaders',
  });

  assert.deepEqual(intent.deliveries.map(delivery => delivery.memberId), ['leader', 'reviewer']);
  const room = controller.rooms.get('room-1');
  assert.deepEqual(room.seedLeaderIds, ['leader', 'reviewer']);
  assert.deepEqual(room.runs.map(run => run.memberId), ['leader', 'reviewer']);
  assert.deepEqual(room.items.map(item => item.sequence), [3]);
});

test('appends a later Host-generated submit to the selected Room without creating another Room', async () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({
    id: 'review', title: 'Review',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
  }));
  const source = controller.createSource({
    ...binding,
    bindingId: 'binding-existing',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'review' },
  });
  const intent = controller.handle({
    binding: { bindingId: 'binding-existing', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload: 'Continue',
  });

  assert.deepEqual(intent, {
    kind: 'send-message', roomId: 'review', roomCreated: false,
    deliveries: [{ memberId: 'leader', runId: 'run-1', runCreated: true, reason: 'ambient' }],
    userItemId: 'message-1',
    bindingId: 'binding-existing', generation: 'owner-1', dispatchText: 'Continue',
  });
  assert.equal(controller.rooms.snapshot().length, 1);
  const snapshot = await source.snapshot();
  assert.equal(snapshot.items.length, 2);
  const continued = snapshot.items.find(item => item.kind === 'message');
  assert.equal(continued.kind, 'message');
  assert.equal(continued.body[0].text.fallback, 'Continue');
  assert.equal(controller.rooms.get('review').runs[0].presence.state, 'creating');
  assert.equal(
    controller.rooms.get('review').runs[0].presence.eventKey,
    'member-presence.6.leader.6.leader.5.run-1',
  );
});

test('routes @member to a reusable or lazy-created member run and @member/run exactly', async () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({ id: 'team', title: 'Team' }));
  controller.createSource({
    ...binding,
    bindingId: 'binding-targets',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'team' },
  });
  const command = submitPayload => controller.handle({
    binding: { bindingId: 'binding-targets', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload,
  });

  const member = command('@reviewer Inspect this');
  assert.deepEqual({
    kind: member.kind, deliveries: member.deliveries, dispatchText: member.dispatchText,
  }, {
    kind: 'send-message', deliveries: [
      { memberId: 'reviewer', runId: 'run-1', runCreated: true, reason: 'mention' },
    ], dispatchText: 'Inspect this',
  });
  const exact = command('@reviewer/run-1 Continue exactly');
  assert.deepEqual({
    deliveries: exact.deliveries, dispatchText: exact.dispatchText,
  }, {
    deliveries: [
      { memberId: 'reviewer', runId: 'run-1', runCreated: false, reason: 'mention' },
    ], dispatchText: 'Continue exactly',
  });
  assert.equal(controller.rooms.get('team').runs.length, 1);
});

test('returns explicit target errors without creating a run or public message', () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({ id: 'team', title: 'Team' }));
  controller.createSource({
    ...binding,
    bindingId: 'binding-errors',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'team' },
  });
  const intent = controller.handle({
    binding: { bindingId: 'binding-errors', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT }, submitPayload: '@missing Hello',
  });

  assert.deepEqual(intent, { kind: 'target-error', roomId: 'team', code: 'missing', mention: '@missing' });
  assert.deepEqual(controller.rooms.get('team').runs, []);
  assert.equal(controller.rooms.get('team').items.length, 1);
  assert.match(controller.rooms.get('team').items[0].label.fallback, /@missing/);
});
