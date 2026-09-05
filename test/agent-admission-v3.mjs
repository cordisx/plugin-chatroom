import assert from 'node:assert/strict';
import test from 'node:test';

import { submitChatroomAgentAdmissionV3 } from '../dist/agent-admission-v3.js';

const baseOrigin = Object.freeze({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
  contract: 'cordisx.agent-command-origin/v1',
  schemaVersion: 1,
  originId: 'origin-1',
  binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' },
  generation: 'shell-8',
  executionId: 'execution-1',
  commandId: 'chatroom.submit',
  scope: 'composer-submit',
  room: {
    roomId: 'room-1',
    participantId: 'room',
    memberId: 'room',
    runId: 'room',
  },
});

const target = (suffix) =>
  Object.freeze({
    participantId: `participant-${suffix}`,
    memberId: `member-${suffix}`,
    runId: `run-${suffix}`,
  });

const handle = suffix =>
  Object.freeze({
    agent: Object.freeze({
      id: `session-${suffix}`,
      // Poison pills prove no issue/reservation path can fall back to a driver call.
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

function services() {
  const calls = { issued: [], reserved: [], submitted: [] };
  return {
    calls,
    origins: {
      issue: async request => {
        calls.issued.push(request);
        return {
          status: 'issued',
          origin: Object.freeze({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json',
            contract: 'cordisx.agent-admission-target-origin/v3',
            schemaVersion: 3,
            token: `opaque-${request.target.runId}`,
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
    return await submitChatroomAgentAdmissionV3(service.origins, service.reservations, {
      handle: handle(suffix),
      origin: baseOrigin,
      target: target(suffix),
      message: { text: 'Review this exact change.' },
    });
  }));
  return { ...service, results };
}

test('v3 adapter issues and reserves independent opaque capabilities for N=2 deliveries', async () => {
  const { calls, results } = await submitMany(2);

  assert.deepEqual(calls.issued.map(call => call.target), [target('1'), target('2')]);
  assert.equal(calls.issued.every(call => call.origin === baseOrigin), true);
  assert.deepEqual(calls.reserved.map(call => call.origin.token), ['opaque-run-1', 'opaque-run-2']);
  assert.deepEqual(calls.reserved.map(call => call.handle.agent.id), ['session-1', 'session-2']);
  assert.deepEqual(calls.submitted, ['opaque-run-1', 'opaque-run-2']);
  assert.equal(results.every(result => result.status === 'accepted'), true);
});

test('v3 adapter issues and reserves independent opaque capabilities for N=3 deliveries', async () => {
  const { calls, results } = await submitMany(3);

  assert.deepEqual(calls.issued.map(call => call.target.runId), ['run-1', 'run-2', 'run-3']);
  assert.equal(new Set(calls.reserved.map(call => call.origin.token)).size, 3);
  assert.equal(new Set(calls.submitted).size, 3);
  assert.deepEqual(results.map(result => result.admission.messageId), [
    'host-message-opaque-run-1',
    'host-message-opaque-run-2',
    'host-message-opaque-run-3',
  ]);
});

test('v3 adapter stops after an issue denial and never reserves or directly dispatches', async () => {
  const calls = { reserved: 0 };
  const origins = { issue: async () => ({ status: 'denied', code: 'target-denied' }) };
  const reservations = {
    reserve: async () => {
      calls.reserved += 1;
      throw new Error('must not reserve');
    },
  };

  const result = await submitChatroomAgentAdmissionV3(origins, reservations, {
    handle: handle('denied'),
    origin: baseOrigin,
    target: target('denied'),
    message: { text: 'Review this exact change.' },
  });

  assert.deepEqual(result, { status: 'denied', stage: 'issue', code: 'target-denied' });
  assert.equal(calls.reserved, 0);
});

test('v3 adapter stops after a reservation denial and never directly dispatches', async () => {
  const origins = {
    issue: async () => ({
      status: 'issued',
      origin: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json',
        contract: 'cordisx.agent-admission-target-origin/v3',
        schemaVersion: 3,
        token: 'opaque-denied',
      },
    }),
  };
  const reservations = { reserve: async () => ({ status: 'denied', code: 'target-mismatch' }) };

  const result = await submitChatroomAgentAdmissionV3(origins, reservations, {
    handle: handle('denied'),
    origin: baseOrigin,
    target: target('denied'),
    message: { text: 'Review this exact change.' },
  });

  assert.deepEqual(result, { status: 'denied', stage: 'reserve', code: 'target-mismatch' });
});
