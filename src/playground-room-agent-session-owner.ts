import { ChatroomAgentSessionController } from './agent-session-controller.js';
import { ChatroomConversationController, type ChatroomPlaygroundSourceInspection } from './conversation-source.js';
import { createChatroomOpaqueId } from './room.js';

import {
  PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
  type PlaygroundRoomSimulationAgentApprovalRequest,
  type PlaygroundRoomSimulationBinding,
  type PlaygroundRoomSimulationEvent,
  type PlaygroundRoomSimulationMessageInput,
  type PlaygroundRoomSimulationOwner,
  type PlaygroundRoomSimulationResult,
  type PlaygroundRoomSimulationTaskDelegationInput,
  type PlaygroundRoomSimulationUnavailable,
} from './playground-room-simulation-contract.js';
import {
  available,
  bindingCorrelation,
  boundedText,
  MAX_MESSAGE_LENGTH,
  OPERATION_ID_PATTERN,
  PROJECTION_WAIT_MS,
  unavailable,
} from './playground-room-simulation-projection.js';
/** SessionId-based Room discovery used by Host task details and Scenario Lab. */
export class ChatroomAgentSessionRoomSimulationOwner implements PlaygroundRoomSimulationOwner {
  private revision = 1;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeRooms: () => void;

  constructor(
    readonly ownerGeneration: string,
    private readonly conversation: ChatroomConversationController,
    private readonly agentSession: ChatroomAgentSessionController,
  ) {
    this.unsubscribeRooms = this.agentSession.rooms.subscribe(() => {
      if (this.disposed) return;
      this.revision += 1;
      for (const listener of this.listeners) listener();
    });
  }

  async resolveSession(sessionId: string) {
    if (this.disposed) return unavailable(this.ownerGeneration, 'owner-retired', 'The Chatroom owner is retired.');
    const matches = this.agentSession.rooms.snapshot().flatMap(room =>
      room.runs
        .filter(run => run.sessionId === sessionId)
        .map(run => ({ room, run }))
    );
    if (matches.length !== 1) {
      return unavailable(
        this.ownerGeneration,
        matches.length === 0 ? 'session-unbound' : 'session-ambiguous',
        matches.length === 0
          ? 'The Agent Session is not bound to an active Chatroom Room.'
          : 'The Agent Session is bound to more than one Chatroom Room run.',
      );
    }
    const { room, run } = matches[0]!;
    if (room.archived) {
      return unavailable(this.ownerGeneration, 'archived', 'The associated Chatroom Room is archived.');
    }
    const binding: PlaygroundRoomSimulationBinding = Object.freeze({
      contract: PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
      sessionId,
      roomId: room.id,
      runId: run.runId,
      memberId: run.memberId,
      bindingId: createChatroomOpaqueId('session-room-binding', sessionId, room.id, run.runId),
      ownerGeneration: this.ownerGeneration,
      generation: this.ownerGeneration,
    });
    const inspection = this.inspectInternal(binding);
    return inspection.status === 'unavailable'
      ? inspection
      : available(this.ownerGeneration, binding);
  }

  async inspect(binding: PlaygroundRoomSimulationBinding) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    return available(
      this.ownerGeneration,
      Object.freeze({
        binding,
        lifecycle: 'active' as const,
        revision: this.revision,
        delegationTargets: Object.freeze(
          inspection.inspection.room.memberships
            .filter(member => member.memberId !== binding.memberId)
            .map(member => Object.freeze({ memberId: member.memberId, label: member.label })),
        ),
      }),
    );
  }

  async delegateTask(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationTaskDelegationInput,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    if (
      !OPERATION_ID_PATTERN.test(operationId)
      || boundedText(payload.memberId, 512) === undefined
      || boundedText(payload.task, MAX_MESSAGE_LENGTH) === undefined
    ) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The task delegation request is invalid.');
    }
    const projection = await this.conversation.projectAgentSessionDelegation(
      bindingCorrelation(binding),
      operationId,
      payload.memberId.trim(),
      payload.task.trim(),
      this.agentSession.reservePresentationSequence(),
    );
    if (projection.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          detail: Object.freeze({
            code: projection.status === 'missing-target' ? 'delegation-target-unavailable' : projection.code,
          }),
        }),
      );
    }
    if (projection.replayed) {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'accepted' as const,
          binding,
          roomEntryId: projection.itemId,
          messageId: projection.messageId,
          runId: projection.targetRunId,
        }),
      );
    }
    const outcome = await this.agentSession.sendToRoom(
      binding.roomId,
      projection.targetRunId,
      projection.itemId,
      projection.text,
      'followup',
      'agent-delegation',
    );
    return available(
      this.ownerGeneration,
      Object.freeze({
        operationId,
        phase: outcome.status === 'accepted' ? 'accepted' as const : 'rejected' as const,
        binding,
        roomEntryId: projection.itemId,
        messageId: outcome.status === 'accepted' ? outcome.messageId : projection.messageId,
        runId: projection.targetRunId,
        ...(outcome.status === 'accepted' ? {} : {
          detail: Object.freeze({ code: outcome.code, status: outcome.status }),
        }),
      }),
    );
  }

  async injectMessage(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationMessageInput,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    const plan = this.conversation.planPlaygroundMessage(
      bindingCorrelation(binding),
      operationId,
      payload.text,
    );
    if (plan.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({ operationId, phase: 'rejected' as const, binding }));
    }
    const outcome = await this.agentSession.sendToRoom(
      binding.roomId,
      binding.runId,
      plan.userItemId,
      plan.text,
    );
    return available(
      this.ownerGeneration,
      Object.freeze({
        operationId,
        phase: outcome.status === 'accepted' ? 'accepted' as const : 'rejected' as const,
        binding,
        roomEntryId: plan.userItemId,
        messageId: outcome.status === 'accepted' ? outcome.messageId : plan.messageId,
        runId: binding.runId,
      }),
    );
  }

  async emitAgentReply() {
    return unavailable(
      this.ownerGeneration,
      'unsupported',
      'Direct Agent reply injection is unavailable for Agent Sessions.',
    );
  }

  async emitAgentApprovalRequest(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentApprovalRequest,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    const reason = boundedText(payload.reason, 4_096);
    if (!OPERATION_ID_PATTERN.test(operationId) || reason === undefined) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The Agent approval request is invalid.');
    }
    const prior = new Set(
      this.agentSession.projectionForRoom(binding.roomId).items
        .filter(item => item.kind === 'approval' && item.runId === binding.runId)
        .map(item => item.itemId),
    );
    const decision = this.agentSession.requestApproval(
      binding.roomId,
      binding.runId,
      'playground.room-simulation.agent-approval',
      reason,
      operationId,
    );
    void decision.catch(() => undefined);
    const item = await this.waitForApproval(binding.roomId, binding.runId, prior);
    if (item === undefined) {
      const settled = await Promise.race([
        decision,
        new Promise<undefined>(resolve => setTimeout(resolve, 0)),
      ]);
      return unavailable(
        this.ownerGeneration,
        settled?.status === 'unavailable' ? settled.code : 'approval-not-projected',
        'The exact Reviewer approval request could not be projected.',
      );
    }
    return available(
      this.ownerGeneration,
      Object.freeze({
        operationId,
        phase: item.state === 'pending' ? 'pending' as const : 'completed' as const,
        binding,
        roomEntryId: item.itemId,
        approvalId: item.approvalId,
        runId: item.runId,
        ...(item.state === 'pending' ? {} : {
          terminal: item.state === 'approved' ? 'completed' as const : item.state,
        }),
        detail: Object.freeze({
          direction: 'agent-to-room',
          requestOperationId: operationId,
          projectionState: 'session-event',
          requesterMemberId: item.memberId,
          authorityMemberId: 'authority' in item ? item.authority.memberId : undefined,
        }),
      }),
    );
  }

  async requestPermission() {
    return unavailable(
      this.ownerGeneration,
      'unsupported',
      'Synthetic permission requests are unavailable for Agent Sessions.',
    );
  }

  async decidePermission() {
    return unavailable(
      this.ownerGeneration,
      'unsupported',
      'Synthetic permission decisions are unavailable for Agent Sessions.',
    );
  }

  async snapshot(binding: PlaygroundRoomSimulationBinding) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    return available(
      this.ownerGeneration,
      Object.freeze({
        binding,
        revision: this.revision,
        events: Object.freeze([]),
      }),
    );
  }

  subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void {
    let live = true;
    const publish = () => {
      if (!live) return;
      const inspection = this.inspectInternal(binding);
      if (inspection.status === 'unavailable') listener(inspection);
    };
    this.listeners.add(publish);
    return () => {
      live = false;
      this.listeners.delete(publish);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRooms();
    this.listeners.clear();
  }

  private inspectInternal(binding: PlaygroundRoomSimulationBinding):
    | {
      readonly status: 'available';
      readonly inspection: Extract<ChatroomPlaygroundSourceInspection, { readonly status: 'available'; }>;
    }
    | PlaygroundRoomSimulationUnavailable
  {
    if (this.disposed || binding.ownerGeneration !== this.ownerGeneration || binding.sessionId === undefined) {
      return unavailable(
        this.ownerGeneration,
        'invalid-binding',
        'The Agent Session Room binding is invalid or retired.',
      );
    }
    const inspection = this.conversation.inspectPlaygroundSource(bindingCorrelation(binding));
    return inspection.status === 'available'
      ? { status: 'available', inspection }
      : unavailable(
        this.ownerGeneration,
        inspection.code,
        `The Chatroom Room source is unavailable (${inspection.code}).`,
      );
  }

  private async waitForApproval(
    roomId: string,
    runId: string,
    prior: ReadonlySet<string>,
  ) {
    const current = () =>
      this.agentSession.projectionForRoom(roomId).items.find(
        (item): item is Extract<typeof item, { readonly kind: 'approval'; }> =>
          item.kind === 'approval' && item.runId === runId && !prior.has(item.itemId),
      );
    const retained = current();
    if (retained !== undefined) return retained;
    return await new Promise<ReturnType<typeof current>>(resolve => {
      let settled = false;
      const finish = (value: ReturnType<typeof current>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.agentSession.subscribeProjection(changedRoomId => {
        if (changedRoomId !== roomId) return;
        const item = current();
        if (item !== undefined) finish(item);
      });
      const timer = setTimeout(() => finish(undefined), PROJECTION_WAIT_MS);
    });
  }
}
