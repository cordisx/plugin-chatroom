import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';
import { createChatroomCliMessageHandler } from '../dist/room-cli-message.js';

// This tests consumer coordination, not native Session recovery or Host credential issuance.
test('same-Session CLI resume restores authority and rebinds without rewriting Room facts', async () => {
  const initial = h.roomWithRun('session-existing');
  const room = h.createRoom({
    ...initial,
    runs: initial.runs.map(run => ({ ...run, collaborationMode: 'cli' })),
  });
  const store = h.DurableChatroomRoomStore.memory([room]);
  const run = room.runs[0];
  const member = room.memberships.find(value => value.memberId === run.memberId);
  await createChatroomCliMessageHandler(store)({
    roomId: room.id,
    memberId: member.memberId,
    participantId: member.participantId,
    runId: run.runId,
    sessionId: run.sessionId,
  }, { operationId: 'original-report', text: 'Existing Room report.' });
  const before = JSON.stringify(store.document(room.id));
  const runtime = h.runtimeHarness({ room: store.rooms.get(room.id) });
  let binds = 0;
  let notifications = 0;
  const unsubscribe = store.rooms.subscribe(() => {
    notifications += 1;
  });
  const controller = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
      collaboration: {
        enabled: () => true,
        ensureBound: async (currentRoom, currentRun) => {
          assert.equal(JSON.stringify(store.document(room.id)), before);
          assert.equal(currentRoom.id, room.id);
          assert.equal(currentRun.runId, run.runId);
          assert.equal(currentRun.sessionId, run.sessionId);
          assert.equal(runtime.resumes.length, 1);
          assert.equal(runtime.handles[0].calls.messages.length, 0);
          binds += 1;
        },
        revoke: async () => {},
      },
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.hydrate();
  assert.equal(runtime.resumes.length, 0, 'hydration does not recover authority');
  const acquired = await controller.ensureOwner(room.id, run.runId);
  assert.equal(acquired.handle.agent.session.id, run.sessionId);
  assert.equal(runtime.creates.length, 0);
  assert.equal(binds, 1);
  assert.equal(notifications, 0);
  assert.equal(JSON.stringify(store.document(room.id)), before);
  await controller.dispose();
  unsubscribe();
  store.dispose();
});

test('resume rejects a different returned Session without replacing the existing run', async () => {
  const room = h.roomWithRun('session-existing');
  const runtime = h.runtimeHarness({ room });
  const resume = runtime.agents.resume;
  runtime.agents.resume = options => resume({ ...options, sessionId: 'different-session' });
  const store = h.DurableChatroomRoomStore.memory([room]);
  const before = JSON.stringify(store.document(room.id));
  const controller = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await assert.rejects(
    controller.ensureOwner(room.id, room.runs[0].runId),
    /changed the existing Room run Session identity/,
  );
  assert.equal(runtime.creates.length, 0);
  assert.equal(JSON.stringify(store.document(room.id)), before);
  assert.equal(runtime.handles[0].calls.disposed, 1);
  await controller.dispose();
  store.dispose();
});
