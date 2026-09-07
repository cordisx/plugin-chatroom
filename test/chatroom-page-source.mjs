import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatroomPageSource } from '../dist/chatroom-page-source.js';
import { addRoomRun, bindRoomRunSession, ChatroomRoomRegistry, createRoom } from '../dist/room.js';

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
  assert.equal('submit' in run.source, false, 'page source exposes no direct Agent dispatch fallback');
});

test('member status comes from an available live Agent observation, never historical lifecycle', async () => {
  const room = bindRoomRunSession(
    addRoomRun(createRoom({ id: 'room-a', title: 'Room A' }), {
      runId: 'review-run',
      memberId: 'reviewer',
      title: 'Reviewer',
      status: 'creating',
    }),
    'review-run',
    'session-a',
  );
  const descriptor = {
    runId: 'review-run',
    memberId: 'reviewer',
    sessionId: 'session-a',
    participantId: room.memberships.find(member => member.memberId === 'reviewer').participantId,
    lifecycle: { phase: 'running' },
  };
  const h = harness({ rooms: [room], projection: { activeRuns: [descriptor], items: [] } });
  let status = { status: 'unavailable', code: 'whole-agent-idle-unobservable' };
  h.sessions.getObservedAgent = async () => ({ id: 'session-a', status });
  assert.deepEqual(h.source.getSnapshot('room-a').activeRuns, []);
  await h.source.hydrate('room-a');
  assert.deepEqual(h.source.getSnapshot('room-a').activeRuns, []);
  status = { status: 'available', value: 'idle' };
  await h.source.hydrate('room-a');
  assert.deepEqual(h.source.getSnapshot('room-a').activeRuns, []);
  status = { status: 'available', value: 'running' };
  await h.source.hydrate('room-a');
  assert.equal(h.source.getSnapshot('room-a').activeRuns[0].lifecycle.phase, 'running');
  status = { status: 'unavailable', code: 'connection-replaced' };
  h.projectionListeners.forEach(listener => listener('room-a'));
  assert.deepEqual(h.source.getSnapshot('room-a').activeRuns, []);
  await h.source.hydrate('room-a');
  assert.deepEqual(h.source.getSnapshot('room-a').activeRuns, []);
  h.source.dispose();
});

test('returned task creation results suppress only their own stale pending presence without changing Room facts', () => {
  let room = createRoom({ id: 'room-a', title: 'Room A' });
  const member = room.memberships.find(value => value.memberId === 'leader');
  for (
    const [runId, code] of [
      ['denied', 'permission-denied'],
      ['unknown', 'reconciliation-required'],
      ['host-unavailable', 'host-unavailable'],
      ['pending', undefined],
    ]
  ) {
    const hostOperation = `host-${runId}`;
    room = addRoomRun(room, {
      runId,
      memberId: member.memberId,
      title: runId,
      status: 'creating',
      delegation: {
        operationId: `caller-${runId}`,
        text: 'Review the project',
        source: { kind: 'room', roomId: room.id },
        request: {
          operationId: hostOperation,
          definition: member.definition,
          context: { kind: 'directory', cwd: '/project' },
          text: 'Review the project',
          tool: {
            commandId: 'send',
            scope: {
              roomId: room.id,
              participantId: member.participantId,
              memberId: member.memberId,
              runId,
              taskOperationId: hostOperation,
            },
          },
        },
        ...(code === undefined ? {} : { result: { status: 'unavailable', operationId: hostOperation, code } }),
      },
    });
  }
  room = addRoomRun(room, { runId: 'ordinary', memberId: member.memberId, title: 'Ordinary', status: 'creating' });
  const before = JSON.stringify(room);
  const h = harness({ rooms: [room] });
  const snapshot = h.source.getSnapshot(room.id);
  assert.deepEqual(snapshot.items.filter(item => item.kind === 'member-presence').map(item => item.runId), [
    'pending',
    'ordinary',
  ]);
  assert.deepEqual(snapshot.activeRuns, []);
  assert.equal(JSON.stringify(h.registry.get(room.id)), before);
  assert.ok(h.registry.get(room.id).runs.every(run => run.status === 'creating' && run.presence.state === 'creating'));
  h.source.dispose();
});
