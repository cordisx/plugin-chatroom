import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../dist/agent-loop-projection.js';
import {
  canonicalRoomPayloadHash,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  prepareRoomOutboxDelivery,
} from '../dist/room-delivery.js';
import { addRoomRun, bindRoomRun, closeRoomRun, createRoom } from '../dist/room.js';
import {
  CHATROOM_ROOM_REGISTRY_DOCUMENT_ID,
  ChatroomRoomStoreError,
  DurableChatroomRoomStore,
} from '../dist/room-store.js';
import {
  acceptRoomRunPresence,
  createStoredRoomRunDetailsUrl,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../dist/room-engagement.js';

const definitionFor = memberId => CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
  .find(member => member.memberId === memberId).definition;
const taskBinding = (number, definition) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v2', schemaVersion: 2,
  binding: { bindingId: `Opaque:Binding-${number}`, generation: 1 },
  definition,
  task: `Opaque:Task-${number}`,
  state: 'active',
});

function roomWithRuns(id, runMembers) {
  let room = createRoom({ id, title: id });
  for (const [index, memberId] of runMembers.entries()) {
    room = addRoomRun(room, { runId: `${id}-run-${index + 1}`, memberId, title: `Run ${index + 1}`, status: 'creating' });
  }
  return room;
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
          contract: 'cordisx.owner-documents/v1', revision: actualRevision + 1,
          schemaVersion: command.schemaVersion, value: JSON.parse(JSON.stringify(command.value)),
        };
        for (const listener of listeners) listener({ status: 'loaded', snapshot });
        return { status: 'accepted', snapshot };
      },
      async replace(command) { return await this.transaction(command); },
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
      $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
      commandId: command.commandId, type: 'create-or-bind', status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' }, binding,
      detailsUrl: { url: `app:task/${this.created}`, target: 'host' },
      delivery: { disposition: 'executed' },
    };
  }

  async subscribe(binding, afterSequence) {
    this.calls.push({ type: 'subscribe', binding, afterSequence });
    const events = this.events.get(binding.binding.bindingId) ?? [];
    let release = () => {};
    const terminal = new Promise(resolve => { release = resolve; });
    const client = this;
    const subscription = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding, afterSequence, snapshotSequence: Math.max(afterSequence, events.length - 1),
    };
    return {
      status: 'accepted', authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription, unsubscribe() { client.unsubscribed += 1; release(); },
        pages: { async *[Symbol.asyncIterator]() {
          let cursor = afterSequence;
          for (let offset = 0; offset < events.length; offset += 64) {
            const selected = events.slice(offset, offset + 64);
            yield {
              $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v1.schema.json',
              contract: 'cordisx.agent-loop-event-page/v2', schemaVersion: 2,
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
        } },
      },
    };
  }

  async send(command) {
    this.calls.push(command);
    if (command.content.some(part => part.kind === 'image-ref')) {
      return {
        $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
        commandId: command.commandId, type: 'send', status: 'unavailable',
        authorization: { capability: 'turns.submit', state: 'unavailable', code: 'unsupported' },
      };
    }
    return {
      $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
      commandId: command.commandId, type: 'send', status: 'accepted',
      authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
      binding: command.binding, messageId: `Opaque:Message-${this.calls.length}`,
      turn: `turn-${this.calls.length}`, delivery: { disposition: 'executed' },
    };
  }

  async requestMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
      commandId: command.commandId, type: command.type, status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId, memberId: command.memberId, runId: command.runId,
      turn: `introduction-turn-${command.runId}`, messageId: `introduction-message-${command.runId}`,
      causation: { operationId: command.commandId }, delivery: { disposition: 'executed' },
    };
  }

  async cancelMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
      commandId: command.commandId, type: command.type, status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId, memberId: command.memberId, runId: command.runId,
      requestOperationId: command.requestOperationId,
      turn: `introduction-turn-${command.runId}`, messageId: `introduction-message-${command.runId}`,
      causation: { operationId: command.commandId }, delivery: { disposition: 'executed' },
    };
  }

  async decideApproval(command) {
    this.calls.push(command);
    return {
      $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
      commandId: command.commandId, type: command.type, status: 'accepted',
      authorization: { capability: 'approvals.decide', state: 'allowed', code: 'allowed' },
      binding: command.binding, turn: command.turn, approvalId: command.approvalId,
      decision: command.decision, causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  dispose() { this.disposed = true; }
}

class DeferredPageAgentLoopClient extends FakeAgentLoopClient {
  page = deferred();

  async subscribe(binding, afterSequence) {
    this.calls.push({ type: 'subscribe', binding, afterSequence });
    const subscription = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding, afterSequence, snapshotSequence: afterSequence + 1,
    };
    const client = this;
    return {
      status: 'accepted', authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() { client.unsubscribed += 1; },
        pages: { async *[Symbol.asyncIterator]() { yield await client.page.promise; } },
      },
    };
  }
}

class ImmediatePageAgentLoopClient extends FakeAgentLoopClient {
  async subscribe(binding, afterSequence) {
    const subscription = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
      subscriptionId: `subscription-${binding.binding.bindingId}`,
      binding: binding.binding, afterSequence, snapshotSequence: afterSequence + 1,
    };
    return {
      status: 'accepted', authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription, unsubscribe() {},
        pages: { async *[Symbol.asyncIterator]() { yield assistantPage(binding, afterSequence + 1); } },
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

function assistantPage(binding, sequence, text = 'Late reply') {
  const subscription = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v1.schema.json',
    contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
    subscriptionId: `subscription-${binding.binding.bindingId}`,
    binding: binding.binding, afterSequence: sequence - 1, snapshotSequence: sequence,
  };
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-page.v1.schema.json',
    contract: 'cordisx.agent-loop-event-page/v2', schemaVersion: 2,
    subscription, afterSequence: sequence - 1, phase: 'live', nextAfterSequence: sequence, hasMore: false,
    events: [{
      $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
      eventId: `event-${sequence}`, binding: binding.binding, sequence,
      occurredAt: '2026-08-31T05:00:00.000Z', type: 'message',
      message: { messageId: `assistant-${sequence}`, role: 'assistant', purpose: 'conversation', content: [{ kind: 'text', text }] },
    }],
  };
}

test('creates isolated bindings for two members in one Room and never cross-streams them', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader', 'reviewer'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{ kind: 'text', text: 'Lead' }]);
  await controller.sendToRoom('room-1', 'room-1-run-2', 'user-2', [{ kind: 'text', text: 'Review' }]);

  const room = rooms.get('room-1');
  assert.deepEqual(client.calls.filter(call => call.type === 'create-or-bind').map(call => call.definition.agentId), [
    'chatroom.generalist', 'chatroom.reviewer',
  ]);
  assert.deepEqual(client.calls.filter(call => call.type === 'create-or-bind').map(call => call.definitions.map(definition => definition.identity.agentId)), [
    ['chatroom.generalist'], ['chatroom.generalist', 'chatroom.reviewer'],
  ]);
  assert.notEqual(room.runs[0].taskBinding.binding.bindingId, room.runs[1].taskBinding.binding.bindingId);
  assert.notEqual(room.runs[0].taskBinding.task, room.runs[1].taskBinding.task);
  assert.deepEqual(room.runs.map(run => [run.memberId, run.presence.state]), [
    ['leader', 'ready'], ['reviewer', 'ready'],
  ]);
  const fanoutCommands = client.calls.filter(call => call.type === 'send');
  assert.notEqual(fanoutCommands[0].commandId, fanoutCommands[1].commandId);
  for (const command of client.calls.filter(call => call.type === 'create-or-bind' || call.type === 'send')) {
    const persisted = room.deliveries.find(delivery => delivery.operationId === command.commandId);
    assert.match(persisted.canonicalPayload, /^sha256\.[0-9a-f]{64}$/);
    assert.equal(persisted.operation.payload.commandId, command.commandId);
    assert.equal(persisted.operation.payload.canonicalHash, persisted.canonicalPayload);
    assert.doesNotMatch(JSON.stringify(persisted.operation.payload),
      /promptSections|personality|memory-policy|"content"|Retry me|Lead|Review/);
    if (command.type === 'create-or-bind') {
      assert.deepEqual(persisted.operation.payload.definitions,
        command.definitions.map(definition => definition.identity));
    } else {
      assert.deepEqual(persisted.operation.payload.binding, command.binding);
    }
    assert.equal(Number.isFinite(Date.parse(persisted.issuedAt)), true);
  }
});

test('preserves both run projections while a second same-Room fanout delivery is being committed', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-fanout', ['leader', 'reviewer'])]);
  const compareAndSwap = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (...args) => {
    await new Promise(resolve => setImmediate(resolve));
    return await compareAndSwap(...args);
  };
  const client = new ImmediatePageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-fanout', 'room-fanout-run-1', 'user-lead', [{ kind: 'text', text: 'Lead request' }],
  );
  await controller.sendToRoom(
    'room-fanout', 'room-fanout-run-2', 'user-reviewer', [{ kind: 'text', text: 'Review request' }],
  );
  await controller.waitForProjectionDrain();

  const room = store.rooms.get('room-fanout');
  assert.deepEqual(room.runs.map(run => run.agentLoopCursor), [0, 0]);
  assert.deepEqual(room.items.filter(item => item.kind === 'message').map(item => item.author.participantId).sort(),
    ['leader', 'reviewer']);
  assert.equal(room.acknowledgements.length, 2);
  assert.equal(room.deliveries.filter(delivery => delivery.stage === 'send').length, 2);
  controller.dispose();
});

test('merges a Lead event that lands while a Reviewer create result is in flight', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-interleaved-create', ['leader', 'reviewer'])]);
  const client = new InterleavedReviewerCreateClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-interleaved-create', 'room-interleaved-create-run-1', 'user-lead', [{ kind: 'text', text: 'Lead request' }],
  );
  const leadBinding = store.rooms.get('room-interleaved-create').runs[0].taskBinding;
  const reviewer = controller.sendToRoom(
    'room-interleaved-create', 'room-interleaved-create-run-2', 'user-reviewer', [{ kind: 'text', text: 'Review request' }],
  );
  await client.secondCreateStarted.promise;
  client.page.resolve(assistantPage(leadBinding, 0, 'Lead event during Reviewer create'));
  await new Promise(resolve => setImmediate(resolve));
  client.releaseSecondCreate.resolve();

  assert.equal((await reviewer).status, 'accepted');
  await controller.waitForProjectionDrain();
  const room = store.rooms.get('room-interleaved-create');
  assert.equal(room.runs[1].taskBinding?.state, 'active');
  assert.equal(room.runs[0].agentLoopCursor, 0);
  assert.equal(room.items.some(item => item.kind === 'message' && item.author.participantId === 'leader'), true);
  controller.dispose();
});

test('plans a Reviewer create against the latest Room when a Lead event lands first', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-interleaved-plan', ['leader', 'reviewer'])]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-interleaved-plan', 'room-interleaved-plan-run-1', 'user-lead', [{ kind: 'text', text: 'Lead request' }],
  );
  const leadBinding = store.rooms.get('room-interleaved-plan').runs[0].taskBinding;
  const reviewer = controller.sendToRoom(
    'room-interleaved-plan', 'room-interleaved-plan-run-2', 'user-reviewer', [{ kind: 'text', text: 'Review request' }],
  );
  client.page.resolve(assistantPage(leadBinding, 0, 'Lead event before Reviewer create planning'));

  assert.equal((await reviewer).status, 'accepted');
  await controller.waitForProjectionDrain();
  const room = store.rooms.get('room-interleaved-plan');
  assert.equal(room.runs[1].taskBinding?.state, 'active');
  assert.equal(room.runs[0].agentLoopCursor, 0);
  assert.equal(room.items.some(item => item.kind === 'message' && item.author.participantId === 'leader'), true);
  controller.dispose();
});

test('latches a live incompatible projection collision without advancing the run cursor', async () => {
  let room = roomWithRuns('room-collision', ['leader']);
  const active = taskBinding(301, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room, 'room-collision-run-1', active,
    createStoredRoomRunDetailsUrl({ url: 'app:task/collision', target: 'host' }),
  );
  const collisionEvent = assistantPage(active, 0).events[0];
  const derived = projectAgentLoopEvent(room, 'room-collision-run-1', collisionEvent).room.items[0];
  room = createRoom({
    ...room,
    timelineSequence: room.timelineSequence + 1,
    items: [{
      kind: 'status', itemId: derived.itemId, sequence: room.timelineSequence + 1,
      label: { fallback: 'Unrelated status' }, state: 'info', ariaLive: 'off',
    }],
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new ImmediatePageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-collision', 'room-collision-run-1', 'user-collision', [{ kind: 'text', text: 'Trigger' }],
  );
  await assert.rejects(controller.waitForProjectionDrain(), /projection identity collided/);
  assert.equal(store.rooms.get('room-collision').runs[0].agentLoopCursor, -1);
  assert.equal(store.rooms.get('room-collision').items[0].kind, 'status');
  await controller.waitForProjectionDrain();
  controller.dispose();
});

test('reuses a commandId only for retrying the same logical message on the same binding', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader', 'reviewer'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-same', [{ kind: 'text', text: 'Retry me' }]);
  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-same', [{ kind: 'text', text: 'Retry me' }]);
  await controller.sendToRoom('room-1', 'room-1-run-2', 'user-same', [{ kind: 'text', text: 'Retry me' }]);
  const sends = client.calls.filter(call => call.type === 'send');

  assert.equal(sends[0].commandId, sends[1].commandId);
  assert.notEqual(sends[0].commandId, sends[2].commandId);
  assert.deepEqual(rooms.get('room-1').runs.map(run => run.presence.state), ['ready', 'ready']);
  const conflict = await controller.sendToRoom(
    'room-1', 'room-1-run-1', 'user-same', [{ kind: 'text', text: 'Different command' }],
  );
  assert.equal(conflict.status, 'unavailable');
  assert.equal(rooms.get('room-1').deliveries.find(item => item.stage === 'send').attention.code,
    'operation-conflict');
});

test('never replays a create operation when the rebuilt catalog command hash changed', async () => {
  const roomId = 'room-1';
  const runId = 'room-1-run-1';
  const userItemId = 'user-1';
  const stablePart = value => `${value.length}:${value}`;
  const createOperationId = `chatroom-create-${canonicalRoomPayloadHash({ roomId, runId }).slice('sha256.'.length)}`;
  const sendOperationId = `chatroom-send-${canonicalRoomPayloadHash({ roomId, runId, userItemId }).slice('sha256.'.length)}`;
  assert.match(createOperationId, /^chatroom-create-[a-f0-9]{64}$/);
  assert.match(sendOperationId, /^chatroom-send-[a-f0-9]{64}$/);
  const deliveryId = `chatroom:delivery:${stablePart(roomId)}${stablePart(runId)}${stablePart(userItemId)}`;
  let room = roomWithRuns(roomId, ['leader']);
  const acknowledgement = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId, memberId: 'leader', runId,
  });
  room = markRoomAcknowledgementSent(
    acknowledgement.room,
    acknowledgement.acknowledgement.acknowledgementKey,
  );
  room = prepareRoomOutboxDelivery(room, {
    deliveryId, userItemId, memberId: 'leader', runId, createOperationId, sendOperationId,
  }).room;
  room = planRoomDelivery(room, {
    deliveryId, operationId: createOperationId, userItemId,
    participantId: 'leader', memberId: 'leader', runId,
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { commandId: createOperationId, type: 'create-or-bind' } },
  }).room;
  room = markRoomDeliverySendingUnknown(room, createOperationId);
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.hydrate();
  assert.equal(client.calls.some(call => call.type === 'create-or-bind' || call.type === 'send'), false);
  const durable = store.rooms.get(roomId).deliveries.find(delivery => delivery.operationId === createOperationId);
  assert.equal(durable.attention.code, 'reconciliation-required');
  assert.equal(durable.operationId, createOperationId, 'attention never invents a replacement operation id');
});

test('startup replays one planned/sending-unknown create with the same id and identical rebuilt hash', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader'])]);
  class UnknownCreateClient extends FakeAgentLoopClient {
    async createOrBind(command) {
      this.calls.push(command);
      throw new Error('outcome unknown');
    }
  }
  const unknown = new UnknownCreateClient();
  const first = new ChatroomAgentLoopController(unknown, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    () => '2026-08-31T00:00:00.000Z');
  await assert.rejects(
    first.sendToRoom('room-1', 'room-1-run-1', 'user-unknown', [{ kind: 'text', text: 'Recover' }]),
    /outcome unknown/,
  );
  const pending = store.rooms.get('room-1').deliveries.find(delivery => delivery.stage === 'create');
  assert.equal(pending.state, 'sending-unknown');

  const replay = new FakeAgentLoopClient();
  const second = new ChatroomAgentLoopController(replay, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    () => '2026-08-31T00:00:10.000Z');
  await second.hydrate();
  const replayed = replay.calls.find(call => call.type === 'create-or-bind');
  assert.equal(replayed.commandId, pending.operationId);
  assert.equal(store.rooms.get('room-1').deliveries
    .find(delivery => delivery.operationId === pending.operationId).state, 'accepted');
  assert.equal(store.rooms.get('room-1').runs[0].presence.state, 'ready');
});

test('does not immediately rebind a recovered bind when the provider preserves binding identity', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(73, definitionFor('leader'));
  room = bindRoomRun(room, 'room-1-run-1', stale);
  const store = DurableChatroomRoomStore.memory([room]);
  class UnknownBindClient extends FakeAgentLoopClient {
    async createOrBind(command) {
      this.calls.push(command);
      throw new Error('outcome unknown');
    }
  }
  const first = new ChatroomAgentLoopController(
    new UnknownBindClient(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  await assert.rejects(
    first.sendToRoom('room-1', 'room-1-run-1', 'user-bind-unknown', [{ kind: 'text', text: 'Recover bind' }]),
    /outcome unknown/,
  );

  class IdentityPreservingClient extends FakeAgentLoopClient {
    async createOrBind(command) {
      this.calls.push(command);
      return {
        $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
        commandId: command.commandId, type: 'create-or-bind', status: 'accepted',
        authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
        binding: stale, detailsUrl: { url: 'app:task/recovered', target: 'host' },
        delivery: { disposition: 'reconciled' },
      };
    }
  }
  const replay = new IdentityPreservingClient();
  const second = new ChatroomAgentLoopController(replay, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  await second.hydrate();
  assert.equal(replay.calls.filter(call => call.type === 'create-or-bind').length, 1);
  assert.equal(replay.calls.filter(call => call.type === 'subscribe').length, 1);
  assert.equal(store.rooms.get('room-1').runs[0].detailsUrl.url, 'app:task/recovered');
});

test('allows one member to own two independently created bindings', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader', 'leader'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await Promise.all([
    controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{ kind: 'text', text: 'One' }]),
    controller.sendToRoom('room-1', 'room-1-run-2', 'user-2', [{ kind: 'text', text: 'Two' }]),
  ]);

  assert.equal(client.calls.filter(call => call.type === 'create-or-bind').length, 2);
  assert.notEqual(rooms.get('room-1').runs[0].taskBinding.task, rooms.get('room-1').runs[1].taskBinding.task);
});

test('reuses only the exact run binding and resumes from that run cursor', async () => {
  let room = roomWithRuns('room-1', ['leader', 'reviewer']);
  const existing = taskBinding(9, definitionFor('reviewer'));
  room = acceptRoomRunPresence(room, 'room-1-run-2', existing,
    createStoredRoomRunDetailsUrl({ url: 'app:task/9', target: 'host' }));
  room = createRoom({
    ...room,
    runs: room.runs.map(run => run.runId === 'room-1-run-2' ? { ...run, agentLoopCursor: 4 } : run),
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  client.events.set(existing.binding.bindingId, [{
    $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
    eventId: 'event-5', binding: existing.binding, sequence: 5, occurredAt: '2026-08-30T00:00:00.000Z',
    type: 'message', message: { messageId: 'assistant-5', role: 'assistant', purpose: 'conversation', content: [{ kind: 'text', text: 'Reviewed' }] },
  }]);
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  const outcome = await controller.sendToRoom('room-1', 'room-1-run-2', 'user-1', [{ kind: 'text', text: 'Continue' }]);
  await controller.waitForProjectionDrain();

  assert.equal(outcome.bindingCreated, false);
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(client.calls.find(call => call.type === 'subscribe').afterSequence, 4);
  assert.equal(rooms.get('room-1').items.at(-1).body[0].text.fallback, 'Reviewed');
});

test('hydrates every persisted active run through a new explicit bind before send or subscribe', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(70, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-1-run-1', stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/stale', target: 'host' }));
  room = createRoom({
    ...room,
    runs: room.runs.map(run => ({ ...run, status: 'completed', agentLoopCursor: 17 })),
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    () => '2026-08-31T00:00:00.000Z');

  await controller.hydrate();
  const rebound = store.rooms.get('room-1').runs[0];
  const create = client.calls.find(call => call.type === 'create-or-bind');
  const subscribe = client.calls.find(call => call.type === 'subscribe');
  assert.deepEqual(create.target, { mode: 'bind', task: stale.task });
  assert.match(create.commandId, /^chatroom-rebind-/);
  assert.notEqual(rebound.taskBinding.binding.bindingId, stale.binding.bindingId);
  assert.equal(rebound.taskBinding.task, stale.task);
  assert.equal(rebound.detailsUrl.url, 'app:task/1');
  assert.equal(rebound.rebind.state, 'accepted');
  assert.equal(rebound.rebind.operationId, create.commandId);
  assert.equal(rebound.rebind.issuedAt, '2026-08-31T00:00:00.000Z');
  assert.equal(rebound.status, 'active');
  assert.equal(rebound.agentLoopCursor, -1);
  assert.equal(subscribe.binding.binding.bindingId, rebound.taskBinding.binding.bindingId);
  assert.notEqual(subscribe.binding.binding.bindingId, stale.binding.bindingId);
  assert.equal(subscribe.afterSequence, -1);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-after-reload', [{ kind: 'text', text: 'Continue' }]);
  assert.equal(client.calls.filter(call => call.type === 'create-or-bind').length, 1);
  assert.equal(client.calls.find(call => call.type === 'send').binding.binding.bindingId,
    rebound.taskBinding.binding.bindingId);
});

test('rebinds all hydrated Rooms before replay and serializes simultaneous registry projections', async () => {
  const owner = ownerDocumentsFixture();
  let transactionInFlight = false;
  let overlappingTransactions = 0;
  const transaction = owner.client.transaction.bind(owner.client);
  owner.client.transaction = async command => {
    if (transactionInFlight) overlappingTransactions += 1;
    transactionInFlight = true;
    await new Promise(resolve => setImmediate(resolve));
    try {
      return await transaction(command);
    } finally {
      transactionInFlight = false;
    }
  };
  owner.client.replace = async command => await owner.client.transaction(command);

  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  for (const roomId of ['room-hydrate-a', 'room-hydrate-b']) {
    let durable = roomWithRuns(roomId, ['leader']);
    durable = acceptRoomRunPresence(
      durable,
      `${roomId}-run-1`,
      taskBinding(roomId, definitionFor('leader')),
      createStoredRoomRunDetailsUrl({ url: `app:task/${roomId}`, target: 'host' }),
    );
    await firstStore.upsert(durable);
  }
  firstStore.dispose();

  const store = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const client = new ImmediatePageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  await controller.hydrate();
  await controller.waitForProjectionDrain();

  assert.equal(overlappingTransactions, 0);
  for (const roomId of ['room-hydrate-a', 'room-hydrate-b']) {
    const persisted = store.rooms.get(roomId);
    assert.equal(persisted.items.length, 1);
    assert.equal(persisted.items[0].body[0].text.fallback, 'Late reply');
    assert.equal(persisted.runs[0].agentLoopCursor, 0);
    assert.equal(persisted.runs[0].publicProjections.length, 1);
  }
  assert.equal(owner.snapshot().value.rooms.every(room => room.items.length === 1), true);
  controller.dispose();
  store.dispose();
});

test('a queued precomputed mutation cannot overwrite a same-Room external CAS update', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  await firstStore.upsert(roomWithRuns('room-external-cas', ['leader']));
  const secondStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, firstStore);
  const gate = deferred();
  controller.mutationTail = gate.promise;
  const base = firstStore.rooms.get('room-external-cas');
  const pending = controller.commit(createRoom({ ...base, title: 'Controller title' }));

  await secondStore.upsert(createRoom({ ...secondStore.rooms.get('room-external-cas'), description: 'External' }));
  gate.resolve();
  await assert.rejects(
    pending,
    error => error instanceof ChatroomRoomStoreError && error.code === 'conflict' && error.recoverable,
  );
  assert.equal(firstStore.rooms.get('room-external-cas').title, 'room-external-cas');
  assert.equal(firstStore.rooms.get('room-external-cas').description, 'External');
  assert.equal(owner.snapshot().value.rooms[0].description, 'External');
  controller.dispose();
  firstStore.dispose();
  secondStore.dispose();
});

test('send enters running and exact turn completion returns the active run and user item to idle', async () => {
  const initial = roomWithRuns('room-lifecycle', ['leader']);
  const store = DurableChatroomRoomStore.memory([createRoom({
    ...initial,
    timelineSequence: 2,
    items: [{
      kind: 'message', itemId: 'user-lifecycle', messageId: 'user-message-lifecycle', sequence: 2,
      source: 'agent-loop',
      author: { participantId: 'user', role: 'human', displayName: { fallback: 'You' } },
      body: [{ kind: 'text', text: { fallback: 'Run' } }], reactions: [],
      timestamp: '2026-08-31T03:59:59.000Z', deliveryState: 'pending', runState: 'idle',
      ariaLive: 'off', actions: [],
    }],
  })]);
  class LifecycleClient extends FakeAgentLoopClient {
    async send(command) {
      const result = await super.send(command);
      this.events.set(command.binding.binding.bindingId, [
        {
          $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
          eventId: 'lifecycle-started', binding: command.binding.binding, sequence: 0,
          occurredAt: '2026-08-31T04:00:00.000Z', type: 'lifecycle',
          lifecycle: { phase: 'turn.started' }, causation: { operationId: command.commandId },
        },
        {
          $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
          eventId: 'lifecycle-completed', binding: command.binding.binding, sequence: 1,
          occurredAt: '2026-08-31T04:00:01.000Z', type: 'lifecycle',
          lifecycle: { phase: 'turn.completed' }, causation: { operationId: command.commandId },
        },
      ]);
      return result;
    }
  }
  const client = new LifecycleClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  const statuses = [];
  const stopObserving = store.rooms.subscribe(roomId => {
    statuses.push(store.rooms.get(roomId).runs[0].status);
  });
  await controller.sendToRoom(
    'room-lifecycle', 'room-lifecycle-run-1', 'user-lifecycle', [{ kind: 'text', text: 'Run' }],
  );
  await controller.waitForProjectionDrain();

  const room = store.rooms.get('room-lifecycle');
  assert.equal(room.runs[0].status, 'active');
  assert.equal(room.runs[0].agentLoopCursor, 1);
  assert.equal(room.acknowledgements[0].state, 'completed');
  assert.equal(room.items.find(item => item.itemId === 'user-lifecycle').runState, 'idle');
  assert.equal(statuses.includes('running'), true);
  assert.equal(statuses.at(-1), 'active');
  stopObserving();
});

test('reopens the owner document and atomically replaces a disposed runtime binding before registration', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(71, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-1-run-1', stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/disposed', target: 'host' }));
  await firstStore.upsert(room);
  firstStore.dispose();

  const reloadedStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, reloadedStore,
    () => '2026-08-31T01:00:00.000Z');
  await controller.hydrate();

  const persisted = owner.snapshot().value.rooms[0].runs[0];
  assert.equal(client.calls[0].type, 'create-or-bind');
  assert.deepEqual(client.calls[0].target, { mode: 'bind', task: stale.task });
  assert.notEqual(persisted.taskBinding.binding.bindingId, stale.binding.bindingId);
  assert.equal(persisted.taskBinding.task, stale.task);
  assert.equal(persisted.detailsUrl.url, 'app:task/1');
  assert.equal(persisted.rebind.state, 'accepted');
  assert.equal(client.calls[1].type, 'subscribe');
  assert.equal(client.calls[1].binding.binding.bindingId, persisted.taskBinding.binding.bindingId);
  controller.dispose();
  reloadedStore.dispose();
});

test('uses a new logical rebind cycle after an accepted reload even when provider identity is unchanged', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(72, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-1-run-1', stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/stale', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);

  const firstClient = new FakeAgentLoopClient();
  const first = new ChatroomAgentLoopController(firstClient, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    () => '2026-08-31T02:00:00.000Z');
  await first.hydrate();
  const firstAccepted = store.rooms.get('room-1').runs[0];
  first.dispose();

  const secondClient = new FakeAgentLoopClient();
  const second = new ChatroomAgentLoopController(secondClient, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    () => '2026-08-31T03:00:00.000Z');
  await second.hydrate();
  const secondAccepted = store.rooms.get('room-1').runs[0];
  assert.deepEqual(secondAccepted.taskBinding.binding, firstAccepted.taskBinding.binding,
    'fixture intentionally returns the same provider binding identity');
  assert.equal(firstAccepted.rebind.cycle, 1);
  assert.equal(secondAccepted.rebind.cycle, 2);
  assert.notEqual(secondAccepted.rebind.operationId, firstAccepted.rebind.operationId);
  assert.notEqual(secondClient.calls[0].commandId, firstClient.calls[0].commandId);
  second.dispose();
});

test('closed generation creates a new logical bind operation instead of returning prior acceptance', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const legacy = taskBinding(80, definitionFor('leader'));
  room = bindRoomRun(room, 'room-1-run-1', legacy);
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-bind-1', [{ kind: 'text', text: 'First' }]);
  const first = client.calls.find(call => call.type === 'create-or-bind');
  const active = store.rooms.get('room-1').runs[0].taskBinding;
  await store.upsert(closeRoomRun(store.rooms.get('room-1'), 'room-1-run-1', active.binding));
  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-bind-2', [{ kind: 'text', text: 'Again' }]);
  const creates = client.calls.filter(call => call.type === 'create-or-bind');
  assert.equal(creates.length, 2);
  assert.notEqual(creates[1].commandId, first.commandId);
  assert.match(creates[0].commandId, /^chatroom-bind-/);
  assert.match(creates[1].commandId, /^chatroom-bind-/);
  assert.equal(creates[1].target.task, active.task);
});

test('explicitly binds a legacy task without details and atomically replaces current binding plus URL', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const legacy = taskBinding(40, definitionFor('leader'));
  room = bindRoomRun(room, 'room-1-run-1', legacy);
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  const outcome = await controller.sendToRoom(
    'room-1', 'room-1-run-1', 'user-bind', [{ kind: 'text', text: 'Bind existing' }],
  );
  const command = client.calls.find(call => call.type === 'create-or-bind');
  assert.deepEqual(command.target, { mode: 'bind', task: legacy.task });
  assert.equal(outcome.status, 'accepted');
  assert.equal(store.rooms.get('room-1').runs[0].taskBinding.binding.bindingId, 'Opaque:Rebinding-1');
  assert.deepEqual(store.rooms.get('room-1').runs[0].detailsUrl, {
    url: 'app:task/1', target: 'host',
  });
  assert.equal(store.rooms.get('room-1').runs[0].presence.state, 'ready');
});

test('drains 64-event pull pages until hasMore is false for one exact binding cursor', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const existing = taskBinding(11, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-1-run-1', existing,
    createStoredRoomRunDetailsUrl({ url: 'app:task/11', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  client.events.set(existing.binding.bindingId, Array.from({ length: 65 }, (_, sequence) => ({
    $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
    eventId: `event-${sequence}`, binding: existing.binding, sequence,
    occurredAt: '2026-08-30T00:00:00.000Z', type: 'message',
    message: { messageId: `assistant-${sequence}`, role: 'assistant', purpose: 'conversation', content: [{ kind: 'text', text: `Reply ${sequence}` }] },
  })));
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{ kind: 'text', text: 'Drain all pages' }]);
  await controller.waitForProjectionDrain();

  assert.equal(rooms.get('room-1').runs[0].agentLoopCursor, 64);
  assert.equal(rooms.get('room-1').items.filter(item => item.kind === 'message').length, 65);
  assert.equal(rooms.get('room-1').items.at(-1).body[0].text.fallback, 'Reply 64');
});

test('keeps image-ref typed and reports unsupported on only its target run', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['reviewer'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  const outcome = await controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{
    kind: 'image-ref', ref: 'Opaque:Image-1', mediaType: 'image/png', alt: 'Screenshot',
  }]);

  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.code, 'unsupported');
  const send = client.calls.find(call => call.type === 'send');
  assert.equal(JSON.stringify(send).includes('path'), false);
  assert.equal(JSON.stringify(send).includes('base64'), false);
  assert.equal(rooms.get('room-1').runs[0].status, 'failed');
  assert.equal(rooms.get('room-1').deliveries.find(item => item.stage === 'send').attention.code,
    'send-unavailable');
});

test('drops a page delivered after controller disposal without a durable write or unhandled rejection', async () => {
  let room = roomWithRuns('room-late-page', ['leader']);
  const binding = taskBinding(91, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-late-page-run-1', binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/91', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-late-page', 'room-late-page-run-1', 'user-late', [{ kind: 'text', text: 'Before reload' }],
  );
  const before = store.rooms.get('room-late-page');
  let lateWrites = 0;
  const compareAndSwap = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (...args) => {
    lateWrites += 1;
    return await compareAndSwap(...args);
  };
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const drain = controller.waitForProjectionDrain();
  controller.dispose();
  client.page.resolve(assistantPage(binding, 0));
  await drain;
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);

  assert.equal(lateWrites, 0);
  assert.equal(store.rooms.get('room-late-page'), before);
  assert.deepEqual(unhandled, []);
});

test('unsubscribes a subscription accepted after controller disposal without starting a projection', async () => {
  let room = roomWithRuns('room-late-subscribe', ['leader']);
  const binding = taskBinding(95, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-late-subscribe-run-1', binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/95', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);
  const entered = deferred();
  const release = deferred();
  class DelayedSubscribeClient extends FakeAgentLoopClient {
    async subscribe(...args) {
      entered.resolve();
      await release.promise;
      return await super.subscribe(...args);
    }
  }
  const client = new DelayedSubscribeClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  const sending = controller.sendToRoom(
    'room-late-subscribe', 'room-late-subscribe-run-1', 'user-subscribe',
    [{ kind: 'text', text: 'Subscribe during reload' }],
  );
  await entered.promise;
  controller.dispose();
  release.resolve();
  assert.equal((await sending).status, 'accepted');
  await controller.waitForProjectionDrain();

  assert.equal(client.unsubscribed, 1);
  assert.equal(store.rooms.get('room-late-subscribe').items.some(item =>
    item.kind === 'message' && item.author.role === 'assistant'), false);
});

for (const staleOutcome of ['unavailable', 'denied', 'rejected']) {
  test(`ignores a delayed ${staleOutcome} subscription outcome from a disposed generation`, async () => {
    const roomId = `room-stale-${staleOutcome}`;
    const runId = `${roomId}-run-1`;
    let room = roomWithRuns(roomId, ['leader']);
    const binding = taskBinding(96, definitionFor('leader'));
    room = acceptRoomRunPresence(room, runId, binding,
      createStoredRoomRunDetailsUrl({ url: 'app:task/96', target: 'host' }));
    const store = DurableChatroomRoomStore.memory([room]);
    const entered = deferred();
    const release = deferred();
    class DelayedOutcomeClient extends FakeAgentLoopClient {
      async subscribe(nextBinding, afterSequence) {
        this.calls.push({ type: 'subscribe', binding: nextBinding, afterSequence });
        entered.resolve();
        await release.promise;
        if (staleOutcome === 'rejected') throw new Error('retired subscription rejection');
        return {
          status: staleOutcome,
          authorization: {
            capability: 'tasks.content.read', state: staleOutcome, code: `subscribe-${staleOutcome}`,
          },
        };
      }
    }
    const client = new DelayedOutcomeClient();
    const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
    const sending = controller.sendToRoom(
      roomId, runId, `user-${staleOutcome}`, [{ kind: 'text', text: 'Replace source' }],
    );
    await entered.promise;
    const before = store.rooms.get(roomId);
    let lateWrites = 0;
    store.compareAndSwap = async () => {
      lateWrites += 1;
      throw new Error('owner document bridge is disposed');
    };
    controller.dispose();
    release.resolve();

    assert.equal((await sending).status, 'accepted');
    assert.equal(lateWrites, 0);
    assert.equal(store.rooms.get(roomId), before);
  });
}

test('keeps live unavailable, denied, and rejected subscription outcomes observable', async () => {
  for (const liveOutcome of ['unavailable', 'denied', 'rejected']) {
    const roomId = `room-live-${liveOutcome}`;
    const runId = `${roomId}-run-1`;
    let room = roomWithRuns(roomId, ['leader']);
    const binding = taskBinding(97, definitionFor('leader'));
    room = acceptRoomRunPresence(room, runId, binding,
      createStoredRoomRunDetailsUrl({ url: 'app:task/97', target: 'host' }));
    const store = DurableChatroomRoomStore.memory([room]);
    class LiveOutcomeClient extends FakeAgentLoopClient {
      async subscribe() {
        if (liveOutcome === 'rejected') throw new Error('live subscription rejection');
        return {
          status: liveOutcome,
          authorization: {
            capability: 'tasks.content.read', state: liveOutcome, code: `subscribe-${liveOutcome}`,
          },
        };
      }
    }
    const controller = new ChatroomAgentLoopController(
      new LiveOutcomeClient(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
    );
    const sending = controller.sendToRoom(
      roomId, runId, `user-${liveOutcome}`, [{ kind: 'text', text: 'Live outcome' }],
    );
    if (liveOutcome === 'rejected') {
      await assert.rejects(sending, /live subscription rejection/);
    } else {
      const outcome = await sending;
      assert.equal(outcome.status, liveOutcome);
      assert.equal(outcome.code, `subscribe-${liveOutcome}`);
      assert.equal(store.rooms.get(roomId).runs[0].status, 'failed');
    }
    controller.dispose();
  }
});

test('a delayed rejected subscription cannot overwrite a replacement source restored from owner documents', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns('room-rejected-reload', ['leader']);
  const binding = taskBinding(98, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-rejected-reload-run-1', binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/98', target: 'host' }));
  await firstStore.upsert(room);
  const entered = deferred();
  const release = deferred();
  class RejectedSubscribeClient extends FakeAgentLoopClient {
    async subscribe() {
      entered.resolve();
      await release.promise;
      throw new Error('retired source rejected');
    }
  }
  const first = new ChatroomAgentLoopController(
    new RejectedSubscribeClient(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, firstStore,
  );
  const sending = first.sendToRoom(
    'room-rejected-reload', 'room-rejected-reload-run-1', 'user-rejected-reload',
    [{ kind: 'text', text: 'Persist before replacement' }],
  );
  await entered.promise;
  first.dispose();
  firstStore.dispose();

  const secondStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const second = new ChatroomAgentLoopController(
    new FakeAgentLoopClient(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, secondStore,
  );
  await second.hydrate();
  const replacement = secondStore.rooms.get('room-rejected-reload').runs[0].taskBinding;
  release.resolve();
  assert.equal((await sending).status, 'accepted');
  assert.equal(secondStore.rooms.get('room-rejected-reload').runs[0].taskBinding.binding.bindingId,
    replacement.binding.bindingId);
  assert.notEqual(secondStore.rooms.get('room-rejected-reload').runs[0].status, 'failed');
  second.dispose();
  secondStore.dispose();
});

test('turns a dispose-during-CAS bridge failure into a stale no-op while preserving live CAS failures', async () => {
  let room = roomWithRuns('room-cas-fence', ['leader']);
  const binding = taskBinding(92, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-cas-fence-run-1', binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/92', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  await controller.sendToRoom(
    'room-cas-fence', 'room-cas-fence-run-1', 'user-cas', [{ kind: 'text', text: 'Fence CAS' }],
  );

  const entered = deferred();
  const release = deferred();
  store.compareAndSwap = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('owner document bridge is disposed');
  };
  const drain = controller.waitForProjectionDrain();
  client.page.resolve(assistantPage(binding, 0));
  await entered.promise;
  controller.dispose();
  release.resolve();
  await drain;

  let liveRoom = roomWithRuns('room-live-cas', ['leader']);
  const liveBinding = taskBinding(93, definitionFor('leader'));
  liveRoom = acceptRoomRunPresence(liveRoom, 'room-live-cas-run-1', liveBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/93', target: 'host' }));
  const liveStore = DurableChatroomRoomStore.memory([liveRoom]);
  const liveClient = new DeferredPageAgentLoopClient();
  const liveController = new ChatroomAgentLoopController(
    liveClient, CHATROOM_DEFAULT_AGENT_CONFIGURATION, liveStore,
  );
  await liveController.sendToRoom(
    'room-live-cas', 'room-live-cas-run-1', 'user-live', [{ kind: 'text', text: 'Live CAS' }],
  );
  const liveCompareAndSwap = liveStore.compareAndSwap.bind(liveStore);
  liveStore.compareAndSwap = async () => { throw new Error('live CAS failure'); };
  liveClient.page.resolve(assistantPage(liveBinding, 0));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(liveController.waitForProjectionDrain(), /live CAS failure/,
    'a late observer still receives the settled live failure');
  await liveController.waitForProjectionDrain();

  liveStore.compareAndSwap = liveCompareAndSwap;
  liveClient.page = deferred();
  await liveController.sendToRoom(
    'room-live-cas', 'room-live-cas-run-1', 'user-healthy', [{ kind: 'text', text: 'Healthy retry' }],
  );
  const healthyDrain = liveController.waitForProjectionDrain();
  liveClient.page.resolve(assistantPage(liveBinding, 0, 'Healthy reply'));
  await healthyDrain;
  assert.equal(liveStore.rooms.get('room-live-cas').items.some(item =>
    item.kind === 'message' && item.body[0]?.text?.fallback === 'Healthy reply'), true);
  liveController.dispose();
});

test('bounds ten thousand unobserved live projection failures to one consumable generation latch', async () => {
  let room = roomWithRuns('room-failure-latch', ['leader']);
  const binding = taskBinding(99, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-failure-latch-run-1', binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/99', target: 'host' }));
  const store = DurableChatroomRoomStore.memory([room]);
  store.compareAndSwap = async () => { throw new Error('stress projection failure'); };
  const controller = new ChatroomAgentLoopController(
    new ImmediatePageAgentLoopClient(), CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      await controller.ensureSubscribed(room, 'room-failure-latch-run-1', binding);
      while (controller.projections.size > 0) await Promise.resolve();
    }
    await Promise.resolve();
    assert.equal(Array.isArray(controller.projectionFailure), false);
    assert.equal(controller.projectionFailure.generation, controller.controllerGeneration);
    assert.match(controller.projectionFailure.error.message, /stress projection failure/);
    await assert.rejects(controller.waitForProjectionDrain(), /stress projection failure/);
    await controller.waitForProjectionDrain();

    await controller.ensureSubscribed(room, 'room-failure-latch-run-1', binding);
    while (controller.projections.size > 0) await Promise.resolve();
    await Promise.resolve();
    assert.notEqual(controller.projectionFailure, undefined);
    controller.dispose();
    assert.equal(controller.projectionFailure, undefined);
    await controller.waitForProjectionDrain();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    controller.dispose();
  }
});

test('reload source replacement restores Rooms and fences the disposed source late page', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns('room-source-reload', ['leader']);
  const stale = taskBinding(94, definitionFor('leader'));
  room = acceptRoomRunPresence(room, 'room-source-reload-run-1', stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/94', target: 'host' }));
  await firstStore.upsert(room);
  const firstClient = new DeferredPageAgentLoopClient();
  const first = new ChatroomAgentLoopController(
    firstClient, CHATROOM_DEFAULT_AGENT_CONFIGURATION, firstStore,
  );
  await first.hydrate();
  const retiredRun = firstStore.rooms.get('room-source-reload').runs[0];
  const retiredBinding = retiredRun.taskBinding;
  const firstDrain = first.waitForProjectionDrain();
  first.dispose();
  firstStore.dispose();
  let retiredWrites = 0;
  firstStore.compareAndSwap = async () => {
    retiredWrites += 1;
    throw new Error('owner document bridge is disposed');
  };

  const reloadedStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const secondClient = new FakeAgentLoopClient();
  const second = new ChatroomAgentLoopController(
    secondClient, CHATROOM_DEFAULT_AGENT_CONFIGURATION, reloadedStore,
  );
  await second.hydrate();
  const restored = reloadedStore.rooms.get('room-source-reload');
  const replacementBinding = restored.runs[0].taskBinding;
  assert.equal(restored.runs[0].rebind.cycle, retiredRun.rebind.cycle + 1);
  assert.notEqual(restored.runs[0].rebind.operationId, retiredRun.rebind.operationId);
  assert.equal(restored.id, 'room-source-reload');

  firstClient.page.resolve(assistantPage(retiredBinding, 0, 'Retired source reply'));
  await firstDrain;
  assert.equal(retiredWrites, 0);
  assert.equal(reloadedStore.rooms.get('room-source-reload').runs[0].taskBinding.binding.bindingId,
    replacementBinding.binding.bindingId);
  assert.equal(reloadedStore.rooms.get('room-source-reload').items.some(item =>
    item.kind === 'message' && item.body[0]?.text?.fallback === 'Retired source reply'), false);
  second.dispose();
  reloadedStore.dispose();
});

test('unsubscribes every active run stream and disposes the bound client', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader', 'reviewer'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  client.live = true;
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{ kind: 'text', text: 'Lead' }]);
  await controller.sendToRoom('room-1', 'room-1-run-2', 'user-2', [{ kind: 'text', text: 'Review' }]);
  controller.dispose();
  await controller.waitForProjectionDrain();

  assert.equal(client.unsubscribed, 2);
  assert.equal(client.disposed, true);
});
