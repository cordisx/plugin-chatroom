import type {
  Agent,
  AgentAcquireResult,
  AgentAdmission,
  AgentMutationResult,
  AgentHandle,
  AgentMessageDiscardResult,
  AgentRegistry,
  AgentSetup,
} from '@cordisx/protocol/agents/v1';
import type {
  ApprovalAnswererHandle,
  ApprovalOutcome,
  ApprovalQuestion,
  ApprovalService,
} from '@cordisx/protocol/approval/v1';
import type {
  MessageId,
  AgentCancelCause,
  Session,
  SessionRegistry,
  SessionSubscription,
  SessionSubscriptionClosed,
  SessionSubscriptionPage,
  UserMessage,
} from '@cordisx/protocol/sessions/v1';

import {
  agentDefinitionCatalogFor,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import {
  addRoomRun,
  approvalAuthorityMemberIds,
  bindRoomRunSession,
  createChatroomOpaqueId,
  recordRoomMemberSelfIntroduction,
  type Room,
  type RoomMembership,
  type RoomRun,
} from './room.js';
import type { ChatroomRoomStore } from './room-store.js';
import { resolveRoomMessageDispatch, type RoomDispatchResolution } from './room-target.js';

export interface ChatroomAgentRuntimeContext {
  readonly agents: AgentRegistry;
  readonly sessions: SessionRegistry;
  readonly approvals: ApprovalService;
}

export interface ChatroomSessionObservation {
  readonly roomId: string;
  readonly runId: string;
  readonly page: SessionSubscriptionPage;
}

export interface ChatroomApprovalContext {
  readonly room: Room;
  readonly run: RoomRun;
  readonly member: RoomMembership;
  /** Ordered nearest manager first. Empty means the request must fail closed. */
  readonly authorityMemberIds: readonly string[];
  readonly question: ApprovalQuestion;
}

export type ChatroomApprovalPolicy = (
  context: ChatroomApprovalContext,
) => ApprovalOutcome | Promise<ApprovalOutcome>;

export type ChatroomSendMode = 'send' | 'followup' | 'steer' | 'inject';

export type ChatroomAgentMutationOutcome =
  | { readonly status: 'accepted'; readonly roomId: string; readonly runId: string; readonly messageId: MessageId; readonly sessionId: string; readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained' }
  | { readonly status: 'denied' | 'unavailable' | 'conflict'; readonly roomId: string; readonly runId: string; readonly code: string };

export type ChatroomDispatchOutcome =
  | Exclude<RoomDispatchResolution, { readonly status: 'resolved' }>
  | {
    readonly status: 'resolved';
    readonly roomId: string;
    readonly outcomes: readonly ChatroomAgentMutationOutcome[];
  };

interface RuntimeOwner {
  readonly handle: AgentHandle;
  readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained';
}

interface RuntimeSubscription {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly subscription: SessionSubscription;
}

const runKey = (roomId: string, runId: string) =>
  `${roomId.length}:${roomId}${runId.length}:${runId}`;

const acquisitionMutationId = (operation: 'create' | 'resume', roomId: string, runId: string) =>
  createChatroomOpaqueId(`agent-${operation}`, roomId, runId);

const errorCode = (result: Exclude<AgentAcquireResult, { readonly status: 'accepted' }>): string =>
  result.code;

const replacementAdmission = (result: AgentAdmission): boolean => result.status === 'unavailable'
  && (result.code === 'agent-replaced'
    || result.code === 'plugin-generation-replaced'
    || result.code === 'connection-replaced');

/**
 * Chatroom domain orchestration over the public DSH-aligned runtime. The only
 * durable Agent identity written to a Room is SessionId. Handles,
 * subscriptions, approval answerers, and replay pages remain process-local.
 */
export class ChatroomAgentSessionController {
  private disposed = false;
  private idSequence = 0;
  private readonly owners = new Map<string, RuntimeOwner>();
  private readonly subscriptions = new Map<string, RuntimeSubscription>();
  private readonly approvalAnswerers = new Map<string, ApprovalAnswererHandle>();
  private readonly acquisitions = new Map<string, Promise<RuntimeOwner | AgentAcquireResult>>();

  constructor(
    private readonly runtime: ChatroomAgentRuntimeContext,
    readonly configuration: ChatroomAgentConfiguration,
    readonly store: ChatroomRoomStore,
    private readonly observe: (observation: ChatroomSessionObservation) => void | Promise<void> = () => {},
    private readonly approvalPolicy: ChatroomApprovalPolicy = () => 'unavailable',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Observer hydration is deliberately read-only: no create/resume, no Room
   * replacement, and no claim of mutation authority.
   */
  async hydrate(): Promise<void> {
    this.assertUsable();
    for (const room of this.store.snapshot()) {
      for (const run of room.runs) {
        if (run.sessionId === undefined) continue;
        const session = await this.runtime.sessions.get(run.sessionId);
        if (session !== undefined) await this.openSessionSubscription(room.id, run.runId, session);
      }
    }
  }

  /** Read-only bare Agent lookup; never grants dispose authority or writes Room state. */
  async getObservedAgent(roomId: string, runId: string): Promise<Agent | undefined> {
    this.assertUsable();
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (run.sessionId === undefined) return undefined;
    const agent = await this.runtime.agents.get(run.sessionId);
    if (agent === undefined) return undefined;
    if (agent.id !== run.sessionId || agent.session.id !== run.sessionId) {
      throw new Error('Observed Agent changed the authoritative Session identity.');
    }
    return agent;
  }

  /** Resolves ambient, explicit @mention, exact-run, and delegation routing. */
  async dispatchMessage(
    roomId: string,
    userItemId: string,
    value: string,
    delegatedMemberIds: readonly string[] = [],
  ): Promise<ChatroomDispatchOutcome> {
    this.assertUsable();
    const initial = this.requireRoom(roomId);
    const resolution = resolveRoomMessageDispatch(initial, value, delegatedMemberIds);
    if (resolution.status !== 'resolved') return resolution;
    const outcomes: ChatroomAgentMutationOutcome[] = [];
    for (const recipient of resolution.recipients) {
      let runId = recipient.runId;
      if (recipient.createRun) {
        runId = this.nextDomainId('run', roomId, recipient.memberId);
        await this.store.replace(roomId, room => addRoomRun(room, {
          runId: runId!,
          memberId: recipient.memberId,
          title: room.memberships.find(member => member.memberId === recipient.memberId)!.label,
          status: 'creating',
        }));
      }
      if (runId === undefined) throw new Error('Resolved recipient did not identify a Room run.');
      outcomes.push(await this.sendToRun(roomId, runId, userItemId, resolution.content));
    }
    return { status: 'resolved', roomId, outcomes: Object.freeze(outcomes) };
  }

  async sendToRun(
    roomId: string,
    runId: string,
    userItemId: string,
    text: string,
    mode: ChatroomSendMode = 'followup',
  ): Promise<ChatroomAgentMutationOutcome> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      return { status: acquired.status, roomId, runId, code: errorCode(acquired) };
    }
    const messageId = createChatroomOpaqueId('room-message', userItemId, runId);
    const message = this.userMessage(acquired.handle, messageId, text, 'chatroom.room-message', userItemId, 'relay');
    const admission = await this.submit(acquired.handle.agent, message, mode);
    if (admission.messageId !== messageId) throw new Error('Agent admission changed the submitted MessageId.');
    if (replacementAdmission(admission)) await this.detachRuntime(roomId, runId);
    if (admission.status !== 'accepted') {
      return { status: admission.status, roomId, runId, code: admission.code };
    }
    return {
      status: 'accepted',
      roomId,
      runId,
      messageId: admission.messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  /** Chatroom-owned prompt and MessageId; Protocol contains no business copy. */
  async requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomAgentMutationOutcome> {
    this.assertUsable();
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      return { status: acquired.status, roomId, runId, code: errorCode(acquired) };
    }
    const current = this.requireRun(this.requireRoom(roomId), runId);
    const member = this.requireMember(this.requireRoom(roomId), current.memberId);
    const correlationId = createChatroomOpaqueId('self-introduction', roomId, member.memberId, runId);
    const messageId = current.selfIntroduction?.requestMessageId
      ?? createChatroomOpaqueId('self-introduction-message', roomId, member.memberId, runId);
    if (current.selfIntroduction === undefined) {
      await this.store.replace(roomId, room => recordRoomMemberSelfIntroduction(room, runId, {
        requestMessageId: messageId,
        correlationId,
        requestedAt: this.now(),
      }));
    }
    const prompt = `Introduce yourself to this Chatroom Room as ${member.label}. State your role, what you can help with, and any important limits. Do not invent capabilities.`;
    const message = this.userMessage(
      acquired.handle,
      messageId,
      prompt,
      'chatroom.member-self-introduction',
      correlationId,
      'instructions',
    );
    const admission = await acquired.handle.agent.followup(message);
    if (admission.messageId !== messageId) throw new Error('Agent admission changed the self-introduction MessageId.');
    if (replacementAdmission(admission)) await this.detachRuntime(roomId, runId);
    if (admission.status !== 'accepted') {
      return { status: admission.status, roomId, runId, code: admission.code };
    }
    return {
      status: 'accepted', roomId, runId, messageId: admission.messageId,
      sessionId: acquired.handle.agent.session.id, disposition: acquired.disposition,
    };
  }

  /** Cancels only the pending introduction MessageId, never the whole Agent. */
  async cancelMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<AgentMessageDiscardResult> {
    this.assertUsable();
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (run.selfIntroduction === undefined) throw new Error('Member self-introduction is unavailable.');
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      const envelope = {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
        contract: 'cordisx.agent-message-cancellation-result/v1',
        schemaVersion: 1,
        messageId: run.selfIntroduction.requestMessageId,
      } as const;
      return acquired.status === 'denied'
        ? { ...envelope, status: 'denied', code: 'permission-denied' }
        : { ...envelope, status: 'unavailable', code: 'host-unavailable' };
    }
    const result = await acquired.handle.agent.discard(run.selfIntroduction.requestMessageId);
    if (result.status === 'unavailable'
      && (result.code === 'agent-replaced'
        || result.code === 'plugin-generation-replaced'
        || result.code === 'connection-replaced')) {
      await this.detachRuntime(roomId, runId);
    }
    return result;
  }

  /** Explicit whole-Agent cancellation; never used for one pending message. */
  async cancelRun(
    roomId: string,
    runId: string,
    cause: AgentCancelCause,
  ): Promise<AgentMutationResult<'cancel'>> {
    this.assertUsable();
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      const envelope = {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json',
        contract: 'cordisx.agent-mutation-result/v1', schemaVersion: 1,
        operation: 'cancel',
        mutationId: createChatroomOpaqueId('agent-cancel', roomId, runId),
      } as const;
      return acquired.status === 'denied'
        ? { ...envelope, status: 'denied', code: 'permission-denied' }
        : { ...envelope, status: 'unavailable', code: 'host-unavailable' };
    }
    const result = await acquired.handle.agent.cancel(cause, {
      mutationId: createChatroomOpaqueId('agent-cancel', roomId, runId),
    });
    if (result.status === 'unavailable'
      && (result.code === 'agent-replaced'
        || result.code === 'plugin-generation-replaced'
        || result.code === 'connection-replaced')) {
      await this.detachRuntime(roomId, runId);
    }
    return result;
  }

  /** Owner handles are intentionally process-local and observable for tests only as a count. */
  get ownerHandleCount(): number { return this.owners.size; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const subscriptions = [...this.subscriptions.values()];
    const answerers = [...this.approvalAnswerers.values()];
    const owners = [...this.owners.values()];
    this.subscriptions.clear();
    this.approvalAnswerers.clear();
    this.owners.clear();
    await Promise.allSettled([
      ...subscriptions.map(item => item.subscription.unsubscribe()),
      ...answerers.map(item => item.dispose()),
      ...owners.map(item => item.handle.dispose()),
    ]);
  }

  private async ensureOwner(roomId: string, runId: string): Promise<RuntimeOwner | Exclude<AgentAcquireResult, { readonly status: 'accepted' }>> {
    const key = runKey(roomId, runId);
    const retained = this.owners.get(key);
    if (retained !== undefined) return { handle: retained.handle, disposition: 'retained' };
    const inFlight = this.acquisitions.get(key);
    if (inFlight !== undefined) return inFlight;
    const operation = this.acquireOwner(roomId, runId);
    this.acquisitions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.acquisitions.get(key) === operation) this.acquisitions.delete(key);
    }
  }

  private async acquireOwner(roomId: string, runId: string): Promise<RuntimeOwner | Exclude<AgentAcquireResult, { readonly status: 'accepted' }>> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    const member = this.requireMember(room, run.memberId);
    const setup: AgentSetup = {
      definition: member.definition,
      definitions: agentDefinitionCatalogFor(member.definition, this.configuration.definitions),
    };
    const result = run.sessionId === undefined
      ? await this.runtime.agents.create({ setup, mutationId: acquisitionMutationId('create', roomId, runId) })
      : await this.runtime.agents.resume({
        sessionId: run.sessionId,
        setup,
        mutationId: acquisitionMutationId('resume', roomId, runId),
      });
    if (result.status !== 'accepted') return result;
    if (result.handle.agent.id !== result.sessionId
      || result.handle.agent.session.id !== result.sessionId
      || result.handle.agent.session.generation !== result.sessionGeneration) {
      throw new Error('Agent acquisition violated the Agent/Session identity contract.');
    }
    await this.store.replace(roomId, current => bindRoomRunSession(current, runId, result.sessionId));
    const owner: RuntimeOwner = { handle: result.handle, disposition: result.disposition };
    this.owners.set(runKey(roomId, runId), owner);
    await this.openSessionSubscription(roomId, runId, result.handle.agent.session);
    await this.openApprovalAnswerer(roomId, runId, result.handle.agent);
    return owner;
  }

  private async openSessionSubscription(roomId: string, runId: string, session: Session): Promise<void> {
    const key = runKey(roomId, runId);
    const existing = this.subscriptions.get(key);
    if (existing?.sessionId === session.id && existing.sessionGeneration === session.generation) return;
    if (existing !== undefined) await existing.subscription.unsubscribe();
    const result = await session.subscribe({ afterSeq: -1, pageSize: 256 }, page =>
      this.observeSessionPage(roomId, runId, session, page));
    if (result.status === 'subscribed') {
      const active: RuntimeSubscription = {
        sessionId: session.id,
        sessionGeneration: session.generation,
        subscription: result.subscription,
      };
      this.subscriptions.set(key, active);
      void result.subscription.closed.then(closed =>
        this.handleSessionSubscriptionClosed(key, active, closed));
    }
  }

  private async observeSessionPage(
    roomId: string,
    runId: string,
    session: Session,
    page: SessionSubscriptionPage,
  ): Promise<void> {
    if (this.disposed) return;
    const run = this.store.get(roomId)?.runs.find(candidate => candidate.runId === runId);
    if (run?.sessionId !== session.id
      || page.sessionId !== session.id
      || page.sessionGeneration !== session.generation) return;
    await this.observe({ roomId, runId, page });
  }

  private async handleSessionSubscriptionClosed(
    key: string,
    active: RuntimeSubscription,
    closed: SessionSubscriptionClosed,
  ): Promise<void> {
    if (this.subscriptions.get(key) !== active
      || closed.sessionId !== active.sessionId
      || closed.sessionGeneration !== active.sessionGeneration
      || closed.subscriptionGeneration !== active.subscription.subscriptionGeneration) return;
    this.subscriptions.delete(key);
    if (closed.code === 'unsubscribed') return;
    this.owners.delete(key);
    const answerer = this.approvalAnswerers.get(key);
    this.approvalAnswerers.delete(key);
    if (answerer !== undefined) await answerer.dispose();
  }

  private async openApprovalAnswerer(roomId: string, runId: string, agent: Agent): Promise<void> {
    const key = runKey(roomId, runId);
    const existing = this.approvalAnswerers.get(key);
    if (existing !== undefined
      && existing.agentId === agent.id
      && existing.agentGeneration === agent.generation) return;
    if (existing !== undefined) await existing.dispose();
    const answerer = await this.runtime.approvals.registerAnswerer(agent, async question => {
      const room = this.requireRoom(roomId);
      const run = this.requireRun(room, runId);
      const member = this.requireMember(room, run.memberId);
      const authorityMemberIds = approvalAuthorityMemberIds(room, member.memberId);
      if (authorityMemberIds.length === 0) return 'unavailable';
      return this.approvalPolicy({ room, run, member, authorityMemberIds, question });
    });
    this.approvalAnswerers.set(key, answerer);
  }

  private async detachRuntime(roomId: string, runId: string): Promise<void> {
    const key = runKey(roomId, runId);
    this.owners.delete(key);
    const subscription = this.subscriptions.get(key);
    const answerer = this.approvalAnswerers.get(key);
    this.subscriptions.delete(key);
    this.approvalAnswerers.delete(key);
    await Promise.allSettled([
      ...(subscription === undefined ? [] : [subscription.subscription.unsubscribe()]),
      ...(answerer === undefined ? [] : [answerer.dispose()]),
    ]);
  }

  private userMessage(
    handle: AgentHandle,
    id: MessageId,
    text: string,
    namespace: string,
    correlationId: string,
    form: 'instructions' | 'relay',
  ): UserMessage {
    const content: UserMessage['content'] = Object.freeze([{ type: 'text', text } as const]);
    return Object.freeze({
      id,
      role: 'user',
      content,
      source: Object.freeze({
        kind: 'plugin',
        pluginId: handle.owner.pluginId,
        generation: handle.owner.generation,
        form,
        correlation: Object.freeze({ namespace, id: correlationId }),
      }),
    });
  }

  private submit(agent: Agent, message: UserMessage, mode: ChatroomSendMode): Promise<AgentAdmission> {
    if (mode === 'send') return agent.send(message, 'next-turn', true);
    if (mode === 'followup') return agent.followup(message);
    if (mode === 'steer') return agent.steer(message);
    return agent.inject(message);
  }

  private nextDomainId(namespace: string, ...parts: readonly string[]): string {
    this.idSequence += 1;
    return createChatroomOpaqueId(namespace, ...parts, String(this.idSequence));
  }

  private requireRoom(roomId: string): Room {
    const room = this.store.get(roomId);
    if (room === undefined) throw new Error('Room is unavailable.');
    return room;
  }

  private requireRun(room: Room, runId: string): RoomRun {
    const run = room.runs.find(candidate => candidate.runId === runId);
    if (run === undefined) throw new Error('Room run is unavailable.');
    return run;
  }

  private requireMember(room: Room, memberId: string): RoomMembership {
    const member = room.memberships.find(candidate => candidate.memberId === memberId);
    if (member === undefined) throw new Error('Room member is unavailable.');
    return member;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom Agent/Session controller is disposed.');
  }
}
