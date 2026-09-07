import type { AgentTaskApprovalBinding, AgentTaskOwnership } from '@cordisx/protocol/agent-task-binding/v1';
import type { Agent, AgentHandle } from '@cordisx/protocol/agents/v1';
import type { ApprovalOutcome, ApprovalQuestion as LegacyQuestion } from '@cordisx/protocol/approval/v1';
import type { ApprovalQuestion } from '@cordisx/protocol/approval/v2';
import type { ApprovalRequestRoutingQuestion } from '@cordisx/protocol/approval/v3';
import type { JsonValue } from '@cordisx/protocol/sessions/v1';
import { ChatroomAgentSessionRuntimeController } from './agent-session-controller-runtime.js';
import { createRoom } from './room.js';
import { canonicalTaskValue, taskApprovalAuthorityMemberId } from './room-task-model.js';
import { runKey, type RuntimeAcquireFailure, type RuntimeOwner } from './agent-session-controller-internals.js';
import { routeChatroomDriverApproval } from './approval-bubble.js';

/** Required Host task bindings own approval registrations; accepted ownership reuses the existing controller. */
export class ChatroomAgentSessionTaskController extends ChatroomAgentSessionRuntimeController {
  private taskOwnership?: AgentTaskOwnership;

  setTaskOwnership(ownership: AgentTaskOwnership): void {
    this.taskOwnership = ownership;
  }

  protected override async ensureOwner(roomId: string, runId: string): Promise<RuntimeOwner | RuntimeAcquireFailure> {
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (
      run.delegation !== undefined && run.delegation.result?.status === 'accepted'
      && !this.owners.has(runKey(roomId, runId))
    ) {
      const acquired = await this.taskOwnership?.acquire({ operationId: run.delegation.request.operationId });
      if (acquired?.status !== 'acquired') {
        throw new Error('Accepted task ownership is unavailable; no Session was resumed or created.');
      }
      await this.adoptTaskOwnership(
        run.delegation.request.operationId,
        acquired.handle,
        run.delegation.request.tool.scope,
      );
    }
    return await super.ensureOwner(roomId, runId);
  }

  async adoptTaskOwnership(operationId: string, handle: AgentHandle, toolScope: JsonValue): Promise<void> {
    this.assertUsable();
    if (handle.agent.id !== handle.agent.session.id) throw new Error('Task ownership changed Session identity.');
    const generation = this.generation;
    const { roomId, runId } = this.requireTaskScope({ operationId, toolScope }, handle.agent.session.id);
    const run = this.requireRun(this.requireRoom(roomId), runId);
    if (run.delegation!.result?.status !== 'accepted') {
      throw new Error('Task ownership requires accepted first submission.');
    }
    const key = runKey(roomId, runId);
    const previous = this.owners.get(key);
    if (previous !== undefined && previous.handle.agent !== handle.agent) throw new Error('Task owner changed.');
    this.owners.set(key, { handle, disposition: 'retained' });
    await this.openSessionSubscription(roomId, runId, handle.agent.session, generation, {
      generation: handle.agent.generation,
      ...(handle.agent.detail === undefined ? {} : { details: handle.agent.detail }),
    });
    if (!this.isCurrent(generation)) throw new Error('Task owner generation was replaced.');
    this.localUnavailableRuns.delete(key);
  }

  async resolveTaskApproval(
    question: ApprovalRequestRoutingQuestion,
    binding: AgentTaskApprovalBinding,
    signal: AbortSignal,
  ) {
    const { roomId, runId } = await this.observeTaskScope(binding, question.requester.sessionId, signal);
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    const agents = new Map<string, Agent>();
    for (const candidate of room.runs) {
      if (candidate.sessionId === undefined) continue;
      const agent = await this.runtime.agents.get(candidate.sessionId);
      if (agent !== undefined) agents.set(candidate.runId, agent);
    }
    if (signal.aborted) throw new Error('Task approval routing was revoked.');
    const source = run.delegation!.source;
    // A child refers to the exact source task even when a Room contains several Leader tasks.
    const members = room.memberships.map(member =>
      !('kind' in source) && member.memberId === source.memberId ? { ...member, preferredRunId: source.runId } : member
    );
    const routedRoom = 'kind' in source
      ? room
      : createRoom({ ...room, memberships: [members[0], ...members.slice(1)] });
    return routeChatroomDriverApproval({ room: routedRoom, question, liveAgentForRun: id => agents.get(id) });
  }

  async answerTaskAuthority(
    question: ApprovalQuestion,
    binding: AgentTaskApprovalBinding,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const { roomId, runId } = await this.observeTaskScope(binding, question.authority.sessionId, signal);
    const room = this.requireRoom(roomId);
    const authorityMember = this.requireMember(room, this.requireRun(room, runId).memberId);
    const requesterRuns = room.runs.filter(run => run.sessionId === question.requester.sessionId);
    const requesterRun = requesterRuns.length === 1 ? requesterRuns[0] : undefined;
    const requesterMember = requesterRun === undefined ? undefined : this.requireMember(room, requesterRun.memberId);
    if (
      requesterRun === undefined || requesterMember === undefined
      || canonicalTaskValue(requesterMember.definition) !== canonicalTaskValue(question.requester.definition)
      || canonicalTaskValue(authorityMember.definition) !== canonicalTaskValue(question.authority.definition)
      || taskApprovalAuthorityMemberId(room, requesterRun) !== authorityMember.memberId
    ) return 'unavailable';
    const key = this.authorityApprovalKey(question.requester.sessionId, question.id);
    if (this.pendingAuthorityApprovals.has(key)) return 'unavailable';
    this.projectors.get(runKey(roomId, requesterRun.runId))?.updateLiveApprovalQuestion(question);
    const waiting = new Promise<ApprovalOutcome>(resolve =>
      this.pendingAuthorityApprovals.set(key, { question, resolve })
    );
    const abort = () => {
      this.pendingAuthorityApprovals.get(key)?.resolve('unavailable');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const listener of this.projectionListeners) listener(roomId);
    try {
      return await waiting;
    } finally {
      signal.removeEventListener('abort', abort);
      this.pendingAuthorityApprovals.delete(key);
    }
  }

  async answerTaskLegacy(
    question: LegacyQuestion,
    binding: AgentTaskApprovalBinding,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const { roomId } = await this.observeTaskScope(binding, question.sessionId, signal);
    const key = this.approvalKey(question.sessionId, question.agentGeneration, question.id);
    if (this.pendingApprovals.has(key)) return 'unavailable';
    const waiting = new Promise<ApprovalOutcome>(resolve => this.pendingApprovals.set(key, resolve));
    const abort = () => {
      this.pendingApprovals.get(key)?.('unavailable');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const listener of this.projectionListeners) listener(roomId);
    try {
      return await waiting;
    } finally {
      signal.removeEventListener('abort', abort);
      this.pendingApprovals.delete(key);
    }
  }

  private requireTaskScope(binding: AgentTaskApprovalBinding, sessionId: string) {
    this.assertUsable();
    const scope = binding.toolScope;
    if (
      scope === null || typeof scope !== 'object' || Array.isArray(scope)
      || typeof scope.roomId !== 'string' || typeof scope.runId !== 'string'
    ) throw new Error('Task scope is unavailable.');
    const room = this.requireRoom(scope.roomId);
    const run = this.requireRun(room, scope.runId);
    if (
      room.archived || run.delegation?.request.operationId !== binding.operationId
      || canonicalTaskValue(run.delegation.request.tool.scope) !== canonicalTaskValue(scope)
      || run.sessionId !== undefined && run.sessionId !== sessionId
    ) throw new Error('Task scope does not match the Room assignment.');
    return { roomId: scope.roomId, runId: scope.runId };
  }

  private async observeTaskScope(binding: AgentTaskApprovalBinding, sessionId: string, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Task binding was revoked.');
    const selection = this.requireTaskScope(binding, sessionId);
    await this.mutateRoom(selection.roomId, room => {
      if (signal.aborted) throw new Error('Task binding was revoked.');
      this.requireTaskScope(binding, sessionId);
      return createRoom({
        ...room,
        runs: room.runs.map(run => run.runId === selection.runId ? { ...run, sessionId } : run),
      });
    });
    await this.hydrateRoom(selection.roomId);
    if (signal.aborted) throw new Error('Task binding was revoked.');
    return selection;
  }
}
