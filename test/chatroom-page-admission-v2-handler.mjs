import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomPageSource } from '../dist/chatroom-page-source.js';
import { ChatroomRoomRegistry } from '../dist/room.js';

function context({ fresh = false, bindingId = 'binding-1', originBindingId = bindingId } = {}) {
  const page = fresh
    ? { outlet: 'main', routeDefinitionId: 'new-room' }
    : { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' };
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-context.v2.schema.json',
    contract: 'cordisx.agent-page-composer-command-context/v2',
    schemaVersion: 2,
    binding: { bindingId, ownerGeneration: 'owner-1' },
    generation: 'page-generation-1',
    scope: 'page-composer-submit',
    command: { id: 'submit' },
    submitPayload: fresh ? 'Fresh task' : 'Existing task',
    origin: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json',
      contract: 'cordisx.agent-page-composer-origin/v1',
      schemaVersion: 1,
      originId: 'origin-1',
      binding: { bindingId: originBindingId, ownerGeneration: 'owner-1' },
      generation: 'page-generation-1',
      executionId: 'execution-1',
      commandId: 'submit',
      scope: 'page-composer-submit',
      page,
    },
    ...(fresh
      ? {
        freshRoomNavigation: {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-fresh-room-navigation.v1.schema.json',
          contract: 'cordisx.agent-page-fresh-room-navigation/v1',
          schemaVersion: 1,
          token: 'fresh-navigation-1',
        },
      }
      : {}),
  };
}

function accepted(roomId, suffix) {
  return {
    memberId: `member-${suffix}`,
    runId: `run-${suffix}`,
    outcome: {
      status: 'accepted',
      roomId,
      runId: `run-${suffix}`,
      sessionId: `session-${suffix}`,
      messageId: `message-${suffix}`,
      disposition: 'created',
    },
  };
}

function denied(roomId, suffix) {
  return {
    memberId: `member-${suffix}`,
    runId: `run-${suffix}`,
    outcome: { status: 'denied', roomId, runId: `run-${suffix}`, code: 'target-denied' },
  };
}

function harness(
  { fresh = false, outcomes, navigationResult, deliveries = [{ memberId: 'member-1', runId: 'run-1' }] } = {},
) {
  const calls = [];
  const rooms = new ChatroomRoomRegistry();
  const roomId = fresh ? 'room-fresh' : 'room-existing';
  const intent = {
    kind: 'send-message',
    roomId,
    roomCreated: fresh,
    deliveries,
    userItemId: 'user-item-1',
    bindingId: 'binding-1',
    generation: 'page-generation-1',
    dispatchText: fresh ? 'Fresh task' : 'Existing task',
  };
  const conversation = {
    rooms,
    submitMessage(...args) {
      calls.push(['intent', ...args]);
      return intent;
    },
    async persistComposerRoom(value) {
      calls.push(['persist', value]);
    },
  };
  const sessions = {
    subscribeProjection() {
      return () => {};
    },
    projectionForRoom() {
      return { activeRuns: [], items: [] };
    },
    isRunLocallyUnavailable() {
      return false;
    },
    async hydrateRoom() {},
    async sendToRoom() {
      throw new Error('direct send must not run');
    },
    answerApprovalItem() {
      return false;
    },
    async submitDeliveriesViaPageAdmissionV2Existing(...args) {
      calls.push(['existing', ...args]);
      return outcomes ?? [accepted(roomId, '1')];
    },
    async submitDeliveriesViaPageAdmissionV2Fresh(...args) {
      calls.push(['fresh', ...args]);
      return outcomes ?? [accepted(roomId, '1')];
    },
  };
  const settings = {
    current: 'enter',
    subscribe() {
      return () => {};
    },
  };
  const services = {
    targets: {},
    reservations: {},
    routeDeclarations: {},
    routeReservations: {},
    freshNavigation: {
      async navigate(request) {
        calls.push(['navigate', request]);
        return navigationResult ?? { status: 'accepted', code: 'claimed', roomId: roomId };
      },
    },
  };
  return { calls, source: new ChatroomPageSource(conversation, sessions, settings), services };
}

test('typed v2 handler uses existing-Room admission only and returns after every target accepts', async () => {
  const run = harness();
  const result = await run.source.handlePageComposerCommand(context(), run.services);
  assert.deepEqual(result, { status: 'accepted', roomId: 'room-existing', roomCreated: false });
  assert.deepEqual(run.calls.map(call => call[0]), ['intent', 'persist', 'existing']);
  assert.equal(run.calls.some(call => call[0] === 'navigate'), false);
  run.source.dispose();
});

for (const count of [1, 2, 3]) {
  test(`typed v2 page handler preserves ${count} exact existing-Room target${count === 1 ? '' : 's'}`, async () => {
    const deliveries = Array.from({ length: count }, (_, index) => ({
      memberId: `member-${index + 1}`,
      runId: `run-${index + 1}`,
    }));
    const run = harness({
      deliveries,
      outcomes: deliveries.map((_, index) => accepted('room-existing', String(index + 1))),
    });
    await run.source.handlePageComposerCommand(context(), run.services);
    assert.deepEqual(run.calls.find(call => call[0] === 'existing').slice(2, 4), [
      deliveries,
      'user-item-1',
    ]);
    run.source.dispose();
  });

  test(`typed v2 page handler preserves ${count} exact fresh-Room target${count === 1 ? '' : 's'} before claim`, async () => {
    const deliveries = Array.from({ length: count }, (_, index) => ({
      memberId: `member-${index + 1}`,
      runId: `run-${index + 1}`,
    }));
    const run = harness({
      fresh: true,
      deliveries,
      outcomes: deliveries.map((_, index) => accepted('room-fresh', String(index + 1))),
    });
    await run.source.handlePageComposerCommand(context({ fresh: true }), run.services);
    assert.deepEqual(run.calls.find(call => call[0] === 'fresh').slice(2, 4), [
      deliveries,
      'user-item-1',
    ]);
    assert.equal(run.calls.at(-1)[0], 'navigate');
    run.source.dispose();
  });
}

test('typed v2 handler exposes a partial failure to Host completion and never falls back to direct send', async () => {
  const run = harness({ outcomes: [accepted('room-existing', '1'), denied('room-existing', '2')] });
  await assert.rejects(
    run.source.handlePageComposerCommand(context(), run.services),
    /member-2\/run-2: denied:target-denied/u,
  );
  assert.deepEqual(run.calls.map(call => call[0]), ['intent', 'persist', 'existing']);
  run.source.dispose();
});

test('typed v2 fresh handler navigates through the Host permit only after all target submits accept', async () => {
  const run = harness({ fresh: true, outcomes: [accepted('room-fresh', '1'), accepted('room-fresh', '2')] });
  const result = await run.source.handlePageComposerCommand(context({ fresh: true }), run.services);
  assert.deepEqual(result, { status: 'accepted', roomId: 'room-fresh', roomCreated: true });
  assert.deepEqual(run.calls.map(call => call[0]), ['intent', 'persist', 'fresh', 'navigate']);
  assert.deepEqual(run.calls.at(-1)[1], {
    navigation: context({ fresh: true }).freshRoomNavigation,
    route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
  });
  run.source.dispose();
});

test('typed v2 fresh claim failure rejects before UI completion and does not retry or directly dispatch', async () => {
  const run = harness({
    fresh: true,
    navigationResult: { status: 'unavailable', code: 'claim-failed' },
  });
  await assert.rejects(
    run.source.handlePageComposerCommand(context({ fresh: true }), run.services),
    /did not claim Room room-fresh/u,
  );
  assert.deepEqual(run.calls.map(call => call[0]), ['intent', 'persist', 'fresh', 'navigate']);
  run.source.dispose();
});

test('typed v2 Host completion clears a draft only for an all-accepted submitted result', () => {
  const run = harness();
  const target = { roomId: 'room-existing', participantId: 'member-1', memberId: 'member-1', runId: 'run-1' };
  assert.deepEqual(
    run.source.pageComposerCompletion({
      status: 'accepted',
      code: 'submitted',
      disposition: 'existing-room',
      roomId: 'room-existing',
      deliveries: [{ target, status: 'accepted', sessionId: 'session-1', messageId: 'message-1' }],
    }),
    { status: 'accepted', roomId: 'room-existing', roomCreated: false },
  );
  assert.deepEqual(
    run.source.pageComposerCompletion({
      status: 'accepted',
      code: 'submitted',
      disposition: 'fresh-room',
      roomId: 'room-fresh',
      deliveries: [{
        target: { ...target, roomId: 'room-fresh' },
        status: 'accepted',
        sessionId: 'session-fresh',
        messageId: 'message-fresh',
      }],
    }),
    { status: 'accepted', roomId: 'room-fresh', roomCreated: true },
  );
  assert.throws(() =>
    run.source.pageComposerCompletion({
      status: 'failed',
      code: 'incomplete-submission',
      roomId: 'room-existing',
      deliveries: [
        { target, status: 'accepted', sessionId: 'session-1', messageId: 'message-1' },
        { target: { ...target, runId: 'run-2' }, status: 'denied', code: 'submit-denied' },
      ],
    }), /incomplete-submission/u);
  assert.throws(() =>
    run.source.pageComposerCompletion({
      status: 'unavailable',
      code: 'page-replaced',
    }), /page-replaced/u);
  run.source.dispose();
});

test('typed v2 handler rejects a stale context before it persists a Room or attempts admission', async () => {
  const run = harness();
  await assert.rejects(
    run.source.handlePageComposerCommand(context({ originBindingId: 'mismatch' }), run.services),
    /context is invalid/u,
  );
  assert.deepEqual(run.calls, []);
  run.source.dispose();
});
