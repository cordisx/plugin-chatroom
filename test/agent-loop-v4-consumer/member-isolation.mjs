import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../../dist/agent-loop-projection.js';
import { acceptMemberSelfIntroduction, planMemberSelfIntroduction } from '../../dist/room-agent-operations.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

import { binding, memberBinding, multiReadyRoom, V4Client } from './fixtures.mjs';

test('isolates Lead and Reviewer introduction and approval operations in one Room', async () => {
  let room = multiReadyRoom();
  room = planMemberSelfIntroduction(room, 'run-lead');
  room = planMemberSelfIntroduction(room, 'run-reviewer');
  const leadIntroduction = room.runs.find(run => run.runId === 'run-lead').selfIntroduction;
  const reviewerIntroduction = room.runs.find(run => run.runId === 'run-reviewer').selfIntroduction;
  assert.notEqual(leadIntroduction.operationId, reviewerIntroduction.operationId);
  assert.deepEqual(
    [leadIntroduction.participantId, leadIntroduction.memberId, leadIntroduction.runId],
    ['leader', 'leader', 'run-lead'],
  );
  assert.deepEqual(
    [reviewerIntroduction.participantId, reviewerIntroduction.memberId, reviewerIntroduction.runId],
    ['reviewer', 'reviewer', 'run-reviewer'],
  );

  const store = DurableChatroomRoomStore.memory([room]);
  const client = new V4Client();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.cancelMemberSelfIntroduction('room-v4-multi', 'run-lead');
  room = store.rooms.get('room-v4-multi');
  room = acceptMemberSelfIntroduction(room, 'run-reviewer', {
    operationId: reviewerIntroduction.operationId,
    binding: reviewerIntroduction.binding,
    participantId: 'reviewer',
    memberId: 'reviewer',
    turn: 'turn-reviewer-introduction',
    messageId: 'message-reviewer-introduction',
    disposition: 'executed',
  });
  room = projectAgentLoopEvent(room, 'run-reviewer', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-reviewer-introduction',
    binding: memberBinding('reviewer').binding,
    sequence: 0,
    occurredAt: '2026-08-31T06:11:00.000Z',
    type: 'message',
    turn: 'turn-reviewer-introduction',
    causation: { operationId: reviewerIntroduction.operationId },
    message: {
      messageId: 'message-reviewer-introduction',
      role: 'assistant',
      purpose: 'member-self-introduction',
      content: [{ kind: 'text', text: 'Reviewer introduction.' }],
    },
  }).room;
  await store.compareAndSwap(store.revision, room);
  assert.equal(
    store.rooms.get('room-v4-multi').runs.find(run => run.runId === 'run-lead').selfIntroduction.state,
    'cancelled',
  );
  assert.equal(
    store.rooms.get('room-v4-multi').runs.find(run => run.runId === 'run-reviewer').selfIntroduction.state,
    'completed',
  );
  assert.equal(store.rooms.get('room-v4-multi').items[0].author.participantId, 'reviewer');

  const approvals = await Promise.all([
    controller.decideApproval('room-v4-multi', 'run-lead', 'turn-lead', 'approval-lead', 'approved'),
    controller.decideApproval('room-v4-multi', 'run-reviewer', 'turn-reviewer', 'approval-reviewer', 'denied'),
  ]);
  assert.equal(approvals.every(outcome => outcome.status === 'accepted'), true);
  assert.notEqual(approvals[0].operationId, approvals[1].operationId);
  const approvalCalls = client.calls.filter(call => call.type === 'approval-decision');
  assert.deepEqual(
    approvalCalls.map(call => [
      call.binding.definition.agentId,
      call.turn,
      call.approvalId,
      call.decision,
    ]),
    [
      [memberBinding('leader').definition.agentId, 'turn-lead', 'approval-lead', 'approved'],
      [memberBinding('reviewer').definition.agentId, 'turn-reviewer', 'approval-reviewer', 'denied'],
    ],
  );
});
