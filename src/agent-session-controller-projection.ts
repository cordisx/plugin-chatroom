import {
  acquireErrorCode,
  admissionLinkOrder,
  type Agent,
  approvalAuthorityMemberIds,
  type ApprovalOutcome,
  type ChatroomAgentSendMode,
  type ChatroomAgentSessionOutcome,
  type ChatroomApprovalCommandContext,
  type ChatroomApprovalRequestExecution,
  type ChatroomRoomSessionProjection,
  type ChatroomRoomSessionProjectionV6,
  createChatroomOpaqueId,
  type ProjectedItem,
  replacementAdmission,
  requestChatroomApproval,
  type Room,
  runKey,
} from './agent-session-controller-internals.js';
import { ChatroomAgentSessionControllerBase } from './agent-session-controller-base.js';

export abstract class ChatroomAgentSessionProjectionController extends ChatroomAgentSessionControllerBase {
  get ownerHandleCount(): number {
    return this.owners.size;
  }

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
    const linkedByItemId = new Map<string, {
      readonly item: ProjectedItem;
      readonly link: NonNullable<Room['admissionMessageLinks']>[number];
    }>();
    const unlinked: ProjectedItem[] = [];
    for (const projector of projectors) {
      for (const item of projector.snapshotItems()) {
        // The projector re-reads the authoritative SessionEvent and checks
        // plugin owner/generation before returning a link. Never dedupe an
        // arbitrary legacy-correlated message merely because ids collide.
        const link = projector.admissionMessageLinkForItem(item);
        if (link === undefined) {
          unlinked.push(item);
          continue;
        }
        const current = linkedByItemId.get(link.itemId);
        if (current === undefined || admissionLinkOrder(link, current.link) < 0) {
          linkedByItemId.set(link.itemId, { item, link });
        }
      }
    }
    const items = [...unlinked, ...[...linkedByItemId.values()].map(entry => entry.item)]
      .sort((left, right) => left.sequence - right.sequence);
    const admissionAppendAnchors = Object.freeze(
      [...linkedByItemId.values()]
        .flatMap(({ item, link }) =>
          link.appendAfterItemId === undefined
            ? []
            : [{ itemId: item.itemId, appendAfterItemId: link.appendAfterItemId }]
        )
        .sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
    );
    return Object.freeze({
      activeRuns: Object.freeze(projectors.map(projector => projector.activeRun())),
      // One Room human item may be admitted to N exact targets. Keep every
      // durable Session/message link for replay/fencing, but expose one stable
      // canonical SessionEvent projection rather than duplicating it N times.
      items: Object.freeze(items),
      ...(admissionAppendAnchors.length === 0 ? {} : { admissionAppendAnchors }),
    });
  }

  projectionForRoomV6(roomId: string): ChatroomRoomSessionProjectionV6 {
    const projection = this.projectionForRoom(roomId);
    return Object.freeze({
      activeRuns: projection.activeRuns,
      items: Object.freeze(projection.items.flatMap(item =>
        item.kind === 'approval' && 'requester' in item
          ? []
          : [item]
      )),
    });
  }

  answerApprovalItem(roomId: string, itemId: string, outcome: ApprovalOutcome): boolean {
    const room = this.rooms.get(roomId);
    if (room === undefined) return false;
    for (const run of room.runs) {
      const item = this.projectors.get(runKey(roomId, run.runId))?.approvalItem(itemId);
      if (item === undefined || item.state !== 'pending') continue;
      if ('authorityBinding' in item) {
        if (outcome !== 'allowed-once' && outcome !== 'rejected') return false;
        const key = this.authorityApprovalKey(item.sessionId, item.approvalId);
        const pending = this.pendingAuthorityApprovals.get(key);
        if (
          pending === undefined
          || pending.question.requester.agentGeneration !== item.agentGeneration
          || pending.question.authority.agentId !== item.authorityBinding.agentId
          || pending.question.authority.sessionId !== item.authorityBinding.sessionId
          || pending.question.authority.agentGeneration !== item.authorityBinding.agentGeneration
        ) return false;
        this.pendingAuthorityApprovals.delete(key);
        pending.resolve(outcome);
        return true;
      }
      const resolve = this.pendingApprovals.get(this.approvalKey(
        item.sessionId,
        item.agentGeneration,
        item.approvalId,
      ));
      if (resolve === undefined) return false;
      this.pendingApprovals.delete(this.approvalKey(item.sessionId, item.agentGeneration, item.approvalId));
      resolve(outcome);
      return true;
    }
    return false;
  }

  answerApprovalCommand(roomId: string, context: ChatroomApprovalCommandContext): boolean {
    const outcome = context.approval.decision === 'approve' ? 'allowed-once' : 'rejected';
    const room = this.rooms.get(roomId);
    if (room === undefined) return false;
    for (const run of room.runs) {
      const item = this.projectors.get(runKey(roomId, run.runId))?.approvalItem(context.itemId);
      if (item === undefined || item.state !== 'pending' || !('authorityBinding' in item)) continue;
      if (
        item.sessionId !== context.approval.sessionId
        || item.approvalId !== context.approval.approvalId
        || item.requester.agentId !== context.approval.requester.agentId
        || item.requester.revision !== context.approval.requester.revision
        || item.authorityBinding.agentId !== context.approval.authority.agentId
        || item.authorityBinding.sessionId !== context.approval.authority.sessionId
        || item.authorityBinding.agentGeneration !== context.approval.authority.agentGeneration
        || item.authorityBinding.definition.agentId !== context.approval.authority.definition.agentId
        || item.authorityBinding.definition.revision !== context.approval.authority.definition.revision
      ) return false;
      return this.answerApprovalItem(roomId, context.itemId, outcome);
    }
    return false;
  }

  /**
   * Starts one requester-authored approval against its exact reports-to Agent.
   * The returned promise settles only after the Host-owned authority answerer
   * decides or either live binding is fenced.
   */
  async requestApproval(
    roomId: string,
    requesterRunId: string,
    toolName: string,
    reason: string,
    callId?: string,
    signal?: AbortSignal,
  ): Promise<ChatroomApprovalRequestExecution> {
    this.assertUsable();
    let room = this.requireRoom(roomId);
    const requesterRun = this.requireRun(room, requesterRunId);
    const requesterMember = this.requireMember(room, requesterRun.memberId);
    const authorityMemberId = approvalAuthorityMemberIds(room, requesterMember.memberId)[0];
    if (authorityMemberId === undefined) {
      return { status: 'unavailable', code: 'authority-member-unavailable' };
    }
    const authorityMember = this.requireMember(room, authorityMemberId);
    const authorityRuns = room.runs.filter(run => run.memberId === authorityMember.memberId);
    const authorityRun = authorityMember.preferredRunId === undefined
      ? authorityRuns.length === 1 ? authorityRuns[0] : undefined
      : authorityRuns.find(run => run.runId === authorityMember.preferredRunId);
    if (authorityRun === undefined) {
      return { status: 'unavailable', code: 'authority-run-unavailable' };
    }
    const [requester, authority] = await Promise.all([
      this.ensureOwner(roomId, requesterRunId),
      this.ensureOwner(roomId, authorityRun.runId),
    ]);
    if (!('handle' in requester)) return { status: 'unavailable', code: 'requester-agent-mismatch' };
    if (!('handle' in authority)) return { status: 'unavailable', code: 'authority-agent-unavailable' };
    room = this.requireRoom(roomId);
    return await requestChatroomApproval(this.runtime.approvals, {
      room,
      requesterRunId,
      requesterAgent: requester.handle.agent,
      liveAgentForRun: runId => this.owners.get(runKey(roomId, runId))?.handle.agent,
      toolName,
      ...(callId === undefined ? {} : { callId }),
      reason,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  isRunLocallyUnavailable(roomId: string, runId: string): boolean {
    return this.localUnavailableRuns.has(runKey(roomId, runId));
  }

  /** Observer hydration reads SessionEvent replay and never claims mutation authority or writes Room state. */
  async hydrate(): Promise<void> {
    this.assertUsable();
    const generation = this.generation;
    for (const room of this.rooms.snapshot()) {
      if (!this.isCurrent(generation)) return;
      await this.hydrateRoom(room.id);
    }
  }

  /**
   * Rebuilds one mounted Room projection from its exact persisted SessionIds.
   * Concurrent Shell refreshes share the same read-only replay operation.
   */
  async hydrateRoom(roomId: string): Promise<void> {
    this.assertUsable();
    const retained = this.roomHydrations.get(roomId);
    if (retained !== undefined) return await retained;
    const generation = this.generation;
    const operation = this.hydrateRoomNow(roomId, generation);
    this.roomHydrations.set(roomId, operation);
    try {
      await operation;
    } finally {
      if (this.roomHydrations.get(roomId) === operation) this.roomHydrations.delete(roomId);
    }
  }

  private async hydrateRoomNow(roomId: string, generation: number): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    for (const run of room.runs) {
      if (run.sessionId === undefined || !this.isCurrent(generation)) continue;
      const key = runKey(roomId, run.runId);
      const active = this.subscriptions.get(key);
      if (active?.sessionId === run.sessionId && this.projectors.has(key)) continue;
      const session = await this.runtime.sessions.get(run.sessionId);
      if (!this.isCurrent(generation)) return;
      if (session === undefined) {
        this.localUnavailableRuns.set(key, 'session-unavailable');
        continue;
      }
      const agent = await this.runtime.agents.get(run.sessionId);
      if (!this.isCurrent(generation)) return;
      if (agent !== undefined && (agent.id !== run.sessionId || agent.session.id !== run.sessionId)) {
        throw new Error('Observed Agent changed the authoritative Session identity.');
      }
      const currentRun = this.rooms.get(roomId)?.runs.find(candidate => candidate.runId === run.runId);
      if (currentRun?.sessionId !== session.id) continue;
      await this.openSessionSubscription(roomId, run.runId, session, generation, {
        ...(agent === undefined ? {} : { generation: agent.generation }),
        ...(agent?.detail === undefined ? {} : { details: agent.detail }),
      });
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
    source: 'room-message' | 'agent-delegation' = 'room-message',
  ): Promise<ChatroomAgentSessionOutcome> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    const acquired = await this.ensureOwner(roomId, runId);
    if (!('handle' in acquired)) {
      return { status: acquired.status, roomId, runId, code: acquireErrorCode(acquired) };
    }
    const current = this.requireRun(this.requireRoom(roomId), runId);
    if (
      current.sessionSelfIntroduction === undefined
      || !this.observedMessageIds.get(acquired.handle.agent.session.id)
        ?.has(current.sessionSelfIntroduction.requestMessageId)
    ) {
      const introduction = await this.requestMemberSelfIntroduction(roomId, runId);
      if (
        introduction.status !== 'accepted'
        && !this.owners.has(runKey(roomId, runId))
      ) return introduction;
    }
    const messageId = createChatroomOpaqueId('room-session-message', userItemId, runId);
    const message = this.userMessage(
      acquired.handle,
      messageId,
      text,
      source === 'room-message' ? 'chatroom.room-message' : 'chatroom.agent-delegation',
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
      status: 'accepted',
      roomId,
      runId,
      messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }
}
