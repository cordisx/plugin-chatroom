import { ChatroomRoomRegistry, type Room } from './room.js';

import {
  type ChatroomPlaygroundSourceCorrelation,
  type ChatroomPlaygroundSourceInspection,
} from './conversation-source-contract.js';

export interface PlaygroundRoomProjectionPort {
  readonly rooms: Pick<ChatroomRoomRegistry, 'get' | 'snapshot'>;
  inspectPlaygroundSource(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
  ): ChatroomPlaygroundSourceInspection;
  commitDirectRoom(room: Room): Promise<void>;
}
export interface PlaygroundDispatchProjectionPort extends PlaygroundRoomProjectionPort {
  locallyUnavailableRunIds(room: Room): ReadonlySet<string>;
  retireLocallyUnavailableRuns(room: Room, memberId: string): Room;
}

export const roomUsesOperationId = (room: Room, operationId: string): boolean =>
  room.items.some(item =>
    item.kind === 'message'
    && item.semantic.purpose === 'conversation'
    && item.semantic.causation?.operationId === operationId
  )
  || room.deliveries.some(delivery => delivery.operationId === operationId)
  || room.outbox.some(delivery =>
    delivery.send.operationId === operationId
    || (delivery.create.state !== 'not-required' && delivery.create.operationId === operationId)
  )
  || room.approvalDecisions.some(decision =>
    decision.operationId === operationId
    || decision.requestOperationId === operationId
  )
  || room.runs.some(run =>
    run.rebind?.operationId === operationId
    || run.selfIntroduction?.operationId === operationId
    || run.selfIntroduction?.cancellation?.operationId === operationId
  )
  || (room.playgroundAgentEgresses ?? []).some(egress => egress.operationId === operationId)
  || (room.playgroundAgentApprovals ?? []).some(approval =>
    approval.operationId === operationId
    || approval.decisionAttempts.some(attempt => attempt.operationId === operationId)
  );
