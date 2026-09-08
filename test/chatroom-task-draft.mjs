import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the production command orchestration against the public command
// return shapes. These tests never create native Sessions or execute a task.
const source = await readFile(new URL('../src/chatroom-task-draft.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: 'chatroom-task-draft.ts',
}).outputText;
const failureSource = await readFile(new URL('../src/chatroom-task-failures.ts', import.meta.url), 'utf8');
const failureExports = {};
new Function(
  'exports',
  ts.transpileModule(failureSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
)(failureExports);
const exports = {};
new Function('require', 'exports', output)(name => {
  assert.equal(name, './chatroom-task-failures.js');
  return failureExports;
}, exports);
const { ChatroomTaskDrafts } = exports;

const members = [
  { memberId: 'lead-a', label: 'Leader A', role: 'leader' },
  { memberId: 'lead-b', label: 'Leader B', role: 'leader' },
  { memberId: 'worker', label: 'Worker', role: 'worker' },
];
const input = { text: 'Review this change', to: 'lead-a', cwd: '/workspace/project' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function room(id = 'existing', overrides = {}) {
  return {
    id,
    title: 'Existing Room',
    archived: false,
    memberships: structuredClone(members),
    runs: [{ memberId: 'lead-a', runId: 'old-run', sessionId: 'old-session' }],
    items: [{ itemId: 'retained-history' }],
    ...overrides,
  };
}

function harness({ initial = [], prepare, start, configuration = members } = {}) {
  const rooms = new Map(initial.map(value => [value.id, structuredClone(value)]));
  const calls = [];
  const prepareRoom = args => {
    const exists = rooms.has(args.roomId);
    if (!exists) rooms.set(args.roomId, room(args.roomId, { title: args.title, runs: [], items: [] }));
    return { status: 'accepted', roomId: args.roomId, disposition: exists ? 'replayed' : 'created' };
  };
  const accepted = args => ({
    status: 'accepted',
    roomId: args.roomId,
    operationId: args.operationId,
    runId: 'created-run',
    memberId: args.to,
    disposition: 'created',
    task: {
      sessionId: 'created-session',
      messageId: 'first-input',
      context: { cwd: args.cwd },
      detail: { kind: 'host', ref: 'opaque-detail' },
    },
  });
  const drafts = new ChatroomTaskDrafts(
    { rooms: { get: id => rooms.get(id) } },
    { members: configuration },
    {
      async execute(request) {
        calls.push(structuredClone(request));
        if (request.id === 'room.prepare') {
          return prepare
            ? await prepare(request.arguments, prepareRoom)
            : prepareRoom(request.arguments);
        }
        assert.equal(request.id, 'task.start');
        return start ? await start(request.arguments, accepted) : accepted(request.arguments);
      },
    },
  );
  return { rooms, calls, drafts };
}

test('invalid task text or unsupported directory context calls neither prepare nor task.start', async () => {
  const invalid = [
    { text: '' },
    { text: ' \n ' },
    { text: 'x'.repeat(16_001) },
    { cwd: '' },
    { cwd: ' \t ' },
    { cwd: 'relative/project' },
    { cwd: '~/project' },
    { cwd: 'C:\\project' },
    { cwd: '\\\\server\\share' },
    { cwd: '/workspace/\0project' },
  ];
  for (const patch of invalid) {
    const h = harness();
    assert.deepEqual(await h.drafts.start(undefined, { ...input, ...patch }), {
      status: 'unavailable',
      code: 'invalid-input',
    }, JSON.stringify(patch));
    assert.deepEqual(h.calls, []);
    assert.equal(h.rooms.size, 0);
  }
  for (const to of ['worker', 'missing', '']) {
    const h = harness();
    assert.deepEqual(await h.drafts.start(undefined, { ...input, to }), {
      status: 'unavailable',
      code: 'leader-unavailable',
    });
    assert.deepEqual(h.calls, []);
  }
});

test('a new Room is prepared before the exact normalized task command and accepted identity is relayed', async () => {
  const h = harness();
  const result = await h.drafts.start(undefined, {
    ...input,
    text: '  First line\nSecond line  ',
    cwd: ' /workspace/project ',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(h.calls.map(call => call.id), ['room.prepare', 'task.start']);
  const [prepare, start] = h.calls;
  assert.deepEqual(prepare.arguments, { roomId: result.roomId, title: 'First line' });
  assert.deepEqual(Object.keys(start.arguments).sort(), ['action', 'cwd', 'operationId', 'roomId', 'text', 'to']);
  assert.equal(start.arguments.action, 'start');
  assert.equal(start.arguments.roomId, result.roomId);
  assert.equal(start.arguments.text, 'First line\nSecond line');
  assert.equal(start.arguments.cwd, input.cwd);
  assert.equal(start.arguments.to, input.to);
  assert.match(start.arguments.operationId, /^[A-Za-z0-9._~-]+$/u);
  assert.equal(h.rooms.size, 1);
  assert.deepEqual(h.rooms.get(result.roomId).runs, []);
});

test('an existing Room uses its own Leaders, skips prepare and preserves existing Session associations', async () => {
  const existing = room('existing', { memberships: members.filter(member => member.memberId !== 'lead-b') });
  const h = harness({ initial: [existing] });
  assert.deepEqual(h.drafts.leaders('existing'), [{ memberId: 'lead-a', label: 'Leader A' }]);
  assert.deepEqual(await h.drafts.start('existing', { ...input, to: 'lead-b' }), {
    status: 'unavailable',
    code: 'leader-unavailable',
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await h.drafts.start('existing', input), { status: 'accepted', roomId: 'existing' });
  assert.deepEqual(h.calls.map(call => call.id), ['task.start']);
  assert.equal(h.calls[0].arguments.roomId, 'existing');
  assert.deepEqual(h.rooms.get('existing'), existing);
  assert.equal(h.rooms.size, 1);
});

test('same normalized payload shares one pending operation while any changed payload stays blocked', async () => {
  const response = deferred();
  const h = harness({ start: async () => response.promise });
  const first = h.drafts.start(undefined, input);
  const same = h.drafts.start(undefined, { ...input, text: ` ${input.text} `, cwd: ` ${input.cwd} ` });
  await tick();
  assert.deepEqual(h.calls.map(call => call.id), ['room.prepare', 'task.start']);
  for (const patch of [{ text: 'Different' }, { cwd: '/elsewhere' }, { to: 'lead-b' }]) {
    assert.deepEqual(await h.drafts.start(undefined, { ...input, ...patch }), {
      status: 'unavailable',
      code: 'pending',
    });
  }
  assert.equal(h.calls.length, 2);
  const sent = h.calls[1].arguments;
  response.resolve({ status: 'accepted', roomId: sent.roomId, operationId: sent.operationId });
  assert.deepEqual(await first, { status: 'accepted', roomId: sent.roomId });
  assert.deepEqual(await same, await first);
});

test('a lost task response retries the same Room and operation and never switches payload', async () => {
  let attempts = 0;
  const h = harness({
    start: async (args, accepted) => {
      attempts++;
      if (attempts === 1) throw new Error('transport lost after task creation');
      return accepted(args);
    },
  });
  assert.deepEqual(await h.drafts.start(undefined, input), { status: 'unavailable', code: 'pending' });
  assert.deepEqual(await h.drafts.start(undefined, { ...input, cwd: '/different' }), {
    status: 'unavailable',
    code: 'pending',
  });
  assert.equal(h.calls.length, 2);
  const first = h.calls[1].arguments;
  assert.deepEqual(await h.drafts.start(undefined, input), { status: 'accepted', roomId: first.roomId });
  assert.deepEqual(h.calls.map(call => call.id), ['room.prepare', 'task.start', 'task.start']);
  assert.deepEqual(h.calls[2].arguments, first);
  assert.equal(h.rooms.size, 1);
  await h.drafts.start(undefined, { ...input, text: 'An intentional next task' });
  assert.notEqual(h.calls.at(-1).arguments.operationId, first.operationId);
});

test('an uncertain prepare response retains its Room identity and does not start a task prematurely', async () => {
  let attempts = 0;
  const h = harness({
    prepare: async (args, prepareRoom) => {
      const result = prepareRoom(args);
      if (++attempts === 1) throw new Error('reply lost after Room commit');
      return result;
    },
  });
  assert.deepEqual(await h.drafts.start(undefined, input), { status: 'unavailable', code: 'pending' });
  assert.deepEqual(h.calls.map(call => call.id), ['room.prepare']);
  assert.deepEqual(await h.drafts.start(undefined, { ...input, text: 'Changed' }), {
    status: 'unavailable',
    code: 'pending',
  });
  assert.equal(h.calls.length, 1);
  const createdRoomId = h.calls[0].arguments.roomId;
  assert.deepEqual(await h.drafts.start(undefined, input), { status: 'accepted', roomId: createdRoomId });
  assert.deepEqual(h.calls.map(call => call.id), ['room.prepare', 'room.prepare', 'task.start']);
  assert.deepEqual(h.calls[1].arguments, h.calls[0].arguments);
  assert.equal(h.calls[2].arguments.roomId, createdRoomId);
  assert.equal(h.rooms.size, 1);
});

test('prepare rejection or a mismatched prepare identity cannot reach task.start', async () => {
  for (
    const [prepared, code] of [
      [undefined, 'pending'],
      [{ status: 'rejected', code: 'invalid-input' }, 'failed'],
      [{ status: 'accepted', roomId: 'foreign' }, 'pending'],
    ]
  ) {
    const h = harness({ prepare: async () => prepared });
    assert.deepEqual(await h.drafts.start(undefined, input), { status: 'unavailable', code });
    assert.deepEqual(h.calls.map(call => call.id), ['room.prepare']);
    assert.equal(h.rooms.size, 0);
  }
});

test('only matching accepted task results complete a draft; unknown results retain the original operation', async () => {
  const responses = [
    () => undefined,
    () => ({ status: 'unavailable', code: 'unavailable' }),
    () => ({ status: 'rejected', code: 'stale-binding' }),
    () => ({ status: 'rejected', code: 'reconciliation-required' }),
    args => ({
      status: 'unavailable',
      operationId: args.operationId,
      roomId: args.roomId,
      runId: 'prepared-run',
      code: 'reconciliation-required',
    }),
    args => ({ status: 'accepted', operationId: 'foreign', roomId: args.roomId, runId: 'prepared-run' }),
    args => ({ status: 'accepted', operationId: args.operationId, roomId: 'foreign', runId: 'prepared-run' }),
  ];
  for (const [index, response] of responses.entries()) {
    const h = harness({ initial: [room()], start: async args => response(args) });
    assert.deepEqual(await h.drafts.start('existing', input), {
      status: 'unavailable',
      code: 'pending',
      ...(index === 4 ? { reason: 'reconciliation-required' } : {}),
    });
    const first = h.calls[0].arguments;
    assert.deepEqual(await h.drafts.start('existing', { ...input, to: 'lead-b' }), {
      status: 'unavailable',
      code: 'pending',
    });
    assert.equal(h.calls.length, 1);
    await h.drafts.start('existing', input);
    assert.deepEqual(h.calls[1].arguments, first);
    assert.deepEqual(h.rooms.get('existing'), room());
  }
});

test('missing or archived Rooms never prepare or dispatch a new task', async () => {
  const h = harness({ initial: [room('archived', { archived: true })] });
  for (const roomId of ['missing', 'archived']) {
    assert.deepEqual(await h.drafts.start(roomId, input), { status: 'unavailable', code: 'leader-unavailable' });
  }
  assert.deepEqual(h.calls, []);
});

test('a definite prepare rejection permits an edited draft without ever starting the rejected task', async () => {
  for (const code of ['invalid-input', 'operation-conflict']) {
    let attempts = 0;
    const h = harness({
      prepare: async (args, prepareRoom) => {
        if (++attempts === 1) return { status: 'rejected', code };
        return prepareRoom(args);
      },
    });
    assert.deepEqual(await h.drafts.start(undefined, input), { status: 'unavailable', code: 'failed' });
    assert.equal(h.rooms.size, 0);
    assert.deepEqual(h.calls.map(call => call.id), ['room.prepare']);
    const edited = { ...input, text: 'A revised task' };
    const result = await h.drafts.start(undefined, edited);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(h.calls.map(call => call.id), ['room.prepare', 'room.prepare', 'task.start']);
    assert.equal(h.calls[2].arguments.text, edited.text);
    assert.equal(h.rooms.size, 1);
  }
});

test('a proven pre-task rejection reuses the prepared Room and preserves its Session associations on edit', async () => {
  for (const code of ['invalid-input', 'context-required', 'unsupported']) {
    for (const originalRoomId of [undefined, 'existing']) {
      let attempts = 0;
      const h = harness({
        initial: originalRoomId === undefined ? [] : [room()],
        start: async (args, accepted) => {
          if (++attempts === 1) return { status: 'rejected', code };
          return accepted(args);
        },
      });
      assert.deepEqual(await h.drafts.start(originalRoomId, input), { status: 'unavailable', code: 'failed' });
      const rejected = h.calls.at(-1).arguments;
      const prepared = structuredClone(h.rooms.get(rejected.roomId));
      const edited = { text: 'A revised task', to: 'lead-b', cwd: '/workspace/other' };
      assert.deepEqual(await h.drafts.start(originalRoomId, edited), { status: 'accepted', roomId: rejected.roomId });
      assert.deepEqual(
        h.calls.map(call => call.id),
        originalRoomId === undefined
          ? ['room.prepare', 'task.start', 'task.start']
          : ['task.start', 'task.start'],
      );
      const retried = h.calls.at(-1).arguments;
      assert.equal(retried.roomId, rejected.roomId);
      assert.notEqual(retried.operationId, rejected.operationId);
      assert.equal(retried.text, edited.text);
      assert.equal(retried.to, edited.to);
      assert.equal(retried.cwd, edited.cwd);
      assert.equal(h.rooms.size, 1);
      assert.deepEqual(h.rooms.get(rejected.roomId), prepared);
    }
  }
});

test('an unavailable prepare result retains the same draft even when no runId is returned', async () => {
  let attempts = 0;
  const h = harness({
    prepare: async (args, prepareRoom) => {
      const accepted = prepareRoom(args);
      return ++attempts === 1 ? { status: 'rejected', code: 'unavailable' } : accepted;
    },
  });
  assert.deepEqual(await h.drafts.start(undefined, input), { status: 'unavailable', code: 'pending' });
  assert.deepEqual(await h.drafts.start(undefined, { ...input, text: 'Changed' }), {
    status: 'unavailable',
    code: 'pending',
  });
  assert.equal(h.calls.length, 1);
  const result = await h.drafts.start(undefined, input);
  assert.equal(result.status, 'accepted');
  assert.equal(result.roomId, h.calls[0].arguments.roomId);
  assert.deepEqual(h.calls[1].arguments, h.calls[0].arguments);
  assert.equal(h.rooms.size, 1);
});

test('a definite permission denial remains visible without changing the retained operation or payload', async () => {
  const h = harness({
    initial: [room()],
    start: args => ({
      status: 'unavailable',
      code: 'permission-denied',
      roomId: args.roomId,
      operationId: args.operationId,
      runId: 'retained-run',
    }),
  });
  assert.deepEqual(await h.drafts.start('existing', input), {
    status: 'unavailable',
    code: 'pending',
    reason: 'permission-denied',
  });
  await h.drafts.start('existing', input);
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.deepEqual(await h.drafts.start('existing', { ...input, text: 'different' }), {
    status: 'unavailable',
    code: 'pending',
  });
  assert.equal(h.calls.length, 2);
});

test('missing bound project context fails before creating a Room or task and never invents a cwd', async () => {
  const h = harness();
  assert.deepEqual(await h.drafts.start(undefined, { text: 'hello', to: 'lead-a' }), {
    status: 'unavailable',
    code: 'failed',
    reason: 'context-required',
  });
  assert.deepEqual(h.calls, []);
  assert.equal(h.rooms.size, 0);
});
