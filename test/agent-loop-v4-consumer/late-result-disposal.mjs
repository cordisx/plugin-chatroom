import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

import { binding, deferred, readyRoom, roomWithRun, V4Client } from './fixtures.mjs';

test('dispose fences accepted, denied, and rejected send outcomes before CAS or subscribe', async t => {
  for (const outcomeKind of ['accepted', 'denied', 'rejected']) {
    await t.test(outcomeKind, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredSendClient extends V4Client {
        async send(command) {
          this.calls.push(command);
          started.resolve(command);
          return await result.promise;
        }
      }
      const roomId = `room-send-${outcomeKind}`;
      const store = DurableChatroomRoomStore.memory([readyRoom(roomId)]);
      const client = new DeferredSendClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.sendToRoom(
        roomId,
        'run-lead',
        `user-${outcomeKind}`,
        [{ kind: 'text', text: outcomeKind }],
      );
      const command = await started.promise;
      controller.dispose();
      if (outcomeKind === 'accepted') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'accepted',
          authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
          binding: command.binding,
          messageId: 'message-late-send',
          turn: 'turn-late-send',
          delivery: { disposition: 'executed' },
        });
      } else if (outcomeKind === 'denied') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'denied',
          authorization: { capability: 'turns.submit', state: 'denied', code: 'permission-denied' },
          code: 'permission-denied',
        });
      } else {
        result.reject(new Error('late rejected send'));
      }
      assert.deepEqual(await pending, {
        status: 'unavailable',
        roomId,
        runId: 'run-lead',
        bindingCreated: false,
        code: 'controller-replaced',
      });
      assert.equal(client.calls.filter(call => call.type === 'subscribe').length, 0);
      const sendDelivery = store.rooms.get(roomId).deliveries
        .find(delivery => delivery.operation.kind === 'send');
      assert.equal(sendDelivery.state, 'sending-unknown');
      assert.equal(sendDelivery.acceptance, undefined);
    });
  }
});

test('dispose fences late create and hydration-probe outcomes before binding/details commit', async t => {
  await t.test('create accepted', async () => {
    const started = deferred();
    const result = deferred();
    class DeferredCreateClient extends V4Client {
      async createOrBind(command) {
        this.calls.push(command);
        started.resolve(command);
        return await result.promise;
      }
    }
    const store = DurableChatroomRoomStore.memory([roomWithRun('room-create-dispose')]);
    const client = new DeferredCreateClient();
    const controller = new ChatroomAgentLoopController(
      client,
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const pending = controller.sendToRoom(
      'room-create-dispose',
      'run-lead',
      'user-create-dispose',
      [{ kind: 'text', text: 'Hello' }],
    );
    const command = await started.promise;
    controller.dispose();
    result.resolve({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
      binding: binding(),
      detailsUrl: { url: 'app:simulator/task-late-create', target: 'host' },
      delivery: { disposition: 'executed' },
    });
    assert.deepEqual(await pending, {
      status: 'unavailable',
      roomId: 'room-create-dispose',
      runId: 'run-lead',
      bindingCreated: false,
      code: 'controller-replaced',
    });
    const run = store.rooms.get('room-create-dispose').runs[0];
    assert.equal(run.taskBinding, undefined);
    assert.equal(run.detailsUrl, undefined);
    assert.equal(client.calls.some(call => call.type === 'request-member-self-introduction'), false);
    assert.equal(client.calls.some(call => call.type === 'send'), false);
  });

  for (const outcomeKind of ['denied', 'rejected']) {
    await t.test(`create ${outcomeKind}`, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredCreateClient extends V4Client {
        async createOrBind(command) {
          this.calls.push(command);
          started.resolve(command);
          return await result.promise;
        }
      }
      const roomId = `room-create-${outcomeKind}`;
      const store = DurableChatroomRoomStore.memory([roomWithRun(roomId)]);
      const client = new DeferredCreateClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.sendToRoom(
        roomId,
        'run-lead',
        `user-create-${outcomeKind}`,
        [{ kind: 'text', text: 'Hello' }],
      );
      const command = await started.promise;
      controller.dispose();
      if (outcomeKind === 'denied') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'denied',
          authorization: { capability: 'tasks.create', state: 'denied', code: 'permission-denied' },
          code: 'permission-denied',
        });
      } else {
        result.reject(new Error('late rejected create'));
      }
      assert.deepEqual(await pending, {
        status: 'unavailable',
        roomId,
        runId: 'run-lead',
        bindingCreated: false,
        code: 'controller-replaced',
      });
      const run = store.rooms.get(roomId).runs[0];
      assert.equal(run.taskBinding, undefined);
      assert.equal(run.detailsUrl, undefined);
      assert.equal(client.calls.some(call => call.type === 'send'), false);
    });
  }

  for (const outcomeKind of ['accepted', 'denied', 'rejected']) {
    await t.test(`hydrate probe ${outcomeKind}`, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredProbeClient extends V4Client {
        async subscribe(bindingValue, afterSequence) {
          this.calls.push({ type: 'subscribe', binding: bindingValue, afterSequence });
          started.resolve({ binding: bindingValue, afterSequence });
          return await result.promise;
        }
      }
      const roomId = `room-bind-${outcomeKind}`;
      const original = readyRoom(roomId);
      const store = DurableChatroomRoomStore.memory([original]);
      const client = new DeferredProbeClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.hydrate();
      const probe = await started.promise;
      controller.dispose();
      if (outcomeKind === 'accepted') {
        const subscription = {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
          contract: 'cordisx.agent-loop-event-subscription/v4',
          schemaVersion: 4,
          subscriptionId: `subscription-${outcomeKind}`,
          binding: probe.binding.binding,
          afterSequence: probe.afterSequence,
          snapshotSequence: probe.afterSequence,
        };
        result.resolve({
          status: 'accepted',
          authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
          handle: {
            subscription,
            unsubscribe() {},
            pages: { async *[Symbol.asyncIterator]() {} },
          },
        });
      } else if (outcomeKind === 'denied') {
        result.resolve({
          status: 'denied',
          authorization: { capability: 'tasks.content.read', state: 'denied', code: 'permission-denied' },
        });
      } else {
        result.reject(new Error('late rejected probe'));
      }
      await pending;
      const run = store.rooms.get(roomId).runs[0];
      assert.deepEqual(run.taskBinding.binding, original.runs[0].taskBinding.binding);
      assert.deepEqual(run.detailsUrl, original.runs[0].detailsUrl);
      assert.equal(run.rebind, undefined);
      assert.equal(client.calls.filter(call => call.type === 'subscribe').length, 1);
      assert.equal(client.calls.filter(call => call.type === 'create-or-bind').length, 0);
    });
  }
});
