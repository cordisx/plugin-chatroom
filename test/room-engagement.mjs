import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  acknowledgeBehaviorForMember,
  parseChatroomAgentConfiguration,
} from '../dist/agent-definition.js';
import {
  acceptRoomRunPresence,
  beginRoomRunPresence,
  claimRoomAcknowledgementDispatch,
  completeRoomAcknowledgement,
  createStoredRoomRunDetailsUrl,
  failRoomAcknowledgement,
  failRoomRunPresence,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../dist/room-engagement.js';
import {
  acceptRoomDelivery,
  canonicalRoomDeliveryOperation,
  closeRoomDelivery,
  hydrateRoomDeliveries,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  prepareRoomOutboxDelivery,
  requireRoomDeliveryAttention,
  requireRoomDeliveryStageAttention,
  roomDeliveryCausation,
} from '../dist/room-delivery.js';
import { projectAgentLoopEvent } from '../dist/agent-loop-projection.js';
import { createRoomConversationModel } from '../dist/conversation-model.js';
import {
  addRoomRun,
  closeRoomRun,
  createChatroomOpaqueId,
  createRoom,
  expandRoomMemberships,
} from '../dist/room.js';
import {
  CHATROOM_ROOM_REGISTRY_CONTRACT,
  CHATROOM_ROOM_REGISTRY_DOCUMENT_ID,
  ChatroomRoomStoreError,
  DurableChatroomRoomStore,
} from '../dist/room-store.js';

const definitionFor = memberId => CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
  .find(member => member.memberId === memberId).definition;

const taskBinding = (number, memberId = 'leader', generation = 1) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v2',
  schemaVersion: 2,
  binding: { bindingId: `Opaque:Binding-${number}`, generation },
  definition: definitionFor(memberId),
  task: `Opaque:Task-${number}`,
  state: 'active',
});

function roomWithRuns() {
  let room = createRoom({ id: 'room-1', title: 'Room' });
  room = addRoomRun(room, { runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating' });
  room = addRoomRun(room, { runId: 'review-run', memberId: 'reviewer', title: 'Review', status: 'creating' });
  return room;
}

function outboxFor(room, input) {
  return prepareRoomOutboxDelivery(room, {
    deliveryId: input.deliveryId,
    userItemId: input.userItemId,
    memberId: input.memberId,
    runId: input.runId,
    createOperationId: input.createOperationId,
    sendOperationId: input.sendOperationId,
  });
}

function ownerDocumentsFixture(initial) {
  let snapshot = initial;
  const listeners = new Set();
  const publish = result => { for (const listener of listeners) listener(result); };
  const client = {
    async load(documentId) {
      assert.equal(documentId, CHATROOM_ROOM_REGISTRY_DOCUMENT_ID);
      return snapshot === undefined ? { status: 'missing', revision: 0 } : { status: 'loaded', snapshot };
    },
    async transaction(command) {
      assert.equal(command.contract, 'cordisx.owner-documents/v1');
      assert.equal(command.documentId, CHATROOM_ROOM_REGISTRY_DOCUMENT_ID);
      const actualRevision = snapshot?.revision ?? 0;
      if (command.expectedRevision !== actualRevision) return { status: 'conflict', actualRevision };
      snapshot = {
        contract: 'cordisx.owner-documents/v1', revision: actualRevision + 1,
        schemaVersion: command.schemaVersion,
        value: JSON.parse(JSON.stringify(command.value)),
      };
      const accepted = { status: 'accepted', snapshot };
      publish({ status: 'loaded', snapshot });
      return accepted;
    },
    async replace(command) { return await this.transaction(command); },
    subscribe(documentId, listener) {
      assert.equal(documentId, CHATROOM_ROOM_REGISTRY_DOCUMENT_ID);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    snapshot: () => snapshot,
    publish,
    replaceWithoutPublish(value) {
      const revision = (snapshot?.revision ?? 0) + 1;
      snapshot = {
        contract: 'cordisx.owner-documents/v1', revision, schemaVersion: 1, value,
      };
      return snapshot;
    },
  };
}

test('resolves built-in, Agent defaults, and per-member acknowledgement overrides without prompt injection', () => {
  const parsed = parseChatroomAgentConfiguration({
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: {
      mode: 'message', messageTemplate: '{member} is checking', failedReaction: '🟥',
    },
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => member.memberId === 'reviewer'
      ? { ...member, acknowledge: { mode: 'none' } }
      : member),
  });

  assert.deepEqual(acknowledgeBehaviorForMember(parsed, 'leader'), {
    mode: 'message', pendingReaction: '👀', completedReaction: '✅', failedReaction: '🟥',
    messageTemplate: '{member} is checking',
  });
  assert.equal(acknowledgeBehaviorForMember(parsed, 'reviewer').mode, 'none');
  assert.equal(JSON.stringify(parsed.definitions).includes('acknowledge'), false);
  assert.equal(Object.isFrozen(parsed.acknowledge), true);
  assert.equal(Object.isFrozen(parsed.members[1].acknowledge), true);
  assert.throws(() => parseChatroomAgentConfiguration({
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION, acknowledge: { mode: 'typing' },
  }), /mode is unsupported/);
});

test('does not synthesize member speech after accepted create, rebind, or reload', async () => {
  let room = createRoom({
    ...roomWithRuns(),
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      { id: 'leader', name: 'Lead', kind: 'agent' },
    ],
    items: [{
      kind: 'message', itemId: 'user-first', messageId: 'user-first', sequence: 3,
      source: 'agent-loop',
      author: {
        participantId: 'user', role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: 'Help' } }],
      reactions: [], timestamp: '2026-08-31T00:00:00.000Z', deliveryState: 'sent',
      runState: 'running', ariaLive: 'off', actions: [],
    }],
    timelineSequence: 3,
  });
  const firstBinding = taskBinding(83);
  const details = createStoredRoomRunDetailsUrl({ url: 'app:task/lead-stable', target: 'host' });
  room = acceptRoomRunPresence(room, 'lead-run', firstBinding, details);
  assert.equal(acceptRoomRunPresence(room, 'lead-run', firstBinding, details), room);
  assert.equal(createRoomConversationModel(room).items.some(item => item.kind === 'member-presence'
    && item.runId === 'lead-run'), false);
  assert.equal(createRoomConversationModel(room).items.some(item => item.kind === 'message'
    && item.author.role === 'agent'), false);

  room = beginRoomRunPresence(room, 'lead-run', { replacement: true });
  room = acceptRoomRunPresence(room, 'lead-run', taskBinding(84, 'leader', 2),
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead-rebound', target: 'host' }));
  assert.equal(createRoomConversationModel(room).items.some(item => item.kind === 'message'
    && item.author.role === 'agent'), false);

  const perMessage = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-first', memberId: 'leader', runId: 'lead-run',
  });
  room = perMessage.room;
  assert.equal(room.acknowledgements.length, 1);
  assert.equal(room.acknowledgements[0].presentation.kind, 'reaction');

  const owner = ownerDocumentsFixture();
  const first = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  await first.upsert(room);
  first.dispose();
  const persisted = owner.snapshot().value;
  owner.replaceWithoutPublish({
    ...persisted,
    rooms: persisted.rooms.map(saved => ({
      ...saved,
      memberships: saved.memberships.map(member => ({
        ...member, engagement: { joinMessageTemplate: 'legacy join speech' },
      })),
      joinAcknowledgements: [{
        acknowledgementKey: 'legacy-join', participantId: 'leader', memberId: 'leader',
        runId: 'lead-run', sequence: 1, timestamp: '2026-08-31T00:00:01.000Z',
        source: 'chatroom-acknowledgement', text: 'legacy join speech',
      }],
    })),
  });
  const reopened = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const hydrated = reopened.rooms.get(room.id);
  assert.equal(hydrated.runs[0].presence.state, 'ready');
  assert.equal('joinAcknowledgements' in hydrated, false);
  assert.equal('engagement' in hydrated.memberships[0], false);
  assert.equal(createRoomConversationModel(hydrated).items.some(item => item.kind === 'message'
    && item.author.role === 'agent'), false);
  const projected = projectAgentLoopEvent(hydrated, 'lead-run', {
    $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
    eventId: 'event-real-reply', binding: hydrated.runs[0].taskBinding.binding, sequence: 0,
    occurredAt: '2026-08-31T00:00:06.000Z', type: 'message',
    message: { messageId: 'provider-reply', role: 'assistant', purpose: 'conversation', content: [{ kind: 'text', text: 'Done' }] },
  }).room;
  const model = createRoomConversationModel(projected);
  const user = model.items.find(item => item.kind === 'message' && item.author.role === 'human');
  assert.deepEqual(user.reactions.map(reaction => [reaction.actorParticipantId, reaction.state]),
    [['leader', 'pending']]);
  assert.deepEqual(model.items.filter(item => item.kind === 'message' && item.author.role === 'agent')
    .map(item => [item.source, item.body[0].text.fallback]), [['agent-loop', 'Done']]);
  assert.equal(JSON.stringify(model).includes('我来看看，稍等'), false);
  reopened.dispose();
});

test('updates one stable presence lifecycle and requires binding plus details URL before ready', () => {
  let room = roomWithRuns();
  const initial = room.runs[0].presence;
  assert.deepEqual(initial, {
    eventKey: 'member-presence.6.leader.6.leader.8.lead-run',
    participantId: 'leader', memberId: 'leader', runId: 'lead-run',
    sequence: 1, state: 'creating', attempt: 1,
  });
  assert.throws(
    () => createStoredRoomRunDetailsUrl({ url: '', target: 'host' }),
    /requires a non-empty details URL/,
  );

  const binding1 = taskBinding(1);
  const details1 = createStoredRoomRunDetailsUrl({ url: 'app:task/one', target: 'host' });
  room = acceptRoomRunPresence(room, 'lead-run', binding1, details1);
  assert.equal(room.runs[0].presence.eventKey, initial.eventKey);
  assert.equal(room.runs[0].presence.state, 'ready');
  assert.deepEqual(room.runs[0].detailsUrl, details1);
  assert.equal(acceptRoomRunPresence(room, 'lead-run', binding1, details1), room);

  room = beginRoomRunPresence(room, 'lead-run', { replacement: true });
  assert.deepEqual(room.runs[0].presence, {
    eventKey: initial.eventKey, participantId: 'leader', memberId: 'leader', runId: 'lead-run',
    sequence: 1, state: 'creating', attempt: 2,
  });
  const binding2 = taskBinding(2, 'leader', 2);
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    binding2,
    createStoredRoomRunDetailsUrl({ url: 'codex://task/two', target: 'external' }),
  );
  assert.equal(room.runs[0].taskBinding.binding.generation, 2);
  assert.equal(room.runs[0].detailsUrl.url, 'codex://task/two');
  assert.equal(room.runs[0].presence.eventKey, initial.eventKey);

  const closed = closeRoomRun(room, 'lead-run', binding2.binding);
  assert.equal(closed.runs[0].taskBinding.state, 'closed');
  assert.equal(closed.runs[0].detailsUrl.url, 'codex://task/two');
});

test('keeps failed presence diagnosable and retries in place', () => {
  let room = roomWithRuns();
  room = failRoomRunPresence(room, 'review-run', { code: 'provider-unavailable', retryable: true });
  assert.deepEqual(room.runs[1].presence, {
    eventKey: 'member-presence.8.reviewer.8.reviewer.10.review-run',
    participantId: 'reviewer', memberId: 'reviewer', runId: 'review-run',
    sequence: 2, state: 'failed', attempt: 1,
    failure: { code: 'provider-unavailable', retryable: true },
  });
  assert.deepEqual(createRoomConversationModel(room).items
    .filter(item => item.kind === 'member-presence' && item.runId === 'review-run')
    .map(item => [item.state, item.retryable]), [['failed', true]]);
  const failed = room;
  assert.equal(failRoomRunPresence(room, 'review-run', { code: 'provider-unavailable', retryable: true }), failed);
  room = beginRoomRunPresence(room, 'review-run');
  assert.deepEqual(room.runs[1].presence, {
    eventKey: 'member-presence.8.reviewer.8.reviewer.10.review-run',
    participantId: 'reviewer', memberId: 'reviewer', runId: 'review-run',
    sequence: 2, state: 'creating', attempt: 2,
  });
});

test('replaces one reaction acknowledgement across pending, completed, and failed states', () => {
  let room = roomWithRuns();
  const prepared = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-1', memberId: 'leader', runId: 'lead-run',
  });
  room = prepared.room;
  const key = prepared.acknowledgement.acknowledgementKey;
  assert.equal(prepared.created, true);
  assert.deepEqual(prepared.acknowledgement.presentation, {
    kind: 'reaction', source: 'chatroom-acknowledgement',
    reactionId: createChatroomOpaqueId('reaction', key), actorParticipantId: 'leader',
    value: { kind: 'emoji', emoji: '👀' }, state: 'pending',
  });

  room = completeRoomAcknowledgement(room, key);
  assert.equal(room.acknowledgements.length, 1);
  assert.deepEqual(room.acknowledgements[0].presentation.value, { kind: 'emoji', emoji: '✅' });
  assert.equal(room.acknowledgements[0].presentation.state, 'completed');
  assert.equal(completeRoomAcknowledgement(room, key), room);
  room = failRoomAcknowledgement(room, key, 'agent-failed');
  assert.equal(room.acknowledgements.length, 1);
  assert.deepEqual(room.acknowledgements[0].presentation.value, { kind: 'emoji', emoji: '⚠️' });
  assert.equal(room.acknowledgements[0].presentation.state, 'failed');
  assert.equal(room.acknowledgements[0].failureCode, 'agent-failed');
});

test('projects every Shell v2 surfaced Room identity as a formal opaque ID', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => member.memberId === 'reviewer'
      ? { ...member, acknowledge: { mode: 'message', messageTemplate: '{member} checking' } }
      : member),
  };
  let room = createRoom({
    ...roomWithRuns(),
    participants: [
      { id: 'user.primary', name: 'You', kind: 'human' },
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
    items: [{
      kind: 'message', itemId: 'user-item.1', messageId: 'user-message.1', sequence: 3,
      source: 'agent-loop',
      author: {
        participantId: 'user.primary', role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{
        kind: 'text',
        text: { namespace: 'chatroom', key: 'message.user', fallback: 'Please review' },
      }],
      reactions: [], timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'delivered', runState: 'idle', ariaLive: 'off', actions: [],
    }],
    timelineSequence: 3,
  });
  room = acceptRoomRunPresence(
    room, 'lead-run', taskBinding(31),
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead', target: 'host' }),
  );
  room = acceptRoomRunPresence(
    room, 'review-run', taskBinding(32, 'reviewer'),
    createStoredRoomRunDetailsUrl({ url: 'codex://task/review', target: 'external' }),
  );
  for (const [memberId, runId] of [['leader', 'lead-run'], ['reviewer', 'review-run']]) {
    const prepared = prepareRoomAcknowledgement(room, configuration, {
      userItemId: 'user-item.1', memberId, runId,
    });
    room = markRoomAcknowledgementSent(prepared.room, prepared.acknowledgement.acknowledgementKey);
  }
  const leadBinding = room.runs[0].taskBinding;
  room = projectAgentLoopEvent(room, 'lead-run', {
    $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
    eventId: 'event-opaque-1', binding: leadBinding.binding, sequence: 0,
    occurredAt: '2026-08-31T00:00:01.000Z', type: 'message',
    message: {
      messageId: 'provider-message-1', role: 'assistant', purpose: 'conversation',
      content: [{ kind: 'text', text: 'Reviewed' }],
    },
  }).room;

  const model = createRoomConversationModel(room);
  const identities = [['roomId', model.selection.roomId]];
  for (const participant of model.selection.participants) {
    identities.push(['participantId', participant.participantId]);
  }
  for (const run of model.selection.activeRuns) {
    identities.push(['activeRun participantId', run.participantId]);
    identities.push(['activeRun memberId', run.memberId]);
    identities.push(['activeRun runId', run.runId]);
  }
  for (const item of model.items) {
    identities.push(['itemId', item.itemId]);
    if (item.kind === 'member-presence') {
      identities.push(['presence participantId', item.participantId]);
      identities.push(['presence memberId', item.memberId]);
      identities.push(['presence runId', item.runId]);
    }
    if (item.kind === 'message') {
      identities.push(['messageId', item.messageId]);
      identities.push(['message author participantId', item.author.participantId]);
      for (const reaction of item.reactions) {
        identities.push(['reactionId', reaction.reactionId]);
        identities.push(['reaction actorParticipantId', reaction.actorParticipantId]);
      }
    }
  }
  assert.equal(identities.some(([label]) => label === 'reactionId'), true);
  assert.equal(model.items.some(item => item.kind === 'message'
    && item.source === 'chatroom-acknowledgement'), true);
  assert.equal(model.items.some(item => item.kind === 'message'
    && item.source === 'agent-loop' && item.author.participantId === 'leader'), true);
  for (const [label, value] of identities) {
    assert.match(value, /^[A-Za-z0-9._~-]+$/, label);
    assert.ok(value.length <= 512, `${label} exceeds the formal maximum`);
  }
});

test('AgentLoop terminal acknowledgement updates never reverse an accepted Chatroom effect dispatch', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-terminal', memberId: 'leader', runId: 'lead-run',
  });
  const acceptedEffect = markRoomAcknowledgementSent(
    prepared.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  const completed = completeRoomAcknowledgement(
    acceptedEffect,
    prepared.acknowledgement.acknowledgementKey,
  );
  assert.equal(completed.acknowledgements[0].dispatchState, 'accepted');
  const failed = failRoomAcknowledgement(
    completed,
    prepared.acknowledgement.acknowledgementKey,
    'turn-failed',
  );
  assert.equal(failed.acknowledgements[0].state, 'failed');
  assert.equal(failed.acknowledgements[0].presentation.state, 'failed');
  assert.equal(failed.acknowledgements[0].dispatchState, 'accepted');
});

test('persists canned-message authors per recipient and never adds a completion presentation', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: { mode: 'message', messageTemplate: '{member}: I’ll check' },
  };
  let room = roomWithRuns();
  const lead = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-shared', memberId: 'leader', runId: 'lead-run',
  });
  room = lead.room;
  const reviewer = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-shared', memberId: 'reviewer', runId: 'review-run',
  });
  room = reviewer.room;

  assert.notEqual(lead.acknowledgement.acknowledgementKey, reviewer.acknowledgement.acknowledgementKey);
  assert.deepEqual(room.acknowledgements.map(item => [
    item.memberId, item.presentation.authorMemberId, item.presentation.text,
  ]), [
    ['leader', 'leader', 'Lead: I’ll check'],
    ['reviewer', 'reviewer', 'Reviewer: I’ll check'],
  ]);
  const beforePresentation = room.acknowledgements[1].presentation;
  room = completeRoomAcknowledgement(room, reviewer.acknowledgement.acknowledgementKey);
  assert.equal(room.acknowledgements.length, 2);
  assert.deepEqual(room.acknowledgements[1].presentation, beforePresentation);
});

test('freezes and correlates participant/member/run as three distinct identities', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member => ({
      ...member, participantId: `participant-${member.memberId}`,
    })),
  };
  let room = createRoom({
    id: 'distinct-identities', title: 'Distinct',
    memberships: expandRoomMemberships(configuration),
  });
  room = addRoomRun(room, { runId: 'lead-distinct-run', memberId: 'leader', title: 'Lead', status: 'creating' });
  const prepared = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-distinct', memberId: 'leader', runId: 'lead-distinct-run',
  });
  const acknowledgement = prepared.acknowledgement;

  assert.equal(prepared.room.memberships[0].participantId, 'participant-leader');
  assert.deepEqual([
    prepared.room.runs[0].presence.participantId,
    prepared.room.runs[0].presence.memberId,
    prepared.room.runs[0].presence.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
  assert.deepEqual([
    acknowledgement.participantId, acknowledgement.memberId, acknowledgement.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
  assert.equal(acknowledgement.presentation.actorParticipantId, 'participant-leader');
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'distinct-delivery', userItemId: 'user-distinct', memberId: 'leader', runId: 'lead-distinct-run',
    createOperationId: 'distinct-create', sendOperationId: 'distinct-send',
  });
  assert.deepEqual([
    aggregate.delivery.participantId, aggregate.delivery.memberId, aggregate.delivery.runId,
  ], ['participant-leader', 'leader', 'lead-distinct-run']);
});

test('rehydrates stable acknowledgement correlation and prevents duplicate claim/effects', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: { mode: 'none' },
  };
  let room = roomWithRuns();
  const prepared = prepareRoomAcknowledgement(room, configuration, {
    userItemId: 'user-reload', memberId: 'leader', runId: 'lead-run',
  });
  room = prepared.room;
  const claimed = claimRoomAcknowledgementDispatch(room, prepared.acknowledgement.acknowledgementKey);
  assert.equal(claimed.claimed, true);

  const reloaded = createRoom(JSON.parse(JSON.stringify(claimed.room)));
  const duplicate = prepareRoomAcknowledgement(reloaded, configuration, {
    userItemId: 'user-reload', memberId: 'leader', runId: 'lead-run',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.room.acknowledgements.length, 1);
  assert.deepEqual(duplicate.acknowledgement.presentation, {
    kind: 'none', source: 'chatroom-acknowledgement',
  });
  assert.deepEqual(claimRoomAcknowledgementDispatch(duplicate.room, duplicate.acknowledgement.acknowledgementKey), {
    room: duplicate.room, claimed: false,
  });
});

test('rehydrates presence and acknowledgement through the owner-scoped registry document', async () => {
  const owner = ownerDocumentsFixture();
  const first = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns();
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    taskBinding(8),
    createStoredRoomRunDetailsUrl({ url: 'app:task/eight', target: 'host' }),
  );
  const prepared = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-durable', memberId: 'leader', runId: 'lead-run',
  });
  const claimed = claimRoomAcknowledgementDispatch(
    prepared.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  await first.upsert(claimed.room);

  const reloaded = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const snapshot = reloaded.rooms.get('room-1');
  assert.equal(snapshot.runs[0].presence.state, 'ready');
  assert.equal(snapshot.runs[0].detailsUrl.url, 'app:task/eight');
  assert.equal(snapshot.acknowledgements[0].dispatchState, 'sending');
  assert.equal(prepareRoomAcknowledgement(snapshot, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-durable', memberId: 'leader', runId: 'lead-run',
  }).created, false);
  assert.equal(owner.snapshot().value.contract, CHATROOM_ROOM_REGISTRY_CONTRACT);
  assert.equal(owner.snapshot().value.rooms.length, 1);
  first.dispose();
  reloaded.dispose();
});

test('subscribes whole-registry replacements and fails closed on CAS conflict and unavailable state', async () => {
  const owner = ownerDocumentsFixture();
  const store = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let replacements = 0;
  store.rooms.subscribe(() => { replacements += 1; });
  await store.upsert(createRoom({ id: 'room-first', title: 'First' }));
  assert.equal(replacements, 1, 'accepted transaction and its subscription echo apply once');

  const replacement = createRoom({ id: 'room-external', title: 'External' });
  const external = owner.replaceWithoutPublish({
    contract: CHATROOM_ROOM_REGISTRY_CONTRACT,
    rooms: [replacement],
  });
  await assert.rejects(
    store.upsert(createRoom({ id: 'room-local', title: 'Local' })),
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict' && error.recoverable,
  );

  owner.publish({ status: 'loaded', snapshot: external });
  assert.deepEqual(store.rooms.snapshot().map(room => room.id), ['room-external']);
  assert.equal(replacements, 3);
  owner.publish({ status: 'loaded', snapshot: external });
  assert.equal(replacements, 3, 'same-revision full snapshot is idempotent');
  owner.publish({
    status: 'unavailable', code: 'quota-exceeded', diagnostic: 'quota', recoverable: true,
  });
  await assert.rejects(
    store.upsert(createRoom({ id: 'room-blocked', title: 'Blocked' })),
    error => error instanceof ChatroomRoomStoreError && error.code === 'quota-exceeded',
  );
  assert.deepEqual(store.rooms.snapshot().map(room => room.id), ['room-external']);
  store.dispose();
});

test('owns Room registry schema migration and never overwrites unsupported future data', async () => {
  const owner = ownerDocumentsFixture({
    contract: 'cordisx.owner-documents/v1', revision: 7, schemaVersion: 2,
    value: { contract: 'cordisx.chatroom-room-registry/v2', rooms: [] },
  });
  await assert.rejects(
    DurableChatroomRoomStore.openOwnerDocuments(owner.client),
    error => error instanceof ChatroomRoomStoreError
      && error.code === 'unsupported-document-schema'
      && error.recoverable === false,
  );
  assert.equal(owner.snapshot().revision, 7);
});

test('CAS-plans one durable operation id with a canonical hash and rejects divergent reuse', async () => {
  assert.equal(
    canonicalRoomDeliveryOperation({ kind: 'create', payload: null }),
    'sha256.be2a07529a3f7f2a0220eca949ac7b946712dfbd885ae138218d4ed88fa199bc',
  );
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-operation-1', memberId: 'leader', runId: 'lead-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-1', userItemId: 'user-operation-1', memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-operation-1', sendOperationId: 'operation-1',
  });
  assert.throws(() => planRoomDelivery(aggregate.room, {
    deliveryId: 'delivery-1', userItemId: 'user-operation-1', participantId: 'leader',
    operationId: 'operation-1', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: {
      kind: 'send', acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { z: 1, a: ['same'] },
    },
  }), /accepted acknowledgement effect/);
  const room = markRoomAcknowledgementSent(
    aggregate.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  assert.deepEqual([
    aggregate.delivery.deliveryId,
    aggregate.delivery.userItemId,
    aggregate.delivery.participantId,
    aggregate.delivery.memberId,
    aggregate.delivery.runId,
  ], ['delivery-1', 'user-operation-1', 'leader', 'leader', 'lead-run']);
  assert.deepEqual([
    aggregate.delivery.create.operationId,
    aggregate.delivery.acknowledge.state,
    aggregate.delivery.send.operationId,
  ], ['create-operation-1', 'pending', 'operation-1']);
  const input = {
    deliveryId: 'delivery-1', userItemId: 'user-operation-1', participantId: 'leader',
    operationId: 'operation-1', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: {
      kind: 'send', acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { z: 1, a: ['same'] },
    },
  };
  const planned = planRoomDelivery(room, input);
  const replay = planRoomDelivery(planned.room, {
    ...input, operation: { ...input.operation, payload: { a: ['same'], z: 1 } },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.room, planned.room);

  const store = DurableChatroomRoomStore.memory([room]);
  const initialDocument = store.document(room.id);
  assert.equal(initialDocument.revision, 0);
  const committed = await store.compareAndSwap(initialDocument.revision, planned.room);
  assert.equal(committed.revision, 1);
  assert.equal(committed.room.deliveries[0].state, 'planned');
  assert.equal(committed.room.outbox[0].send.state, 'planned');
  await assert.rejects(
    store.compareAndSwap(initialDocument.revision, planned.room),
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict',
    'stale document revision cannot overwrite the complete Room snapshot',
  );

  const conflicted = planRoomDelivery(planned.room, {
    ...input, operation: { ...input.operation, payload: { a: ['different'], z: 1 } },
  });
  assert.equal(conflicted.room.deliveries.length, 1);
  assert.equal(conflicted.delivery.operationId, 'operation-1');
  assert.deepEqual(conflicted.delivery.attention, {
    code: 'operation-conflict',
    diagnostic: 'The same durable operation id was reused with different structural input.',
  });
});

test('accepted create persists binding and URL with disposition before presence is ready', () => {
  const acknowledged = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-create-1', memberId: 'leader', runId: 'lead-run',
  });
  const aggregate = outboxFor(acknowledged.room, {
    deliveryId: 'delivery-create-1', userItemId: 'user-create-1', memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-1', sendOperationId: 'send-after-create-1',
  });
  const room = aggregate.room;
  const planned = planRoomDelivery(room, {
    deliveryId: 'delivery-create-1', userItemId: 'user-create-1', participantId: 'leader',
    operationId: 'create-1', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'create' } },
  });
  assert.equal(requireRoomDeliveryStageAttention(planned.room, 'create-1', {
    outcome: 'denied', diagnostic: 'create capability denied',
  }).deliveries[0].attention.code, 'create-denied');
  const accepted = acceptRoomDelivery(planned.room, 'create-1', {
    kind: 'create', disposition: 'reconciled', firstObservedAt: '2026-08-31T00:00:01.000Z',
    binding: taskBinding(30),
    detailsUrl: createStoredRoomRunDetailsUrl({ url: 'app:task/30', target: 'host' }),
  });

  assert.equal(accepted.deliveries[0].state, 'accepted');
  assert.equal(accepted.deliveries[0].acceptance.disposition, 'reconciled');
  assert.equal(accepted.runs[0].taskBinding.binding.bindingId, 'Opaque:Binding-30');
  assert.equal(accepted.runs[0].detailsUrl.url, 'app:task/30');
  assert.equal(accepted.runs[0].presence.state, 'ready');
  assert.equal(accepted.runs[0].status, 'active');
  assert.equal(createRoomConversationModel(accepted).items.some(item => item.kind === 'message'
    && item.author.role === 'agent'), false);
  assert.equal(accepted.outbox[0].create.state, 'accepted');
  assert.deepEqual(roomDeliveryCausation(accepted.deliveries[0]), { operationId: 'create-1' });
});

test('plans create only for first join and reuses an existing ready run without another create operation', () => {
  const firstAcknowledgement = prepareRoomAcknowledgement(
    roomWithRuns(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-first-join', memberId: 'leader', runId: 'lead-run' },
  );
  const first = outboxFor(firstAcknowledgement.room, {
    deliveryId: 'delivery-first-join', userItemId: 'user-first-join',
    memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-first-join', sendOperationId: 'send-first-join',
  });
  assert.deepEqual(first.delivery.create, {
    operationId: 'create-first-join', ownerDeliveryId: 'delivery-first-join', state: 'planned',
  });

  let readyRoom = acceptRoomRunPresence(
    first.room,
    'lead-run',
    taskBinding(31),
    createStoredRoomRunDetailsUrl({ url: 'app:task/31', target: 'host' }),
  );
  const replayedFirst = outboxFor(readyRoom, {
    deliveryId: 'delivery-first-join', userItemId: 'user-first-join',
    memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-first-join', sendOperationId: 'send-first-join',
  });
  assert.equal(replayedFirst.created, false, 'ready transition does not invalidate first-join replay');

  const nextAcknowledgement = prepareRoomAcknowledgement(
    replayedFirst.room,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-existing-run', memberId: 'leader', runId: 'lead-run' },
  );
  readyRoom = markRoomAcknowledgementSent(
    nextAcknowledgement.room,
    nextAcknowledgement.acknowledgement.acknowledgementKey,
  );
  const reused = outboxFor(readyRoom, {
    deliveryId: 'delivery-existing-run', userItemId: 'user-existing-run',
    memberId: 'leader', runId: 'lead-run', sendOperationId: 'send-existing-run',
  });
  assert.deepEqual(reused.delivery.create, { state: 'not-required' });
  assert.throws(() => outboxFor(readyRoom, {
    deliveryId: 'delivery-existing-run-with-create', userItemId: 'user-existing-run',
    memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-must-not-exist', sendOperationId: 'send-other',
  }), /must not plan another create operation/);
  assert.throws(() => planRoomDelivery(reused.room, {
    deliveryId: 'delivery-existing-run', userItemId: 'user-existing-run', participantId: 'leader',
    operationId: 'create-must-not-exist', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'must-not-run' } },
  }), /exact outbox participant\/member\/run operation/);
  const sent = planRoomDelivery(reused.room, {
    deliveryId: 'delivery-existing-run', userItemId: 'user-existing-run', participantId: 'leader',
    operationId: 'send-existing-run', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:01.000Z',
    operation: {
      kind: 'send', acknowledgementKey: nextAcknowledgement.acknowledgement.acknowledgementKey,
      payload: { text: 'reuse ready session' },
    },
  });
  assert.equal(sent.delivery.stage, 'send');
  assert.equal(sent.room.deliveries.some(item => item.deliveryId === 'delivery-existing-run'
    && item.stage === 'create'), false);
});

test('shares one pending create owner across two messages on the same run while sends remain independent', () => {
  const firstAcknowledgement = prepareRoomAcknowledgement(
    roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-pending-one', memberId: 'leader', runId: 'lead-run' },
  );
  const first = outboxFor(firstAcknowledgement.room, {
    deliveryId: 'delivery-pending-one', userItemId: 'user-pending-one',
    memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-shared', sendOperationId: 'send-one',
  });
  const secondAcknowledgement = prepareRoomAcknowledgement(
    first.room, CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-pending-two', memberId: 'leader', runId: 'lead-run' },
  );
  const second = outboxFor(secondAcknowledgement.room, {
    deliveryId: 'delivery-pending-two', userItemId: 'user-pending-two',
    memberId: 'leader', runId: 'lead-run', sendOperationId: 'send-two',
  });
  assert.deepEqual(second.room.outbox.map(item => item.create), [
    { operationId: 'create-shared', ownerDeliveryId: 'delivery-pending-one', state: 'planned' },
    { operationId: 'create-shared', ownerDeliveryId: 'delivery-pending-one', state: 'planned' },
  ]);
  assert.deepEqual(second.room.outbox.map(item => item.send.operationId), ['send-one', 'send-two']);
  assert.throws(() => outboxFor(secondAcknowledgement.room, {
    deliveryId: 'delivery-pending-conflict', userItemId: 'user-pending-two',
    memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-second-task', sendOperationId: 'send-conflict',
  }), /different pending create operation/);
  assert.throws(() => planRoomDelivery(second.room, {
    deliveryId: 'delivery-pending-two', userItemId: 'user-pending-two', participantId: 'leader',
    operationId: 'create-shared', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'must-use-owner' } },
  }), /exact outbox participant\/member\/run operation/);
  const planned = planRoomDelivery(second.room, {
    deliveryId: 'delivery-pending-one', userItemId: 'user-pending-one', participantId: 'leader',
    operationId: 'create-shared', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'one-task' } },
  });
  const accepted = acceptRoomDelivery(planned.room, 'create-shared', {
    kind: 'create', disposition: 'replayed', firstObservedAt: '2026-08-31T00:00:01.000Z',
    binding: taskBinding(32),
    detailsUrl: createStoredRoomRunDetailsUrl({ url: 'app:task/32', target: 'host' }),
  });
  assert.deepEqual(accepted.outbox.map(item => item.create.state), ['accepted', 'accepted']);
  assert.equal(accepted.runs[0].taskBinding.task, 'Opaque:Task-32');
});

test('requires accepted acknowledgement dispatch before send for reaction, message, and none modes', () => {
  const cases = [
    ['reaction', CHATROOM_DEFAULT_AGENT_CONFIGURATION],
    ['message', {
      ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      acknowledge: { mode: 'message', messageTemplate: '{member}: checking' },
    }],
    ['none', {
      ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      acknowledge: { mode: 'none' },
    }],
  ];
  for (const [mode, configuration] of cases) {
    const userItemId = `user-ack-gate-${mode}`;
    const prepared = prepareRoomAcknowledgement(roomWithRuns(), configuration, {
      userItemId, memberId: 'leader', runId: 'lead-run',
    });
    const aggregate = outboxFor(prepared.room, {
      deliveryId: `delivery-ack-gate-${mode}`, userItemId,
      memberId: 'leader', runId: 'lead-run',
      createOperationId: `create-ack-gate-${mode}`,
      sendOperationId: `send-ack-gate-${mode}`,
    });
    const sendInput = {
      deliveryId: `delivery-ack-gate-${mode}`, userItemId, participantId: 'leader',
      operationId: `send-ack-gate-${mode}`, memberId: 'leader', runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: {
        kind: 'send', acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
        payload: { text: `dispatch after ${mode} acknowledgement` },
      },
    };
    assert.throws(
      () => planRoomDelivery(aggregate.room, sendInput),
      /accepted acknowledgement effect/,
      `${mode} send must wait for Chatroom acknowledgement dispatch`,
    );
    const acknowledged = markRoomAcknowledgementSent(
      aggregate.room,
      prepared.acknowledgement.acknowledgementKey,
    );
    const stored = acknowledged.acknowledgements[0];
    assert.equal(stored.dispatchState, 'accepted');
    assert.equal(stored.state, 'pending', 'presentation lifecycle remains independent of dispatch');
    assert.equal(stored.presentation.kind,
      mode === 'message' ? 'canned-message' : mode);
    assert.equal(planRoomDelivery(acknowledged, sendInput).delivery.state, 'planned');
  }
});

test('keeps send messageId and turn exact and maps typed uncertainty to attention', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-send-1', memberId: 'reviewer', runId: 'review-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-send-1', userItemId: 'user-send-1', memberId: 'reviewer', runId: 'review-run',
    createOperationId: 'create-before-send-1', sendOperationId: 'send-1',
  });
  const room = markRoomAcknowledgementSent(
    aggregate.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  const planned = planRoomDelivery(room, {
    deliveryId: 'delivery-send-1', userItemId: 'user-send-1', participantId: 'reviewer',
    operationId: 'send-1', memberId: 'reviewer', runId: 'review-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: {
      kind: 'send', acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { text: 'review' },
    },
  });
  assert.equal('messageId' in planned.delivery.operation, false);
  assert.equal('turn' in planned.delivery.operation, false);
  assert.equal(planned.delivery.canonicalPayload.includes('messageId'), false);
  const accepted = acceptRoomDelivery(planned.room, 'send-1', {
    kind: 'send', disposition: 'executed', firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9', turn: '4',
  });
  assert.equal(accepted.deliveries[0].acceptance.messageId, 'message-9');
  assert.equal(accepted.deliveries[0].acceptance.turn, '4');
  const replayed = acceptRoomDelivery(accepted, 'send-1', {
    kind: 'send', disposition: 'replayed', firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9', turn: '4',
  });
  assert.equal(replayed.deliveries[0].acceptance.disposition, 'replayed');
  const mismatch = acceptRoomDelivery(replayed, 'send-1', {
    kind: 'send', disposition: 'executed', firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9', turn: '5',
  });
  assert.equal(mismatch.deliveries[0].attention.code, 'operation-conflict');
  const unavailable = requireRoomDeliveryAttention(
    planned.room, 'send-1', 'details-unavailable', 'Provider omitted its canonical details URL.',
  );
  assert.deepEqual(unavailable.deliveries[0].attention, {
    code: 'details-unavailable', diagnostic: 'Provider omitted its canonical details URL.',
  });
  assert.equal(requireRoomDeliveryStageAttention(planned.room, 'send-1', {
    outcome: 'unavailable', diagnostic: 'send capability unavailable',
  }).deliveries[0].attention.code, 'send-unavailable');
});

test('hydrates only same-id exact-payload reconciliation and expires closed recovery after 30 days', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-recover-1', memberId: 'leader', runId: 'lead-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-recover-1', userItemId: 'user-recover-1', memberId: 'leader', runId: 'lead-run',
    createOperationId: 'create-recover-1', sendOperationId: 'recover-1',
  });
  let room = markRoomAcknowledgementSent(
    aggregate.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  room = planRoomDelivery(room, {
    deliveryId: 'delivery-recover-1', userItemId: 'user-recover-1', participantId: 'leader',
    operationId: 'recover-1', memberId: 'leader', runId: 'lead-run',
    issuedAt: '2026-08-01T00:00:00.000Z',
    operation: {
      kind: 'send', acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { text: 'recover' },
    },
  }).room;
  room = markRoomDeliverySendingUnknown(room, 'recover-1');
  const recoverable = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z', durableApiAvailable: true,
  });
  assert.deepEqual(recoverable.reconciliations, [{
    operationId: 'recover-1',
    canonicalPayload: room.deliveries[0].canonicalPayload,
    operation: room.deliveries[0].operation,
  }]);
  assert.equal(hydrateRoomDeliveries(room, {
    now: '2027-12-31T00:00:00.000Z', durableApiAvailable: true,
  }).reconciliations.length, 1, 'consumer issuedAt never expires an unknown operation');

  const unavailable = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z', durableApiAvailable: false,
  });
  assert.equal(unavailable.reconciliations.length, 0);
  assert.equal(unavailable.room.deliveries[0].attention.code, 'reconciliation-required');
  const replaced = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z', durableApiAvailable: true, providerReplaced: true,
  });
  assert.equal(replaced.room.deliveries[0].attention.code, 'provider-replaced');

  const closed = closeRoomDelivery(room, 'recover-1', {
    closedAt: '2026-08-20T00:00:00.000Z', source: 'host',
  });
  assert.equal(hydrateRoomDeliveries(closed, {
    now: '2026-09-18T23:59:59.000Z', durableApiAvailable: true,
  }).reconciliations.length, 1);
  const expired = hydrateRoomDeliveries(closed, {
    now: '2026-09-20T00:00:00.001Z', durableApiAvailable: true,
  });
  assert.equal(expired.reconciliations.length, 0);
  assert.equal(expired.room.deliveries[0].attention.code, 'operation-expired');
  assert.match(expired.room.deliveries[0].attention.diagnostic, /30-day recovery window/);
});
