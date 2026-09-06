import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { bindRoomRun, closeRoomRun, createRoom } from '../../dist/room.js';
import { ChatroomRoomStoreError, DurableChatroomRoomStore } from '../../dist/room-store.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../../dist/room-engagement.js';

import {
  acceptedTurnFor,
  deferred,
  definitionFor,
  FakeAgentLoopClient,
  ownerDocumentsFixture,
  roomWithRuns,
  taskBinding,
} from './fixtures.mjs';

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
      kind: 'message',
      itemId: 'user-lifecycle',
      messageId: 'user-message-lifecycle',
      sequence: 2,
      source: 'agent-loop',
      author: { participantId: 'user', role: 'human', displayName: { fallback: 'You' } },
      body: [{ kind: 'text', text: { fallback: 'Run' } }],
      reactions: [],
      timestamp: '2026-08-31T03:59:59.000Z',
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    }],
  })]);
  class LifecycleClient extends FakeAgentLoopClient {
    async send(command) {
      const result = await super.send(command);
      this.events.set(command.binding.binding.bindingId, [
        {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
          contract: 'cordisx.agent-loop-event/v4',
          schemaVersion: 4,
          eventId: 'lifecycle-started',
          binding: command.binding.binding,
          sequence: 0,
          occurredAt: '2026-08-31T04:00:00.000Z',
          type: 'lifecycle',
          lifecycle: { phase: 'turn.started' },
          causation: { operationId: command.commandId },
        },
        {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
          contract: 'cordisx.agent-loop-event/v4',
          schemaVersion: 4,
          eventId: 'lifecycle-completed',
          binding: command.binding.binding,
          sequence: 1,
          occurredAt: '2026-08-31T04:00:01.000Z',
          type: 'lifecycle',
          lifecycle: { phase: 'turn.completed' },
          causation: { operationId: command.commandId },
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
    'room-lifecycle',
    'room-lifecycle-run-1',
    'user-lifecycle',
    [{ kind: 'text', text: 'Run' }],
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

test('reopens the owner document and probes its durable binding before registration', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(71, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-1-run-1',
    stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/disposed', target: 'host' }),
  );
  await firstStore.upsert(room);
  firstStore.dispose();

  const reloadedStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    reloadedStore,
    () => '2026-08-31T01:00:00.000Z',
  );
  await controller.hydrate();

  const persisted = owner.snapshot().value.rooms[0].runs[0];
  assert.equal(client.calls[0].type, 'subscribe');
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(persisted.taskBinding.binding.bindingId, stale.binding.bindingId);
  assert.equal(persisted.taskBinding.task, stale.task);
  assert.equal(persisted.detailsUrl.url, 'app:task/disposed');
  assert.equal(persisted.rebind, undefined);
  assert.equal(client.calls[0].binding.binding.bindingId, persisted.taskBinding.binding.bindingId);
  controller.dispose();
  reloadedStore.dispose();
});

test('repeated hydration probes preserve one durable binding without minting rebind cycles', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(72, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-1-run-1',
    stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/stale', target: 'host' }),
  );
  const store = DurableChatroomRoomStore.memory([room]);

  const firstClient = new FakeAgentLoopClient();
  const first = new ChatroomAgentLoopController(
    firstClient,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => '2026-08-31T02:00:00.000Z',
  );
  await first.hydrate();
  const firstAccepted = store.rooms.get('room-1').runs[0];
  first.dispose();

  const secondClient = new FakeAgentLoopClient();
  const second = new ChatroomAgentLoopController(
    secondClient,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => '2026-08-31T03:00:00.000Z',
  );
  await second.hydrate();
  const secondAccepted = store.rooms.get('room-1').runs[0];
  assert.deepEqual(secondAccepted.taskBinding.binding, firstAccepted.taskBinding.binding);
  assert.equal(firstAccepted.rebind, undefined);
  assert.equal(secondAccepted.rebind, undefined);
  assert.equal(firstClient.calls[0].type, 'subscribe');
  assert.equal(secondClient.calls[0].type, 'subscribe');
  assert.equal(firstClient.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(secondClient.calls.some(call => call.type === 'create-or-bind'), false);
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
    'room-1',
    'room-1-run-1',
    'user-bind',
    [{ kind: 'text', text: 'Bind existing' }],
  );
  const command = client.calls.find(call => call.type === 'create-or-bind');
  assert.deepEqual(command.target, { mode: 'bind', task: legacy.task });
  assert.equal(outcome.status, 'accepted');
  assert.equal(store.rooms.get('room-1').runs[0].taskBinding.binding.bindingId, 'Opaque:Rebinding-1');
  assert.deepEqual(store.rooms.get('room-1').runs[0].detailsUrl, {
    url: 'app:task/1',
    target: 'host',
  });
  assert.equal(store.rooms.get('room-1').runs[0].presence.state, 'ready');
});

test('drains 64-event pull pages until hasMore is false for one exact binding cursor', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const existing = taskBinding(11, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-1-run-1',
    existing,
    createStoredRoomRunDetailsUrl({ url: 'app:task/11', target: 'host' }),
  );
  const store = DurableChatroomRoomStore.memory([room]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  client.events.set(
    existing.binding.bindingId,
    Array.from({ length: 65 }, (_, sequence) => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
      contract: 'cordisx.agent-loop-event/v4',
      schemaVersion: 4,
      eventId: `event-${sequence}`,
      binding: existing.binding,
      sequence,
      occurredAt: '2026-08-30T00:00:00.000Z',
      type: 'message',
      turn: acceptedTurnFor(existing),
      message: {
        messageId: `assistant-${sequence}`,
        role: 'assistant',
        purpose: 'conversation',
        content: [{ kind: 'text', text: `Reply ${sequence}` }],
      },
    })),
  );
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
    kind: 'image-ref',
    ref: 'Opaque:Image-1',
    mediaType: 'image/png',
    alt: 'Screenshot',
  }]);

  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.code, 'unsupported');
  const send = client.calls.find(call => call.type === 'send');
  assert.equal(JSON.stringify(send).includes('path'), false);
  assert.equal(JSON.stringify(send).includes('base64'), false);
  assert.equal(rooms.get('room-1').runs[0].status, 'failed');
  assert.equal(rooms.get('room-1').deliveries.find(item => item.stage === 'send').attention.code, 'send-unavailable');
});
