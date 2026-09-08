import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatroomCliBindings } from '../dist/room-cli-bindings.js';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';

function setup() {
  const room = h.roomWithRun();
  const runtime = h.runtimeHarness({ room });
  const store = h.DurableChatroomRoomStore.memory([room]);
  return { room, runtime, store };
}

// Lifecycle coordination test; this intentionally does not claim a real Host or CLI process.
test('first real Session association precedes binding, and binding failure prevents Agent submission', async () => {
  const { runtime, store } = setup();
  const controller = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
      collaboration: {
        enabled: () => true,
        ensureBound: async (room, run) => {
          assert.equal(store.rooms.get(room.id).runs[0].sessionId, run.sessionId);
          assert.equal(run.collaborationMode, 'cli-pending');
          assert.equal(runtime.handles[0].calls.messages.length, 0);
          throw new Error('Binding denied');
        },
        revoke: async () => {},
      },
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await assert.rejects(controller.requestMemberSelfIntroduction('room', 'review-run'), /Binding denied/);
  assert.equal(runtime.handles[0].calls.messages.length, 0);
  const run = store.rooms.get('room').runs[0];
  assert.equal(run.collaborationMode, 'cli-pending');
  assert.equal(run.presence.failure.code, 'chatroom-cli-binding-unavailable');
  await controller.dispose();
  store.dispose();
});

test('successful binding precedes first submission and opts in only this run', async () => {
  const { runtime, store } = setup();
  const order = [];
  const controller = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
      collaboration: {
        enabled: () => true,
        ensureBound: async () => {
          order.push('bound');
          assert.equal(runtime.handles[0].calls.messages.length, 0);
        },
        revoke: async () => {
          order.push('revoked');
        },
      },
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const outcome = await controller.requestMemberSelfIntroduction('room', 'review-run');
  assert.equal(outcome.status, 'accepted');
  assert.equal(store.rooms.get('room').runs[0].collaborationMode, 'cli');
  assert.equal(runtime.handles[0].calls.messages.length, 1);
  await controller.dispose();
  assert.deepEqual(order, ['bound', 'revoked']);
  store.dispose();
});

test('adapter revokes on Room archive and rejects a late handler even before revoke transport settles', async () => {
  let handler;
  let revokes = 0;
  const room = h.roomWithRun('session-existing');
  const store = h.DurableChatroomRoomStore.memory([room]);
  const bindings = new ChatroomCliBindings(
    {
      register: (_, value) => {
        handler = value;
        return () => {};
      },
      bind: async ({ sessionId }) => ({
        bindingId: 'binding-test',
        sessionId,
        expiresAt: '2099-01-01T00:00:00Z',
        revoke: async () => {
          revokes += 1;
        },
      }),
    },
    store,
    { get: () => ({ cliReporting: true }), watch: () => () => {} },
  );
  await bindings.ensureBound(room, room.runs[0]);
  await store.upsert(h.createRoom({ ...room, archived: true }));
  assert.equal(revokes, 1);
  const result = await handler({
    binding: {
      sessionId: 'session-existing',
      scope: { roomId: 'room', runId: 'review-run', memberId: 'reviewer', participantId: 'reviewer' },
    },
    input: { operationId: 'op-late', text: 'Late message' },
    signal: new AbortController().signal,
  });
  assert.equal(result.code, 'stale-binding');
  assert.equal(store.rooms.get('room').cliMessages, undefined);
  await bindings.dispose();
  store.dispose();
});

test('disabled CLI collaboration rejects task startup before any task fact or Host call', async () => {
  const { room, store } = setup();
  let hostCalls = 0;
  const bindings = new ChatroomCliBindings(
    undefined,
    store,
    { get: () => ({ cliReporting: false }), watch: () => () => {} },
    {
      createAndSubmit: async () => {
        hostCalls += 1;
        throw new Error('must not execute');
      },
    },
  );
  const before = JSON.stringify(store.rooms.get(room.id));
  assert.deepEqual(
    await bindings.startTask({
      action: 'start',
      roomId: room.id,
      to: 'leader',
      operationId: 'disabled-start',
      text: 'New task',
      cwd: '/workspace/project',
    }),
    { status: 'rejected', code: 'unsupported' },
  );
  assert.equal(hostCalls, 0);
  assert.equal(JSON.stringify(store.rooms.get(room.id)), before);
  await bindings.dispose();
  store.dispose();
});
