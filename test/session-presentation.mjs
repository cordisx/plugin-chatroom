import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  ChatroomSessionPresentation,
  addRoomRun,
  bindRoomRunSession,
  createRoom,
} from '../dist/index.js';

const base = (seq, type, data) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1',
  schemaVersion: 1,
  sessionId: 'session-one',
  seq,
  time: 1_000 + seq,
  type,
  data,
});

test('projects replay then live SessionEvent facts without a second durable history', () => {
  let room = createRoom({ id: 'room-one', title: 'Room one', configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION });
  room = addRoomRun(room, { runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'running' });
  room = bindRoomRunSession(room, 'lead-run', 'session-one');
  const presentation = new ChatroomSessionPresentation();

  presentation.observe({ roomId: room.id, runId: 'lead-run', page: {
    sessionId: 'session-one', sessionGeneration: 1, phase: 'replay',
    events: [base(0, 'user/message', {
      id: 'user-one', role: 'user', content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' },
    })],
  } });
  presentation.observe({ roomId: room.id, runId: 'lead-run', page: {
    sessionId: 'session-one', sessionGeneration: 1, phase: 'live',
    events: [base(1, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'assistant-one', role: 'assistant', content: [{ type: 'text', text: 'Hi' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    })],
  } });

  assert.equal(presentation.revision, 2);
  assert.deepEqual(presentation.items(room).map(item => [item.kind, item.messageId]), [
    ['message', 'user-one'], ['message', 'assistant-one'],
  ]);
  assert.equal(presentation.selection(room).activeRuns[0].sessionId, 'session-one');
});
