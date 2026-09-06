import { ChatroomAgentLoopController } from './agent-loop-controller.js';
import { ChatroomConversationController, type ChatroomPlaygroundSourceInspection } from './conversation-source.js';
import { type Room } from './room.js';

import {
  PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT,
  type PlaygroundRoomSimulationAgentApprovalRequest,
  type PlaygroundRoomSimulationAgentReplyInput,
  type PlaygroundRoomSimulationBinding,
  type PlaygroundRoomSimulationEvent,
  type PlaygroundRoomSimulationMessageInput,
  type PlaygroundRoomSimulationOwner,
  type PlaygroundRoomSimulationPermissionDecision,
  type PlaygroundRoomSimulationPermissionRequest,
  type PlaygroundRoomSimulationResult,
  type PlaygroundRoomSimulationTaskDelegationInput,
  type PlaygroundRoomSimulationUnavailable,
} from './playground-room-simulation-contract.js';
import {
  approvalForTurn,
  available,
  bindingCorrelation,
  boundedText,
  delegationContextText,
  deliveryForOperation,
  lifecycleFor,
  MAX_MESSAGE_LENGTH,
  normalizeAgentReplyCorrelation,
  OPERATION_ID_PATTERN,
  PROJECTION_WAIT_MS,
  receiptForAgentApproval,
  receiptForAgentDelegation,
  receiptForAgentEgress,
  receiptForOperation,
  roomEvents,
  unavailable,
} from './playground-room-simulation-projection.js';
export class ChatroomPlaygroundRoomSimulationOwner implements PlaygroundRoomSimulationOwner {
  private revision = 1;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeRooms: () => void;

  constructor(
    readonly ownerGeneration: string,
    private readonly conversation: ChatroomConversationController,
    private readonly agentLoop: ChatroomAgentLoopController,
  ) {
    this.unsubscribeRooms = this.agentLoop.rooms.subscribe(() => {
      if (this.disposed) return;
      this.revision += 1;
      for (const listener of this.listeners) listener();
    });
  }

  async resolveSession(_sessionId: string) {
    return unavailable(
      this.ownerGeneration,
      'unsupported',
      'Legacy AgentLoop Rooms do not expose Agent Session bindings.',
    );
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

  async injectMessage(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationMessageInput,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    const inputError = this.inputError(operationId, payload.text);
    if (inputError !== undefined) return inputError;
    const plan = this.conversation.planPlaygroundMessage(
      bindingCorrelation(binding),
      operationId,
      payload.text,
    );
    if (plan.status === 'conflict') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({ code: plan.code }),
        }),
      );
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>;
    try {
      outcome = await this.agentLoop.sendToRoom(
        binding.roomId,
        binding.runId,
        plan.userItemId,
        [{ kind: 'text', text: plan.text }],
        binding.generation,
        operationId,
      );
    } catch (error) {
      return this.ownerFailure('room-send-failed', 'Room message delivery failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          roomEntryId: plan.userItemId,
          messageId: plan.messageId,
          runId: binding.runId,
          terminal: 'failed' as const,
          detail: Object.freeze({ code: outcome.code, status: outcome.status }),
        }),
      );
    }
    const room = this.agentLoop.rooms.get(binding.roomId);
    if (room === undefined) {
      return unavailable(this.ownerGeneration, 'deleted', 'The Room was deleted during injection.');
    }
    return available(this.ownerGeneration, receiptForOperation(binding, room, operationId));
  }

  async emitAgentReply(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentReplyInput,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    const inputError = this.inputError(operationId, payload.text);
    if (inputError !== undefined) return inputError;
    const correlation = normalizeAgentReplyCorrelation(payload.correlation);
    if (correlation === null) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The Agent reply correlation is invalid.');
    }
    let projection: Awaited<ReturnType<ChatroomConversationController['projectPlaygroundAgentReply']>>;
    try {
      projection = await this.conversation.projectPlaygroundAgentReply(
        bindingCorrelation(binding),
        operationId,
        payload.text,
        correlation,
      );
    } catch (error) {
      return this.ownerFailure('agent-egress-projection-failed', 'Room Agent reply projection failed', error);
    }
    if (projection.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({
            code: projection.code,
            direction: 'agent-to-room',
            ...(projection.status === 'target-error' ? { mention: projection.mention } : {}),
          }),
        }),
      );
    }
    const outcomes: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>[] = [];
    for (const recipient of projection.recipients ?? []) {
      try {
        outcomes.push(
          await this.agentLoop.sendToRoom(
            binding.roomId,
            recipient.targetRunId,
            projection.itemId,
            [{ kind: 'text', text: recipient.content }],
            binding.generation,
          ),
        );
      } catch (error) {
        return this.ownerFailure('agent-targeted-send-failed', 'Targeted Agent message delivery failed', error);
      }
    }
    const room = this.agentLoop.rooms.get(binding.roomId);
    const egress = room?.playgroundAgentEgresses
      ?.find(candidate => candidate.operationId === operationId);
    if (room === undefined || egress === undefined) {
      return unavailable(
        this.ownerGeneration,
        room === undefined ? 'deleted' : 'projection-missing',
        room === undefined
          ? 'The Room was deleted during Agent reply projection.'
          : 'The projected Agent reply correlation is unavailable.',
      );
    }
    const failure = outcomes.find(outcome => outcome.status !== 'accepted');
    if (failure !== undefined) {
      return available(
        this.ownerGeneration,
        Object.freeze({
          ...receiptForAgentEgress(binding, room, egress, projection.replayed),
          phase: 'failed' as const,
          detail: Object.freeze({
            ...receiptForAgentEgress(binding, room, egress, projection.replayed).detail,
            code: failure.code,
            status: failure.status,
          }),
        }),
      );
    }
    return available(
      this.ownerGeneration,
      receiptForAgentEgress(binding, room, egress, projection.replayed),
    );
  }

  async emitAgentApprovalRequest(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationAgentApprovalRequest,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return unavailable(this.ownerGeneration, 'invalid-operation-id', 'The operationId is invalid.');
    }
    const request = payload as unknown;
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The Agent approval request is invalid.');
    }
    const record = request as Readonly<Record<string, unknown>>;
    const reason = boundedText(record.reason, 4_096);
    if (reason === undefined || Object.keys(record).some(key => key !== 'reason')) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The Agent approval request is invalid.');
    }
    let projection: Awaited<ReturnType<ChatroomConversationController['projectPlaygroundAgentApprovalRequest']>>;
    try {
      projection = await this.conversation.projectPlaygroundAgentApprovalRequest(
        bindingCorrelation(binding),
        operationId,
        reason,
      );
    } catch (error) {
      return this.ownerFailure(
        'agent-approval-projection-failed',
        'Room Agent approval projection failed',
        error,
      );
    }
    if (projection.status === 'conflict') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({ code: projection.code, direction: 'agent-to-room' }),
        }),
      );
    }
    if (projection.status === 'missing') {
      return unavailable(
        this.ownerGeneration,
        'projection-missing',
        'The Agent approval projection is unavailable.',
      );
    }
    const room = this.agentLoop.rooms.get(binding.roomId);
    const approval = room?.playgroundAgentApprovals
      ?.find(candidate => candidate.operationId === operationId);
    if (room === undefined || approval === undefined) {
      return unavailable(
        this.ownerGeneration,
        room === undefined ? 'deleted' : 'projection-missing',
        room === undefined
          ? 'The Room was deleted during Agent approval projection.'
          : 'The projected Agent approval correlation is unavailable.',
      );
    }
    return available(
      this.ownerGeneration,
      receiptForAgentApproval(binding, approval, operationId, projection.replayed),
    );
  }

  async delegateTask(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    payload: PlaygroundRoomSimulationTaskDelegationInput,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return unavailable(this.ownerGeneration, 'invalid-operation-id', 'The operationId is invalid.');
    }
    const request = payload as unknown;
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The task delegation request is invalid.');
    }
    const record = request as Readonly<Record<string, unknown>>;
    const targetMemberId = boundedText(record.memberId, 512);
    const task = boundedText(record.task, MAX_MESSAGE_LENGTH);
    if (
      targetMemberId === undefined || task === undefined
      || Object.keys(record).some(key => key !== 'memberId' && key !== 'task')
    ) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The task delegation request is invalid.');
    }
    let projection: Awaited<ReturnType<ChatroomConversationController['projectPlaygroundAgentDelegation']>>;
    try {
      projection = await this.conversation.projectPlaygroundAgentDelegation(
        bindingCorrelation(binding),
        operationId,
        targetMemberId,
        task,
      );
    } catch (error) {
      return this.ownerFailure('agent-delegation-projection-failed', 'Agent task delegation projection failed', error);
    }
    if (projection.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({
            code: projection.status === 'missing-target' ? 'delegation-target-unavailable' : projection.code,
            direction: 'agent-to-agent',
          }),
        }),
      );
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>;
    try {
      outcome = await this.agentLoop.sendToRoom(
        binding.roomId,
        projection.targetRunId,
        projection.itemId,
        [
          { kind: 'text', text: delegationContextText(projection.context) },
          { kind: 'text', text: projection.text },
        ],
        binding.generation,
      );
    } catch (error) {
      return this.ownerFailure('agent-delegation-send-failed', 'Delegated task delivery failed', error);
    }
    const room = this.agentLoop.rooms.get(binding.roomId);
    if (room === undefined) {
      return unavailable(this.ownerGeneration, 'deleted', 'The Room was deleted during task delegation.');
    }
    const egress = room.playgroundAgentEgresses?.find(candidate => candidate.operationId === operationId);
    if (egress === undefined || egress.delegation === undefined) {
      return unavailable(this.ownerGeneration, 'projection-missing', 'The delegated task projection is unavailable.');
    }
    if (outcome.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          ...receiptForAgentDelegation(binding, room, egress, projection.replayed),
          phase: 'rejected' as const,
          detail: Object.freeze({
            ...receiptForAgentDelegation(binding, room, egress, projection.replayed).detail,
            code: outcome.code,
            status: outcome.status,
          }),
        }),
      );
    }
    return available(
      this.ownerGeneration,
      receiptForAgentDelegation(binding, room, egress, projection.replayed),
    );
  }

  async requestPermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    request: PlaygroundRoomSimulationPermissionRequest,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    if (request.kind !== undefined && request.kind !== 'command') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({ code: 'permission-kind-unavailable' }),
        }),
      );
    }
    if (request.detail !== undefined && Object.keys(request.detail).length > 0) {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({ code: 'permission-detail-unavailable' }),
        }),
      );
    }
    const title = boundedText(request.title, 512);
    const rationale = request.rationale === undefined ? undefined : boundedText(request.rationale, 4_096);
    const visibleText = title === undefined
      ? undefined
      : rationale === undefined
      ? title
      : `${title}\n${rationale}`;
    const inputError = this.inputError(operationId, visibleText);
    if (inputError !== undefined || visibleText === undefined) {
      return inputError ?? unavailable(this.ownerGeneration, 'invalid-request', 'The permission request is invalid.');
    }
    const plan = this.conversation.planPlaygroundMessage(
      bindingCorrelation(binding),
      operationId,
      visibleText,
    );
    if (plan.status === 'conflict') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          runId: binding.runId,
          detail: Object.freeze({ code: plan.code }),
        }),
      );
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>;
    try {
      outcome = await this.agentLoop.sendToRoom(
        binding.roomId,
        binding.runId,
        plan.userItemId,
        [{ kind: 'text', text: `${visibleText}\n[approval]` }],
        binding.generation,
        operationId,
      );
    } catch (error) {
      return this.ownerFailure('permission-send-failed', 'Room permission delivery failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          roomEntryId: plan.userItemId,
          messageId: plan.messageId,
          runId: binding.runId,
          terminal: 'failed' as const,
          detail: Object.freeze({ code: outcome.code, status: outcome.status }),
        }),
      );
    }
    const pending = await this.waitForRoom(binding.roomId, room => {
      const delivery = deliveryForOperation(room, operationId);
      const turn = delivery?.acceptance?.kind === 'send' ? delivery.acceptance.turn : undefined;
      return approvalForTurn(room, binding.runId, turn)?.kind === 'approval';
    });
    if (pending === undefined) {
      const currentRoom = this.agentLoop.rooms.get(binding.roomId);
      if (currentRoom === undefined) {
        return unavailable(this.ownerGeneration, 'deleted', 'The Room was deleted while awaiting approval projection.');
      }
      return available(
        this.ownerGeneration,
        Object.freeze({
          ...receiptForOperation(binding, currentRoom, operationId),
          phase: 'rejected' as const,
          terminal: 'failed' as const,
          detail: Object.freeze({ code: 'approval-not-projected' }),
        }),
      );
    }
    return available(this.ownerGeneration, receiptForOperation(binding, pending, operationId));
  }

  async decidePermission(
    binding: PlaygroundRoomSimulationBinding,
    operationId: string,
    approvalId: string,
    decision: PlaygroundRoomSimulationPermissionDecision,
  ) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    if (!OPERATION_ID_PATTERN.test(operationId) || boundedText(approvalId, 512) === undefined) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The permission decision correlation is invalid.');
    }
    const mapped = decision === 'allow'
      ? 'approved' as const
      : decision === 'deny'
      ? 'denied' as const
      : 'cancelled' as const;
    let playgroundDecision: Awaited<ReturnType<ChatroomConversationController['decidePlaygroundAgentApproval']>>;
    try {
      playgroundDecision = await this.conversation.decidePlaygroundAgentApproval(
        bindingCorrelation(binding),
        operationId,
        approvalId,
        mapped,
      );
    } catch (error) {
      return this.ownerFailure(
        'agent-approval-decision-failed',
        'Room Agent approval decision failed',
        error,
      );
    }
    if (playgroundDecision.status === 'conflict') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          approvalId,
          runId: binding.runId,
          detail: Object.freeze({
            code: playgroundDecision.code,
            direction: 'host-to-chatroom',
          }),
        }),
      );
    }
    if (playgroundDecision.status === 'accepted') {
      const room = this.agentLoop.rooms.get(binding.roomId);
      const directApproval = room?.playgroundAgentApprovals
        ?.find(candidate => candidate.approvalId === approvalId);
      if (room === undefined || directApproval === undefined) {
        return unavailable(
          this.ownerGeneration,
          room === undefined ? 'deleted' : 'projection-missing',
          room === undefined
            ? 'The Room was deleted during Agent approval decision.'
            : 'The decided Agent approval correlation is unavailable.',
        );
      }
      return available(
        this.ownerGeneration,
        receiptForAgentApproval(
          binding,
          directApproval,
          operationId,
          playgroundDecision.replayed,
        ),
      );
    }
    const approval = inspection.inspection.room.items.find(item =>
      item.kind === 'approval'
      && item.runId === binding.runId && item.approvalId === approvalId
    );
    if (approval?.kind !== 'approval') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          approvalId,
          runId: binding.runId,
          detail: Object.freeze({ code: 'approval-missing' }),
        }),
      );
    }
    if (approval.state !== 'pending') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: approval.state === mapped ? 'completed' as const : 'rejected' as const,
          binding,
          approvalId,
          turnId: approval.turn,
          runId: binding.runId,
          ...(approval.state === mapped
            ? { terminal: mapped === 'approved' ? 'completed' as const : mapped }
            : { detail: Object.freeze({ code: 'approval-conflict', current: approval.state }) }),
        }),
      );
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['decideApproval']>>;
    try {
      outcome = await this.agentLoop.decideApproval(
        binding.roomId,
        binding.runId,
        approval.turn,
        approval.approvalId,
        mapped,
        operationId,
      );
    } catch (error) {
      return this.ownerFailure('permission-decision-failed', 'Room permission decision failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(
        this.ownerGeneration,
        Object.freeze({
          operationId,
          phase: 'rejected' as const,
          binding,
          approvalId,
          turnId: approval.turn,
          runId: binding.runId,
          detail: Object.freeze({
            code: outcome.code,
            status: outcome.status,
            commandOperationId: outcome.operationId,
          }),
        }),
      );
    }
    const terminalRoom = await this.waitForRoom(binding.roomId, room => {
      const item = room.items.find(candidate =>
        candidate.kind === 'approval'
        && candidate.runId === binding.runId && candidate.approvalId === approvalId
      );
      return item?.kind === 'approval' && item.state !== 'pending';
    });
    const terminalApproval = terminalRoom?.items.find(item =>
      item.kind === 'approval'
      && item.runId === binding.runId && item.approvalId === approvalId
    );
    return available(
      this.ownerGeneration,
      Object.freeze({
        operationId,
        phase: terminalApproval?.kind === 'approval' && terminalApproval.state !== 'pending'
          ? 'completed' as const
          : 'accepted' as const,
        binding,
        approvalId,
        turnId: approval.turn,
        runId: binding.runId,
        ...(terminalApproval?.kind === 'approval' && terminalApproval.state !== 'pending'
          ? {
            terminal: terminalApproval.state === 'approved'
              ? 'completed' as const
              : terminalApproval.state === 'denied'
              ? 'denied' as const
              : terminalApproval.state === 'cancelled'
              ? 'cancelled' as const
              : 'failed' as const,
          }
          : {}),
        detail: Object.freeze({ commandOperationId: outcome.operationId }),
      }),
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
        events: roomEvents(binding, inspection.inspection.room, this.revision),
      }),
    );
  }

  subscribe(
    binding: PlaygroundRoomSimulationBinding,
    listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void,
  ): () => void {
    let live = true;
    const fingerprints = new Map<string, string>();
    const publish = () => {
      if (!live) return;
      const inspection = this.inspectInternal(binding);
      if (inspection.status === 'unavailable') {
        listener(inspection);
        return;
      }
      for (const event of roomEvents(binding, inspection.inspection.room, this.revision)) {
        const key = `${event.kind}\u0000${event.operationId ?? ''}\u0000${JSON.stringify(event.detail ?? {})}`;
        if (fingerprints.get(key) === key) continue;
        fingerprints.set(key, key);
        listener(available(this.ownerGeneration, event));
      }
    };
    queueMicrotask(publish);
    this.listeners.add(publish);
    return () => {
      live = false;
      this.listeners.delete(publish);
      fingerprints.clear();
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
    if (this.disposed) return unavailable(this.ownerGeneration, 'owner-retired', 'The Chatroom owner is retired.');
    if (
      binding.contract !== PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT
      || binding.ownerGeneration !== this.ownerGeneration
    ) {
      return unavailable(this.ownerGeneration, 'invalid-binding', 'The Playground Room binding is invalid or retired.');
    }
    const inspection = this.conversation.inspectPlaygroundSource(bindingCorrelation(binding));
    if (inspection.status === 'unavailable') {
      return unavailable(
        this.ownerGeneration,
        inspection.code,
        `The Playground Room source is ${lifecycleFor(inspection.code)} (${inspection.code}).`,
      );
    }
    return { status: 'available', inspection };
  }

  private inputError(operationId: string, text: unknown): PlaygroundRoomSimulationUnavailable | undefined {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return unavailable(this.ownerGeneration, 'invalid-operation-id', 'The operationId is invalid.');
    }
    if (boundedText(text, MAX_MESSAGE_LENGTH) === undefined) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The message payload is invalid.');
    }
    return undefined;
  }

  private ownerFailure(
    code: string,
    action: string,
    error: unknown,
  ): PlaygroundRoomSimulationUnavailable {
    const detail = error instanceof Error && error.message.trim() !== ''
      ? error.message.trim()
      : 'Unknown owner failure.';
    return unavailable(this.ownerGeneration, code, `${action}: ${detail}`);
  }

  private async waitForRoom(roomId: string, predicate: (room: Room) => boolean): Promise<Room | undefined> {
    const current = this.agentLoop.rooms.get(roomId);
    if (current !== undefined && predicate(current)) return current;
    return await new Promise<Room | undefined>(resolve => {
      let settled = false;
      const finish = (room: Room | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(room);
      };
      const unsubscribe = this.agentLoop.rooms.subscribe(changedRoomId => {
        if (changedRoomId !== roomId) return;
        const room = this.agentLoop.rooms.get(roomId);
        if (room !== undefined && predicate(room)) finish(room);
      });
      const timer = setTimeout(() => finish(undefined), PROJECTION_WAIT_MS);
    });
  }
}
