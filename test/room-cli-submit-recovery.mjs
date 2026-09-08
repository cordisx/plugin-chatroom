import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';

function fixture() {
  let original = h.createRoom({ id: 'room', title: 'Existing Room' });
  original = h.addRoomRun(original, { memberId: 'leader', runId: 'run-1', title: 'Lead run', status: 'creating' });
  original = h.bindRoomRunSession(original, 'run-1', 'original-session');
  const room = h.createRoom({ ...original, runs: original.runs.map(run => ({ ...run, collaborationMode: 'cli' })) });
  const store = h.DurableChatroomRoomStore.memory([room]);
  const runtime = h.runtimeHarness({ room });
  runtime.sessions.clear();
  const member = room.memberships.find(value => value.memberId === room.runs[0].memberId);
  const definition = h.CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions.find(value =>
    value.identity.agentId === member.definition.agentId && value.identity.revision === member.definition.revision
  );
  const owner = { profileId: 'test', installationId: 'test', pluginId: 'chatroom' };
  const calls = [];
  const resume = runtime.agents.resume;
  runtime.agents.resume = async options => {
    calls.push(options);
    return options.setup ? resume(options) : { status: 'unavailable', code: 'session-unavailable' };
  };
  const sessions = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
      entities: {
        snapshot: async () => ({
          binding: owner,
          entities: h.CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions.map(definition => ({
            identity: definition.identity,
            digest: definition.identity.revision,
            definition,
            owner,
            access: 'owned',
          })),
        }),
      },
      collaboration: { enabled: () => true, ensureBound: async () => {}, revoke: async () => {} },
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  assert.ok(definition);
  const conversation = new h.ChatroomConversationController(
    store.rooms,
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    room => store.upsert(room),
    (roomId, runId) => sessions.isRunLocallyUnavailable(roomId, runId),
    (roomId, runId) => sessions.canAttemptRunRecovery(roomId, runId),
  );
  return { room, store, runtime, sessions, conversation, calls };
}

test('UI submit planning keeps a missing-Session CLI run and enters recovery without a replacement', async () => {
  const value = fixture();
  await value.sessions.hydrate();
  assert.equal(value.sessions.isRunLocallyUnavailable('room', 'run-1'), true);
  assert.equal(value.sessions.canAttemptRunRecovery('room', 'run-1'), true);
  const intent = value.conversation.submitMessage('room', 'Continue the original work.');
  assert.equal(intent.kind, 'send-message');
  assert.deepEqual(intent.deliveries.map(item => [item.runId, item.runCreated]), [['run-1', false]]);
  await value.conversation.persistComposerRoom('room');
  const acquired = await value.sessions.ensureOwner('room', intent.deliveries[0].runId);
  assert.equal(acquired.handle.agent.session.id, 'original-session');
  assert.equal(value.calls.length, 2);
  assert.equal(value.calls[0].definitionSource, 'session-persisted');
  assert.ok(value.calls[1].setup);
  assert.equal(value.runtime.creates.length, 0);
  const current = value.store.rooms.get('room');
  assert.equal(current.runs.length, 1);
  assert.equal(current.runs[0].runId, 'run-1');
  assert.equal(current.runs[0].sessionId, 'original-session');
  value.conversation.dispose();
  await value.sessions.dispose();
  value.store.dispose();
});

test('unrecoverable unavailable CLI target reports an error instead of retiring and creating a run', () => {
  const original = h.roomWithRun('original-session');
  const room = h.createRoom({ ...original, runs: original.runs.map(run => ({ ...run, collaborationMode: 'cli' })) });
  const conversation = new h.ChatroomConversationController(
    [room],
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    undefined,
    () => true,
  );
  const intent = conversation.submitMessage('room', '@reviewer Continue');
  assert.equal(intent.kind, 'target-error');
  assert.deepEqual(conversation.rooms.get('room').runs, room.runs);
  conversation.dispose();
});
