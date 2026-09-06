import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../../dist/agent-loop-projection.js';
import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
} from '../../dist/conversation-model.js';
import { ChatroomConversationController } from '../../dist/conversation-source.js';
import {
  acceptMemberSelfIntroduction,
  approvalDecisionOperationId,
  planMemberSelfIntroduction,
} from '../../dist/room-agent-operations.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

import { binding, deferred, readyRoom, roomWithRun, V4Client } from './fixtures.mjs';

test('maps Shell approval actions to exact v4 decisions and completes by causation', async () => {
  const store = DurableChatroomRoomStore.memory([readyRoom('room-approval')]);
  const client = new V4Client();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const result = await controller.decideApproval(
    'room-approval',
    'run-lead',
    'turn-approval',
    'approval-1',
    'denied',
  );
  assert.equal(result.status, 'accepted');
  assert.equal(
    result.operationId,
    approvalDecisionOperationId('room-approval', 'run-lead', 'turn-approval', 'approval-1', 'denied'),
  );
  await controller.decideApproval('room-approval', 'run-lead', 'turn-approval', 'approval-1', 'denied');
  const conflicting = await controller.decideApproval(
    'room-approval',
    'run-lead',
    'turn-approval',
    'approval-1',
    'approved',
  );
  assert.equal(conflicting.status, 'conflict');
  assert.equal(conflicting.operationId, result.operationId);
  assert.equal(client.calls.filter(call => call.type === 'approval-decision').length, 1);

  let room = store.rooms.get('room-approval');
  room = projectAgentLoopEvent(room, 'run-lead', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'approval-pending',
    binding: binding().binding,
    sequence: 0,
    occurredAt: '2026-08-31T06:01:00.000Z',
    type: 'approval',
    turn: 'turn-approval',
    approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' },
  }).room;
  const pending = room.items[0];
  assert.equal(pending.kind, 'approval');
  assert.deepEqual(pending.actions.map(action => [action.decision, action.command.id]), [
    ['approve', 'approval.approve'],
    ['deny', 'approval.deny'],
    ['cancel', 'approval.cancel'],
  ]);
  room = projectAgentLoopEvent(room, 'run-lead', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'approval-denied',
    binding: binding().binding,
    sequence: 1,
    occurredAt: '2026-08-31T06:02:00.000Z',
    type: 'approval',
    turn: 'turn-approval',
    causation: { operationId: result.operationId },
    approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'denied' },
  }).room;
  assert.equal(room.items.length, 1);
  assert.equal(room.items[0].itemId, pending.itemId);
  assert.equal(room.items[0].state, 'denied');
  assert.equal(room.approvalDecisions[0].state, 'completed');
});

test('routes each Shell v3 approval action to its explicit v4 terminal decision token', () => {
  let room = readyRoom('room-shell-approval');
  room = projectAgentLoopEvent(room, 'run-lead', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'approval-shell-pending',
    binding: binding().binding,
    sequence: 0,
    occurredAt: '2026-08-31T06:03:00.000Z',
    type: 'approval',
    turn: 'turn-shell',
    approval: { approvalId: 'approval-shell', kind: 'file-change', state: 'pending' },
  }).room;
  const controller = new ChatroomConversationController([room]);
  const shellBinding = {
    bindingId: 'shell-binding',
    shell: 'agent-desktop',
    ownerGeneration: 'owner-1',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: room.id },
  };
  const source = controller.createSource(shellBinding);
  const itemId = room.items[0].itemId;
  for (
    const [commandId, expected] of [
      [CHATROOM_COMMAND_APPROVAL_APPROVE, 'approved'],
      [CHATROOM_COMMAND_APPROVAL_DENY, 'denied'],
      [CHATROOM_COMMAND_APPROVAL_CANCEL, 'cancelled'],
    ]
  ) {
    assert.equal(
      controller.handle({
        binding: { bindingId: shellBinding.bindingId, ownerGeneration: shellBinding.ownerGeneration },
        generation: shellBinding.ownerGeneration,
        scope: 'approval',
        itemId,
        command: { id: commandId },
      }).decision,
      expected,
    );
  }
  source.dispose();
  controller.dispose();
});

test('dispose fences late introduction, approval, and cancellation results without follow-up effects', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const introductionStarted = deferred();
    const introductionResult = deferred();
    class DeferredIntroductionClient extends V4Client {
      async requestMemberSelfIntroduction(command) {
        this.calls.push(command);
        introductionStarted.resolve(command);
        return await introductionResult.promise;
      }
    }
    const introductionStore = DurableChatroomRoomStore.memory([roomWithRun('room-dispose-intro')]);
    const introductionClient = new DeferredIntroductionClient();
    const introductionController = new ChatroomAgentLoopController(
      introductionClient,
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      introductionStore,
    );
    const sending = introductionController.sendToRoom(
      'room-dispose-intro',
      'run-lead',
      'user-dispose',
      [{ kind: 'text', text: 'Hello' }],
    );
    const introductionCommand = await introductionStarted.promise;
    introductionController.dispose();
    introductionResult.resolve({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: introductionCommand.commandId,
      type: introductionCommand.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: introductionCommand.binding,
      participantId: introductionCommand.participantId,
      memberId: introductionCommand.memberId,
      runId: introductionCommand.runId,
      turn: 'turn-late',
      messageId: 'message-late',
      causation: { operationId: introductionCommand.commandId },
      delivery: { disposition: 'executed' },
    });
    assert.deepEqual(await sending, {
      status: 'unavailable',
      roomId: 'room-dispose-intro',
      runId: 'run-lead',
      bindingCreated: false,
      code: 'controller-replaced',
    });
    assert.equal(introductionClient.calls.some(call => call.type === 'send'), false);
    assert.equal(
      introductionStore.rooms.get('room-dispose-intro').runs[0].selfIntroduction.state,
      'sending-unknown',
    );

    const approvalStarted = deferred();
    const approvalResult = deferred();
    class DeferredApprovalClient extends V4Client {
      async decideApproval(command) {
        this.calls.push(command);
        approvalStarted.resolve(command);
        return await approvalResult.promise;
      }
    }
    const approvalStore = DurableChatroomRoomStore.memory([readyRoom('room-dispose-approval')]);
    const approvalClient = new DeferredApprovalClient();
    const approvalController = new ChatroomAgentLoopController(
      approvalClient,
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      approvalStore,
    );
    const deciding = approvalController.decideApproval(
      'room-dispose-approval',
      'run-lead',
      'turn-dispose',
      'approval-dispose',
      'approved',
    );
    const approvalCommand = await approvalStarted.promise;
    approvalController.dispose();
    approvalResult.resolve({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: approvalCommand.commandId,
      type: approvalCommand.type,
      status: 'accepted',
      authorization: { capability: 'approvals.decide', state: 'allowed', code: 'allowed' },
      binding: approvalCommand.binding,
      turn: approvalCommand.turn,
      approvalId: approvalCommand.approvalId,
      decision: approvalCommand.decision,
      causation: { operationId: approvalCommand.commandId },
      delivery: { disposition: 'executed' },
    });
    const approvalOutcome = await deciding;
    assert.equal(approvalOutcome.status, 'unavailable');
    assert.equal(approvalOutcome.code, 'controller-replaced');
    assert.equal(approvalStore.rooms.get('room-dispose-approval').approvalDecisions[0].state, 'sending-unknown');

    let cancellingRoom = planMemberSelfIntroduction(readyRoom('room-dispose-cancel'), 'run-lead');
    const introduction = cancellingRoom.runs[0].selfIntroduction;
    cancellingRoom = acceptMemberSelfIntroduction(cancellingRoom, 'run-lead', {
      operationId: introduction.operationId,
      binding: introduction.binding,
      participantId: introduction.participantId,
      memberId: introduction.memberId,
      turn: 'turn-cancel',
      messageId: 'message-cancel',
      disposition: 'executed',
    });
    const cancellationStarted = deferred();
    const cancellationResult = deferred();
    class DeferredCancellationClient extends V4Client {
      async cancelMemberSelfIntroduction(command) {
        this.calls.push(command);
        cancellationStarted.resolve(command);
        return await cancellationResult.promise;
      }
    }
    const cancellationStore = DurableChatroomRoomStore.memory([cancellingRoom]);
    const cancellationClient = new DeferredCancellationClient();
    const cancellationController = new ChatroomAgentLoopController(
      cancellationClient,
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      cancellationStore,
    );
    const cancelling = cancellationController.cancelMemberSelfIntroduction('room-dispose-cancel', 'run-lead');
    const cancellationCommand = await cancellationStarted.promise;
    cancellationController.dispose();
    cancellationResult.resolve({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: cancellationCommand.commandId,
      type: cancellationCommand.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: cancellationCommand.binding,
      participantId: cancellationCommand.participantId,
      memberId: cancellationCommand.memberId,
      runId: cancellationCommand.runId,
      requestOperationId: cancellationCommand.requestOperationId,
      turn: 'turn-cancel',
      messageId: 'message-cancel',
      causation: { operationId: cancellationCommand.commandId },
      delivery: { disposition: 'executed' },
    });
    const cancellationOutcome = await cancelling;
    assert.equal(cancellationOutcome.status, 'unavailable');
    assert.equal(cancellationOutcome.code, 'controller-replaced');
    assert.equal(
      cancellationStore.rooms.get('room-dispose-cancel').runs[0].selfIntroduction.state,
      'accepted',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('cancellation is terminal against a late accepted result and assistant event', async () => {
  let room = planMemberSelfIntroduction(readyRoom('room-terminal-cancel'), 'run-lead');
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentLoopController(
    new V4Client(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.cancelMemberSelfIntroduction('room-terminal-cancel', 'run-lead');
  room = store.rooms.get('room-terminal-cancel');
  const introduction = room.runs[0].selfIntroduction;
  const afterLateAcceptance = acceptMemberSelfIntroduction(room, 'run-lead', {
    operationId: introduction.operationId,
    binding: introduction.binding,
    participantId: introduction.participantId,
    memberId: introduction.memberId,
    turn: 'turn-introduction',
    messageId: 'message-introduction',
    disposition: 'reconciled',
  });
  assert.equal(afterLateAcceptance, room);
  assert.equal(afterLateAcceptance.runs[0].selfIntroduction.state, 'cancelled');
  const afterLateEvent = projectAgentLoopEvent(afterLateAcceptance, 'run-lead', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-late-introduction',
    binding: binding().binding,
    sequence: 0,
    occurredAt: '2026-08-31T06:10:00.000Z',
    type: 'message',
    turn: 'turn-introduction',
    causation: { operationId: introduction.operationId },
    message: {
      messageId: 'message-introduction',
      role: 'assistant',
      purpose: 'member-self-introduction',
      content: [{ kind: 'text', text: 'Too late.' }],
    },
  }).room;
  assert.equal(afterLateEvent.items.length, 0);
  assert.equal(afterLateEvent.runs[0].agentLoopCursor, 0);
  assert.equal(afterLateEvent.runs[0].selfIntroduction.state, 'cancelled');
});

test('keeps live approval and cancellation transport failures observable', async () => {
  class RejectingClient extends V4Client {
    async decideApproval(command) {
      this.calls.push(command);
      throw new Error('live approval transport failure');
    }
    async cancelMemberSelfIntroduction(command) {
      this.calls.push(command);
      throw new Error('live cancellation transport failure');
    }
  }
  let room = planMemberSelfIntroduction(readyRoom('room-live-failure'), 'run-lead');
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentLoopController(
    new RejectingClient(),
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await assert.rejects(
    controller.decideApproval(
      'room-live-failure',
      'run-lead',
      'turn-live',
      'approval-live',
      'denied',
    ),
    /live approval transport failure/,
  );
  await assert.rejects(
    controller.cancelMemberSelfIntroduction('room-live-failure', 'run-lead'),
    /live cancellation transport failure/,
  );
  room = store.rooms.get('room-live-failure');
  assert.equal(room.approvalDecisions[0].state, 'sending-unknown');
  assert.equal(room.runs[0].selfIntroduction.cancellation.state, 'sending-unknown');
});
