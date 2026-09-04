import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomAgentSessionProjector } from '../dist/agent-session-projection.js';
import {
  addRoomRun,
  bindRoomRunSession,
  createRoom,
  recordRoomAdmissionMessageLink,
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

test('projects exact SessionEvent message identity and explicit self-introduction causation into Shell v6', () => {
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

test('keeps B visible by exact admission identity while A stays pending, then rejects and cold-replays without duplicates', () => {
  const submitted = {
    kind: 'message', itemId: 'admitted-room-item', messageId: 'admitted-room-message', sequence: 1,
    source: 'agent-loop',
    author: {
      participantId: 'user', role: 'human',
      displayName: { namespace: 'chatroom', key: 'participant.name', fallback: 'You' },
    },
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message', fallback: 'Room copy must not win' } }],
    reactions: [], timestamp: '2026-09-04T00:00:00.000Z', deliveryState: 'pending',
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
  const eventData = {
    id: 'admission-message', role: 'user', content: [{ type: 'text', text: 'Host-authoritative body' }],
    source: { kind: 'plugin', pluginId: 'chatroom', generation: 7, form: 'relay' },
  };
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence, { generation: 9 },
  );
  const pendingA = event(0, 'approval/asked', {
    id: 'approval-a', toolName: 'shell', reason: 'A remains pending while B arrives',
  });
  const admittedB = event(1, 'user/message', eventData);
  const beforeLink = projector.project(page('live', [pendingA, admittedB]));
  assert.equal(beforeLink.items.length, 1, 'the unlinked B event is buffered, never inferred by text');
  assert.equal(beforeLink.items[0].kind, 'approval');
  assert.equal(beforeLink.items[0].state, 'pending');

  const linked = recordRoomAdmissionMessageLink(room, {
    roomId: room.id, itemId: submitted.itemId,
    participantId: 'reviewer', memberId: 'reviewer', runId: 'review-run',
    sessionId, messageId: 'admission-message', owner: { pluginId: 'chatroom', generation: 7 },
    appendAfterItemId: 'approval-a-opaque',
  });
  assert.equal(linked.admissionMessageLinks[0].appendAfterItemId, 'approval-a-opaque',
    'the owner document retains only an opaque projection ordering fence');
  const reconciled = projector.reconcileAdmissionLinks(linked, linked.runs[0]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].item.kind, 'message');
  assert.equal(reconciled[0].item.messageId, 'admission-message');
  assert.equal(reconciled[0].item.sequence, submitted.sequence);
  assert.equal(reconciled[0].item.timestamp, submitted.timestamp);
  assert.equal(reconciled[0].item.body[0].text.fallback, 'Host-authoritative body',
    'the associated Room item orders the message but never supplies its content');

  const afterLink = projector.snapshotItems();
  assert.equal(afterLink.filter(item => item.kind === 'message' && item.messageId === 'admission-message').length, 1);
  assert.equal(afterLink.find(item => item.kind === 'approval')?.state, 'pending',
    'an existing A approval never filters B from the Room projection');

  const duplicateLive = projector.project(page('live', [admittedB], 1));
  assert.equal(duplicateLive.items.filter(item => item.kind === 'message' && item.messageId === 'admission-message').length, 1,
    'duplicate live/replay delivery dedupes by the exact Session/message tuple');

  const rejected = projector.project(page('live', [event(2, 'approval/decided', {
    id: 'approval-a', outcome: 'rejected',
  })], 2));
  assert.equal(rejected.items.length, 2);
  assert.equal(rejected.items.find(item => item.kind === 'approval')?.state, 'denied');
  assert.equal(rejected.items.filter(item => item.kind === 'message' && item.messageId === 'admission-message').length, 1,
    'reject updates A in place and retains B');

  let coldSequence = linked.timelineSequence;
  const cold = new ChatroomAgentSessionProjector(
    linked, linked.runs[0], sessionId, () => ++coldSequence, { generation: 9 },
  );
  const replayed = cold.project(page('replay', [pendingA, admittedB, event(2, 'approval/decided', {
    id: 'approval-a', outcome: 'rejected',
  })]));
  assert.deepEqual(
    replayed.items.map(item => [item.kind, item.itemId, item.sequence, item.kind === 'message' ? item.messageId : item.state]),
    rejected.items.map(item => [item.kind, item.itemId, item.sequence, item.kind === 'message' ? item.messageId : item.state]),
    'cold replay preserves the same item ids, order, and count after rejection',
  );

  const foreignRoom = bindRoomRunSession(addRoomRun(linked, {
    runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating',
  }), 'lead-run', 'session-two');
  const unprojected = (data, messageSessionId = sessionId) => {
    const domain = messageSessionId === sessionId ? linked : foreignRoom;
    const run = domain.runs.find(candidate => candidate.runId === (
      messageSessionId === sessionId ? 'review-run' : 'lead-run'
    ));
    const probe = new ChatroomAgentSessionProjector(domain, run, messageSessionId, () => 99, { generation: 9 });
    const foreignEvent = { ...event(1, 'user/message', data), sessionId: messageSessionId };
    const foreignPage = { ...page('replay', [foreignEvent]), sessionId: messageSessionId, events: [foreignEvent] };
    return probe.project(foreignPage).items;
  };
  assert.equal(unprojected({ ...eventData, id: 'foreign-message' }).length, 0, 'foreign message id is hidden');
  assert.equal(unprojected({ ...eventData, source: { ...eventData.source, pluginId: 'foreign' } }).length, 0,
    'foreign plugin owner is hidden');
  assert.equal(unprojected({ ...eventData, source: { ...eventData.source, generation: 8 } }).length, 0,
    'stale plugin generation is hidden');
  assert.equal(unprojected(eventData, 'session-two').length, 0, 'foreign Session is hidden');
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
  assert.equal(pending.participantId, 'reviewer');
  assert.equal(pending.memberId, 'reviewer');
  assert.equal(pending.runId, 'review-run');
  assert.equal(pending.rationale.fallback, 'Needs permission');
  assert.deepEqual(pending.actions.map(action => action.decision), ['approve', 'deny', 'cancel']);

  const decided = projector.project(page('live', [event(1, 'approval/decided', {
    id: 'approval-one', outcome: 'allowed-once',
  })], 0));
  assert.equal(decided.changes[0].kind, 'item-updated');
  assert.equal(decided.changes[0].item.state, 'approved');
  assert.equal(decided.changes[0].item.agentGeneration, 9);
  assert.deepEqual(decided.changes[0].item.actions, []);
  assert.equal(decided.changes[0].item.sequence, pending.sequence);
  assert.equal(decided.items.length, 1);
});

test('cold replay correlates durable asked and decided into one actionless terminal approval without inventing generation', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence,
  );
  const projected = projector.project(page('replay', [
    event(22, 'approval/asked', {
      id: 'approval-cold', toolName: 'shell', reason: 'Needs durable permission',
    }),
    event(23, 'approval/decided', {
      id: 'approval-cold', outcome: 'allowed-once',
    }),
  ], 34));

  assert.equal(projected.changes.length, 1);
  assert.equal(projected.changes[0].kind, 'item-appended');
  assert.equal(projected.changes[0].eventSeq, 23);
  const terminal = projected.items[0];
  assert.equal(terminal.kind, 'approval');
  assert.equal(terminal.state, 'approved');
  assert.equal(terminal.sessionId, sessionId);
  assert.equal(terminal.approvalId, 'approval-cold');
  assert.equal('agentGeneration' in terminal, false);
  assert.deepEqual(terminal.actions, []);
  assert.equal(terminal.rationale.fallback, 'Needs durable permission');
});

test('cold replay projects unavailable as an actionless failed approval with a localized diagnostic', () => {
  const room = roomFixture();
  let sequence = room.timelineSequence;
  const projector = new ChatroomAgentSessionProjector(
    room, room.runs[0], sessionId, () => ++sequence,
  );
  const projected = projector.project(page('replay', [
    event(4, 'approval/asked', { id: 'approval-failed', toolName: 'shell' }),
    event(5, 'approval/decided', { id: 'approval-failed', outcome: 'unavailable' }),
  ], 5));
  const terminal = projected.items[0];
  assert.equal(terminal.kind, 'approval');
  assert.equal(terminal.state, 'failed');
  assert.equal('agentGeneration' in terminal, false);
  assert.deepEqual(terminal.actions, []);
  assert.deepEqual(terminal.diagnostic, {
    namespace: 'chatroom', key: 'agent.approval.unavailable', fallback: 'Approval unavailable',
  });
});

test('cold replay maps rejected and cancelled outcomes to actionless terminal states', () => {
  const room = roomFixture();
  for (const [outcome, state] of [['rejected', 'denied'], ['cancelled', 'cancelled']]) {
    let sequence = room.timelineSequence;
    const projector = new ChatroomAgentSessionProjector(
      room, room.runs[0], sessionId, () => ++sequence,
    );
    const projected = projector.project(page('replay', [
      event(6, 'approval/asked', { id: `approval-${outcome}`, toolName: 'shell' }),
      event(7, 'approval/decided', { id: `approval-${outcome}`, outcome }),
    ], 7));
    assert.equal(projected.items[0].state, state);
    assert.deepEqual(projected.items[0].actions, []);
    assert.equal('agentGeneration' in projected.items[0], false);
  }
});

test('cold replay never turns asked-only, unpaired, duplicate, or out-of-order approval facts into a card', () => {
  const room = roomFixture();
  const createProjector = () => {
    let sequence = room.timelineSequence;
    return new ChatroomAgentSessionProjector(
      room, room.runs[0], sessionId, () => ++sequence,
    );
  };

  const askedOnly = createProjector().project(page('replay', [
    event(8, 'approval/asked', { id: 'asked-only', toolName: 'shell' }),
  ], 8));
  assert.deepEqual(askedOnly.items, []);

  const unpaired = createProjector().project(page('replay', [
    event(9, 'approval/decided', { id: 'unpaired', outcome: 'allowed-once' }),
  ], 9));
  assert.deepEqual(unpaired.items, []);

  const duplicateAsked = createProjector().project(page('replay', [
    event(10, 'approval/asked', { id: 'duplicate-asked', toolName: 'shell' }),
    event(11, 'approval/asked', { id: 'duplicate-asked', toolName: 'shell' }),
    event(12, 'approval/decided', { id: 'duplicate-asked', outcome: 'allowed-once' }),
  ], 12));
  assert.deepEqual(duplicateAsked.items, []);

  const duplicateDecided = createProjector().project(page('replay', [
    event(13, 'approval/asked', { id: 'duplicate-decided', toolName: 'shell' }),
    event(14, 'approval/decided', { id: 'duplicate-decided', outcome: 'allowed-once' }),
    event(15, 'approval/decided', { id: 'duplicate-decided', outcome: 'allowed-once' }),
  ], 15));
  assert.deepEqual(duplicateDecided.items, []);
  assert.equal(duplicateDecided.requiresSnapshotReplacement, true);

  const outOfOrder = createProjector().project(page('replay', [
    event(17, 'approval/decided', { id: 'out-of-order', outcome: 'allowed-once' }),
    event(16, 'approval/asked', { id: 'out-of-order', toolName: 'shell' }),
  ], 17));
  assert.deepEqual(outOfOrder.items, []);

  const foreign = createProjector();
  assert.throws(() => foreign.project({
    ...page('replay', [event(18, 'approval/asked', {
      id: 'foreign-session', toolName: 'shell',
    })], 18),
    sessionId: 'session-foreign',
  }), /foreign Session page/u);
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

test('never invents pending approval generation or self-introduction causation from missing facts', () => {
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
