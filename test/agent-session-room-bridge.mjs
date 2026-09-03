import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomAgentSessionRoomSimulationOwner } from '../dist/playground-room-simulation-bridge.js';

const memberships = [
  ['lead', 'Lead'],
  ['reviewer', 'Reviewer'],
  ['integrator', 'Integrator'],
  ['documentation', 'Documentation'],
  ['qa', 'QA'],
].map(([memberId, label]) => ({ memberId, label, participantId: `participant-${memberId}` }));

const room = {
  id: 'room-one',
  archived: false,
  memberships,
  runs: [{
    runId: 'run-lead', memberId: 'lead', sessionId: 'cx-session.room-one.lead',
    presence: { state: 'ready' },
  }],
};

test('discovers the Room from SessionId and delegates to another Room entity', async () => {
  const sent = [];
  const rooms = {
    snapshot: () => [room],
    subscribe: () => () => {},
  };
  const conversation = {
    inspectPlaygroundSource: correlation => {
      assert.equal(correlation.sessionId, 'cx-session.room-one.lead');
      return { status: 'available', room, run: room.runs[0], member: memberships[0] };
    },
    projectAgentSessionDelegation: async (_correlation, operationId, memberId, task) => ({
      status: 'accepted',
      targetRunId: 'run-reviewer',
      targetMemberId: memberId,
      itemId: `item-${operationId}`,
      messageId: `message-${operationId}`,
      text: task,
      context: {
        source: { memberId: 'lead', label: 'Lead', runId: 'run-lead' },
        target: { memberId: 'reviewer', label: 'Reviewer', runId: 'run-reviewer' },
        availableTargets: [],
        communicationMode: 'explicit-mention-required',
        approvalMode: 'reports-to-hierarchy',
      },
    }),
  };
  const agentSession = {
    rooms,
    reservePresentationSequence: () => 42,
    sendToRoom: async (...args) => {
      sent.push(args);
      return {
        status: 'accepted',
        messageId: 'message-delegated',
        sessionId: 'cx-session.room-one.reviewer',
      };
    },
  };
  const owner = new ChatroomAgentSessionRoomSimulationOwner(
    'owner-one', conversation, agentSession,
  );

  const resolved = await owner.resolveSession('cx-session.room-one.lead');
  assert.equal(resolved.status, 'available');
  if (resolved.status !== 'available') return;
  assert.deepEqual(
    (await owner.inspect(resolved.value)).value.delegationTargets.map(target => target.label),
    ['Reviewer', 'Integrator', 'Documentation', 'QA'],
  );

  const delegated = await owner.delegateTask(resolved.value, 'operation-one', {
    memberId: 'reviewer',
    task: 'Review the final chain.',
  });
  assert.equal(delegated.status, 'available');
  assert.equal(delegated.value.phase, 'accepted');
  assert.equal(delegated.value.runId, 'run-reviewer');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 3), ['room-one', 'run-reviewer', 'item-operation-one']);
  assert.equal(sent[0][3], 'Review the final chain.');
  assert.doesNotMatch(sent[0][3], /Chatroom delegation context|delegatedBy|availableTargets/u);
  owner.dispose();
});

test('fails closed when a Session is not bound to exactly one Room run', async () => {
  const owner = new ChatroomAgentSessionRoomSimulationOwner(
    'owner-one',
    { inspectPlaygroundSource: () => { throw new Error('must not inspect an unbound Session'); } },
    { rooms: { snapshot: () => [], subscribe: () => () => {} } },
  );
  assert.deepEqual(await owner.resolveSession('cx-session.unknown'), {
    status: 'unavailable',
    code: 'session-unbound',
    message: 'The Agent Session is not bound to an active Chatroom Room.',
    ownerGeneration: 'owner-one',
  });
  owner.dispose();
});
