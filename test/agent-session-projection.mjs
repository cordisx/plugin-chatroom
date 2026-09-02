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
