import { type RoomDispatchRecipient } from './room-target.js';
import { type Room } from './room.js';

export interface ChatroomCommandDelivery {
  readonly memberId: string;
  readonly runId: string;
  readonly runCreated: boolean;
  readonly reason: RoomDispatchRecipient['reason'];
}

export type ChatroomCommandIntent =
  | {
    readonly kind: 'send-message';
    readonly roomId: string;
    readonly roomCreated: boolean;
    readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly userItemId: string;
    readonly bindingId: string;
    readonly generation: string;
    readonly dispatchText: string;
  }
  | {
    readonly kind: 'approval-decision';
    readonly roomId: string;
    readonly runId: string;
    readonly turn: string;
    readonly approvalId: string;
    readonly decision: 'approved' | 'denied' | 'cancelled';
  }
  | {
    readonly kind: 'playground-approval-decision';
    readonly roomId: string;
    readonly itemId: string;
    readonly operationId: string;
    readonly decision: 'approved' | 'denied' | 'cancelled';
  }
  | {
    readonly kind: 'target-error';
    readonly roomId?: string;
    readonly code: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message';
    readonly mention?: string;
  };

export interface ChatroomPlaygroundSourceCorrelation {
  /** Exact Session identity for route-independent Room discovery. */
  readonly sessionId?: string;
  readonly roomId: string;
  readonly runId: string;
  readonly memberId: string;
  readonly bindingId: string;
  readonly ownerGeneration: string;
  readonly generation: string;
}

export type ChatroomPlaygroundSourceInspection =
  | {
    readonly status: 'available';
    readonly room: Room;
    readonly run: Room['runs'][number];
    readonly member: Room['memberships'][number];
  }
  | {
    readonly status: 'unavailable';
    readonly code:
      | 'missing'
      | 'deleted'
      | 'archived'
      | 'retired'
      | 'stale-binding'
      | 'generation-invalid'
      | 'correlation-invalid';
  };

export type ChatroomPlaygroundMessagePlan =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly userItemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly replayed: boolean;
  }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict'; };

export interface ChatroomPlaygroundAgentReplyCorrelation {
  readonly turnId?: string;
  readonly messageId?: string;
  readonly inReplyToMessageId?: string;
}

export type ChatroomPlaygroundAgentReplyProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly participantId: string;
    readonly itemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly timestamp: string;
    readonly replayed: boolean;
    readonly recipients?: readonly {
      readonly targetMemberId: string;
      readonly targetRunId: string;
      readonly content: string;
      readonly runCreated: boolean;
    }[];
    readonly turnId?: string;
    readonly sourceMessageId?: string;
    readonly inReplyToMessageId?: string;
  }
  | {
    readonly status: 'target-error';
    readonly code: 'missing' | 'ambiguous' | 'empty-targeted-message' | 'self-target';
    readonly mention: string;
  }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict'; };

export interface ChatroomPlaygroundDelegationContext {
  readonly source: { readonly memberId: string; readonly label: string; readonly runId: string; };
  readonly target: { readonly memberId: string; readonly label: string; readonly runId: string; };
  readonly reportsTo?: { readonly memberId: string; readonly label: string; };
  readonly availableTargets: readonly { readonly memberId: string; readonly label: string; }[];
  readonly communicationMode: 'explicit-mention-required';
  readonly approvalMode: 'reports-to-hierarchy';
}

export type ChatroomPlaygroundAgentDelegationProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly sourceRunId: string;
    readonly sourceMemberId: string;
    readonly sourceParticipantId: string;
    readonly targetRunId: string;
    readonly targetMemberId: string;
    readonly targetParticipantId: string;
    readonly itemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly context: ChatroomPlaygroundDelegationContext;
    readonly timestamp: string;
    readonly replayed: boolean;
  }
  | { readonly status: 'missing-target'; }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict'; };

export type ChatroomPlaygroundAgentApprovalProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly participantId: string;
    readonly itemId: string;
    readonly turnId: string;
    readonly approvalId: string;
    readonly reason: string;
    readonly state: 'pending' | 'approved' | 'denied' | 'cancelled';
    readonly timestamp: string;
    readonly replayed: boolean;
    readonly decisionOperationId?: string;
  }
  | { readonly status: 'missing'; }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict' | 'approval-conflict' | 'decision-capacity'; };
