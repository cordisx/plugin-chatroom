import assert from 'node:assert/strict';
import test from 'node:test';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';
import { createChatroomCliMessageHandler } from '../dist/room-cli-message.js';
import { roomCliPageMessages } from '../dist/room-cli-message-page.js';
import { parseChatroomArguments } from '../src/cli/parse.mjs';

function fixture() {
  let room = createRoom({ id: 'room-cli-test', title: 'CLI test' });
  const member = room.memberships[0];
  room = addRoomRun(room, { memberId: member.memberId, runId: 'run-cli-test', status: 'creating' });
  room = bindRoomRunSession(room, 'run-cli-test', 'session-cli-test');
  const scope = {
    roomId: room.id,
    memberId: member.memberId,
    participantId: member.participantId,
    runId: 'run-cli-test',
    sessionId: 'session-cli-test',
  };
  const store = DurableChatroomRoomStore.memory([room]);
  return { store, scope, send: createChatroomCliMessageHandler(store) };
}

test('real handler uses Room CAS and publishes one correct member message for concurrent retries', async () => {
  const { store, scope, send } = fixture();
  let changes = 0;
  const unsubscribe = store.rooms.subscribe(() => {
    changes += 1;
  });
  const input = { operationId: 'op-1', text: 'Work accepted.' };
  const results = await Promise.all([send(scope, input), send(scope, input)]);
  assert.deepEqual(results.map(value => value.disposition).sort(), ['created', 'replayed']);
  assert.equal(results[0].messageId, results[1].messageId);
  assert.equal(changes, 1);
  const room = store.rooms.get(scope.roomId);
  assert.equal(room.cliMessages.length, 1);
  assert.equal(roomCliPageMessages(room)[0].author.participantId, scope.participantId);
  const restored = DurableChatroomRoomStore.memory([createRoom(JSON.parse(JSON.stringify(room)))]);
  assert.equal((await createChatroomCliMessageHandler(restored)(scope, input)).disposition, 'replayed');
  assert.deepEqual(await send(scope, { ...input, text: 'Changed' }), {
    status: 'rejected',
    code: 'operation-conflict',
  });
  unsubscribe();
  store.dispose();
  restored.dispose();
});

test('Room/member/run/session and explicit room constraint fail closed without a write', async () => {
  const { store, scope, send } = fixture();
  const input = { operationId: 'op-2', text: 'Cannot escape scope.' };
  assert.equal((await send(scope, { ...input, roomId: 'other-room' })).code, 'unauthorized');
  for (const field of ['roomId', 'memberId', 'participantId', 'runId', 'sessionId']) {
    assert.equal((await send({ ...scope, [field]: 'other' }, input)).code, 'stale-binding');
  }
  assert.equal((await send(scope, { ...input, author: 'lead' })).code, 'invalid-input');
  await store.upsert(createRoom({ ...store.rooms.get(scope.roomId), archived: true }));
  assert.equal((await send(scope, input)).code, 'stale-binding');
  assert.equal(store.rooms.get(scope.roomId).cliMessages, undefined);
  store.dispose();
});

test('CLI parser preserves exact text and rejects duplicate arguments and self-declared identity', () => {
  const prefix = ['--binding', '/host/binding.json', 'send', '--operation', 'op-3', '--text', ' line 1\nline 2 '];
  assert.equal(parseChatroomArguments(prefix).input.text, ' line 1\nline 2 ');
  assert.throws(() => parseChatroomArguments([...prefix, '--member', 'lead']));
  assert.throws(() => parseChatroomArguments([...prefix, '--text', 'changed']));
  assert.throws(() => parseChatroomArguments(['send', '--operation', 'op-3', '--text', 'hello']));
});
