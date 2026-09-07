import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';
import { createChatroomCliMessageHandler } from '../dist/room-cli-message.js';
import { projectAgentConversationShellSnapshotV7 } from '../node_modules/cordisx/packages/cli/dist/src/renderer/agent-conversation-shell-projection.js';

function historyRoom() {
  let room = h.createRoom({ id: 'history-room', title: 'Original Room' });
  room = h.createRoom({
    ...room,
    participants: [
      { id: 'user', name: 'You', kind: 'human' },
      ...room.memberships.map(member => ({ id: member.participantId, name: member.label, kind: 'agent' })),
    ],
  });
  room = h.addRoomRun(room, { runId: 'original-run', memberId: 'leader', title: 'Lead run', status: 'creating' });
  room = h.bindRoomRunSession(room, 'original-run', 'original-session');
  room = h.createRoom({
    ...room,
    items: [{
      kind: 'message',
      itemId: 'original-room-item',
      messageId: 'original-display-message',
      sequence: 2,
      author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
      source: 'agent-loop',
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'message.user', fallback: 'hi' } }],
      timestamp: '2026-09-07T13:18:26.884Z',
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      reactions: [],
      actions: [],
    }],
  });
  return h.recordRoomAdmissionMessageLink(room, {
    roomId: room.id,
    itemId: 'original-room-item',
    messageId: 'accepted-session-message',
    participantId: 'leader',
    memberId: 'leader',
    runId: 'original-run',
    sessionId: 'original-session',
    owner: h.owner,
  });
}

test('cold Room history shows persisted hi and CLI reply, then exact Session replay replaces only the history representation', async () => {
  const room = historyRoom();
  const store = h.DurableChatroomRoomStore.memory([room]);
  await createChatroomCliMessageHandler(store)({
    roomId: room.id,
    participantId: 'leader',
    memberId: 'leader',
    runId: 'original-run',
    sessionId: 'original-session',
  }, { operationId: 'original-report', text: 'Original CLI reply.' });
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
  const binding = {
    bindingId: 'history-binding',
    shell: 'agent-desktop',
    ownerGeneration: 'history-owner',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: room.id },
  };
  const source = new h.ChatroomAgentSessionConversationSourceV12(
    binding,
    domain.createSource(binding),
    sessions,
    'enter',
  );
  try {
    const cold = await source.snapshot();
    const messages = cold.items.filter(item => item.kind === 'message');
    assert.deepEqual(cold.selection.associatedSessions, [{
      participantId: 'leader',
      memberId: 'leader',
      runId: 'original-run',
      sessionId: 'original-session',
      state: 'unloaded',
    }]);
    assert.equal(messages.length, 2);
    const human = messages.find(item => item.author.role === 'human');
    assert.equal(human.source.kind, 'room-user-message');
    assert.equal(human.messageId, 'original-display-message');
    assert.equal(human.source.sequence, 2);
    assert.equal(human.body[0].text.fallback, 'hi');
    assert.equal(human.deliveryState, 'sent');
    const model = projectAgentConversationShellSnapshotV7(
      'chatroom',
      cold,
      {
        resolve: value => value.fallback ?? value.key,
      },
      true,
      true,
      true,
    );
    assert.deepEqual(
      model.entries.filter(item => item.kind === 'message' && item.authorId === 'user')
        .map(item => item.body),
      [['hi']],
    );
    assert.equal(messages.find(item => item.author.role === 'agent').body[0].text.fallback, 'Original CLI reply.');
    assert.equal(JSON.stringify(store.document(room.id)), before);
    assert.equal(runtime.creates.length, 0);
    assert.equal(runtime.resumes.length, 0);

    const originalEvent = h.sessionEvent('original-session', 1, 'user/message', {
      id: 'accepted-session-message',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', pluginId: h.owner.pluginId, generation: h.owner.generation, form: 'relay' },
    });
    const session = new h.FakeSession('original-session', [
      h.sessionEvent('original-session', 0, 'turn/start', { turn: 1 }),
      originalEvent,
    ]);
    runtime.sessions.set(session.id, session);
    await sessions.hydrateRoom(room.id);
    await new Promise(resolve => setImmediate(resolve));
    const observedSnapshot = await source.snapshot();
    assert.equal(observedSnapshot.selection.associatedSessions, undefined);
    const observed = observedSnapshot.items.filter(item => item.kind === 'message');
    assert.equal(observed.length, 2);
    assert.equal(observed.filter(item => item.source.kind === 'room-user-message').length, 0);
    assert.equal(observed.find(item => item.author.role === 'human').messageId, 'accepted-session-message');

    await session.emitLive([h.sessionEvent('original-session', 2, 'user/message', {
      id: 'replacement-session-message',
      role: 'user',
      content: [{ type: 'text', text: 'Revised' }],
      source: { kind: 'user' },
    }, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] })]);
    await new Promise(resolve => setImmediate(resolve));
    const replaced = (await source.snapshot()).items.filter(item => item.kind === 'message');
    assert.equal(replaced.length, 2, 'authoritative replacement must not resurrect the old Room history item');
    assert.equal(replaced.find(item => item.author.role === 'human').body[0].text.fallback, 'Revised');
    assert.equal(JSON.stringify(store.document(room.id)), before);
  } finally {
    source.dispose();
    domain.dispose();
    await sessions.dispose();
    store.dispose();
  }
});
