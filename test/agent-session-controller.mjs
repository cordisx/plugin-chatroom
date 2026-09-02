import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { ChatroomAgentSessionController } from '../dist/agent-session-controller.js';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { InMemoryChatroomRoomStore } from '../dist/room-store.js';

const owner = Object.freeze({ pluginId: 'org.cordisx.chatroom', generation: 7 });

const admission = (messageId, status = 'accepted', code) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
  contract: 'cordisx.agent-admission/v1', schemaVersion: 1, status, messageId,
  ...(code === undefined ? {} : { code }),
});

const acquire = (operation, handle, disposition) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json',
  contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1,
  operation, status: 'accepted', sessionId: handle.agent.session.id,
  agentGeneration: handle.agent.generation, sessionGeneration: handle.agent.session.generation,
  owner, sessionIdSource: operation === 'create' ? 'host' : 'caller', disposition, handle,
});

const discardResult = (messageId, status = 'accepted', code) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
  contract: 'cordisx.agent-message-cancellation-result/v1', schemaVersion: 1,
  status, messageId, ...(code === undefined ? {} : { code }),
});

const mutationResult = operation => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json',
  contract: 'cordisx.agent-mutation-result/v1', schemaVersion: 1, operation, status: 'accepted',
});

const userEvent = (sessionId, seq, id, text) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1, sessionId, seq, time: seq + 1,
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
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

  async read() { throw new Error('Controller must use atomic Session.subscribe for hydration.'); }

  async subscribe(request, observer) {
    assert.equal(request.afterSeq, -1);
    let resolveClosed;
    const record = {
      observer,
      closed: false,
      closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
      resolveClosed,
    };
    this.observers.push(record);
    if (this.replay.length > 0) {
      await observer(this.page('replay', this.replay));
    }
    return { status: 'subscribed', subscription: {
      sessionId: this.id, sessionGeneration: this.generation,
      subscriptionGeneration: 1, replayThrough: this.replay.at(-1)?.seq ?? -1,
      closed: record.closedPromise,
      unsubscribe: async () => {
        this.unsubscribeCount += 1;
        return this.finish(record, 'unsubscribed');
      },
    } };
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
      sessionId: this.id, sessionGeneration: this.generation, subscriptionGeneration: 1,
      replayThrough: this.replay.at(-1)?.seq ?? -1, phase, events,
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
      return discardResult(messageId);
    },
    cancel: async (cause, options) => {
      calls.cancelled.push({ cause, options });
      return mutationResult('cancel');
    },
    whenIdle: async () => ({ status: 'idle' }),
    subscribe: async () => ({ status: 'unavailable', code: 'unsupported' }),
  };
  const handle = {
    agent,
    owner,
    dispose: async () => {
      calls.disposed += 1;
      return mutationResult('dispose');
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

function roomWithRun({ sessionId } = {}) {
  let room = createRoom({ id: 'room', title: 'Room', configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION });
  room = addRoomRun(room, { runId: 'review-run', memberId: 'reviewer', title: 'Review', status: 'creating' });
  return sessionId === undefined ? room : bindRoomRunSession(room, 'review-run', sessionId);
}

function runtimeHarness({ room = roomWithRun(), createAdmissions = [], resumeAdmissions = [] } = {}) {
  const sessions = new Map();
  if (room.runs[0]?.sessionId !== undefined) {
    sessions.set(room.runs[0].sessionId, new FakeSession(room.runs[0].sessionId));
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
  const sessionRegistry = { get: async id => sessions.get(id) };
  const approvals = new FakeApprovals();
  return { room, sessions, creates, resumes, handles, agents, sessionRegistry, approvals };
}

test('observer hydration replays then streams live without writing or claiming an Agent', async () => {
  const room = roomWithRun({ sessionId: 'session-existing' });
  const harness = runtimeHarness({ room });
  const session = harness.sessions.get('session-existing');
  session.replay = [userEvent(session.id, 0, 'replay-message', 'Replay')];
  const store = new InMemoryChatroomRoomStore([room]);
  const observations = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store, observation => observations.push(observation),
  );

  await controller.hydrate();
  await session.emitLive([userEvent(session.id, 1, 'live-message', 'Live')]);

  assert.equal(store.writes, 0);
  assert.equal(harness.creates.length, 0);
  assert.equal(harness.resumes.length, 0);
  assert.equal(controller.ownerHandleCount, 0);
  assert.deepEqual(observations.map(item => [item.page.phase, item.page.events[0].seq]), [
    ['replay', 0], ['live', 1],
  ]);
});

test('first explicit mutation creates once, persists only SessionId, then retains owner handle', async () => {
  const harness = runtimeHarness();
  const store = new InMemoryChatroomRoomStore([harness.room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );

  const first = await controller.sendToRun('room', 'review-run', 'user-1', 'First');
  const second = await controller.sendToRun('room', 'review-run', 'user-2', 'Second', 'steer');

  assert.equal(first.status, 'accepted');
  assert.equal(first.disposition, 'created');
  assert.equal(second.status, 'accepted');
  assert.equal(second.disposition, 'retained');
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.resumes.length, 0);
  assert.equal(store.get('room').runs[0].sessionId, 'session-created-1');
  assert.equal(harness.handles[0].calls.messages[0].method, 'followup');
  assert.equal(harness.handles[0].calls.messages[1].method, 'steer');
  assert.deepEqual(harness.handles[0].calls.messages[0].message.source.correlation, {
    namespace: 'chatroom.room-message', id: 'user-1',
  });
});

test('bare Agent get stays read-only while send, inject, and whole-Agent cancel use formal methods', async () => {
  const harness = runtimeHarness();
  const store = new InMemoryChatroomRoomStore([harness.room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  await controller.sendToRun('room', 'review-run', 'user-1', 'Send', 'send');
  const writesAfterCreate = store.writes;
  const observed = await controller.getObservedAgent('room', 'review-run');
  await controller.sendToRun('room', 'review-run', 'user-2', 'Inject', 'inject');
  const cancelled = await controller.cancelRun('room', 'review-run', { kind: 'user' });

  assert.equal(observed, harness.handles[0].handle.agent);
  assert.equal(store.writes, writesAfterCreate);
  assert.deepEqual(harness.handles[0].calls.messages.map(call => call.method), ['send', 'inject']);
  assert.deepEqual(harness.handles[0].calls.messages[0], {
    method: 'send', message: harness.handles[0].calls.messages[0].message,
    target: 'next-turn', wakeup: true,
  });
  assert.equal(cancelled.status, 'accepted');
  assert.deepEqual(harness.handles[0].calls.cancelled[0].cause, { kind: 'user' });
});

test('first explicit mutation after observer hydration resumes the authoritative Session', async () => {
  const room = roomWithRun({ sessionId: 'session-existing' });
  const harness = runtimeHarness({ room });
  const store = new InMemoryChatroomRoomStore([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  await controller.hydrate();
  const outcome = await controller.sendToRun('room', 'review-run', 'user-1', 'Resume');
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.disposition, 'resumed');
  assert.equal(harness.creates.length, 0);
  assert.equal(harness.resumes.length, 1);
  assert.equal(harness.resumes[0].sessionId, 'session-existing');
  assert.equal(store.writes, 0);
});

test('explicit mentions and delegation route to their member Agents without a delivery ledger', async () => {
  const room = createRoom({ id: 'room', title: 'Room', configuration: CHATROOM_DEFAULT_AGENT_CONFIGURATION });
  const harness = runtimeHarness({ room });
  const store = new InMemoryChatroomRoomStore([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  const result = await controller.dispatchMessage('room', 'user-1', '@reviewer Inspect', ['reviewer']);
  assert.equal(result.status, 'resolved');
  assert.equal(result.outcomes.length, 2);
  assert.equal(harness.creates.length, 2);
  assert.deepEqual(store.get('room').runs.map(run => run.memberId).sort(), ['leader', 'reviewer']);
  assert.equal(JSON.stringify(store.get('room')).includes('outbox'), false);
});

test('replacement drops process-local authority and the next explicit mutation resumes', async () => {
  const unavailable = admission('room-message.6.user-18.review-run', 'unavailable', 'agent-replaced');
  const harness = runtimeHarness({ createAdmissions: [unavailable] });
  const store = new InMemoryChatroomRoomStore([harness.room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  const first = await controller.sendToRun('room', 'review-run', 'user-1', 'Replace');
  const second = await controller.sendToRun('room', 'review-run', 'user-2', 'Recover');
  assert.equal(first.status, 'unavailable');
  assert.equal(first.code, 'agent-replaced');
  assert.equal(second.status, 'accepted');
  assert.equal(second.disposition, 'resumed');
  assert.equal(harness.creates.length, 1);
  assert.equal(harness.resumes.length, 1);
});

test('route replacement closes the subscription, drops authority, and requires a new explicit resume', async () => {
  const room = roomWithRun({ sessionId: 'session-existing' });
  const harness = runtimeHarness({ room });
  const store = new InMemoryChatroomRoomStore([room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  await controller.sendToRun('room', 'review-run', 'user-1', 'Own');
  assert.equal(controller.ownerHandleCount, 1);
  await harness.sessions.get('session-existing').close('route-replaced');
  await Promise.resolve();
  assert.equal(controller.ownerHandleCount, 0);
  const resumed = await controller.sendToRun('room', 'review-run', 'user-2', 'Resume route');
  assert.equal(resumed.status, 'accepted');
  assert.equal(harness.resumes.length, 2);
});

test('self-introduction is Chatroom orchestration and cancellation discards only its MessageId', async () => {
  const harness = runtimeHarness();
  const store = new InMemoryChatroomRoomStore([harness.room]);
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store,
  );
  const requested = await controller.requestMemberSelfIntroduction('room', 'review-run');
  const cancelled = await controller.cancelMemberSelfIntroduction('room', 'review-run');
  const message = harness.handles[0].calls.messages[0].message;

  assert.equal(requested.status, 'accepted');
  assert.equal(message.source.correlation.namespace, 'chatroom.member-self-introduction');
  assert.match(message.content[0].text, /Introduce yourself to this Chatroom Room as Reviewer/);
  assert.equal(cancelled.status, 'accepted');
  assert.deepEqual(harness.handles[0].calls.discarded, [requested.messageId]);
  assert.equal(store.get('room').runs[0].selfIntroduction.requestMessageId, requested.messageId);
});

test('approval answerer uses reports-to policy while the service owns same-Session facts', async () => {
  const harness = runtimeHarness();
  const store = new InMemoryChatroomRoomStore([harness.room]);
  const policyInputs = [];
  const controller = new ChatroomAgentSessionController(
    { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
    CHATROOM_DEFAULT_AGENT_CONFIGURATION, store, () => {}, context => {
      policyInputs.push(context);
      return 'allowed-once';
    },
  );
  await controller.sendToRun('room', 'review-run', 'user-1', 'Needs tool');
  const agent = harness.handles[0].handle.agent;
  const decision = await harness.approvals.request({ agent, toolName: 'shell', reason: 'Run command' });

  assert.equal(decision.outcome, 'allowed-once');
  assert.deepEqual(policyInputs[0].authorityMemberIds, ['leader']);
  assert.deepEqual(harness.approvals.facts, [
    { type: 'approval/asked', sessionId: agent.session.id, id: 'approval-1' },
    { type: 'approval/decided', sessionId: agent.session.id, id: 'approval-1', outcome: 'allowed-once' },
  ]);
  assert.equal(JSON.stringify(store.get('room')).includes('approval'), false);
});
