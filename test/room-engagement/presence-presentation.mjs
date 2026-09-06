import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeBehaviorForMember,
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  parseChatroomAgentConfiguration,
} from '../../dist/agent-definition.js';
import {
  acceptRoomRunPresence,
  beginRoomRunPresence,
  completeRoomAcknowledgement,
  createStoredRoomRunDetailsUrl,
  failRoomAcknowledgement,
  failRoomRunPresence,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from '../../dist/room-engagement.js';
import { projectAgentLoopEvent } from '../../dist/agent-loop-projection.js';
import { createRoomConversationModel } from '../../dist/conversation-model.js';
import { closeRoomRun, createChatroomOpaqueId, createRoom } from '../../dist/room.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

import { acceptConversationTurn, ownerDocumentsFixture, roomWithRuns, taskBinding } from './fixtures.mjs';

test('resolves built-in, Agent defaults, and per-member acknowledgement overrides without prompt injection', () => {
  const parsed = parseChatroomAgentConfiguration({
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    acknowledge: {
      mode: 'message',
      messageTemplate: '{member} is checking',
      failedReaction: '🟥',
    },
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member =>
      member.memberId === 'reviewer'
        ? { ...member, acknowledge: { mode: 'none' } }
        : member
    ),
  });

  assert.deepEqual(acknowledgeBehaviorForMember(parsed, 'leader'), {
    mode: 'message',
    pendingReaction: '👀',
    completedReaction: '✅',
    failedReaction: '🟥',
    messageTemplate: '{member} is checking',
  });
  assert.equal(acknowledgeBehaviorForMember(parsed, 'reviewer').mode, 'none');
  assert.equal(JSON.stringify(parsed.definitions).includes('acknowledge'), false);
  assert.equal(Object.isFrozen(parsed.acknowledge), true);
  assert.equal(Object.isFrozen(parsed.members[1].acknowledge), true);
  assert.throws(() =>
    parseChatroomAgentConfiguration({
      ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      acknowledge: { mode: 'typing' },
    }), /mode is unsupported/);
});

test('does not synthesize member speech after accepted create, rebind, or reload', async () => {
  let room = createRoom({
    ...roomWithRuns(),
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      { id: 'leader', name: 'Lead', kind: 'agent' },
    ],
    items: [{
      kind: 'message',
      itemId: 'user-first',
      messageId: 'user-first',
      sequence: 3,
      source: 'agent-loop',
      author: {
        participantId: 'user',
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: 'Help' } }],
      reactions: [],
      timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'sent',
      runState: 'running',
      ariaLive: 'off',
      actions: [],
    }],
    timelineSequence: 3,
  });
  const firstBinding = taskBinding(83);
  const details = createStoredRoomRunDetailsUrl({ url: 'app:task/lead-stable', target: 'host' });
  room = acceptRoomRunPresence(room, 'lead-run', firstBinding, details);
  assert.equal(acceptRoomRunPresence(room, 'lead-run', firstBinding, details), room);
  assert.equal(
    createRoomConversationModel(room).items.some(item =>
      item.kind === 'member-presence'
      && item.runId === 'lead-run'
    ),
    false,
  );
  assert.equal(
    createRoomConversationModel(room).items.some(item =>
      item.kind === 'message'
      && item.author.role === 'agent'
    ),
    false,
  );

  room = beginRoomRunPresence(room, 'lead-run', { replacement: true });
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    taskBinding(84, 'leader', 2),
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead-rebound', target: 'host' }),
  );
  assert.equal(
    createRoomConversationModel(room).items.some(item =>
      item.kind === 'message'
      && item.author.role === 'agent'
    ),
    false,
  );

  const perMessage = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-first',
    memberId: 'leader',
    runId: 'lead-run',
  });
  room = perMessage.room;
  assert.equal(room.acknowledgements.length, 1);
  assert.equal(room.acknowledgements[0].presentation.kind, 'reaction');

  const owner = ownerDocumentsFixture();
  const first = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  await first.upsert(room);
  first.dispose();
  const persisted = owner.snapshot().value;
  owner.replaceWithoutPublish({
    ...persisted,
    rooms: persisted.rooms.map(saved => ({
      ...saved,
      memberships: saved.memberships.map(member => ({
        ...member,
        engagement: { joinMessageTemplate: 'legacy join speech' },
      })),
      joinAcknowledgements: [{
        acknowledgementKey: 'legacy-join',
        participantId: 'leader',
        memberId: 'leader',
        runId: 'lead-run',
        sequence: 1,
        timestamp: '2026-08-31T00:00:01.000Z',
        source: 'chatroom-acknowledgement',
        text: 'legacy join speech',
      }],
    })),
  });
  const reopened = await DurableChatroomRoomStore.openOwnerDocuments(owner.client);
  const hydrated = reopened.rooms.get(room.id);
  assert.equal(hydrated.runs[0].presence.state, 'ready');
  assert.equal('joinAcknowledgements' in hydrated, false);
  assert.equal('engagement' in hydrated.memberships[0], false);
  assert.equal(
    createRoomConversationModel(hydrated).items.some(item =>
      item.kind === 'message'
      && item.author.role === 'agent'
    ),
    false,
  );
  const accepted = acceptConversationTurn(hydrated, {
    configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    userItemId: 'user-first',
    memberId: 'leader',
    runId: 'lead-run',
    binding: hydrated.runs[0].taskBinding,
  });
  const projected = projectAgentLoopEvent(accepted.room, 'lead-run', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-real-reply',
    binding: hydrated.runs[0].taskBinding.binding,
    sequence: 0,
    occurredAt: '2026-08-31T00:00:06.000Z',
    type: 'message',
    turn: accepted.turn,
    message: {
      messageId: 'provider-reply',
      role: 'assistant',
      purpose: 'conversation',
      content: [{ kind: 'text', text: 'Done' }],
    },
  }).room;
  const model = createRoomConversationModel(projected);
  const user = model.items.find(item => item.kind === 'message' && item.author.role === 'human');
  assert.deepEqual(user.reactions.map(reaction => [reaction.actorParticipantId, reaction.state]), [[
    'leader',
    'pending',
  ]]);
  assert.deepEqual(
    model.items.filter(item => item.kind === 'message' && item.author.role === 'agent')
      .map(item => [item.source, item.body[0].text.fallback]),
    [['agent-loop', 'Done']],
  );
  assert.equal(JSON.stringify(model).includes('我来看看，稍等'), false);
  reopened.dispose();
});

test('updates one stable presence lifecycle and requires binding plus details URL before ready', () => {
  let room = roomWithRuns();
  const initial = room.runs[0].presence;
  assert.deepEqual(initial, {
    eventKey: 'member-presence.6.leader.6.leader.8.lead-run',
    participantId: 'leader',
    memberId: 'leader',
    runId: 'lead-run',
    sequence: 1,
    state: 'creating',
    attempt: 1,
  });
  assert.throws(
    () => createStoredRoomRunDetailsUrl({ url: '', target: 'host' }),
    /requires a non-empty details URL/,
  );

  const binding1 = taskBinding(1);
  const details1 = createStoredRoomRunDetailsUrl({ url: 'app:task/one', target: 'host' });
  room = acceptRoomRunPresence(room, 'lead-run', binding1, details1);
  assert.equal(room.runs[0].presence.eventKey, initial.eventKey);
  assert.equal(room.runs[0].presence.state, 'ready');
  assert.deepEqual(room.runs[0].detailsUrl, details1);
  assert.equal(acceptRoomRunPresence(room, 'lead-run', binding1, details1), room);

  room = beginRoomRunPresence(room, 'lead-run', { replacement: true });
  assert.deepEqual(room.runs[0].presence, {
    eventKey: initial.eventKey,
    participantId: 'leader',
    memberId: 'leader',
    runId: 'lead-run',
    sequence: 1,
    state: 'creating',
    attempt: 2,
  });
  const binding2 = taskBinding(2, 'leader', 2);
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    binding2,
    createStoredRoomRunDetailsUrl({ url: 'codex://task/two', target: 'external' }),
  );
  assert.equal(room.runs[0].taskBinding.binding.generation, 2);
  assert.equal(room.runs[0].detailsUrl.url, 'codex://task/two');
  assert.equal(room.runs[0].presence.eventKey, initial.eventKey);

  const closed = closeRoomRun(room, 'lead-run', binding2.binding);
  assert.equal(closed.runs[0].taskBinding.state, 'closed');
  assert.equal(closed.runs[0].detailsUrl.url, 'codex://task/two');
});

test('keeps failed presence diagnosable and retries in place', () => {
  let room = roomWithRuns();
  room = failRoomRunPresence(room, 'review-run', { code: 'provider-unavailable', retryable: true });
  assert.deepEqual(room.runs[1].presence, {
    eventKey: 'member-presence.8.reviewer.8.reviewer.10.review-run',
    participantId: 'reviewer',
    memberId: 'reviewer',
    runId: 'review-run',
    sequence: 2,
    state: 'failed',
    attempt: 1,
    failure: { code: 'provider-unavailable', retryable: true },
  });
  assert.deepEqual(
    createRoomConversationModel(room).items
      .filter(item => item.kind === 'member-presence' && item.runId === 'review-run')
      .map(item => [item.state, item.retryable]),
    [['failed', true]],
  );
  const failed = room;
  assert.equal(failRoomRunPresence(room, 'review-run', { code: 'provider-unavailable', retryable: true }), failed);
  room = beginRoomRunPresence(room, 'review-run');
  assert.deepEqual(room.runs[1].presence, {
    eventKey: 'member-presence.8.reviewer.8.reviewer.10.review-run',
    participantId: 'reviewer',
    memberId: 'reviewer',
    runId: 'review-run',
    sequence: 2,
    state: 'creating',
    attempt: 2,
  });
});

test('replaces one reaction acknowledgement across pending, completed, and failed states', () => {
  let room = roomWithRuns();
  const prepared = prepareRoomAcknowledgement(room, CHATROOM_DEFAULT_AGENT_CONFIGURATION, {
    userItemId: 'user-1',
    memberId: 'leader',
    runId: 'lead-run',
  });
  room = prepared.room;
  const key = prepared.acknowledgement.acknowledgementKey;
  assert.equal(prepared.created, true);
  assert.deepEqual(prepared.acknowledgement.presentation, {
    kind: 'reaction',
    source: 'chatroom-acknowledgement',
    reactionId: createChatroomOpaqueId('reaction', key),
    actorParticipantId: 'leader',
    value: { kind: 'emoji', emoji: '👀' },
    state: 'pending',
  });

  room = completeRoomAcknowledgement(room, key);
  assert.equal(room.acknowledgements.length, 1);
  assert.deepEqual(room.acknowledgements[0].presentation.value, { kind: 'emoji', emoji: '✅' });
  assert.equal(room.acknowledgements[0].presentation.state, 'completed');
  assert.equal(completeRoomAcknowledgement(room, key), room);
  room = failRoomAcknowledgement(room, key, 'agent-failed');
  assert.equal(room.acknowledgements.length, 1);
  assert.deepEqual(room.acknowledgements[0].presentation.value, { kind: 'emoji', emoji: '⚠️' });
  assert.equal(room.acknowledgements[0].presentation.state, 'failed');
  assert.equal(room.acknowledgements[0].failureCode, 'agent-failed');
});

test('projects every Shell v2 surfaced Room identity as a formal opaque ID', () => {
  const configuration = {
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    members: CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.map(member =>
      member.memberId === 'reviewer'
        ? { ...member, acknowledge: { mode: 'message', messageTemplate: '{member} checking' } }
        : member
    ),
  };
  let room = createRoom({
    ...roomWithRuns(),
    participants: [
      { id: 'user.primary', name: 'You', kind: 'human' },
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
    items: [{
      kind: 'message',
      itemId: 'user-item.1',
      messageId: 'user-message.1',
      sequence: 3,
      source: 'agent-loop',
      author: {
        participantId: 'user.primary',
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{
        kind: 'text',
        text: { namespace: 'chatroom', key: 'message.user', fallback: 'Please review' },
      }],
      reactions: [],
      timestamp: '2026-08-31T00:00:00.000Z',
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    }],
    timelineSequence: 3,
  });
  room = acceptRoomRunPresence(
    room,
    'lead-run',
    taskBinding(31),
    createStoredRoomRunDetailsUrl({ url: 'app:task/lead', target: 'host' }),
  );
  room = acceptRoomRunPresence(
    room,
    'review-run',
    taskBinding(32, 'reviewer'),
    createStoredRoomRunDetailsUrl({ url: 'codex://task/review', target: 'external' }),
  );
  for (const [memberId, runId] of [['leader', 'lead-run'], ['reviewer', 'review-run']]) {
    const prepared = prepareRoomAcknowledgement(room, configuration, {
      userItemId: 'user-item.1',
      memberId,
      runId,
    });
    room = markRoomAcknowledgementSent(prepared.room, prepared.acknowledgement.acknowledgementKey);
  }
  const leadBinding = room.runs[0].taskBinding;
  const accepted = acceptConversationTurn(room, {
    configuration,
    userItemId: 'user-item.1',
    memberId: 'leader',
    runId: 'lead-run',
    binding: leadBinding,
  });
  room = accepted.room;
  room = projectAgentLoopEvent(room, 'lead-run', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-event.v4.schema.json',
    contract: 'cordisx.agent-loop-event/v4',
    schemaVersion: 4,
    eventId: 'event-opaque-1',
    binding: leadBinding.binding,
    sequence: 0,
    occurredAt: '2026-08-31T00:00:01.000Z',
    type: 'message',
    turn: accepted.turn,
    message: {
      messageId: 'provider-message-1',
      role: 'assistant',
      purpose: 'conversation',
      content: [{ kind: 'text', text: 'Reviewed' }],
    },
  }).room;

  const model = createRoomConversationModel(room);
  const identities = [['roomId', model.selection.roomId]];
  for (const participant of model.selection.participants) {
    identities.push(['participantId', participant.participantId]);
  }
  for (const run of model.selection.activeRuns) {
    identities.push(['activeRun participantId', run.participantId]);
    identities.push(['activeRun memberId', run.memberId]);
    identities.push(['activeRun runId', run.runId]);
  }
  for (const item of model.items) {
    identities.push(['itemId', item.itemId]);
    if (item.kind === 'member-presence') {
      identities.push(['presence participantId', item.participantId]);
      identities.push(['presence memberId', item.memberId]);
      identities.push(['presence runId', item.runId]);
    }
    if (item.kind === 'message') {
      identities.push(['messageId', item.messageId]);
      identities.push(['message author participantId', item.author.participantId]);
      for (const reaction of item.reactions) {
        identities.push(['reactionId', reaction.reactionId]);
        identities.push(['reaction actorParticipantId', reaction.actorParticipantId]);
      }
    }
  }
  assert.equal(identities.some(([label]) => label === 'reactionId'), true);
  assert.equal(
    model.items.some(item =>
      item.kind === 'message'
      && item.source === 'chatroom-acknowledgement'
    ),
    true,
  );
  assert.equal(
    model.items.some(item =>
      item.kind === 'message'
      && item.source === 'agent-loop' && item.author.participantId === 'leader'
    ),
    true,
  );
  for (const [label, value] of identities) {
    assert.match(value, /^[A-Za-z0-9._~-]+$/, label);
    assert.ok(value.length <= 512, `${label} exceeds the formal maximum`);
  }
});
