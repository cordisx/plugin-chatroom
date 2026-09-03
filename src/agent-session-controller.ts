import type {
  Agent,
  AgentAdmission,
  AgentHandle,
  AgentMessageDiscardResult,
  AgentMutationResult,
} from '@cordisx/protocol/agents/v1';
import type { EntityAgentAcquireResult } from '@cordisx/protocol/entities/v1';
import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
} from 'cordisx/contracts';
import type {
  ApprovalAnswererHandle,
  ApprovalOutcome,
  ApprovalQuestion,
  ApprovalService,
} from '@cordisx/protocol/approval/v1';
import type {
  AgentCancelCause,
  MessageId,
  Session,
  SessionRegistry,
  SessionSubscription,
  SessionSubscriptionClosed,
  SessionSubscriptionPage,
  UserMessage,
} from '@cordisx/protocol/sessions/v1';

import type { ChatroomAgentConfiguration } from './agent-definition.js';
import {
  ChatroomAgentSessionProjector,
  type ChatroomSessionAgentFacts,
  type ChatroomSessionProjectionPage,
} from './agent-session-projection.js';
import { ChatroomRoomStoreError, type DurableChatroomRoomStore } from './room-store.js';
import {
  approvalAuthorityMemberIds,
  addRoomRun,
  bindRoomRunSession,
  createChatroomOpaqueId,
  recordRoomSessionSelfIntroduction,
  type Room,
  type RoomMembership,
  type RoomRun,
} from './room.js';
import { resolveExplicitRoomAgentDispatch } from './room-target.js';

export interface ChatroomAgentRuntimeContext {
  readonly agents: CordisXAgentRegistryV1;
  readonly sessions: SessionRegistry;
  readonly approvals: ApprovalService;
}

export interface ChatroomSessionObservation {
  readonly roomId: string;
  readonly runId: string;
  readonly page: SessionSubscriptionPage;
  readonly projection: ChatroomSessionProjectionPage;
}

export interface ChatroomApprovalContext {
  readonly room: Room;
  readonly run: RoomRun;
  readonly member: RoomMembership;
  /** Ordered nearest manager first. Empty means the request fails closed. */
  readonly authorityMemberIds: readonly string[];
  readonly question: ApprovalQuestion;
}

export type ChatroomApprovalPolicy = (
  context: ChatroomApprovalContext,
) => ApprovalOutcome | Promise<ApprovalOutcome>;

export type ChatroomAgentSendMode = 'send' | 'followup' | 'steer' | 'inject';

export type ChatroomAgentSessionOutcome =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly messageId: MessageId;
    readonly sessionId: string;
    readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained';
  }
  | {
    readonly status: 'denied' | 'unavailable' | 'conflict';
    readonly roomId: string;
    readonly runId: string;
    readonly code: string;
  };

interface RuntimeOwner {
  readonly handle: AgentHandle;
  readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained';
}

interface RuntimeSubscription {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly subscription: SessionSubscription;
  phase: 'replay' | 'live';
  afterSeq: number;
}

export interface ChatroomRoomSessionProjection {
  readonly activeRuns: readonly ReturnType<ChatroomAgentSessionProjector['activeRun']>[];
  readonly items: readonly import('@cordisx/protocol/agent-conversation-shell/v4').AgentConversationItem[];
}

type RuntimeAcquireResult = EntityAgentAcquireResult | CordisXAgentSessionLegacyAcquireResultV1;
type RuntimeAcquireFailure = Exclude<EntityAgentAcquireResult, { readonly status: 'accepted' }>
  | Exclude<CordisXAgentSessionLegacyAcquireResultV1, { readonly status: 'accepted' }>;

const runKey = (roomId: string, runId: string) =>
  `${roomId.length}:${roomId}${runId.length}:${runId}`;

const acquisitionMutationId = (operation: 'create' | 'resume' | 'migrate', roomId: string, runId: string) =>
  createChatroomOpaqueId(`agent-${operation}`, roomId, runId);

const replacementAdmission = (result: AgentAdmission): boolean => result.status === 'unavailable'
  && (result.code === 'agent-replaced'
    || result.code === 'plugin-generation-replaced'
    || result.code === 'connection-replaced');

const acquireErrorCode = (
  result: RuntimeAcquireFailure,
): string => result.code;

/**
 * Chatroom domain orchestration over the public Agent/Session runtime.
 * SessionId is the only durable runtime identity; owners, subscriptions,
 * answerers, replay pages, and SessionEvent projections remain process-local.
 */
export class ChatroomAgentSessionController {
  private disposed = false;
  private generation = 1;
  private readonly owners = new Map<string, RuntimeOwner>();
  private readonly subscriptions = new Map<string, RuntimeSubscription>();
  private readonly projectors = new Map<string, ChatroomAgentSessionProjector>();
  private readonly approvalAnswerers = new Map<string, ApprovalAnswererHandle>();
  private readonly acquisitions = new Map<string, Promise<RuntimeOwner | RuntimeAcquireFailure>>();
  private readonly roomMutations = new Map<string, Promise<void>>();
  private readonly localUnavailableRuns = new Map<string, string>();
  private readonly observedMessageIds = new Map<string, Set<MessageId>>();
  /** Live admission coordination only; durable truth is still SessionEvent. */
  private readonly admittedMessageIds = new Set<MessageId>();
  private readonly projectionListeners = new Set<(roomId: string) => void>();
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
  private readonly delegatedSessionEvents = new Set<string>();
  private presentationSequence: number;

  constructor(
    private readonly runtime: ChatroomAgentRuntimeContext,
    readonly configuration: ChatroomAgentConfiguration,
    readonly store: DurableChatroomRoomStore,
    private readonly observe: (observation: ChatroomSessionObservation) => void | Promise<void> = () => {},
    private readonly approvalPolicy?: ChatroomApprovalPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.presentationSequence = Math.max(0, ...this.rooms.snapshot().map(room => room.timelineSequence));
  }

  get rooms() { return this.store.rooms; }

  get ownerHandleCount(): number { return this.owners.size; }

  subscribeProjection(listener: (roomId: string) => void): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  projectionForRoom(roomId: string): ChatroomRoomSessionProjection {
    const room = this.rooms.get(roomId);
    if (room === undefined) return { activeRuns: [], items: [] };
    const projectors = room.runs.flatMap(run => {
      const projector = this.projectors.get(runKey(roomId, run.runId));
      return projector === undefined ? [] : [projector];
    });
    return Object.freeze({
      activeRuns: Object.freeze(projectors.map(projector => projector.activeRun())),
      items: Object.freeze(projectors.flatMap(projector => projector.snapshotItems())
        .sort((left, right) => left.sequence - right.sequence)),
    });
  }

  answerApprovalItem(roomId: string, itemId: string, outcome: ApprovalOutcome): boolean {
    const room = this.rooms.get(roomId);
    if (room === undefined) return false;
    for (const run of room.runs) {
      const item = this.projectors.get(runKey(roomId, run.runId))?.approvalItem(itemId);
      if (item === undefined || item.state !== 'pending') continue;
      const resolve = this.pendingApprovals.get(this.approvalKey(
        item.sessionId, item.agentGeneration, item.approvalId,
      ));
      if (resolve === undefined) return false;
      this.pendingApprovals.delete(this.approvalKey(item.sessionId, item.agentGeneration, item.approvalId));
      resolve(outcome);
      return true;
    }
    return false;
  }

  isRunLocallyUnavailable(roomId: string, runId: string): boolean {
    return this.localUnavailableRuns.has(runKey(roomId, runId));
  }

  /** Observer hydration reads SessionEvent replay and never claims mutation authority or writes Room state. */
  async hydrate(): Promise<void> {
    this.assertUsable();
    const generation = this.generation;
    for (const room of this.rooms.snapshot()) {
      for (const run of room.runs) {
        if (run.sessionId === undefined || !this.isCurrent(generation)) continue;
        const session = await this.runtime.sessions.get(run.sessionId);
        if (!this.isCurrent(generation)) return;
        if (session === undefined) {
          this.localUnavailableRuns.set(runKey(room.id, run.runId), 'session-unavailable');
          continue;
        }
        const agent = await this.runtime.agents.get(run.sessionId);
        if (!this.isCurrent(generation)) return;
        if (agent !== undefined && (agent.id !== run.sessionId || agent.session.id !== run.sessionId)) {
          throw new Error('Observed Agent changed the authoritative Session identity.');
        }
        await this.openSessionSubscription(room.id, run.runId, session, generation, {
          ...(agent === undefined ? {} : { generation: agent.generation }),
          ...(agent?.detail === undefined ? {} : { details: agent.detail }),
        });
      }
    }
  }

  /** Read-only lookup never grants owner disposal authority. */
  async getObservedAgent(roomId: string, runId: string): Promise<Agent | undefined> {
    this.assertUsable();
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (run.sessionId === undefined) return undefined;
    const agent = await this.runtime.agents.get(run.sessionId);
    if (agent !== undefined && (agent.id !== run.sessionId || agent.session.id !== run.sessionId)) {
      throw new Error('Observed Agent changed the authoritative Session identity.');
    }
    return agent;
  }

  async sendToRoom(
    roomId: string,
    runId: string,
    userItemId: string,
    text: string,
    mode: ChatroomAgentSendMode = 'followup',
  ): Promise<ChatroomAgentSessionOutcome> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      return { status: acquired.status, roomId, runId, code: acquireErrorCode(acquired) };
    }
    const current = this.requireRun(this.requireRoom(roomId), runId);
    if (current.sessionSelfIntroduction === undefined
      || !this.observedMessageIds.get(acquired.handle.agent.session.id)
        ?.has(current.sessionSelfIntroduction.requestMessageId)) {
      const introduction = await this.requestMemberSelfIntroduction(roomId, runId);
      if (introduction.status !== 'accepted'
        && !this.owners.has(runKey(roomId, runId))) return introduction;
    }
    const messageId = createChatroomOpaqueId('room-session-message', userItemId, runId);
    const message = this.userMessage(
      acquired.handle,
      messageId,
      text,
      'chatroom.room-message',
      userItemId,
      'relay',
    );
    const admission = await this.submit(acquired.handle.agent, message, mode);
    if (admission.messageId !== messageId) {
      throw new Error('Agent admission changed the submitted MessageId.');
    }
    if (replacementAdmission(admission)) await this.detachRuntime(roomId, runId);
    if (admission.status !== 'accepted') {
      return { status: admission.status, roomId, runId, code: admission.code };
    }
    return {
      status: 'accepted', roomId, runId, messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  /** Chatroom owns the introduction copy and correlation; Protocol owns no business prompt. */
  async requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomAgentSessionOutcome> {
    this.assertUsable();
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      return { status: acquired.status, roomId, runId, code: acquireErrorCode(acquired) };
    }
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    const member = this.requireMember(room, run.memberId);
    const correlationId = createChatroomOpaqueId(
      'self-introduction', roomId, member.memberId, runId,
    );
    const messageId = run.sessionSelfIntroduction?.requestMessageId
      ?? createChatroomOpaqueId('self-introduction-message', roomId, member.memberId, runId);
    if (run.sessionSelfIntroduction === undefined) {
      await this.mutateRoom(roomId, current => recordRoomSessionSelfIntroduction(current, runId, {
        requestMessageId: messageId,
        correlationId,
        requestedAt: this.now(),
      }));
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
    }
    if (this.admittedMessageIds.has(run.sessionSelfIntroduction!.requestMessageId)
      || this.observedMessageIds.get(acquired.handle.agent.session.id)
        ?.has(run.sessionSelfIntroduction!.requestMessageId)) {
      return {
        status: 'accepted', roomId, runId,
        messageId: run.sessionSelfIntroduction!.requestMessageId,
        sessionId: acquired.handle.agent.session.id,
        disposition: acquired.disposition,
      };
    }
    const message = this.userMessage(
      acquired.handle,
      messageId,
      `Introduce yourself to this Chatroom Room as ${member.label}. State your role, what you can help with, and any important limits. Do not invent capabilities.`,
      'chatroom.member-self-introduction',
      run.sessionSelfIntroduction!.correlationId,
      'instructions',
    );
    const admission = await acquired.handle.agent.followup(message);
    if (admission.messageId !== messageId) {
      throw new Error('Agent admission changed the self-introduction MessageId.');
    }
    if (replacementAdmission(admission)) await this.detachRuntime(roomId, runId);
    if (admission.status !== 'accepted') {
      return { status: admission.status, roomId, runId, code: admission.code };
    }
    this.admittedMessageIds.add(messageId);
    return {
      status: 'accepted', roomId, runId, messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  /** Cancels only the still-pending introduction message, never the whole Agent. */
  async cancelMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<AgentMessageDiscardResult> {
    this.assertUsable();
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (run.sessionSelfIntroduction === undefined) {
      throw new Error('Member self-introduction is unavailable.');
    }
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      const envelope = {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
        contract: 'cordisx.agent-message-cancellation-result/v1',
        schemaVersion: 1,
        messageId: run.sessionSelfIntroduction.requestMessageId,
      } as const;
      return acquired.status === 'denied'
        ? { ...envelope, status: 'denied', code: 'permission-denied' }
        : { ...envelope, status: 'unavailable', code: 'host-unavailable' };
    }
    const result = await acquired.handle.agent.discard(run.sessionSelfIntroduction.requestMessageId);
    if (result.status === 'unavailable'
      && (result.code === 'agent-replaced'
        || result.code === 'plugin-generation-replaced'
        || result.code === 'connection-replaced')) {
      await this.detachRuntime(roomId, runId);
    }
    return result;
  }

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
        contract: 'cordisx.agent-mutation-result/v1',
        schemaVersion: 1,
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const subscriptions = [...this.subscriptions.values()];
    const answerers = [...this.approvalAnswerers.values()];
    const owners = [...this.owners.entries()];
    this.subscriptions.clear();
    this.projectors.clear();
    this.approvalAnswerers.clear();
    this.owners.clear();
    this.localUnavailableRuns.clear();
    this.observedMessageIds.clear();
    this.admittedMessageIds.clear();
    this.projectionListeners.clear();
    for (const resolve of this.pendingApprovals.values()) resolve('unavailable');
    this.pendingApprovals.clear();
    this.delegatedSessionEvents.clear();
    await Promise.allSettled([
      ...subscriptions.map(item => item.subscription.unsubscribe()),
      ...answerers.map(item => item.dispose()),
      ...owners.map(([key, item]) => this.disposeOwner(key, item.handle)),
    ]);
  }

  private async ensureOwner(
    roomId: string,
    runId: string,
  ): Promise<RuntimeOwner | RuntimeAcquireFailure> {
    const key = runKey(roomId, runId);
    const retained = this.owners.get(key);
    if (retained !== undefined) return { handle: retained.handle, disposition: 'retained' };
    const inFlight = this.acquisitions.get(key);
    if (inFlight !== undefined) return await inFlight;
    const operation = this.acquireOwner(roomId, runId);
    this.acquisitions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.acquisitions.get(key) === operation) this.acquisitions.delete(key);
    }
  }

  private async acquireOwner(roomId: string, runId: string): Promise<RuntimeOwner | RuntimeAcquireFailure> {
    const generation = this.generation;
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    const member = this.requireMember(room, run.memberId);
    const raw: RuntimeAcquireResult = run.sessionId !== undefined
      ? await this.runtime.agents.resume({
        sessionId: run.sessionId,
        definitionSource: 'session-persisted',
        mutationId: acquisitionMutationId('resume', roomId, runId),
      })
      : run.taskBinding !== undefined
        ? await this.runtime.agents.acquireLegacyTaskBinding({
          $schema: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
          contract: CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
          schemaVersion: 1,
          binding: run.taskBinding,
          mutationId: acquisitionMutationId('migrate', roomId, runId),
        })
        : await this.runtime.agents.create({
        definition: member.definition,
        mutationId: acquisitionMutationId('create', roomId, runId),
      });
    if (raw.status !== 'accepted') return raw;
    const result = 'acquire' in raw ? raw.acquire : raw;
    if (result.status !== 'accepted') return result;
    if (!this.isCurrent(generation)) {
      await this.disposeOwner(runKey(roomId, runId), result.handle);
      throw new Error('Chatroom Agent/Session controller was replaced during acquisition.');
    }
    if (result.handle.agent.id !== result.sessionId
      || result.handle.agent.session.id !== result.sessionId
      || result.handle.agent.generation !== result.agentGeneration
      || result.handle.agent.session.generation !== result.sessionGeneration) {
      throw new Error('Agent acquisition violated the Agent/Session identity contract.');
    }
    const key = runKey(roomId, runId);
    try {
      await this.mutateRoom(roomId, current => bindRoomRunSession(current, runId, result.sessionId));
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced before publication.');
      const owner: RuntimeOwner = { handle: result.handle, disposition: result.disposition };
      this.owners.set(key, owner);
      this.localUnavailableRuns.delete(key);
      await this.openSessionSubscription(roomId, runId, result.handle.agent.session, generation, {
        generation: result.handle.agent.generation,
        ...(result.handle.agent.detail === undefined ? {} : { details: result.handle.agent.detail }),
      });
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced during Session subscription.');
      await this.openApprovalAnswerer(roomId, runId, result.handle.agent);
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced during approval registration.');
    } catch (error) {
      this.owners.delete(key);
      const subscription = this.subscriptions.get(key);
      const answerer = this.approvalAnswerers.get(key);
      this.subscriptions.delete(key);
      this.projectors.delete(key);
      this.approvalAnswerers.delete(key);
      await Promise.allSettled([
        ...(subscription === undefined ? [] : [subscription.subscription.unsubscribe()]),
        ...(answerer === undefined ? [] : [answerer.dispose()]),
        this.disposeOwner(key, result.handle),
      ]);
      throw error;
    }
    return { handle: result.handle, disposition: result.disposition };
  }

  private async openSessionSubscription(
    roomId: string,
    runId: string,
    session: Session,
    generation: number,
    agentFacts: ChatroomSessionAgentFacts = {},
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const key = runKey(roomId, runId);
    const existing = this.subscriptions.get(key);
    if (existing?.sessionId === session.id && existing.sessionGeneration === session.generation) {
      const existingProjector = this.projectors.get(key);
      if (existingProjector?.agentGeneration !== undefined || agentFacts.generation === undefined) {
        existingProjector?.updateAgentFacts(agentFacts);
        return;
      }
      this.subscriptions.delete(key);
      this.projectors.delete(key);
      await existing.subscription.unsubscribe();
    }
    else if (existing !== undefined) await existing.subscription.unsubscribe();
    this.observedMessageIds.delete(session.id);
    const initialRoom = this.requireRoom(roomId);
    const initialRun = this.requireRun(initialRoom, runId);
    const projector = new ChatroomAgentSessionProjector(
      initialRoom,
      initialRun,
      session.id,
      () => this.nextPresentationSequence(),
      agentFacts,
    );
    this.projectors.set(key, projector);
    let active: RuntimeSubscription | undefined;
    const pendingPages: SessionSubscriptionPage[] = [];
    let observationTail = Promise.resolve();
    const observePage = async (page: SessionSubscriptionPage): Promise<void> => {
      if (active === undefined) {
        pendingPages.push(page);
        return;
      }
      const operation = observationTail.then(async () => {
        if (active === undefined
          || this.subscriptions.get(key) !== active
          || !this.isCurrent(generation)) return;
        this.validateSessionPage(active, page);
        const currentRoom = this.requireRoom(roomId);
        projector.updateDomain(currentRoom, this.requireRun(currentRoom, runId));
        const projection = projector.project(page);
        await this.observe({ roomId, runId, page, projection });
        for (const listener of this.projectionListeners) listener(roomId);
        if (page.phase === 'live' && this.owners.has(key)) {
          for (const event of page.events) {
            if (event.type === 'assistant/message') {
              await this.dispatchAgentMentions(roomId, runId, event.seq, event.data.message.content);
            }
          }
        }
      });
      observationTail = operation.then(() => {}, () => {});
      await operation;
    };
    const result = await session.subscribe({ afterSeq: -1, pageSize: 256 }, observePage);
    if (!this.isCurrent(generation)) {
      this.projectors.delete(key);
      if (result.status === 'subscribed') await result.subscription.unsubscribe();
      return;
    }
    if (result.status !== 'subscribed') {
      this.projectors.delete(key);
      this.localUnavailableRuns.set(key, result.code);
      return;
    }
    active = {
      sessionId: session.id,
      sessionGeneration: session.generation,
      subscription: result.subscription,
      phase: 'replay',
      afterSeq: -1,
    };
    this.subscriptions.set(key, active);
    for (const page of pendingPages) await observePage(page);
    for (const listener of this.projectionListeners) listener(roomId);
    void result.subscription.closed.then(closed =>
      this.handleSessionSubscriptionClosed(key, active!, closed));
  }

  private validateSessionPage(active: RuntimeSubscription, page: SessionSubscriptionPage): void {
    if (page.sessionId !== active.sessionId
      || page.sessionGeneration !== active.sessionGeneration
      || page.subscriptionGeneration !== active.subscription.subscriptionGeneration
      || page.replayThrough !== active.subscription.replayThrough
      || (active.phase === 'live' && page.phase !== 'live')) {
      throw new Error('Session subscription page crossed its identity or replay/live fence.');
    }
    for (const event of page.events) {
      if (event.sessionId !== active.sessionId || event.seq !== active.afterSeq + 1) {
        throw new Error('SessionEvent replay/live sequence is not contiguous.');
      }
      active.afterSeq = event.seq;
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        const message = event.type === 'user/message' ? event.data : event.data.message;
        const ids = this.observedMessageIds.get(active.sessionId) ?? new Set<MessageId>();
        ids.add(message.id);
        this.observedMessageIds.set(active.sessionId, ids);
      }
    }
    if (page.phase === 'live') active.phase = 'live';
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
    this.projectors.delete(key);
    if (closed.code === 'unsubscribed') return;
    // Permission decisions replace the issued lease, not the durable Session.
    // The next explicit action may resume that Session under refreshed grants.
    if (closed.code !== 'permission-revoked') this.localUnavailableRuns.set(key, closed.code);
    const owner = this.owners.get(key);
    this.owners.delete(key);
    this.settleSessionApprovals(active.sessionId);
    const answerer = this.approvalAnswerers.get(key);
    this.approvalAnswerers.delete(key);
    await Promise.allSettled([
      ...(answerer === undefined ? [] : [answerer.dispose()]),
      ...(owner === undefined ? [] : [this.disposeOwner(key, owner.handle)]),
    ]);
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
      if (this.approvalPolicy !== undefined) {
        return await this.approvalPolicy({ room, run, member, authorityMemberIds, question });
      }
      const pendingKey = this.approvalKey(agent.session.id, agent.generation, question.id);
      return await new Promise<ApprovalOutcome>(resolve => {
        this.pendingApprovals.set(pendingKey, resolve);
      });
    });
    this.approvalAnswerers.set(key, answerer);
  }

  private async detachRuntime(roomId: string, runId: string): Promise<void> {
    const key = runKey(roomId, runId);
    const owner = this.owners.get(key);
    this.owners.delete(key);
    const subscription = this.subscriptions.get(key);
    const answerer = this.approvalAnswerers.get(key);
    this.subscriptions.delete(key);
    this.projectors.delete(key);
    this.approvalAnswerers.delete(key);
    this.localUnavailableRuns.set(key, 'agent-replaced');
    if (owner !== undefined) this.settleSessionApprovals(owner.handle.agent.session.id);
    await Promise.allSettled([
      ...(subscription === undefined ? [] : [subscription.subscription.unsubscribe()]),
      ...(answerer === undefined ? [] : [answerer.dispose()]),
      ...(owner === undefined ? [] : [this.disposeOwner(key, owner.handle)]),
    ]);
  }

  private disposeOwner(key: string, handle: AgentHandle): Promise<AgentMutationResult<'dispose'>> {
    return handle.dispose({ mutationId: createChatroomOpaqueId('agent-dispose', key) });
  }

  private userMessage(
    handle: AgentHandle,
    id: MessageId,
    text: string,
    namespace: string,
    correlationId: string,
    form: 'instructions' | 'relay',
  ): UserMessage {
    return Object.freeze({
      id,
      role: 'user',
      content: Object.freeze([{ type: 'text' as const, text }]),
      source: Object.freeze({
        kind: 'plugin',
        pluginId: handle.owner.pluginId,
        generation: handle.owner.generation,
        form,
        correlation: Object.freeze({ namespace, id: correlationId }),
      }),
    });
  }

  private submit(agent: Agent, message: UserMessage, mode: ChatroomAgentSendMode): Promise<AgentAdmission> {
    if (mode === 'send') return agent.send(message, 'next-turn', true);
    if (mode === 'followup') return agent.followup(message);
    if (mode === 'steer') return agent.steer(message);
    return agent.inject(message);
  }

  private async dispatchAgentMentions(
    roomId: string,
    sourceRunId: string,
    eventSeq: number,
    content: UserMessage['content'],
  ): Promise<void> {
    const eventKey = createChatroomOpaqueId('session-delegation-event', roomId, sourceRunId, String(eventSeq));
    if (this.delegatedSessionEvents.has(eventKey)) return;
    this.delegatedSessionEvents.add(eventKey);
    const value = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
    if (value === '') return;
    let room = this.requireRoom(roomId);
    const sourceRun = this.requireRun(room, sourceRunId);
    const unavailable = new Set(room.runs
      .filter(run => this.isRunLocallyUnavailable(roomId, run.runId))
      .map(run => run.runId));
    const dispatch = resolveExplicitRoomAgentDispatch(room, value, sourceRun.memberId, unavailable);
    if (dispatch.status !== 'resolved') return;
    for (const recipient of dispatch.recipients) {
      let targetRunId = recipient.runId;
      if (recipient.createRun) {
        targetRunId = createChatroomOpaqueId(
          'session-delegation-run', roomId, sourceRunId, String(eventSeq), recipient.memberId,
        );
        const nextRunId = targetRunId;
        await this.mutateRoom(roomId, current => current.runs.some(run => run.runId === nextRunId)
          ? current
          : addRoomRun(current, {
            runId: nextRunId,
            memberId: recipient.memberId,
            title: this.requireMember(current, recipient.memberId).label,
            status: 'creating',
          }));
        room = this.requireRoom(roomId);
      }
      if (targetRunId === undefined) continue;
      const acquired = await this.ensureOwner(roomId, targetRunId);
      if (!('handle' in acquired)) continue;
      const target = this.requireRun(room, targetRunId);
      if (target.sessionSelfIntroduction === undefined) {
        await this.requestMemberSelfIntroduction(roomId, targetRunId);
      }
      const messageId = createChatroomOpaqueId(
        'session-delegation-message', roomId, sourceRunId, String(eventSeq), targetRunId,
      );
      const message = this.userMessage(
        acquired.handle,
        messageId,
        dispatch.content,
        'chatroom.agent-delegation',
        eventKey,
        'relay',
      );
      await acquired.handle.agent.followup(message);
    }
  }

  private nextPresentationSequence(): number {
    this.presentationSequence = Math.max(
      this.presentationSequence,
      ...this.rooms.snapshot().map(room => room.timelineSequence),
    ) + 1;
    return this.presentationSequence;
  }

  private approvalKey(sessionId: string, agentGeneration: number, approvalId: string): string {
    return `${sessionId.length}:${sessionId}:${agentGeneration}:${approvalId.length}:${approvalId}`;
  }

  private settleSessionApprovals(sessionId: string): void {
    const prefix = `${sessionId.length}:${sessionId}:`;
    for (const [key, resolve] of this.pendingApprovals) {
      if (!key.startsWith(prefix)) continue;
      this.pendingApprovals.delete(key);
      resolve('unavailable');
    }
  }

  private async mutateRoom(roomId: string, transform: (room: Room) => Room): Promise<void> {
    const previous = this.roomMutations.get(roomId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        this.assertUsable();
        const document = this.store.document(roomId);
        if (document === undefined) throw new Error('Room is unavailable.');
        const next = transform(document.room);
        if (next === document.room) return;
        try {
          await this.store.compareAndSwap(document.revision, next);
          return;
        } catch (error) {
          if (!(error instanceof ChatroomRoomStoreError) || error.code !== 'conflict') throw error;
        }
      }
      throw new ChatroomRoomStoreError(
        'conflict', 'Room registry kept changing during Agent/Session mutation.', true,
      );
    });
    const settled = operation.then(() => {}, () => {});
    this.roomMutations.set(roomId, settled);
    try {
      await operation;
    } finally {
      if (this.roomMutations.get(roomId) === settled) this.roomMutations.delete(roomId);
    }
  }

  private requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
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

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom Agent/Session controller is disposed.');
  }
}
