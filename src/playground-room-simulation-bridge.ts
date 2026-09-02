import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';

import { ChatroomAgentLoopController } from './agent-loop-controller.js';
import {
  ChatroomConversationController,
  type ChatroomPlaygroundDelegationContext,
  type ChatroomPlaygroundAgentReplyCorrelation,
  type ChatroomPlaygroundSourceCorrelation,
  type ChatroomPlaygroundSourceInspection,
} from './conversation-source.js';
import {
  createChatroomOpaqueId,
  type Room,
  type RoomPlaygroundAgentApproval,
  type RoomPlaygroundAgentEgress,
} from './room.js';

export const PLAYGROUND_ROOM_SIMULATION_BRIDGE_SERVICE = 'playgroundRoomSimulationBridge' as const;
export const PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT =
  'cordisx.playground-room-simulation-binding/v1' as const;

export interface PlaygroundRoomSimulationBinding extends ChatroomPlaygroundSourceCorrelation {
  readonly contract: typeof PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT;
}

export interface PlaygroundRoomSimulationUnavailable {
  readonly status: 'unavailable';
  readonly code: string;
  readonly message: string;
  readonly ownerGeneration?: string;
}

export interface PlaygroundRoomSimulationAvailable<Value> {
  readonly status: 'available';
  readonly ownerGeneration: string;
  readonly value: Value;
}

export type PlaygroundRoomSimulationResult<Value> =
  | PlaygroundRoomSimulationAvailable<Value>
  | PlaygroundRoomSimulationUnavailable;

export interface PlaygroundRoomSimulationInspection {
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly lifecycle: 'active' | 'archived' | 'deleted' | 'retired' | 'unavailable';
  readonly revision: number;
  readonly delegationTargets: readonly PlaygroundRoomSimulationDelegationTarget[];
  readonly reason?: string;
}

export interface PlaygroundRoomSimulationDelegationTarget {
  readonly memberId: string;
  readonly label: string;
}

export interface PlaygroundRoomSimulationOperationReceipt {
  readonly operationId: string;
  readonly phase: 'accepted' | 'pending' | 'completed' | 'failed' | 'rejected';
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly roomEntryId?: string;
  readonly messageId?: string;
  readonly approvalId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly terminal?: 'completed' | 'failed' | 'denied' | 'cancelled';
  readonly replayed?: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PlaygroundRoomSimulationEvent {
  readonly kind: string;
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly revision: number;
  readonly operationId?: string;
  readonly occurredAt?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PlaygroundRoomSimulationSnapshot {
  readonly binding: PlaygroundRoomSimulationBinding;
  readonly revision: number;
  readonly events: readonly PlaygroundRoomSimulationEvent[];
}

export interface PlaygroundRoomSimulationMessageInput { readonly text: string }
export interface PlaygroundRoomSimulationAgentReplyInput {
  readonly text: string;
  readonly correlation?: ChatroomPlaygroundAgentReplyCorrelation;
}
export interface PlaygroundRoomSimulationAgentApprovalRequest { readonly reason: string }
export interface PlaygroundRoomSimulationTaskDelegationInput {
  readonly memberId: string;
  readonly task: string;
}
export interface PlaygroundRoomSimulationPermissionRequest {
  readonly title: string;
  readonly rationale?: string;
  readonly kind?: 'command' | 'file-change' | 'external-action' | 'other';
  readonly detail?: Readonly<Record<string, unknown>>;
}
export type PlaygroundRoomSimulationPermissionDecision = 'allow' | 'deny' | 'cancel';

export interface PlaygroundRoomSimulationOwner {
  readonly ownerGeneration: string;
  inspect(binding: PlaygroundRoomSimulationBinding): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationInspection>>;
  injectMessage(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationMessageInput): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  emitAgentReply(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationAgentReplyInput): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  emitAgentApprovalRequest(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationAgentApprovalRequest): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  delegateTask(binding: PlaygroundRoomSimulationBinding, operationId: string, payload: PlaygroundRoomSimulationTaskDelegationInput): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  requestPermission(binding: PlaygroundRoomSimulationBinding, operationId: string, request: PlaygroundRoomSimulationPermissionRequest): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  decidePermission(binding: PlaygroundRoomSimulationBinding, operationId: string, approvalId: string, decision: PlaygroundRoomSimulationPermissionDecision): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>>;
  snapshot(binding: PlaygroundRoomSimulationBinding): Promise<PlaygroundRoomSimulationResult<PlaygroundRoomSimulationSnapshot>>;
  subscribe(binding: PlaygroundRoomSimulationBinding, listener: (event: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>) => void): () => void;
}

export interface PlaygroundRoomSimulationBridgeService {
  register(owner: PlaygroundRoomSimulationOwner): () => void;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_MESSAGE_LENGTH = 32_768;
const PROJECTION_WAIT_MS = 5_000;

const available = <Value>(ownerGeneration: string, value: Value): PlaygroundRoomSimulationAvailable<Value> =>
  Object.freeze({ status: 'available', ownerGeneration, value });

const unavailable = (
  ownerGeneration: string,
  code: string,
  message: string,
): PlaygroundRoomSimulationUnavailable => Object.freeze({
  status: 'unavailable', code, message, ownerGeneration,
});

const boundedText = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maximum ? value.trim() : undefined;

function normalizeAgentReplyCorrelation(
  value: unknown,
): Readonly<ChatroomPlaygroundAgentReplyCorrelation> | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some(key => key !== 'turnId'
    && key !== 'messageId' && key !== 'inReplyToMessageId')) return null;
  const fields = ['turnId', 'messageId', 'inReplyToMessageId'] as const;
  for (const field of fields) {
    if (record[field] !== undefined && boundedText(record[field], 512) === undefined) return null;
  }
  return Object.freeze({
    ...(record.turnId === undefined ? {} : { turnId: boundedText(record.turnId, 512)! }),
    ...(record.messageId === undefined ? {} : { messageId: boundedText(record.messageId, 512)! }),
    ...(record.inReplyToMessageId === undefined ? {} : {
      inReplyToMessageId: boundedText(record.inReplyToMessageId, 512)!,
    }),
  });
}

const bindingCorrelation = (binding: PlaygroundRoomSimulationBinding): ChatroomPlaygroundSourceCorrelation => ({
  roomId: binding.roomId,
  runId: binding.runId,
  memberId: binding.memberId,
  bindingId: binding.bindingId,
  ownerGeneration: binding.ownerGeneration,
  generation: binding.generation,
});

const agentEgressMatchesBinding = (
  egress: RoomPlaygroundAgentEgress,
  binding: PlaygroundRoomSimulationBinding,
): boolean => egress.runId === binding.runId
  && egress.memberId === binding.memberId
  && egress.shellBindingId === binding.bindingId
  && egress.ownerGeneration === binding.ownerGeneration
  && egress.shellGeneration === binding.generation;

const agentApprovalMatchesBinding = (
  approval: RoomPlaygroundAgentApproval,
  binding: PlaygroundRoomSimulationBinding,
): boolean => approval.runId === binding.runId
  && approval.memberId === binding.memberId
  && approval.shellBindingId === binding.bindingId
  && approval.ownerGeneration === binding.ownerGeneration
  && approval.shellGeneration === binding.generation;

function lifecycleFor(code: string): PlaygroundRoomSimulationInspection['lifecycle'] {
  if (code === 'archived') return 'archived';
  if (code === 'deleted') return 'deleted';
  if (code === 'retired' || code === 'stale-binding' || code === 'generation-invalid') return 'retired';
  return 'unavailable';
}

function operationForItem(item: AgentConversationItem): string | undefined {
  return item.kind === 'message' && item.semantic.purpose === 'conversation'
    ? item.semantic.causation?.operationId
    : undefined;
}

function approvalForTurn(room: Room, runId: string, turn: string | undefined) {
  return turn === undefined ? undefined : room.items.find(item => item.kind === 'approval'
    && item.runId === runId && item.turn === turn);
}

function messageForOperation(room: Room, operationId: string) {
  return room.items.find(item => item.kind === 'message'
    && item.semantic.purpose === 'conversation'
    && item.semantic.causation?.operationId === operationId);
}

function deliveryForOperation(room: Room, operationId: string) {
  return room.deliveries.find(delivery => delivery.stage === 'send'
    && delivery.operationId === operationId);
}

function acknowledgementForDelivery(room: Room, operationId: string) {
  const delivery = deliveryForOperation(room, operationId);
  return delivery?.operation.kind === 'send'
    ? room.acknowledgements.find(item => item.acknowledgementKey === delivery.operation.acknowledgementKey)
    : undefined;
}

function receiptForOperation(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  operationId: string,
): PlaygroundRoomSimulationOperationReceipt {
  const message = messageForOperation(room, operationId);
  const delivery = deliveryForOperation(room, operationId);
  const acceptance = delivery?.acceptance?.kind === 'send' ? delivery.acceptance : undefined;
  const acknowledgement = acknowledgementForDelivery(room, operationId);
  const approval = approvalForTurn(room, binding.runId, acceptance?.turn);
  const terminal = approval?.kind === 'approval' && approval.state !== 'pending' && approval.state !== 'failed'
    ? approval.state === 'approved' ? 'completed' as const
      : approval.state === 'denied' ? 'denied' as const : 'cancelled' as const
    : acknowledgement?.state === 'completed' ? 'completed' as const
      : acknowledgement?.state === 'failed' ? 'failed' as const : undefined;
  const phase = approval?.kind === 'approval' && approval.state === 'pending'
    ? 'pending' as const
    : terminal === 'failed' ? 'failed' as const
      : terminal === undefined
        ? delivery?.state === 'accepted' ? 'accepted' as const : 'pending' as const
        : 'completed' as const;
  return Object.freeze({
    operationId,
    phase,
    binding,
    ...(message?.kind !== 'message' ? {} : { roomEntryId: message.itemId, messageId: message.messageId }),
    ...(approval?.kind !== 'approval' ? {} : { approvalId: approval.approvalId }),
    ...(acceptance === undefined ? {} : { turnId: acceptance.turn }),
    runId: binding.runId,
    ...(terminal === undefined ? {} : { terminal }),
    detail: Object.freeze({
      deliveryState: message?.kind === 'message' ? message.deliveryState : 'missing',
      runState: message?.kind === 'message' ? message.runState : 'missing',
      deliveryDisposition: acceptance?.disposition,
      acknowledgementState: acknowledgement?.state,
      acknowledgementDispatchState: acknowledgement?.dispatchState,
      approvalState: approval?.kind === 'approval' ? approval.state : undefined,
      failureCode: acknowledgement?.failureCode ?? delivery?.attention?.code,
    }),
  });
}

const agentEgressDeliveryId = (operationId: string) =>
  createChatroomOpaqueId('simulator-agent-egress-delivery', operationId);

const agentEgressAcknowledgementId = (operationId: string) =>
  createChatroomOpaqueId('simulator-agent-egress-ack', operationId);

function receiptForAgentEgress(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  egress: RoomPlaygroundAgentEgress,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const targetedDeliveries = (egress.recipients ?? []).map(recipient => {
    const delivery = room.deliveries.find(candidate => candidate.stage === 'send'
      && candidate.userItemId === egress.itemId
      && candidate.memberId === recipient.targetMemberId
      && candidate.runId === recipient.targetRunId);
    return Object.freeze({
      targetMemberId: recipient.targetMemberId,
      targetRunId: recipient.targetRunId,
      runCreated: recipient.runCreated,
      deliveryOperationId: delivery?.operationId,
      deliveryState: delivery?.state,
      deliveryDisposition: delivery?.acceptance?.disposition,
      failureCode: delivery?.attention?.code,
    });
  });
  const targeted = targetedDeliveries.length > 0;
  const failed = targetedDeliveries.some(delivery => delivery.deliveryState === 'attention');
  const accepted = targetedDeliveries.every(delivery => delivery.deliveryState === 'accepted');
  return Object.freeze({
    operationId: egress.operationId,
    phase: failed ? 'failed' as const : targeted && !accepted ? 'pending' as const : 'completed' as const,
    binding,
    roomEntryId: egress.itemId,
    messageId: egress.messageId,
    ...(egress.turnId === undefined ? {} : { turnId: egress.turnId }),
    runId: egress.runId,
    ...(!targeted || accepted ? { terminal: 'completed' as const } : {}),
    replayed,
    detail: Object.freeze({
      direction: targeted ? 'agent-to-agent' : 'agent-to-room',
      projectionState: 'projected',
      targetingMode: targeted ? 'explicit-mention' : 'room-only',
      recipients: Object.freeze(targetedDeliveries),
      deliveryId: agentEgressDeliveryId(egress.operationId),
      deliveryState: 'accepted',
      acknowledgementId: agentEgressAcknowledgementId(egress.operationId),
      acknowledgementState: 'completed',
      replayed,
      correlation: Object.freeze({
        ...(egress.turnId === undefined ? {} : { turnId: egress.turnId }),
        ...(egress.sourceMessageId === undefined ? {} : { messageId: egress.sourceMessageId }),
        ...(egress.inReplyToMessageId === undefined ? {} : {
          inReplyToMessageId: egress.inReplyToMessageId,
        }),
      }),
    }),
  });
}

function delegationContextText(context: ChatroomPlaygroundDelegationContext): string {
  return [
    '[Chatroom delegation context]',
    JSON.stringify({
      self: context.target,
      delegatedBy: context.source,
      reportsTo: context.reportsTo ?? null,
      availableTargets: context.availableTargets,
      communication: {
        mode: context.communicationMode,
        rule: 'Prefix an ordinary Room message with @<memberId-or-label> to deliver it only to that entity. Without @, the message is Room-visible only.',
      },
      approvals: {
        mode: context.approvalMode,
        next: context.reportsTo ?? null,
        rule: 'Approval and permission requests follow reportsToMemberId upward; they do not use arbitrary @ routing.',
      },
    }),
  ].join('\n');
}

function receiptForAgentDelegation(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  egress: RoomPlaygroundAgentEgress,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const delegation = egress.delegation!;
  const run = room.runs.find(candidate => candidate.runId === delegation.targetRunId);
  const delivery = room.deliveries.find(candidate => candidate.stage === 'send'
    && candidate.userItemId === egress.itemId
    && candidate.memberId === delegation.targetMemberId
    && candidate.runId === delegation.targetRunId);
  const acceptance = delivery?.acceptance?.kind === 'send' ? delivery.acceptance : undefined;
  const failed = delivery?.state === 'attention' || run?.status === 'failed';
  return Object.freeze({
    operationId: egress.operationId,
    phase: failed ? 'failed' as const : acceptance === undefined ? 'pending' as const : 'accepted' as const,
    binding,
    roomEntryId: egress.itemId,
    messageId: egress.messageId,
    ...(acceptance === undefined ? {} : { turnId: acceptance.turn }),
    runId: delegation.targetRunId,
    replayed,
    detail: Object.freeze({
      direction: 'agent-to-agent',
      requestOperationId: egress.operationId,
      sourceMemberId: egress.memberId,
      targetMemberId: delegation.targetMemberId,
      targetRunId: delegation.targetRunId,
      delegationContext: delegation.context,
      runCreated: true,
      task: run?.taskBinding?.task,
      detailsUrl: run?.detailsUrl,
      deliveryOperationId: delivery?.operationId,
      deliveryState: delivery?.state,
      deliveryDisposition: acceptance?.disposition,
      failureCode: delivery?.attention?.code,
      replayed,
    }),
  });
}

function receiptForAgentApproval(
  binding: PlaygroundRoomSimulationBinding,
  approval: RoomPlaygroundAgentApproval,
  operationId: string,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const terminal = approval.state === 'pending' ? undefined
    : approval.state === 'approved' ? 'completed' as const
      : approval.state;
  return Object.freeze({
    operationId,
    phase: terminal === undefined ? 'pending' as const : 'completed' as const,
    binding,
    roomEntryId: approval.itemId,
    approvalId: approval.approvalId,
    turnId: approval.turnId,
    runId: approval.runId,
    ...(terminal === undefined ? {} : { terminal }),
    replayed,
    detail: Object.freeze({
      direction: 'agent-to-room',
      requestOperationId: approval.operationId,
      projectionState: 'projected',
      approvalState: approval.state,
      replayed,
      decisionOperationIds: Object.freeze(approval.decisionAttempts.map(attempt => attempt.operationId)),
    }),
  });
}

function roomEvents(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  revision: number,
): readonly PlaygroundRoomSimulationEvent[] {
  const events: PlaygroundRoomSimulationEvent[] = [];
  for (const item of room.items) {
    const operationId = operationForItem(item);
    if (item.kind === 'message' && operationId !== undefined) {
      const egress = room.playgroundAgentEgresses?.find(candidate => candidate.itemId === item.itemId
        && candidate.operationId === operationId && agentEgressMatchesBinding(candidate, binding));
      events.push(Object.freeze({
        kind: egress?.delegation !== undefined ? 'room.agent-task-delegation.projected'
          : egress?.recipients !== undefined ? 'room.agent-message.targeted.projected'
          : egress !== undefined ? 'room.agent-egress.projected'
          : item.author.role === 'human' ? 'room.message.projected' : 'room.agent-message.projected',
        binding, revision, operationId, occurredAt: item.timestamp,
        detail: Object.freeze({
          entryId: item.itemId, messageId: item.messageId,
          deliveryState: item.deliveryState, runState: item.runState,
          authorRole: item.author.role,
          ...(egress === undefined ? {} : {
            direction: egress.delegation === undefined && egress.recipients === undefined
              ? 'agent-to-room' : 'agent-to-agent',
            memberId: egress.memberId,
            participantId: egress.participantId,
            ...(egress.recipients === undefined ? {} : {
              targetingMode: 'explicit-mention',
              recipients: Object.freeze(egress.recipients.map(recipient => Object.freeze({
                targetMemberId: recipient.targetMemberId,
                targetRunId: recipient.targetRunId,
              }))),
            }),
            ...(egress.delegation === undefined ? {} : {
              targetMemberId: egress.delegation.targetMemberId,
              targetRunId: egress.delegation.targetRunId,
            }),
            correlation: Object.freeze({
              ...(egress.turnId === undefined ? {} : { turnId: egress.turnId }),
              ...(egress.sourceMessageId === undefined ? {} : { messageId: egress.sourceMessageId }),
              ...(egress.inReplyToMessageId === undefined ? {} : {
                inReplyToMessageId: egress.inReplyToMessageId,
              }),
            }),
          }),
        }),
      }));
    }
    if (item.kind === 'approval' && item.runId === binding.runId) {
      const playgroundApproval = room.playgroundAgentApprovals?.find(candidate =>
        candidate.itemId === item.itemId && candidate.approvalId === item.approvalId
        && agentApprovalMatchesBinding(candidate, binding));
      if (playgroundApproval !== undefined) {
        const latestDecision = playgroundApproval.decisionAttempts.at(-1);
        const projectionDetail = Object.freeze({
          direction: 'agent-to-room',
          entryId: item.itemId,
          approvalId: item.approvalId,
          turnId: item.turn,
          approvalKind: item.approvalKind,
        });
        const lifecycleDetail = Object.freeze({
          ...projectionDetail,
          state: item.state,
          ...(latestDecision === undefined ? {} : {
            decisionOperationId: latestDecision.operationId,
            decision: latestDecision.decision,
          }),
        });
        events.push(Object.freeze({
          kind: 'room.agent-approval.projected',
          binding,
          revision,
          operationId: playgroundApproval.operationId,
          occurredAt: playgroundApproval.timestamp,
          detail: projectionDetail,
        }));
        events.push(Object.freeze({
          kind: item.state === 'pending'
            ? 'room.agent-approval.pending' : 'room.agent-approval.terminal',
          binding,
          revision,
          operationId: playgroundApproval.operationId,
          occurredAt: latestDecision?.timestamp ?? playgroundApproval.timestamp,
          detail: lifecycleDetail,
        }));
        continue;
      }
      const delivery = room.deliveries.find(candidate => candidate.stage === 'send'
        && candidate.runId === binding.runId && candidate.acceptance?.kind === 'send'
        && candidate.acceptance.turn === item.turn);
      events.push(Object.freeze({
        kind: item.state === 'pending' ? 'room.permission.pending' : 'room.permission.terminal',
        binding, revision,
        ...(delivery === undefined ? {} : { operationId: delivery.operationId }),
        detail: Object.freeze({
          entryId: item.itemId, approvalId: item.approvalId, turnId: item.turn,
          approvalKind: item.approvalKind, state: item.state,
        }),
      }));
    }
  }
  for (const delivery of room.deliveries) {
    if (delivery.stage !== 'send' || delivery.runId !== binding.runId) continue;
    events.push(Object.freeze({
      kind: delivery.state === 'accepted' ? 'room.delivery.accepted'
        : delivery.state === 'attention' ? 'room.delivery.failed' : 'room.delivery.pending',
      binding, revision, operationId: delivery.operationId, occurredAt: delivery.issuedAt,
      detail: Object.freeze({
        deliveryId: delivery.deliveryId, state: delivery.state,
        disposition: delivery.acceptance?.disposition,
        turnId: delivery.acceptance?.kind === 'send' ? delivery.acceptance.turn : undefined,
        messageId: delivery.acceptance?.kind === 'send' ? delivery.acceptance.messageId : undefined,
        failureCode: delivery.attention?.code,
      }),
    }));
    const acknowledgement = acknowledgementForDelivery(room, delivery.operationId);
    if (acknowledgement !== undefined) {
      events.push(Object.freeze({
        kind: acknowledgement.state === 'pending' ? 'room.ack.pending' : 'room.ack.terminal',
        binding, revision, operationId: delivery.operationId, occurredAt: acknowledgement.timestamp,
        detail: Object.freeze({
          acknowledgementKey: acknowledgement.acknowledgementKey,
          state: acknowledgement.state, dispatchState: acknowledgement.dispatchState,
          failureCode: acknowledgement.failureCode,
        }),
      }));
    }
  }
  for (const decision of room.approvalDecisions) {
    if (decision.runId !== binding.runId) continue;
    events.push(Object.freeze({
      kind: decision.state === 'completed' ? 'room.permission-decision.terminal' : 'room.permission-decision.accepted',
      binding, revision, operationId: decision.requestOperationId ?? decision.operationId,
      detail: Object.freeze({
        commandOperationId: decision.operationId, approvalId: decision.approvalId,
        turnId: decision.turn, decision: decision.decision, state: decision.state,
        disposition: decision.disposition, failureCode: decision.attention?.code,
      }),
    }));
  }
  for (const egress of room.playgroundAgentEgresses ?? []) {
    if (!agentEgressMatchesBinding(egress, binding)) continue;
    const common = {
      binding,
      revision,
      operationId: egress.operationId,
      occurredAt: egress.timestamp,
    } as const;
    if (egress.delegation !== undefined) {
      const delivery = room.deliveries.find(candidate => candidate.stage === 'send'
        && candidate.userItemId === egress.itemId
        && candidate.memberId === egress.delegation!.targetMemberId
        && candidate.runId === egress.delegation!.targetRunId);
      if (delivery?.state === 'accepted') {
        events.push(Object.freeze({
          kind: 'room.agent-task-delegation.accepted',
          ...common,
          detail: Object.freeze({
            direction: 'agent-to-agent',
            requestOperationId: egress.operationId,
            sourceMemberId: egress.memberId,
            targetMemberId: egress.delegation.targetMemberId,
            targetRunId: egress.delegation.targetRunId,
            deliveryOperationId: delivery.operationId,
            state: delivery.state,
            entryId: egress.itemId,
            messageId: egress.messageId,
          }),
        }));
      }
      continue;
    }
    if (egress.recipients !== undefined) {
      for (const recipient of egress.recipients) {
        const delivery = room.deliveries.find(candidate => candidate.stage === 'send'
          && candidate.userItemId === egress.itemId
          && candidate.memberId === recipient.targetMemberId
          && candidate.runId === recipient.targetRunId);
        if (delivery?.state !== 'accepted') continue;
        events.push(Object.freeze({
          kind: 'room.agent-message.targeted.accepted',
          ...common,
          detail: Object.freeze({
            direction: 'agent-to-agent',
            targetingMode: 'explicit-mention',
            sourceMemberId: egress.memberId,
            targetMemberId: recipient.targetMemberId,
            targetRunId: recipient.targetRunId,
            deliveryOperationId: delivery.operationId,
            state: delivery.state,
            entryId: egress.itemId,
            messageId: egress.messageId,
          }),
        }));
      }
      continue;
    }
    events.push(Object.freeze({
      kind: 'room.agent-egress.delivery.accepted',
      ...common,
      detail: Object.freeze({
        direction: 'agent-to-room',
        deliveryId: agentEgressDeliveryId(egress.operationId),
        state: 'accepted',
        entryId: egress.itemId,
        messageId: egress.messageId,
      }),
    }));
    events.push(Object.freeze({
      kind: 'room.agent-egress.ack.terminal',
      ...common,
      detail: Object.freeze({
        direction: 'agent-to-room',
        acknowledgementId: agentEgressAcknowledgementId(egress.operationId),
        state: 'completed',
        terminal: 'completed',
        entryId: egress.itemId,
        messageId: egress.messageId,
      }),
    }));
  }
  for (const approval of room.playgroundAgentApprovals ?? []) {
    if (!agentApprovalMatchesBinding(approval, binding)) continue;
    for (const attempt of approval.decisionAttempts) {
      events.push(Object.freeze({
        kind: 'room.agent-approval.decision.accepted',
        binding,
        revision,
        operationId: attempt.operationId,
        occurredAt: attempt.timestamp,
        detail: Object.freeze({
          direction: 'host-to-chatroom',
          requestOperationId: approval.operationId,
          entryId: approval.itemId,
          approvalId: approval.approvalId,
          turnId: approval.turnId,
          decision: attempt.decision,
          state: 'completed',
        }),
      }));
    }
  }
  const run = room.runs.find(candidate => candidate.runId === binding.runId);
  if (run !== undefined) {
    events.push(Object.freeze({
      kind: 'room.run.lifecycle', binding, revision,
      detail: Object.freeze({
        runId: run.runId, memberId: run.memberId, status: run.status,
        presence: run.presence.state, agentLoopCursor: run.agentLoopCursor,
        agentLoopBindingId: run.taskBinding?.binding.bindingId,
        agentLoopBindingGeneration: run.taskBinding?.binding.generation,
      }),
    }));
  }
  return Object.freeze(events);
}

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

  async inspect(binding: PlaygroundRoomSimulationBinding) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    return available(this.ownerGeneration, Object.freeze({
      binding,
      lifecycle: 'active' as const,
      revision: this.revision,
      delegationTargets: Object.freeze(inspection.inspection.room.memberships
        .filter(member => member.memberId !== binding.memberId)
        .map(member => Object.freeze({ memberId: member.memberId, label: member.label }))),
    }));
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
      bindingCorrelation(binding), operationId, payload.text,
    );
    if (plan.status === 'conflict') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({ code: plan.code }),
      }));
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>;
    try {
      outcome = await this.agentLoop.sendToRoom(
        binding.roomId, binding.runId, plan.userItemId,
        [{ kind: 'text', text: plan.text }], binding.generation, operationId,
      );
    } catch (error) {
      return this.ownerFailure('room-send-failed', 'Room message delivery failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding,
        roomEntryId: plan.userItemId, messageId: plan.messageId, runId: binding.runId,
        terminal: 'failed' as const,
        detail: Object.freeze({ code: outcome.code, status: outcome.status }),
      }));
    }
    const room = this.agentLoop.rooms.get(binding.roomId);
    if (room === undefined) return unavailable(this.ownerGeneration, 'deleted', 'The Room was deleted during injection.');
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
        bindingCorrelation(binding), operationId, payload.text, correlation,
      );
    } catch (error) {
      return this.ownerFailure('agent-egress-projection-failed', 'Room Agent reply projection failed', error);
    }
    if (projection.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({
          code: projection.code,
          direction: 'agent-to-room',
          ...(projection.status === 'target-error' ? { mention: projection.mention } : {}),
        }),
      }));
    }
    const outcomes: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>[] = [];
    for (const recipient of projection.recipients ?? []) {
      try {
        outcomes.push(await this.agentLoop.sendToRoom(
          binding.roomId,
          recipient.targetRunId,
          projection.itemId,
          [{ kind: 'text', text: recipient.content }],
          binding.generation,
        ));
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
      return available(this.ownerGeneration, Object.freeze({
        ...receiptForAgentEgress(binding, room, egress, projection.replayed),
        phase: 'failed' as const,
        detail: Object.freeze({
          ...receiptForAgentEgress(binding, room, egress, projection.replayed).detail,
          code: failure.code,
          status: failure.status,
        }),
      }));
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
        bindingCorrelation(binding), operationId, reason,
      );
    } catch (error) {
      return this.ownerFailure(
        'agent-approval-projection-failed', 'Room Agent approval projection failed', error,
      );
    }
    if (projection.status === 'conflict') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({ code: projection.code, direction: 'agent-to-room' }),
      }));
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
    if (targetMemberId === undefined || task === undefined
      || Object.keys(record).some(key => key !== 'memberId' && key !== 'task')) {
      return unavailable(this.ownerGeneration, 'invalid-request', 'The task delegation request is invalid.');
    }
    let projection: Awaited<ReturnType<ChatroomConversationController['projectPlaygroundAgentDelegation']>>;
    try {
      projection = await this.conversation.projectPlaygroundAgentDelegation(
        bindingCorrelation(binding), operationId, targetMemberId, task,
      );
    } catch (error) {
      return this.ownerFailure('agent-delegation-projection-failed', 'Agent task delegation projection failed', error);
    }
    if (projection.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({
          code: projection.status === 'missing-target' ? 'delegation-target-unavailable' : projection.code,
          direction: 'agent-to-agent',
        }),
      }));
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
    if (room === undefined) return unavailable(this.ownerGeneration, 'deleted', 'The Room was deleted during task delegation.');
    const egress = room.playgroundAgentEgresses?.find(candidate => candidate.operationId === operationId);
    if (egress === undefined || egress.delegation === undefined) {
      return unavailable(this.ownerGeneration, 'projection-missing', 'The delegated task projection is unavailable.');
    }
    if (outcome.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        ...receiptForAgentDelegation(binding, room, egress, projection.replayed),
        phase: 'rejected' as const,
        detail: Object.freeze({
          ...receiptForAgentDelegation(binding, room, egress, projection.replayed).detail,
          code: outcome.code,
          status: outcome.status,
        }),
      }));
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
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({ code: 'permission-kind-unavailable' }),
      }));
    }
    if (request.detail !== undefined && Object.keys(request.detail).length > 0) {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({ code: 'permission-detail-unavailable' }),
      }));
    }
    const title = boundedText(request.title, 512);
    const rationale = request.rationale === undefined ? undefined : boundedText(request.rationale, 4_096);
    const visibleText = title === undefined ? undefined
      : rationale === undefined ? title : `${title}\n${rationale}`;
    const inputError = this.inputError(operationId, visibleText);
    if (inputError !== undefined || visibleText === undefined) {
      return inputError ?? unavailable(this.ownerGeneration, 'invalid-request', 'The permission request is invalid.');
    }
    const plan = this.conversation.planPlaygroundMessage(
      bindingCorrelation(binding), operationId, visibleText,
    );
    if (plan.status === 'conflict') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, runId: binding.runId,
        detail: Object.freeze({ code: plan.code }),
      }));
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['sendToRoom']>>;
    try {
      outcome = await this.agentLoop.sendToRoom(
        binding.roomId, binding.runId, plan.userItemId,
        [{ kind: 'text', text: `${visibleText}\n[approval]` }], binding.generation, operationId,
      );
    } catch (error) {
      return this.ownerFailure('permission-send-failed', 'Room permission delivery failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding,
        roomEntryId: plan.userItemId, messageId: plan.messageId, runId: binding.runId,
        terminal: 'failed' as const,
        detail: Object.freeze({ code: outcome.code, status: outcome.status }),
      }));
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
      return available(this.ownerGeneration, Object.freeze({
        ...receiptForOperation(binding, currentRoom, operationId),
        phase: 'rejected' as const,
        terminal: 'failed' as const,
        detail: Object.freeze({ code: 'approval-not-projected' }),
      }));
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
    const mapped = decision === 'allow' ? 'approved' as const
      : decision === 'deny' ? 'denied' as const : 'cancelled' as const;
    let playgroundDecision: Awaited<ReturnType<ChatroomConversationController['decidePlaygroundAgentApproval']>>;
    try {
      playgroundDecision = await this.conversation.decidePlaygroundAgentApproval(
        bindingCorrelation(binding), operationId, approvalId, mapped,
      );
    } catch (error) {
      return this.ownerFailure(
        'agent-approval-decision-failed', 'Room Agent approval decision failed', error,
      );
    }
    if (playgroundDecision.status === 'conflict') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, approvalId, runId: binding.runId,
        detail: Object.freeze({
          code: playgroundDecision.code,
          direction: 'host-to-chatroom',
        }),
      }));
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
          binding, directApproval, operationId, playgroundDecision.replayed,
        ),
      );
    }
    const approval = inspection.inspection.room.items.find(item => item.kind === 'approval'
      && item.runId === binding.runId && item.approvalId === approvalId);
    if (approval?.kind !== 'approval') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding, approvalId, runId: binding.runId,
        detail: Object.freeze({ code: 'approval-missing' }),
      }));
    }
    if (approval.state !== 'pending') {
      return available(this.ownerGeneration, Object.freeze({
        operationId,
        phase: approval.state === mapped ? 'completed' as const : 'rejected' as const,
        binding, approvalId, turnId: approval.turn, runId: binding.runId,
        ...(approval.state === mapped ? { terminal: mapped === 'approved' ? 'completed' as const : mapped }
          : { detail: Object.freeze({ code: 'approval-conflict', current: approval.state }) }),
      }));
    }
    let outcome: Awaited<ReturnType<ChatroomAgentLoopController['decideApproval']>>;
    try {
      outcome = await this.agentLoop.decideApproval(
        binding.roomId, binding.runId, approval.turn, approval.approvalId, mapped, operationId,
      );
    } catch (error) {
      return this.ownerFailure('permission-decision-failed', 'Room permission decision failed', error);
    }
    if (outcome.status !== 'accepted') {
      return available(this.ownerGeneration, Object.freeze({
        operationId, phase: 'rejected' as const, binding,
        approvalId, turnId: approval.turn, runId: binding.runId,
        detail: Object.freeze({ code: outcome.code, status: outcome.status, commandOperationId: outcome.operationId }),
      }));
    }
    const terminalRoom = await this.waitForRoom(binding.roomId, room => {
      const item = room.items.find(candidate => candidate.kind === 'approval'
        && candidate.runId === binding.runId && candidate.approvalId === approvalId);
      return item?.kind === 'approval' && item.state !== 'pending';
    });
    const terminalApproval = terminalRoom?.items.find(item => item.kind === 'approval'
      && item.runId === binding.runId && item.approvalId === approvalId);
    return available(this.ownerGeneration, Object.freeze({
      operationId,
      phase: terminalApproval?.kind === 'approval' && terminalApproval.state !== 'pending'
        ? 'completed' as const : 'accepted' as const,
      binding, approvalId, turnId: approval.turn, runId: binding.runId,
      ...(terminalApproval?.kind === 'approval' && terminalApproval.state !== 'pending'
        ? { terminal: terminalApproval.state === 'approved' ? 'completed' as const
          : terminalApproval.state === 'denied' ? 'denied' as const : terminalApproval.state === 'cancelled' ? 'cancelled' as const : 'failed' as const }
        : {}),
      detail: Object.freeze({ commandOperationId: outcome.operationId }),
    }));
  }

  async snapshot(binding: PlaygroundRoomSimulationBinding) {
    const inspection = this.inspectInternal(binding);
    if (inspection.status === 'unavailable') return inspection;
    return available(this.ownerGeneration, Object.freeze({
      binding,
      revision: this.revision,
      events: roomEvents(binding, inspection.inspection.room, this.revision),
    }));
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
    | { readonly status: 'available'; readonly inspection: Extract<ChatroomPlaygroundSourceInspection, { readonly status: 'available' }> }
    | PlaygroundRoomSimulationUnavailable {
    if (this.disposed) return unavailable(this.ownerGeneration, 'owner-retired', 'The Chatroom owner is retired.');
    if (binding.contract !== PLAYGROUND_ROOM_SIMULATION_BINDING_CONTRACT
      || binding.ownerGeneration !== this.ownerGeneration) {
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

export function registerChatroomPlaygroundRoomSimulationOwner(
  service: PlaygroundRoomSimulationBridgeService,
  conversation: ChatroomConversationController,
  agentLoop: ChatroomAgentLoopController,
): () => void {
  let unregisterOwner: (() => void) | undefined;
  let owner: ChatroomPlaygroundRoomSimulationOwner | undefined;
  const unsubscribeGeneration = conversation.subscribeOwnerGeneration(ownerGeneration => {
    unregisterOwner?.();
    owner?.dispose();
    owner = new ChatroomPlaygroundRoomSimulationOwner(ownerGeneration, conversation, agentLoop);
    unregisterOwner = service.register(owner);
  });
  return () => {
    unsubscribeGeneration();
    unregisterOwner?.();
    owner?.dispose();
  };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly playgroundRoomSimulationBridge: PlaygroundRoomSimulationBridgeService;
  }
}
