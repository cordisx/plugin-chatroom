import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomPageSource } from '../dist/chatroom-page-source.js';
import { ChatroomRoomRegistry, createRoom } from '../dist/room.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function harness({ rooms = [], projection = { activeRuns: [], items: [] }, intent } = {}) {
  const registry = new ChatroomRoomRegistry(rooms);
  const projectionListeners = new Set();
  const settingsListeners = new Set();
  const calls = [];
  const conversation = {
    rooms: registry,
    submitMessage(...args) {
      calls.push(['submit', ...args]);
      return intent ?? {
        kind: 'send-message',
        roomId: 'created-room',
        roomCreated: true,
        deliveries: [],
        userItemId: 'user-item',
        bindingId: 'page',
        generation: 'page',
        dispatchText: args[1],
      };
    },
    async persistComposerRoom(roomId) {
      calls.push(['persist', roomId]);
    },
    async decidePlaygroundAgentApprovalFromRoom(...args) {
      calls.push(['playground-approval', ...args]);
      return { status: 'accepted' };
    },
  };
  const sessions = {
    subscribeProjection(listener) {
      projectionListeners.add(listener);
      return () => projectionListeners.delete(listener);
    },
    projectionForRoom() {
      return projection;
    },
    isRunLocallyUnavailable() {
      return false;
    },
    async hydrateRoom(roomId) {
      calls.push(['hydrate', roomId]);
    },
    async sendToRoom(...args) {
      calls.push(['send', ...args]);
      return {
        status: 'accepted',
        roomId: args[0],
        runId: args[1],
        messageId: `message-${args[1]}`,
        sessionId: `session-${args[1]}`,
        disposition: 'created',
      };
    },
    answerApprovalItem(...args) {
      calls.push(['session-approval', ...args]);
      return true;
    },
  };
  const settings = {
    current: 'enter',
    subscribe(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
  };
  const source = new ChatroomPageSource(conversation, sessions, settings);
  return { calls, conversation, projectionListeners, registry, sessions, settingsListeners, source };
}

const projectedMessage = Object.freeze({
  kind: 'message',
  itemId: 'projected-item',
  messageId: 'projected-message',
  sequence: 7,
  source: { kind: 'session-event', sessionId: 'session-a', eventSeq: 7 },
  semantic: { purpose: 'conversation' },
  author: { participantId: 'agent-a', role: 'agent', displayName: { key: 'agent', fallback: 'Agent A' } },
  body: [{ kind: 'text', text: { key: 'reply', fallback: 'Done.' } }],
  reactions: [],
  timestamp: '2026-09-04T00:00:00.000Z',
  deliveryState: 'delivered',
  runState: 'idle',
  ariaLive: 'polite',
  actions: [],
});

test('merges replayed Session items, exposes participants, hydrates and invalidates stable snapshots', async () => {
  const room = createRoom({
    id: 'room-a',
    title: 'Room A',
    participants: [{ id: 'agent-a', name: 'Agent A', kind: 'agent' }],
  });
  const run = harness({ rooms: [room], projection: { activeRuns: [], items: [projectedMessage] } });
  const first = run.source.getSnapshot('room-a');
  assert.equal(first.room.id, 'room-a');
  assert.equal(first.participants[0].participantId, 'agent-a');
  assert.equal(first.items[0].messageId, 'projected-message');
  assert.equal(run.source.getSnapshot('room-a'), first);
  await run.source.hydrate('room-a');
  assert.deepEqual(run.calls, [['hydrate', 'room-a']]);
  const second = run.source.getSnapshot('room-a');
  assert.notEqual(second, first);
  assert.ok(second.revision > first.revision);
  run.projectionListeners.forEach(listener => listener('room-a'));
  assert.ok(run.source.getSnapshot('room-a').revision > second.revision);
  run.source.dispose();
});

test('awaits every Agent Session delivery and keeps the first-Room navigation result explicit', async () => {
  const left = deferred();
  const right = deferred();
  const intent = {
    kind: 'send-message',
    roomId: 'created-room',
    roomCreated: true,
    deliveries: [
      { memberId: 'member-a', runId: 'run-a' },
      { memberId: 'member-b', runId: 'run-b' },
    ],
    userItemId: 'user-item',
    bindingId: 'page',
    generation: 'page',
    dispatchText: 'Hello',
  };
  const run = harness({ intent });
  let sendIndex = 0;
  run.sessions.sendToRoom = (...args) => {
    run.calls.push(['send', ...args]);
    return sendIndex++ === 0 ? left.promise : right.promise;
  };
  let settled = false;
  const resultPromise = run.source.submit(undefined, 'Hello').then(result => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  left.resolve({
    status: 'accepted',
    roomId: 'created-room',
    runId: 'run-a',
    messageId: 'message-a',
    sessionId: 'session-a',
    disposition: 'created',
  });
  await Promise.resolve();
  assert.equal(settled, false);
  right.resolve({
    status: 'accepted',
    roomId: 'created-room',
    runId: 'run-b',
    messageId: 'message-b',
    sessionId: 'session-b',
    disposition: 'created',
  });
  assert.deepEqual(await resultPromise, {
    status: 'accepted',
    roomId: 'created-room',
    roomCreated: true,
  });
  assert.deepEqual(run.calls.filter(call => call[0] === 'send'), [
    ['send', 'created-room', 'run-a', 'user-item', 'Hello'],
    ['send', 'created-room', 'run-b', 'user-item', 'Hello'],
  ]);
  assert.ok(
    run.calls.findIndex(call => call[0] === 'persist')
      < run.calls.findIndex(call => call[0] === 'send'),
  );
  run.source.dispose();
});

test('keeps the owned-page draft failed when any exact delivery is not accepted', async () => {
  const intent = {
    kind: 'send-message',
    roomId: 'room-a',
    roomCreated: false,
    deliveries: [{ memberId: 'member-a', runId: 'run-a' }],
    userItemId: 'user-item',
    bindingId: 'page',
    generation: 'page',
    dispatchText: 'Hello',
  };
  const run = harness({ intent });
  run.sessions.sendToRoom = (...args) => {
    run.calls.push(['send', ...args]);
    return Promise.resolve({ status: 'denied', roomId: 'room-a', runId: 'run-a', code: 'denied' });
  };
  await assert.rejects(run.source.submit('room-a', 'Hello'), /member-a\/run-a: denied:denied/u);
  run.source.dispose();
});

test('routes current and legacy approval decisions to exact Session or playground owners', async () => {
  const regular = harness({ rooms: [createRoom({ id: 'room-a', title: 'Room A' })] });
  assert.equal(await regular.source.decideApproval('room-a', 'approval-a', 'approved'), true);
  assert.deepEqual(regular.calls.at(-1), [
    'session-approval',
    'room-a',
    'approval-a',
    'allowed-once',
  ]);
  regular.source.dispose();

  const playgroundApproval = {
    itemId: 'approval-p',
    runId: 'run-p',
    turnId: 'turn-p',
    approvalId: 'approval-id-p',
  };
  const playgroundRoom = {
    ...createRoom({ id: 'room-p', title: 'Playground Room' }),
    playgroundAgentApprovals: [playgroundApproval],
  };
  const playground = harness();
  playground.registry.get = roomId => roomId === 'room-p' ? playgroundRoom : undefined;
  assert.equal(await playground.source.decideApproval('room-p', 'approval-p', 'denied'), true);
  const call = playground.calls.at(-1);
  assert.equal(call[0], 'playground-approval');
  assert.deepEqual(call.slice(1, 3), ['room-p', 'approval-p']);
  assert.equal(call[4], 'denied');
  playground.source.dispose();
});

test('detaches Room, Session, and settings listeners on disposal', async () => {
  const run = harness();
  assert.equal(run.projectionListeners.size, 1);
  assert.equal(run.settingsListeners.size, 1);
  run.source.dispose();
  assert.equal(run.projectionListeners.size, 0);
  assert.equal(run.settingsListeners.size, 0);
  await assert.rejects(run.source.submit(undefined, 'late'), /disposed/u);
});
