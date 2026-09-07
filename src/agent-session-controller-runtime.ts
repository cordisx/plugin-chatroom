import { createRoom } from './room.js';
import { failRoomRunPresence } from './room-engagement.js';
import {
  acquireErrorCode,
  acquisitionMutationId,
  addRoomRun,
  type Agent,
  type AgentAdmission,
  type AgentCancelCause,
  type AgentHandle,
  type AgentMessageDiscardResult,
  type AgentMutationResult,
  approvalAuthorityMemberIds,
  type ApprovalOutcome,
  bindRoomRunSession,
  type ChatroomAgentSendMode,
  type ChatroomAgentSessionOutcome,
  ChatroomAgentSessionProjector,
  type ChatroomSessionAgentFacts,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  createChatroomOpaqueId,
  type MessageId,
  recordRoomSessionSelfIntroduction,
  replacementAdmission,
  resolveExplicitRoomAgentDispatch,
  type RoomMembership,
  routeChatroomDriverApproval,
  runKey,
  type RuntimeAcquireFailure,
  type RuntimeAcquireResult,
  type RuntimeOwner,
  type RuntimeSubscription,
  type Session,
  type SessionSubscriptionClosed,
  type SessionSubscriptionPage,
  type UserMessage,
} from './agent-session-controller-internals.js';
import { ChatroomAgentSessionAdmissionController } from './agent-session-controller-admission.js';

export class ChatroomAgentSessionRuntimeController extends ChatroomAgentSessionAdmissionController {
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
      'self-introduction',
      roomId,
      member.memberId,
      runId,
    );
    const messageId = run.sessionSelfIntroduction?.requestMessageId
      ?? createChatroomOpaqueId('self-introduction-message', roomId, member.memberId, runId);
    if (run.sessionSelfIntroduction === undefined) {
      await this.mutateRoom(roomId, current =>
        recordRoomSessionSelfIntroduction(current, runId, {
          requestMessageId: messageId,
          correlationId,
          requestedAt: this.now(),
        }));
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
    }
    if (
      this.admittedMessageIds.has(run.sessionSelfIntroduction!.requestMessageId)
      || this.observedMessageIds.get(acquired.handle.agent.session.id)
        ?.has(run.sessionSelfIntroduction!.requestMessageId)
    ) {
      return {
        status: 'accepted',
        roomId,
        runId,
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
      status: 'accepted',
      roomId,
      runId,
      messageId,
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
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json',
        contract: 'cordisx.agent-message-cancellation-result/v1',
        schemaVersion: 1,
        messageId: run.sessionSelfIntroduction.requestMessageId,
      } as const;
      return acquired.status === 'denied'
        ? { ...envelope, status: 'denied', code: 'permission-denied' }
        : { ...envelope, status: 'unavailable', code: 'host-unavailable' };
    }
    const result = await acquired.handle.agent.discard(run.sessionSelfIntroduction.requestMessageId);
    if (
      result.status === 'unavailable'
      && (result.code === 'agent-replaced'
        || result.code === 'plugin-generation-replaced'
        || result.code === 'connection-replaced')
    ) {
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
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json',
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
    if (
      result.status === 'unavailable'
      && (result.code === 'agent-replaced'
        || result.code === 'plugin-generation-replaced'
        || result.code === 'connection-replaced')
    ) {
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
    const authorityAnswerers = [...this.approvalAuthorityAnswerers.values()];
    const requestResolvers = [...this.approvalRequestResolvers.values()];
    const owners = [...this.owners.entries()];
    this.subscriptions.clear();
    this.projectors.clear();
    this.roomHydrations.clear();
    this.approvalAnswerers.clear();
    this.approvalAuthorityAnswerers.clear();
    this.owners.clear();
    this.localUnavailableRuns.clear();
    this.observedMessageIds.clear();
    this.admittedMessageIds.clear();
    this.projectionListeners.clear();
    for (const resolve of this.pendingApprovals.values()) resolve('unavailable');
    this.pendingApprovals.clear();
    for (const pending of this.pendingAuthorityApprovals.values()) pending.resolve('unavailable');
    this.pendingAuthorityApprovals.clear();
    this.delegatedSessionEvents.clear();
    this.presentationSequencesByEvent.clear();
    await Promise.allSettled([
      ...subscriptions.map(item => item.subscription.unsubscribe()),
      ...answerers.map(item => item.dispose()),
      ...authorityAnswerers.map(item => item.dispose()),
      ...requestResolvers.map(item => item.dispose()),
      ...owners.map(([key, item]) => this.disposeOwner(key, item.handle)),
    ]);
  }

  protected async ensureOwner(
    roomId: string,
    runId: string,
  ): Promise<RuntimeOwner | RuntimeAcquireFailure> {
    const key = runKey(roomId, runId);
    const retained = this.owners.get(key);
    if (retained !== undefined) {
      await this.ensureCollaboration(roomId, runId);
      await this.ensureOwnerApprovalRegistrations(roomId, runId, retained.handle);
      this.localUnavailableRuns.delete(key);
      return { handle: retained.handle, disposition: 'retained' };
    }
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
    if (
      result.handle.agent.id !== result.sessionId
      || result.handle.agent.session.id !== result.sessionId
      || result.handle.agent.generation !== result.agentGeneration
      || result.handle.agent.session.generation !== result.sessionGeneration
    ) {
      throw new Error('Agent acquisition violated the Agent/Session identity contract.');
    }
    const key = runKey(roomId, runId);
    try {
      if (run.sessionId === undefined) {
        await this.mutateRoom(roomId, current => bindRoomRunSession(current, runId, result.sessionId));
      } else {
        const currentRun = this.requireRun(this.requireRoom(roomId), runId);
        if (
          result.sessionId !== run.sessionId || currentRun.sessionId !== run.sessionId
          || currentRun.memberId !== run.memberId
        ) {
          throw new Error('Agent resume changed the existing Room run Session identity.');
        }
        // Resume recovers live authority, not a new Room association. Rebinding
        // the same Session would rewrite presence and clear retained operations.
      }
      await this.ensureCollaboration(roomId, runId);
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced before publication.');
      const owner: RuntimeOwner = { handle: result.handle, disposition: result.disposition };
      this.owners.set(key, owner);
      this.localUnavailableRuns.delete(key);
      await this.openSessionSubscription(roomId, runId, result.handle.agent.session, generation, {
        generation: result.handle.agent.generation,
        ...(result.handle.agent.detail === undefined ? {} : { details: result.handle.agent.detail }),
      });
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced during Session subscription.');
      await this.ensureOwnerApprovalRegistrations(roomId, runId, result.handle);
      if (!this.isCurrent(generation)) throw new Error('Agent acquisition was replaced during approval registration.');
    } catch (error) {
      this.owners.delete(key);
      const subscription = this.subscriptions.get(key);
      const answerer = this.approvalAnswerers.get(key);
      const authorityAnswerer = this.approvalAuthorityAnswerers.get(key);
      const requestResolver = this.approvalRequestResolvers.get(key);
      this.subscriptions.delete(key);
      this.projectors.delete(key);
      this.approvalAnswerers.delete(key);
      this.approvalAuthorityAnswerers.delete(key);
      this.approvalRequestResolvers.delete(key);
      await Promise.allSettled([
        ...(subscription === undefined ? [] : [subscription.subscription.unsubscribe()]),
        ...(answerer === undefined ? [] : [answerer.dispose()]),
        ...(authorityAnswerer === undefined ? [] : [authorityAnswerer.dispose()]),
        ...(requestResolver === undefined ? [] : [requestResolver.dispose()]),
        this.disposeOwner(key, result.handle),
      ]);
      throw error;
    }
    return { handle: result.handle, disposition: result.disposition };
  }

  private async ensureCollaboration(roomId: string, runId: string): Promise<void> {
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    const collaboration = this.runtime.collaboration;
    if ((collaboration === undefined || !collaboration.enabled()) && run.collaborationMode === undefined) return;
    try {
      if (collaboration === undefined) throw new Error('Chatroom CLI binding service is unavailable.');
      // A failed initial binding remains explicitly required, never a plain-agent fallback.
      if (run.collaborationMode === undefined) {
        await this.setCollaborationMode(roomId, runId, 'cli-pending');
        room = this.requireRoom(roomId);
        run = this.requireRun(room, runId);
      }
      await collaboration.ensureBound(room, run);
      if (run.collaborationMode !== 'cli') await this.setCollaborationMode(roomId, runId, 'cli');
    } catch (error) {
      await this.mutateRoom(roomId, current =>
        failRoomRunPresence(current, runId, {
          code: 'chatroom-cli-binding-unavailable',
          retryable: true,
          diagnostic: 'Chatroom reporting is unavailable; no task was submitted.',
        }));
      throw error;
    }
  }

  private async setCollaborationMode(roomId: string, runId: string, mode: 'cli-pending' | 'cli'): Promise<void> {
    await this.mutateRoom(roomId, current =>
      createRoom({
        ...current,
        runs: current.runs.map(value => value.runId === runId ? { ...value, collaborationMode: mode } : value),
      }));
  }

  private async ensureOwnerApprovalRegistrations(
    roomId: string,
    runId: string,
    handle: AgentHandle,
  ): Promise<void> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    const member = this.requireMember(room, run.memberId);
    await this.openApprovalAnswerer(roomId, runId, handle.agent);
    await this.openApprovalAuthorityAnswerer(roomId, runId, handle.agent, member);
    await this.openApprovalRequestResolver(roomId, runId, handle.agent, member);
  }

  protected async openSessionSubscription(
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
      if (
        existingProjector !== undefined
        && (existingProjector.agentGeneration !== undefined || agentFacts.generation === undefined)
      ) {
        existingProjector.updateAgentFacts(agentFacts);
        return;
      }
      this.subscriptions.delete(key);
      await existing.subscription.unsubscribe();
    } else if (existing !== undefined) await existing.subscription.unsubscribe();
    // A permission lease can be replaced while a terminal SessionEvent page is
    // already projected.  Retain that exact, replayable Session projection
    // until a replacement subscription has actually been accepted.  It is not
    // a second ledger: it remains process-local and is discarded whenever the
    // persisted Room run points at a different Session.
    const retainedProjector = this.projectors.get(key);
    if (retainedProjector !== undefined && retainedProjector.projectedSessionId !== session.id) {
      this.projectors.delete(key);
    }
    this.observedMessageIds.delete(session.id);
    const initialRoom = this.requireRoom(roomId);
    const initialRun = this.requireRun(initialRoom, runId);
    const projector = new ChatroomAgentSessionProjector(
      initialRoom,
      initialRun,
      session.id,
      (eventSeq, kind) => this.presentationSequenceForEvent(session.id, eventSeq, kind),
      agentFacts,
    );
    let active: RuntimeSubscription | undefined;
    const pendingPages: SessionSubscriptionPage[] = [];
    let observationTail = Promise.resolve();
    const observePage = async (page: SessionSubscriptionPage): Promise<void> => {
      if (active === undefined) {
        pendingPages.push(page);
        return;
      }
      const operation = observationTail.then(async () => {
        if (
          active === undefined
          || this.subscriptions.get(key) !== active
          || !this.isCurrent(generation)
        ) return;
        this.validateSessionPage(active, page);
        const currentRoom = this.requireRoom(roomId);
        projector.updateDomain(currentRoom, this.requireRun(currentRoom, runId));
        const projection = projector.project(page);
        await this.observe({ roomId, runId, page, projection });
        for (const listener of this.projectionListeners) listener(roomId);
        if (
          page.phase === 'live' && this.owners.has(key)
          && this.requireRun(currentRoom, runId).collaborationMode !== 'cli'
        ) {
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
      if (result.status === 'subscribed') await result.subscription.unsubscribe();
      return;
    }
    if (result.status !== 'subscribed') {
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
    // Only a successfully established subscription may replace a retained
    // display projector.  A transient replay denial must not publish a Room
    // snapshot that silently drops already projected SessionEvent facts.
    this.projectors.set(key, projector);
    this.subscriptions.set(key, active);
    this.localUnavailableRuns.delete(key);
    for (const page of pendingPages) await observePage(page);
    for (const listener of this.projectionListeners) listener(roomId);
    void result.subscription.closed.then(closed => this.handleSessionSubscriptionClosed(roomId, key, active!, closed));
  }

  private validateSessionPage(active: RuntimeSubscription, page: SessionSubscriptionPage): void {
    if (
      page.sessionId !== active.sessionId
      || page.sessionGeneration !== active.sessionGeneration
      || page.subscriptionGeneration !== active.subscription.subscriptionGeneration
      || page.replayThrough !== active.subscription.replayThrough
      || (active.phase === 'live' && page.phase !== 'live')
    ) {
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
    roomId: string,
    key: string,
    active: RuntimeSubscription,
    closed: SessionSubscriptionClosed,
  ): Promise<void> {
    if (
      this.subscriptions.get(key) !== active
      || closed.sessionId !== active.sessionId
      || closed.sessionGeneration !== active.sessionGeneration
      || closed.subscriptionGeneration !== active.subscription.subscriptionGeneration
    ) return;
    this.subscriptions.delete(key);
    // `permission-revoked` and a same-Session `route-replaced` fence the live
    // owner and its answerers, not the durable SessionEvent facts. Keep that
    // exact projector until a new read-only replay replaces it (or the Room
    // run changes Session identity), so a V7 replacement cannot collapse to
    // domain-only items mid-terminal. detachRuntime() and a different
    // persisted SessionId still discard it deliberately.
    if (closed.code !== 'permission-revoked' && closed.code !== 'route-replaced') {
      this.projectors.delete(key);
    }
    if (closed.code === 'unsubscribed') return;
    // Permission decisions replace the issued lease, not the durable Session.
    // The next explicit action may resume that Session under refreshed grants.
    if (closed.code !== 'permission-revoked') this.localUnavailableRuns.set(key, closed.code);
    const owner = this.owners.get(key);
    this.owners.delete(key);
    this.settleSessionApprovals(active.sessionId);
    const answerer = this.approvalAnswerers.get(key);
    const authorityAnswerer = this.approvalAuthorityAnswerers.get(key);
    const requestResolver = this.approvalRequestResolvers.get(key);
    this.approvalAnswerers.delete(key);
    this.approvalAuthorityAnswerers.delete(key);
    this.approvalRequestResolvers.delete(key);
    await Promise.allSettled([
      ...(answerer === undefined ? [] : [answerer.dispose()]),
      ...(authorityAnswerer === undefined ? [] : [authorityAnswerer.dispose()]),
      ...(requestResolver === undefined ? [] : [requestResolver.dispose()]),
      ...(owner === undefined ? [] : [this.disposeOwner(key, owner.handle)]),
    ]);
    // An externally fenced Session invalidates the Room's full Shell
    // projection. Notify after its answerer/owner have been settled so the
    // source can reacquire the exact persisted Session and replay the durable
    // asked/decided facts instead of waiting for an unrelated later message.
    for (const listener of this.projectionListeners) listener(roomId);
  }

  private async openApprovalAnswerer(roomId: string, runId: string, agent: Agent): Promise<void> {
    const key = runKey(roomId, runId);
    const existing = this.approvalAnswerers.get(key);
    if (
      existing !== undefined
      && existing.agentId === agent.id
      && existing.agentGeneration === agent.generation
    ) return;
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

  private async openApprovalAuthorityAnswerer(
    roomId: string,
    runId: string,
    agent: Agent,
    member: RoomMembership,
  ): Promise<void> {
    const key = runKey(roomId, runId);
    const existing = this.approvalAuthorityAnswerers.get(key);
    if (
      existing !== undefined
      && existing.authority.agentId === agent.id
      && existing.authority.agentGeneration === agent.generation
      && existing.authority.definition.agentId === member.definition.agentId
      && existing.authority.definition.revision === member.definition.revision
    ) return;
    if (existing !== undefined) await existing.dispose();
    const answerer = await this.runtime.approvals.registerAuthorityAnswerer(
      { agent, definition: member.definition },
      async question => {
        const room = this.requireRoom(roomId);
        const authorityRun = this.requireRun(room, runId);
        const authorityMember = this.requireMember(room, authorityRun.memberId);
        const requesterRuns = room.runs.filter(candidate => candidate.sessionId === question.requester.sessionId);
        if (
          requesterRuns.length !== 1
          || question.authority.agentId !== agent.id
          || question.authority.sessionId !== agent.session.id
          || question.authority.agentGeneration !== agent.generation
          || question.authority.definition.agentId !== authorityMember.definition.agentId
          || question.authority.definition.revision !== authorityMember.definition.revision
        ) return 'unavailable';
        const requesterRun = requesterRuns[0];
        const requesterMember = this.requireMember(room, requesterRun.memberId);
        if (
          requesterMember.definition.agentId !== question.requester.definition.agentId
          || requesterMember.definition.revision !== question.requester.definition.revision
          || approvalAuthorityMemberIds(room, requesterMember.memberId)[0] !== authorityMember.memberId
        ) {
          return 'unavailable';
        }
        const pendingKey = this.authorityApprovalKey(question.requester.sessionId, question.id);
        if (this.pendingAuthorityApprovals.has(pendingKey)) return 'unavailable';
        this.projectors.get(runKey(roomId, requesterRun.runId))?.updateLiveApprovalQuestion(question);
        for (const listener of this.projectionListeners) listener(roomId);
        return await new Promise<ApprovalOutcome>(resolve => {
          this.pendingAuthorityApprovals.set(pendingKey, { question, resolve });
        });
      },
    );
    this.approvalAuthorityAnswerers.set(key, answerer);
  }

  private async openApprovalRequestResolver(
    roomId: string,
    runId: string,
    agent: Agent,
    member: RoomMembership,
  ): Promise<void> {
    const key = runKey(roomId, runId);
    const register = this.runtime.approvals.registerRequestResolver;
    // Older deterministic fixtures and legacy Host surfaces do not expose
    // approval/v3 yet; retain their frozen v1 path until the formal consumer
    // is mounted.
    if (typeof register !== 'function') return;
    const existing = this.approvalRequestResolvers.get(key);
    if (
      existing !== undefined
      && existing.registration.requester.agentId === agent.id
      && existing.registration.requester.sessionId === agent.session.id
      && existing.registration.requester.agentGeneration === agent.generation
      && existing.registration.requester.definition.agentId === member.definition.agentId
      && existing.registration.requester.definition.revision === member.definition.revision
    ) return;
    if (existing !== undefined) await existing.dispose();
    const registered = await register.call(
      this.runtime.approvals,
      { agent, definition: member.definition },
      async question =>
        routeChatroomDriverApproval({
          room: this.requireRoom(roomId),
          question,
          liveAgentForRun: candidateRunId => this.owners.get(runKey(roomId, candidateRunId))?.handle.agent,
        }),
    );
    if (registered.status !== 'registered') {
      throw new Error(`Chatroom approval request resolver was not registered: ${registered.code}`);
    }
    this.approvalRequestResolvers.set(key, registered.handle);
    void registered.handle.closed.then(closed => {
      if (this.approvalRequestResolvers.get(key) !== registered.handle) return;
      this.approvalRequestResolvers.delete(key);
      this.localUnavailableRuns.set(key, closed.code);
    }).catch(() => {
      if (this.approvalRequestResolvers.get(key) !== registered.handle) return;
      this.approvalRequestResolvers.delete(key);
      this.localUnavailableRuns.set(key, 'request-resolver-unavailable');
    });
  }

  protected async detachRuntime(roomId: string, runId: string): Promise<void> {
    const key = runKey(roomId, runId);
    const owner = this.owners.get(key);
    this.owners.delete(key);
    const subscription = this.subscriptions.get(key);
    const answerer = this.approvalAnswerers.get(key);
    const authorityAnswerer = this.approvalAuthorityAnswerers.get(key);
    const requestResolver = this.approvalRequestResolvers.get(key);
    this.subscriptions.delete(key);
    this.projectors.delete(key);
    this.approvalAnswerers.delete(key);
    this.approvalAuthorityAnswerers.delete(key);
    this.approvalRequestResolvers.delete(key);
    this.localUnavailableRuns.set(key, 'agent-replaced');
    if (owner !== undefined) this.settleSessionApprovals(owner.handle.agent.session.id);
    await Promise.allSettled([
      ...(subscription === undefined ? [] : [subscription.subscription.unsubscribe()]),
      ...(answerer === undefined ? [] : [answerer.dispose()]),
      ...(authorityAnswerer === undefined ? [] : [authorityAnswerer.dispose()]),
      ...(requestResolver === undefined ? [] : [requestResolver.dispose()]),
      ...(owner === undefined ? [] : [this.disposeOwner(key, owner.handle)]),
    ]);
  }

  private async disposeOwner(key: string, handle: AgentHandle): Promise<AgentMutationResult<'dispose'>> {
    await this.runtime.collaboration?.revoke(handle.agent.session.id);
    return handle.dispose({ mutationId: createChatroomOpaqueId('agent-dispose', key) });
  }

  protected userMessage(
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

  protected submit(agent: Agent, message: UserMessage, mode: ChatroomAgentSendMode): Promise<AgentAdmission> {
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
    const unavailable = new Set(
      room.runs
        .filter(run => this.isRunLocallyUnavailable(roomId, run.runId))
        .map(run => run.runId),
    );
    const dispatch = resolveExplicitRoomAgentDispatch(room, value, sourceRun.memberId, unavailable);
    if (dispatch.status !== 'resolved') return;
    for (const recipient of dispatch.recipients) {
      let targetRunId = recipient.runId;
      if (recipient.createRun) {
        targetRunId = createChatroomOpaqueId(
          'session-delegation-run',
          roomId,
          sourceRunId,
          String(eventSeq),
          recipient.memberId,
        );
        const nextRunId = targetRunId;
        await this.mutateRoom(roomId, current =>
          current.runs.some(run => run.runId === nextRunId)
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
        'session-delegation-message',
        roomId,
        sourceRunId,
        String(eventSeq),
        targetRunId,
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
}
