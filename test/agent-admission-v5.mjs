import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueChatroomAgentAdmissionBootstrapRoomTarget,
  submitChatroomAgentAdmissionBootstrapRoomReservation,
} from '../dist/agent-admission-v5.js';

const origin = Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
  contract: 'cordisx.agent-bootstrap-command-origin/v1', schemaVersion: 1,
  originId: 'bootstrap-room-origin-1', binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' },
  generation: 'shell-9', executionId: 'execution-1', commandId: 'chatroom.submit', scope: 'composer-submit',
});

const target = suffix => Object.freeze({
  roomId: 'room-existing', participantId: `participant-${suffix}`, memberId: `member-${suffix}`, runId: `run-${suffix}`,
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
  const calls = { issued: [], reserved: [], submitted: [] };
  return {
    calls,
    targets: {
      issue: async request => {
        calls.issued.push(request);
        return {
          status: 'issued',
          origin: Object.freeze({
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-origin.v5.schema.json',
            contract: 'cordisx.agent-admission-bootstrap-room-target-origin/v5', schemaVersion: 5,
            token: `room-target-${request.target.runId}`,
          }),
          receipt: Object.freeze({
            $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-receipt.v5.schema.json',
            contract: 'cordisx.agent-admission-bootstrap-room-target-receipt/v5', schemaVersion: 5,
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

async function submitMany(count) {
  const service = services();
  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const suffix = String(index + 1);
    const issued = await issueChatroomAgentAdmissionBootstrapRoomTarget(service.targets, origin, target(suffix));
    assert.equal(issued.status, 'issued');
    if (issued.status !== 'issued') throw new Error('bootstrap Room target unexpectedly denied');
    return await submitChatroomAgentAdmissionBootstrapRoomReservation(service.reservations, {
      handle: handle(suffix), origin: issued.origin, message: { text: 'Continue this exact Room.' },
    });
  }));
  return { ...service, results };
}

for (const count of [1, 2, 3]) {
  test(`v5 bootstrap Room adapter binds and submits ${count} independent same-Room target${count === 1 ? '' : 's'}`, async () => {
    const { calls, results } = await submitMany(count);

    assert.deepEqual(calls.issued.map(call => call.origin), Array(count).fill(origin));
    assert.deepEqual(calls.issued.map(call => call.target), Array.from({ length: count }, (_, index) => target(String(index + 1))));
    assert.equal(new Set(calls.issued.map(call => call.target.roomId)).size, 1);
    assert.deepEqual(calls.reserved.map(call => call.handle.agent.id), Array.from({ length: count }, (_, index) => `session-${index + 1}`));
    assert.equal(new Set(calls.reserved.map(call => call.origin.token)).size, count);
    assert.deepEqual(calls.submitted, calls.reserved.map(call => call.origin.token));
    assert.equal(results.every(result => result.status === 'accepted'), true);
  });
}

test('v5 bootstrap Room adapter stops after target denial with no reserve or direct dispatch', async () => {
  const issued = await issueChatroomAgentAdmissionBootstrapRoomTarget({
    issue: async () => ({ status: 'denied', code: 'target-denied' }),
  }, origin, target('denied'));

  assert.deepEqual(issued, { status: 'denied', stage: 'issue', code: 'target-denied' });
});

test('v5 bootstrap Room adapter stops after reservation denial with no direct dispatch', async () => {
  const targetOrigin = Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-room-target-origin.v5.schema.json',
    contract: 'cordisx.agent-admission-bootstrap-room-target-origin/v5', schemaVersion: 5, token: 'room-target-denied',
  });
  const result = await submitChatroomAgentAdmissionBootstrapRoomReservation({
    reserve: async () => ({ status: 'denied', code: 'target-mismatch' }),
  }, {
    handle: handle('denied'), origin: targetOrigin, message: { text: 'Continue this exact Room.' },
  });

  assert.deepEqual(result, { status: 'denied', stage: 'reserve', code: 'target-mismatch' });
});
