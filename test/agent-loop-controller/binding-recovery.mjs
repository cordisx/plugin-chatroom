import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import {
  canonicalRoomPayloadHash,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  prepareRoomOutboxDelivery,
} from '../../dist/room-delivery.js';
import { bindRoomRun, createRoom } from '../../dist/room.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';
import {
  acceptRoomRunPresence,
  createStoredRoomRunDetailsUrl,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../../dist/room-engagement.js';

import {
  acceptedTurnFor,
  definitionFor,
  FakeAgentLoopClient,
  ImmediatePageAgentLoopClient,
  ownerDocumentsFixture,
  roomWithRuns,
  taskBinding,
} from './fixtures.mjs';

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
    'room-1',
    'room-1-run-1',
    'user-same',
    [{ kind: 'text', text: 'Different command' }],
  );
  assert.equal(conflict.status, 'unavailable');
  assert.equal(rooms.get('room-1').deliveries.find(item => item.stage === 'send').attention.code, 'operation-conflict');
});

test('never replays a create operation when the rebuilt catalog command hash changed', async () => {
  const roomId = 'room-1';
  const runId = 'room-1-run-1';
  const userItemId = 'user-1';
  const stablePart = value => `${value.length}:${value}`;
  const createOperationId = `chatroom-create-${canonicalRoomPayloadHash({ roomId, runId }).slice('sha256.'.length)}`;
  const sendOperationId = `chatroom-send-${
    canonicalRoomPayloadHash({ roomId, runId, userItemId }).slice('sha256.'.length)
  }`;
  assert.match(createOperationId, /^chatroom-create-[a-f0-9]{64}$/);
  assert.match(sendOperationId, /^chatroom-send-[a-f0-9]{64}$/);
  const deliveryId = `chatroom:delivery:${stablePart(roomId)}${stablePart(runId)}${stablePart(userItemId)}`;
  let room = roomWithRuns(roomId, ['leader']);
  const acknowledgement = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId,
    memberId: 'leader',
    runId,
  });
  room = markRoomAcknowledgementSent(
    acknowledgement.room,
    acknowledgement.acknowledgement.acknowledgementKey,
  );
  room = prepareRoomOutboxDelivery(room, {
    deliveryId,
    userItemId,
    memberId: 'leader',
    runId,
    createOperationId,
    sendOperationId,
  }).room;
  room = planRoomDelivery(room, {
    deliveryId,
    operationId: createOperationId,
    userItemId,
    participantId: 'leader',
    memberId: 'leader',
    runId,
    issuedAt: '2026-08-31T00:00:00.000Z',
    operation: { kind: 'create', payload: { commandId: createOperationId, type: 'create-or-bind' } },
  }).room;
  room = markRoomDeliverySendingUnknown(room, createOperationId);
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.recoverUnknownDeliveries(roomId, controller.controllerGeneration);
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
  const first = new ChatroomAgentLoopController(
    unknown,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => '2026-08-31T00:00:00.000Z',
  );
  await assert.rejects(
    first.sendToRoom(
      'room-1',
      'room-1-run-1',
      'user-unknown',
      [{ kind: 'text', text: 'Recover' }],
      'runtime-1',
    ),
    /outcome unknown/,
  );
  const pending = store.rooms.get('room-1').deliveries.find(delivery => delivery.stage === 'create');
  assert.equal(pending.state, 'sending-unknown');

  const replay = new FakeAgentLoopClient();
  const second = new ChatroomAgentLoopController(
    replay,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => '2026-08-31T00:00:10.000Z',
  );
  await second.recoverUnknownDeliveries('room-1', second.controllerGeneration);
  const replayed = replay.calls.find(call => call.type === 'create-or-bind');
  assert.equal(replayed.commandId, pending.operationId);
  assert.equal(
    store.rooms.get('room-1').deliveries
      .find(delivery => delivery.operationId === pending.operationId).state,
    'accepted',
  );
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
    new UnknownBindClient(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await assert.rejects(
    first.sendToRoom(
      'room-1',
      'room-1-run-1',
      'user-bind-unknown',
      [{ kind: 'text', text: 'Recover bind' }],
      'runtime-1',
    ),
    /outcome unknown/,
  );

  class IdentityPreservingClient extends FakeAgentLoopClient {
    async createOrBind(command) {
      this.calls.push(command);
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
        contract: 'cordisx.agent-loop-result/v4',
        schemaVersion: 4,
        commandId: command.commandId,
        type: 'create-or-bind',
        status: 'accepted',
        authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
        binding: stale,
        detailsUrl: { url: 'app:task/recovered', target: 'host' },
        delivery: { disposition: 'reconciled' },
      };
    }
  }
  const replay = new IdentityPreservingClient();
  const second = new ChatroomAgentLoopController(replay, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  const recovered = await second.recoverUnknownDeliveries('room-1', second.controllerGeneration);
  assert.equal(replay.calls.filter(call => call.type === 'create-or-bind').length, 1);
  assert.equal(replay.calls.filter(call => call.type === 'subscribe').length, 0);
  assert.equal(recovered.subscriptions.length, 1);
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
  room = acceptRoomRunPresence(
    room,
    'room-1-run-2',
    existing,
    createStoredRoomRunDetailsUrl({ url: 'app:task/9', target: 'host' }),
  );
  room = createRoom({
    ...room,
    runs: room.runs.map(run => run.runId === 'room-1-run-2' ? { ...run, agentLoopCursor: 4 } : run),
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  client.events.set(existing.binding.bindingId, [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-5',
    binding: existing.binding,
    sequence: 5,
    occurredAt: '2026-08-30T00:00:00.000Z',
    type: 'message',
    turn: acceptedTurnFor(existing),
    message: {
      messageId: 'assistant-5',
      role: 'assistant',
      purpose: 'conversation',
      content: [{ kind: 'text', text: 'Reviewed' }],
    },
  }]);
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  const outcome = await controller.sendToRoom('room-1', 'room-1-run-2', 'user-1', [{ kind: 'text', text: 'Continue' }]);
  await controller.waitForProjectionDrain();

  assert.equal(outcome.bindingCreated, false);
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(client.calls.find(call => call.type === 'subscribe').afterSequence, 4);
  assert.equal(rooms.get('room-1').items.at(-1).body[0].text.fallback, 'Reviewed');
});

test('probes every persisted active run without mutating its durable binding', async () => {
  let room = roomWithRuns('room-1', ['leader']);
  const stale = taskBinding(70, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-1-run-1',
    stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/stale', target: 'host' }),
  );
  room = createRoom({
    ...room,
    runs: room.runs.map(run => ({ ...run, status: 'completed', agentLoopCursor: 17 })),
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => '2026-08-31T00:00:00.000Z',
  );

  await controller.hydrate();
  const hydrated = store.rooms.get('room-1').runs[0];
  const subscribe = client.calls.find(call => call.type === 'subscribe');
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(hydrated.taskBinding.binding.bindingId, stale.binding.bindingId);
  assert.equal(hydrated.detailsUrl.url, 'app:task/stale');
  assert.equal(hydrated.rebind, undefined);
  assert.equal(hydrated.status, 'completed');
  assert.equal(hydrated.agentLoopCursor, 17);
  assert.equal(subscribe.binding.binding.bindingId, stale.binding.bindingId);
  assert.equal(subscribe.afterSequence, 17);
  assert.equal(controller.isRunLocallyUnavailable('room-1', 'room-1-run-1'), false);

  await controller.sendToRoom(
    'room-1',
    'room-1-run-1',
    'user-after-reload',
    [{ kind: 'text', text: 'Continue' }],
    'runtime-1',
  );
  assert.equal(client.calls.filter(call => call.type === 'create-or-bind').length, 0);
  assert.equal(client.calls.find(call => call.type === 'send').binding.binding.bindingId, stale.binding.bindingId);
});

test('probes all hydrated Rooms without replaying or mutating registry projections', async () => {
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
  assert.equal(client.calls.filter(call => call.type === 'subscribe').length, 2);
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  for (const roomId of ['room-hydrate-a', 'room-hydrate-b']) {
    const persisted = store.rooms.get(roomId);
    assert.equal(persisted.items.length, 0);
    assert.equal(persisted.runs[0].agentLoopCursor, -1);
    assert.equal(persisted.runs[0].publicProjections.length, 0);
  }
  assert.equal(owner.snapshot().value.rooms.every(room => room.items.length === 0), true);
  controller.dispose();
  store.dispose();
});
