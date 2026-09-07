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

test('Leader startup requires explicit new-task context, binds before submission, then delegates through its own authenticated Session', async () => {
  let room = createRoom({ id: 'leader-start', title: 'First real task' });
  const store = DurableChatroomRoomStore.memory([room]);
  const requests = [];
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(request) {
      requests.push(request);
      return {
        ...accepted(request),
        task: {
          ...accepted(request).task,
          sessionId: requests.length === 1 ? 'leader-start-session' : 'child-session',
        },
      };
    },
  });
  const input = {
    action: 'start',
    roomId: room.id,
    to: 'leader',
    operationId: 'leader-op',
    text: 'Delegate a review.',
  };
  assert.equal((await handler.start(input)).code, 'context-required');
  assert.equal(store.rooms.get(room.id).runs.length, 0);
  assert.equal((await handler.start({ ...input, cwd: '/project' })).status, 'accepted');
  room = store.rooms.get(room.id);
  assert.equal(room.runs.length, 1);
  assert.deepEqual(room.runs[0].delegation.source, { kind: 'room', roomId: room.id });
  const scope = { ...requests[0].tool.scope, sessionId: 'leader-start-session' };
  assert.equal((await handler.handle(scope, { ...input, cwd: '/project' })).code, 'invalid-input');
  assert.equal(
    (await handler.handle(scope, { action: 'delegate', operationId: 'child-op', to: 'reviewer', text: 'Review.' }))
      .status,
    'accepted',
  );
  assert.deepEqual(requests[1].context, { kind: 'inherit', sessionId: 'leader-start-session' });
  assert.equal(store.rooms.get(room.id).runs.length, 2);
  assert.deepEqual(requests[0].context, { kind: 'directory', cwd: '/project' });
  assert.match(requests[0].text, /"availableTargets":\[/);
  store.dispose();
});

test('public Room preparation uses configured membership and persists no Session or acknowledgement', async () => {
  const { createRoomTaskBootstrap } = await import('../dist/room-task-bootstrap.js');
  const { CHATROOM_DEFAULT_AGENT_CONFIGURATION } = await import('../dist/agent-definition.js');
  const store = DurableChatroomRoomStore.memory([]);
  const prepare = createRoomTaskBootstrap(store, CHATROOM_DEFAULT_AGENT_CONFIGURATION);
  const input = { roomId: 'prepared-room', title: 'Prepared' };
  const results = await Promise.all([prepare(input), prepare(input)]);
  assert.deepEqual(results.map(value => value.disposition).sort(), ['created', 'replayed']);
  const room = store.rooms.get(input.roomId);
  assert.equal(room.runs.length, 0);
  assert.equal(room.acknowledgements.length, 0);
  assert.equal(room.items.length, 0);
  assert.equal(room.memberships.length, CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.length);
  assert.equal((await prepare({ ...input, title: 'Changed' })).code, 'operation-conflict');
  assert.equal((await prepare({ ...input, caller: 'fake' })).code, 'invalid-input');
  store.dispose();
});

test('legacy controller cannot create a second Session for a pending or partial delegation', async () => {
  const { agentSessionControllerHarness: h } = await import('./agent-session-controller/harness.mjs');
  for (const partial of [false, true]) {
    const { store, scope, input } = fixture();
    const taskHandler = new ChatroomTaskHandler(store, {
      async createAndSubmit(request) {
        return {
          status: 'unavailable',
          operationId: request.operationId,
          code: 'reconciliation-required',
          ...(partial ? { sessionId: 'partial-child' } : {}),
        };
      },
    });
    const result = await taskHandler.handle(scope, input);
    const room = store.rooms.get(scope.roomId);
    const runtime = h.runtimeHarness({ room });
    const controller = new h.ChatroomAgentSessionController(
      { agents: runtime.agents, sessions: runtime.sessionRegistry, approvals: runtime.approvals },
      h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    await assert.rejects(controller.sendToRoom(room.id, result.runId, 'followup-item', 'Continue'), /reconciliation/);
    assert.equal(runtime.creates.length, 0);
    assert.equal(runtime.resumes.length, 0);
    await controller.dispose();
    store.dispose();
  }
});

test('explicit recovery uses the retained Host operation and Session without creating another task', async () => {
  const { store, scope, input } = fixture();
  let request;
  let creates = 0;
  let recoveries = 0;
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(value) {
      request = value;
      creates += 1;
      return {
        status: 'unavailable',
        operationId: value.operationId,
        code: 'submit-failed',
        sessionId: 'child-session',
      };
    },
  }, async value => {
    recoveries += 1;
    assert.equal(value.operationId, request.operationId);
    return accepted(request);
  });
  await handler.handle(scope, input);
  const recovered = await handler.handle(scope, { action: 'recover', operationId: input.operationId });
  assert.equal(recovered.status, 'accepted');
  assert.equal(recovered.task.sessionId, 'child-session');
  assert.equal(creates, 1);
  assert.equal(recoveries, 1);
  assert.equal(store.rooms.get(scope.roomId).runs.length, 2);
  store.dispose();
});

test('a relationship revoked while task persistence yields prevents the first Host call', async () => {
  const { store, scope, input } = fixture();
  const cas = store.compareAndSwap.bind(store);
  let changed = false;
  store.compareAndSwap = async (revision, room) => {
    const result = await cas(revision, room);
    if (!changed && room.runs.some(run => run.delegation)) {
      changed = true;
      const current = store.document(room.id);
      await cas(
        current.revision,
        createRoom({
          ...current.room,
          memberships: current.room.memberships.map(member =>
            member.memberId === input.to
              ? { ...member, reportsToMemberId: undefined }
              : member
          ),
        }),
      );
    }
    return result;
  };
  let creates = 0;
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(request) {
      creates += 1;
      return accepted(request);
    },
  });
  assert.equal((await handler.handle(scope, input)).code, 'stale-binding');
  assert.equal(creates, 0);
  store.dispose();
});
