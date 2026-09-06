import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import {
  acceptRoomRunPresence,
  createStoredRoomRunDetailsUrl,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../../dist/room-engagement.js';
import {
  acceptRoomDelivery,
  canonicalRoomDeliveryOperation,
  closeRoomDelivery,
  hydrateRoomDeliveries,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  requireRoomDeliveryAttention,
  requireRoomDeliveryStageAttention,
  roomDeliveryCausation,
} from '../../dist/room-delivery.js';
import { createRoomConversationModel } from '../../dist/conversation-model.js';
import { ChatroomRoomStoreError, DurableChatroomRoomStore } from '../../dist/room-store.js';

import { outboxFor, roomWithRuns, taskBinding } from './fixtures.mjs';

test('CAS-plans one durable operation id with a canonical hash and rejects divergent reuse', async () => {
  assert.equal(
    canonicalRoomDeliveryOperation({ kind: 'create', payload: null }),
    'sha256.be2a07529a3f7f2a0220eca949ac7b946712dfbd885ae138218d4ed88fa199bc',
  );
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-operation-1',
    memberId: 'leader',
    runId: 'lead-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-1',
    userItemId: 'user-operation-1',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-operation-1',
    sendOperationId: 'operation-1',
  });
  assert.throws(() =>
    planRoomDelivery(aggregate.room, {
      deliveryId: 'delivery-1',
      userItemId: 'user-operation-1',
      participantId: 'leader',
      operationId: 'operation-1',
      memberId: 'leader',
      runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: {
        kind: 'send',
        acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
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
    deliveryId: 'delivery-1',
    userItemId: 'user-operation-1',
    participantId: 'leader',
    operationId: 'operation-1',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { z: 1, a: ['same'] },
    },
  };
  const planned = planRoomDelivery(room, input);
  const replay = planRoomDelivery(planned.room, {
    ...input,
    operation: { ...input.operation, payload: { a: ['same'], z: 1 } },
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
    ...input,
    operation: { ...input.operation, payload: { a: ['different'], z: 1 } },
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
    userItemId: 'user-create-1',
    memberId: 'leader',
    runId: 'lead-run',
  });
  const aggregate = outboxFor(acknowledged.room, {
    deliveryId: 'delivery-create-1',
    userItemId: 'user-create-1',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-1',
    sendOperationId: 'send-after-create-1',
  });
  const room = aggregate.room;
  const planned = planRoomDelivery(room, {
    deliveryId: 'delivery-create-1',
    userItemId: 'user-create-1',
    participantId: 'leader',
    operationId: 'create-1',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'create' } },
  });
  assert.equal(
    requireRoomDeliveryStageAttention(planned.room, 'create-1', {
      outcome: 'denied',
      diagnostic: 'create capability denied',
    }).deliveries[0].attention.code,
    'create-denied',
  );
  const accepted = acceptRoomDelivery(planned.room, 'create-1', {
    kind: 'create',
    disposition: 'reconciled',
    firstObservedAt: '2026-08-31T00:00:01.000Z',
    binding: taskBinding(30),
    detailsUrl: createStoredRoomRunDetailsUrl({ url: 'app:task/30', target: 'host' }),
  });

  assert.equal(accepted.deliveries[0].state, 'accepted');
  assert.equal(accepted.deliveries[0].acceptance.disposition, 'reconciled');
  assert.equal(accepted.runs[0].taskBinding.binding.bindingId, 'Opaque:Binding-30');
  assert.equal(accepted.runs[0].detailsUrl.url, 'app:task/30');
  assert.equal(accepted.runs[0].presence.state, 'ready');
  assert.equal(accepted.runs[0].status, 'active');
  assert.equal(
    createRoomConversationModel(accepted).items.some(item =>
      item.kind === 'message'
      && item.author.role === 'agent'
    ),
    false,
  );
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
    deliveryId: 'delivery-first-join',
    userItemId: 'user-first-join',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-first-join',
    sendOperationId: 'send-first-join',
  });
  assert.deepEqual(first.delivery.create, {
    operationId: 'create-first-join',
    ownerDeliveryId: 'delivery-first-join',
    state: 'planned',
  });

  let readyRoom = acceptRoomRunPresence(
    first.room,
    'lead-run',
    taskBinding(31),
    createStoredRoomRunDetailsUrl({ url: 'app:task/31', target: 'host' }),
  );
  const replayedFirst = outboxFor(readyRoom, {
    deliveryId: 'delivery-first-join',
    userItemId: 'user-first-join',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-first-join',
    sendOperationId: 'send-first-join',
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
    deliveryId: 'delivery-existing-run',
    userItemId: 'user-existing-run',
    memberId: 'leader',
    runId: 'lead-run',
    sendOperationId: 'send-existing-run',
  });
  assert.deepEqual(reused.delivery.create, { state: 'not-required' });
  assert.throws(() =>
    outboxFor(readyRoom, {
      deliveryId: 'delivery-existing-run-with-create',
      userItemId: 'user-existing-run',
      memberId: 'leader',
      runId: 'lead-run',
      createOperationId: 'create-must-not-exist',
      sendOperationId: 'send-other',
    }), /must not plan another create operation/);
  assert.throws(() =>
    planRoomDelivery(reused.room, {
      deliveryId: 'delivery-existing-run',
      userItemId: 'user-existing-run',
      participantId: 'leader',
      operationId: 'create-must-not-exist',
      memberId: 'leader',
      runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: { kind: 'create', payload: { target: 'must-not-run' } },
    }), /exact outbox participant\/member\/run operation/);
  const sent = planRoomDelivery(reused.room, {
    deliveryId: 'delivery-existing-run',
    userItemId: 'user-existing-run',
    participantId: 'leader',
    operationId: 'send-existing-run',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:01.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: nextAcknowledgement.acknowledgement.acknowledgementKey,
      payload: { text: 'reuse ready session' },
    },
  });
  assert.equal(sent.delivery.stage, 'send');
  assert.equal(
    sent.room.deliveries.some(item =>
      item.deliveryId === 'delivery-existing-run'
      && item.stage === 'create'
    ),
    false,
  );
});

test('shares one pending create owner across two messages on the same run while sends remain independent', () => {
  const firstAcknowledgement = prepareRoomAcknowledgement(
    roomWithRuns(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-pending-one', memberId: 'leader', runId: 'lead-run' },
  );
  const first = outboxFor(firstAcknowledgement.room, {
    deliveryId: 'delivery-pending-one',
    userItemId: 'user-pending-one',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-shared',
    sendOperationId: 'send-one',
  });
  const secondAcknowledgement = prepareRoomAcknowledgement(
    first.room,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    { userItemId: 'user-pending-two', memberId: 'leader', runId: 'lead-run' },
  );
  const second = outboxFor(secondAcknowledgement.room, {
    deliveryId: 'delivery-pending-two',
    userItemId: 'user-pending-two',
    memberId: 'leader',
    runId: 'lead-run',
    sendOperationId: 'send-two',
  });
  assert.deepEqual(second.room.outbox.map(item => item.create), [
    { operationId: 'create-shared', ownerDeliveryId: 'delivery-pending-one', state: 'planned' },
    { operationId: 'create-shared', ownerDeliveryId: 'delivery-pending-one', state: 'planned' },
  ]);
  assert.deepEqual(second.room.outbox.map(item => item.send.operationId), ['send-one', 'send-two']);
  assert.throws(() =>
    outboxFor(secondAcknowledgement.room, {
      deliveryId: 'delivery-pending-conflict',
      userItemId: 'user-pending-two',
      memberId: 'leader',
      runId: 'lead-run',
      createOperationId: 'create-second-task',
      sendOperationId: 'send-conflict',
    }), /different pending create operation/);
  assert.throws(() =>
    planRoomDelivery(second.room, {
      deliveryId: 'delivery-pending-two',
      userItemId: 'user-pending-two',
      participantId: 'leader',
      operationId: 'create-shared',
      memberId: 'leader',
      runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: { kind: 'create', payload: { target: 'must-use-owner' } },
    }), /exact outbox participant\/member\/run operation/);
  const planned = planRoomDelivery(second.room, {
    deliveryId: 'delivery-pending-one',
    userItemId: 'user-pending-one',
    participantId: 'leader',
    operationId: 'create-shared',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { target: 'one-task' } },
  });
  const accepted = acceptRoomDelivery(planned.room, 'create-shared', {
    kind: 'create',
    disposition: 'replayed',
    firstObservedAt: '2026-08-31T00:00:01.000Z',
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
      userItemId,
      memberId: 'leader',
      runId: 'lead-run',
    });
    const aggregate = outboxFor(prepared.room, {
      deliveryId: `delivery-ack-gate-${mode}`,
      userItemId,
      memberId: 'leader',
      runId: 'lead-run',
      createOperationId: `create-ack-gate-${mode}`,
      sendOperationId: `send-ack-gate-${mode}`,
    });
    const sendInput = {
      deliveryId: `delivery-ack-gate-${mode}`,
      userItemId,
      participantId: 'leader',
      operationId: `send-ack-gate-${mode}`,
      memberId: 'leader',
      runId: 'lead-run',
      issuedAt: '2026-08-31T00:00:00.000Z',
      operation: {
        kind: 'send',
        acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
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
    assert.equal(stored.presentation.kind, mode === 'message' ? 'canned-message' : mode);
    assert.equal(planRoomDelivery(acknowledged, sendInput).delivery.state, 'planned');
  }
});

test('keeps send messageId and turn exact and maps typed uncertainty to attention', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-send-1',
    memberId: 'reviewer',
    runId: 'review-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-send-1',
    userItemId: 'user-send-1',
    memberId: 'reviewer',
    runId: 'review-run',
    createOperationId: 'create-before-send-1',
    sendOperationId: 'send-1',
  });
  const room = markRoomAcknowledgementSent(
    aggregate.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  const planned = planRoomDelivery(room, {
    deliveryId: 'delivery-send-1',
    userItemId: 'user-send-1',
    participantId: 'reviewer',
    operationId: 'send-1',
    memberId: 'reviewer',
    runId: 'review-run',
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { text: 'review' },
    },
  });
  assert.equal('messageId' in planned.delivery.operation, false);
  assert.equal('turn' in planned.delivery.operation, false);
  assert.equal(planned.delivery.canonicalPayload.includes('messageId'), false);
  const accepted = acceptRoomDelivery(planned.room, 'send-1', {
    kind: 'send',
    disposition: 'executed',
    firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9',
    turn: '4',
  });
  assert.equal(accepted.deliveries[0].acceptance.messageId, 'message-9');
  assert.equal(accepted.deliveries[0].acceptance.turn, '4');
  const replayed = acceptRoomDelivery(accepted, 'send-1', {
    kind: 'send',
    disposition: 'replayed',
    firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9',
    turn: '4',
  });
  assert.equal(replayed.deliveries[0].acceptance.disposition, 'replayed');
  const mismatch = acceptRoomDelivery(replayed, 'send-1', {
    kind: 'send',
    disposition: 'executed',
    firstObservedAt: '2026-08-31T00:00:02.000Z',
    messageId: 'message-9',
    turn: '5',
  });
  assert.equal(mismatch.deliveries[0].attention.code, 'operation-conflict');
  const unavailable = requireRoomDeliveryAttention(
    planned.room,
    'send-1',
    'details-unavailable',
    'Provider omitted its canonical details URL.',
  );
  assert.deepEqual(unavailable.deliveries[0].attention, {
    code: 'details-unavailable',
    diagnostic: 'Provider omitted its canonical details URL.',
  });
  assert.equal(
    requireRoomDeliveryStageAttention(planned.room, 'send-1', {
      outcome: 'unavailable',
      diagnostic: 'send capability unavailable',
    }).deliveries[0].attention.code,
    'send-unavailable',
  );
});

test('hydrates only same-id exact-payload reconciliation and expires closed recovery after 30 days', () => {
  const prepared = prepareRoomAcknowledgement(roomWithRuns(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-recover-1',
    memberId: 'leader',
    runId: 'lead-run',
  });
  const aggregate = outboxFor(prepared.room, {
    deliveryId: 'delivery-recover-1',
    userItemId: 'user-recover-1',
    memberId: 'leader',
    runId: 'lead-run',
    createOperationId: 'create-recover-1',
    sendOperationId: 'recover-1',
  });
  let room = markRoomAcknowledgementSent(
    aggregate.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  room = planRoomDelivery(room, {
    deliveryId: 'delivery-recover-1',
    userItemId: 'user-recover-1',
    participantId: 'leader',
    operationId: 'recover-1',
    memberId: 'leader',
    runId: 'lead-run',
    issuedAt: '2026-08-01T00:00:00.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { text: 'recover' },
    },
  }).room;
  room = markRoomDeliverySendingUnknown(room, 'recover-1');
  const recoverable = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z',
    durableApiAvailable: true,
  });
  assert.deepEqual(recoverable.reconciliations, [{
    operationId: 'recover-1',
    canonicalPayload: room.deliveries[0].canonicalPayload,
    operation: room.deliveries[0].operation,
  }]);
  assert.equal(
    hydrateRoomDeliveries(room, {
      now: '2027-12-31T00:00:00.000Z',
      durableApiAvailable: true,
    }).reconciliations.length,
    1,
    'consumer issuedAt never expires an unknown operation',
  );

  const unavailable = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z',
    durableApiAvailable: false,
  });
  assert.equal(unavailable.reconciliations.length, 0);
  assert.equal(unavailable.room.deliveries[0].attention.code, 'reconciliation-required');
  const replaced = hydrateRoomDeliveries(room, {
    now: '2026-08-15T00:00:00.000Z',
    durableApiAvailable: true,
    providerReplaced: true,
  });
  assert.equal(replaced.room.deliveries[0].attention.code, 'provider-replaced');

  const closed = closeRoomDelivery(room, 'recover-1', {
    closedAt: '2026-08-20T00:00:00.000Z',
    source: 'host',
  });
  assert.equal(
    hydrateRoomDeliveries(closed, {
      now: '2026-09-18T23:59:59.000Z',
      durableApiAvailable: true,
    }).reconciliations.length,
    1,
  );
  const expired = hydrateRoomDeliveries(closed, {
    now: '2026-09-20T00:00:00.001Z',
    durableApiAvailable: true,
  });
  assert.equal(expired.reconciliations.length, 0);
  assert.equal(expired.room.deliveries[0].attention.code, 'operation-expired');
  assert.match(expired.room.deliveries[0].attention.diagnostic, /30-day recovery window/);
});
