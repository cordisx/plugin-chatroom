import type {
  Agent,
  AgentAdmission,
  AgentHandle,
  AgentMessageDiscardResult,
  AgentMutationResult,
} from '@cordisx/protocol/agents/v1';
import type { EntityAgentAcquireResult } from '@cordisx/protocol/entities/v1';
import {
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
} from 'cordisx/contracts';
import type {
  ApprovalAnswererHandle as ApprovalAnswererHandleV1,
  ApprovalOutcome,
  ApprovalQuestion as ApprovalQuestionV1,
  ApprovalService as ApprovalServiceV1,
} from '@cordisx/protocol/approval/v1';
import type {
  ApprovalAuthorityAnswererHandle,
  ApprovalQuestion as ApprovalQuestionV2,
  ApprovalService as ApprovalServiceV2,
} from '@cordisx/protocol/approval/v2';
import type {
  ApprovalRequestResolverHandle,
  ApprovalService as ApprovalServiceV3,
} from '@cordisx/protocol/approval/v3';
import type { AgentConversationShellCommandContext } from '@cordisx/protocol/agent-conversation-shell/v7';
import type {
  AgentAdmissionTarget,
  AgentAdmissionTargetOriginService,
  AgentAdmissionTargetReservationService,
} from '@cordisx/protocol/agent-admission/v3';
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v1';
import type {
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetService,
  AgentBootstrapCommandOrigin,
} from '@cordisx/protocol/agent-admission/v4';
import type {
  AgentPageAdmissionReservationService,
  AgentPageAdmissionRouteDeclarationService,
  AgentPageAdmissionRouteReservationService,
  AgentPageAdmissionTargetService,
  AgentPageComposerOrigin,
  AgentPageRoomRoute,
} from '@cordisx/protocol/agent-page-admission/v2';
import type {
  AgentCancelCause,
  MessageId,
  Session,
  SessionRegistry,
  SessionSubscription,
  SessionSubscriptionClosed,
  SessionSubscriptionPage,
  UserMessage,
} from '@cordisx/protocol/sessions/v1';

import type { ChatroomAgentConfiguration } from './agent-definition.js';
import {
  ChatroomAgentSessionProjector,
  type ChatroomSessionAgentFacts,
  type ChatroomSessionProjectionPage,
  type ProjectedItem,
} from './agent-session-projection.js';
import { ChatroomRoomStoreError, type DurableChatroomRoomStore } from './room-store.js';
import { failRoomRunPresence } from './room-engagement.js';
import {
  addRoomRun,
  approvalAuthorityMemberIds,
  bindRoomRunSession,
  createChatroomOpaqueId,
  recordRoomAdmissionMessageLink,
  recordRoomSessionSelfIntroduction,
  type Room,
  type RoomMembership,
  type RoomRun,
} from './room.js';
import { resolveExplicitRoomAgentDispatch } from './room-target.js';
import {
  type ChatroomApprovalRequestExecution,
  requestChatroomApproval,
  routeChatroomDriverApproval,
} from './approval-bubble.js';
import { submitChatroomAgentAdmissionV3 } from './agent-admission-v3.js';
import {
  issueChatroomAgentAdmissionBootstrapTarget,
  submitChatroomAgentAdmissionBootstrapReservation,
} from './agent-admission-v4.js';
import {
  declareChatroomPageAdmissionRoute,
  issueChatroomPageAdmissionTarget,
  submitChatroomPageAdmissionReservation,
  submitChatroomPageAdmissionRouteReservation,
} from './agent-page-admission-v2.js';

/** Consumer lifecycle coordination. Implemented by the Chatroom Host-tool adapter. */
export interface ChatroomRunCollaboration {
  enabled(): boolean;
  ensureBound(room: Room, run: RoomRun): Promise<void>;
  revoke(sessionId: string): Promise<void>;
}

export interface ChatroomAgentRuntimeContext {
  readonly collaboration?: ChatroomRunCollaboration;
  readonly agents: CordisXAgentRegistryV1;
  readonly sessions: SessionRegistry;
  readonly approvals: ApprovalServiceV1 & ApprovalServiceV2 & ApprovalServiceV3;
}

export interface ChatroomSessionObservation {
  readonly roomId: string;
  readonly runId: string;
  readonly page: SessionSubscriptionPage;
  readonly projection: ChatroomSessionProjectionPage;
}

export interface ChatroomApprovalContext {
  readonly room: Room;
  readonly run: RoomRun;
  readonly member: RoomMembership;
  /** Ordered nearest manager first. Empty means the request fails closed. */
  readonly authorityMemberIds: readonly string[];
  readonly question: ApprovalQuestionV1;
}

export type ChatroomApprovalPolicy = (
  context: ChatroomApprovalContext,
) => ApprovalOutcome | Promise<ApprovalOutcome>;

export type ChatroomAgentSendMode = 'send' | 'followup' | 'steer' | 'inject';
/** One resolved Chatroom intent delivery, before its target origin is issued. */
export interface ChatroomAgentAdmissionDelivery {
  readonly memberId: string;
  readonly runId: string;
}

export interface ChatroomAgentAdmissionDeliveryOutcome {
  readonly memberId: string;
  readonly runId: string;
  readonly outcome: ChatroomAgentSessionOutcome;
}

/**
 * A composer command is complete only when every exact target accepts its
 * target-scoped reservation. Callers must surface a non-accepted outcome;
 * silently continuing would make a cleared draft look delivered.
 */
export function assertChatroomAdmissionDeliveriesAccepted(
  outcomes: readonly ChatroomAgentAdmissionDeliveryOutcome[],
): void {
  if (outcomes.length === 0) {
    throw new Error('Chatroom composer submit resolved no deliveries.');
  }
  const failed = outcomes.find(({ outcome }) => outcome.status !== 'accepted');
  if (failed === undefined) return;
  const outcome = failed.outcome;
  // `find()` cannot preserve the discriminant of its callback for TypeScript,
  // even though a failed delivery is necessarily non-accepted at runtime.
  if (outcome.status === 'accepted') return;
  throw new Error(
    `Chatroom admission delivery failed for ${failed.memberId}/${failed.runId}: ${outcome.status}:${outcome.code}.`,
  );
}

export type ChatroomApprovalCommandContext = Extract<
  AgentConversationShellCommandContext,
  { readonly scope: 'approval'; }
>;

export type ChatroomAgentSessionOutcome =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly messageId: MessageId;
    readonly sessionId: string;
    readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained';
  }
  | {
    readonly status: 'denied' | 'unavailable' | 'conflict';
    readonly roomId: string;
    readonly runId: string;
    readonly code: string;
  };

export interface RuntimeOwner {
  readonly handle: AgentHandle;
  readonly disposition: 'created' | 'resumed' | 'replayed' | 'retained';
}

export type ApprovalAuthorityWarmup =
  | { readonly status: 'not-required' | 'ready'; }
  | { readonly status: 'unavailable'; readonly code: string; };

/**
 * The direct reports-to relationship is Room-owned.  A first explicit
 * delivery may need to materialize that exact authority Run before its
 * requester can be admitted, but an explicit preference or an ambiguous
 * existing set must remain fail-closed.
 */
export type DirectApprovalAuthorityRun =
  | { readonly status: 'not-required'; }
  | { readonly status: 'unavailable'; readonly code: 'authority-run-unavailable'; }
  | { readonly status: 'materialize'; readonly authorityMember: RoomMembership; }
  | { readonly status: 'ready'; readonly authorityMember: RoomMembership; readonly authorityRun: RoomRun; };

export interface RuntimeSubscription {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly subscription: SessionSubscription;
  phase: 'replay' | 'live';
  afterSeq: number;
}

export interface ChatroomRoomSessionProjection {
  readonly activeRuns: readonly ReturnType<ChatroomAgentSessionProjector['activeRun']>[];
  readonly items: readonly ProjectedItem[];
  /**
   * Durable opaque append fences for admitted Room messages. The V7 source
   * applies these after its ordinary cross-source merge so a new B item cannot
   * reposition an already materialized A approval card.
   */
  readonly admissionAppendAnchors?: readonly Readonly<{
    itemId: string;
    appendAfterItemId: string;
  }>[];
}

export interface ChatroomRoomSessionProjectionV6 {
  readonly activeRuns: readonly ReturnType<ChatroomAgentSessionProjector['activeRun']>[];
  readonly items: readonly import('@cordisx/protocol/agent-conversation-shell/v6').AgentConversationItem[];
}

export type RuntimeAcquireResult = EntityAgentAcquireResult | CordisXAgentSessionLegacyAcquireResultV1;
export type RuntimeAcquireFailure =
  | Exclude<EntityAgentAcquireResult, { readonly status: 'accepted'; }>
  | Exclude<CordisXAgentSessionLegacyAcquireResultV1, { readonly status: 'accepted'; }>;

export const runKey = (roomId: string, runId: string) => `${roomId.length}:${roomId}${runId.length}:${runId}`;

export const admissionLinkOrder = (
  left: { readonly memberId: string; readonly runId: string; readonly sessionId: string; readonly messageId: string; },
  right: { readonly memberId: string; readonly runId: string; readonly sessionId: string; readonly messageId: string; },
): number => {
  for (const key of ['memberId', 'runId', 'sessionId', 'messageId'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
};

export const acquisitionMutationId = (operation: 'create' | 'resume' | 'migrate', roomId: string, runId: string) =>
  createChatroomOpaqueId(`agent-${operation}`, roomId, runId);

export const replacementAdmission = (result: AgentAdmission): boolean =>
  result.status === 'unavailable'
  && (result.code === 'agent-replaced'
    || result.code === 'plugin-generation-replaced'
    || result.code === 'connection-replaced');

export const acquireErrorCode = (
  result: RuntimeAcquireFailure,
): string => result.code;

export {
  addRoomRun,
  type Agent,
  type AgentAdmission,
  type AgentAdmissionBootstrapReservationService,
  type AgentAdmissionBootstrapTargetService,
  type AgentAdmissionTarget,
  type AgentAdmissionTargetOriginService,
  type AgentAdmissionTargetReservationService,
  type AgentBootstrapCommandOrigin,
  type AgentCancelCause,
  type AgentCommandOrigin,
  type AgentConversationShellCommandContext,
  type AgentHandle,
  type AgentMessageDiscardResult,
  type AgentMutationResult,
  type AgentPageAdmissionReservationService,
  type AgentPageAdmissionRouteDeclarationService,
  type AgentPageAdmissionRouteReservationService,
  type AgentPageAdmissionTargetService,
  type AgentPageComposerOrigin,
  type AgentPageRoomRoute,
  type ApprovalAnswererHandleV1,
  type ApprovalAuthorityAnswererHandle,
  approvalAuthorityMemberIds,
  type ApprovalOutcome,
  type ApprovalQuestionV1,
  type ApprovalQuestionV2,
  type ApprovalRequestResolverHandle,
  type ApprovalServiceV1,
  type ApprovalServiceV2,
  type ApprovalServiceV3,
  bindRoomRunSession,
  type ChatroomAgentConfiguration,
  ChatroomAgentSessionProjector,
  type ChatroomApprovalRequestExecution,
  ChatroomRoomStoreError,
  type ChatroomSessionAgentFacts,
  type ChatroomSessionProjectionPage,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_CONTRACT_V1,
  CORDISX_AGENT_SESSION_LEGACY_ACQUIRE_SCHEMA_V1,
  type CordisXAgentRegistryV1,
  type CordisXAgentSessionLegacyAcquireResultV1,
  createChatroomOpaqueId,
  declareChatroomPageAdmissionRoute,
  type DurableChatroomRoomStore,
  type EntityAgentAcquireResult,
  failRoomRunPresence,
  issueChatroomAgentAdmissionBootstrapTarget,
  issueChatroomPageAdmissionTarget,
  type MessageId,
  type ProjectedItem,
  recordRoomAdmissionMessageLink,
  recordRoomSessionSelfIntroduction,
  requestChatroomApproval,
  resolveExplicitRoomAgentDispatch,
  type Room,
  type RoomMembership,
  type RoomRun,
  routeChatroomDriverApproval,
  type Session,
  type SessionRegistry,
  type SessionSubscription,
  type SessionSubscriptionClosed,
  type SessionSubscriptionPage,
  submitChatroomAgentAdmissionBootstrapReservation,
  submitChatroomAgentAdmissionV3,
  submitChatroomPageAdmissionReservation,
  submitChatroomPageAdmissionRouteReservation,
  type UserMessage,
};
