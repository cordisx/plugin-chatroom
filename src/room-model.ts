import { type AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';
import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  AgentLoopApprovalDecision,
  AgentLoopTaskBinding,
  AgentLoopTaskDetailsUrl,
} from '@cordisx/protocol/agent-loop/v4';
import type { MessageId, SessionId } from '@cordisx/protocol/sessions/v1';
import { type AgentDefinitionIdentity } from './agent-definition.js';
import type { ChatroomAcknowledgeBehavior } from './engagement-config.js';

export type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';

export const AGENT_LOOP_TASK_BINDING_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json' as const;
export const AGENT_LOOP_TASK_BINDING_CONTRACT = 'cordisx.agent-loop-task-binding/v4' as const;

export const CHATROOM_SHELL_OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
export const AGENT_LOOP_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const encodeOpaqueIdPart = (value: string): string =>
  Array.from(value, character =>
    /^[A-Za-z0-9_-]$/.test(character)
      ? character
      : `~${character.codePointAt(0)!.toString(16)}~`).join('');

/** Stable collision-resistant-by-structure ID encoder for formal Shell fields. */
export function createChatroomOpaqueId(namespace: string, ...parts: readonly string[]): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) throw new Error('Opaque ID namespace is invalid.');
  const result = [namespace, ...parts.map(part => `${Array.from(part).length}.${encodeOpaqueIdPart(part)}`)].join('.');
  if (result.length > 512) throw new Error('Opaque ID exceeds the formal Shell limit.');
  return result;
}

export function requireShellOpaqueId(value: string, field: string): void {
  if (value.length < 1 || value.length > 512 || !CHATROOM_SHELL_OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a formal Shell opaque ID.`);
  }
}

export function requireAgentLoopOperationId(value: string, field: string): void {
  if (value.length < 1 || value.length > 128 || !AGENT_LOOP_OPERATION_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a formal AgentLoop operation ID.`);
  }
}

export type RoomRunStatus = 'creating' | 'active' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

/** Persisted formal navigation value returned by accepted create/bind. */
export type StoredRoomRunDetailsUrl = AgentLoopTaskDetailsUrl;

export interface RoomRunPresence {
  /** Stable for every lifecycle update of one Room/member/run relationship. */
  readonly eventKey: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  /** Stable public timeline position for in-place lifecycle replacement. */
  readonly sequence: number;
  readonly state: 'inviting' | 'creating' | 'joined' | 'ready' | 'failed';
  readonly attempt: number;
  readonly failure?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly diagnostic?: string;
    readonly retryCommand?: { readonly commandId: string; };
  };
}

export type RoomReactionValue =
  | { readonly kind: 'emoji'; readonly emoji: string; }
  | { readonly kind: 'semantic'; readonly value: string; };

export type RoomAcknowledgementPresentation =
  | {
    readonly kind: 'reaction';
    readonly source: 'chatroom-acknowledgement';
    readonly reactionId: string;
    readonly actorParticipantId: string;
    readonly value: RoomReactionValue;
    readonly state: 'pending' | 'completed' | 'failed';
  }
  | {
    readonly kind: 'canned-message';
    readonly source: 'chatroom-acknowledgement';
    readonly authorParticipantId: string;
    readonly authorMemberId: string;
    readonly text: string;
  }
  | { readonly kind: 'none'; readonly source: 'chatroom-acknowledgement'; };

export interface RoomAcknowledgement {
  /** Stable across reload and every pending/completed/failed replacement. */
  readonly acknowledgementKey: string;
  readonly userItemId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  /** Stable position for a canned acknowledgement item, or its target item. */
  readonly sequence: number;
  readonly timestamp: string;
  readonly behavior: ChatroomAcknowledgeBehavior;
  readonly state: 'pending' | 'completed' | 'failed';
  /** Persisted claim prevents a reload from blindly re-sending the delivery. */
  readonly dispatchState: 'pending' | 'sending' | 'accepted' | 'failed';
  readonly presentation: RoomAcknowledgementPresentation;
  readonly failureCode?: string;
}

export type RoomDeliveryPayload = null | boolean | number | string | readonly RoomDeliveryPayload[] | {
  readonly [key: string]: RoomDeliveryPayload;
};

export type RoomDeliveryAttentionCode =
  | 'details-unavailable'
  | 'operation-conflict'
  | 'reconciliation-required'
  | 'operation-expired'
  | 'provider-replaced'
  | 'create-denied'
  | 'create-unavailable'
  | 'send-denied'
  | 'send-unavailable';

export type RoomDeliveryOperation =
  | { readonly kind: 'create'; readonly payload: RoomDeliveryPayload; }
  | {
    readonly kind: 'send';
    readonly acknowledgementKey: string;
    readonly payload: RoomDeliveryPayload;
  };

export type RoomDeliveryAcceptance =
  | {
    readonly kind: 'create';
    readonly disposition: 'executed' | 'replayed' | 'reconciled';
    readonly firstObservedAt: string;
    readonly binding: AgentLoopTaskBinding;
    readonly detailsUrl: StoredRoomRunDetailsUrl;
  }
  | {
    readonly kind: 'send';
    readonly disposition: 'executed' | 'replayed' | 'reconciled';
    readonly firstObservedAt: string;
    readonly messageId: string;
    readonly turn: string;
  };

export interface RoomDelivery {
  readonly deliveryId: string;
  readonly operationId: string;
  readonly stage: 'create' | 'send';
  readonly userItemId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly issuedAt: string;
  readonly revision: number;
  /** Privacy-safe command correlation; never contains content or prompt sections. */
  readonly operation: RoomDeliveryOperation;
  /** SHA-256 of the exact canonical command used for replay/conflict checks. */
  readonly canonicalPayload: string;
  readonly state: 'planned' | 'sending-unknown' | 'accepted' | 'attention' | 'closed';
  readonly acceptance?: RoomDeliveryAcceptance;
  readonly attention?: {
    readonly code: RoomDeliveryAttentionCode;
    readonly diagnostic?: string;
  };
  readonly closedAt?: string;
  readonly closedBy?: 'host' | 'provider';
}

export type RoomOutboxStageState = 'planned' | 'sending-unknown' | 'accepted' | 'attention';

export type RoomOutboxCreateStage =
  | { readonly state: 'not-required'; }
  | {
    readonly operationId: string;
    /** Only this delivery plans the shared per-run create command. */
    readonly ownerDeliveryId: string;
    readonly state: RoomOutboxStageState;
  };

export interface RoomOutboxDelivery {
  readonly deliveryId: string;
  readonly userItemId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly acknowledgementKey: string;
  readonly create: RoomOutboxCreateStage;
  readonly acknowledge: { readonly state: 'pending' | 'completed' | 'failed'; };
  readonly send: { readonly operationId: string; readonly state: RoomOutboxStageState; };
}

export interface RoomImageReference {
  readonly itemId: string;
  readonly contentIndex: number;
  readonly kind: 'image-ref';
  readonly ref: string;
  readonly mediaType: `image/${string}`;
  readonly alt?: string;
  readonly state: 'unsupported';
}

/** Connector-issued references stay opaque and are scoped to one member. */
export type OpaqueConversationHandle = string & { readonly __opaqueConversationHandle: unique symbol; };
export type OpaqueRunHandle = string & { readonly __opaqueRunHandle: unique symbol; };

export interface RoomChannelLinkBase {
  readonly linkId: string;
  readonly conversation: OpaqueConversationHandle;
  readonly run?: OpaqueRunHandle;
  readonly state: 'active' | 'removed' | 'unavailable';
}

export type RoomChannelLink =
  | (RoomChannelLinkBase & { readonly scope: 'room'; })
  | (RoomChannelLinkBase & { readonly scope: 'member'; readonly memberId: string; });

export interface RoomMembership {
  readonly memberId: string;
  /** Frozen participant identity; it is not assumed to equal memberId. */
  readonly participantId: string;
  readonly label: string;
  /** Exact catalog identity; membership never embeds or mutates a definition. */
  readonly definition: AgentDefinitionIdentity;
  /** Effective Avatar is resolved once and frozen with this Room snapshot. */
  readonly avatar: AgentAvatarRef;
  readonly role: 'leader' | 'member';
  readonly attentionPolicy: 'ambient' | 'mention-only';
  readonly reportsToMemberId?: string;
  readonly preferredRunId?: string;
}

export interface RoomRun {
  readonly runId: string;
  readonly memberId: string;
  readonly title: string;
  readonly status: RoomRunStatus;
  /** Sole persisted identity for the Agent/Session runtime path. AgentId is identical. */
  readonly sessionId?: SessionId;
  /** One private AgentLoop task/session binding belongs to this run only. */
  readonly taskBinding?: AgentLoopTaskBinding;
  /** Persisted with the binding; closed historical runs retain this URL. */
  readonly detailsUrl?: StoredRoomRunDetailsUrl;
  /** Durable bind attempt; observer-only hydration never writes this field. */
  readonly rebind?: {
    /** Monotonic logical bind attempt for this persisted run. */
    readonly cycle: number;
    readonly operationId: string;
    readonly issuedAt: string;
    readonly canonicalPayload: string;
    readonly source: {
      readonly task: string;
      readonly bindingId: string;
      readonly generation: number;
    };
    readonly state: 'planned' | 'sending-unknown' | 'accepted' | 'attention';
    readonly acceptance?: {
      readonly firstObservedAt: string;
      readonly disposition: 'executed' | 'replayed' | 'reconciled';
    };
    readonly attention?: {
      readonly code:
        | 'reconciliation-required'
        | 'operation-conflict'
        | 'provider-replaced'
        | 'create-denied'
        | 'create-unavailable';
      readonly diagnostic?: string;
    };
  };
  /** Durable, model-owned free-form introduction request for this exact membership run. */
  readonly selfIntroduction?: RoomMemberSelfIntroduction;
  /** Chatroom correlation only; admission and completion remain SessionEvent facts. */
  readonly sessionSelfIntroduction?: RoomSessionSelfIntroduction;
  readonly presence: RoomRunPresence;
  /** Highest accepted AgentLoop event sequence for this exact binding. */
  readonly agentLoopCursor?: number;
  /** Durable semantic correlations survive the bounded public timeline window. */
  readonly publicProjections?: readonly RoomRunPublicProjection[];
}

export interface RoomSessionSelfIntroduction {
  readonly requestMessageId: MessageId;
  readonly correlationId: string;
  readonly requestedAt: string;
}

export type RoomMemberSelfIntroductionAttentionCode =
  | 'operation-conflict'
  | 'binding-conflict'
  | 'member-conflict'
  | 'run-conflict'
  | 'introduction-conflict'
  | 'introduction-completed'
  | 'introduction-cancelled'
  | 'reconciliation-required'
  | 'operation-expired'
  | 'provider-replaced'
  | 'binding-closed'
  | 'introduction-expired'
  | 'introduction-unavailable'
  | 'introduction-not-found'
  | 'user-denied'
  | 'policy-denied'
  | 'host-unavailable'
  | 'task-unavailable'
  | 'unsupported';

export interface RoomMemberSelfIntroduction {
  readonly operationId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  /** Exact binding used by the structurally replayable request. */
  readonly binding: AgentLoopTaskBinding;
  readonly state: 'planned' | 'sending-unknown' | 'accepted' | 'completed' | 'cancelled' | 'attention';
  readonly acceptance?: {
    readonly disposition: 'executed' | 'replayed' | 'reconciled';
    readonly turn: string;
    readonly messageId: string;
  };
  /** Event correlation can arrive before the accepted command result is durably committed. */
  readonly projection?: {
    readonly turn: string;
    readonly messageId: string;
  };
  readonly attention?: {
    readonly code: RoomMemberSelfIntroductionAttentionCode;
    readonly diagnostic?: string;
  };
  readonly cancellation?: {
    readonly operationId: string;
    readonly state: 'planned' | 'sending-unknown' | 'accepted' | 'attention';
    readonly disposition?: 'executed' | 'replayed' | 'reconciled';
    readonly attention?: {
      readonly code: RoomMemberSelfIntroductionAttentionCode;
      readonly diagnostic?: string;
    };
  };
}

export interface RoomApprovalDecision {
  readonly operationId: string;
  /** Optional caller correlation; the formal decision command keeps its deterministic operationId. */
  readonly requestOperationId?: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly binding: AgentLoopTaskBinding;
  readonly turn: string;
  readonly approvalId: string;
  readonly decision: AgentLoopApprovalDecision;
  readonly state: 'planned' | 'sending-unknown' | 'accepted' | 'completed' | 'attention';
  readonly disposition?: 'executed' | 'replayed' | 'reconciled';
  readonly attention?: {
    readonly code: string;
    readonly diagnostic?: string;
  };
}

/**
 * Durable correlation for one Playground-only Agent-authored Room projection.
 *
 * Every egress is projected into the public Room timeline. Explicit recipients
 * and task delegations may additionally submit the same correlated item to
 * another member run; Room-only egresses never create an AgentLoop delivery.
 */
export interface RoomPlaygroundAgentEgress {
  readonly operationId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly shellBindingId: string;
  readonly ownerGeneration: string;
  readonly shellGeneration: string;
  readonly itemId: string;
  readonly messageId: string;
  readonly text: string;
  readonly timestamp: string;
  readonly state: 'completed';
  readonly delegation?: {
    readonly targetMemberId: string;
    readonly targetRunId: string;
    /** Exact task delivered to the target Agent. Legacy records omit it. */
    readonly task?: string;
    /** Playground-only structured context delivered with the delegated task. */
    readonly context?: {
      readonly source: { readonly memberId: string; readonly label: string; readonly runId: string; };
      readonly target: { readonly memberId: string; readonly label: string; readonly runId: string; };
      readonly reportsTo?: { readonly memberId: string; readonly label: string; };
      readonly availableTargets: readonly { readonly memberId: string; readonly label: string; }[];
      readonly communicationMode: 'explicit-mention-required';
      readonly approvalMode: 'reports-to-hierarchy';
    };
  };
  /** Explicit Agent-authored @ recipients. Absence means Room-only visibility. */
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

export interface RoomPlaygroundAgentApprovalDecisionAttempt {
  readonly operationId: string;
  readonly decision: 'approved' | 'denied' | 'cancelled';
  readonly timestamp: string;
}

/** Durable Playground-only Agent approval card and its direct decisions. */
export interface RoomPlaygroundAgentApproval {
  readonly operationId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly shellBindingId: string;
  readonly ownerGeneration: string;
  readonly shellGeneration: string;
  readonly agentLoopBindingId: string;
  readonly agentLoopBindingGeneration: number;
  readonly itemId: string;
  readonly turnId: string;
  readonly approvalId: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly state: 'pending' | 'approved' | 'denied' | 'cancelled';
  readonly decisionAttempts: readonly RoomPlaygroundAgentApprovalDecisionAttempt[];
}

export const CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS = 4096 as const;
export const CHATROOM_MAX_APPROVAL_DECISIONS = 4096 as const;
export const CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES = 500 as const;
export const CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS = 500 as const;
export const CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS = 32 as const;
/**
 * Bounded Room-owned associations from Host-admitted Session messages back to
 * the pre-existing public human item.  This is intentionally not a second
 * message ledger: SessionEvent remains the execution fact and this only
 * supplies the exact durable display/dedup join for admission/v6 messages,
 * whose reservation request cannot carry a plugin correlation.
 */
export const CHATROOM_MAX_ADMISSION_MESSAGE_LINKS = 4096 as const;

export interface RoomAdmissionMessageLink {
  /** Repeated for an exact, self-validating association across owner-doc replay. */
  readonly roomId: string;
  readonly itemId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly sessionId: SessionId;
  readonly messageId: MessageId;
  /** Exact Host-stamped plugin provenance expected on the SessionEvent. */
  readonly owner: { readonly pluginId: string; readonly generation: number; };
  /**
   * Opaque projection item that was last visible when this later Room message
   * was admitted. It is an ordering fence only: no SessionEvent content,
   * timestamp, or Host-private state is copied into the Room document.
   */
  readonly appendAfterItemId?: string;
}

export type RoomRunPublicProjection = Readonly<{
  itemId: string;
  kind: 'message' | 'status' | 'approval';
  /** Bounded exact semantic association, independent of transport event ids. */
  association: string;
}>;

export function roomRunPublicProjectionForItem(
  item: Extract<AgentConversationItem, { kind: 'message' | 'status' | 'approval'; }>,
): RoomRunPublicProjection {
  return Object.freeze({
    itemId: item.itemId,
    kind: item.kind,
    association: item.kind === 'message'
      ? `agent:${item.author.participantId}`
      : item.kind === 'approval'
      ? `approval:${
        JSON.stringify({
          participantId: item.participantId,
          memberId: item.memberId,
          runId: item.runId,
          binding: item.binding,
          turn: item.turn,
          approvalId: item.approvalId,
          approvalKind: item.approvalKind,
        })
      }`
      : `status:${JSON.stringify({ label: item.label, state: item.state, ariaLive: item.ariaLive })}`,
  });
}

export function roomRunPublicProjectionMatchesItem(
  projection: RoomRunPublicProjection,
  item: AgentConversationItem,
): boolean {
  if (
    projection.kind !== item.kind || (item.kind === 'message'
      && (item.source !== 'agent-loop' || item.messageId !== projection.itemId || item.author.role !== 'agent'))
  ) {
    return false;
  }
  return projection.association === roomRunPublicProjectionForItem(item).association;
}

export interface RoomParticipant {
  readonly id: string;
  readonly name: string;
  readonly kind: 'human' | 'agent' | 'system';
  readonly avatar?: AgentAvatarRef;
}

export type RoomParticipantPresentation =
  | { readonly multiParticipant: false; readonly participantPresentation: 'none'; }
  | { readonly multiParticipant: true; readonly participantPresentation: 'none' | 'host-initials'; };

export interface Room {
  readonly id: string;
  readonly title: string;
  /** Durable sidebar management state. */
  readonly pinned: boolean;
  /** Archived Rooms remain durable and recoverable through their own collection. */
  readonly archived: boolean;
  /** Chatroom-owned descriptive metadata; Shell v2 intentionally does not project it. */
  readonly description?: string;
  readonly memberships: readonly [RoomMembership, ...RoomMembership[]];
  readonly seedLeaderIds: readonly string[];
  /** A member may have zero, one, or many private runs. */
  readonly runs: readonly RoomRun[];
  readonly acknowledgements: readonly RoomAcknowledgement[];
  readonly deliveries: readonly RoomDelivery[];
  readonly outbox: readonly RoomOutboxDelivery[];
  readonly approvalDecisions: readonly RoomApprovalDecision[];
  /** Exact admitted SessionEvent-to-Room-item associations; no message copy. */
  readonly admissionMessageLinks?: readonly RoomAdmissionMessageLink[];
  /** Present only when the loopback Playground bridge projected Agent egress. */
  readonly playgroundAgentEgresses?: readonly RoomPlaygroundAgentEgress[];
  /** Present only when the loopback Playground bridge projected Agent approvals. */
  readonly playgroundAgentApprovals?: readonly RoomPlaygroundAgentApproval[];
  /** Room-owned sequence for public timeline items only. */
  readonly timelineSequence: number;
  readonly imageReferences: readonly RoomImageReference[];
  readonly channelLinks: readonly RoomChannelLink[];
  readonly participants: readonly RoomParticipant[];
  readonly participantPresentation?: RoomParticipantPresentation;
  /** Public aggregate only; private tool/reasoning/session transcript is excluded. */
  readonly items: readonly AgentConversationItem[];
}

export type RoomMembershipInput = Omit<RoomMembership, 'avatar' | 'participantId'> & {
  readonly avatar?: AgentAvatarRef;
  readonly participantId?: string;
};

export type CreateRoomInput = {
  readonly id: string;
  readonly title: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly description?: string;
  readonly memberships?: readonly RoomMembershipInput[];
  readonly seedLeaderIds?: readonly string[];
  readonly runs?: readonly RoomRun[];
  readonly acknowledgements?: readonly RoomAcknowledgement[];
  readonly deliveries?: readonly RoomDelivery[];
  readonly outbox?: readonly RoomOutboxDelivery[];
  readonly approvalDecisions?: readonly RoomApprovalDecision[];
  readonly admissionMessageLinks?: readonly RoomAdmissionMessageLink[];
  readonly playgroundAgentEgresses?: readonly RoomPlaygroundAgentEgress[];
  readonly playgroundAgentApprovals?: readonly RoomPlaygroundAgentApproval[];
  readonly timelineSequence?: number;
  readonly imageReferences?: readonly RoomImageReference[];
  readonly channelLinks?: readonly RoomChannelLink[];
  readonly participants?: readonly RoomParticipant[];
  readonly participantPresentation?: RoomParticipantPresentation;
  readonly items?: readonly AgentConversationItem[];
};
