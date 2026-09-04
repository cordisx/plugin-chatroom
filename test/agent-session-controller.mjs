import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { ChatroomAgentSessionController } from '../dist/agent-session-controller.js';
import { ChatroomAgentSessionConversationSource } from '../dist/agent-session-conversation-source.js';
import { CHATROOM_COMMAND_SUBMIT } from '../dist/conversation-model.js';
import { ChatroomConversationController } from '../dist/conversation-source.js';
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

const sessionEvent = (sessionId, seq, type, data, extra = {}) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1,
  sessionId, seq, time: 1_000 + seq, type, data, ...extra,
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
  authorityAnswerers = new Map();
  requestResolvers = new Map();
  facts = [];

  async registerAnswerer(agent, answerer) {
    this.answerers.set(agent.id, { agent, answerer });
    return {
      agentId: agent.id,
      agentGeneration: agent.generation,
      dispose: async () => ({ status: 'closed', code: 'disposed' }),
    };
  }

  async registerAuthorityAnswerer(authority, answerer) {
    this.authorityAnswerers.set(authority.agent.id, { authority, answerer });
    return {
      authority: {
        agentId: authority.agent.id,
        sessionId: authority.agent.session.id,
        agentGeneration: authority.agent.generation,
        definition: authority.definition,
      },
      dispose: async () => ({ status: 'closed', code: 'disposed' }),
    };
  }

  async registerRequestResolver(requester, resolver) {
    const registration = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-registration.v1.schema.json',
      contract: 'cordisx.approval-request-routing-registration/v1', schemaVersion: 1,
      registrationId: `routing-${requester.agent.id}`,
      owner: { pluginId: 'chatroom', installationId: 'test', profileId: 'test', pluginGeneration: 'generation' },
      requester: {
        agentId: requester.agent.id, sessionId: requester.agent.session.id,
        agentGeneration: requester.agent.generation, definition: requester.definition,
      },
    };
    const entry = { requester, resolver, closed: false };
    this.requestResolvers.set(requester.agent.id, entry);
    return {
      status: 'registered',
      handle: {
        registration,
        closed: Promise.resolve({ ...registration, status: 'closed', code: 'disposed' }),
        dispose: async () => { entry.closed = true; return { ...registration, status: 'closed', code: 'disposed' }; },
      },
    };
  }

  async request(request) {
    if ('requester' in request) {
      const registered = this.authorityAnswerers.get(request.authority.agent.id);
      const id = `approval-v2-${this.facts.length + 1}`;
      const binding = target => ({
        agentId: target.agent.id,
        sessionId: target.agent.session.id,
        agentGeneration: target.agent.generation,
        definition: target.definition,
      });
      const question = {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v2.schema.json',
        contract: 'cordisx.approval-question/v2', schemaVersion: 2,
        id,
        requester: binding(request.requester),
        authority: binding(request.authority),
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        reason: request.reason,
      };
      const session = request.requester.agent.session;
      const start = session.replay.at(-1)?.seq + 1 || 0;
      await session.emitLive([
        sessionEvent(session.id, start, 'approval/authority-bound', {
          approvalId: id,
          requester: request.requester.definition,
          authority: request.authority.definition,
          reason: request.reason,
        }, { ignorable: true }),
        sessionEvent(session.id, start + 1, 'approval/asked', {
          id, toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          reason: request.reason.text,
        }),
      ]);
      const outcome = registered === undefined ? 'unavailable' : await registered.answerer(question);
      await session.emitLive([sessionEvent(session.id, start + 2, 'approval/decided', { id, outcome })]);
      return {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v2.schema.json',
        contract: 'cordisx.approval-decision/v2', schemaVersion: 2,
        id, requester: question.requester, authority: question.authority, outcome,
      };
    }
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
  const legacyAcquires = [];
  const handles = [];
  const sessionGets = [];
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
    acquireLegacyTaskBinding: async request => {
      legacyAcquires.push(request);
      const session = new FakeSession('session-legacy-exact');
      sessions.set(session.id, session);
      const pair = fakeHandle(session);
      handles.push(pair);
      return {
        $schema: request.$schema, contract: request.contract, schemaVersion: 1,
        mutationId: request.mutationId, status: 'accepted', sessionId: session.id,
        identitySource: 'agent-loop-authority',
        acquire: acquire('resume', pair.handle, 'resumed'),
      };
    },
    get: async id => handles.find(pair => pair.handle.agent.id === id)?.handle.agent,
  };
  const approvals = new FakeApprovals();
  return {
    sessions, creates, resumes, legacyAcquires, handles, sessionGets, agents, approvals,
    sessionRegistry: { get: async id => { sessionGets.push(id); return sessions.get(id); } },
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

test('Room source remount and process reload rebuild approval and success solely from durable SessionEvent replay', async () => {
  const sessionId = 'cx-session.reviewer-durable';
  const acknowledgement = {
    kind: 'message', itemId: 'delegation-ack', messageId: 'delegation-ack-message', sequence: 20,
    source: 'chatroom-acknowledgement',
    author: {
      participantId: 'leader', role: 'agent',
      displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
      agentIdentity: roomWithRun(sessionId).memberships.find(member => member.memberId === 'leader').definition,
    },
    semantic: { purpose: 'chatroom-acknowledgement' },
    body: [{ kind: 'text', text: {
      namespace: 'chatroom', key: 'delegation', fallback: '已向 @Reviewer 下发任务：验证审批恢复。',
    } }],
    reactions: [], timestamp: new Date(1_021).toISOString(),
    deliveryState: 'delivered', runState: 'idle', ariaLive: 'polite', actions: [],
  };
  const room = createRoom({
    ...roomWithRun(sessionId),
    participants: [
      { id: 'leader', name: 'Lead', kind: 'agent' },
      { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
    ],
    items: [acknowledgement],
    timelineSequence: acknowledgement.sequence,
  });
  const replay = Array.from({ length: 35 }, (_, seq) => sessionEvent(
    sessionId, seq, 'step/start', { turn: 1, step: seq + 1 },
  ));
  replay[20] = sessionEvent(sessionId, 20, 'user/message', {
    id: 'reviewer-task', role: 'user', content: [{ type: 'text', text: '验证审批恢复。' }],
    source: {
      kind: 'plugin', pluginId: 'chatroom', generation: 7, form: 'relay',
      correlation: { namespace: 'chatroom.agent-delegation', id: 'delegation-ack' },
    },
  });
  replay[22] = sessionEvent(sessionId, 22, 'approval/asked', {
    id: 'approval-reviewer', toolName: 'shell', reason: 'Reviewer needs permission',
  });
  replay[23] = sessionEvent(sessionId, 23, 'approval/decided', {
    id: 'approval-reviewer', outcome: 'allowed-once',
  });
  replay[31] = sessionEvent(sessionId, 31, 'assistant/message', {
    turn: 1, step: 31,
    message: {
      id: 'reviewer-success', role: 'assistant',
      content: [{ type: 'text', text: 'Reviewer success' }],
      source: { kind: 'model', provider: 'provider', model: 'model' },
    },
  }, { sourceEventSeqs: [20] });
  replay[34] = sessionEvent(sessionId, 34, 'turn/end', {
    turn: 1, reason: { kind: 'completed' },
  });

  const harness = runtimeHarness({ room });
  const session = harness.sessions.get(sessionId);
  session.replay = replay;
  const store = DurableChatroomRoomStore.memory([room]);
  const durableBefore = JSON.stringify(store.rooms.get('room'));
  const binding = {
    bindingId: 'binding-hydration', shell: 'agent-desktop', ownerGeneration: 'owner-hydration',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room' },
  };
  const domain = new ChatroomConversationController([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const mount = () => new ChatroomAgentSessionConversationSource(
    binding, domain.createSource(binding), controller, 'enter',
  );

  const firstSource = mount();
  const first = await firstSource.snapshot();
  const visible = first.items.map(item => [item.itemId, item.sequence]);
  const approval = first.items.find(item => item.kind === 'approval');
  const success = first.items.find(item => item.kind === 'message' && item.messageId === 'reviewer-success');
  assert.equal(approval.state, 'approved');
  assert.equal(approval.approvalId, 'approval-reviewer');
  assert.equal('agentGeneration' in approval, false,
    'completed cold replay never invents a process-local Agent generation');
  assert.deepEqual(approval.actions, []);
  assert.equal(success.body[0].text.fallback, 'Reviewer success');
  assert.deepEqual(success.source, { kind: 'session-event', sessionId, eventSeq: 31 });
  assert.deepEqual(first.items.map(item => item.itemId), [
    'delegation-ack', approval.itemId, success.itemId,
  ]);
  assert.equal(first.selection.activeRuns[0].lifecycle.phase, 'active');
  assert.equal(harness.creates.length, 0);
  assert.equal(harness.resumes.length, 0);
  assert.equal(controller.ownerHandleCount, 0,
    'Shell hydration never claims Agent mutation ownership');
  assert.equal(harness.handles.length, 0,
    'completed Session replay never reconstructs a live Agent handle');
  assert.equal(JSON.stringify(store.rooms.get('room')), durableBefore,
    'observer projection never writes replay facts to the Room document');
  firstSource.dispose();

  await session.close('permission-revoked');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller.projectionForRoom('room').items, [],
    'route replacement closes and removes only the process-local projector');

  const secondSource = mount();
  const [second, concurrent] = await Promise.all([secondSource.snapshot(), secondSource.snapshot()]);
  assert.deepEqual(second.items.map(item => [item.itemId, item.sequence]), visible);
  assert.deepEqual(concurrent.items.map(item => [item.itemId, item.sequence]), visible);
  assert.equal(session.observers.length, 2,
    'concurrent remount reads share one replay subscription');
  assert.deepEqual(harness.sessionGets, [sessionId, sessionId],
    'each mount resolves only the exact persisted RoomRun SessionId');
  assert.equal(new Set(second.items.map(item => item.itemId)).size, second.items.length);
  assert.equal(JSON.stringify(store.rooms.get('room')), durableBefore);

  const liveSuccess = sessionEvent(sessionId, 35, 'assistant/message', {
    turn: 2, step: 1,
    message: {
      id: 'reviewer-live-success', role: 'assistant',
      content: [{ type: 'text', text: 'Reviewer live success after remount' }],
      source: { kind: 'model', provider: 'provider', model: 'model' },
    },
  }, { sourceEventSeqs: [20] });
  await session.emitLive([liveSuccess]);
  session.replay.push(liveSuccess);
  await new Promise(resolve => setImmediate(resolve));
  const afterLive = await secondSource.snapshot();
  assert.equal(afterLive.items.filter(item => item.kind === 'message'
    && item.messageId === 'reviewer-live-success').length, 1,
    'the reopened replay subscription continues into live without duplicate projection');
  const durableReplayVisible = afterLive.items.map(item => [item.itemId, item.sequence]);
  secondSource.dispose();
  await controller.dispose();

  const reloadedController = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const reloadedSource = new ChatroomAgentSessionConversationSource(
    binding, domain.createSource(binding), reloadedController, 'enter',
  );
  const reloaded = await reloadedSource.snapshot();
  assert.deepEqual(reloaded.items.map(item => [item.itemId, item.sequence]), durableReplayVisible,
    'fresh process replay retains exact item identities and presentation coordinates');
  assert.equal(new Set(reloaded.items.map(item => item.itemId)).size, reloaded.items.length);
  const reloadedApproval = reloaded.items.find(item => item.kind === 'approval');
  assert.equal(reloadedApproval.state, 'approved');
  assert.equal('agentGeneration' in reloadedApproval, false);
  assert.deepEqual(reloadedApproval.actions, []);
  assert.equal(JSON.stringify(store.rooms.get('room')), durableBefore);

  reloadedSource.dispose();
  await reloadedController.dispose();
  domain.dispose();
  store.dispose();
});

test('a concurrent second run and permission replacement never publish a Room snapshot that drops the first run', async () => {
  const sessionAId = 'cx-session.pending-reviewer';
  const sessionBId = 'cx-session.followup-lead';
  const baseRoom = roomWithRun(sessionAId);
  const delegation = {
    kind: 'message', itemId: 'lead-delegation', messageId: 'lead-delegation', sequence: 20,
    source: 'chatroom-acknowledgement',
    author: {
      participantId: 'leader', role: 'agent',
      displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
      agentIdentity: baseRoom.memberships.find(member => member.memberId === 'leader').definition,
    },
    semantic: { purpose: 'chatroom-acknowledgement' },
    body: [{ kind: 'text', text: {
      namespace: 'chatroom', key: 'delegation', fallback: '已向 @Reviewer 下发任务：3。',
    } }],
    reactions: [], timestamp: new Date(1_002).toISOString(),
    deliveryState: 'delivered', runState: 'idle', ariaLive: 'polite', actions: [],
  };
  const initialRoom = createRoom({
    ...baseRoom, items: [delegation], timelineSequence: delegation.sequence,
  });
  const harness = runtimeHarness({ room: initialRoom });
  const store = DurableChatroomRoomStore.memory([initialRoom]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.sendToRoom('room', 'review-run', 'user-3', '3');
  const sessionA = harness.sessions.get(sessionAId);
  const eventsA = [
    sessionEvent(sessionAId, 0, 'turn/start', { turn: 1 }),
    sessionEvent(sessionAId, 1, 'user/message', {
      id: 'user-3', role: 'user', content: [{ type: 'text', text: '3' }], source: { kind: 'user' },
    }),
    sessionEvent(sessionAId, 2, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'reviewer-intro', role: 'assistant', content: [{ type: 'text', text: 'Reviewer introduction' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [1] }),
    sessionEvent(sessionAId, 3, 'approval/asked', {
      id: 'approval-a', toolName: 'shell', reason: 'Reviewer needs exact permission',
    }),
  ];
  await sessionA.emitLive(eventsA);

  const binding = {
    bindingId: 'binding-two-runs', shell: 'agent-desktop', ownerGeneration: 'owner-two-runs',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room' },
  };
  const domain = new ChatroomConversationController(store.rooms);
  const source = new ChatroomAgentSessionConversationSource(
    binding, domain.createSource(binding), controller, 'enter',
  );
  const before = await source.snapshot();
  const pending = before.items.find(item => item.kind === 'approval');
  assert.equal(pending.state, 'pending');
  const stableA = before.items.map(item => [item.itemId, item.sequence]);
  const subscription = await source.subscribe(before.snapshotSequence);
  assert.equal(subscription.result.status, 'accepted');
  const pages = subscription.handle.pages[Symbol.asyncIterator]();

  const sessionB = new FakeSession(sessionBId, [
    sessionEvent(sessionBId, 0, 'turn/start', { turn: 1 }),
    sessionEvent(sessionBId, 1, 'user/message', {
      id: 'user-1', role: 'user', content: [{ type: 'text', text: '1' }], source: { kind: 'user' },
    }),
    sessionEvent(sessionBId, 2, 'assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'lead-reply', role: 'assistant', content: [{ type: 'text', text: 'Lead reply' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [1] }),
  ]);
  harness.sessions.set(sessionBId, sessionB);
  let releaseSessionB;
  const sessionBBlocked = new Promise(resolve => { releaseSessionB = resolve; });
  let markSessionBRequested;
  const sessionBRequested = new Promise(resolve => { markSessionBRequested = resolve; });
  const originalGet = harness.sessionRegistry.get;
  harness.sessionRegistry.get = async id => {
    if (id === sessionBId) {
      markSessionBRequested();
      await sessionBBlocked;
    }
    return await originalGet(id);
  };
  const withRunB = bindRoomRunSession(addRoomRun(store.rooms.get('room'), {
    runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating',
  }), 'lead-run', sessionBId);
  await store.upsert(withRunB);
  const durableAfterRunB = JSON.stringify(store.rooms.get('room'));
  await sessionBRequested;

  // Model a Host permission replacement at the vulnerable point: refresh has
  // already accepted the new Room document and skipped active run A, but is
  // still awaiting run B. The durable decision lands before exact replay.
  sessionA.replay = [...eventsA, sessionEvent(sessionAId, 4, 'approval/decided', {
    id: 'approval-a', outcome: 'rejected',
  })];
  harness.agents.get = async () => undefined;
  await sessionA.close('permission-revoked');
  releaseSessionB();

  const page = (await pages.next()).value;
  const visible = page.updates[0].snapshot.items;
  const replayedApproval = visible.find(item => item.itemId === pending.itemId);
  assert.equal(replayedApproval.state, 'denied');
  assert.deepEqual(replayedApproval.actions, []);
  assert.equal('agentGeneration' in replayedApproval, false);
  assert.deepEqual(visible.slice(0, stableA.length).map(item => [item.itemId, item.sequence]), stableA);
  assert.equal(visible.some(item => item.kind === 'message' && item.messageId === 'lead-reply'), true);
  assert.equal(new Set(visible.map(item => item.itemId)).size, visible.length);
  assert.equal(store.rooms.get('room').items.some(item => item.itemId === pending.itemId), false,
    'Session approval projection is never copied into the durable Room document');
  assert.equal(JSON.stringify(store.rooms.get('room')), durableAfterRunB,
    'observer refresh never writes a denied approval or Session message into the Room document');
  assert.equal(controller.isRunLocallyUnavailable('room', 'review-run'), false);

  await subscription.handle.unsubscribe();
  source.dispose();
  await controller.dispose();

  const coldHarness = runtimeHarness({ room: store.rooms.get('room') });
  coldHarness.sessions.get(sessionAId).replay = sessionA.replay;
  coldHarness.sessions.get(sessionBId).replay = sessionB.replay;
  const coldController = new ChatroomAgentSessionController(
    { agents: coldHarness.agents, sessions: coldHarness.sessionRegistry, approvals: coldHarness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const coldSource = new ChatroomAgentSessionConversationSource(
    binding, domain.createSource(binding), coldController, 'enter',
  );
  const cold = await coldSource.snapshot();
  assert.deepEqual(cold.items.map(item => [item.itemId, item.sequence]),
    visible.map(item => [item.itemId, item.sequence]),
    'fresh controller replay restores every A/B item once in the same presentation order');
  const coldApprovals = cold.items.filter(item => item.kind === 'approval');
  assert.equal(coldApprovals.length, 1);
  assert.equal(coldApprovals[0].itemId, pending.itemId);
  assert.equal(coldApprovals[0].state, 'denied');
  assert.deepEqual(coldApprovals[0].actions, []);
  assert.equal(JSON.stringify(store.rooms.get('room')), durableAfterRunB);

  coldSource.dispose();
  await coldController.dispose();
  domain.dispose();
  store.dispose();
});

test('dispose fences an in-flight Room replay demand before subscription publication', async () => {
  const room = roomWithRun('session-delayed-hydration');
  const session = new FakeSession('session-delayed-hydration', [
    userEvent('session-delayed-hydration', 0, 'delayed-message', 'Delayed'),
  ]);
  let release;
  const pendingSession = new Promise(resolve => { release = resolve; });
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    {
      agents: harness.agents,
      sessions: { get: async id => {
        assert.equal(id, 'session-delayed-hydration');
        return await pendingSession;
      } },
      approvals: harness.approvals,
    },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  const hydration = controller.hydrateRoom('room');
  await Promise.resolve();
  const disposing = controller.dispose();
  release(session);
  await Promise.all([hydration, disposing]);

  assert.equal(session.observers.length, 0);
  assert.deepEqual(controller.projectionForRoom('room').items, []);
  assert.equal(JSON.stringify(store.rooms.get('room')), JSON.stringify(room));
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
  assert.deepEqual(harness.creates[0].definition,
    room.memberships.find(member => member.memberId === 'reviewer').definition);
  assert.equal('setup' in harness.creates[0], false);
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

test('Shell v8 admission acquires the exact owner then reserves its matching Room member run without a direct Agent send', async () => {
  const room = roomWithRun();
  const member = room.memberships.find(candidate => candidate.memberId === 'reviewer');
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const origin = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
    contract: 'cordisx.agent-command-origin/v1', schemaVersion: 1,
    originId: 'origin-v8', binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
    generation: 'shell-v8', executionId: 'execution-v8', commandId: CHATROOM_COMMAND_SUBMIT,
    scope: 'composer-submit',
    room: { roomId: room.id, participantId: member.participantId, memberId: member.memberId, runId: 'review-run' },
  };
  let reserved;
  const reservations = {
    reserve: async request => {
      reserved = request;
      return {
        status: 'reserved',
        reservation: {
          reservationId: 'reservation-v8',
          submit: async () => admission('host-v8-message'),
          revoke: async () => {},
        },
      };
    },
  };

  const result = await controller.submitToRoomViaAdmissionV2(
    room.id, 'review-run', origin, 'Review the exact v8 dispatch.', reservations,
  );

  assert.equal(result.status, 'accepted');
  assert.equal(result.messageId, 'host-v8-message');
  assert.equal(result.disposition, 'created');
  assert.equal(harness.creates.length, 1);
  assert.equal(reserved.handle, harness.handles[0].handle, 'reserve receives the acquired exact owner handle');
  assert.deepEqual(reserved.origin, origin);
  assert.deepEqual(reserved.message, { text: 'Review the exact v8 dispatch.' });
  assert.deepEqual(harness.handles[0].calls.messages, [], 'v8 admission never falls through to Agent direct dispatch');
  await controller.dispose();
  store.dispose();
});

test('explicit mention stays in the durable Room display while Agent admission receives stripped dispatch text', async () => {
  const domain = new ChatroomConversationController();
  domain.rooms.upsert(createRoom({ id: 'room', title: 'Room' }));
  domain.createSource({
    bindingId: 'binding-display', shell: 'agent-desktop', ownerGeneration: 'owner-1',
    routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room' },
  });
  const intent = domain.handle({
    binding: { bindingId: 'binding-display', ownerGeneration: 'owner-1' }, generation: 'owner-1',
    scope: 'composer-submit', command: { id: CHATROOM_COMMAND_SUBMIT },
    submitPayload: '@Reviewer 请回复：显式路由成功。',
  });
  assert.equal(intent.kind, 'send-message');
  assert.deepEqual(intent.deliveries.map(delivery => delivery.memberId), ['reviewer']);
  assert.equal(intent.dispatchText, '请回复：显式路由成功。');
  const room = domain.rooms.get('room');
  assert.equal(room.items.find(item => item.itemId === intent.userItemId).body[0].text.fallback,
    '@Reviewer 请回复：显式路由成功。');

  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const observations = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
    observation => { observations.push(observation); },
  );
  await controller.sendToRoom(
    'room', intent.deliveries[0].runId, intent.userItemId, intent.dispatchText,
  );
  const [introduction, admitted] = harness.handles[0].calls.messages.map(call => call.message);
  assert.equal(admitted.content[0].text, '请回复：显式路由成功。');
  assert.deepEqual(admitted.source.correlation, {
    namespace: 'chatroom.room-message', id: intent.userItemId,
  });

  await harness.sessions.get('session-created-1').emitLive([
    messageEvent('session-created-1', 0, introduction),
    messageEvent('session-created-1', 1, {
      id: 'assistant-introduction', role: 'assistant',
      content: [{ type: 'text', text: 'I review changes.' }],
      source: { kind: 'model', provider: 'provider', model: 'model' },
    }, [0]),
    messageEvent('session-created-1', 2, admitted),
  ]);
  const display = observations[0].projection.changes
    .map(change => change.item)
    .find(item => item.kind === 'message' && item.messageId === admitted.id);
  assert.equal(display.body[0].text.fallback, '@Reviewer 请回复：显式路由成功。');
  assert.deepEqual(display.source, {
    kind: 'session-event', sessionId: 'session-created-1', eventSeq: 2,
  });
  await controller.dispose();
  store.dispose();
});

test('first explicit mutation migrates an exact legacy TaskBinding through Host authority', async () => {
  let room = roomWithRun();
  const binding = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
    contract: 'cordisx.agent-loop-task-binding/v4', schemaVersion: 4,
    binding: { bindingId: 'legacy-binding', generation: 3 },
    definition: room.memberships.find(member => member.memberId === 'reviewer').definition,
    task: 'opaque-legacy-task', state: 'active',
  };
  room = bindRoomRun(room, 'review-run', binding);
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Migrate');

  assert.equal(result.status, 'accepted');
  assert.equal(result.sessionId, 'session-legacy-exact');
  assert.equal(harness.creates.length, 0);
  assert.equal(harness.resumes.length, 0);
  assert.equal(harness.legacyAcquires.length, 1);
  assert.deepEqual(harness.legacyAcquires[0].binding, binding, 'TaskBinding remains opaque');
  assert.equal('setup' in harness.legacyAcquires[0], false,
    'legacy Session resumes its persisted definition binding');
  assert.equal(store.rooms.get('room').runs[0].sessionId, 'session-legacy-exact');
  assert.equal(store.rooms.get('room').runs[0].taskBinding, undefined);
  await controller.dispose();
  store.dispose();
});

test('controller emits Shell v6 projection from the same replay-to-live Session stream', async () => {
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
  assert.equal(harness.resumes[0].definitionSource, 'session-persisted');
  assert.equal('definition' in harness.resumes[0], false);
  assert.equal('setup' in harness.resumes[0], false);
  assert.equal(controller.ownerHandleCount, 1);
  await controller.dispose();
  store.dispose();
});

test('permission lease replacement keeps the durable Session resumable on explicit mutation', async () => {
  const room = roomWithRun('session-existing');
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );

  await controller.hydrate();
  await harness.sessions.get('session-existing').close('permission-revoked');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(controller.isRunLocallyUnavailable('room', 'review-run'), false);
  const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Resume');
  assert.equal(result.status, 'accepted');
  assert.equal(result.disposition, 'resumed');
  assert.deepEqual(harness.resumes.map(item => item.sessionId), ['session-existing']);
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

test('live Session assistant mentions preserve Reviewer to Integrator and Documentation to QA delegation', async t => {
  for (const [sourceMemberId, targetLabel] of [
    ['reviewer', 'Integrator'],
    ['documentation', 'QA'],
  ]) {
    await t.test(`${sourceMemberId} -> ${targetLabel}`, async () => {
      let room = createRoom({ id: 'room', title: 'Room' });
      room = addRoomRun(room, {
        runId: 'source-run', memberId: sourceMemberId, title: sourceMemberId, status: 'creating',
      });
      const harness = runtimeHarness({ room });
      const store = DurableChatroomRoomStore.memory([room]);
      const controller = new ChatroomAgentSessionController(
        { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      await controller.sendToRoom('room', 'source-run', 'user-1', 'Coordinate');
      await harness.handles[0].handle.agent.session.emitLive([messageEvent(
        'session-created-1', 0,
        {
          id: `assistant-${sourceMemberId}`, role: 'assistant',
          content: [{ type: 'text', text: `@${targetLabel} Verify the handoff` }],
          source: { kind: 'model', provider: 'provider', model: 'model' },
        },
      )]);

      const targetRun = store.rooms.get('room').runs.find(run =>
        store.rooms.get('room').memberships.find(member => member.memberId === run.memberId)?.label === targetLabel);
      assert.ok(targetRun);
      const targetHandle = harness.handles.find(pair => pair.handle.agent.session.id === targetRun.sessionId);
      assert.deepEqual(targetHandle.calls.messages.map(call => call.message.source.correlation.namespace), [
        'chatroom.member-self-introduction', 'chatroom.agent-delegation',
      ]);
      assert.equal(targetHandle.calls.messages[1].message.content[0].text, 'Verify the handoff');
      await controller.dispose();
      store.dispose();
    });
  }
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

test('Shell approval action settles only the matching independent ctx.approvals question', async () => {
  const room = roomWithRun();
  const harness = runtimeHarness({ room });
  const store = DurableChatroomRoomStore.memory([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  await controller.sendToRoom('room', 'review-run', 'user-1', 'Needs approval');
  const agent = harness.handles[0].handle.agent;
  const decision = harness.approvals.request({ agent, toolName: 'shell', reason: 'Run command' });
  await new Promise(resolve => setImmediate(resolve));
  await agent.session.emitLive([{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
    contract: 'cordisx.session-event/v1', schemaVersion: 1,
    sessionId: agent.session.id, seq: 0, time: 1_000,
    type: 'approval/asked', data: { id: 'approval-1', toolName: 'shell', reason: 'Run command' },
  }]);
  const item = controller.projectionForRoom('room').items.find(candidate => candidate.kind === 'approval');

  assert.equal(item.state, 'pending');
  assert.equal(controller.answerApprovalItem('room', item.itemId, 'allowed-once'), true);
  assert.equal((await decision).outcome, 'allowed-once');
  assert.equal(store.rooms.get('room').approvalDecisions.length, 0);
  await controller.dispose();
  store.dispose();
});

test('approval v2 binds Reviewer requester to exact Lead authority and updates one v7 item in place', async () => {
  let room = createRoom({ id: 'room', title: 'Room' });
  room = addRoomRun(room, {
    runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating',
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

  const decision = controller.requestApproval(
    'room', 'review-run', 'shell', 'Reviewer needs permission to inspect the protected result.', 'call-review',
  );
  await new Promise(resolve => setImmediate(resolve));
  const pending = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');

  assert.ok(pending);
  assert.equal(pending.memberId, 'reviewer');
  assert.equal(pending.authority.memberId, 'leader');
  assert.equal(pending.reason.text, 'Reviewer needs permission to inspect the protected result.');
  assert.deepEqual(pending.actions.map(action => action.decision), ['approve', 'reject']);
  const stable = { itemId: pending.itemId, sequence: pending.sequence };
  const commandContext = {
    binding: { bindingId: 'binding', ownerGeneration: 'owner' },
    generation: 'shell-generation', scope: 'approval', itemId: pending.itemId,
    command: { id: 'chatroom.approval.deny' },
    approval: {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      requester: pending.requester,
      authority: pending.authorityBinding,
      decision: 'reject',
    },
  };
  assert.equal(controller.answerApprovalCommand('room', {
    ...commandContext,
    approval: { ...commandContext.approval, approvalId: 'foreign-approval' },
  }), false);
  assert.equal(controller.answerApprovalCommand('room', commandContext), true);
  assert.equal((await decision).decision.outcome, 'rejected');
  const denied = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');
  assert.deepEqual({ itemId: denied.itemId, sequence: denied.sequence }, stable);
  assert.equal(denied.state, 'denied');
  assert.deepEqual(denied.actions, []);
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
  assert.equal(harness.approvals.requestResolvers.get(session.id).closed, true);
  assert.equal(controller.ownerHandleCount, 0);
  store.dispose();
});
