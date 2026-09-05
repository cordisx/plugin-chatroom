import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeBehaviorForMember,
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  parseChatroomAgentConfiguration,
} from '../dist/agent-definition.js';
import {
  acceptRoomDelivery,
  canonicalRoomDeliveryOperation,
  hydrateRoomDeliveries,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  prepareRoomOutboxDelivery,
  roomDeliveryCausation,
} from '../dist/room-delivery.js';
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
import { addRoomRun, createRoom } from '../dist/room.js';

const definitionFor = memberId =>
  CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
    .find(member => member.memberId === memberId).definition;

const taskBinding = (number, memberId = 'leader', generation = 1) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v2',
  schemaVersion: 2,
  binding: { bindingId: `Opaque:Binding-${number}`, generation },
  definition: definitionFor(memberId),
  task: `Opaque:Task-${number}`,
  state: 'active',
});

function roomWithRuns() {
  let room = createRoom({ id: 'room-1', title: 'Room' });
  room = addRoomRun(room, {
    runId: 'lead-run',
    memberId: 'leader',
    title: 'Lead',
    status: 'creating',
  });
  room = addRoomRun(room, {
    runId: 'review-run',
    memberId: 'reviewer',
    title: 'Review',
    status: 'creating',
  });
  return room;
}

test('keeps engagement configuration outside AgentDefinition prompts', () => {
  const parsed = parseChatroomAgentConfiguration({
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: {
      mode: 'message',
      messageTemplate: '{member} is checking',
      failedReaction: '🟥',
    },
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member =>
      member.memberId === 'reviewer'
        ? { ...member, acknowledge: { mode: 'none' } }
        : member
    ),
  });

  assert.deepEqual(acknowledgeBehaviorForMember(parsed, 'leader'), {
    mode: 'message',
    pendingReaction: '👀',
    completedReaction: '✅',
    failedReaction: '🟥',
    messageTemplate: '{member} is checking',
  });
  assert.equal(acknowledgeBehaviorForMember(parsed, 'reviewer').mode, 'none');
  assert.equal(JSON.stringify(parsed.definitions).includes('acknowledge'), false);
  assert.equal(Object.isFrozen(parsed.acknowledge), true);
});

test('updates one presence lifecycle and commits binding plus details URL before ready', () => {
  let room = roomWithRuns();
  const eventKey = room.runs[0].presence.eventKey;
  room = beginRoomRunPresence(room, 'lead-run', { state: 'inviting' });
  assert.equal(room.runs[0].presence.state, 'inviting');

  const firstBinding = taskBinding(1);
  const firstDetails = createStoredRoomRunDetailsUrl({
    url: 'app:task/one',
    target: 'host',
  });
  room = acceptRoomRunPresence(room, 'lead-run', firstBinding, firstDetails);
  assert.equal(room.runs[0].presence.eventKey, eventKey);
  assert.equal(room.runs[0].presence.state, 'ready');
  assert.deepEqual(room.runs[0].taskBinding, firstBinding);
  assert.deepEqual(room.runs[0].detailsUrl, firstDetails);
  assert.equal(acceptRoomRunPresence(room, 'lead-run', firstBinding, firstDetails), room);

  room = beginRoomRunPresence(room, 'lead-run', { replacement: true });
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    taskBinding(2, 'leader', 2),
    createStoredRoomRunDetailsUrl({ url: 'codex://task/two', target: 'external' }),
  );
  assert.equal(room.runs[0].presence.eventKey, eventKey);
  assert.equal(room.runs[0].taskBinding.binding.generation, 2);
  assert.equal(room.runs[0].agentLoopCursor, -1);

  const failed = failRoomRunPresence(room, 'review-run', {
    code: 'provider-unavailable',
    retryable: true,
  });
  assert.deepEqual(failed.runs[1].presence.failure, {
    code: 'provider-unavailable',
    retryable: true,
  });
  assert.equal(
    failRoomRunPresence(failed, 'review-run', {
      code: 'provider-unavailable',
      retryable: true,
    }),
    failed,
  );
});

test('persists one acknowledgement correlation and updates its reaction in place', () => {
  const prepared = prepareRoomAcknowledgement(
    roomWithRuns(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-1', memberId: 'leader', runId: 'lead-run' },
  );
  const key = prepared.acknowledgement.acknowledgementKey;
  assert.equal(prepared.created, true);
  assert.deepEqual(prepared.acknowledgement.presentation, {
    kind: 'reaction',
    source: 'chatroom-acknowledgement',
    reactionId: prepared.acknowledgement.presentation.reactionId,
    actorParticipantId: 'leader',
    value: { kind: 'emoji', emoji: '👀' },
    state: 'pending',
  });

  const duplicate = prepareRoomAcknowledgement(
    prepared.room,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-1', memberId: 'leader', runId: 'lead-run' },
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.room, prepared.room);

  const claimed = claimRoomAcknowledgementDispatch(prepared.room, key);
  assert.equal(claimed.claimed, true);
  assert.deepEqual(claimRoomAcknowledgementDispatch(claimed.room, key), {
    room: claimed.room,
    claimed: false,
  });
  const sent = markRoomAcknowledgementSent(claimed.room, key);
  const completed = completeRoomAcknowledgement(sent, key);
  assert.equal(completed.acknowledgements.length, 1);
  assert.deepEqual(completed.acknowledgements[0].presentation.value, {
    kind: 'emoji',
    emoji: '✅',
  });
  assert.equal(completed.acknowledgements[0].dispatchState, 'accepted');

  const failed = failRoomAcknowledgement(completed, key, 'agent-failed');
  assert.equal(failed.acknowledgements.length, 1);
  assert.equal(failed.acknowledgements[0].presentation.state, 'failed');
  assert.deepEqual(failed.acknowledgements[0].presentation.value, {
    kind: 'emoji',
    emoji: '⚠️',
  });
});

test('plans exact durable create/send operations and reconciles without minting a new id', () => {
  const acknowledgement = prepareRoomAcknowledgement(
    roomWithRuns(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-delivery', memberId: 'leader', runId: 'lead-run' },
  );
  const aggregate = prepareRoomOutboxDelivery(acknowledgement.room, {
    deliveryId: 'delivery-1',
    userItemId: 'user-delivery',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-1',
    sendOperationId: 'send-1',
  });
  const createOperation = {
    kind: 'create',
    payload: { target: { mode: 'create' }, definition: definitionFor('leader') },
  };
  const plannedCreate = planRoomDelivery(aggregate.room, {
    deliveryId: 'delivery-1',
    operationId: 'create-1',
    userItemId: 'user-delivery',
    participantId: 'leader',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: createOperation,
  });
  assert.match(canonicalRoomDeliveryOperation(createOperation), /^sha256\.[0-9a-f]{64}$/);
  assert.equal(
    planRoomDelivery(plannedCreate.room, {
      deliveryId: 'delivery-1',
      operationId: 'create-1',
      userItemId: 'user-delivery',
      participantId: 'leader',
      memberId: 'leader',
      runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: createOperation,
    }).created,
    false,
  );

  let room = acceptRoomDelivery(plannedCreate.room, 'create-1', {
    kind: 'create',
    disposition: 'reconciled',
    firstObservedAt: '2026-08-31T00:00:01.000Z',
    binding: taskBinding(3),
    detailsUrl: createStoredRoomRunDetailsUrl({ url: 'app:task/three', target: 'host' }),
  });
  assert.equal(room.runs[0].presence.state, 'ready');
  assert.deepEqual(roomDeliveryCausation(room.deliveries[0]), { operationId: 'create-1' });

  room = markRoomAcknowledgementSent(
    room,
    acknowledgement.acknowledgement.acknowledgementKey,
  );
  const plannedSend = planRoomDelivery(room, {
    deliveryId: 'delivery-1',
    operationId: 'send-1',
    userItemId: 'user-delivery',
    participantId: 'leader',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:02.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: acknowledgement.acknowledgement.acknowledgementKey,
      payload: { content: [{ kind: 'text', text: 'hello' }] },
    },
  });
  const unknown = markRoomDeliverySendingUnknown(plannedSend.room, 'send-1');
  const hydrated = hydrateRoomDeliveries(unknown, {
    now: '2026-08-31T00:00:03.000Z',
    durableApiAvailable: true,
  });
  assert.deepEqual(hydrated.reconciliations.map(item => item.operationId), ['send-1']);
  assert.equal(
    hydrateRoomDeliveries(unknown, {
      now: '2026-08-31T00:00:03.000Z',
      durableApiAvailable: false,
    }).room.deliveries.find(item => item.operationId === 'send-1').attention.code,
    'reconciliation-required',
  );

  const accepted = acceptRoomDelivery(unknown, 'send-1', {
    kind: 'send',
    disposition: 'replayed',
    firstObservedAt: '2026-08-31T00:00:04.000Z',
    messageId: 'provider-message-1',
    turn: 'provider-turn-1',
  });
  const send = accepted.deliveries.find(item => item.operationId === 'send-1');
  assert.equal(send.state, 'accepted');
  assert.deepEqual(send.acceptance, {
    kind: 'send',
    disposition: 'replayed',
    firstObservedAt: '2026-08-31T00:00:04.000Z',
    messageId: 'provider-message-1',
    turn: 'provider-turn-1',
  });
});
