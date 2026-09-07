import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';

test('late read-only detail lookup cannot publish after its Shell source is disposed', async () => {
  const original = h.roomWithRun('original-session');
  const room = h.createRoom({
    ...original,
    participants: original.memberships.map(member => ({
      id: member.participantId,
      name: member.label,
      kind: 'agent',
    })),
  });
  const store = h.DurableChatroomRoomStore.memory([room]);
  const before = JSON.stringify(store.document(room.id));
  const runtime = h.runtimeHarness({ room });
  runtime.sessions.clear();
  const sessions = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const domain = new h.ChatroomConversationController(store.rooms);
  let resolveDetail;
  let entered;
  const pending = new Promise(resolve => {
    entered = resolve;
  });
  const source = new h.ChatroomAgentSessionConversationSourceV12(
    {
      bindingId: 'associated-source',
      shell: 'agent-desktop',
      ownerGeneration: 'associated-owner',
      routeSelection: { scope: 'room-or-new', selectedRoomParam: room.id },
    },
    domain.createSource({
      bindingId: 'associated-source',
      shell: 'agent-desktop',
      ownerGeneration: 'associated-owner',
      routeSelection: { scope: 'room-or-new', selectedRoomParam: room.id },
    }),
    sessions,
    'enter',
    () => {},
    {
      get: async request => {
        entered();
        return await new Promise(resolve => {
          resolveDetail = () =>
            resolve({
              status: 'accepted',
              sessionId: request.sessionId,
              target: { kind: 'host', ref: 'late-reference' },
            });
        });
      },
    },
  );
  await pending;
  source.dispose();
  resolveDetail();
  await assert.rejects(source.snapshot(), /source is unavailable/);
  assert.equal(JSON.stringify(store.document(room.id)), before);
  assert.equal(runtime.creates.length, 0);
  assert.equal(runtime.resumes.length, 0);
  domain.dispose();
  await sessions.dispose();
  store.dispose();
});
