import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomAgentSessionProjector } from '../dist/agent-session-projection.js';
import {
  addRoomRun,
  bindRoomRunSession,
  createRoom,
  recordRoomSessionSelfIntroduction,
} from '../dist/room.js';

const sessionId = 'session-one';

function roomFixture() {
  let room = createRoom({
    id: 'room',
    title: 'Room',
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
  });
  room = addRoomRun(room, {
    runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating',
  });
  room = bindRoomRunSession(room, 'review-run', sessionId);
  return room;
}

const event = (seq, type, data, extra = {}) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1,
  sessionId, seq, time: 1_788_000_000_000 + seq, type, data, ...extra,
});

const page = (phase, events, replayThrough = events.at(-1)?.seq ?? -1) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json',
  contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1,
  sessionId, sessionGeneration: 2, subscriptionGeneration: 3,
  replayThrough, phase, events,
});

test('projects exact SessionEvent message identity and explicit self-introduction causation into Shell v4', () => {
  let room = roomFixture();
  room = recordRoomSessionSelfIntroduction(room, 'review-run', {
    requestMessageId: 'intro-request',
    correlationId: 'intro-correlation',
    requestedAt: '2026-09-03T00:00:00.000Z',
  });
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room,
    room.runs[0],
    sessionId,
    () => ++sequence,
    { generation: 9, details: { kind: 'host', ref: 'agent-detail-one' } },
  );
  const projected = projector.project(page('replay', [
    event(0, 'user/message', {
      id: 'intro-request', role: 'user', content: [{ type: 'text', text: 'Introduce yourself' }],
      source: {
        kind: 'plugin', pluginId: 'chatroom', generation: 7, form: 'instructions',
        correlation: { namespace: 'chatroom.member-self-introduction', id: 'intro-correlation' },
      },
    }),
    event(1, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'assistant-introduction', role: 'assistant', content: [{ type: 'text', text: 'I review changes.' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [0] }),
  ]));

  assert.equal(projected.changes.length, 1, 'the private instruction is not surfaced');
  const item = projected.changes[0].item;
  assert.equal(item.kind, 'message');
  assert.deepEqual(item.source, { kind: 'session-event', sessionId, eventSeq: 1 });
  assert.equal(item.messageId, 'assistant-introduction');
  assert.deepEqual(item.semantic, {
    purpose: 'member-self-introduction',
    correlation: { sessionId, requestMessageId: 'intro-request' },
    participantId: 'reviewer', memberId: 'reviewer', runId: 'review-run',
  });
  assert.deepEqual(projected.activeRun, {
    participantId: 'reviewer', memberId: 'reviewer', runId: 'review-run', sessionId,
    lifecycle: { phase: 'active' }, details: { kind: 'host', ref: 'agent-detail-one' },
  });
});

test('keeps the submitted Room message before first-run self-introduction and reply', () => {
  const submitted = {
    kind: 'message', itemId: 'room-user-item', messageId: 'room-user-message', sequence: 1,
    source: 'agent-loop',
    author: {
      participantId: 'user', role: 'human',
      displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'You' },
    },
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message', fallback: 'hi' } }],
    reactions: [], timestamp: '2026-09-03T00:00:00.000Z', deliveryState: 'pending',
    runState: 'idle', ariaLive: 'off', actions: [],
  };
  let room = createRoom({
    id: 'room', title: 'Room', timelineSequence: submitted.sequence,
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
    items: [submitted],
  });
  room = addRoomRun(room, {
    runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating',
  });
  room = bindRoomRunSession(room, 'review-run', sessionId);
  room = recordRoomSessionSelfIntroduction(room, 'review-run', {
    requestMessageId: 'intro-request', correlationId: 'intro-correlation',
    requestedAt: '2026-09-03T00:00:00.001Z',
  });
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence, { generation: 9 },
  );
  const projected = projector.project(page('live', [
    event(1, 'user/message', {
      id: 'intro-request', role: 'user', content: [{ type: 'text', text: 'Introduce yourself' }],
      source: {
        kind: 'plugin', pluginId: 'chatroom', generation: 7, form: 'instructions',
        correlation: { namespace: 'chatroom.member-self-introduction', id: 'intro-correlation' },
      },
    }),
    event(2, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'assistant-introduction', role: 'assistant',
        content: [{ type: 'text', text: 'I review changes.' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [1] }),
    event(3, 'user/message', {
      id: 'room-runtime-message', role: 'user', content: [{ type: 'text', text: 'hi' }],
      source: {
        kind: 'plugin', pluginId: 'chatroom', generation: 7, form: 'relay',
        correlation: { namespace: 'chatroom.room-message', id: submitted.itemId },
      },
    }),
    event(4, 'assistant/message', {
      turn: 2, step: 1,
      message: {
        id: 'assistant-reply', role: 'assistant', content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [3] }),
  ], 4));

  const ordered = [...projected.items].sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(ordered.map(item => item.messageId), [
    'room-runtime-message', 'assistant-introduction', 'assistant-reply',
  ]);
  assert.equal(ordered[0].sequence, submitted.sequence);
  assert.ok(ordered[0].sequence < ordered[1].sequence);
  assert.ok(ordered[1].sequence < ordered[2].sequence);
  assert.equal(ordered[0].timestamp, submitted.timestamp);
});

test('projects approvals only with real Agent generation and updates from the matching SessionEvent decision', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence, { generation: 9 },
  );
  const asked = projector.project(page('live', [event(0, 'approval/asked', {
    id: 'approval-one', toolName: 'shell', reason: 'Needs permission',
  })], 0));
  const pending = asked.changes[0].item;
  assert.equal(pending.kind, 'approval');
  assert.equal(pending.sessionId, sessionId);
  assert.equal(pending.agentGeneration, 9);
  assert.equal(pending.approvalId, 'approval-one');
  assert.equal(pending.state, 'pending');

  const decided = projector.project(page('live', [event(1, 'approval/decided', {
    id: 'approval-one', outcome: 'allowed-once',
  })], 0));
  assert.equal(decided.changes[0].kind, 'item-updated');
  assert.equal(decided.changes[0].item.state, 'approved');
  assert.equal(decided.changes[0].item.sequence, pending.sequence);
  assert.equal(decided.items.length, 1);
});

test('hides a persisted delegation context envelope even without source event correlation', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence, { generation: 9 },
  );
  const context = JSON.stringify({
    self: { memberId: 'reviewer', label: 'Reviewer', runId: 'review-run' },
    delegatedBy: { memberId: 'leader', label: 'Lead', runId: 'lead-run' },
    reportsTo: { memberId: 'leader', label: 'Lead' },
    availableTargets: [{ memberId: 'qa', label: 'QA' }],
    communication: {
      mode: 'explicit-mention-required',
      rule: 'Prefix an ordinary Room message with @<memberId-or-label> to deliver it only to that entity. Without @, the message is Room-visible only.',
    },
    approvals: {
      mode: 'reports-to-hierarchy',
      next: { memberId: 'leader', label: 'Lead' },
      rule: 'Approval and permission requests follow reportsToMemberId upward; they do not use arbitrary @ routing.',
    },
  });
  const projected = projector.project(page('replay', [event(20, 'assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'assistant-delegated', role: 'assistant',
      content: [{
        type: 'text',
        text: `Playground Agent/Session fixture reply: [Chatroom delegation context]\n${context}\n\n最终链路验证`,
      }],
      source: { kind: 'model', provider: 'deterministic-agent-session', model: 'deterministic-v1' },
    },
  }, { sourceEventSeqs: null })], 20));

  const message = projected.changes[0].item;
  assert.equal(message.kind, 'message');
  assert.equal(message.body[0].text.fallback,
    'Playground Agent/Session fixture reply: 最终链路验证');
  assert.doesNotMatch(JSON.stringify(message.body), /Chatroom delegation context|delegatedBy/u);
});

test('keeps lookalike delegation text visible unless the exact legacy envelope validates', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence, { generation: 9 },
  );
  const lookalike = '[Chatroom delegation context]\n{"delegatedBy":"not-the-envelope"}\n\n保留正文';
  const projected = projector.project(page('replay', [event(21, 'assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'assistant-lookalike', role: 'assistant', content: [{ type: 'text', text: lookalike }],
      source: { kind: 'model', provider: 'provider', model: 'model' },
    },
  }, { sourceEventSeqs: null })], 21));

  assert.equal(projected.changes[0].item.body[0].text.fallback, lookalike);
});

test('never invents an Agent generation or self-introduction causation from missing facts', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(room, room.runs[0], sessionId, () => ++sequence);
  const projected = projector.project(page('replay', [
    event(0, 'approval/asked', { id: 'approval-one', toolName: 'shell' }),
    event(1, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'assistant-one', role: 'assistant', content: [{ type: 'text', text: 'A response' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }),
  ]));
  assert.equal(projected.changes.length, 1, 'approval is withheld without a real Agent generation');
  assert.deepEqual(projected.changes[0].item.semantic, { purpose: 'conversation' });
});

test('marks a Session surface replacement for one atomic Shell snapshot replacement', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(room, room.runs[0], sessionId, () => ++sequence);
  projector.project(page('replay', [event(1, 'user/message', {
    id: 'user-one', role: 'user', content: [{ type: 'text', text: 'Original' }], source: { kind: 'user' },
  })], 1));
  const replaced = projector.project(page('live', [event(2, 'user/message', {
    id: 'user-two', role: 'user', content: [{ type: 'text', text: 'Replacement' }], source: { kind: 'user' },
  }, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] })], 1));
  assert.equal(replaced.requiresSnapshotReplacement, true);
  assert.equal(replaced.items.length, 1);
  assert.equal(replaced.items[0].messageId, 'user-two');
  assert.deepEqual(replaced.items[0].source, { kind: 'session-event', sessionId, eventSeq: 2 });
});
