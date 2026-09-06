import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';
import {
  acceptRoomRunPresence,
  createStoredRoomRunDetailsUrl,
  prepareRoomAcknowledgement,
} from '../../dist/room-engagement.js';

import {
  assistantPage,
  deferred,
  DeferredPageAgentLoopClient,
  definitionFor,
  FakeAgentLoopClient,
  ImmediatePageAgentLoopClient,
  ownerDocumentsFixture,
  roomWithRuns,
  taskBinding,
} from './fixtures.mjs';

test('drops a page delivered after controller disposal without a durable write or unhandled rejection', async () => {
  let room = roomWithRuns('room-late-page', ['leader']);
  const binding = taskBinding(91, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-late-page-run-1',
    binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/91', target: 'host' }),
  );
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);

  await controller.sendToRoom(
    'room-late-page',
    'room-late-page-run-1',
    'user-late',
    [{ kind: 'text', text: 'Before reload' }],
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
  room = acceptRoomRunPresence(
    room,
    'room-late-subscribe-run-1',
    binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/95', target: 'host' }),
  );
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
    'room-late-subscribe',
    'room-late-subscribe-run-1',
    'user-subscribe',
    [{ kind: 'text', text: 'Subscribe during reload' }],
  );
  await entered.promise;
  controller.dispose();
  release.resolve();
  assert.equal((await sending).status, 'accepted');
  await controller.waitForProjectionDrain();

  assert.equal(client.unsubscribed, 1);
  assert.equal(
    store.rooms.get('room-late-subscribe').items.some(item =>
      item.kind === 'message' && item.author.role === 'assistant'
    ),
    false,
  );
});

for (const staleOutcome of ['unavailable', 'denied', 'rejected']) {
  test(`ignores a delayed ${staleOutcome} subscription outcome from a disposed generation`, async () => {
    const roomId = `room-stale-${staleOutcome}`;
    const runId = `${roomId}-run-1`;
    let room = roomWithRuns(roomId, ['leader']);
    const binding = taskBinding(96, definitionFor('leader'));
    room = acceptRoomRunPresence(
      room,
      runId,
      binding,
      createStoredRoomRunDetailsUrl({ url: 'app:task/96', target: 'host' }),
    );
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
            capability: 'tasks.content.read',
            state: staleOutcome,
            code: `subscribe-${staleOutcome}`,
          },
        };
      }
    }
    const client = new DelayedOutcomeClient();
    const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
    const sending = controller.sendToRoom(
      roomId,
      runId,
      `user-${staleOutcome}`,
      [{ kind: 'text', text: 'Replace source' }],
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
    room = acceptRoomRunPresence(
      room,
      runId,
      binding,
      createStoredRoomRunDetailsUrl({ url: 'app:task/97', target: 'host' }),
    );
    const store = DurableChatroomRoomStore.memory([room]);
    class LiveOutcomeClient extends FakeAgentLoopClient {
      async subscribe() {
        if (liveOutcome === 'rejected') throw new Error('live subscription rejection');
        return {
          status: liveOutcome,
          authorization: {
            capability: 'tasks.content.read',
            state: liveOutcome,
            code: `subscribe-${liveOutcome}`,
          },
        };
      }
    }
    const controller = new ChatroomAgentLoopController(
      new LiveOutcomeClient(),
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const sending = controller.sendToRoom(
      roomId,
      runId,
      `user-${liveOutcome}`,
      [{ kind: 'text', text: 'Live outcome' }],
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
  room = acceptRoomRunPresence(
    room,
    'room-rejected-reload-run-1',
    binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/98', target: 'host' }),
  );
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
    new RejectedSubscribeClient(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    firstStore,
  );
  const sending = first.sendToRoom(
    'room-rejected-reload',
    'room-rejected-reload-run-1',
    'user-rejected-reload',
    [{ kind: 'text', text: 'Persist before replacement' }],
  );
  await entered.promise;
  first.dispose();
  firstStore.dispose();

  const secondStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const second = new ChatroomAgentLoopController(
    new FakeAgentLoopClient(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    secondStore,
  );
  await second.hydrate();
  const replacement = secondStore.rooms.get('room-rejected-reload').runs[0].taskBinding;
  release.resolve();
  assert.equal((await sending).status, 'accepted');
  assert.equal(
    secondStore.rooms.get('room-rejected-reload').runs[0].taskBinding.binding.bindingId,
    replacement.binding.bindingId,
  );
  assert.notEqual(secondStore.rooms.get('room-rejected-reload').runs[0].status, 'failed');
  second.dispose();
  secondStore.dispose();
});

test('turns a dispose-during-CAS bridge failure into a stale no-op while preserving live CAS failures', async () => {
  let room = roomWithRuns('room-cas-fence', ['leader']);
  const binding = taskBinding(92, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-cas-fence-run-1',
    binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/92', target: 'host' }),
  );
  const store = DurableChatroomRoomStore.memory([room]);
  const client = new DeferredPageAgentLoopClient();
  const controller = new ChatroomAgentLoopController(client, CHATROOM_DEFAULT_AGENT_CONFIGURATION, store);
  await controller.sendToRoom(
    'room-cas-fence',
    'room-cas-fence-run-1',
    'user-cas',
    [{ kind: 'text', text: 'Fence CAS' }],
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
  liveRoom = acceptRoomRunPresence(
    liveRoom,
    'room-live-cas-run-1',
    liveBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/93', target: 'host' }),
  );
  const liveStore = DurableChatroomRoomStore.memory([liveRoom]);
  const liveClient = new DeferredPageAgentLoopClient();
  const liveController = new ChatroomAgentLoopController(
    liveClient,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    liveStore,
  );
  await liveController.sendToRoom(
    'room-live-cas',
    'room-live-cas-run-1',
    'user-live',
    [{ kind: 'text', text: 'Live CAS' }],
  );
  const liveCompareAndSwap = liveStore.compareAndSwap.bind(liveStore);
  liveStore.compareAndSwap = async () => {
    throw new Error('live CAS failure');
  };
  liveClient.page.resolve(assistantPage(liveBinding, 0));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    liveController.waitForProjectionDrain(),
    /live CAS failure/,
    'a late observer still receives the settled live failure',
  );
  await liveController.waitForProjectionDrain();

  liveStore.compareAndSwap = liveCompareAndSwap;
  liveClient.page = deferred();
  await liveController.sendToRoom(
    'room-live-cas',
    'room-live-cas-run-1',
    'user-healthy',
    [{ kind: 'text', text: 'Healthy retry' }],
  );
  const healthyDrain = liveController.waitForProjectionDrain();
  liveClient.page.resolve(assistantPage(
    liveBinding,
    0,
    'Healthy reply',
    liveClient.acceptedDeliveries.get(liveBinding.binding.bindingId),
  ));
  await healthyDrain;
  assert.equal(
    liveStore.rooms.get('room-live-cas').items.some(item =>
      item.kind === 'message' && item.body[0]?.text?.fallback === 'Healthy reply'
    ),
    true,
  );
  liveController.dispose();
});

test('bounds ten thousand unobserved live projection failures to one consumable generation latch', async () => {
  let room = roomWithRuns('room-failure-latch', ['leader']);
  const binding = taskBinding(99, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-failure-latch-run-1',
    binding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/99', target: 'host' }),
  );
  room = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-failure-latch',
    memberId: 'leader',
    runId: 'room-failure-latch-run-1',
  }).room;
  const store = DurableChatroomRoomStore.memory([room]);
  store.compareAndSwap = async () => {
    throw new Error('stress projection failure');
  };
  const controller = new ChatroomAgentLoopController(
    new ImmediatePageAgentLoopClient(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      await controller.ensureSubscribed(room, 'room-failure-latch-run-1', binding);
      while (controller.projections.size > 0) await Promise.resolve();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Array.isArray(controller.projectionFailure), false);
    assert.equal(controller.projectionFailure.generation, controller.controllerGeneration);
    assert.match(controller.projectionFailure.error.message, /stress projection failure/);
    await assert.rejects(controller.waitForProjectionDrain(), /stress projection failure/);
    await controller.waitForProjectionDrain();

    await controller.ensureSubscribed(room, 'room-failure-latch-run-1', binding);
    while (controller.projections.size > 0) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
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

test('reload source replacement preserves Rooms and fences the disposed source late page', async () => {
  const owner = ownerDocumentsFixture();
  const firstStore = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  let room = roomWithRuns('room-source-reload', ['leader']);
  const stale = taskBinding(94, definitionFor('leader'));
  room = acceptRoomRunPresence(
    room,
    'room-source-reload-run-1',
    stale,
    createStoredRoomRunDetailsUrl({ url: 'app:task/94', target: 'host' }),
  );
  await firstStore.upsert(room);
  const firstClient = new DeferredPageAgentLoopClient();
  const first = new ChatroomAgentLoopController(
    firstClient,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    firstStore,
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
    secondClient,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    reloadedStore,
  );
  await second.hydrate();
  const restored = reloadedStore.rooms.get('room-source-reload');
  const replacementBinding = restored.runs[0].taskBinding;
  assert.deepEqual(replacementBinding.binding, retiredBinding.binding);
  assert.equal(restored.runs[0].rebind, undefined);
  assert.equal(retiredRun.rebind, undefined);
  assert.equal(restored.id, 'room-source-reload');

  firstClient.page.resolve(assistantPage(retiredBinding, 0, 'Retired source reply'));
  await firstDrain;
  assert.equal(retiredWrites, 0);
  assert.equal(
    reloadedStore.rooms.get('room-source-reload').runs[0].taskBinding.binding.bindingId,
    replacementBinding.binding.bindingId,
  );
  assert.equal(
    reloadedStore.rooms.get('room-source-reload').items.some(item =>
      item.kind === 'message' && item.body[0]?.text?.fallback === 'Retired source reply'
    ),
    false,
  );
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
