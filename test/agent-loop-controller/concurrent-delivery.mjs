import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../../dist/agent-loop-projection.js';
import { createRoom } from '../../dist/room.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../../dist/room-engagement.js';

import {
  acceptConversationDelivery,
  assistantPage,
  DeferredPageAgentLoopClient,
  definitionFor,
  FakeAgentLoopClient,
  ImmediatePageAgentLoopClient,
  InterleavedReviewerCreateClient,
  roomWithRuns,
  taskBinding,
} from './fixtures.mjs';

test('creates isolated bindings for two members in one Room and never cross-streams them', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-1', ['leader', 'reviewer'])]);
  const rooms = store.rooms;
  const client = new FakeAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom('room-1', 'room-1-run-1', 'user-1', [{ kind: 'text', text: 'Lead' }]);
  await controller.sendToRoom('room-1', 'room-1-run-2', 'user-2', [{ kind: 'text', text: 'Review' }]);

  const room = rooms.get('room-1');
  assert.deepEqual(client.calls.filter(call => call.type === 'create-or-bind').map(call => call.definition.agentId), [
    'chatroom.generalist',
    'chatroom.reviewer',
  ]);
  assert.deepEqual(
    client.calls.filter(call => call.type === 'create-or-bind').map(call =>
      call.definitions.map(definition => definition.identity.agentId)
    ),
    [
      ['chatroom.generalist'],
      ['chatroom.generalist', 'chatroom.reviewer'],
    ],
  );
  assert.notEqual(room.runs[0].taskBinding.binding.bindingId, room.runs[1].taskBinding.binding.bindingId);
  assert.notEqual(room.runs[0].taskBinding.task, room.runs[1].taskBinding.task);
  assert.deepEqual(room.runs.map(run => [run.memberId, run.presence.state]), [
    ['leader', 'ready'],
    ['reviewer', 'ready'],
  ]);
  const fanoutCommands = client.calls.filter(call => call.type === 'send');
  assert.notEqual(fanoutCommands[0].commandId, fanoutCommands[1].commandId);
  for (const command of client.calls.filter(call => call.type === 'create-or-bind' || call.type === 'send')) {
    const persisted = room.deliveries.find(delivery => delivery.operationId === command.commandId);
    assert.match(persisted.canonicalPayload, /^sha256\.[0-9a-f]{64}$/);
    assert.equal(persisted.operation.payload.commandId, command.commandId);
    assert.equal(persisted.operation.payload.canonicalHash, persisted.canonicalPayload);
    assert.doesNotMatch(
      JSON.stringify(persisted.operation.payload),
      /promptSections|personality|memory-policy|"content"|Retry me|Lead|Review/,
    );
    if (command.type === 'create-or-bind') {
      assert.deepEqual(
        persisted.operation.payload.definitions,
        command.definitions.map(definition => definition.identity),
      );
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
    'room-fanout',
    'room-fanout-run-1',
    'user-lead',
    [{ kind: 'text', text: 'Lead request' }],
  );
  await controller.waitForProjectionDrain();
  await controller.sendToRoom(
    'room-fanout',
    'room-fanout-run-2',
    'user-reviewer',
    [{ kind: 'text', text: 'Review request' }],
  );
  await controller.waitForProjectionDrain();

  const room = store.rooms.get('room-fanout');
  assert.deepEqual(room.runs.map(run => run.agentLoopCursor), [1, 1]);
  assert.deepEqual(room.items.filter(item => item.kind === 'message').map(item => item.author.participantId).sort(), [
    'leader',
    'reviewer',
  ]);
  assert.equal(room.acknowledgements.length, 2);
  assert.equal(room.deliveries.filter(delivery => delivery.stage === 'send').length, 2);
  controller.dispose();
});

test('merges a Lead event that lands while a Reviewer create result is in flight', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-interleaved-create', ['leader', 'reviewer'])]);
  const client = new InterleavedReviewerCreateClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-interleaved-create',
    'room-interleaved-create-run-1',
    'user-lead',
    [{ kind: 'text', text: 'Lead request' }],
  );
  const leadBinding = store.rooms.get('room-interleaved-create').runs[0].taskBinding;
  const reviewer = controller.sendToRoom(
    'room-interleaved-create',
    'room-interleaved-create-run-2',
    'user-reviewer',
    [{ kind: 'text', text: 'Review request' }],
  );
  await client.secondCreateStarted.promise;
  client.page.resolve(assistantPage(
    leadBinding,
    0,
    'Lead event during Reviewer create',
    client.acceptedDeliveries.get(leadBinding.binding.bindingId),
  ));
  await new Promise(resolve => setImmediate(resolve));
  client.releaseSecondCreate.resolve();

  assert.equal((await reviewer).status, 'accepted');
  await controller.waitForProjectionDrain();
  const room = store.rooms.get('room-interleaved-create');
  assert.equal(room.runs[1].taskBinding?.state, 'active');
  assert.equal(room.runs[0].agentLoopCursor, 1);
  assert.equal(room.items.some(item => item.kind === 'message' && item.author.participantId === 'leader'), true);
  controller.dispose();
});

test('plans a Reviewer create against the latest Room when a Lead event lands first', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRuns('room-interleaved-plan', ['leader', 'reviewer'])]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-interleaved-plan',
    'room-interleaved-plan-run-1',
    'user-lead',
    [{ kind: 'text', text: 'Lead request' }],
  );
  const leadBinding = store.rooms.get('room-interleaved-plan').runs[0].taskBinding;
  const reviewer = controller.sendToRoom(
    'room-interleaved-plan',
    'room-interleaved-plan-run-2',
    'user-reviewer',
    [{ kind: 'text', text: 'Review request' }],
  );
  client.page.resolve(assistantPage(
    leadBinding,
    0,
    'Lead event before Reviewer create planning',
    client.acceptedDeliveries.get(leadBinding.binding.bindingId),
  ));

  assert.equal((await reviewer).status, 'accepted');
  await controller.waitForProjectionDrain();
  const room = store.rooms.get('room-interleaved-plan');
  assert.equal(room.runs[1].taskBinding?.state, 'active');
  assert.equal(room.runs[0].agentLoopCursor, 1);
  assert.equal(room.items.some(item => item.kind === 'message' && item.author.participantId === 'leader'), true);
  controller.dispose();
});

test('latches a live incompatible projection collision without advancing the run cursor', async () => {
  let room = roomWithRuns('room-collision', ['leader']);
  const active = taskBinding(301, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-collision-run-1',
    active,
    createStoredRoomRunDetailsUrl({ url: 'app:task/collision', target: 'host' }),
  );
  const accepted = acceptConversationDelivery(room, 'room-collision-run-1', 'fixture-user', active);
  room = accepted.room;
  const collisionEvent = assistantPage(active, 0, 'Late reply', accepted.acceptance).events[0];
  const derived = projectAgentLoopEvent(room, 'room-collision-run-1', collisionEvent).room.items[0];
  room = createRoom({
    ...room,
    timelineSequence: room.timelineSequence + 1,
    items: [{
      kind: 'status',
      itemId: derived.itemId,
      sequence: room.timelineSequence + 1,
      label: { fallback: 'Unrelated status' },
      state: 'info',
      ariaLive: 'off',
    }],
  });
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new ImmediatePageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-collision',
    'room-collision-run-1',
    'user-collision',
    [{ kind: 'text', text: 'Trigger' }],
  );
  await controller.waitForProjectionDrain();
  assert.equal(store.rooms.get('room-collision').runs[0].agentLoopCursor, -1);
  assert.equal(store.rooms.get('room-collision').items[0].kind, 'status');
  assert.equal(store.rooms.get('room-collision').runs[0].presence.failure.code, 'event-projection-failed');
  controller.dispose();
});
