import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoomConversationModel } from '../dist/conversation-model.js';
import { ChatroomConversationController } from '../dist/conversation-source.js';
import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';

test('projects a delegated task as an explicit source-authored Room announcement', async () => {
  let room = createRoom({ id: 'delegation-room', title: 'Delegation' });
  room = addRoomRun(room, {
    runId: 'lead-run',
    memberId: 'leader',
    title: 'Lead',
    status: 'creating',
  });
  room = bindRoomRunSession(room, 'lead-run', 'cx-session.delegation.lead');
  const controller = new ChatroomConversationController([room]);

  const result = await controller.projectAgentSessionDelegation(
    {
      sessionId: 'cx-session.delegation.lead',
      roomId: room.id,
      runId: 'lead-run',
      memberId: 'leader',
      bindingId: 'binding',
      ownerGeneration: 'owner',
      generation: 'generation',
    },
    'delegation-operation',
    'reviewer',
    '最终链路验证',
  );

  assert.equal(result.status, 'accepted');
  const announcement = controller.rooms.get(room.id).items.find(item =>
    item.kind === 'message' && item.itemId === result.itemId
  );
  assert.equal(announcement.kind, 'message');
  assert.equal(announcement.author.displayName.fallback, 'Lead');
  assert.equal(announcement.body[0].text.fallback, '已向 @Reviewer 下发任务：最终链路验证。');
});

test('creates and projects a Room only from the first page-domain submit', async () => {
  const controller = new ChatroomConversationController();
  const intent = controller.submitMessage(undefined, 'bounded host text');
  assert.deepEqual(intent, {
    kind: 'send-message',
    roomId: 'room-1',
    roomCreated: true,
    deliveries: [{ memberId: 'leader', runId: 'run-1', runCreated: true, reason: 'ambient' }],
    userItemId: 'message-1',
    bindingId: 'chatroom-page',
    generation: 'chatroom-page',
    dispatchText: 'bounded host text',
  });
  assert.deepEqual(controller.takePendingIntents(), [
    intent,
  ]);
  const snapshot = createRoomConversationModel(controller.rooms.get(intent.roomId));
  assert.equal(snapshot.selection.kind, 'room');
  if (snapshot.selection.kind === 'room') {
    const lead = snapshot.selection.participants.find(participant => participant.participantId === 'leader');
    assert.deepEqual(lead?.avatar, {
      kind: 'asset',
      ref: 'oneworks-avatar:asset.red-fox.v1',
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
    assert.deepEqual(userMessage.author.displayName, {
      namespace: 'chatroom',
      key: 'participant.name',
      fallback: 'You',
    });
    assert.equal(userMessage.body[0].text.fallback, 'bounded host text');
    assert.equal(userMessage.deliveryState, 'pending');
    assert.equal(userMessage.runState, 'idle');
  }
  const room = controller.rooms.get('room-1');
  assert.equal(room.memberships.length, 5);
  assert.deepEqual(room.seedLeaderIds, ['leader']);
  assert.deepEqual(room.runs.map(run => [run.memberId, run.status]), [['leader', 'creating']]);
});

test('persists the first Room before route replacement and resolves a later ambient composer submit', async () => {
  const store = DurableChatroomRoomStore.memory();
  const firstController = new ChatroomConversationController(
    store.rooms,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    async room => {
      await store.upsert(room);
    },
  );
  const first = firstController.submitMessage(undefined, '3');
  assert.equal(first?.kind, 'send-message');
  if (first?.kind !== 'send-message') return;
  await firstController.persistComposerRoom(first.roomId);
  assert.equal(store.document(first.roomId)?.room.items.some(item => item.kind === 'message'), true);

  const secondController = new ChatroomConversationController(
    store.rooms,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    async room => {
      await store.upsert(room);
    },
  );
  const second = secondController.submitMessage(first.roomId, '3');
  assert.deepEqual(second?.kind, 'send-message');
  if (second?.kind === 'send-message') {
    assert.deepEqual(second.deliveries.map(delivery => delivery.reason), ['ambient']);
    assert.equal(second.dispatchText, '3');
  }
});

test('restores Room, run, and message id watermarks from the hydrated registry', () => {
  let hydrated = createRoom({
    id: 'room-9',
    title: 'Hydrated',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
    items: [{
      kind: 'message',
      itemId: 'message-20',
      messageId: 'message-21',
      sequence: 1,
      source: 'agent-loop',
      author: {
        participantId: 'user',
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: 'Old' } }],
      reactions: [],
      timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    }],
    timelineSequence: 1,
  });
  hydrated = addRoomRun(hydrated, {
    runId: 'run-12',
    memberId: 'leader',
    title: 'Lead',
    status: 'creating',
  });
  const controller = new ChatroomConversationController([hydrated]);
  const intent = controller.submitMessage(undefined, 'New');
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
      ...member,
      role: 'leader',
      attentionPolicy: 'ambient',
      reportsToMemberId: undefined,
    })),
  };
  const controller = new ChatroomConversationController([], configuration);
  const intent = controller.submitMessage(undefined, 'Hello leaders');

  assert.deepEqual(intent.deliveries.map(delivery => delivery.memberId), ['leader', 'reviewer']);
  const room = controller.rooms.get('room-1');
  assert.deepEqual(room.seedLeaderIds, ['leader', 'reviewer']);
  assert.deepEqual(room.runs.map(run => run.memberId), ['leader', 'reviewer']);
  assert.deepEqual(room.items.map(item => item.sequence), [3]);
});

test('appends a later page-domain submit to the selected Room without creating another Room', async () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({
    id: 'review',
    title: 'Review',
    participants: [{ id: 'user', name: 'You', kind: 'human' }],
  }));
  const intent = controller.submitMessage('review', 'Continue');

  assert.deepEqual(intent, {
    kind: 'send-message',
    roomId: 'review',
    roomCreated: false,
    deliveries: [{ memberId: 'leader', runId: 'run-1', runCreated: true, reason: 'ambient' }],
    userItemId: 'message-1',
    bindingId: 'chatroom-page',
    generation: 'chatroom-page',
    dispatchText: 'Continue',
  });
  assert.equal(controller.rooms.snapshot().length, 1);
  const snapshot = createRoomConversationModel(controller.rooms.get(intent.roomId));
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
  const command = submitPayload => controller.submitMessage('team', submitPayload);

  const member = command('@reviewer Inspect this');
  assert.deepEqual({
    kind: member.kind,
    deliveries: member.deliveries,
    dispatchText: member.dispatchText,
  }, {
    kind: 'send-message',
    deliveries: [
      { memberId: 'reviewer', runId: 'run-1', runCreated: true, reason: 'mention' },
    ],
    dispatchText: 'Inspect this',
  });
  const exact = command('@reviewer/run-1 Continue exactly');
  assert.deepEqual({
    deliveries: exact.deliveries,
    dispatchText: exact.dispatchText,
  }, {
    deliveries: [
      { memberId: 'reviewer', runId: 'run-1', runCreated: false, reason: 'mention' },
    ],
    dispatchText: 'Continue exactly',
  });
  assert.equal(controller.rooms.get('team').runs.length, 1);
});

test('returns explicit target errors without creating a run or public message', () => {
  const controller = new ChatroomConversationController();
  controller.rooms.upsert(createRoom({ id: 'team', title: 'Team' }));
  const intent = controller.submitMessage('team', '@missing Hello');

  assert.deepEqual(intent, { kind: 'target-error', roomId: 'team', code: 'missing', mention: '@missing' });
  assert.deepEqual(controller.rooms.get('team').runs, []);
  assert.equal(controller.rooms.get('team').items.length, 1);
  assert.match(controller.rooms.get('team').items[0].label.fallback, /@missing/);
});

test('classifies every invalid composer target before any public message is appended', () => {
  const noRecipientsConfiguration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => ({
      ...member,
      attentionPolicy: 'mention-only',
    })),
  };
  const cases = [
    { name: 'empty', configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION, payload: '', code: 'empty' },
    { name: 'no-recipients', configuration: noRecipientsConfiguration, payload: '3', code: 'no-recipients' },
    {
      name: 'missing',
      configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      payload: '@missing 3',
      code: 'missing',
      mention: '@missing',
    },
    {
      name: 'ambiguous',
      configuration: {
        ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => ({ ...member, label: 'Same' })),
      },
      payload: '@same 3',
      code: 'ambiguous',
      mention: '@same',
    },
    {
      name: 'empty-targeted-message',
      configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      payload: '@leader',
      code: 'empty-targeted-message',
      mention: '@leader',
    },
  ];
  for (const scenario of cases) {
    const controller = new ChatroomConversationController([], scenario.configuration);
    const intent = controller.submitMessage(undefined, scenario.payload);
    assert.equal(intent?.kind, 'target-error', scenario.name);
    if (intent?.kind !== 'target-error') continue;
    assert.equal(intent.code, scenario.code, scenario.name);
    assert.equal(intent.mention, scenario.mention, scenario.name);
    assert.equal(controller.rooms.snapshot().length, 0, scenario.name);
  }
});
