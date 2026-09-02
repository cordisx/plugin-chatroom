import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { ChatroomAgentSessionController } from '../dist/agent-session-controller.js';
import {
  addRoomRun,
  bindRoomRun,
  bindRoomRunSession,
  createRoom,
  recordRoomSessionSelfIntroduction,
} from '../dist/room.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';

const owner = Object.freeze({ pluginId: 'chatroom', generation: 7 });

const admission = (messageId, status = 'accepted', code) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
  contract: 'cordisx.agent-admission/v1', schemaVersion: 1, status, messageId,
  ...(code === undefined ? {} : { code }),
});

const mutation = operation => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json',
  contract: 'cordisx.agent-mutation-result/v1', schemaVersion: 1, operation, status: 'accepted',
});

const discarded = messageId => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
  contract: 'cordisx.agent-message-cancellation-result/v1', schemaVersion: 1,
  status: 'accepted', messageId,
});

const acquire = (operation, handle, disposition) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json',
  contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1,
  operation, status: 'accepted', sessionId: handle.agent.session.id,
  agentGeneration: handle.agent.generation,
  sessionGeneration: handle.agent.session.generation,
  owner,
  sessionIdSource: 'host',
  disposition,
  handle,
});

const userEvent = (sessionId, seq, id, text) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1,
  sessionId, seq, time: 1_000 + seq, type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
});

const messageEvent = (sessionId, seq, message, sourceEventSeqs) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1,
  sessionId, seq, time: 1_000 + seq, type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
  data: message.role === 'assistant' ? { turn: 1, step: 1, message } : message,
  ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
});

class FakeSession {
  observers = [];
  unsubscribeCount = 0;

  constructor(id, replay = []) {
    this.id = id;
    this.generation = 1;
    this.header = { id, formatVersion: 1, createdAt: 1, isSeeded: false };
    this.replay = replay;
  }

  async snapshot() {
    return { status: 'available', snapshot: {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-snapshot.v1.schema.json',
      contract: 'cordisx.session-snapshot/v1', schemaVersion: 1,
      sessionId: this.id, sessionGeneration: this.generation, header: this.header,
      snapshotSeq: this.replay.at(-1)?.seq ?? -1,
    } };
  }

  async read() { throw new Error('Controller must use atomic Session.subscribe.'); }

  async subscribe(request, observer) {
    assert.deepEqual(request, { afterSeq: -1, pageSize: 256 });
    let resolveClosed;
    const record = {
      observer,
      closed: false,
      closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
      resolveClosed,
    };
    this.observers.push(record);
    if (this.replay.length > 0) await observer(this.page('replay', this.replay));
    const subscription = {
      sessionId: this.id,
      sessionGeneration: this.generation,
      subscriptionGeneration: 1,
      replayThrough: this.replay.at(-1)?.seq ?? -1,
      closed: record.closedPromise,
      unsubscribe: async () => {
        this.unsubscribeCount += 1;
        return this.finish(record, 'unsubscribed');
      },
    };
    return { status: 'subscribed', subscription };
  }

  async emitLive(events) {
    for (const record of this.observers) {
      if (!record.closed) await record.observer(this.page('live', events));
    }
  }

  async close(code) {
    for (const record of this.observers) this.finish(record, code);
    await Promise.resolve();
  }

  finish(record, code) {
    if (record.terminal !== undefined) return record.terminal;
    record.closed = true;
    record.terminal = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-close.v1.schema.json',
      contract: 'cordisx.session-subscription-close/v1', schemaVersion: 1,
      sessionId: this.id, sessionGeneration: this.generation, subscriptionGeneration: 1,
      status: 'closed', code,
    };
    record.resolveClosed(record.terminal);
    return record.terminal;
  }

  page(phase, events) {
    return {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json',
      contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1,
      sessionId: this.id,
      sessionGeneration: this.generation,
      subscriptionGeneration: 1,
      replayThrough: this.replay.at(-1)?.seq ?? -1,
      phase,
      events,
    };
  }
}

function fakeHandle(session, admissions = []) {
  const calls = { messages: [], discarded: [], cancelled: [], disposed: 0 };
  const nextAdmission = message => {
    const queued = admissions.shift();
    return queued === undefined ? admission(message.id) : { ...queued, messageId: message.id };
  };
  const agent = {
    id: session.id,
    generation: 1,
    options: {},
    session,
    inbox: { nextTurn: [], nextStep: [] },
    status: { status: 'available', value: 'idle' },
    send: async (message, target, wakeup) => {
      calls.messages.push({ method: 'send', message, target, wakeup });
      return nextAdmission(message);
    },
    followup: async message => {
      calls.messages.push({ method: 'followup', message });
      return nextAdmission(message);
    },
    steer: async message => {
      calls.messages.push({ method: 'steer', message });
      return nextAdmission(message);
    },
    inject: async message => {
      calls.messages.push({ method: 'inject', message });
      return nextAdmission(message);
    },
    discard: async messageId => {
      calls.discarded.push(messageId);
      return discarded(messageId);
    },
    cancel: async (cause, options) => {
      calls.cancelled.push({ cause, options });
      return mutation('cancel');
    },
    whenIdle: async () => ({ status: 'idle' }),
    subscribe: async () => ({ status: 'unavailable', code: 'unsupported' }),
  };
  const handle = {
    agent,
    owner,
    dispose: async () => {
      calls.disposed += 1;
      return mutation('dispose');
    },
  };
  return { handle, calls };
}

class FakeApprovals {
  answerers = new Map();
  facts = [];

  async registerAnswerer(agent, answerer) {
    this.answerers.set(agent.id, { agent, answerer });
    return {
      agentId: agent.id,
      agentGeneration: agent.generation,
      dispose: async () => ({ status: 'closed', code: 'disposed' }),
    };
  }

  async request(request) {
    const registered = this.answerers.get(request.agent.id);
    const question = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v1.schema.json',
      contract: 'cordisx.approval-question/v1', schemaVersion: 1,
      id: 'approval-1', agentId: request.agent.id, sessionId: request.agent.session.id,
      agentGeneration: request.agent.generation, toolName: request.toolName, reason: request.reason,
    };
    this.facts.push({ type: 'approval/asked', sessionId: question.sessionId, id: question.id });
    const outcome = registered === undefined ? 'unavailable' : await registered.answerer(question);
    this.facts.push({ type: 'approval/decided', sessionId: question.sessionId, id: question.id, outcome });
    return { ...question, outcome };
  }
}

function roomWithRun(sessionId) {
  let room = createRoom({ id: 'room', title: 'Room' });
  room = addRoomRun(room, {
    runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating',
  });
  return sessionId === undefined ? room : bindRoomRunSession(room, 'review-run', sessionId);
}

function runtimeHarness({ room = roomWithRun(), createAdmissions = [], resumeAdmissions = [] } = {}) {
  const sessions = new Map();
  for (const run of room.runs) {
    if (run.sessionId !== undefined) sessions.set(run.sessionId, new FakeSession(run.sessionId));
  }
  const creates = [];
  const resumes = [];
  const handles = [];
  const agents = {
    create: async options => {
      creates.push(options);
      const session = new FakeSession(`session-created-${creates.length}`);
      sessions.set(session.id, session);
      const pair = fakeHandle(session, [...createAdmissions]);
      handles.push(pair);
      return acquire('create', pair.handle, 'created');
    },
    resume: async options => {
      resumes.push(options);
      const session = sessions.get(options.sessionId) ?? new FakeSession(options.sessionId);
      sessions.set(session.id, session);
      const pair = fakeHandle(session, [...resumeAdmissions]);
      handles.push(pair);
      return acquire('resume', pair.handle, resumes.length === 1 ? 'resumed' : 'replayed');
    },
    get: async id => handles.find(pair => pair.handle.agent.id === id)?.handle.agent,
  };
  const approvals = new FakeApprovals();
  return {
    sessions, creates, resumes, handles, agents, approvals,
    sessionRegistry: { get: async id => sessions.get(id) },
  };
}

test('observer hydration replays then streams live with zero Room transactions or Agent acquisition', async () => {
  const room = roomWithRun('session-existing');
  const harness = runtimeHarness({ room });
  harness.sessions.get('session-existing').replay = [
    userEvent('session-existing', 0, 'replay-message', 'Replay'),
  ];
  const value = { contract: 'cordisx.chatroom-room-registry/v1', rooms: [room] };
  const before = JSON.stringify(value);
  let transactions = 0;
  const store = await DurableChatroomRoomStore.openOwnerDocuments({
    async load() {
      return { status: 'loaded', snapshot: {
        contract: 'cordisx.owner-documents/v1', documentId: 'room-registry',
        revision: 4, schemaVersion: 1, value,
      } };
    },
    async transaction() {
      transactions += 1;
      throw new Error('observer hydration must not transact');
    },
    subscribe() { return () => {}; },
  });
  const observations = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    observation => { observations.push(observation); },
  );

  await controller.hydrate();
  await harness.sessions.get('session-existing').emitLive([
    userEvent('session-existing', 1, 'live-message', 'Live'),
  ]);

  assert.equal(transactions, 0);
  assert.equal(JSON.stringify(value), before);
  assert.equal(harness.creates.length, 0);
  assert.equal(harness.resumes.length, 0);
  assert.equal(controller.ownerHandleCount, 0);
  assert.deepEqual(observations.map(item => [item.page.phase, item.page.events[0].seq]), [
    ['replay', 0], ['live', 1],
  ]);
  await controller.dispose();
  store.dispose();
});

test('first explicit mutation creates once, persists only SessionId, and retains owner authority in memory', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  const first = await controller.sendToRoom('room', 'review-run', 'user-1', 'First');
  const second = await controller.sendToRoom('room', 'review-run', 'user-2', 'Second', 'steer');
  const persisted = store.rooms.get('room').runs[0];

  assert.equal(first.status, 'accepted');
  assert.equal(first.disposition, 'created');
  assert.equal(second.status, 'accepted');
  assert.equal(second.disposition, 'retained');
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.resumes.length, 0);
  assert.equal(harness.creates[0].sessionId, undefined, 'Host mints a new SessionId');
  assert.equal(persisted.sessionId, 'session-created-1');
  assert.equal(persisted.taskBinding, undefined);
  assert.equal(persisted.detailsUrl, undefined);
  assert.equal(persisted.agentLoopCursor, undefined);
  assert.equal(persisted.publicProjections, undefined);
  assert.equal(controller.ownerHandleCount, 1);
  assert.deepEqual(harness.handles[0].calls.messages.map(call => call.method), [
    'followup', 'followup', 'steer',
  ]);
  assert.equal(harness.handles[0].calls.messages[0].message.source.correlation.namespace,
    'chatroom.member-self-introduction');
  assert.deepEqual(harness.handles[0].calls.messages[1].message.source.correlation, {
    namespace: 'chatroom.room-message', id: 'user-1',
  });
  await controller.dispose();
  store.dispose();
});

test('controller emits Shell v4 projection from the same replay-to-live Session stream', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const observations = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    observation => { observations.push(observation); },
  );

  await controller.sendToRoom('room', 'review-run', 'user-1', 'Please review');
  const introduction = harness.handles[0].calls.messages[0].message;
  await harness.sessions.get('session-created-1').emitLive([
    messageEvent('session-created-1', 0, introduction),
    messageEvent('session-created-1', 1, {
      id: 'assistant-introduction', role: 'assistant', content: [{ type: 'text', text: 'I review changes.' }],
      source: { kind: 'model', provider: 'provider', model: 'model' },
    }, [0]),
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].page.phase, 'live');
  assert.equal(observations[0].projection.phase, 'live');
  assert.equal(observations[0].projection.changes.length, 1);
  assert.deepEqual(observations[0].projection.changes[0].item.source, {
    kind: 'session-event', sessionId: 'session-created-1', eventSeq: 1,
  });
  assert.deepEqual(observations[0].projection.changes[0].item.semantic.correlation, {
    sessionId: 'session-created-1', requestMessageId: introduction.id,
  });
  await controller.dispose();
  store.dispose();
});

test('Session binding atomically retires the same run AgentLoop identity instead of keeping dual truth', () => {
  let room = roomWithRun();
  room = bindRoomRun(room, 'review-run', {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
    contract: 'cordisx.agent-loop-task-binding/v4', schemaVersion: 4,
    binding: { bindingId: 'legacy-binding', generation: 1 },
    definition: room.memberships.find(member => member.memberId === 'reviewer').definition,
    task: 'legacy-task', state: 'active',
  });

  const migrated = bindRoomRunSession(room, 'review-run', 'session-one');
  const persisted = JSON.parse(JSON.stringify(migrated.runs[0]));

  assert.equal(persisted.sessionId, 'session-one');
  assert.equal(persisted.presence.state, 'ready');
  assert.equal('taskBinding' in persisted, false);
  assert.equal('detailsUrl' in persisted, false);
  assert.equal('rebind' in persisted, false);
  assert.equal('agentLoopCursor' in persisted, false);
  assert.equal('publicProjections' in persisted, false);
});

test('observer hydration stays read-only until the first explicit mutation resumes its Session', async () => {
  const room = roomWithRun('session-existing');
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  await controller.hydrate();
  assert.equal(controller.ownerHandleCount, 0);
  const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Resume');

  assert.equal(result.status, 'accepted');
  assert.equal(result.disposition, 'resumed');
  assert.equal(harness.creates.length, 0);
  assert.deepEqual(harness.resumes.map(item => item.sessionId), ['session-existing']);
  assert.equal(controller.ownerHandleCount, 1);
  await controller.dispose();
  store.dispose();
});

test('SessionEvent replay prevents a persisted self-introduction correlation from being resubmitted', async () => {
  let room = roomWithRun('session-existing');
  room = recordRoomSessionSelfIntroduction(room, 'review-run', {
    requestMessageId: 'intro-message', correlationId: 'intro-correlation',
    requestedAt: '2026-09-03T00:00:00.000Z',
  });
  const harness = runtimeHarness({ room });
  harness.sessions.get('session-existing').replay = [{
    ...userEvent('session-existing', 0, 'intro-message', 'Introduce'),
    data: {
      id: 'intro-message', role: 'user', content: [{ type: 'text', text: 'Introduce' }],
      source: {
        kind: 'plugin', pluginId: 'chatroom', generation: 6, form: 'instructions',
        correlation: { namespace: 'chatroom.member-self-introduction', id: 'intro-correlation' },
      },
    },
  }];
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  await controller.hydrate();
  const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Continue');

  assert.equal(result.status, 'accepted');
  assert.deepEqual(harness.handles[0].calls.messages.map(call => call.message.id), [
    'room-session-message.6.user-1.10.review-run',
  ]);
  await controller.dispose();
  store.dispose();
});

test('two Room runs acquire isolated Sessions and owner handles without persisting either handle', async () => {
  let room = createRoom({ id: 'room', title: 'Room' });
  room = addRoomRun(room, {
    runId: 'lead-run', memberId: 'leader', title: 'Leader', status: 'creating',
  });
  room = addRoomRun(room, {
    runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating',
  });
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  await Promise.all([
    controller.sendToRoom('room', 'lead-run', 'user-1', 'Lead'),
    controller.sendToRoom('room', 'review-run', 'user-1', 'Review'),
  ]);
  const persisted = store.rooms.get('room');

  assert.equal(new Set(persisted.runs.map(run => run.sessionId)).size, 2);
  assert.equal(controller.ownerHandleCount, 2);
  assert.doesNotMatch(JSON.stringify(persisted), /owner|handle|subscription/i);
  await controller.dispose();
  store.dispose();
});

test('self introduction remains Chatroom orchestration and pending cancellation discards only its MessageId', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  const requested = await controller.requestMemberSelfIntroduction('room', 'review-run');
  const cancelled = await controller.cancelMemberSelfIntroduction('room', 'review-run');
  const message = harness.handles[0].calls.messages[0].message;

  assert.equal(requested.status, 'accepted');
  assert.equal(message.source.correlation.namespace, 'chatroom.member-self-introduction');
  assert.match(message.content[0].text, /Introduce yourself to this Chatroom Room as Reviewer/);
  assert.equal(cancelled.status, 'accepted');
  assert.deepEqual(harness.handles[0].calls.discarded, [requested.messageId]);
  assert.equal(store.rooms.get('room').runs[0].sessionSelfIntroduction.requestMessageId,
    requested.messageId);
  await controller.dispose();
  store.dispose();
});

test('replacement drops process-local ownership and the next explicit mutation resumes', async () => {
  const room = roomWithRun();
  const unavailable = admission('placeholder', 'unavailable', 'agent-replaced');
  const harness = runtimeHarness({ room, createAdmissions: [admission('intro'), unavailable] });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  const first = await controller.sendToRoom('room', 'review-run', 'user-1', 'Replace');
  const second = await controller.sendToRoom('room', 'review-run', 'user-2', 'Recover');

  assert.equal(first.status, 'unavailable');
  assert.equal(first.code, 'agent-replaced');
  assert.equal(second.status, 'accepted');
  assert.equal(second.disposition, 'resumed');
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.resumes.length, 1);
  await controller.dispose();
  store.dispose();
});

test('approval answerer follows reports-to hierarchy while ctx.approvals owns Session facts', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const policies = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    () => {},
    context => {
      policies.push(context);
      return 'allowed-once';
    },
  );

  await controller.sendToRoom('room', 'review-run', 'user-1', 'Needs approval');
  const agent = harness.handles[0].handle.agent;
  const decision = await harness.approvals.request({
    agent, toolName: 'shell', reason: 'Run command',
  });

  assert.equal(decision.outcome, 'allowed-once');
  assert.deepEqual(policies[0].authorityMemberIds, ['leader']);
  assert.deepEqual(harness.approvals.facts, [
    { type: 'approval/asked', sessionId: agent.session.id, id: 'approval-1' },
    { type: 'approval/decided', sessionId: agent.session.id, id: 'approval-1', outcome: 'allowed-once' },
  ]);
  assert.equal(store.rooms.get('room').approvalDecisions.length, 0);
  await controller.dispose();
  store.dispose();
});

test('dispose closes every Session subscription, answerer, and in-memory owner handle', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.sendToRoom('room', 'review-run', 'user-1', 'Dispose');
  const session = harness.handles[0].handle.agent.session;

  await controller.dispose();

  assert.equal(session.unsubscribeCount, 1);
  assert.equal(harness.handles[0].calls.disposed, 1);
  assert.equal(controller.ownerHandleCount, 0);
  store.dispose();
});
