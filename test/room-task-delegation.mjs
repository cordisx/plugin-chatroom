import assert from 'node:assert/strict';
import test from 'node:test';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';
import { ChatroomTaskHandler } from '../dist/room-task-handler.js';
import { createChatroomCliMessageHandler } from '../dist/room-cli-message.js';
import { projectRoomTasks } from '../dist/room-task-projection.js';
import { parseChatroomArguments } from '../src/cli/parse.mjs';

export function fixture() {
  let room = createRoom({ id: 'room-task', title: 'Delegation' });
  room = addRoomRun(room, { memberId: 'leader', runId: 'leader-run', title: 'Lead', status: 'creating' });
  room = bindRoomRunSession(room, 'leader-run', 'leader-session');
  const leader = room.memberships.find(member => member.memberId === 'leader');
  const scope = {
    roomId: room.id,
    memberId: leader.memberId,
    participantId: leader.participantId,
    runId: 'leader-run',
    sessionId: 'leader-session',
  };
  const store = DurableChatroomRoomStore.memory([room]);
  return {
    store,
    scope,
    input: { action: 'delegate', operationId: 'review-1', to: 'reviewer', text: 'Review change.' },
  };
}
const accepted = request => ({
  status: 'accepted',
  operationId: request.operationId,
  disposition: 'created',
  task: {
    sessionId: 'child-session',
    messageId: 'child-first-message',
    context: { cwd: '/project' },
    detail: { kind: 'host', ref: 'opaque-detail' },
  },
});

test('single operation persists before Host create, joins early reports, deduplicates and preserves honest runtime query', async () => {
  const { store, scope, input } = fixture();
  const send = createChatroomCliMessageHandler(store);
  let creates = 0;
  let request;
  const execution = { status: 'unavailable', code: 'host-unavailable' };
  const tasks = {
    async createAndSubmit(value) {
      creates += 1;
      request = value;
      const run = store.rooms.get(scope.roomId).runs.find(run => run.delegation);
      assert.equal(run.sessionId, undefined);
      assert.equal(run.delegation.request.operationId, value.operationId);
      assert.deepEqual(value.context, { kind: 'inherit', sessionId: scope.sessionId });
      assert.deepEqual(
        value.definition,
        store.rooms.get(scope.roomId).memberships.find(value => value.memberId === input.to).definition,
      );
      assert.match(value.text, /"memberId":"reviewer"/);
      const childScope = { ...value.tool.scope, sessionId: 'child-session' };
      assert.equal((await send(childScope, { operationId: 'accepted-1', text: 'Accepted.' })).status, 'accepted');
      assert.equal((await send(childScope, { operationId: 'accepted-1', text: 'Accepted.' })).disposition, 'replayed');
      assert.equal(
        store.rooms.get(scope.roomId).runs.find(value => value.runId === run.runId).delegation.result,
        undefined,
      );
      return accepted(value);
    },
    async query(value) {
      assert.equal(value.operationId, request.operationId);
      return { status: 'found', result: accepted(request), execution };
    },
  };
  const handler = new ChatroomTaskHandler(store, tasks);
  const results = await Promise.all([handler.handle(scope, input), handler.handle(scope, input)]);
  assert.equal(creates, 1);
  assert.equal(results[0].status, 'accepted');
  assert.equal(results[1].runId, results[0].runId);
  const room = store.rooms.get(scope.roomId);
  assert.equal(room.runs.length, 2);
  assert.equal(room.cliMessages.length, 1);
  const projection = projectRoomTasks(room)[0];
  assert.equal(projection.text, input.text);
  assert.equal(projection.creation.status, 'accepted');
  assert.equal(projection.execution, undefined);
  const query = await handler.handle(scope, { action: 'query', operationId: input.operationId });
  assert.deepEqual(query.execution, execution);
  assert.equal(query.reports.length, 1);
  assert.equal(creates, 1);
  const restored = DurableChatroomRoomStore.memory([JSON.parse(JSON.stringify(room))]);
  assert.equal(projectRoomTasks(restored.rooms.get(room.id))[0].sessionId, 'child-session');
  const restarted = new ChatroomTaskHandler(restored, tasks);
  assert.equal((await restarted.handle(scope, { action: 'query', operationId: input.operationId })).status, 'found');
  assert.equal((await restarted.handle(scope, { ...input, text: 'Changed' })).code, 'operation-conflict');
  assert.equal(creates, 1);
  store.dispose();
  restored.dispose();
});

test('explicit context is frozen, unavailable/partial result remains correlated and query never submits', async () => {
  for (const override of [{ cwd: '/other' }, { projectId: 'project-a', cwd: '/other' }, { projectId: 'project-a' }]) {
    const { store, scope, input } = fixture();
    let request;
    let calls = 0;
    const handler = new ChatroomTaskHandler(store, {
      async createAndSubmit(value) {
        request = value;
        calls += 1;
        return {
          status: 'unavailable',
          operationId: value.operationId,
          code: 'submit-failed',
          sessionId: 'partial-session',
        };
      },
      async query() {
        return {
          status: 'found',
          result: {
            status: 'unavailable',
            operationId: request.operationId,
            code: 'reconciliation-required',
            sessionId: 'partial-session',
          },
          execution: { status: 'unavailable' },
        };
      },
    });
    const response = await handler.handle(scope, { ...input, ...override });
    assert.equal(response.status, 'unavailable');
    assert.equal(response.sessionId, 'partial-session');
    assert.deepEqual(
      request.context,
      override.projectId ? { kind: 'project', ...override } : { kind: 'directory', ...override },
    );
    const query = await handler.handle(scope, { action: 'query', operationId: input.operationId });
    assert.equal(query.result.code, 'reconciliation-required');
    assert.equal(calls, 1);
    assert.equal(store.rooms.get(scope.roomId).runs.length, 2);
    store.dispose();
  }
});

test('invalid input, unauthorized source/target and changed operation fail without native side effects', async () => {
  const { store, scope, input } = fixture();
  let calls = 0;
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(request) {
      calls += 1;
      return accepted(request);
    },
  });
  for (const changed of [{ sessionId: 'forged' }, { roomId: 'other-room' }, { memberId: 'reviewer' }]) {
    assert.equal((await handler.handle({ ...scope, ...changed }, input)).code, 'stale-binding');
  }
  for (
    const changed of [{ caller: scope }, { cwd: 'relative' }, { context: { kind: 'inherit', sessionId: 'other' } }]
  ) {
    assert.equal((await handler.handle(scope, { ...input, ...changed })).code, 'invalid-input');
  }
  assert.equal((await handler.handle(scope, { ...input, to: 'leader' })).code, 'unauthorized');
  assert.equal((await handler.handle(scope, { ...input, to: 'qa' })).code, 'unauthorized');
  assert.equal((await handler.handle(scope, { ...input, roomId: 'other' })).code, 'unauthorized');
  assert.equal(calls, 0);
  assert.equal((await handler.handle(scope, input)).status, 'accepted');
  assert.equal((await handler.handle(scope, { ...input, cwd: '/new' })).code, 'operation-conflict');
  assert.equal(calls, 1);
  store.dispose();
});

test('forged early report scope and returned mismatched Session cannot replace a task association', async () => {
  const { store, scope, input } = fixture();
  const send = createChatroomCliMessageHandler(store);
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(request) {
      const childScope = { ...request.tool.scope, sessionId: 'child-session' };
      for (
        const changed of [{ taskOperationId: 'wrong' }, { runId: scope.runId }, { memberId: scope.memberId }, {
          roomId: 'wrong',
        }]
      ) {
        assert.equal(
          (await send({ ...childScope, ...changed }, { operationId: 'early', text: 'Early report' })).code,
          'stale-binding',
        );
      }
      assert.equal((await send(childScope, { operationId: 'early', text: 'Early report' })).status, 'accepted');
      return { ...accepted(request), task: { ...accepted(request).task, sessionId: 'wrong-session' } };
    },
  });
  assert.equal((await handler.handle(scope, input)).code, 'reconciliation-required');
  const task = projectRoomTasks(store.rooms.get(scope.roomId))[0];
  assert.equal(task.sessionId, 'child-session');
  assert.equal(task.creation.status, 'pending');
  store.dispose();
});

test('missing Host capability creates no run; transport uncertainty retains operation without pretending acceptance', async () => {
  const { store, scope, input } = fixture();
  assert.equal((await new ChatroomTaskHandler(store).handle(scope, input)).code, 'unsupported');
  assert.equal(store.rooms.get(scope.roomId).runs.length, 1);
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit() {
      throw new Error('lost response');
    },
  });
  const result = await handler.handle(scope, input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'reconciliation-required');
  const restored = createRoom(JSON.parse(JSON.stringify(store.rooms.get(scope.roomId))));
  assert.equal(restored.runs[1].delegation.result.code, 'reconciliation-required');
  assert.equal(restored.runs[1].sessionId, undefined);
  store.dispose();
});

test('CLI delegate/query parse the same binding and forbid report identity and unsupported flags', () => {
  const prefix = [
    '--binding',
    '/host/binding',
    'delegate',
    '--operation',
    'op-1',
    '--to',
    'reviewer',
    '--text',
    'Work',
  ];
  assert.deepEqual(parseChatroomArguments(prefix).input, {
    action: 'delegate',
    operationId: 'op-1',
    to: 'reviewer',
    text: 'Work',
  });
  assert.equal(parseChatroomArguments([...prefix, '--cwd', '/project']).input.cwd, '/project');
  assert.throws(() => parseChatroomArguments([...prefix, '--cwd', 'relative']));
  assert.throws(() => parseChatroomArguments([...prefix, '--session', 'fake']));
  assert.throws(() => parseChatroomArguments(['--binding', '/binding', 'query', '--operation', 'op', '--text', 'bad']));
  assert.deepEqual(parseChatroomArguments(['--binding', '/binding', 'query', '--operation', 'op']).input, {
    action: 'query',
    operationId: 'op',
  });
});
