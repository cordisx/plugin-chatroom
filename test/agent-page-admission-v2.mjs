import assert from 'node:assert/strict';
import test from 'node:test';

import {
  declareChatroomPageAdmissionRoute,
  issueChatroomPageAdmissionTarget,
  submitChatroomPageAdmissionReservation,
  submitChatroomPageAdmissionRouteReservation,
} from '../dist/agent-page-admission-v2.js';

const origin = Object.freeze({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json',
  contract: 'cordisx.agent-page-composer-origin/v1',
  schemaVersion: 1,
  originId: 'page-origin-1',
  binding: { bindingId: 'page-binding-1', ownerGeneration: 'owner-1' },
  generation: 'page-generation-1',
  executionId: 'page-execution-1',
  commandId: 'submit',
  scope: 'page-composer-submit',
  page: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' },
});

const target = suffix =>
  Object.freeze({
    roomId: 'room-existing',
    participantId: `participant-${suffix}`,
    memberId: `member-${suffix}`,
    runId: `run-${suffix}`,
  });

const routeTarget = suffix =>
  Object.freeze({
    roomId: 'room-fresh',
    participantId: `participant-${suffix}`,
    memberId: `member-${suffix}`,
    runId: `run-${suffix}`,
    route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
  });

const handle = suffix =>
  Object.freeze({
    agent: Object.freeze({
      id: `session-${suffix}`,
      session: { id: `session-${suffix}` },
      send: () => {
        throw new Error('direct send must not run');
      },
      followup: () => {
        throw new Error('direct followup must not run');
      },
      steer: () => {
        throw new Error('direct steer must not run');
      },
      inject: () => {
        throw new Error('direct inject must not run');
      },
    }),
  });

const admission = suffix =>
  Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
    contract: 'cordisx.agent-admission/v1',
    schemaVersion: 1,
    status: 'accepted',
    messageId: `host-message-${suffix}`,
  });

function existingServices() {
  const calls = { issued: [], reserved: [], submitted: [] };
  return {
    calls,
    targets: {
      issue: async request => {
        calls.issued.push(request);
        return {
          status: 'issued',
          origin: Object.freeze({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-target-origin.v1.schema.json',
            contract: 'cordisx.agent-page-admission-target-origin/v1',
            schemaVersion: 1,
            token: `target-${request.target.runId}`,
          }),
          receipt: Object.freeze({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-target-receipt.v1.schema.json',
            contract: 'cordisx.agent-page-admission-target-receipt/v1',
            schemaVersion: 1,
            receiptId: `receipt-${request.target.runId}`,
            target: request.target,
          }),
        };
      },
    },
    reservations: {
      reserve: async request => {
        calls.reserved.push(request);
        return {
          status: 'reserved',
          reservation: {
            reservationId: `reservation-${request.origin.token}`,
            submit: async () => {
              calls.submitted.push(request.origin.token);
              return admission(request.origin.token);
            },
            revoke: async () => {},
          },
        };
      },
    },
  };
}

function freshServices() {
  const calls = { declared: [], reserved: [], submitted: [] };
  return {
    calls,
    declarations: {
      declare: async request => {
        calls.declared.push(request);
        return {
          status: 'declared',
          continuation: Object.freeze({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-continuation.v1.schema.json',
            contract: 'cordisx.agent-page-admission-route-continuation/v1',
            schemaVersion: 1,
            token: `continuation-${request.target.runId}`,
          }),
        };
      },
    },
    reservations: {
      reserve: async request => {
        calls.reserved.push(request);
        return {
          status: 'reserved',
          reservation: {
            reservationId: `reservation-${request.continuation.token}`,
            submit: async () => {
              calls.submitted.push(request.continuation.token);
              return admission(request.continuation.token);
            },
            revoke: async () => {},
          },
        };
      },
    },
  };
}

for (const count of [1, 2, 3]) {
  test(`page v2 issues ${count} independent existing-Room target${count === 1 ? '' : 's'} before one-shot reservation submit`, async () => {
    const service = existingServices();
    const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const suffix = String(index + 1);
      const issued = await issueChatroomPageAdmissionTarget(service.targets, origin, target(suffix));
      assert.equal(issued.status, 'issued');
      if (issued.status !== 'issued') throw new Error('unexpected target denial');
      return await submitChatroomPageAdmissionReservation(service.reservations, {
        handle: handle(suffix),
        origin: issued.origin,
        message: { text: 'Page delivery' },
      });
    }));

    assert.deepEqual(service.calls.issued.map(call => call.origin), Array(count).fill(origin));
    assert.deepEqual(
      service.calls.issued.map(call => call.target),
      Array.from({ length: count }, (_, index) => target(String(index + 1))),
    );
    assert.equal(new Set(service.calls.issued.map(call => call.target.roomId)).size, 1);
    assert.deepEqual(
      service.calls.reserved.map(call => call.handle.agent.id),
      Array.from({ length: count }, (_, index) => `session-${index + 1}`),
    );
    assert.equal(new Set(service.calls.reserved.map(call => call.origin.token)).size, count);
    assert.deepEqual(service.calls.submitted, service.calls.reserved.map(call => call.origin.token));
    assert.equal(results.every(result => result.status === 'accepted'), true);
  });

  test(`page v2 declares ${count} independent fresh-Room route target${count === 1 ? '' : 's'} before one-shot submit`, async () => {
    const service = freshServices();
    const freshOrigin = { ...origin, page: { outlet: 'main', routeDefinitionId: 'new-room' } };
    const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const suffix = String(index + 1);
      const declared = await declareChatroomPageAdmissionRoute(service.declarations, freshOrigin, routeTarget(suffix));
      assert.equal(declared.status, 'declared');
      if (declared.status !== 'declared') throw new Error('unexpected route denial');
      return await submitChatroomPageAdmissionRouteReservation(service.reservations, {
        handle: handle(suffix),
        continuation: declared.continuation,
        message: { text: 'Fresh page delivery' },
      });
    }));

    assert.deepEqual(service.calls.declared.map(call => call.origin), Array(count).fill(freshOrigin));
    assert.deepEqual(
      service.calls.declared.map(call => call.target),
      Array.from({ length: count }, (_, index) => routeTarget(String(index + 1))),
    );
    assert.equal(new Set(service.calls.declared.map(call => call.target.roomId)).size, 1);
    assert.equal(new Set(service.calls.declared.map(call => call.target.route.roomId)).size, 1);
    assert.deepEqual(service.calls.submitted, service.calls.reserved.map(call => call.continuation.token));
    assert.equal(results.every(result => result.status === 'accepted'), true);
  });
}

test('page v2 stops after existing target denial without reservation or direct dispatch', async () => {
  const result = await issueChatroomPageAdmissionTarget(
    {
      issue: async () => ({ status: 'denied', code: 'target-denied' }),
    },
    origin,
    target('denied'),
  );
  assert.deepEqual(result, { status: 'denied', stage: 'issue', code: 'target-denied' });
});

test('page v2 stops after fresh declaration denial without reservation or direct dispatch', async () => {
  const freshOrigin = { ...origin, page: { outlet: 'main', routeDefinitionId: 'new-room' } };
  const result = await declareChatroomPageAdmissionRoute(
    {
      declare: async () => ({ status: 'denied', code: 'route-denied' }),
    },
    freshOrigin,
    routeTarget('denied'),
  );
  assert.deepEqual(result, { status: 'denied', stage: 'declare', code: 'route-denied' });
});

test('page v2 stops after reservation denial without direct dispatch', async () => {
  const result = await submitChatroomPageAdmissionReservation({
    reserve: async () => ({ status: 'denied', code: 'stale' }),
  }, {
    handle: handle('denied'),
    origin: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-target-origin.v1.schema.json',
      contract: 'cordisx.agent-page-admission-target-origin/v1',
      schemaVersion: 1,
      token: 'denied-target',
    },
    message: { text: 'No dispatch' },
  });
  assert.deepEqual(result, { status: 'denied', stage: 'reserve', code: 'stale' });
});
