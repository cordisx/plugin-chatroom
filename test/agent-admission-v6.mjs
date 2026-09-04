import assert from 'node:assert/strict';
import test from 'node:test';

import {
  declareChatroomAgentAdmissionBootstrapRoute,
  submitChatroomAgentAdmissionBootstrapRouteReservation,
} from '../dist/agent-admission-v6.js';

const origin = Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
  contract: 'cordisx.agent-bootstrap-command-origin/v1', schemaVersion: 1,
  originId: 'bootstrap-route-origin-1', binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' },
  generation: 'shell-9', executionId: 'execution-1', commandId: 'chatroom.submit', scope: 'composer-submit',
});

const target = suffix => Object.freeze({
  roomId: 'room-bootstrap', participantId: `participant-${suffix}`, memberId: `member-${suffix}`, runId: `run-${suffix}`,
  route: Object.freeze({ routeId: 'room', param: 'roomId', roomId: 'room-bootstrap' }),
});

const handle = suffix => Object.freeze({
  agent: Object.freeze({
    id: `session-${suffix}`,
    send: () => { throw new Error('direct send must not run'); },
    followup: () => { throw new Error('direct followup must not run'); },
    steer: () => { throw new Error('direct steer must not run'); },
    inject: () => { throw new Error('direct inject must not run'); },
  }),
});

const admission = suffix => Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
  contract: 'cordisx.agent-admission/v1', schemaVersion: 1,
  status: 'accepted', messageId: `host-message-${suffix}`,
});

function services() {
  const calls = { declared: [], reserved: [], submitted: [] };
  return {
    calls,
    declarations: {
      declare: async request => {
        calls.declared.push(request);
        return {
          status: 'declared',
          continuation: Object.freeze({
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json',
            contract: 'cordisx.agent-admission-bootstrap-route-continuation/v6', schemaVersion: 6,
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

async function submitMany(count) {
  const service = services();
  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const suffix = String(index + 1);
    const declared = await declareChatroomAgentAdmissionBootstrapRoute(service.declarations, origin, target(suffix));
    assert.equal(declared.status, 'declared');
    if (declared.status !== 'declared') throw new Error('bootstrap route declaration unexpectedly denied');
    return await submitChatroomAgentAdmissionBootstrapRouteReservation(service.reservations, {
      handle: handle(suffix), continuation: declared.continuation, message: { text: 'Review this exact change.' },
    });
  }));
  return { ...service, results };
}

for (const count of [1, 2, 3]) {
  test(`v6 bootstrap route adapter declares and submits ${count} independent same-Room target${count === 1 ? '' : 's'}`, async () => {
    const { calls, results } = await submitMany(count);

    assert.deepEqual(calls.declared.map(call => call.origin), Array(count).fill(origin));
    assert.deepEqual(calls.declared.map(call => call.target), Array.from({ length: count }, (_, index) => target(String(index + 1))));
    assert.equal(new Set(calls.declared.map(call => call.target.route.roomId)).size, 1);
    assert.deepEqual(calls.reserved.map(call => call.handle.agent.id), Array.from({ length: count }, (_, index) => `session-${index + 1}`));
    assert.equal(new Set(calls.reserved.map(call => call.continuation.token)).size, count);
    assert.deepEqual(calls.submitted, calls.reserved.map(call => call.continuation.token));
    assert.equal(results.every(result => result.status === 'accepted'), true);
  });
}

test('v6 bootstrap route adapter stops after declaration denial with no reserve or direct dispatch', async () => {
  const declared = await declareChatroomAgentAdmissionBootstrapRoute({
    declare: async () => ({ status: 'denied', code: 'cross-room' }),
  }, origin, target('denied'));

  assert.deepEqual(declared, { status: 'denied', stage: 'declare', code: 'cross-room' });
});

test('v6 bootstrap route adapter stops after reservation denial with no direct dispatch', async () => {
  const continuation = Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-route-continuation.v6.schema.json',
    contract: 'cordisx.agent-admission-bootstrap-route-continuation/v6', schemaVersion: 6, token: 'continuation-denied',
  });
  const result = await submitChatroomAgentAdmissionBootstrapRouteReservation({
    reserve: async () => ({ status: 'denied', code: 'binding-replaced' }),
  }, {
    handle: handle('denied'), continuation, message: { text: 'Review this exact change.' },
  });

  assert.deepEqual(result, { status: 'denied', stage: 'reserve', code: 'binding-replaced' });
});
