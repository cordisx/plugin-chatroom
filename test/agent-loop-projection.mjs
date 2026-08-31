import assert from 'node:assert/strict';
import test from 'node:test';

import { projectAgentLoopEvent } from '../dist/agent-loop-projection.js';
import { createRoomConversationModel } from '../dist/conversation-model.js';
import {
  addRoomRun,
  CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS,
  createChatroomOpaqueId,
  createRoom,
} from '../dist/room.js';
import { acceptRoomRunPresence, createStoredRoomRunDetailsUrl } from '../dist/room-engagement.js';

const identities = {
  lead: { agentId: 'chatroom.generalist', revision: 'chatroom-internal-v1' },
  review: { agentId: 'chatroom.reviewer', revision: 'chatroom-internal-v1' },
};
const binding = (id, definition, generation = 1) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json',
  contract: 'cordisx.agent-loop-task-binding/v2', schemaVersion: 2,
  binding: { bindingId: `Opaque:Binding-${id}`, generation }, definition,
  task: `Opaque:Task-${id}`, state: 'active',
});
const members = [
  {
    memberId: 'lead', label: 'Lead', definition: identities.lead, role: 'leader', attentionPolicy: 'ambient',
    avatar: { kind: 'asset', ref: 'oneworks-avatar:asset.red-fox.v1',
      revision: 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa' },
  },
  {
    memberId: 'review', label: 'Review', definition: identities.review, role: 'member',
    attentionPolicy: 'mention-only', reportsToMemberId: 'lead',
    avatar: { kind: 'asset', ref: 'oneworks-avatar:asset.arctic-fox.v1',
      revision: 'oneworks-avatar:editor-arctic-fox-2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011' },
  },
];

function room() {
  let result = createRoom({
    id: 'room-1', title: 'Review', memberships: members, seedLeaderIds: ['lead'],
    participants: [
      { id: 'lead', name: 'Lead', kind: 'agent' },
      { id: 'review', name: 'Review', kind: 'agent' },
    ],
  });
  result = addRoomRun(result, { runId: 'lead-run', memberId: 'lead', title: 'Lead run', status: 'creating' });
  result = addRoomRun(result, { runId: 'review-run', memberId: 'review', title: 'Review run', status: 'creating' });
  result = acceptRoomRunPresence(
    result, 'lead-run', binding('lead', identities.lead),
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead', target: 'host' }),
  );
  return acceptRoomRunPresence(
    result, 'review-run', binding('review', identities.review),
    createStoredRoomRunDetailsUrl({ url: 'app:task/review', target: 'host' }),
  );
}

const event = (runBinding, sequence, extra) => ({
  $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
  eventId: `event-${runBinding.binding.bindingId}-${sequence}`,
  binding: runBinding.binding, sequence, occurredAt: '2026-08-30T00:00:00.000Z', ...extra,
});

test('keeps per-run cursors independent while Room assigns one public timeline sequence', () => {
  const initial = room();
  const leadBinding = initial.runs[0].taskBinding;
  const reviewBinding = initial.runs[1].taskBinding;
  const lead = projectAgentLoopEvent(initial, 'lead-run', event(leadBinding, 0, {
    type: 'message', message: { messageId: 'lead-0', role: 'assistant', content: [{ kind: 'text', text: 'Lead answer' }] },
  })).room;
  const review = projectAgentLoopEvent(lead, 'review-run', event(reviewBinding, 0, {
    type: 'message', message: { messageId: 'review-0', role: 'assistant', content: [{ kind: 'text', text: 'Review answer' }] },
  })).room;

  assert.deepEqual(review.runs.map(run => run.agentLoopCursor), [0, 0]);
  assert.deepEqual(review.items.map(item => item.sequence), [3, 4]);
  assert.deepEqual(review.items.map(item => item.kind === 'message' && item.author.participantId), ['lead', 'review']);
  assert.deepEqual(review.items.map(item => item.kind === 'message' && item.author.avatar?.ref), [
    'oneworks-avatar:asset.red-fox.v1',
    'oneworks-avatar:asset.arctic-fox.v1',
  ]);
  assert.deepEqual(review.items[0].author.avatar, review.participants[0].avatar);
  assert.deepEqual(review.items[1].author.avatar, review.participants[1].avatar);
  const selection = createRoomConversationModel(review).selection;
  assert.equal(selection.kind, 'room');
  assert.deepEqual(review.items[0].author, selection.participants[0]);
  assert.deepEqual(review.items[1].author, selection.participants[1]);
});

test('projects only public assistant content and keeps image-ref opaque/unsupported', () => {
  const initial = room();
  const runBinding = initial.runs[0].taskBinding;
  const echoed = projectAgentLoopEvent(initial, 'lead-run', event(runBinding, 0, {
    type: 'message', message: { messageId: 'user-0', role: 'user', content: [{ kind: 'text', text: 'private echo' }] },
  })).room;
  const projected = projectAgentLoopEvent(echoed, 'lead-run', event(runBinding, 1, {
    type: 'message', message: { messageId: 'assistant-1', role: 'assistant', content: [
      { kind: 'text', text: 'Done' },
      { kind: 'image-ref', ref: 'Opaque:Image-1', mediaType: 'image/png', alt: 'Screenshot' },
    ] },
  })).room;

  assert.equal(echoed.items.length, 0);
  assert.equal(projected.items.length, 1);
  assert.equal(projected.imageReferences[0].ref, 'Opaque:Image-1');
  assert.equal(JSON.stringify(projected.items).includes('Opaque:Image-1'), false);
  assert.equal(JSON.stringify(projected).includes('base64'), false);
  assert.equal(JSON.stringify(projected).includes('path'), false);
});

test('projects approval and turn lifecycle while keeping a completed turn active and reusable', () => {
  const initial = room();
  const runBinding = initial.runs[0].taskBinding;
  const pending = projectAgentLoopEvent(initial, 'lead-run', event(runBinding, 0, {
    type: 'approval', turn: 'turn-1', approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' },
  })).room;
  const resolved = projectAgentLoopEvent(pending, 'lead-run', event(runBinding, 1, {
    type: 'approval', turn: 'turn-1', approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' },
  })).room;
  const completed = projectAgentLoopEvent(resolved, 'lead-run', event(runBinding, 2, {
    type: 'lifecycle', lifecycle: { phase: 'turn.completed' },
  })).room;

  assert.deepEqual(completed.items.map(item => item.label.fallback), [
    'Waiting for approval', 'Approval completed',
  ]);
  assert.equal(completed.runs[0].status, 'active');
  assert.equal(completed.memberships.some(member => member.memberId === 'lead'), true);
  assert.equal(createRoomConversationModel(completed).selection.activeRuns[0].lifecycle.phase, 'active');

  const reboundBinding = {
    ...runBinding,
    binding: { bindingId: 'Opaque:Binding-approval-rebound', generation: 2 },
  };
  const rebound = acceptRoomRunPresence(
    completed, 'lead-run', reboundBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/approval-rebound', target: 'host' }),
  );
  const replayedPending = projectAgentLoopEvent(rebound, 'lead-run', event(reboundBinding, 10, {
    eventId: 'event-approval-rebound-pending',
    type: 'approval', turn: 'turn-1',
    approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' },
  })).room;
  const replayedResolved = projectAgentLoopEvent(replayedPending, 'lead-run', event(reboundBinding, 11, {
    eventId: 'event-approval-rebound-resolved',
    type: 'approval', turn: 'turn-1',
    approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' },
  })).room;
  assert.equal(replayedResolved.items.length, 2);
  assert.equal(new Set(replayedResolved.items.map(item => item.itemId)).size, 2);
  assert.equal(replayedResolved.runs[0].agentLoopCursor, 11);
});

test('rejects cross-run generations, duplicate sequences, and post-close events', () => {
  const initial = room();
  const runBinding = initial.runs[0].taskBinding;
  assert.equal(projectAgentLoopEvent(initial, 'review-run', event(runBinding, 0, {
    type: 'lifecycle', lifecycle: { phase: 'turn.started' },
  })).accepted, false);
  assert.equal(projectAgentLoopEvent(initial, 'lead-run', event({ ...runBinding, binding: { ...runBinding.binding, generation: 2 } }, 0, {
    type: 'lifecycle', lifecycle: { phase: 'turn.started' },
  })).accepted, false);
  const accepted = projectAgentLoopEvent(initial, 'lead-run', event(runBinding, 0, {
    type: 'lifecycle', lifecycle: { phase: 'turn.started' },
  })).room;
  assert.equal(projectAgentLoopEvent(accepted, 'lead-run', event(runBinding, 0, {
    type: 'lifecycle', lifecycle: { phase: 'turn.completed' },
  })).accepted, false);
  const closed = projectAgentLoopEvent(accepted, 'lead-run', event(runBinding, 1, {
    type: 'lifecycle', lifecycle: { phase: 'binding.closed' },
  })).room;
  assert.equal(createRoomConversationModel(closed).selection.activeRuns
    .some(run => run.runId === 'lead-run'), false);
  assert.equal(projectAgentLoopEvent(closed, 'lead-run', event(runBinding, 2, {
    type: 'message', message: { messageId: 'late', role: 'assistant', content: [{ kind: 'text', text: 'Late' }] },
  })).accepted, false);
});

test('rebind replay advances the new cursor without duplicating stable public items', () => {
  const initial = room();
  const firstBinding = initial.runs[0].taskBinding;
  const message = {
    eventId: 'event-stable-message', type: 'message', turn: 'turn-stable',
    causation: { operationId: 'operation-stable' },
    message: { messageId: 'assistant-stable', role: 'assistant', content: [
      { kind: 'text', text: 'Stable answer' },
      { kind: 'image-ref', ref: 'Opaque:Image-Stable', mediaType: 'image/png', alt: 'Stable image' },
    ] },
  };
  const completedLifecycle = {
    eventId: 'event-stable-completed', type: 'lifecycle', turn: 'turn-stable',
    causation: { operationId: 'operation-stable' }, lifecycle: { phase: 'turn.completed' },
  };
  const projected = projectAgentLoopEvent(initial, 'lead-run', event(firstBinding, 0, message)).room;
  const completed = projectAgentLoopEvent(
    projected, 'lead-run', event(firstBinding, 1, completedLifecycle),
  ).room;
  const existingItem = completed.items[0];
  const existingTimelineSequence = completed.timelineSequence;
  const reboundBinding = {
    ...firstBinding,
    binding: { bindingId: 'Opaque:Binding-lead-rebound', generation: 2 },
  };
  const rebound = acceptRoomRunPresence(
    completed, 'lead-run', reboundBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead-rebound', target: 'host' }),
  );
  assert.equal(rebound.runs[0].agentLoopCursor, -1);

  const replayedMessage = projectAgentLoopEvent(
    rebound, 'lead-run', event(reboundBinding, 10, {
      ...message,
      eventId: 'event-rebound-message',
    }),
  ).room;
  const replayedCompleted = projectAgentLoopEvent(
    replayedMessage, 'lead-run', event(reboundBinding, 11, {
      ...completedLifecycle,
      eventId: 'event-rebound-completed',
    }),
  ).room;
  assert.equal(replayedCompleted.items.length, 1);
  assert.equal(replayedCompleted.items[0], existingItem, 'the first durable public item remains exact');
  assert.equal(replayedCompleted.imageReferences.length, 1);
  assert.equal(replayedCompleted.timelineSequence, existingTimelineSequence);
  assert.equal(replayedCompleted.runs[0].agentLoopCursor, 11);
  assert.equal(replayedCompleted.runs[0].status, 'active');

  const next = projectAgentLoopEvent(replayedCompleted, 'lead-run', event(reboundBinding, 12, {
    eventId: 'event-distinct-message', type: 'message', turn: 'turn-distinct',
    causation: { operationId: 'operation-distinct' },
    message: {
      messageId: 'assistant-distinct', role: 'assistant', content: [{ kind: 'text', text: 'Distinct turn' }],
    },
  })).room;
  assert.equal(next.items.length, 2);
  assert.equal(new Set(next.items.map(item => item.itemId)).size, next.items.length);
  assert.equal(next.runs[0].agentLoopCursor, 12);

  const secondRoom = createRoom({ ...room(), id: 'room-2', title: 'Other Room' });
  const secondBinding = secondRoom.runs[0].taskBinding;
  const secondProjected = projectAgentLoopEvent(
    secondRoom, 'lead-run', event(secondBinding, 0, message),
  ).room;
  assert.equal(secondProjected.items.length, 1);
  assert.equal(next.items.length, 2, 'another Room projection cannot mutate the first Room');
});

test('fails closed when a semantic projection id collides with an incompatible public item', () => {
  const initial = room();
  const runBinding = initial.runs[0].taskBinding;
  const assistant = event(runBinding, 0, {
    eventId: 'event-collision-source', type: 'message', turn: 'turn-collision',
    message: {
      messageId: 'assistant-collision', role: 'assistant',
      content: [{ kind: 'text', text: 'Must not be swallowed' }],
    },
  });
  const projected = projectAgentLoopEvent(initial, 'lead-run', assistant).room;
  const itemId = projected.items[0].itemId;
  const collision = createRoom({
    ...initial,
    timelineSequence: initial.timelineSequence + 1,
    items: [{
      kind: 'status', itemId, sequence: initial.timelineSequence + 1,
      label: { fallback: 'Unrelated status' }, state: 'info', ariaLive: 'off',
    }],
  });

  assert.throws(
    () => projectAgentLoopEvent(collision, 'lead-run', assistant),
    /projection identity collided/,
  );
  assert.throws(() => createRoom({
    ...initial,
    items: [projected.items[0], projected.items[0]],
  }), /timeline item ids must be unique/);
  assert.throws(() => createRoom({
    ...projected,
    items: collision.items,
  }), /projection does not match its visible timeline item/);

  const truncated = createRoom({ ...projected, items: [], imageReferences: [] });
  const reboundBinding = {
    ...runBinding,
    binding: { bindingId: 'Opaque:Binding-truncated-rebound', generation: 2 },
  };
  const rebound = acceptRoomRunPresence(
    truncated, 'lead-run', reboundBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/truncated-rebound', target: 'host' }),
  );
  const replayed = projectAgentLoopEvent(rebound, 'lead-run', event(reboundBinding, 10, {
    eventId: 'event-truncated-replay',
    type: assistant.type,
    turn: assistant.turn,
    message: assistant.message,
  })).room;
  assert.equal(replayed.items.length, 0, 'a valid truncated correlation suppresses only its exact replay');
  assert.equal(replayed.runs[0].agentLoopCursor, 10);
});

test('fails closed when an approval status id collides with a different status presentation', () => {
  const initial = room();
  const runBinding = initial.runs[0].taskBinding;
  const approval = event(runBinding, 0, {
    eventId: 'event-approval-collision', type: 'approval', turn: 'turn-approval-collision',
    approval: { approvalId: 'approval-collision', kind: 'command', state: 'pending' },
  });
  const projected = projectAgentLoopEvent(initial, 'lead-run', approval).room;
  const collision = createRoom({
    ...initial,
    timelineSequence: initial.timelineSequence + 1,
    items: [{
      kind: 'status', itemId: projected.items[0].itemId, sequence: initial.timelineSequence + 1,
      label: { fallback: 'Unrelated status' }, state: 'error', ariaLive: 'off',
    }],
  });
  assert.throws(() => projectAgentLoopEvent(collision, 'lead-run', approval), /projection identity collided/);
  assert.equal(collision.runs[0].agentLoopCursor, -1);
});

test('keeps more than the visible timeline window replay-idempotent across a new binding generation', () => {
  let projected = room();
  const firstBinding = projected.runs[0].taskBinding;
  const messages = Array.from({ length: 501 }, (_, index) => ({
    eventId: `event-first-${index}`,
    type: 'message',
    turn: `turn-${index}`,
    causation: { operationId: `operation-${index}` },
    message: {
      messageId: `assistant-${index}`,
      role: 'assistant',
      content: [
        { kind: 'text', text: `Answer ${index}` },
        { kind: 'image-ref', ref: `Opaque:Image-${index}`, mediaType: 'image/png', alt: `Image ${index}` },
      ],
    },
  }));
  for (const [index, message] of messages.entries()) {
    projected = projectAgentLoopEvent(projected, 'lead-run', event(firstBinding, index, message)).room;
  }
  assert.equal(projected.items.length, 500);
  assert.equal(projected.imageReferences.length, 500);
  assert.equal(projected.runs[0].publicProjections.length, 501);

  const reboundBinding = {
    ...firstBinding,
    binding: { bindingId: 'Opaque:Binding-window-rebound', generation: 2 },
  };
  let replayed = acceptRoomRunPresence(
    projected, 'lead-run', reboundBinding,
    createStoredRoomRunDetailsUrl({ url: 'app:task/window-rebound', target: 'host' }),
  );
  const baselineItems = replayed.items;
  const baselineImages = replayed.imageReferences;
  const baselineTimelineSequence = replayed.timelineSequence;
  for (const [index, message] of messages.entries()) {
    replayed = projectAgentLoopEvent(replayed, 'lead-run', event(reboundBinding, 1000 + index, {
      ...message,
      eventId: `event-rebound-${index}`,
    })).room;
  }
  assert.deepEqual(replayed.items, baselineItems);
  assert.deepEqual(replayed.imageReferences, baselineImages);
  assert.equal(replayed.timelineSequence, baselineTimelineSequence);
  assert.equal(replayed.runs[0].agentLoopCursor, 1500);
  assert.equal(replayed.runs[0].publicProjections.length, 501);

  const next = projectAgentLoopEvent(replayed, 'lead-run', event(reboundBinding, 1501, {
    eventId: 'event-new-after-window', type: 'message', turn: 'turn-new-after-window',
    message: {
      messageId: 'assistant-new-after-window', role: 'assistant',
      content: [{ kind: 'text', text: 'New answer after replay' }],
    },
  })).room;
  assert.equal(next.items.length, 500);
  assert.equal(next.timelineSequence, baselineTimelineSequence + 1);
  assert.equal(next.runs[0].publicProjections.length, 502);
});

test('fails closed instead of silently truncating the bounded durable replay ledger', () => {
  const initial = room();
  const overflow = Array.from({ length: CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS + 1 }, (_, index) => ({
    itemId: createChatroomOpaqueId('agent-status', 'lead-run', `overflow-${index}`),
    kind: 'status',
    association: 'status:overflow',
  }));
  assert.throws(() => createRoom({
    ...initial,
    runs: initial.runs.map(run => run.runId === 'lead-run' ? { ...run, publicProjections: overflow } : run),
  }), /projection replay limit/);
  const duplicate = createChatroomOpaqueId('agent-status', 'lead-run', 'duplicate');
  assert.throws(() => createRoom({
    ...initial,
    runs: initial.runs.map(run => run.runId === 'lead-run' ? {
      ...run,
      publicProjections: [
        { itemId: duplicate, kind: 'status', association: 'status:duplicate' },
        { itemId: duplicate, kind: 'status', association: 'status:duplicate' },
      ],
    } : run),
  }), /projection identities must be unique/);
});
