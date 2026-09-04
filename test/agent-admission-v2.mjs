import assert from 'node:assert/strict';
import test from 'node:test';

import { submitChatroomAgentAdmissionV2 } from '../dist/agent-admission-v2.js';

const target = Object.freeze({
  roomId: 'room-1', participantId: 'participant-lead', memberId: 'lead', runId: 'run-lead',
});

const origin = Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
  contract: 'cordisx.agent-command-origin/v1', schemaVersion: 1,
  originId: 'origin-1', binding: { bindingId: 'binding-1', ownerGeneration: 'owner-1' },
  generation: 'shell-8', executionId: 'execution-1', commandId: 'chatroom.submit',
  scope: 'composer-submit', room: target,
});

const handle = Object.freeze({
  agent: Object.freeze({
    id: 'session-1',
    // These poison pills prove the adapter cannot fall back to direct dispatch.
    send: () => { throw new Error('direct send must not run'); },
    followup: () => { throw new Error('direct followup must not run'); },
    steer: () => { throw new Error('direct steer must not run'); },
    inject: () => { throw new Error('direct inject must not run'); },
  }),
});

const acceptedAdmission = Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
  contract: 'cordisx.agent-admission/v1', schemaVersion: 1,
  status: 'accepted', messageId: 'host-message-1',
});

test('v2 adapter reserves the exact owner, Shell origin, and dispatch text before one-shot submit', async () => {
  let reserved;
  let submitted = 0;
  const service = {
    reserve: async request => {
      reserved = request;
      return {
        status: 'reserved',
        reservation: {
          reservationId: 'reservation-1',
          submit: async () => { submitted += 1; return acceptedAdmission; },
          revoke: async () => {},
        },
      };
    },
  };

  const result = await submitChatroomAgentAdmissionV2(service, {
    handle, origin, target, message: { text: 'Review this exact change.' },
  });

  assert.deepEqual(reserved, {
    handle, origin, message: { text: 'Review this exact change.' },
  });
  assert.equal(submitted, 1);
  assert.deepEqual(result, { status: 'accepted', admission: acceptedAdmission });
});

test('v2 adapter returns a reservation denial and never invokes any direct Agent dispatch', async () => {
  let submits = 0;
  const service = {
    reserve: async () => ({
      status: 'denied', code: 'origin-denied',
      reservation: { submit: async () => { submits += 1; return acceptedAdmission; } },
    }),
  };

  const result = await submitChatroomAgentAdmissionV2(service, {
    handle, origin, target, message: { text: 'Review this exact change.' },
  });

  assert.deepEqual(result, { status: 'denied', code: 'origin-denied' });
  assert.equal(submits, 0);
});

test('v2 adapter rejects an origin for another Room before it can reserve or submit', async () => {
  let reserves = 0;
  const service = { reserve: async () => { reserves += 1; throw new Error('must not reserve'); } };

  await assert.rejects(submitChatroomAgentAdmissionV2(service, {
    handle,
    origin: { ...origin, room: { ...target, runId: 'other-run' } },
    target,
    message: { text: 'Review this exact change.' },
  }), /exact Room member run/);
  assert.equal(reserves, 0);
});

test('v2 adapter propagates a reserve failure without a direct Agent fallback', async () => {
  const service = { reserve: async () => { throw new Error('Host reservation unavailable'); } };

  await assert.rejects(submitChatroomAgentAdmissionV2(service, {
    handle, origin, target, message: { text: 'Review this exact change.' },
  }), /Host reservation unavailable/);
});
