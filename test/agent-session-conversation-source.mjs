import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomAgentSessionConversationSource, v3BindingFor } from '../dist/agent-session-conversation-source.js';
import { ChatroomAgentSessionConversationSourceV7 } from '../dist/agent-session-conversation-source-v7.js';

const binding = {
  bindingId: 'binding-one',
  shell: 'agent-desktop',
  ownerGeneration: 'owner-one',
  routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room-one' },
};

const human = {
  participantId: 'human',
  role: 'human',
  displayName: { namespace: 'chatroom', key: 'human', fallback: 'You' },
};
const agent = {
  participantId: 'reviewer',
  role: 'agent',
  displayName: { namespace: 'chatroom', key: 'reviewer', fallback: 'Reviewer' },
  agentIdentity: { provider: 'codex', model: 'gpt-5', role: 'reviewer' },
};

function domainSource(itemOverride) {
  const snapshot = {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: binding.ownerGeneration,
    snapshotSequence: 500,
    selection: {
      kind: 'room',
      roomId: 'room-one',
      title: { key: 'room', fallback: 'Room' },
      multiParticipant: true,
      participantPresentation: 'host-initials',
      participants: [human, agent],
      activeRuns: [{
        participantId: 'reviewer',
        memberId: 'reviewer',
        runId: 'run-one',
        lifecycle: { phase: 'active' },
        detailsUrl: { kind: 'host-route', routeId: 'legacy', params: {} },
      }],
    },
    items: itemOverride ?? [
      {
        kind: 'message',
        itemId: 'ack',
        messageId: 'ack-message',
        sequence: 1,
        source: 'chatroom-acknowledgement',
        author: human,
        semantic: { purpose: 'chatroom-acknowledgement' },
        body: [{ kind: 'text', text: { key: 'ack', fallback: 'Message sent' } }],
        reactions: [],
        timestamp: '2026-09-03T00:00:00.000Z',
        deliveryState: 'delivered',
        runState: 'idle',
        ariaLive: 'off',
        actions: [],
      },
      {
        kind: 'message',
        itemId: 'legacy',
        messageId: 'legacy-message',
        sequence: 2,
        source: 'agent-loop',
        author: agent,
        semantic: { purpose: 'conversation' },
        body: [{ kind: 'text', text: { key: 'legacy', fallback: 'Legacy' } }],
        reactions: [],
        timestamp: '2026-09-03T00:00:01.000Z',
        deliveryState: 'delivered',
        runState: 'idle',
        ariaLive: 'off',
        actions: [],
      },
      {
        kind: 'member-presence',
        itemId: 'presence',
        sequence: 3,
        participantId: 'reviewer',
        memberId: 'reviewer',
        runId: 'run-one',
        state: 'ready',
        retryable: false,
      },
    ],
    composer: {
      availability: 'available',
      placeholder: { key: 'compose', fallback: 'Write a message' },
      disabled: { value: false },
      submit: { id: 'chatroom.submit' },
    },
    headerActions: [],
  };
  return {
    snapshot: async () => snapshot,
    subscribe: async afterSequence => ({
      result: {
        type: 'subscribe',
        status: 'accepted',
        code: 'allowed',
        subscription: {
          subscriptionId: 'domain',
          binding: snapshot.binding,
          generation: snapshot.generation,
          afterSequence,
          snapshotSequence: snapshot.snapshotSequence,
        },
      },
      handle: {
        subscription: {},
        pages: { async *[Symbol.asyncIterator]() {} },
        unsubscribe() {},
      },
    }),
    updateRoomSettings: async request => ({
      type: 'update-room-settings',
      requestId: request.requestId,
      binding: request.binding,
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
      status: 'applied',
      code: 'applied',
      snapshotSequence: snapshot.snapshotSequence,
    }),
    dispose() {},
  };
}

function sessionProjection(itemOverride, admissionAppendAnchors) {
  let listener;
  let currentItems = itemOverride;
  let currentRuns;
  let currentAdmissionAppendAnchors = admissionAppendAnchors;
  return {
    async hydrateRoom() {},
    subscribeProjection(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit(roomId = 'room-one') {
      listener?.(roomId);
    },
    replace({ activeRuns, items, admissionAppendAnchors: nextAdmissionAppendAnchors }) {
      currentRuns = activeRuns;
      currentItems = items;
      currentAdmissionAppendAnchors = nextAdmissionAppendAnchors;
      listener?.('room-one');
    },
    projectionForRoom() {
      const projection = {
        activeRuns: currentRuns ?? [{
          participantId: 'reviewer',
          memberId: 'reviewer',
          runId: 'run-one',
          sessionId: 'session-one',
          lifecycle: { phase: 'running' },
          details: { kind: 'host', ref: 'detail-one' },
        }],
        items: currentItems ?? [{
          kind: 'message',
          itemId: 'session-message',
          messageId: 'assistant-one',
          sequence: 4,
          source: { kind: 'session-event', sessionId: 'session-one', eventSeq: 7 },
          author: agent,
          semantic: { purpose: 'conversation' },
          body: [{ kind: 'text', text: { key: 'reply', fallback: 'Done' } }],
          reactions: [],
          timestamp: '2026-09-03T00:00:02.000Z',
          deliveryState: 'delivered',
          runState: 'idle',
          ariaLive: 'polite',
          actions: [],
        }],
      };
      return currentAdmissionAppendAnchors === undefined
        ? projection
        : { ...projection, admissionAppendAnchors: currentAdmissionAppendAnchors };
    },
    projectionForRoomV6() {
      return this.projectionForRoom();
    },
  };
}

const sessionMessage = ({ itemId, sessionId, eventSeq, sequence, timestamp, author, text }) => ({
  kind: 'message',
  itemId,
  messageId: itemId,
  sequence,
  source: { kind: 'session-event', sessionId, eventSeq },
  author,
  semantic: { purpose: 'conversation' },
  body: [{ kind: 'text', text: { key: itemId, fallback: text } }],
  reactions: [],
  timestamp,
  deliveryState: 'delivered',
  runState: 'idle',
  ariaLive: 'polite',
  actions: [],
});

test('Shell v6 preserves domain product items while replacing execution facts with Session facts', async () => {
  const source = new ChatroomAgentSessionConversationSource(binding, domainSource(), sessionProjection(), 'enter');
  const snapshot = await source.snapshot();

  assert.equal(v3BindingFor(binding).routeSelection.selectedRoomParam, 'room-one');
  assert.equal(snapshot.selection.activeRuns[0].sessionId, 'session-one');
  assert.deepEqual(snapshot.selection.activeRuns[0].details, { kind: 'host', ref: 'detail-one' });
  assert.deepEqual(snapshot.items.map(item => item.itemId), ['ack', 'presence', 'session-message']);
  assert.deepEqual(snapshot.items[0].source, { kind: 'chatroom-acknowledgement' });
  assert.equal(snapshot.items[1].sessionId, 'session-one');
  assert.deepEqual(snapshot.items[2].source, {
    kind: 'session-event',
    sessionId: 'session-one',
    eventSeq: 7,
  });
  assert.equal(snapshot.composer.shortcutPolicy, 'enter');
  source.dispose();
});

test('a later Room run appends without replacing an earlier pending run projection', async () => {
  const lead = {
    participantId: 'lead',
    role: 'agent',
    displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
    agentIdentity: { provider: 'codex', model: 'gpt-5', role: 'lead' },
  };
  const runA = {
    participantId: 'reviewer',
    memberId: 'reviewer',
    runId: 'run-a',
    sessionId: 'session-a',
    lifecycle: { phase: 'waiting' },
  };
  const runB = {
    participantId: 'lead',
    memberId: 'lead',
    runId: 'run-b',
    sessionId: 'session-b',
    lifecycle: { phase: 'running' },
  };
  const user3 = sessionMessage({
    itemId: 'user-3',
    sessionId: 'session-a',
    eventSeq: 1,
    sequence: 500,
    timestamp: '2026-09-04T00:00:00.000Z',
    author: human,
    text: '3',
  });
  const reviewerIntro = sessionMessage({
    itemId: 'reviewer-intro',
    sessionId: 'session-a',
    eventSeq: 4,
    sequence: 502,
    timestamp: '2026-09-04T00:00:02.000Z',
    author: agent,
    text: 'Reviewer introduction',
  });
  const pending = {
    kind: 'approval',
    itemId: 'approval-a',
    sequence: 503,
    participantId: 'reviewer',
    memberId: 'reviewer',
    runId: 'run-a',
    sessionId: 'session-a',
    agentGeneration: 7,
    approvalId: 'approval-a',
    approvalKind: 'command',
    state: 'pending',
    actions: [
      { decision: 'approve', command: { id: 'chatroom.approval.approve' } },
      { decision: 'deny', command: { id: 'chatroom.approval.deny' } },
      { decision: 'cancel', command: { id: 'chatroom.approval.cancel' } },
    ],
  };
  const delegation = {
    kind: 'message',
    itemId: 'delegation-a',
    messageId: 'delegation-a',
    sequence: 20,
    source: 'chatroom-acknowledgement',
    author: lead,
    semantic: { purpose: 'chatroom-acknowledgement' },
    body: [{ kind: 'text', text: { key: 'delegation', fallback: '已向 @Reviewer 下发任务：3。' } }],
    reactions: [],
    timestamp: '2026-09-04T00:00:01.000Z',
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'polite',
    actions: [],
  };
  const projection = sessionProjection([user3, reviewerIntro, pending]);
  projection.replace({ activeRuns: [runA], items: [user3, reviewerIntro, pending] });
  const source = new ChatroomAgentSessionConversationSource(
    binding,
    domainSource([delegation]),
    projection,
    'enter',
  );
  const initial = await source.snapshot();
  const stableA = initial.items.map(item => [item.itemId, item.sequence]);
  assert.deepEqual(initial.items.map(item => item.itemId), [
    'user-3',
    'delegation-a',
    'reviewer-intro',
    'approval-a',
  ]);

  const user1 = sessionMessage({
    itemId: 'user-1',
    sessionId: 'session-b',
    eventSeq: 1,
    sequence: 504,
    timestamp: '2026-09-04T00:00:03.000Z',
    author: human,
    text: '1',
  });
  const leadReply = sessionMessage({
    itemId: 'lead-reply',
    sessionId: 'session-b',
    eventSeq: 2,
    sequence: 505,
    timestamp: '2026-09-04T00:00:04.000Z',
    author: lead,
    text: 'Lead reply',
  });
  projection.replace({
    activeRuns: [runA, runB],
    items: [user3, reviewerIntro, pending, user1, leadReply],
  });
  await new Promise(resolve => setImmediate(resolve));
  const appended = await source.snapshot();
  assert.deepEqual(appended.items.slice(0, stableA.length).map(item => [item.itemId, item.sequence]), stableA);
  assert.deepEqual(appended.items.map(item => item.itemId), [
    'user-3',
    'delegation-a',
    'reviewer-intro',
    'approval-a',
    'user-1',
    'lead-reply',
  ]);

  projection.replace({
    activeRuns: [{ ...runA, lifecycle: { phase: 'active' } }, runB],
    items: [
      user3,
      reviewerIntro,
      { ...pending, state: 'denied', actions: [] },
      user1,
      leadReply,
    ],
  });
  await new Promise(resolve => setImmediate(resolve));
  const terminal = await source.snapshot();
  assert.deepEqual(terminal.items.map(item => item.itemId), appended.items.map(item => item.itemId));
  assert.deepEqual(terminal.items.map(item => item.sequence), appended.items.map(item => item.sequence));
  assert.equal(terminal.items.find(item => item.itemId === 'approval-a').state, 'denied');
  assert.equal(terminal.items.find(item => item.itemId === 'lead-reply').body[0].text.fallback, 'Lead reply');
  source.dispose();
});

test('merges persisted and new delegation acknowledgements into stable Session chronology', async () => {
  const lead = {
    participantId: 'lead',
    role: 'agent',
    displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
    agentIdentity: { provider: 'codex', model: 'gpt-5', role: 'lead' },
  };
  const domainItems = [
    {
      kind: 'message',
      itemId: 'delegation-existing',
      messageId: 'delegation-existing',
      sequence: 20,
      source: 'chatroom-acknowledgement',
      author: lead,
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: { key: 'old-ack', fallback: '我会通知 @Reviewer 去完成旧任务的工作。' } }],
      reactions: [],
      timestamp: '2026-09-03T00:00:02.000Z',
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    },
    {
      kind: 'message',
      itemId: 'delegation-new',
      messageId: 'delegation-new',
      sequence: 21,
      source: 'chatroom-acknowledgement',
      author: lead,
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: { key: 'new-ack', fallback: '已向 @Reviewer 下发任务：新任务。' } }],
      reactions: [],
      timestamp: '2026-09-03T00:00:06.000Z',
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    },
  ];
  const sessionItems = [
    ['human', 500, '2026-09-03T00:00:00.000Z', human, '先处理主任务'],
    ['lead-reply-one', 501, '2026-09-03T00:00:01.000Z', lead, 'Lead 原回复'],
    ['reviewer-intro-one', 502, '2026-09-03T00:00:03.000Z', agent, 'Reviewer introduction'],
    ['reviewer-reply-one', 503, '2026-09-03T00:00:04.000Z', agent, 'Reviewer reply'],
    ['lead-reply-two', 504, '2026-09-03T00:00:05.000Z', lead, 'Lead 后续回复'],
    ['reviewer-intro-two', 505, '2026-09-03T00:00:07.000Z', agent, 'Reviewer second introduction'],
    ['reviewer-reply-two', 506, '2026-09-03T00:00:08.000Z', agent, 'Reviewer second reply'],
  ].map(([itemId, sequence, timestamp, author, fallback], index) => ({
    kind: 'message',
    itemId,
    messageId: itemId,
    sequence,
    source: {
      kind: 'session-event',
      sessionId: index < 2 || index === 4 ? 'session-lead' : 'session-reviewer',
      eventSeq: index + 1,
    },
    author,
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { key: itemId, fallback } }],
    reactions: [],
    timestamp,
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'polite',
    actions: [],
  }));
  const projection = sessionProjection(sessionItems);
  const source = new ChatroomAgentSessionConversationSource(
    binding,
    domainSource(domainItems),
    projection,
    'enter',
  );
  const first = await source.snapshot();
  const expected = [
    'human',
    'lead-reply-one',
    'delegation-existing',
    'reviewer-intro-one',
    'reviewer-reply-one',
    'lead-reply-two',
    'delegation-new',
    'reviewer-intro-two',
    'reviewer-reply-two',
  ];
  assert.deepEqual(first.items.map(item => item.itemId), expected);
  assert.equal(new Set(first.items.map(item => item.sequence)).size, first.items.length);
  assert.deepEqual(
    first.items.map(item => item.sequence),
    [...first.items.map(item => item.sequence)].sort((left, right) => left - right),
  );

  projection.emit();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = await source.snapshot();
  assert.deepEqual(
    refreshed.items.map(item => [item.itemId, item.sequence]),
    first.items.map(item => [item.itemId, item.sequence]),
  );
  source.dispose();

  const replayedSource = new ChatroomAgentSessionConversationSource(
    binding,
    domainSource(domainItems),
    sessionProjection(sessionItems),
    'enter',
  );
  const replayed = await replayedSource.snapshot();
  assert.deepEqual(
    replayed.items.map(item => [item.itemId, item.sequence]),
    first.items.map(item => [item.itemId, item.sequence]),
  );
  replayedSource.dispose();
});

test('Shell v6 subscription close is first-terminal and unsubscribe is idempotent', async () => {
  const source = new ChatroomAgentSessionConversationSource(binding, domainSource(), sessionProjection(), 'enter');
  const snapshot = await source.snapshot();
  const result = await source.subscribe(snapshot.snapshotSequence);
  assert.equal(result.result.status, 'accepted');

  const first = await result.handle.unsubscribe();
  const second = await result.handle.unsubscribe();
  assert.deepEqual(second, first);
  assert.equal(await result.handle.closed, first);
  assert.equal(first.code, 'unsubscribed');
  assert.equal(first.contract, 'cordisx.agent-conversation-shell-subscription-close/v6');
  assert.equal(first.schemaVersion, 6);
  source.dispose();
});

test('snapshot-to-subscribe gap rebases absolute refreshes onto one contiguous live stream', async () => {
  const projection = sessionProjection();
  const source = new ChatroomAgentSessionConversationSource(binding, domainSource(), projection, 'enter');
  const snapshot = await source.snapshot();
  const result = await source.subscribe(snapshot.snapshotSequence);
  assert.equal(result.result.status, 'accepted');

  // Model the boundary race precisely: one source refresh lands after the
  // consumer snapshot but before this accepted stream can observe it.
  const stream = [...source.streams][0];
  source.streams.delete(stream);
  projection.emit();
  await new Promise(resolve => setImmediate(resolve));
  source.streams.add(stream);

  const pages = result.handle.pages[Symbol.asyncIterator]();
  projection.emit();
  const first = (await pages.next()).value;
  assert.equal(first.phase, 'live');
  assert.equal(first.afterSequence, snapshot.snapshotSequence);
  assert.equal(first.updates[0].sequence, snapshot.snapshotSequence + 1);
  assert.equal(first.updates[0].snapshot.snapshotSequence, snapshot.snapshotSequence + 1);
  assert.equal(first.nextAfterSequence, snapshot.snapshotSequence + 1);

  projection.emit();
  const second = (await pages.next()).value;
  assert.equal(second.afterSequence, first.nextAfterSequence);
  assert.equal(second.updates[0].sequence, first.nextAfterSequence + 1);
  assert.equal(second.updates[0].snapshot.snapshotSequence, first.nextAfterSequence + 1);
  await result.handle.unsubscribe();
  source.dispose();
});

test('committed shortcut changes replace every live Shell v6 snapshot without changing submit', async () => {
  const source = new ChatroomAgentSessionConversationSource(
    binding,
    domainSource(),
    sessionProjection(),
    'enter',
  );
  const initial = await source.snapshot();
  assert.equal(initial.composer.shortcutPolicy, 'enter');
  assert.deepEqual(initial.composer.submit, { id: 'chatroom.submit' });

  const result = await source.subscribe(initial.snapshotSequence);
  assert.equal(result.result.status, 'accepted');
  const pages = result.handle.pages[Symbol.asyncIterator]();
  source.setComposerShortcutPolicy('mod-enter');
  const page = (await pages.next()).value;
  assert.equal(page.updates[0].kind, 'snapshot-replaced');
  assert.equal(page.updates[0].snapshot.composer.shortcutPolicy, 'mod-enter');
  assert.deepEqual(page.updates[0].snapshot.composer.submit, { id: 'chatroom.submit' });
  assert.equal((await source.snapshot()).composer.shortcutPolicy, 'mod-enter');

  await result.handle.unsubscribe();
  source.dispose();
});

test('Shell v7 keeps the complete A3/B1 Room timeline when Reviewer approval is rejected', async () => {
  const lead = {
    participantId: 'lead',
    role: 'agent',
    displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
    agentIdentity: { agentId: 'lead-agent', revision: 'lead-r1' },
  };
  const requester = { agentId: 'reviewer-agent', revision: 'reviewer-r1' };
  const authorityBinding = {
    agentId: 'session-lead',
    sessionId: 'session-lead',
    agentGeneration: 3,
    definition: lead.agentIdentity,
  };
  const user3 = sessionMessage({
    itemId: 'user-3-v7',
    sessionId: 'session-reviewer',
    eventSeq: 1,
    sequence: 500,
    timestamp: '2026-09-04T00:00:00.000Z',
    author: human,
    text: '3',
  });
  const intro = sessionMessage({
    itemId: 'reviewer-intro-v7',
    sessionId: 'session-reviewer',
    eventSeq: 4,
    sequence: 502,
    timestamp: '2026-09-04T00:00:02.000Z',
    author: agent,
    text: 'Reviewer introduction',
  });
  const pending = {
    kind: 'approval',
    itemId: 'approval-v7',
    sequence: 503,
    participantId: 'reviewer',
    memberId: 'reviewer',
    runId: 'run-reviewer',
    sessionId: 'session-reviewer',
    approvalId: 'approval-v7',
    approvalKind: 'command',
    requester,
    authority: { participantId: 'lead', memberId: 'leader', identity: lead.agentIdentity },
    reason: { kind: 'plain-text', text: 'Reviewer requests permission for the protected check.' },
    state: 'pending',
    agentGeneration: 2,
    authorityBinding,
    actions: [
      { decision: 'approve', command: { id: 'chatroom.approval.approve' } },
      { decision: 'reject', command: { id: 'chatroom.approval.deny' } },
    ],
  };
  const delegation = {
    kind: 'message',
    itemId: 'delegation-v7',
    messageId: 'delegation-v7',
    sequence: 20,
    source: 'chatroom-acknowledgement',
    author: lead,
    semantic: { purpose: 'chatroom-acknowledgement' },
    body: [{ kind: 'text', text: { key: 'delegation', fallback: '已向 @Reviewer 下发任务：3。' } }],
    reactions: [],
    timestamp: '2026-09-04T00:00:01.000Z',
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'polite',
    actions: [],
  };
  const projection = sessionProjection();
  projection.replace({
    activeRuns: [{
      participantId: 'reviewer',
      memberId: 'reviewer',
      runId: 'run-reviewer',
      sessionId: 'session-reviewer',
      lifecycle: { phase: 'waiting' },
    }],
    items: [user3, intro, pending],
  });
  const source = new ChatroomAgentSessionConversationSourceV7(
    binding,
    domainSource([delegation]),
    projection,
    'enter',
  );
  const before = await source.snapshot();
  const stable = before.items.map(item => [item.itemId, item.sequence]);
  const user1 = sessionMessage({
    // This is the real B ordering shape: the durable Room item coordinate is
    // older than the already-published approval coordinate. The opaque link
    // must append B after the approval without moving that approval item.
    itemId: 'user-1-v7',
    sessionId: 'session-lead',
    eventSeq: 1,
    sequence: 501,
    timestamp: '2026-09-04T00:00:03.000Z',
    author: human,
    text: '1',
  });
  const leadReply = sessionMessage({
    itemId: 'lead-reply-v7',
    sessionId: 'session-lead',
    eventSeq: 2,
    sequence: 505,
    timestamp: '2026-09-04T00:00:04.000Z',
    author: lead,
    text: 'Lead reply',
  });
  const { authorityBinding: _removed, ...denied } = pending;
  projection.replace({
    activeRuns: [
      {
        participantId: 'reviewer',
        memberId: 'reviewer',
        runId: 'run-reviewer',
        sessionId: 'session-reviewer',
        lifecycle: { phase: 'active' },
      },
      {
        participantId: 'lead',
        memberId: 'leader',
        runId: 'run-lead',
        sessionId: 'session-lead',
        lifecycle: { phase: 'active' },
      },
    ],
    items: [user3, intro, { ...denied, state: 'denied', actions: [] }, user1, leadReply],
    admissionAppendAnchors: [{ itemId: 'user-1-v7', appendAfterItemId: 'approval-v7' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  const after = await source.snapshot();

  assert.deepEqual(after.items.slice(0, stable.length).map(item => [item.itemId, item.sequence]), stable);
  assert.deepEqual(after.items.map(item => item.itemId), [
    'user-3-v7',
    'delegation-v7',
    'reviewer-intro-v7',
    'approval-v7',
    'user-1-v7',
    'lead-reply-v7',
  ]);
  const terminal = after.items.find(item => item.itemId === 'approval-v7');
  assert.equal(terminal.state, 'denied');
  assert.deepEqual(terminal.actions, []);
  assert.equal('authorityBinding' in terminal, false);
  const coldProjection = sessionProjection();
  coldProjection.replace({
    activeRuns: [
      {
        participantId: 'reviewer',
        memberId: 'reviewer',
        runId: 'run-reviewer',
        sessionId: 'session-reviewer',
        lifecycle: { phase: 'active' },
      },
      {
        participantId: 'lead',
        memberId: 'leader',
        runId: 'run-lead',
        sessionId: 'session-lead',
        lifecycle: { phase: 'active' },
      },
    ],
    items: [user3, intro, { ...denied, state: 'denied', actions: [] }, user1, leadReply],
    admissionAppendAnchors: [{ itemId: 'user-1-v7', appendAfterItemId: 'approval-v7' }],
  });
  const cold = new ChatroomAgentSessionConversationSourceV7(
    binding,
    domainSource([delegation]),
    coldProjection,
    'enter',
  );
  const replayed = await cold.snapshot();
  assert.deepEqual(
    replayed.items.map(item => [item.itemId, item.sequence]),
    after.items.map(item => [item.itemId, item.sequence]),
    'cold replay rebuilds the append fence without moving the rejected approval item',
  );
  assert.equal(replayed.items.find(item => item.itemId === 'approval-v7').state, 'denied');
  cold.dispose();
  const subscribed = await source.subscribe(after.snapshotSequence);
  assert.equal(subscribed.result.status, 'accepted');
  const closed = await subscribed.handle.unsubscribe();
  assert.equal(closed.contract, 'cordisx.agent-conversation-shell-subscription-close/v7');
  assert.equal(closed.schemaVersion, 7);
  source.dispose();
});
