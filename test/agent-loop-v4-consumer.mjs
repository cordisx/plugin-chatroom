import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../dist/agent-loop-projection.js';
import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
  createRoomConversationModel,
} from '../dist/conversation-model.js';
import { ChatroomConversationController } from '../dist/conversation-source.js';
import {
  acceptMemberSelfIntroduction,
  approvalDecisionOperationId,
  markMemberSelfIntroductionSendingUnknown,
  memberSelfIntroductionOperationId,
  planMemberSelfIntroduction,
} from '../dist/room-agent-operations.js';
import { addRoomRun, createRoom } from '../dist/room.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../dist/room-engagement.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';

const binding = (generation = 1) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v4',
  schemaVersion: 4,
  binding: { bindingId: `binding-${generation}`, generation },
  definition: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members[0].definition,
  task: 'task-lead',
  state: 'active',
});

const memberBinding = (memberId, generation = 1) => {
  const member = CHATROOM_DEFAULT_AGENT_CONFIGURATION.members
    .find(candidate => candidate.memberId === memberId);
  return {
    ...binding(generation),
    binding: { bindingId: `binding-${memberId}-${generation}`, generation },
    definition: member.definition,
    task: `task-${memberId}`,
  };
};

const roomWithRun = (id = 'room-v4') =>
  addRoomRun(
    createRoom({
      id,
      title: 'V4 room',
      participants: [{ id: 'leader', name: 'Lead', kind: 'agent' }],
    }),
    {
      runId: 'run-lead',
      memberId: 'leader',
      title: 'Lead run',
      status: 'creating',
    },
  );

const readyRoom = (id = 'room-v4') =>
  acceptRoomRunPresence(
    roomWithRun(id),
    'run-lead',
    binding(),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-lead', target: 'host' }),
  );

const multiReadyRoom = (id = 'room-v4-multi') => {
  let room = createRoom({
    id,
    title: 'V4 multi-agent room',
    participants: [
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
  });
  room = addRoomRun(room, {
    runId: 'run-lead',
    memberId: 'leader',
    title: 'Lead run',
    status: 'creating',
  });
  room = addRoomRun(room, {
    runId: 'run-reviewer',
    memberId: 'reviewer',
    title: 'Reviewer run',
    status: 'creating',
  });
  room = acceptRoomRunPresence(
    room,
    'run-lead',
    memberBinding('leader'),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-lead', target: 'host' }),
  );
  return acceptRoomRunPresence(
    room,
    'run-reviewer',
    memberBinding('reviewer'),
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-reviewer', target: 'host' }),
  );
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class V4Client {
  calls = [];
  introductionDisposition = 'executed';

  async createOrBind(command) {
    this.calls.push(command);
    const created = binding();
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
      binding: created,
      detailsUrl: { url: 'app:simulator/task-lead', target: 'host' },
      delivery: { disposition: 'executed' },
    };
  }

  async requestMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      turn: 'turn-introduction',
      messageId: 'message-introduction',
      causation: { operationId: command.commandId },
      delivery: { disposition: this.introductionDisposition },
    };
  }

  async cancelMemberSelfIntroduction(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      participantId: command.participantId,
      memberId: command.memberId,
      runId: command.runId,
      requestOperationId: command.requestOperationId,
      turn: 'turn-introduction',
      messageId: 'message-introduction',
      causation: { operationId: command.commandId },
      delivery: { disposition: 'replayed' },
    };
  }

  async decideApproval(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'approvals.decide', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      turn: command.turn,
      approvalId: command.approvalId,
      decision: command.decision,
      causation: { operationId: command.commandId },
      delivery: { disposition: 'executed' },
    };
  }

  async send(command) {
    this.calls.push(command);
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
      binding: command.binding,
      messageId: `message-${command.commandId}`,
      turn: `turn-${command.commandId}`,
      delivery: { disposition: 'executed' },
    };
  }

  async subscribe(bindingValue, afterSequence) {
    this.calls.push({ type: 'subscribe', binding: bindingValue, afterSequence });
    const subscription = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
      contract: 'cordisx.agent-loop-event-subscription/v4',
      schemaVersion: 4,
      subscriptionId: 'subscription-v4',
      binding: bindingValue.binding,
      afterSequence,
      snapshotSequence: afterSequence,
    };
    return {
      status: 'accepted',
      authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
      handle: {
        subscription,
        unsubscribe() {},
        pages: { async *[Symbol.asyncIterator]() {} },
      },
    };
  }

  dispose() {}
}

test('durably requests one exact free-form member introduction after binding commit', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRun()]);
  const client = new V4Client();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  await controller.sendToRoom('room-v4', 'run-lead', 'user-1', [{ kind: 'text', text: 'Hello' }]);
  await controller.sendToRoom('room-v4', 'run-lead', 'user-2', [{ kind: 'text', text: 'Again' }]);

  const introductions = client.calls.filter(call => call.type === 'request-member-self-introduction');
  assert.equal(introductions.length, 1);
  assert.deepEqual(introductions[0].intent, {
    kind: 'member-self-introduction',
    audience: 'room',
    output: 'assistant-message',
  });
  assert.equal('issuedAt' in introductions[0], false);
  assert.equal('content' in introductions[0], false);
  assert.equal('prompt' in introductions[0], false);
  assert.equal(introductions[0].participantId, 'leader');
  assert.equal(introductions[0].memberId, 'leader');
  assert.equal(introductions[0].runId, 'run-lead');
  assert.equal(
    introductions[0].commandId,
    memberSelfIntroductionOperationId(
      'room-v4',
      'leader',
      'leader',
      'run-lead',
      introductions[0].binding,
    ),
  );
  assert.match(introductions[0].commandId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const stored = store.rooms.get('room-v4').runs[0].selfIntroduction;
  assert.equal(stored.state, 'accepted');
  assert.equal(stored.acceptance.turn, 'turn-introduction');
  assert.equal(stored.acceptance.messageId, 'message-introduction');
});

test('replays an unknown introduction with the same exact operation and never mints a duplicate', async () => {
  class UnknownOnceClient extends V4Client {
    attempts = 0;
    async requestMemberSelfIntroduction(command) {
      this.calls.push(command);
      this.attempts += 1;
      if (this.attempts === 1) throw new Error('transport outcome unknown');
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
        contract: 'cordisx.agent-loop-result/v4',
        schemaVersion: 4,
        commandId: command.commandId,
        type: command.type,
        status: 'accepted',
        authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
        binding: command.binding,
        participantId: command.participantId,
        memberId: command.memberId,
        runId: command.runId,
        turn: 'turn-introduction',
        messageId: 'message-introduction',
        causation: { operationId: command.commandId },
        delivery: { disposition: 'reconciled' },
      };
    }
  }
  const store = DurableChatroomRoomStore.memory([roomWithRun('room-replay')]);
  const client = new UnknownOnceClient();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await assert.rejects(
    controller.sendToRoom('room-replay', 'run-lead', 'user-1', [{ kind: 'text', text: 'Hello' }]),
    /outcome unknown/,
  );
  await controller.sendToRoom('room-replay', 'run-lead', 'user-1', [{ kind: 'text', text: 'Hello' }]);
  const introductions = client.calls.filter(call => call.type === 'request-member-self-introduction');
  assert.equal(introductions.length, 2);
  assert.deepEqual(introductions[1], introductions[0]);
  assert.equal(store.rooms.get('room-replay').runs[0].selfIntroduction.acceptance.disposition, 'reconciled');
});

test('reload hydration preserves an unknown introduction without minting a new operation', async () => {
  let room = markMemberSelfIntroductionSendingUnknown(
    planMemberSelfIntroduction(readyRoom('room-rebind-unknown'), 'run-lead'),
    'run-lead',
  );
  const originalOperationId = room.runs[0].selfIntroduction.operationId;
  const store = DurableChatroomRoomStore.memory([room]);
  class RebindingClient extends V4Client {
    async createOrBind(command) {
      this.calls.push(command);
      const rebound = { ...binding(2), task: command.target.task };
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
        contract: 'cordisx.agent-loop-result/v4',
        schemaVersion: 4,
        commandId: command.commandId,
        type: command.type,
        status: 'accepted',
        authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
        binding: rebound,
        detailsUrl: { url: 'app:simulator/task-lead', target: 'host' },
        delivery: { disposition: 'reconciled' },
      };
    }
  }
  const client = new RebindingClient();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.hydrate();
  room = store.rooms.get('room-rebind-unknown');
  assert.equal(room.runs[0].selfIntroduction.operationId, originalOperationId);
  assert.equal(room.runs[0].selfIntroduction.state, 'sending-unknown');
  assert.equal(room.runs[0].selfIntroduction.attention, undefined);
  assert.equal(client.calls.some(call => call.type === 'create-or-bind'), false);
  assert.equal(client.calls.some(call => call.type === 'request-member-self-introduction'), false);
});

test('cancellation uses an independent stable operation and exact original request id', async () => {
  const store = DurableChatroomRoomStore.memory([roomWithRun('room-cancel')]);
  const client = new V4Client();
  const controller = new ChatroomAgentLoopController(
    client,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.sendToRoom('room-cancel', 'run-lead', 'user-1', [{ kind: 'text', text: 'Hello' }]);
  const request = client.calls.find(call => call.type === 'request-member-self-introduction');
  const result = await controller.cancelMemberSelfIntroduction('room-cancel', 'run-lead');
  const cancellation = client.calls.find(call => call.type === 'cancel-member-self-introduction');
  assert.equal(result.status, 'accepted');
  assert.equal(cancellation.requestOperationId, request.commandId);
  assert.notEqual(cancellation.commandId, request.commandId);
  assert.equal('issuedAt' in cancellation, false);
  assert.equal(store.rooms.get('room-cancel').runs[0].selfIntroduction.state, 'cancelled');
});

test('projects only exact purpose and causation as one Agent-authored introduction message', () => {
  let room = planMemberSelfIntroduction(readyRoom(), 'run-lead');
  const operationId = room.runs[0].selfIntroduction.operationId;
  const event = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-introduction',
    binding: binding().binding,
    sequence: 0,
    occurredAt: '2026-08-31T06:00:00.000Z',
    type: 'message',
    turn: 'turn-introduction',
    causation: { operationId },
    message: {
      messageId: 'message-introduction',
      role: 'assistant',
      purpose: 'member-self-introduction',
      content: [{ kind: 'text', text: 'I am introducing myself freely.' }],
    },
  };
  room = projectAgentLoopEvent(room, 'run-lead', event).room;
  assert.equal(room.items.length, 1);
  assert.equal(room.items[0].source, 'agent-loop');
  assert.equal(room.items[0].semantic.purpose, 'member-self-introduction');
  assert.equal(room.items[0].semantic.causation.operationId, operationId);
  assert.equal(room.items[0].author.participantId, 'leader');
  assert.equal(room.items[0].body[0].text.fallback, 'I am introducing myself freely.');
  assert.equal(room.runs[0].selfIntroduction.state, 'completed');
  const shellItem = createRoomConversationModel(room).items[0];
  assert.equal(shellItem.semantic.purpose, 'member-self-introduction');
  assert.deepEqual(shellItem.author.agentIdentity, binding().definition);

  const reboundBinding = {
    ...binding(2),
    task: binding().task,
  };
  const rebound = acceptRoomRunPresence(
    room,
    'run-lead',
    reboundBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:simulator/task-lead', target: 'host' }),
  );
  const replay = projectAgentLoopEvent(
    rebound,
    'run-lead',
    {
      ...event,
      eventId: 'event-introduction-replay',
      sequence: 10,
      binding: reboundBinding.binding,
    },
  ).room;
  assert.equal(replay.items.length, 1);
  assert.equal(replay.timelineSequence, room.timelineSequence);

  const foreign = projectAgentLoopEvent(
    { ...room, runs: [{ ...room.runs[0], agentLoopCursor: -1 }] },
    'run-lead',
    {
      ...event,
      eventId: 'event-wrong-causation',
      sequence: 11,
      causation: { operationId: 'different-operation' },
    },
  ).room;
  assert.equal(foreign.items.length, 1);
  assert.equal(foreign.runs[0].agentLoopCursor, 11);
});

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

test('dispose fences accepted, denied, and rejected send outcomes before CAS or subscribe', async t => {
  for (const outcomeKind of ['accepted', 'denied', 'rejected']) {
    await t.test(outcomeKind, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredSendClient extends V4Client {
        async send(command) {
          this.calls.push(command);
          started.resolve(command);
          return await result.promise;
        }
      }
      const roomId = `room-send-${outcomeKind}`;
      const store = DurableChatroomRoomStore.memory([readyRoom(roomId)]);
      const client = new DeferredSendClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.sendToRoom(
        roomId,
        'run-lead',
        `user-${outcomeKind}`,
        [{ kind: 'text', text: outcomeKind }],
      );
      const command = await started.promise;
      controller.dispose();
      if (outcomeKind === 'accepted') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'accepted',
          authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
          binding: command.binding,
          messageId: 'message-late-send',
          turn: 'turn-late-send',
          delivery: { disposition: 'executed' },
        });
      } else if (outcomeKind === 'denied') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'denied',
          authorization: { capability: 'turns.submit', state: 'denied', code: 'permission-denied' },
          code: 'permission-denied',
        });
      } else {
        result.reject(new Error('late rejected send'));
      }
      assert.deepEqual(await pending, {
        status: 'unavailable',
        roomId,
        runId: 'run-lead',
        bindingCreated: false,
        code: 'controller-replaced',
      });
      assert.equal(client.calls.filter(call => call.type === 'subscribe').length, 0);
      const sendDelivery = store.rooms.get(roomId).deliveries
        .find(delivery => delivery.operation.kind === 'send');
      assert.equal(sendDelivery.state, 'sending-unknown');
      assert.equal(sendDelivery.acceptance, undefined);
    });
  }
});

test('dispose fences late create and hydration-probe outcomes before binding/details commit', async t => {
  await t.test('create accepted', async () => {
    const started = deferred();
    const result = deferred();
    class DeferredCreateClient extends V4Client {
      async createOrBind(command) {
        this.calls.push(command);
        started.resolve(command);
        return await result.promise;
      }
    }
    const store = DurableChatroomRoomStore.memory([roomWithRun('room-create-dispose')]);
    const client = new DeferredCreateClient();
    const controller = new ChatroomAgentLoopController(
      client,
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const pending = controller.sendToRoom(
      'room-create-dispose',
      'run-lead',
      'user-create-dispose',
      [{ kind: 'text', text: 'Hello' }],
    );
    const command = await started.promise;
    controller.dispose();
    result.resolve({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
      contract: 'cordisx.agent-loop-result/v4',
      schemaVersion: 4,
      commandId: command.commandId,
      type: command.type,
      status: 'accepted',
      authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
      binding: binding(),
      detailsUrl: { url: 'app:simulator/task-late-create', target: 'host' },
      delivery: { disposition: 'executed' },
    });
    assert.deepEqual(await pending, {
      status: 'unavailable',
      roomId: 'room-create-dispose',
      runId: 'run-lead',
      bindingCreated: false,
      code: 'controller-replaced',
    });
    const run = store.rooms.get('room-create-dispose').runs[0];
    assert.equal(run.taskBinding, undefined);
    assert.equal(run.detailsUrl, undefined);
    assert.equal(client.calls.some(call => call.type === 'request-member-self-introduction'), false);
    assert.equal(client.calls.some(call => call.type === 'send'), false);
  });

  for (const outcomeKind of ['denied', 'rejected']) {
    await t.test(`create ${outcomeKind}`, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredCreateClient extends V4Client {
        async createOrBind(command) {
          this.calls.push(command);
          started.resolve(command);
          return await result.promise;
        }
      }
      const roomId = `room-create-${outcomeKind}`;
      const store = DurableChatroomRoomStore.memory([roomWithRun(roomId)]);
      const client = new DeferredCreateClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.sendToRoom(
        roomId,
        'run-lead',
        `user-create-${outcomeKind}`,
        [{ kind: 'text', text: 'Hello' }],
      );
      const command = await started.promise;
      controller.dispose();
      if (outcomeKind === 'denied') {
        result.resolve({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-result.v4.schema.json',
          contract: 'cordisx.agent-loop-result/v4',
          schemaVersion: 4,
          commandId: command.commandId,
          type: command.type,
          status: 'denied',
          authorization: { capability: 'tasks.create', state: 'denied', code: 'permission-denied' },
          code: 'permission-denied',
        });
      } else {
        result.reject(new Error('late rejected create'));
      }
      assert.deepEqual(await pending, {
        status: 'unavailable',
        roomId,
        runId: 'run-lead',
        bindingCreated: false,
        code: 'controller-replaced',
      });
      const run = store.rooms.get(roomId).runs[0];
      assert.equal(run.taskBinding, undefined);
      assert.equal(run.detailsUrl, undefined);
      assert.equal(client.calls.some(call => call.type === 'send'), false);
    });
  }

  for (const outcomeKind of ['accepted', 'denied', 'rejected']) {
    await t.test(`hydrate probe ${outcomeKind}`, async () => {
      const started = deferred();
      const result = deferred();
      class DeferredProbeClient extends V4Client {
        async subscribe(bindingValue, afterSequence) {
          this.calls.push({ type: 'subscribe', binding: bindingValue, afterSequence });
          started.resolve({ binding: bindingValue, afterSequence });
          return await result.promise;
        }
      }
      const roomId = `room-bind-${outcomeKind}`;
      const original = readyRoom(roomId);
      const store = DurableChatroomRoomStore.memory([original]);
      const client = new DeferredProbeClient();
      const controller = new ChatroomAgentLoopController(
        client,
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const pending = controller.hydrate();
      const probe = await started.promise;
      controller.dispose();
      if (outcomeKind === 'accepted') {
        const subscription = {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event-subscription.v4.schema.json',
          contract: 'cordisx.agent-loop-event-subscription/v4',
          schemaVersion: 4,
          subscriptionId: `subscription-${outcomeKind}`,
          binding: probe.binding.binding,
          afterSequence: probe.afterSequence,
          snapshotSequence: probe.afterSequence,
        };
        result.resolve({
          status: 'accepted',
          authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
          handle: {
            subscription,
            unsubscribe() {},
            pages: { async *[Symbol.asyncIterator]() {} },
          },
        });
      } else if (outcomeKind === 'denied') {
        result.resolve({
          status: 'denied',
          authorization: { capability: 'tasks.content.read', state: 'denied', code: 'permission-denied' },
        });
      } else {
        result.reject(new Error('late rejected probe'));
      }
      await pending;
      const run = store.rooms.get(roomId).runs[0];
      assert.deepEqual(run.taskBinding.binding, original.runs[0].taskBinding.binding);
      assert.deepEqual(run.detailsUrl, original.runs[0].detailsUrl);
      assert.equal(run.rebind, undefined);
      assert.equal(client.calls.filter(call => call.type === 'subscribe').length, 1);
      assert.equal(client.calls.filter(call => call.type === 'create-or-bind').length, 0);
    });
  }
});

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
