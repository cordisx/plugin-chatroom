import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';

import {
  type ChatroomPlaygroundAgentReplyCorrelation,
  type ChatroomPlaygroundDelegationContext,
  type ChatroomPlaygroundSourceCorrelation,
} from './conversation-source.js';
import {
  createChatroomOpaqueId,
  type Room,
  type RoomPlaygroundAgentApproval,
  type RoomPlaygroundAgentEgress,
} from './room.js';

import {
  type PlaygroundRoomSimulationAvailable,
  type PlaygroundRoomSimulationBinding,
  type PlaygroundRoomSimulationEvent,
  type PlaygroundRoomSimulationInspection,
  type PlaygroundRoomSimulationOperationReceipt,
  type PlaygroundRoomSimulationUnavailable,
} from './playground-room-simulation-contract.js';
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const MAX_MESSAGE_LENGTH = 32_768;
export const PROJECTION_WAIT_MS = 5_000;

export const available = <Value>(ownerGeneration: string, value: Value): PlaygroundRoomSimulationAvailable<Value> =>
  Object.freeze({ status: 'available', ownerGeneration, value });

export const unavailable = (
  ownerGeneration: string,
  code: string,
  message: string,
): PlaygroundRoomSimulationUnavailable =>
  Object.freeze({
    status: 'unavailable',
    code,
    message,
    ownerGeneration,
  });

export const boundedText = (value: unknown, maximum: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maximum ? value.trim() : undefined;

export function normalizeAgentReplyCorrelation(
  value: unknown,
): Readonly<ChatroomPlaygroundAgentReplyCorrelation> | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).some(key =>
      key !== 'turnId'
      && key !== 'messageId' && key !== 'inReplyToMessageId'
    )
  ) return null;
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

export const bindingCorrelation = (binding: PlaygroundRoomSimulationBinding): ChatroomPlaygroundSourceCorrelation => ({
  ...(binding.sessionId === undefined ? {} : { sessionId: binding.sessionId }),
  roomId: binding.roomId,
  runId: binding.runId,
  memberId: binding.memberId,
  bindingId: binding.bindingId,
  ownerGeneration: binding.ownerGeneration,
  generation: binding.generation,
});

export const agentEgressMatchesBinding = (
  egress: RoomPlaygroundAgentEgress,
  binding: PlaygroundRoomSimulationBinding,
): boolean =>
  egress.runId === binding.runId
  && egress.memberId === binding.memberId
  && egress.shellBindingId === binding.bindingId
  && egress.ownerGeneration === binding.ownerGeneration
  && egress.shellGeneration === binding.generation;

export const agentApprovalMatchesBinding = (
  approval: RoomPlaygroundAgentApproval,
  binding: PlaygroundRoomSimulationBinding,
): boolean =>
  approval.runId === binding.runId
  && approval.memberId === binding.memberId
  && approval.shellBindingId === binding.bindingId
  && approval.ownerGeneration === binding.ownerGeneration
  && approval.shellGeneration === binding.generation;

export function lifecycleFor(code: string): PlaygroundRoomSimulationInspection['lifecycle'] {
  if (code === 'archived') return 'archived';
  if (code === 'deleted') return 'deleted';
  if (code === 'retired' || code === 'stale-binding' || code === 'generation-invalid') return 'retired';
  return 'unavailable';
}

export function operationForItem(item: AgentConversationItem): string | undefined {
  return item.kind === 'message' && item.semantic.purpose === 'conversation'
    ? item.semantic.causation?.operationId
    : undefined;
}

export function approvalForTurn(room: Room, runId: string, turn: string | undefined) {
  return turn === undefined ? undefined : room.items.find(item =>
    item.kind === 'approval'
    && item.runId === runId && item.turn === turn
  );
}

export function messageForOperation(room: Room, operationId: string) {
  return room.items.find(item =>
    item.kind === 'message'
    && item.semantic.purpose === 'conversation'
    && item.semantic.causation?.operationId === operationId
  );
}

export function deliveryForOperation(room: Room, operationId: string) {
  return room.deliveries.find(delivery =>
    delivery.stage === 'send'
    && delivery.operationId === operationId
  );
}

export function acknowledgementForDelivery(room: Room, operationId: string) {
  const delivery = deliveryForOperation(room, operationId);
  const acknowledgementKey = delivery?.operation.kind === 'send'
    ? delivery.operation.acknowledgementKey
    : undefined;
  return acknowledgementKey !== undefined
    ? room.acknowledgements.find(item => item.acknowledgementKey === acknowledgementKey)
    : undefined;
}

export function receiptForOperation(
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
    ? approval.state === 'approved'
      ? 'completed' as const
      : approval.state === 'denied'
      ? 'denied' as const
      : 'cancelled' as const
    : acknowledgement?.state === 'completed'
    ? 'completed' as const
    : acknowledgement?.state === 'failed'
    ? 'failed' as const
    : undefined;
  const phase = approval?.kind === 'approval' && approval.state === 'pending'
    ? 'pending' as const
    : terminal === 'failed'
    ? 'failed' as const
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

export const agentEgressDeliveryId = (operationId: string) =>
  createChatroomOpaqueId('simulator-agent-egress-delivery', operationId);

export const agentEgressAcknowledgementId = (operationId: string) =>
  createChatroomOpaqueId('simulator-agent-egress-ack', operationId);

export function receiptForAgentEgress(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  egress: RoomPlaygroundAgentEgress,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const targetedDeliveries = (egress.recipients ?? []).map(recipient => {
    const delivery = room.deliveries.find(candidate =>
      candidate.stage === 'send'
      && candidate.userItemId === egress.itemId
      && candidate.memberId === recipient.targetMemberId
      && candidate.runId === recipient.targetRunId
    );
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

export function delegationContextText(context: ChatroomPlaygroundDelegationContext): string {
  return [
    '[Chatroom delegation context]',
    JSON.stringify({
      self: context.target,
      delegatedBy: context.source,
      reportsTo: context.reportsTo ?? null,
      availableTargets: context.availableTargets,
      communication: {
        mode: context.communicationMode,
        rule:
          'Prefix an ordinary Room message with @<memberId-or-label> to deliver it only to that entity. Without @, the message is Room-visible only.',
      },
      approvals: {
        mode: context.approvalMode,
        next: context.reportsTo ?? null,
        rule: 'Approval and permission requests follow reportsToMemberId upward; they do not use arbitrary @ routing.',
      },
    }),
  ].join('\n');
}

export function receiptForAgentDelegation(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  egress: RoomPlaygroundAgentEgress,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const delegation = egress.delegation!;
  const run = room.runs.find(candidate => candidate.runId === delegation.targetRunId);
  const delivery = room.deliveries.find(candidate =>
    candidate.stage === 'send'
    && candidate.userItemId === egress.itemId
    && candidate.memberId === delegation.targetMemberId
    && candidate.runId === delegation.targetRunId
  );
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

export function receiptForAgentApproval(
  binding: PlaygroundRoomSimulationBinding,
  approval: RoomPlaygroundAgentApproval,
  operationId: string,
  replayed: boolean,
): PlaygroundRoomSimulationOperationReceipt {
  const terminal = approval.state === 'pending'
    ? undefined
    : approval.state === 'approved'
    ? 'completed' as const
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

export function roomEvents(
  binding: PlaygroundRoomSimulationBinding,
  room: Room,
  revision: number,
): readonly PlaygroundRoomSimulationEvent[] {
  const events: PlaygroundRoomSimulationEvent[] = [];
  for (const item of room.items) {
    const operationId = operationForItem(item);
    if (item.kind === 'message' && operationId !== undefined) {
      const egress = room.playgroundAgentEgresses?.find(candidate =>
        candidate.itemId === item.itemId
        && candidate.operationId === operationId && agentEgressMatchesBinding(candidate, binding)
      );
      events.push(Object.freeze({
        kind: egress?.delegation !== undefined
          ? 'room.agent-task-delegation.projected'
          : egress?.recipients !== undefined
          ? 'room.agent-message.targeted.projected'
          : egress !== undefined
          ? 'room.agent-egress.projected'
          : item.author.role === 'human'
          ? 'room.message.projected'
          : 'room.agent-message.projected',
        binding,
        revision,
        operationId,
        occurredAt: item.timestamp,
        detail: Object.freeze({
          entryId: item.itemId,
          messageId: item.messageId,
          deliveryState: item.deliveryState,
          runState: item.runState,
          authorRole: item.author.role,
          ...(egress === undefined ? {} : {
            direction: egress.delegation === undefined && egress.recipients === undefined
              ? 'agent-to-room'
              : 'agent-to-agent',
            memberId: egress.memberId,
            participantId: egress.participantId,
            ...(egress.recipients === undefined ? {} : {
              targetingMode: 'explicit-mention',
              recipients: Object.freeze(egress.recipients.map(recipient =>
                Object.freeze({
                  targetMemberId: recipient.targetMemberId,
                  targetRunId: recipient.targetRunId,
                })
              )),
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
        && agentApprovalMatchesBinding(candidate, binding)
      );
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
            ? 'room.agent-approval.pending'
            : 'room.agent-approval.terminal',
          binding,
          revision,
          operationId: playgroundApproval.operationId,
          occurredAt: latestDecision?.timestamp ?? playgroundApproval.timestamp,
          detail: lifecycleDetail,
        }));
        continue;
      }
      const delivery = room.deliveries.find(candidate =>
        candidate.stage === 'send'
        && candidate.runId === binding.runId && candidate.acceptance?.kind === 'send'
        && candidate.acceptance.turn === item.turn
      );
      events.push(Object.freeze({
        kind: item.state === 'pending' ? 'room.permission.pending' : 'room.permission.terminal',
        binding,
        revision,
        ...(delivery === undefined ? {} : { operationId: delivery.operationId }),
        detail: Object.freeze({
          entryId: item.itemId,
          approvalId: item.approvalId,
          turnId: item.turn,
          approvalKind: item.approvalKind,
          state: item.state,
        }),
      }));
    }
  }
  for (const delivery of room.deliveries) {
    if (delivery.stage !== 'send' || delivery.runId !== binding.runId) continue;
    events.push(Object.freeze({
      kind: delivery.state === 'accepted'
        ? 'room.delivery.accepted'
        : delivery.state === 'attention'
        ? 'room.delivery.failed'
        : 'room.delivery.pending',
      binding,
      revision,
      operationId: delivery.operationId,
      occurredAt: delivery.issuedAt,
      detail: Object.freeze({
        deliveryId: delivery.deliveryId,
        state: delivery.state,
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
        binding,
        revision,
        operationId: delivery.operationId,
        occurredAt: acknowledgement.timestamp,
        detail: Object.freeze({
          acknowledgementKey: acknowledgement.acknowledgementKey,
          state: acknowledgement.state,
          dispatchState: acknowledgement.dispatchState,
          failureCode: acknowledgement.failureCode,
        }),
      }));
    }
  }
  for (const decision of room.approvalDecisions) {
    if (decision.runId !== binding.runId) continue;
    events.push(Object.freeze({
      kind: decision.state === 'completed' ? 'room.permission-decision.terminal' : 'room.permission-decision.accepted',
      binding,
      revision,
      operationId: decision.requestOperationId ?? decision.operationId,
      detail: Object.freeze({
        commandOperationId: decision.operationId,
        approvalId: decision.approvalId,
        turnId: decision.turn,
        decision: decision.decision,
        state: decision.state,
        disposition: decision.disposition,
        failureCode: decision.attention?.code,
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
      const delivery = room.deliveries.find(candidate =>
        candidate.stage === 'send'
        && candidate.userItemId === egress.itemId
        && candidate.memberId === egress.delegation!.targetMemberId
        && candidate.runId === egress.delegation!.targetRunId
      );
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
        const delivery = room.deliveries.find(candidate =>
          candidate.stage === 'send'
          && candidate.userItemId === egress.itemId
          && candidate.memberId === recipient.targetMemberId
          && candidate.runId === recipient.targetRunId
        );
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
      kind: 'room.run.lifecycle',
      binding,
      revision,
      detail: Object.freeze({
        runId: run.runId,
        memberId: run.memberId,
        status: run.status,
        presence: run.presence.state,
        agentLoopCursor: run.agentLoopCursor,
        agentLoopBindingId: run.taskBinding?.binding.bindingId,
        agentLoopBindingGeneration: run.taskBinding?.binding.generation,
      }),
    }));
  }
  return Object.freeze(events);
}
