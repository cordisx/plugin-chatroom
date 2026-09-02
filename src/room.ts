import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  AgentLoopApprovalDecision,
  AgentLoopTaskBinding,
  AgentLoopTaskDetailsUrl,
} from '@cordisx/protocol/agent-loop/v4';
import {
  cloneAgentAvatarRef,
  createGeneratedAgentAvatarRef,
  type AgentAvatarRef,
} from '@cordisx/protocol/agent-avatar/v1';
import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  agentAvatarForDefinition,
  type AgentDefinitionIdentity,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import type { ChatroomAcknowledgeBehavior } from './engagement-config.js';

export type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';

export const AGENT_LOOP_TASK_BINDING_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json' as const;
export const AGENT_LOOP_TASK_BINDING_CONTRACT = 'cordisx.agent-loop-task-binding/v4' as const;

export const CHATROOM_SHELL_OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const AGENT_LOOP_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const encodeOpaqueIdPart = (value: string): string => Array.from(value, character =>
  /^[A-Za-z0-9_-]$/.test(character)
    ? character
    : `~${character.codePointAt(0)!.toString(16)}~`).join('');

/** Stable collision-resistant-by-structure ID encoder for formal Shell fields. */
export function createChatroomOpaqueId(namespace: string, ...parts: readonly string[]): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) throw new Error('Opaque ID namespace is invalid.');
  const result = [namespace, ...parts.map(part =>
    `${Array.from(part).length}.${encodeOpaqueIdPart(part)}`)].join('.');
  if (result.length > 512) throw new Error('Opaque ID exceeds the formal Shell limit.');
  return result;
}

function requireShellOpaqueId(value: string, field: string): void {
  if (value.length < 1 || value.length > 512 || !CHATROOM_SHELL_OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a formal Shell opaque ID.`);
  }
}

function requireAgentLoopOperationId(value: string, field: string): void {
  if (value.length < 1 || value.length > 128 || !AGENT_LOOP_OPERATION_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a formal AgentLoop operation ID.`);
  }
}

export type RoomRunStatus =
  | 'creating' | 'active' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

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
    readonly retryCommand?: { readonly commandId: string };
  };
}

export type RoomReactionValue =
  | { readonly kind: 'emoji'; readonly emoji: string }
  | { readonly kind: 'semantic'; readonly value: string };

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
  | { readonly kind: 'none'; readonly source: 'chatroom-acknowledgement' };

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

export type RoomDeliveryPayload =
  | null | boolean | number | string
  | readonly RoomDeliveryPayload[]
  | { readonly [key: string]: RoomDeliveryPayload };

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
  | { readonly kind: 'create'; readonly payload: RoomDeliveryPayload }
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
  | { readonly state: 'not-required' }
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
  readonly acknowledge: { readonly state: 'pending' | 'completed' | 'failed' };
  readonly send: { readonly operationId: string; readonly state: RoomOutboxStageState };
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
export type OpaqueConversationHandle = string & { readonly __opaqueConversationHandle: unique symbol };
export type OpaqueRunHandle = string & { readonly __opaqueRunHandle: unique symbol };

interface RoomChannelLinkBase {
  readonly linkId: string;
  readonly conversation: OpaqueConversationHandle;
  readonly run?: OpaqueRunHandle;
  readonly state: 'active' | 'removed' | 'unavailable';
}

export type RoomChannelLink =
  | (RoomChannelLinkBase & { readonly scope: 'room' })
  | (RoomChannelLinkBase & { readonly scope: 'member'; readonly memberId: string });

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
      readonly code: 'reconciliation-required' | 'operation-conflict' | 'provider-replaced' | 'create-denied' | 'create-unavailable';
      readonly diagnostic?: string;
    };
  };
  /** Durable, model-owned free-form introduction request for this exact membership run. */
  readonly selfIntroduction?: RoomMemberSelfIntroduction;
  readonly presence: RoomRunPresence;
  /** Highest accepted AgentLoop event sequence for this exact binding. */
  readonly agentLoopCursor: number;
  /** Durable semantic correlations survive the bounded public timeline window. */
  readonly publicProjections?: readonly RoomRunPublicProjection[];
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
      readonly source: { readonly memberId: string; readonly label: string; readonly runId: string };
      readonly target: { readonly memberId: string; readonly label: string; readonly runId: string };
      readonly reportsTo?: { readonly memberId: string; readonly label: string };
      readonly availableTargets: readonly { readonly memberId: string; readonly label: string }[];
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

export type RoomRunPublicProjection = Readonly<{
  itemId: string;
  kind: 'message' | 'status' | 'approval';
  /** Bounded exact semantic association, independent of transport event ids. */
  association: string;
}>;

export function roomRunPublicProjectionForItem(
  item: Extract<AgentConversationItem, { kind: 'message' | 'status' | 'approval' }>,
): RoomRunPublicProjection {
  return Object.freeze({
    itemId: item.itemId,
    kind: item.kind,
    association: item.kind === 'message'
      ? `agent:${item.author.participantId}`
      : item.kind === 'approval'
        ? `approval:${JSON.stringify({
          participantId: item.participantId,
          memberId: item.memberId,
          runId: item.runId,
          binding: item.binding,
          turn: item.turn,
          approvalId: item.approvalId,
          approvalKind: item.approvalKind,
        })}`
        : `status:${JSON.stringify({ label: item.label, state: item.state, ariaLive: item.ariaLive })}`,
  });
}

export function roomRunPublicProjectionMatchesItem(
  projection: RoomRunPublicProjection,
  item: AgentConversationItem,
): boolean {
  if (projection.kind !== item.kind || (item.kind === 'message'
    && (item.source !== 'agent-loop' || item.messageId !== projection.itemId || item.author.role !== 'agent'))) {
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
  | { readonly multiParticipant: false; readonly participantPresentation: 'none' }
  | { readonly multiParticipant: true; readonly participantPresentation: 'none' | 'host-initials' };

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

type RoomMembershipInput = Omit<RoomMembership, 'avatar' | 'participantId'> & {
  readonly avatar?: AgentAvatarRef;
  readonly participantId?: string;
};

type CreateRoomInput = {
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
  readonly playgroundAgentEgresses?: readonly RoomPlaygroundAgentEgress[];
  readonly playgroundAgentApprovals?: readonly RoomPlaygroundAgentApproval[];
  readonly timelineSequence?: number;
  readonly imageReferences?: readonly RoomImageReference[];
  readonly channelLinks?: readonly RoomChannelLink[];
  readonly participants?: readonly RoomParticipant[];
  readonly participantPresentation?: RoomParticipantPresentation;
  readonly items?: readonly AgentConversationItem[];
};

const sameIdentity = (left: AgentDefinitionIdentity, right: AgentDefinitionIdentity) =>
  left.agentId === right.agentId && left.revision === right.revision;

const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && sameIdentity(left.definition, right.definition);

function freezeTaskBinding(binding: AgentLoopTaskBinding): AgentLoopTaskBinding {
  return Object.freeze({
    ...binding,
    binding: Object.freeze({ ...binding.binding }),
    definition: Object.freeze({ ...binding.definition }),
  });
}

const presenceEventKey = (participantId: string, memberId: string, runId: string) =>
  createChatroomOpaqueId('member-presence', participantId, memberId, runId);

function freezeRun(run: RoomRun, member: RoomMembership): RoomRun {
  const presence = run.presence ?? {
    eventKey: presenceEventKey(member.participantId, run.memberId, run.runId),
    participantId: member.participantId,
    memberId: run.memberId,
    runId: run.runId,
    sequence: 0,
    state: run.status === 'failed' ? 'failed' : 'creating',
    attempt: 1,
  };
  const publicProjections = run.publicProjections ?? [];
  if (publicProjections.length > CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS) {
    throw new Error(`Room run exceeds its ${CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS}-projection replay limit.`);
  }
  if (new Set(publicProjections.map(projection => projection.itemId)).size !== publicProjections.length) {
    throw new Error('Room run public projection identities must be unique.');
  }
  for (const projection of publicProjections) {
    requireShellOpaqueId(projection.itemId, 'Room run public projection itemId');
    if (projection.association.length === 0 || projection.association.length > 1024
      || (projection.kind === 'message' && projection.association !== `agent:${member.participantId}`)
      || (projection.kind === 'approval' && !projection.association.startsWith('approval:'))
      || (projection.kind === 'status' && !projection.association.startsWith('status:'))) {
      throw new Error('Room run public projection must retain its exact kind/participant association.');
    }
  }
  return Object.freeze({
    ...run,
    ...(run.taskBinding === undefined ? {} : { taskBinding: freezeTaskBinding(run.taskBinding) }),
    ...(run.detailsUrl === undefined ? {} : { detailsUrl: Object.freeze({ ...run.detailsUrl }) }),
    ...(run.rebind === undefined ? {} : { rebind: Object.freeze({
      ...run.rebind,
      source: Object.freeze({ ...run.rebind.source }),
      ...(run.rebind.acceptance === undefined ? {} : { acceptance: Object.freeze({ ...run.rebind.acceptance }) }),
      ...(run.rebind.attention === undefined ? {} : { attention: Object.freeze({ ...run.rebind.attention }) }),
    }) }),
    ...(run.selfIntroduction === undefined ? {} : { selfIntroduction: Object.freeze({
      ...run.selfIntroduction,
      binding: freezeTaskBinding(run.selfIntroduction.binding),
      ...(run.selfIntroduction.acceptance === undefined ? {} : {
        acceptance: Object.freeze({ ...run.selfIntroduction.acceptance }),
      }),
      ...(run.selfIntroduction.projection === undefined ? {} : {
        projection: Object.freeze({ ...run.selfIntroduction.projection }),
      }),
      ...(run.selfIntroduction.attention === undefined ? {} : {
        attention: Object.freeze({ ...run.selfIntroduction.attention }),
      }),
      ...(run.selfIntroduction.cancellation === undefined ? {} : {
        cancellation: Object.freeze({
          ...run.selfIntroduction.cancellation,
          ...(run.selfIntroduction.cancellation.attention === undefined ? {} : {
            attention: Object.freeze({ ...run.selfIntroduction.cancellation.attention }),
          }),
        }),
      }),
    }) }),
    presence: Object.freeze({
      ...presence,
      ...(presence.failure === undefined ? {} : { failure: Object.freeze({
        ...presence.failure,
        ...(presence.failure.retryCommand === undefined ? {} : {
          retryCommand: Object.freeze({ ...presence.failure.retryCommand }),
        }),
      }) }),
    }),
    publicProjections: Object.freeze(publicProjections.map(projection => Object.freeze({ ...projection }))),
  });
}

function freezeAcknowledgement(acknowledgement: RoomAcknowledgement): RoomAcknowledgement {
  const presentation = acknowledgement.presentation.kind === 'reaction'
    ? Object.freeze({
      ...acknowledgement.presentation,
      value: Object.freeze({ ...acknowledgement.presentation.value }),
    })
    : Object.freeze({ ...acknowledgement.presentation });
  return Object.freeze({
    ...acknowledgement,
    behavior: Object.freeze({ ...acknowledgement.behavior }),
    presentation,
  });
}

function freezeDeliveryPayload(value: RoomDeliveryPayload): RoomDeliveryPayload {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeliveryPayload));
  if (typeof value === 'object' && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, freezeDeliveryPayload(item)])));
  }
  return value;
}

function freezeDelivery(delivery: RoomDelivery): RoomDelivery {
  const operation = Object.freeze({
    ...delivery.operation,
    payload: freezeDeliveryPayload(delivery.operation.payload),
  });
  const acceptance = delivery.acceptance === undefined ? undefined : delivery.acceptance.kind === 'create'
    ? Object.freeze({
      ...delivery.acceptance,
      binding: freezeTaskBinding(delivery.acceptance.binding),
      detailsUrl: Object.freeze({ ...delivery.acceptance.detailsUrl }),
    })
    : Object.freeze({ ...delivery.acceptance });
  return Object.freeze({
    ...delivery,
    operation,
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(delivery.attention === undefined ? {} : { attention: Object.freeze({ ...delivery.attention }) }),
  });
}

const freezeConfiguredMember = (
  member: ChatroomAgentConfiguration['members'][number],
  configuration: ChatroomAgentConfiguration,
): RoomMembership => Object.freeze({
  memberId: member.memberId,
  participantId: member.participantId ?? member.memberId,
    label: member.label,
    definition: Object.freeze({ ...member.definition }),
    avatar: agentAvatarForDefinition(member.definition, configuration.definitions),
    role: member.role,
    attentionPolicy: member.attentionPolicy,
  });

export function expandRoomMemberships(
  configuration: ChatroomAgentConfiguration,
  seedLeaderIds: readonly string[] = configuration.seedLeaderIds,
): readonly [RoomMembership, ...RoomMembership[]] {
  if (seedLeaderIds.length === 0) throw new Error('Room requires at least one seed leader.');
  const configured = new Map(configuration.members.map(member => [member.memberId, member]));
  const children = new Map<string, string[]>();
  for (const member of configuration.members) {
    if (member.reportsToMemberId !== undefined) {
      const current = children.get(member.reportsToMemberId) ?? [];
      current.push(member.memberId);
      children.set(member.reportsToMemberId, current);
    }
  }
  const included = new Set<string>();
  const active = new Set<string>();
  const visit = (memberId: string): void => {
    const member = configured.get(memberId);
    if (member === undefined) throw new Error('Room seed/related member is not configured.');
    if (active.has(memberId)) throw new Error('Agent team expansion graph contains a cycle.');
    if (included.has(memberId)) return;
    active.add(memberId);
    included.add(memberId);
    for (const child of children.get(memberId) ?? []) visit(child);
    for (const related of member.relatedMemberIds ?? []) visit(related);
    active.delete(memberId);
  };
  for (const seed of seedLeaderIds) {
    if (configured.get(seed)?.role !== 'leader') throw new Error('Room seeds must reference configured leaders.');
    visit(seed);
  }
  const snapshots = configuration.members.filter(member => included.has(member.memberId)).map(member => Object.freeze({
    ...freezeConfiguredMember(member, configuration),
    ...(member.reportsToMemberId !== undefined && included.has(member.reportsToMemberId)
      ? { reportsToMemberId: member.reportsToMemberId }
      : {}),
  }));
  const [first, ...rest] = snapshots;
  if (first === undefined) throw new Error('Room membership expansion is empty.');
  return Object.freeze([first, ...rest]);
}

export function createRoom(input: CreateRoomInput): Room {
  requireShellOpaqueId(input.id, 'Room id');
  const rawMemberships = input.memberships === undefined
    ? expandRoomMemberships(CHATROOM_DEFAULT_AGENT_CONFIGURATION)
    : input.memberships;
  if (rawMemberships.length === 0) throw new Error('Room requires at least one Agent membership.');
  const memberships = Object.freeze(rawMemberships.map(member => Object.freeze({
    memberId: member.memberId,
    participantId: member.participantId ?? member.memberId,
    label: member.label,
    definition: Object.freeze({ ...member.definition }),
    avatar: member.avatar === undefined
      ? createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: member.definition.agentId })
      : cloneAgentAvatarRef(member.avatar),
    role: member.role,
    attentionPolicy: member.attentionPolicy,
    ...(member.reportsToMemberId === undefined ? {} : { reportsToMemberId: member.reportsToMemberId }),
    ...(member.preferredRunId === undefined ? {} : { preferredRunId: member.preferredRunId }),
  }))) as readonly [RoomMembership, ...RoomMembership[]];
  if (new Set(memberships.map(member => member.memberId)).size !== memberships.length) {
    throw new Error('Room member ids must be unique.');
  }
  for (const member of memberships) {
    requireShellOpaqueId(member.memberId, 'Room memberId');
    requireShellOpaqueId(member.participantId, 'Room participantId');
  }
  if (new Set(memberships.map(member => member.participantId)).size !== memberships.length) {
    throw new Error('Room participant ids must be unique across memberships.');
  }
  const membershipById = new Map(memberships.map(member => [member.memberId, member]));
  const membershipByParticipantId = new Map(memberships.map(member => [member.participantId, member]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (memberId: string): void => {
    if (visiting.has(memberId)) throw new Error('Room reporting graph contains a cycle.');
    if (visited.has(memberId)) return;
    const member = membershipById.get(memberId)!;
    visiting.add(memberId);
    if (member.reportsToMemberId !== undefined) {
      if (!membershipById.has(member.reportsToMemberId)) throw new Error('reportsToMemberId must reference a Room membership.');
      visit(member.reportsToMemberId);
    }
    visiting.delete(memberId);
    visited.add(memberId);
  };
  for (const member of memberships) visit(member.memberId);
  const seedLeaderIds = Object.freeze([...(input.seedLeaderIds ?? memberships
    .filter(member => member.role === 'leader' && member.reportsToMemberId === undefined)
    .map(member => member.memberId))]);
  for (const seed of seedLeaderIds) {
    if (membershipById.get(seed)?.role !== 'leader') throw new Error('Room seeds must reference leader memberships.');
  }
  const runs = Object.freeze([...(input.runs ?? [])].map(run => {
    const member = membershipById.get(run.memberId);
    if (member === undefined) throw new Error('Room run must reference a member.');
    return freezeRun(run, member);
  }));
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Room run ids must be unique.');
  const publicProjectionIds = runs.flatMap(run => (run.publicProjections ?? []).map(projection => projection.itemId));
  if (new Set(publicProjectionIds).size !== publicProjectionIds.length) {
    throw new Error('Room run public projection identities must be globally unique.');
  }
  for (const run of runs) {
    requireShellOpaqueId(run.runId, 'Room runId');
    const member = memberships.find(candidate => candidate.memberId === run.memberId);
    if (member === undefined) throw new Error('Room run must reference a member.');
    if (run.taskBinding !== undefined && !sameIdentity(member.definition, run.taskBinding.definition)) {
      throw new Error('TaskBinding Agent identity does not match the Room member.');
    }
    if (run.detailsUrl !== undefined && run.taskBinding === undefined) {
      throw new Error('Run details URL requires a persisted TaskBinding.');
    }
    if (run.detailsUrl !== undefined && (run.detailsUrl.url.trim() === ''
      || (run.detailsUrl.target !== 'host' && run.detailsUrl.target !== 'external'))) {
      throw new Error('Run details URL is invalid.');
    }
    if (run.presence.eventKey !== presenceEventKey(member.participantId, run.memberId, run.runId)
      || run.presence.participantId !== member.participantId
      || run.presence.memberId !== run.memberId
      || run.presence.runId !== run.runId) {
      throw new Error('Run presence event key does not match the run.');
    }
    if (!Number.isSafeInteger(run.presence.attempt) || run.presence.attempt < 1) {
      throw new Error('Run presence attempt must be a positive integer.');
    }
    if (run.rebind !== undefined) {
      if (!Number.isSafeInteger(run.rebind.cycle)
        || run.rebind.cycle < 1
        || run.rebind.operationId.trim() === ''
        || !Number.isFinite(Date.parse(run.rebind.issuedAt))
        || !/^sha256\.[0-9a-f]{64}$/.test(run.rebind.canonicalPayload)
        || run.rebind.source.task.trim() === ''
        || run.rebind.source.bindingId.trim() === ''
        || !Number.isSafeInteger(run.rebind.source.generation)
        || run.rebind.source.generation < 1) {
        throw new Error('Run rebind recovery correlation is invalid.');
      }
      if (run.rebind.state === 'attention' && run.rebind.attention === undefined) {
        throw new Error('Run rebind attention requires a diagnostic state.');
      }
      if (run.rebind.state === 'accepted'
        && (run.rebind.acceptance === undefined
          || !Number.isFinite(Date.parse(run.rebind.acceptance.firstObservedAt)))) {
        throw new Error('Accepted run rebind requires provider observation metadata.');
      }
    }
    if (run.selfIntroduction !== undefined) {
      const introduction = run.selfIntroduction;
      requireAgentLoopOperationId(introduction.operationId, 'Member self-introduction operationId');
      if (introduction.cancellation !== undefined) {
        requireAgentLoopOperationId(
          introduction.cancellation.operationId,
          'Member self-introduction cancellation operationId',
        );
      }
      if (introduction.participantId !== member.participantId
        || introduction.memberId !== member.memberId
        || introduction.runId !== run.runId
        || run.taskBinding === undefined
        || ((introduction.state === 'planned' || introduction.state === 'sending-unknown')
          && !sameBinding(introduction.binding, run.taskBinding))
        || (introduction.state === 'accepted' && introduction.acceptance === undefined)
        || (introduction.state === 'completed'
          && introduction.acceptance === undefined && introduction.projection === undefined)
        || (introduction.state === 'attention' && introduction.attention === undefined)) {
        throw new Error('Member self-introduction must retain its exact operation/member/run/binding correlation.');
      }
      if (introduction.acceptance !== undefined && introduction.projection !== undefined
        && (introduction.acceptance.turn !== introduction.projection.turn
          || introduction.acceptance.messageId !== introduction.projection.messageId)) {
        throw new Error('Member self-introduction result and projected message correlation must match.');
      }
      if (introduction.cancellation?.state === 'accepted'
        && introduction.cancellation.disposition === undefined) {
        throw new Error('Accepted member self-introduction cancellation requires delivery disposition.');
      }
      if (introduction.cancellation?.state === 'attention'
        && introduction.cancellation.attention === undefined) {
        throw new Error('Member self-introduction cancellation attention requires a diagnostic state.');
      }
    }
    if ((run.presence.state === 'joined' || run.presence.state === 'ready')
      && (run.taskBinding === undefined || run.detailsUrl === undefined)) {
      throw new Error('Joined/ready member presence requires a persisted binding and details URL.');
    }
  }
  for (const member of memberships) {
    if (member.preferredRunId !== undefined
      && !runs.some(run => run.runId === member.preferredRunId && run.memberId === member.memberId)) {
      throw new Error('Preferred run must belong to its Room member.');
    }
  }
  const items: readonly AgentConversationItem[] = Object.freeze([...(input.items ?? [])].slice(-500).map(item => {
    const candidate = item as AgentConversationItem & { readonly semantic?: { readonly purpose: string } };
    if (candidate.kind !== 'message' || candidate.semantic !== undefined) return item;
    // Consumer-owned migration for durable Shell v2 Room snapshots. It does
    // not infer introductions: only legacy visible conversation/ack messages
    // receive their exact predecessor semantics.
    return candidate.source === 'chatroom-acknowledgement'
      ? { ...candidate, semantic: { purpose: 'chatroom-acknowledgement' as const } } as AgentConversationItem
      : { ...candidate, semantic: { purpose: 'conversation' as const } } as AgentConversationItem;
  }));
  if (new Set(items.map(item => item.itemId)).size !== items.length) {
    throw new Error('Room public timeline item ids must be unique.');
  }
  for (const item of items) {
    requireShellOpaqueId(item.itemId, 'Conversation itemId');
    if (item.kind === 'message') {
      requireShellOpaqueId(item.messageId, 'Conversation messageId');
      requireShellOpaqueId(item.author.participantId, 'Conversation author participantId');
      for (const reaction of item.reactions ?? []) {
        requireShellOpaqueId(reaction.reactionId, 'Conversation reactionId');
        requireShellOpaqueId(reaction.actorParticipantId, 'Conversation reaction actorParticipantId');
      }
    } else if (item.kind === 'member-presence') {
      requireShellOpaqueId(item.participantId, 'Presence participantId');
      requireShellOpaqueId(item.memberId, 'Presence memberId');
      requireShellOpaqueId(item.runId, 'Presence runId');
    } else if (item.kind === 'approval') {
      requireShellOpaqueId(item.participantId, 'Approval participantId');
      requireShellOpaqueId(item.memberId, 'Approval memberId');
      requireShellOpaqueId(item.runId, 'Approval runId');
      requireShellOpaqueId(item.turn, 'Approval turn');
      requireShellOpaqueId(item.approvalId, 'Approval approvalId');
    }
  }
  const itemById = new Map(items.map(item => [item.itemId, item]));
  for (const run of runs) {
    for (const projection of run.publicProjections ?? []) {
      const item = itemById.get(projection.itemId);
      if (item !== undefined && !roomRunPublicProjectionMatchesItem(projection, item)) {
        throw new Error('Room run public projection does not match its visible timeline item.');
      }
    }
  }
  const timelineSequence = Math.max(input.timelineSequence ?? 0, ...items.map(item => item.sequence));
  const channelLinks = Object.freeze([...(input.channelLinks ?? [])].map(link => Object.freeze({ ...link })));
  if (new Set(channelLinks.map(link => link.linkId)).size !== channelLinks.length) {
    throw new Error('Room ChannelLink ids must be unique.');
  }
  for (const link of channelLinks) {
    if (link.scope === 'member' && !membershipById.has(link.memberId)) {
      throw new Error('Member-scoped ChannelLink must reference a Room membership.');
    }
  }
  const acknowledgements = Object.freeze([...(input.acknowledgements ?? [])].map(freezeAcknowledgement));
  if (new Set(acknowledgements.map(item => item.acknowledgementKey)).size !== acknowledgements.length) {
    throw new Error('Room acknowledgement keys must be unique.');
  }
  for (const acknowledgement of acknowledgements) {
    requireShellOpaqueId(acknowledgement.userItemId, 'Room acknowledgement userItemId');
    requireShellOpaqueId(acknowledgement.participantId, 'Room acknowledgement participantId');
    requireShellOpaqueId(acknowledgement.memberId, 'Room acknowledgement memberId');
    requireShellOpaqueId(acknowledgement.runId, 'Room acknowledgement runId');
    const run = runs.find(candidate => candidate.runId === acknowledgement.runId);
    const member = membershipById.get(acknowledgement.memberId);
    if (run?.memberId !== acknowledgement.memberId
      || member?.participantId !== acknowledgement.participantId) {
      throw new Error('Room acknowledgement must reference its exact member run.');
    }
    if (acknowledgement.presentation.kind === 'canned-message'
      && (acknowledgement.presentation.authorParticipantId !== acknowledgement.participantId
        || acknowledgement.presentation.authorMemberId !== acknowledgement.memberId)) {
      throw new Error('Canned acknowledgement author must match its participant/member.');
    }
    if (acknowledgement.presentation.kind === 'canned-message') {
      requireShellOpaqueId(acknowledgement.presentation.authorParticipantId,
        'Canned acknowledgement author participantId');
      requireShellOpaqueId(acknowledgement.presentation.authorMemberId,
        'Canned acknowledgement author memberId');
    }
    if (acknowledgement.presentation.kind === 'reaction'
      && (acknowledgement.presentation.reactionId
          !== createChatroomOpaqueId('reaction', acknowledgement.acknowledgementKey)
        || acknowledgement.presentation.actorParticipantId !== acknowledgement.participantId
        || acknowledgement.presentation.state !== acknowledgement.state)) {
      throw new Error('Reaction acknowledgement identity/state does not match its delivery.');
    }
    if (acknowledgement.presentation.kind === 'reaction') {
      requireShellOpaqueId(acknowledgement.presentation.reactionId, 'Acknowledgement reactionId');
      requireShellOpaqueId(acknowledgement.presentation.actorParticipantId,
        'Acknowledgement reaction actorParticipantId');
    }
  }
  const outbox = Object.freeze([...(input.outbox ?? [])].map(item => Object.freeze({
    ...item,
    create: Object.freeze({ ...item.create }),
    acknowledge: Object.freeze({ ...item.acknowledge }),
    send: Object.freeze({ ...item.send }),
  })));
  if (new Set(outbox.map(item => item.deliveryId)).size !== outbox.length) {
    throw new Error('Room outbox delivery ids must be unique.');
  }
  const sendOperationIds = outbox.map(item => item.send.operationId);
  if (new Set(sendOperationIds).size !== sendOperationIds.length) {
    throw new Error('Room outbox send operation ids must be globally unique.');
  }
  const operationKinds = new Map<string, 'create' | 'send'>();
  for (const item of outbox) {
    const existingSendKind = operationKinds.get(item.send.operationId);
    if (existingSendKind !== undefined) throw new Error('Room outbox operation ids must be globally unique by kind.');
    operationKinds.set(item.send.operationId, 'send');
    if (item.create.state !== 'not-required') {
      const existingCreateKind = operationKinds.get(item.create.operationId);
      if (existingCreateKind === 'send') throw new Error('Room outbox operation ids must be globally unique by kind.');
      operationKinds.set(item.create.operationId, 'create');
    }
  }
  for (const item of outbox) {
    const member = membershipById.get(item.memberId);
    const run = runs.find(candidate => candidate.runId === item.runId);
    const acknowledgement = acknowledgements.find(candidate => candidate.acknowledgementKey === item.acknowledgementKey);
    if (member?.participantId !== item.participantId || run?.memberId !== item.memberId
      || acknowledgement?.participantId !== item.participantId
      || acknowledgement.memberId !== item.memberId || acknowledgement.runId !== item.runId
      || acknowledgement.userItemId !== item.userItemId
      || acknowledgement.state !== item.acknowledge.state) {
      throw new Error('Room outbox must retain its exact participant/member/run/user correlation.');
    }
    if (item.create.state !== 'not-required') {
      const create = item.create;
      const owner = outbox.find(candidate => candidate.deliveryId === create.ownerDeliveryId);
      if (owner?.create.state === 'not-required'
        || owner?.create.operationId !== create.operationId
        || owner.participantId !== item.participantId
        || owner.memberId !== item.memberId || owner.runId !== item.runId) {
        throw new Error('Shared create operation must retain one exact per-run owner delivery.');
      }
    }
  }
  const deliveries = Object.freeze([...(input.deliveries ?? [])].map(freezeDelivery));
  if (new Set(deliveries.map(delivery => delivery.operationId)).size !== deliveries.length) {
    throw new Error('Room delivery operation ids must be unique.');
  }
  for (const delivery of deliveries) {
    const run = runs.find(candidate => candidate.runId === delivery.runId);
    const member = membershipById.get(delivery.memberId);
    if (run?.memberId !== delivery.memberId || member?.participantId !== delivery.participantId) {
      throw new Error('Room delivery must reference its exact participant/member/run.');
    }
    if (!Number.isSafeInteger(delivery.revision) || delivery.revision < 1) {
      throw new Error('Room delivery revision must be a positive integer.');
    }
    if (delivery.state === 'accepted' && delivery.acceptance === undefined) {
      throw new Error('Accepted Room delivery requires its acceptance.');
    }
    if (delivery.state === 'closed'
      && (delivery.closedBy === undefined || delivery.closedAt === undefined
        || !Number.isFinite(Date.parse(delivery.closedAt)))) {
      throw new Error('Closed Room delivery requires Host/provider closedAt.');
    }
    if (delivery.acceptance !== undefined
      && (!Number.isFinite(Date.parse(delivery.acceptance.firstObservedAt))
        || delivery.acceptance.kind !== delivery.stage
        || (delivery.acceptance.kind === 'send'
          && (delivery.acceptance.messageId.trim() === ''
            || delivery.acceptance.turn.trim() === '')))) {
      throw new Error('Room delivery acceptance requires provider-observed result identity.');
    }
    const aggregate = outbox.find(item => item.deliveryId === delivery.deliveryId);
    const aggregateStage = delivery.stage === 'send'
      ? aggregate?.send
      : aggregate?.create.state === 'not-required' ? undefined : aggregate?.create;
    if (aggregate?.participantId !== delivery.participantId
      || aggregate.memberId !== delivery.memberId || aggregate.runId !== delivery.runId
      || aggregate.userItemId !== delivery.userItemId
      || aggregateStage?.operationId !== delivery.operationId
      || (delivery.stage === 'create' && aggregate?.create.state !== 'not-required'
        && aggregate.create.ownerDeliveryId !== delivery.deliveryId)) {
      throw new Error('Room delivery operation must belong to its exact outbox recipient aggregate.');
    }
    if (delivery.state !== 'closed' && aggregateStage?.state !== delivery.state) {
      throw new Error('Room delivery operation state must match its outbox stage.');
    }
    if (delivery.operation.kind !== delivery.stage) throw new Error('Room delivery stage does not match its operation.');
    if (delivery.operation.kind === 'send') {
      const operation = delivery.operation;
      if (!acknowledgements.some(item => item.acknowledgementKey === operation.acknowledgementKey
          && item.userItemId === delivery.userItemId
          && item.participantId === delivery.participantId
          && item.memberId === delivery.memberId && item.runId === delivery.runId
          && item.dispatchState === 'accepted')) {
        throw new Error('Send delivery requires its exact acknowledgement correlation.');
      }
    }
  }
  const approvalDecisions = Object.freeze([...(input.approvalDecisions ?? [])].map(decision => Object.freeze({
    ...decision,
    binding: freezeTaskBinding(decision.binding),
    ...(decision.attention === undefined ? {} : { attention: Object.freeze({ ...decision.attention }) }),
  })));
  if (approvalDecisions.length > CHATROOM_MAX_APPROVAL_DECISIONS) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_APPROVAL_DECISIONS}-approval decision recovery limit.`);
  }
  if (new Set(approvalDecisions.map(decision => decision.operationId)).size !== approvalDecisions.length) {
    throw new Error('Room approval decision operation ids must be unique.');
  }
  for (const decision of approvalDecisions) {
    const run = runs.find(candidate => candidate.runId === decision.runId);
    const member = membershipById.get(decision.memberId);
    requireAgentLoopOperationId(decision.operationId, 'Room approval decision operationId');
    if (decision.requestOperationId !== undefined) {
      requireAgentLoopOperationId(decision.requestOperationId, 'Room approval decision requestOperationId');
    }
    if (run?.memberId !== decision.memberId
      || member?.participantId !== decision.participantId
      || run.taskBinding === undefined
      || ((decision.state === 'planned' || decision.state === 'sending-unknown')
        && !sameBinding(run.taskBinding, decision.binding))
      || !sameIdentity(member.definition, decision.binding.definition)
      || decision.turn.trim() === ''
      || decision.approvalId.trim() === ''
      || (decision.state === 'accepted' && decision.disposition === undefined)
      || (decision.state === 'attention' && decision.attention === undefined)) {
      throw new Error('Room approval decision must retain its exact operation/member/run/binding correlation.');
    }
  }
  const approvalRequestOperationIds = approvalDecisions.flatMap(decision =>
    decision.requestOperationId === undefined ? [] : [decision.requestOperationId]);
  if (new Set(approvalRequestOperationIds).size !== approvalRequestOperationIds.length) {
    throw new Error('Room approval decision request operation ids must be unique.');
  }
  const playgroundAgentEgresses = Object.freeze([...(input.playgroundAgentEgresses ?? [])]
    .map(egress => Object.freeze({
      ...egress,
      ...(egress.delegation === undefined ? {} : {
        delegation: Object.freeze({
          ...egress.delegation,
          ...(egress.delegation.context === undefined ? {} : {
            context: Object.freeze({
              ...egress.delegation.context,
              source: Object.freeze({ ...egress.delegation.context.source }),
              target: Object.freeze({ ...egress.delegation.context.target }),
              ...(egress.delegation.context.reportsTo === undefined ? {} : {
                reportsTo: Object.freeze({ ...egress.delegation.context.reportsTo }),
              }),
              availableTargets: Object.freeze(egress.delegation.context.availableTargets
                .map(target => Object.freeze({ ...target }))),
            }),
          }),
        }),
      }),
      ...(egress.recipients === undefined ? {} : {
        recipients: Object.freeze(egress.recipients.map(recipient => Object.freeze({ ...recipient }))),
      }),
    })));
  if (playgroundAgentEgresses.length > CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES}-Agent egress recovery limit.`);
  }
  if (new Set(playgroundAgentEgresses.map(egress => egress.operationId)).size
    !== playgroundAgentEgresses.length) {
    throw new Error('Playground Agent egress operation ids must be unique.');
  }
  for (const egress of playgroundAgentEgresses) {
    const run = runs.find(candidate => candidate.runId === egress.runId);
    const member = membershipById.get(egress.memberId);
    const item = itemById.get(egress.itemId);
    const projection = run?.publicProjections?.find(candidate => candidate.itemId === egress.itemId);
    const delegationTarget = egress.delegation === undefined ? undefined
      : membershipById.get(egress.delegation.targetMemberId);
    const delegationRun = egress.delegation === undefined ? undefined
      : runs.find(candidate => candidate.runId === egress.delegation!.targetRunId);
    const recipientsValid = egress.recipients === undefined || (
      egress.recipients.length > 0
      && new Set(egress.recipients.map(recipient =>
        `${recipient.targetMemberId.length}:${recipient.targetMemberId}${recipient.targetRunId.length}:${recipient.targetRunId}`,
      )).size === egress.recipients.length
      && egress.recipients.every(recipient => {
        const target = membershipById.get(recipient.targetMemberId);
        const targetRun = runs.find(candidate => candidate.runId === recipient.targetRunId);
        return target !== undefined
          && target.memberId !== egress.memberId
          && targetRun?.memberId === target.memberId
          && targetRun.runId !== egress.runId
          && recipient.content.trim() !== ''
          && recipient.content.length <= 32_768;
      })
    );
    requireAgentLoopOperationId(egress.operationId, 'Playground Agent egress operationId');
    requireShellOpaqueId(egress.itemId, 'Playground Agent egress itemId');
    requireShellOpaqueId(egress.messageId, 'Playground Agent egress messageId');
    if (run?.memberId !== egress.memberId
      || member?.participantId !== egress.participantId
      || egress.shellBindingId.trim() === ''
      || egress.ownerGeneration.trim() === ''
      || egress.shellGeneration.trim() === ''
      || egress.text.trim() === ''
      || egress.text.length > 32_768
      || !Number.isFinite(Date.parse(egress.timestamp))
      || egress.state !== 'completed'
      || !recipientsValid
      || (egress.delegation !== undefined && egress.recipients !== undefined)
      || (egress.delegation !== undefined && (
        delegationTarget === undefined
        || egress.delegation.targetMemberId === egress.memberId
        || delegationRun?.memberId !== egress.delegation.targetMemberId
        || egress.delegation.targetRunId === egress.runId
        || (egress.delegation.task !== undefined
          && (egress.delegation.task.trim() === '' || egress.delegation.task.length > 32_768))
        || (egress.delegation.context !== undefined && (
          egress.delegation.context.source.memberId !== egress.memberId
          || egress.delegation.context.source.runId !== egress.runId
          || egress.delegation.context.target.memberId !== egress.delegation.targetMemberId
          || egress.delegation.context.target.runId !== egress.delegation.targetRunId
          || egress.delegation.context.communicationMode !== 'explicit-mention-required'
          || egress.delegation.context.approvalMode !== 'reports-to-hierarchy'
        ))
      ))
      || [egress.turnId, egress.sourceMessageId, egress.inReplyToMessageId].some(value =>
        value !== undefined && (value.trim() === '' || value.length > 512))
      || projection?.kind !== 'message'
      || projection.association !== `agent:${egress.participantId}`
      || (item !== undefined && (item.kind !== 'message'
        || item.source !== 'agent-loop'
        || item.itemId !== egress.itemId
        || item.messageId !== egress.messageId
        || item.author.role !== 'agent'
        || item.author.participantId !== egress.participantId
        || item.semantic.purpose !== 'conversation'
        || item.semantic.causation?.operationId !== egress.operationId
        || item.body.length !== 1
        || item.body[0].kind !== 'text'
        || item.body[0].text.fallback !== egress.text
        || (egress.delegation === undefined && egress.recipients === undefined
          ? item.deliveryState !== 'delivered' || item.runState !== 'idle'
          : !((item.deliveryState === 'delivered' && item.runState === 'idle')
            || (item.deliveryState === 'sent'
              && (item.runState === 'running' || item.runState === 'idle' || item.runState === 'failed'))
            || (item.deliveryState === 'failed' && item.runState === 'failed')))))) {
      throw new Error('Playground Agent egress must retain its exact operation/member/run/projection correlation.');
    }
    const collidesWithDelivery = deliveries.some(delivery => delivery.operationId === egress.operationId)
      || outbox.some(delivery => delivery.send.operationId === egress.operationId
        || (delivery.create.state !== 'not-required'
          && delivery.create.operationId === egress.operationId));
    const collidesWithAgentOperation = approvalDecisions.some(decision =>
      decision.operationId === egress.operationId || decision.requestOperationId === egress.operationId)
      || runs.some(candidate => candidate.rebind?.operationId === egress.operationId
        || candidate.selfIntroduction?.operationId === egress.operationId
        || candidate.selfIntroduction?.cancellation?.operationId === egress.operationId);
    if (collidesWithDelivery || collidesWithAgentOperation) {
      throw new Error('Playground Agent egress operation collides with another Room operation.');
    }
  }
  const playgroundAgentApprovals = Object.freeze([...(input.playgroundAgentApprovals ?? [])]
    .map(approval => Object.freeze({
      ...approval,
      decisionAttempts: Object.freeze(approval.decisionAttempts.map(attempt => Object.freeze({ ...attempt }))),
    })));
  if (playgroundAgentApprovals.length > CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS) {
    throw new Error(`Room exceeds its ${CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS}-Agent approval recovery limit.`);
  }
  if (new Set(playgroundAgentApprovals.map(approval => approval.operationId)).size
    !== playgroundAgentApprovals.length
    || new Set(playgroundAgentApprovals.map(approval => approval.approvalId)).size
      !== playgroundAgentApprovals.length
    || new Set(playgroundAgentApprovals.map(approval => approval.itemId)).size
      !== playgroundAgentApprovals.length) {
    throw new Error('Playground Agent approval request/item identities must be unique.');
  }
  const playgroundApprovalDecisionOperationIds: string[] = [];
  for (const approval of playgroundAgentApprovals) {
    const run = runs.find(candidate => candidate.runId === approval.runId);
    const member = membershipById.get(approval.memberId);
    const item = itemById.get(approval.itemId);
    const projection = run?.publicProjections?.find(candidate => candidate.itemId === approval.itemId);
    requireAgentLoopOperationId(approval.operationId, 'Playground Agent approval operationId');
    requireShellOpaqueId(approval.itemId, 'Playground Agent approval itemId');
    requireShellOpaqueId(approval.turnId, 'Playground Agent approval turnId');
    requireShellOpaqueId(approval.approvalId, 'Playground Agent approval approvalId');
    if (approval.decisionAttempts.length > CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS
      || new Set(approval.decisionAttempts.map(attempt => attempt.operationId)).size
        !== approval.decisionAttempts.length) {
      throw new Error('Playground Agent approval decision attempts are invalid.');
    }
    for (const attempt of approval.decisionAttempts) {
      requireAgentLoopOperationId(attempt.operationId, 'Playground Agent approval decision operationId');
      if (!Number.isFinite(Date.parse(attempt.timestamp))) {
        throw new Error('Playground Agent approval decision timestamp is invalid.');
      }
      playgroundApprovalDecisionOperationIds.push(attempt.operationId);
    }
    const terminalDecision = approval.state === 'pending' ? undefined : approval.state;
    if (run?.memberId !== approval.memberId
      || member?.participantId !== approval.participantId
      || approval.shellBindingId.trim() === ''
      || approval.ownerGeneration.trim() === ''
      || approval.shellGeneration.trim() === ''
      || approval.agentLoopBindingId.trim() === ''
      || !Number.isSafeInteger(approval.agentLoopBindingGeneration)
      || approval.agentLoopBindingGeneration < 1
      || approval.reason.trim() === ''
      || approval.reason.length > 4_096
      || !Number.isFinite(Date.parse(approval.timestamp))
      || (terminalDecision === undefined) !== (approval.decisionAttempts.length === 0)
      || (terminalDecision !== undefined
        && approval.decisionAttempts.some(attempt => attempt.decision !== terminalDecision))
      || projection?.kind !== 'approval'
      || (item !== undefined && (item.kind !== 'approval'
        || item.itemId !== approval.itemId
        || item.participantId !== approval.participantId
        || item.memberId !== approval.memberId
        || item.runId !== approval.runId
        || item.binding.bindingId !== approval.agentLoopBindingId
        || item.binding.generation !== approval.agentLoopBindingGeneration
        || item.turn !== approval.turnId
        || item.approvalId !== approval.approvalId
        || item.approvalKind !== 'other'
        || item.rationale?.fallback !== approval.reason
        || item.state !== approval.state
        || (approval.state === 'pending' ? item.actions.length !== 3 : item.actions.length !== 0)
        || !roomRunPublicProjectionMatchesItem(projection, item)))) {
      throw new Error('Playground Agent approval must retain its exact operation/member/run/card correlation.');
    }
    const requestCollides = deliveries.some(delivery => delivery.operationId === approval.operationId)
      || outbox.some(delivery => delivery.send.operationId === approval.operationId
        || (delivery.create.state !== 'not-required'
          && delivery.create.operationId === approval.operationId))
      || approvalDecisions.some(decision => decision.operationId === approval.operationId
        || decision.requestOperationId === approval.operationId)
      || runs.some(candidate => candidate.rebind?.operationId === approval.operationId
        || candidate.selfIntroduction?.operationId === approval.operationId
        || candidate.selfIntroduction?.cancellation?.operationId === approval.operationId)
      || playgroundAgentEgresses.some(egress => egress.operationId === approval.operationId);
    if (requestCollides) {
      throw new Error('Playground Agent approval operation collides with another Room operation.');
    }
  }
  if (new Set(playgroundApprovalDecisionOperationIds).size
    !== playgroundApprovalDecisionOperationIds.length) {
    throw new Error('Playground Agent approval decision operation ids must be unique.');
  }
  const playgroundApprovalOperationIds = new Set(playgroundAgentApprovals.map(approval => approval.operationId));
  if (playgroundApprovalDecisionOperationIds.some(operationId =>
    playgroundApprovalOperationIds.has(operationId)
    || deliveries.some(delivery => delivery.operationId === operationId)
    || outbox.some(delivery => delivery.send.operationId === operationId
      || (delivery.create.state !== 'not-required' && delivery.create.operationId === operationId))
    || approvalDecisions.some(decision => decision.operationId === operationId
      || decision.requestOperationId === operationId)
    || playgroundAgentEgresses.some(egress => egress.operationId === operationId))) {
    throw new Error('Playground Agent approval decision collides with another Room operation.');
  }
  return Object.freeze({
    id: input.id,
    title: input.title,
    pinned: input.pinned === true,
    archived: input.archived === true,
    ...(input.description === undefined ? {} : { description: input.description }),
    memberships,
    seedLeaderIds,
    runs,
    acknowledgements,
    deliveries,
    outbox,
    approvalDecisions,
    ...(playgroundAgentEgresses.length === 0 ? {} : { playgroundAgentEgresses }),
    ...(playgroundAgentApprovals.length === 0 ? {} : { playgroundAgentApprovals }),
    timelineSequence,
    imageReferences: Object.freeze([...(input.imageReferences ?? [])].slice(-500)),
    channelLinks,
    participants: Object.freeze([...(input.participants ?? [])].map(participant => {
      requireShellOpaqueId(participant.id, 'Room participantId');
      const membershipAvatar = participant.kind === 'agent'
        ? membershipByParticipantId.get(participant.id)?.avatar
        : undefined;
      const avatar = membershipAvatar ?? participant.avatar;
      return Object.freeze({
        ...participant,
        ...(avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(avatar) }),
      });
    })),
    ...(input.participantPresentation === undefined ? {} : { participantPresentation: input.participantPresentation }),
    items,
  });
}

export function addRoomRun(
  room: Room,
  run: Omit<RoomRun, 'agentLoopCursor' | 'presence'> & {
    readonly agentLoopCursor?: number;
    readonly presence?: RoomRunPresence;
  },
): Room {
  if (!room.memberships.some(member => member.memberId === run.memberId)) throw new Error('Room run must reference a member.');
  if (room.runs.some(candidate => candidate.runId === run.runId)) throw new Error('Room run id already exists.');
  const presenceSequence = run.presence?.sequence ?? nextRoomTimelineSequence(room);
  return createRoom({
    ...room,
    timelineSequence: Math.max(room.timelineSequence, presenceSequence),
    runs: [...room.runs, {
      ...run,
      agentLoopCursor: run.agentLoopCursor ?? -1,
      presence: run.presence ?? (() => {
        const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
        return {
          eventKey: presenceEventKey(member.participantId, run.memberId, run.runId),
          participantId: member.participantId,
          memberId: run.memberId,
          runId: run.runId,
          sequence: presenceSequence,
          state: 'creating' as const,
          attempt: 1,
        };
      })(),
    }],
  });
}

export function bindRoomRun(room: Room, runId: string, binding: AgentLoopTaskBinding): Room {
  if (binding.state !== 'active') throw new Error('Room run requires an active TaskBinding.');
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  if (!sameIdentity(member.definition, binding.definition)) {
    throw new Error('TaskBinding Agent identity does not match the Room member.');
  }
  if (run.taskBinding !== undefined) {
    if (sameBinding(run.taskBinding, binding) && run.taskBinding.state === binding.state) return room;
    throw new Error('Room run is already isolated to a different TaskBinding.');
  }
  const memberships = room.memberships.map(candidate => candidate.memberId === member.memberId
    ? { ...candidate, preferredRunId: runId }
    : candidate);
  return createRoom({
    ...replaceRoomRun(room, runId, { ...run, status: 'active', taskBinding: binding }),
    memberships,
  });
}

export function closeRoomRun(room: Room, runId: string, binding: AgentLoopTaskBinding['binding']): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  const current = run?.taskBinding;
  if (run === undefined || current === undefined
    || current.binding.bindingId !== binding.bindingId
    || current.binding.generation !== binding.generation) {
    throw new Error('TaskBinding does not belong to the Room run.');
  }
  if (current.state === 'closed') return room;
  return replaceRoomRun(room, runId, {
    ...run,
    status: run.status === 'failed' ? 'failed' : 'stopped',
    taskBinding: { ...current, state: 'closed' },
  });
}

export function roomRunOwnsAgentLoopBinding(
  room: Room,
  runId: string,
  binding: Readonly<{ bindingId: string; generation: number }>,
): boolean {
  const current = room.runs.find(run => run.runId === runId)?.taskBinding;
  return current?.state === 'active'
    && current.binding.bindingId === binding.bindingId
    && current.binding.generation === binding.generation;
}

export function replaceRoomRun(room: Room, runId: string, replacement: RoomRun): Room {
  const index = room.runs.findIndex(run => run.runId === runId);
  if (index < 0 || replacement.runId !== runId) throw new Error('Room run is unavailable.');
  const runs = [...room.runs];
  runs[index] = replacement;
  return createRoom({ ...room, runs });
}

export function replaceRoomRunProjection(
  room: Room,
  runId: string,
  input: {
    readonly items?: readonly AgentConversationItem[];
    readonly imageReferences?: readonly RoomImageReference[];
    readonly eventCursor: number;
    readonly status?: RoomRunStatus;
    readonly taskBinding?: AgentLoopTaskBinding;
    readonly publicProjection?: RoomRunPublicProjection;
  },
): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const items = input.items === undefined ? room.items : input.items.slice(-500);
  const publicProjections = run.publicProjections ?? [];
  if (input.publicProjection !== undefined
    && publicProjections.length >= CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS) {
    throw new Error(`Room run exceeds its ${CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS}-projection replay limit.`);
  }
  return createRoom({
    ...room,
    items,
    timelineSequence: Math.max(room.timelineSequence, ...items.map(item => item.sequence)),
    imageReferences: input.imageReferences ?? room.imageReferences,
    runs: room.runs.map(candidate => candidate.runId === runId ? {
      ...run,
      agentLoopCursor: input.eventCursor,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.taskBinding === undefined ? {} : { taskBinding: input.taskBinding }),
      publicProjections: input.publicProjection === undefined
        ? publicProjections
        : [...publicProjections, input.publicProjection],
    } : candidate),
  });
}

export function nextRoomTimelineSequence(room: Room): number { return room.timelineSequence + 1; }

export class ChatroomRoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly listeners = new Set<(roomId: string) => void>();

  constructor(initialRooms: readonly Room[] = []) {
    for (const room of initialRooms) this.rooms.set(room.id, room);
  }

  get(roomId: string): Room | undefined { return this.rooms.get(roomId); }
  snapshot(): readonly Room[] { return [...this.rooms.values()]; }

  upsert(room: Room): void {
    this.rooms.set(room.id, room);
    for (const listener of this.listeners) listener(room.id);
  }

  remove(roomId: string): void {
    this.rooms.delete(roomId);
    for (const listener of this.listeners) listener(roomId);
  }

  /** Atomically replaces the complete durable snapshot before notifying readers. */
  replaceAll(rooms: readonly Room[]): void {
    const previousIds = new Set(this.rooms.keys());
    this.rooms.clear();
    for (const room of rooms) this.rooms.set(room.id, room);
    const changedIds = new Set([...previousIds, ...rooms.map(room => room.id)]);
    for (const roomId of changedIds) {
      for (const listener of this.listeners) listener(roomId);
    }
  }

  subscribe(listener: (roomId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
