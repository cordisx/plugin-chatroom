import assert from 'node:assert/strict';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { acceptRoomDelivery, planRoomDelivery, prepareRoomOutboxDelivery } from '../../dist/room-delivery.js';
import { addRoomRun, createRoom } from '../../dist/room.js';
import { CHATROOM_ROOM_REGISTRY_DOCUMENT_ID } from '../../dist/room-store.js';
import { markRoomAcknowledgementSent, prepareRoomAcknowledgement } from '../../dist/room-engagement.js';

const definitionFor = memberId =>
  CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
    .find(member => member.memberId === memberId).definition;
const taskBinding = (number, definition) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v4',
  schemaVersion: 4,
  binding: { bindingId: `Opaque:Binding-${number}`, generation: 1 },
  definition,
  task: `Opaque:Task-${number}`,
  state: 'active',
});
const acceptedTurnFor = binding => `turn-${binding.binding.bindingId}`;

function roomWithRuns(id, runMembers) {
  let room = createRoom({ id, title: id });
  for (const [index, memberId] of runMembers.entries()) {
    room = addRoomRun(room, {
      runId: `${id}-run-${index + 1}`,
      memberId,
      title: `Run ${index + 1}`,
      status: 'creating',
    });
  }
  return room;
}

function acceptConversationDelivery(room, runId, userItemId, binding) {
  const run = room.runs.find(candidate => candidate.runId === runId);
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId);
  const acknowledgement = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId,
    memberId: member.memberId,
    runId,
  });
  room = markRoomAcknowledgementSent(
    acknowledgement.room,
    acknowledgement.acknowledgement.acknowledgementKey,
  );
  const deliveryId = `fixture-delivery-${userItemId}`;
  const operationId = `fixture-send-${userItemId}`;
  room = prepareRoomOutboxDelivery(room, {
    deliveryId,
    userItemId,
    memberId: member.memberId,
    runId,
    sendOperationId: operationId,
  }).room;
  room = planRoomDelivery(room, {
    deliveryId,
    operationId,
    userItemId,
    participantId: member.participantId,
    memberId: member.memberId,
    runId,
    issuedAt: '2026-08-31T04:59:59.000Z',
    operation: {
      kind: 'send',
      acknowledgementKey: acknowledgement.acknowledgement.acknowledgementKey,
      payload: { commandId: operationId, type: 'send', binding },
    },
  }).room;
  return {
    room: acceptRoomDelivery(room, operationId, {
      kind: 'send',
      disposition: 'executed',
      firstObservedAt: '2026-08-31T05:00:00.000Z',
      messageId: `fixture-message-${userItemId}`,
      turn: acceptedTurnFor(binding),
    }),
    acceptance: { operationId, turn: acceptedTurnFor(binding) },
  };
}

function ownerDocumentsFixture() {
  let snapshot;
  const listeners = new Set();
  return {
    client: {
      async load(documentId) {
        assert.equal(documentId, CHATROOM_ROOM_REGISTRY_DOCUMENT_ID);
        return snapshot === undefined ? { status: 'missing', revision: 0 } : { status: 'loaded', snapshot };
      },
      async transaction(command) {
        const actualRevision = snapshot?.revision ?? 0;
        if (command.expectedRevision !== actualRevision) return { status: 'conflict', actualRevision };
        snapshot = {
          contract: 'cordisx.owner-documents/v1',
          revision: actualRevision + 1,
          schemaVersion: command.schemaVersion,
          value: JSON.parse(JSON.stringify(command.value)),
        };
        for (const listener of listeners) listener({ status: 'loaded', snapshot });
        return { status: 'accepted', snapshot };
      },
      async replace(command) {
        return await this.transaction(command);
      },
      subscribe(documentId, listener) {
        assert.equal(documentId, CHATROOM_ROOM_REGISTRY_DOCUMENT_ID);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    snapshot: () => snapshot,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAgentLoopClient {
  calls = [];
  created = 0;
  disposed = false;
  live = false;
  unsubscribed = 0;
  events = new Map();
  acceptedDeliveries = new Map();

  async createOrBind(command) {
    this.calls.push(command);
    const number = this.created += 1;
    const generated = taskBinding(number, command.definition);
    const binding = command.target.mode === 'bind'
      ? {
        ...generated,
        binding: { bindingId: `Opaque:Rebinding-${number}`, generation: number + 1 },
        task: command.target.task,
      }
      : generated;
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: 'create-or-bind',
      status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
      binding,
      detailsUrl: { url: `app:task/${this.created}`, target: 'host' },
      delivery: { disposition: 'executed' },
    };
  }

  async subscribe(binding, afterSequence) {
    this.calls.push({ type: 'subscribe', binding, afterSequence });
    const acceptedDelivery = this.acceptedDeliveries.get(binding.binding.bindingId);
    const configuredEvents = this.events.get(binding.binding.bindingId) ?? [];
    const events = configuredEvents.length > 0 || acceptedDelivery === undefined
      ? configuredEvents
      : [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
        contract: 'cordisx.agent-loop-event/v4',
        schemaVersion: 4,
        eventId: `completed-${binding.binding.bindingId}`,
        binding: binding.binding,
        sequence: afterSequence + 1,
        occurredAt: '2026-08-31T05:00:01.000Z',
        type: 'lifecycle',
        turn: acceptedDelivery.turn,
        causation: { operationId: acceptedDelivery.operationId },
        lifecycle: { phase: 'turn.completed' },
      }];
    let release = () => {};
    const terminal = new Promise(resolve => {
      release = resolve;
    });
    const client = this;
    const subscription = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v4',
      schemaVersion: 4,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding,
      afterSequence,
      snapshotSequence: Math.max(afterSequence, events.length - 1),
    };
    return {
      status: 'accepted',
      authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() {
          client.unsubscribed += 1;
          release();
        },
        pages: {
          async *[Symbol.asyncIterator]() {
            let cursor = afterSequence;
            for (let offset = 0; offset < events.length; offset += 64) {
              const selected = events.slice(offset, offset + 64);
              yield {
                $schema:
                  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v4.schema.json',
                contract: 'cordisx.agent-loop-event-page/v4',
                schemaVersion: 4,
                subscription,
                afterSequence: cursor,
                phase: 'replay',
                events: selected,
                nextAfterSequence: selected.at(-1).sequence,
                hasMore: offset + selected.length < events.length,
              };
              cursor = selected.at(-1).sequence;
            }
            if (client.live) await terminal;
          },
        },
      },
    };
  }

  async send(command) {
    this.calls.push(command);
    if (command.content.some(part => part.kind === 'image-ref')) {
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
        contract: 'cordisx.agent-loop-result/v4',
        schemaVersion: 4,
        commandId: command.commandId,
        type: 'send',
        status: 'unavailable',
        authorization: { capability: 'turns.submit', state: 'unavailable', code: 'unsupported' },
      };
    }
    const acceptance = {
      operationId: command.commandId,
      turn: acceptedTurnFor(command.binding),
    };
    this.acceptedDeliveries.set(command.binding.binding.bindingId, acceptance);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: 'send',
      status: 'accepted',
      authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      messageId: `Opaque:Message-${this.calls.length}`,
      turn: acceptance.turn,
      delivery: { disposition: 'executed' },
    };
  }

  async requestMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      turn: `introduction-turn-${command.runId}`,
      messageId: `introduction-message-${command.runId}`,
      causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  async cancelMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      requestOperationId: command.requestOperationId,
      turn: `introduction-turn-${command.runId}`,
      messageId: `introduction-message-${command.runId}`,
      causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  async decideApproval(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'approvals.decide', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      turn: command.turn,
      approvalId: command.approvalId,
      decision: command.decision,
      causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  dispose() {
    this.disposed = true;
  }
}

class DeferredPageAgentLoopClient extends FakeAgentLoopClient {
  page = deferred();

  async subscribe(binding, afterSequence) {
    this.calls.push({ type: 'subscribe', binding, afterSequence });
    const subscription = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v4',
      schemaVersion: 4,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding,
      afterSequence,
      snapshotSequence: afterSequence + 1,
    };
    const client = this;
    return {
      status: 'accepted',
      authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() {
          client.unsubscribed += 1;
        },
        pages: {
          async *[Symbol.asyncIterator]() {
            yield await client.page.promise;
          },
        },
      },
    };
  }
}

class ImmediatePageAgentLoopClient extends FakeAgentLoopClient {
  async subscribe(binding, afterSequence) {
    this.calls.push({ type: 'subscribe', binding, afterSequence });
    const client = this;
    const subscription = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v4',
      schemaVersion: 4,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding,
      afterSequence,
      snapshotSequence: afterSequence + 1,
    };
    return {
      status: 'accepted',
      authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() {},
        pages: {
          async *[Symbol.asyncIterator]() {
            yield assistantPage(
              binding,
              afterSequence + 1,
              'Late reply',
              client.acceptedDeliveries.get(binding.binding.bindingId),
            );
          },
        },
      },
    };
  }
}

class InterleavedReviewerCreateClient extends DeferredPageAgentLoopClient {
  secondCreateStarted = deferred();
  releaseSecondCreate = deferred();
  subscriptions = 0;

  async createOrBind(command) {
    if (this.created === 1) {
      this.secondCreateStarted.resolve();
      await this.releaseSecondCreate.promise;
    }
    return await super.createOrBind(command);
  }

  async subscribe(binding, afterSequence) {
    this.subscriptions += 1;
    return this.subscriptions === 1
      ? await super.subscribe(binding, afterSequence)
      : await FakeAgentLoopClient.prototype.subscribe.call(this, binding, afterSequence);
  }
}

function assistantPage(binding, sequence, text = 'Late reply', acceptedDelivery) {
  const subscription = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
    contract: 'cordisx.agent-loop-event-subscription/v4',
    schemaVersion: 4,
    subscriptionId: `subscription-${binding.binding.bindingId}`,
    binding: binding.binding,
    afterSequence: sequence - 1,
    snapshotSequence: sequence,
  };
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v4.schema.json',
    contract: 'cordisx.agent-loop-event-page/v4',
    schemaVersion: 4,
    subscription,
    afterSequence: sequence - 1,
    phase: 'live',
    nextAfterSequence: acceptedDelivery === undefined ? sequence : sequence + 1,
    hasMore: false,
    events: [
      {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
        contract: 'cordisx.agent-loop-event/v4',
        schemaVersion: 4,
        eventId: `event-${sequence}`,
        binding: binding.binding,
        sequence,
        occurredAt: '2026-08-31T05:00:00.000Z',
        type: 'message',
        turn: acceptedDelivery?.turn ?? acceptedTurnFor(binding),
        message: {
          messageId: `assistant-${sequence}`,
          role: 'assistant',
          purpose: 'conversation',
          content: [{ kind: 'text', text }],
        },
      },
      ...(acceptedDelivery === undefined ? [] : [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
        contract: 'cordisx.agent-loop-event/v4',
        schemaVersion: 4,
        eventId: `event-${sequence + 1}`,
        binding: binding.binding,
        sequence: sequence + 1,
        occurredAt: '2026-08-31T05:00:01.000Z',
        type: 'lifecycle',
        turn: acceptedDelivery.turn,
        causation: { operationId: acceptedDelivery.operationId },
        lifecycle: { phase: 'turn.completed' },
      }]),
    ],
  };
}

export {
  acceptConversationDelivery,
  acceptedTurnFor,
  assistantPage,
  deferred,
  DeferredPageAgentLoopClient,
  definitionFor,
  FakeAgentLoopClient,
  ImmediatePageAgentLoopClient,
  InterleavedReviewerCreateClient,
  ownerDocumentsFixture,
  roomWithRuns,
  taskBinding,
};
