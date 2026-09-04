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

test('Agent Session scenario approval uses the exact structured Reviewer reason and returns the v7 card correlation', async () => {
  const reviewerRoom = {
    ...room,
    runs: [
      { runId: 'run-lead', memberId: 'lead', sessionId: 'session-lead', presence: { state: 'ready' } },
      { runId: 'run-reviewer', memberId: 'reviewer', sessionId: 'session-reviewer', presence: { state: 'ready' } },
    ],
  };
  const listeners = new Set();
  let projected = [];
  let request;
  const agentSession = {
    rooms: { snapshot: () => [reviewerRoom], subscribe: () => () => {} },
    subscribeProjection: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    projectionForRoom: () => ({ activeRuns: [], items: projected }),
    requestApproval: async (...args) => {
      request = args;
      projected = [{
        kind: 'approval', itemId: 'approval-card', sequence: 9,
        participantId: 'participant-reviewer', memberId: 'reviewer', runId: 'run-reviewer',
        sessionId: 'session-reviewer', approvalId: 'approval-v2', approvalKind: 'command',
        requester: { agentId: 'reviewer-agent', revision: 'reviewer-r1' },
        authority: {
          participantId: 'participant-lead', memberId: 'lead',
          identity: { agentId: 'lead-agent', revision: 'lead-r1' },
        },
        reason: { kind: 'plain-text', text: args[3] },
        state: 'pending', agentGeneration: 2,
        authorityBinding: {
          agentId: 'session-lead', sessionId: 'session-lead', agentGeneration: 3,
          definition: { agentId: 'lead-agent', revision: 'lead-r1' },
        },
        actions: [
          { decision: 'approve', command: { id: 'chatroom.approval.approve' } },
          { decision: 'reject', command: { id: 'chatroom.approval.deny' } },
        ],
      }];
      for (const listener of listeners) listener('room-one');
      return await new Promise(() => {});
    },
  };
  const owner = new ChatroomAgentSessionRoomSimulationOwner(
    'owner-one',
    {
      inspectPlaygroundSource: () => ({
        status: 'available', room: reviewerRoom, run: reviewerRoom.runs[1], member: memberships[1],
      }),
    },
    agentSession,
  );
  const binding = (await owner.resolveSession('session-reviewer')).value;
  const result = await owner.emitAgentApprovalRequest(binding, 'scenario-code3', {
    reason: 'Reviewer needs approval to validate the protected release output.',
  });

  assert.deepEqual(request, [
    'room-one', 'run-reviewer', 'playground.room-simulation.agent-approval',
    'Reviewer needs approval to validate the protected release output.', 'scenario-code3',
  ]);
  assert.equal(result.status, 'available');
  assert.equal(result.value.phase, 'pending');
  assert.equal(result.value.roomEntryId, 'approval-card');
  assert.equal(result.value.approvalId, 'approval-v2');
  assert.equal(result.value.detail.requesterMemberId, 'reviewer');
  assert.equal(result.value.detail.authorityMemberId, 'lead');
  owner.dispose();
});
