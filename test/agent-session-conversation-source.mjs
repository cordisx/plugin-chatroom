import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatroomAgentSessionConversationSource,
  v3BindingFor,
} from '../dist/agent-session-conversation-source.js';

const binding = {
  bindingId: 'binding-one', shell: 'agent-desktop', ownerGeneration: 'owner-one',
  routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room-one' },
};

const human = {
  participantId: 'human', role: 'human',
  displayName: { namespace: 'chatroom', key: 'human', fallback: 'You' },
};
const agent = {
  participantId: 'reviewer', role: 'agent',
  displayName: { namespace: 'chatroom', key: 'reviewer', fallback: 'Reviewer' },
  agentIdentity: { provider: 'codex', model: 'gpt-5', role: 'reviewer' },
};

function domainSource(itemOverride) {
  const snapshot = {
    binding: { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration },
    generation: binding.ownerGeneration,
    snapshotSequence: 500,
    selection: {
      kind: 'room', roomId: 'room-one',
      title: { key: 'room', fallback: 'Room' },
      multiParticipant: true, participantPresentation: 'host-initials',
      participants: [human, agent],
      activeRuns: [{
        participantId: 'reviewer', memberId: 'reviewer', runId: 'run-one',
        lifecycle: { phase: 'active' },
        detailsUrl: { kind: 'host-route', routeId: 'legacy', params: {} },
      }],
    },
    items: itemOverride ?? [
      {
        kind: 'message', itemId: 'ack', messageId: 'ack-message', sequence: 1,
        source: 'chatroom-acknowledgement', author: human,
        semantic: { purpose: 'chatroom-acknowledgement' },
        body: [{ kind: 'text', text: { key: 'ack', fallback: 'Message sent' } }],
        reactions: [], timestamp: '2026-09-03T00:00:00.000Z', deliveryState: 'delivered',
        runState: 'idle', ariaLive: 'off', actions: [],
      },
      {
        kind: 'message', itemId: 'legacy', messageId: 'legacy-message', sequence: 2,
        source: 'agent-loop', author: agent, semantic: { purpose: 'conversation' },
        body: [{ kind: 'text', text: { key: 'legacy', fallback: 'Legacy' } }],
        reactions: [], timestamp: '2026-09-03T00:00:01.000Z', deliveryState: 'delivered',
        runState: 'idle', ariaLive: 'off', actions: [],
      },
      {
        kind: 'member-presence', itemId: 'presence', sequence: 3,
        participantId: 'reviewer', memberId: 'reviewer', runId: 'run-one',
        state: 'ready', retryable: false,
      },
    ],
    composer: {
      availability: 'available', placeholder: { key: 'compose', fallback: 'Write a message' },
      disabled: { value: false }, submit: { id: 'chatroom.submit' },
    },
    headerActions: [],
  };
  return {
    snapshot: async () => snapshot,
    subscribe: async afterSequence => ({
      result: {
        type: 'subscribe', status: 'accepted', code: 'allowed',
        subscription: {
          subscriptionId: 'domain', binding: snapshot.binding, generation: snapshot.generation,
          afterSequence, snapshotSequence: snapshot.snapshotSequence,
        },
      },
      handle: {
        subscription: {},
        pages: { async *[Symbol.asyncIterator]() {} },
        unsubscribe() {},
      },
    }),
    updateRoomSettings: async request => ({
      type: 'update-room-settings', requestId: request.requestId, binding: request.binding,
      generation: request.generation, roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
      status: 'applied', code: 'applied', snapshotSequence: snapshot.snapshotSequence,
    }),
    dispose() {},
  };
}

function sessionProjection(itemOverride) {
  let listener;
  return {
    subscribeProjection(next) { listener = next; return () => { listener = undefined; }; },
    emit(roomId = 'room-one') { listener?.(roomId); },
    projectionForRoom() {
      return {
        activeRuns: [{
          participantId: 'reviewer', memberId: 'reviewer', runId: 'run-one',
          sessionId: 'session-one', lifecycle: { phase: 'running' },
          details: { kind: 'host', ref: 'detail-one' },
        }],
        items: itemOverride ?? [{
          kind: 'message', itemId: 'session-message', messageId: 'assistant-one', sequence: 4,
          source: { kind: 'session-event', sessionId: 'session-one', eventSeq: 7 },
          author: agent, semantic: { purpose: 'conversation' },
          body: [{ kind: 'text', text: { key: 'reply', fallback: 'Done' } }],
          reactions: [], timestamp: '2026-09-03T00:00:02.000Z', deliveryState: 'delivered',
          runState: 'idle', ariaLive: 'polite', actions: [],
        }],
      };
    },
  };
}

test('Shell v5 preserves domain product items while replacing execution facts with Session facts', async () => {
  const source = new ChatroomAgentSessionConversationSource(binding, domainSource(), sessionProjection(), 'enter');
  const snapshot = await source.snapshot();

  assert.equal(v3BindingFor(binding).routeSelection.selectedRoomParam, 'room-one');
  assert.equal(snapshot.selection.activeRuns[0].sessionId, 'session-one');
  assert.deepEqual(snapshot.selection.activeRuns[0].details, { kind: 'host', ref: 'detail-one' });
  assert.deepEqual(snapshot.items.map(item => item.itemId), ['ack', 'presence', 'session-message']);
  assert.deepEqual(snapshot.items[0].source, { kind: 'chatroom-acknowledgement' });
  assert.equal(snapshot.items[1].sessionId, 'session-one');
  assert.deepEqual(snapshot.items[2].source, {
    kind: 'session-event', sessionId: 'session-one', eventSeq: 7,
  });
  assert.equal(snapshot.composer.shortcutPolicy, 'enter');
  source.dispose();
});

test('merges persisted and new delegation acknowledgements into stable Session chronology', async () => {
  const lead = {
    participantId: 'lead', role: 'agent',
    displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
    agentIdentity: { provider: 'codex', model: 'gpt-5', role: 'lead' },
  };
  const domainItems = [
    {
      kind: 'message', itemId: 'delegation-existing', messageId: 'delegation-existing', sequence: 20,
      source: 'chatroom-acknowledgement', author: lead,
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: { key: 'old-ack', fallback: '我会通知 @Reviewer 去完成旧任务的工作。' } }],
      reactions: [], timestamp: '2026-09-03T00:00:02.000Z', deliveryState: 'delivered',
      runState: 'idle', ariaLive: 'polite', actions: [],
    },
    {
      kind: 'message', itemId: 'delegation-new', messageId: 'delegation-new', sequence: 21,
      source: 'chatroom-acknowledgement', author: lead,
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: { key: 'new-ack', fallback: '已向 @Reviewer 下发任务：新任务。' } }],
      reactions: [], timestamp: '2026-09-03T00:00:06.000Z', deliveryState: 'delivered',
      runState: 'idle', ariaLive: 'polite', actions: [],
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
    kind: 'message', itemId, messageId: itemId, sequence,
    source: { kind: 'session-event', sessionId: index < 2 || index === 4 ? 'session-lead' : 'session-reviewer', eventSeq: index + 1 },
    author, semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { key: itemId, fallback } }],
    reactions: [], timestamp, deliveryState: 'delivered', runState: 'idle',
    ariaLive: 'polite', actions: [],
  }));
  const projection = sessionProjection(sessionItems);
  const source = new ChatroomAgentSessionConversationSource(
    binding, domainSource(domainItems), projection, 'enter',
  );
  const first = await source.snapshot();
  const expected = [
    'human', 'lead-reply-one', 'delegation-existing', 'reviewer-intro-one',
    'reviewer-reply-one', 'lead-reply-two', 'delegation-new',
    'reviewer-intro-two', 'reviewer-reply-two',
  ];
  assert.deepEqual(first.items.map(item => item.itemId), expected);
  assert.equal(new Set(first.items.map(item => item.sequence)).size, first.items.length);
  assert.deepEqual(first.items.map(item => item.sequence),
    [...first.items.map(item => item.sequence)].sort((left, right) => left - right));

  projection.emit();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = await source.snapshot();
  assert.deepEqual(refreshed.items.map(item => [item.itemId, item.sequence]),
    first.items.map(item => [item.itemId, item.sequence]));
  source.dispose();

  const replayedSource = new ChatroomAgentSessionConversationSource(
    binding, domainSource(domainItems), sessionProjection(sessionItems), 'enter',
  );
  const replayed = await replayedSource.snapshot();
  assert.deepEqual(replayed.items.map(item => [item.itemId, item.sequence]),
    first.items.map(item => [item.itemId, item.sequence]));
  replayedSource.dispose();
});

test('Shell v5 subscription close is first-terminal and unsubscribe is idempotent', async () => {
  const source = new ChatroomAgentSessionConversationSource(binding, domainSource(), sessionProjection(), 'enter');
  const snapshot = await source.snapshot();
  const result = await source.subscribe(snapshot.snapshotSequence);
  assert.equal(result.result.status, 'accepted');

  const first = await result.handle.unsubscribe();
  const second = await result.handle.unsubscribe();
  assert.deepEqual(second, first);
  assert.equal(await result.handle.closed, first);
  assert.equal(first.code, 'unsubscribed');
  assert.equal(first.contract, 'cordisx.agent-conversation-shell-subscription-close/v5');
  assert.equal(first.schemaVersion, 5);
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

test('committed shortcut changes replace every live Shell v5 snapshot without changing submit', async () => {
  const source = new ChatroomAgentSessionConversationSource(
    binding, domainSource(), sessionProjection(), 'enter',
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
