import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import { ChatroomAgentLoopController } from '../../dist/agent-loop-controller.js';
import { projectAgentLoopEvent } from '../../dist/agent-loop-projection.js';
import { createRoomConversationModel } from '../../dist/conversation-model.js';
import {
  markMemberSelfIntroductionSendingUnknown,
  memberSelfIntroductionOperationId,
  planMemberSelfIntroduction,
} from '../../dist/room-agent-operations.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../../dist/room-engagement.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

import { binding, readyRoom, roomWithRun, V4Client } from './fixtures.mjs';

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
