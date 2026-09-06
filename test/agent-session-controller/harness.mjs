import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../../dist/agent-definition.js';
import {
  assertChatroomAdmissionDeliveriesAccepted,
  ChatroomAgentSessionController,
} from '../../dist/agent-session-controller.js';
import { ChatroomAgentSessionConversationSource } from '../../dist/agent-session-conversation-source.js';
import { ChatroomAgentSessionConversationSourceV7 } from '../../dist/agent-session-conversation-source-v7.js';
import { CHATROOM_COMMAND_SUBMIT } from '../../dist/conversation-model.js';
import { ChatroomConversationController } from '../../dist/conversation-source.js';
import {
  addRoomRun,
  bindRoomRun,
  bindRoomRunSession,
  createRoom,
  recordRoomAdmissionMessageLink,
  recordRoomSessionSelfIntroduction,
} from '../../dist/room.js';
import { DurableChatroomRoomStore } from '../../dist/room-store.js';

const owner = Object.freeze({ pluginId: 'chatroom', generation: 7 });

const admission = (messageId, status = 'accepted', code) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json',
  contract: 'cordisx.agent-admission/v1',
  schemaVersion: 1,
  status,
  messageId,
  ...(code === undefined ? {} : { code }),
});

const mutation = operation => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json',
  contract: 'cordisx.agent-mutation-result/v1',
  schemaVersion: 1,
  operation,
  status: 'accepted',
});

const discarded = messageId => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
  contract: 'cordisx.agent-message-cancellation-result/v1',
  schemaVersion: 1,
  status: 'accepted',
  messageId,
});

const acquire = (operation, handle, disposition) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json',
  contract: 'cordisx.agent-acquire-result/v1',
  schemaVersion: 1,
  operation,
  status: 'accepted',
  sessionId: handle.agent.session.id,
  agentGeneration: handle.agent.generation,
  sessionGeneration: handle.agent.session.generation,
  owner,
  sessionIdSource: 'host',
  disposition,
  handle,
});

const userEvent = (sessionId, seq, id, text) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1',
  schemaVersion: 1,
  sessionId,
  seq,
  time: 1_000 + seq,
  type: 'user/message',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
});

const messageEvent = (sessionId, seq, message, sourceEventSeqs) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1',
  schemaVersion: 1,
  sessionId,
  seq,
  time: 1_000 + seq,
  type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
  data: message.role === 'assistant' ? { turn: 1, step: 1, message } : message,
  ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
});

const sessionEvent = (sessionId, seq, type, data, extra = {}) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1',
  schemaVersion: 1,
  sessionId,
  seq,
  time: 1_000 + seq,
  type,
  data,
  ...extra,
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
    return {
      status: 'available',
      snapshot: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-snapshot.v1.schema.json',
        contract: 'cordisx.session-snapshot/v1',
        schemaVersion: 1,
        sessionId: this.id,
        sessionGeneration: this.generation,
        header: this.header,
        snapshotSeq: this.replay.at(-1)?.seq ?? -1,
      },
    };
  }

  async read() {
    throw new Error('Controller must use atomic Session.subscribe.');
  }

  async subscribe(request, observer) {
    assert.deepEqual(request, { afterSeq: -1, pageSize: 256 });
    let resolveClosed;
    const record = {
      observer,
      closed: false,
      closedPromise: new Promise(resolve => {
        resolveClosed = resolve;
      }),
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
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-close.v1.schema.json',
      contract: 'cordisx.session-subscription-close/v1',
      schemaVersion: 1,
      sessionId: this.id,
      sessionGeneration: this.generation,
      subscriptionGeneration: 1,
      status: 'closed',
      code,
    };
    record.resolveClosed(record.terminal);
    return record.terminal;
  }

  page(phase, events) {
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json',
      contract: 'cordisx.session-subscription-page/v1',
      schemaVersion: 1,
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

  constructor({ resolverRegistrationResult } = {}) {
    this.resolverRegistrationResult = resolverRegistrationResult;
  }

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
    const result = this.resolverRegistrationResult?.(requester);
    if (result !== undefined) return result;
    const registration = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-registration.v1.schema.json',
      contract: 'cordisx.approval-request-routing-registration/v1',
      schemaVersion: 1,
      registrationId: `routing-${requester.agent.id}`,
      owner: { pluginId: 'chatroom', installationId: 'test', profileId: 'test', pluginGeneration: 'generation' },
      requester: {
        agentId: requester.agent.id,
        sessionId: requester.agent.session.id,
        agentGeneration: requester.agent.generation,
        definition: requester.definition,
      },
    };
    let resolveClosed;
    const closed = new Promise(resolve => {
      resolveClosed = resolve;
    });
    const entry = { requester, resolver, registration, closedCode: undefined, resolveClosed };
    this.requestResolvers.set(requester.agent.id, entry);
    return {
      status: 'registered',
      handle: {
        registration,
        closed,
        dispose: async () => {
          entry.closedCode ??= 'disposed';
          entry.resolveClosed({ ...registration, status: 'closed', code: entry.closedCode });
          return { ...registration, status: 'closed', code: entry.closedCode };
        },
      },
    };
  }

  async routeDriverApproval(agent, reason = 'Reviewer needs permission to inspect the exact diff.') {
    const entry = this.requestResolvers.get(agent.id);
    assert.ok(entry, 'the exact requester must register an approval resolver');
    return await entry.resolver({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-question.v1.schema.json',
      contract: 'cordisx.approval-request-routing-question/v1',
      schemaVersion: 1,
      routingId: `routing-${agent.id}`,
      registration: entry.registration,
      requester: entry.registration.requester,
      toolName: 'shell',
      callId: 'call-review',
      reason: { kind: 'plain-text', text: reason },
    }, new AbortController().signal);
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
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v2.schema.json',
        contract: 'cordisx.approval-question/v2',
        schemaVersion: 2,
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
          id,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          reason: request.reason.text,
        }),
      ]);
      const outcome = registered === undefined ? 'unavailable' : await registered.answerer(question);
      await session.emitLive([sessionEvent(session.id, start + 2, 'approval/decided', { id, outcome })]);
      return {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v2.schema.json',
        contract: 'cordisx.approval-decision/v2',
        schemaVersion: 2,
        id,
        requester: question.requester,
        authority: question.authority,
        outcome,
      };
    }
    const registered = this.answerers.get(request.agent.id);
    const question = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v1.schema.json',
      contract: 'cordisx.approval-question/v1',
      schemaVersion: 1,
      id: 'approval-1',
      agentId: request.agent.id,
      sessionId: request.agent.session.id,
      agentGeneration: request.agent.generation,
      toolName: request.toolName,
      reason: request.reason,
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
    runId: 'review-run',
    memberId: 'reviewer',
    title: 'Reviewer',
    status: 'creating',
  });
  return sessionId === undefined ? room : bindRoomRunSession(room, 'review-run', sessionId);
}

function runtimeHarness({
  room = roomWithRun(),
  createAdmissions = [],
  resumeAdmissions = [],
  resolverRegistrationResult,
} = {}) {
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
        $schema: request.$schema,
        contract: request.contract,
        schemaVersion: 1,
        mutationId: request.mutationId,
        status: 'accepted',
        sessionId: session.id,
        identitySource: 'agent-loop-authority',
        acquire: acquire('resume', pair.handle, 'resumed'),
      };
    },
    get: async id => handles.find(pair => pair.handle.agent.id === id)?.handle.agent,
  };
  const approvals = new FakeApprovals({ resolverRegistrationResult });
  return {
    sessions,
    creates,
    resumes,
    legacyAcquires,
    handles,
    sessionGets,
    agents,
    approvals,
    sessionRegistry: {
      get: async id => {
        sessionGets.push(id);
        return sessions.get(id);
      },
    },
  };
}

export const agentSessionControllerHarness = Object.freeze({
  CHATROOM_COMMAND_SUBMIT,
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  ChatroomAgentSessionController,
  ChatroomAgentSessionConversationSource,
  ChatroomAgentSessionConversationSourceV7,
  ChatroomConversationController,
  DurableChatroomRoomStore,
  FakeApprovals,
  FakeSession,
  acquire,
  addRoomRun,
  admission,
  assert,
  assertChatroomAdmissionDeliveriesAccepted,
  bindRoomRun,
  bindRoomRunSession,
  createRoom,
  discarded,
  fakeHandle,
  messageEvent,
  mutation,
  owner,
  recordRoomAdmissionMessageLink,
  recordRoomSessionSelfIntroduction,
  roomWithRun,
  runtimeHarness,
  sessionEvent,
  test,
  userEvent,
});
