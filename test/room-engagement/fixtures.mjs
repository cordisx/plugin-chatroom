import assert from 'node:assert/strict';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { markRoomAcknowledgementSent, prepareRoomAcknowledgement } from '../../dist/room-engagement.js';
import { acceptRoomDelivery, planRoomDelivery, prepareRoomOutboxDelivery } from '../../dist/room-delivery.js';
import { addRoomRun, createRoom } from '../../dist/room.js';
import { CHATROOM_ROOM_REGISTRY_DOCUMENT_ID } from '../../dist/room-store.js';

const definitionFor = memberId =>
  CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
    .find(member => member.memberId === memberId).definition;

const taskBinding = (number, memberId = 'leader', generation = 1) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v4',
  schemaVersion: 4,
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

function acceptConversationTurn(room, input) {
  const prepared = prepareRoomAcknowledgement(room, input.configuration, {
    userItemId: input.userItemId,
    memberId: input.memberId,
    runId: input.runId,
  });
  let next = markRoomAcknowledgementSent(
    prepared.room,
    prepared.acknowledgement.acknowledgementKey,
  );
  const deliveryId = `fixture-delivery-${input.runId}`;
  const operationId = `fixture-send-${input.runId}`;
  next = prepareRoomOutboxDelivery(next, {
    deliveryId,
    userItemId: input.userItemId,
    memberId: input.memberId,
    runId: input.runId,
    sendOperationId: operationId,
  }).room;
  next = planRoomDelivery(next, {
    deliveryId,
    operationId,
    userItemId: input.userItemId,
    participantId: prepared.acknowledgement.participantId,
    memberId: input.memberId,
    runId: input.runId,
    issuedAt: '2026-08-31T00:00:05.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: prepared.acknowledgement.acknowledgementKey,
      payload: { commandId: operationId, type: 'send', binding: input.binding },
    },
  }).room;
  const turn = `turn-${input.runId}`;
  return {
    room: acceptRoomDelivery(next, operationId, {
      kind: 'send',
      disposition: 'executed',
      firstObservedAt: '2026-08-31T00:00:05.000Z',
      messageId: `fixture-message-${input.runId}`,
      turn,
    }),
    turn,
  };
}

function ownerDocumentsFixture(initial) {
  let snapshot = initial;
  const listeners = new Set();
  const publish = result => {
    for (const listener of listeners) listener(result);
  };
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
        contract: 'cordisx.owner-documents/v1',
        revision: actualRevision + 1,
        schemaVersion: command.schemaVersion,
        value: JSON.parse(JSON.stringify(command.value)),
      };
      const accepted = { status: 'accepted', snapshot };
      publish({ status: 'loaded', snapshot });
      return accepted;
    },
    async replace(command) {
      return await this.transaction(command);
    },
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
        contract: 'cordisx.owner-documents/v1',
        revision,
        schemaVersion: 1,
        value,
      };
      return snapshot;
    },
  };
}

export { acceptConversationTurn, definitionFor, outboxFor, ownerDocumentsFixture, roomWithRuns, taskBinding };
