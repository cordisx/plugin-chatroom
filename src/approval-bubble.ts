import type { Agent, AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1';
import type {
  ApprovalAgentBinding,
  ApprovalAuthorityBoundSessionEvent,
  ApprovalDecision,
  ApprovalQuestion,
  ApprovalReason,
  ApprovalRequest,
  ApprovalService,
} from '@cordisx/protocol/approval/v2';
import type { ApprovalRequestRoutingQuestion, ApprovalRequestRoutingResult } from '@cordisx/protocol/approval/v3';
import type { AgentConversationApprovalItem } from '@cordisx/protocol/agent-conversation-shell/v7';
import type { SessionEvent, SessionId } from '@cordisx/protocol/sessions/v1';

import { CHATROOM_COMMAND_APPROVAL_APPROVE, CHATROOM_COMMAND_APPROVAL_DENY } from './conversation-model.js';
import {
  approvalAuthorityMemberIds,
  createChatroomOpaqueId,
  type Room,
  type RoomMembership,
  type RoomRun,
} from './room.js';

const sameIdentity = (left: AgentDefinitionIdentity, right: AgentDefinitionIdentity): boolean =>
  left.agentId === right.agentId && left.revision === right.revision;

const exactIdentity = (identity: AgentDefinitionIdentity): boolean =>
  identity.agentId.trim() !== '' && identity.revision.trim() !== ''
  && identity.agentId !== '*' && identity.revision !== '*';

const validReason = (value: string): boolean =>
  value.length >= 1 && value.length <= 10_000
  && !/[\u0000\u000B\u000C\u000E-\u001F\u007F]/u.test(value);

const validToolName = (value: string): boolean =>
  value.length >= 1 && value.length <= 256
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);

const validOpaqueId = (value: string): boolean => value.length >= 1 && value.length <= 512;

const exactLiveAgent = (agent: Agent, run: RoomRun): boolean =>
  run.sessionId !== undefined
  && agent.id === run.sessionId
  && agent.session.id === run.sessionId
  && Number.isSafeInteger(agent.generation)
  && agent.generation > 0;

export interface ChatroomApprovalRequestPreparationInput {
  readonly room: Room;
  readonly requesterRunId: string;
  readonly requesterAgent: Agent;
  /** Process-local owner lookup by exact Room run id; never by label or agent name. */
  readonly liveAgentForRun: (runId: string) => Agent | undefined;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason: string;
  readonly signal?: AbortSignal;
}

export type ChatroomApprovalRequestPreparation =
  | {
    readonly status: 'ready';
    readonly request: ApprovalRequest;
    readonly requester: { readonly run: RoomRun; readonly member: RoomMembership; };
    readonly authority: { readonly run: RoomRun; readonly member: RoomMembership; };
  }
  | {
    readonly status: 'unavailable';
    readonly code:
      | 'requester-run-unavailable'
      | 'requester-identity-unavailable'
      | 'requester-agent-mismatch'
      | 'authority-member-unavailable'
      | 'authority-identity-unavailable'
      | 'authority-run-unavailable'
      | 'authority-agent-unavailable'
      | 'authority-agent-mismatch'
      | 'reason-invalid'
      | 'tool-name-invalid'
      | 'call-id-invalid';
  };

const unavailable = <C extends Extract<ChatroomApprovalRequestPreparation, { status: 'unavailable'; }>['code']>(
  code: C,
): Extract<ChatroomApprovalRequestPreparation, { status: 'unavailable'; }> =>
  Object.freeze({
    status: 'unavailable',
    code,
  });

/**
 * Resolves the exact Reviewer -> reportsTo authority pair while both Agents
 * are live. Room membership identity is the only business mapping; display
 * names and ambient/current Agents are never consulted.
 */
export function prepareChatroomApprovalRequest(
  input: ChatroomApprovalRequestPreparationInput,
): ChatroomApprovalRequestPreparation {
  const requesterRun = input.room.runs.find(run => run.runId === input.requesterRunId);
  if (requesterRun === undefined) return unavailable('requester-run-unavailable');
  const requesterMember = input.room.memberships.find(member => member.memberId === requesterRun.memberId);
  if (requesterMember === undefined || !exactIdentity(requesterMember.definition)) {
    return unavailable('requester-identity-unavailable');
  }
  if (!exactLiveAgent(input.requesterAgent, requesterRun)) {
    return unavailable('requester-agent-mismatch');
  }
  if (!validReason(input.reason)) return unavailable('reason-invalid');
  if (!validToolName(input.toolName)) return unavailable('tool-name-invalid');
  if (input.callId !== undefined && !validOpaqueId(input.callId)) return unavailable('call-id-invalid');

  const authorityMemberId = approvalAuthorityMemberIds(input.room, requesterMember.memberId)[0];
  const authorityMember = authorityMemberId === undefined
    ? undefined
    : input.room.memberships.find(member => member.memberId === authorityMemberId);
  if (authorityMember === undefined) return unavailable('authority-member-unavailable');
  if (!exactIdentity(authorityMember.definition)) return unavailable('authority-identity-unavailable');

  const authorityRuns = input.room.runs.filter(run => run.memberId === authorityMember.memberId);
  const preferred = authorityMember.preferredRunId === undefined
    ? undefined
    : authorityRuns.find(run => run.runId === authorityMember.preferredRunId);
  const liveCandidates = (preferred === undefined ? authorityRuns : [preferred])
    .flatMap(run => {
      const agent = input.liveAgentForRun(run.runId);
      return agent === undefined ? [] : [{ run, agent }];
    });
  if (authorityRuns.length === 0 || (authorityMember.preferredRunId !== undefined && preferred === undefined)) {
    return unavailable('authority-run-unavailable');
  }
  if (liveCandidates.length !== 1) return unavailable('authority-agent-unavailable');
  const authority = liveCandidates[0];
  if (!exactLiveAgent(authority.agent, authority.run)) return unavailable('authority-agent-mismatch');

  const reason: ApprovalReason = Object.freeze({ kind: 'plain-text', text: input.reason });
  const request: ApprovalRequest = Object.freeze({
    requester: Object.freeze({ agent: input.requesterAgent, definition: requesterMember.definition }),
    authority: Object.freeze({ agent: authority.agent, definition: authorityMember.definition }),
    toolName: input.toolName,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    reason,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return Object.freeze({
    status: 'ready',
    request,
    requester: Object.freeze({ run: requesterRun, member: requesterMember }),
    authority: Object.freeze({ run: authority.run, member: authorityMember }),
  });
}

export type ChatroomApprovalRequestExecution =
  | Exclude<ChatroomApprovalRequestPreparation, { readonly status: 'ready'; }>
  | {
    readonly status: 'decided';
    readonly decision: ApprovalDecision;
    readonly requester: { readonly run: RoomRun; readonly member: RoomMembership; };
    readonly authority: { readonly run: RoomRun; readonly member: RoomMembership; };
  }
  | { readonly status: 'unavailable'; readonly code: 'decision-correlation-invalid'; };

/** Calls only the public v2 service after the exact Room mapping is complete. */
export async function requestChatroomApproval(
  approvals: ApprovalService,
  input: ChatroomApprovalRequestPreparationInput,
): Promise<ChatroomApprovalRequestExecution> {
  const prepared = prepareChatroomApprovalRequest(input);
  if (prepared.status !== 'ready') return prepared;
  const decision = await approvals.request(prepared.request);
  const requester = prepared.request.requester.agent;
  const authority = prepared.request.authority.agent;
  if (
    !bindingMatches(decision.requester, prepared.request.requester.definition)
    || decision.requester.agentId !== requester.id
    || decision.requester.sessionId !== requester.session.id
    || decision.requester.agentGeneration !== requester.generation
    || !bindingMatches(decision.authority, prepared.request.authority.definition)
    || decision.authority.agentId !== authority.id
    || decision.authority.sessionId !== authority.session.id
    || decision.authority.agentGeneration !== authority.generation
  ) {
    return Object.freeze({ status: 'unavailable', code: 'decision-correlation-invalid' });
  }
  return Object.freeze({
    status: 'decided',
    decision,
    requester: prepared.requester,
    authority: prepared.authority,
  });
}

type ApprovalAskedEvent = SessionEvent<'approval/asked'>;
type ApprovalDecidedEvent = SessionEvent<'approval/decided'>;
export type ChatroomApprovalBubbleEvent =
  | ApprovalAuthorityBoundSessionEvent
  | ApprovalAskedEvent
  | ApprovalDecidedEvent;

export interface ChatroomApprovalBubbleProjectionInput {
  readonly room: Room;
  readonly sessionId: SessionId;
  readonly approvalId: string;
  readonly events: readonly ChatroomApprovalBubbleEvent[];
  /** Present only while the exact requester and authority Agents remain live. */
  readonly liveQuestion?: ApprovalQuestion;
  readonly sequence: number;
}

export type ChatroomApprovalBubbleProjection =
  | { readonly status: 'projected'; readonly item: AgentConversationApprovalItem; }
  | { readonly status: 'legacy'; readonly code: 'authority-binding-missing'; }
  | { readonly status: 'waiting'; readonly code: 'live-authority-unavailable'; }
  | {
    readonly status: 'invalid';
    readonly code:
      | 'event-correlation-invalid'
      | 'event-order-invalid'
      | 'requester-correlation-invalid'
      | 'authority-correlation-invalid'
      | 'reason-correlation-invalid'
      | 'live-question-invalid';
  };

const projectionResult = <T extends ChatroomApprovalBubbleProjection>(value: T): T => Object.freeze(value);

const bindingMatches = (
  binding: ApprovalAgentBinding,
  definition: AgentDefinitionIdentity,
): boolean =>
  binding.agentId === binding.sessionId
  && Number.isSafeInteger(binding.agentGeneration)
  && binding.agentGeneration > 0
  && sameIdentity(binding.definition, definition);

const bindingMatchesAgent = (binding: ApprovalAgentBinding, agent: Agent): boolean =>
  binding.agentId === agent.id
  && binding.sessionId === agent.session.id
  && binding.agentGeneration === agent.generation;

const routingResult = (
  question: ApprovalRequestRoutingQuestion,
  result:
    | {
      readonly status: 'accepted';
      readonly code: 'routed';
      readonly requester: ApprovalAgentBinding;
      readonly authority: ApprovalAgentBinding;
    }
    | {
      readonly status: 'unavailable';
      readonly code: 'mapping-unavailable' | 'authority-unavailable';
    },
): ApprovalRequestRoutingResult =>
  result.status === 'accepted'
    ? Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
      contract: 'cordisx.approval-request-routing-result/v1',
      schemaVersion: 1,
      routingId: question.routingId,
      registration: question.registration,
      status: result.status,
      code: result.code,
      requester: result.requester,
      authority: result.authority,
    })
    : Object.freeze({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-result.v1.schema.json',
      contract: 'cordisx.approval-request-routing-result/v1',
      schemaVersion: 1,
      routingId: question.routingId,
      registration: question.registration,
      status: result.status,
      code: result.code,
    });

export interface ChatroomDriverApprovalRouteInput {
  readonly room: Room;
  readonly question: ApprovalRequestRoutingQuestion;
  /** Process-local owner lookup by exact Room run id; never by label or agent name. */
  readonly liveAgentForRun: (runId: string) => Agent | undefined;
}

/**
 * Resolves a Host driver approval before persistence. The exact requester
 * registration selects one Room run; only that member's direct reportsTo edge
 * may select the live authority. The resolver never appends SessionEvent.
 */
export function routeChatroomDriverApproval(
  input: ChatroomDriverApprovalRouteInput,
): ApprovalRequestRoutingResult {
  const question = input.question;
  if (
    question.registration.requester.agentId !== question.requester.agentId
    || question.registration.requester.sessionId !== question.requester.sessionId
    || question.registration.requester.agentGeneration !== question.requester.agentGeneration
    || !sameIdentity(question.registration.requester.definition, question.requester.definition)
  ) {
    return routingResult(question, { status: 'unavailable', code: 'mapping-unavailable' });
  }
  const requesterRuns = input.room.runs.filter(run => run.sessionId === question.requester.sessionId);
  if (requesterRuns.length !== 1) {
    return routingResult(question, { status: 'unavailable', code: 'mapping-unavailable' });
  }
  const requesterRun = requesterRuns[0];
  const requesterMember = input.room.memberships.find(member => member.memberId === requesterRun.memberId);
  const requesterAgent = input.liveAgentForRun(requesterRun.runId);
  if (
    requesterMember === undefined
    || requesterAgent === undefined
    || !exactIdentity(requesterMember.definition)
    || !sameIdentity(question.requester.definition, requesterMember.definition)
    || !bindingMatches(question.requester, requesterMember.definition)
    || !bindingMatchesAgent(question.requester, requesterAgent)
    || !exactLiveAgent(requesterAgent, requesterRun)
  ) {
    return routingResult(question, { status: 'unavailable', code: 'mapping-unavailable' });
  }

  const authorityMemberId = approvalAuthorityMemberIds(input.room, requesterMember.memberId)[0];
  const authorityMember = authorityMemberId === undefined
    ? undefined
    : input.room.memberships.find(member => member.memberId === authorityMemberId);
  if (authorityMember === undefined || !exactIdentity(authorityMember.definition)) {
    return routingResult(question, { status: 'unavailable', code: 'authority-unavailable' });
  }
  const authorityRuns = input.room.runs.filter(run => run.memberId === authorityMember.memberId);
  const preferred = authorityMember.preferredRunId === undefined
    ? authorityRuns.length === 1 ? authorityRuns[0] : undefined
    : authorityRuns.find(run => run.runId === authorityMember.preferredRunId);
  const authorityAgent = preferred === undefined ? undefined : input.liveAgentForRun(preferred.runId);
  if (preferred === undefined || authorityAgent === undefined || !exactLiveAgent(authorityAgent, preferred)) {
    return routingResult(question, { status: 'unavailable', code: 'authority-unavailable' });
  }
  return routingResult(question, {
    status: 'accepted',
    code: 'routed',
    requester: question.requester,
    authority: Object.freeze({
      agentId: authorityAgent.id,
      sessionId: authorityAgent.session.id,
      agentGeneration: authorityAgent.generation,
      definition: authorityMember.definition,
    }),
  });
}

const approvalState = (
  outcome: ApprovalDecidedEvent['data']['outcome'],
): 'approved' | 'denied' | 'cancelled' | 'failed' => {
  if (outcome === 'allowed-once') return 'approved';
  if (outcome === 'rejected') return 'denied';
  if (outcome === 'cancelled') return 'cancelled';
  return 'failed';
};

export const chatroomApprovalBubbleItemId = (sessionId: SessionId, approvalId: string): string =>
  createChatroomOpaqueId('session-approval', sessionId, approvalId);

/**
 * Projects only the v7 authority-bound shape. An old asked/decided ledger is
 * explicitly left to the existing v6 compatibility source; no Lead identity
 * or generation is reconstructed from current process state.
 */
export function projectChatroomApprovalBubble(
  input: ChatroomApprovalBubbleProjectionInput,
): ChatroomApprovalBubbleProjection {
  const bound = input.events.filter((event): event is ApprovalAuthorityBoundSessionEvent =>
    event.type === 'approval/authority-bound'
    && event.sessionId === input.sessionId
    && event.data.approvalId === input.approvalId
  );
  if (bound.length === 0) return projectionResult({ status: 'legacy', code: 'authority-binding-missing' });
  const asked = input.events.filter((event): event is ApprovalAskedEvent =>
    event.type === 'approval/asked'
    && event.sessionId === input.sessionId
    && event.data.id === input.approvalId
  );
  const decided = input.events.filter((event): event is ApprovalDecidedEvent =>
    event.type === 'approval/decided'
    && event.sessionId === input.sessionId
    && event.data.id === input.approvalId
  );
  if (bound.length !== 1 || asked.length !== 1 || decided.length > 1) {
    return projectionResult({ status: 'invalid', code: 'event-correlation-invalid' });
  }
  if (bound[0].seq >= asked[0].seq || (decided[0] !== undefined && asked[0].seq >= decided[0].seq)) {
    return projectionResult({ status: 'invalid', code: 'event-order-invalid' });
  }
  const binding = bound[0].data;
  if (!exactIdentity(binding.requester) || !exactIdentity(binding.authority)) {
    return projectionResult({ status: 'invalid', code: 'event-correlation-invalid' });
  }
  const requesterRuns = input.room.runs.filter(run => run.sessionId === input.sessionId);
  if (requesterRuns.length !== 1) {
    return projectionResult({ status: 'invalid', code: 'requester-correlation-invalid' });
  }
  const requesterRun = requesterRuns[0];
  const requesterMember = input.room.memberships.find(member => member.memberId === requesterRun.memberId);
  if (requesterMember === undefined || !sameIdentity(requesterMember.definition, binding.requester)) {
    return projectionResult({ status: 'invalid', code: 'requester-correlation-invalid' });
  }
  const authorityMemberId = approvalAuthorityMemberIds(input.room, requesterMember.memberId)[0];
  const authorityMember = authorityMemberId === undefined
    ? undefined
    : input.room.memberships.find(member => member.memberId === authorityMemberId);
  if (authorityMember === undefined || !sameIdentity(authorityMember.definition, binding.authority)) {
    return projectionResult({ status: 'invalid', code: 'authority-correlation-invalid' });
  }
  if (asked[0].data.reason !== binding.reason.text || !validReason(binding.reason.text)) {
    return projectionResult({ status: 'invalid', code: 'reason-correlation-invalid' });
  }

  const question = input.liveQuestion;
  if (question !== undefined) {
    const authorityRuns = input.room.runs.filter(run =>
      run.memberId === authorityMember.memberId
      && run.sessionId === question.authority.sessionId
    );
    if (
      question.id !== input.approvalId
      || question.toolName !== asked[0].data.toolName
      || question.callId !== asked[0].data.callId
      || question.reason.kind !== 'plain-text'
      || question.reason.text !== binding.reason.text
      || question.requester.sessionId !== input.sessionId
      || !bindingMatches(question.requester, binding.requester)
      || !bindingMatches(question.authority, binding.authority)
      || authorityRuns.length !== 1
    ) {
      return projectionResult({ status: 'invalid', code: 'live-question-invalid' });
    }
  }

  const common = {
    kind: 'approval' as const,
    itemId: chatroomApprovalBubbleItemId(input.sessionId, input.approvalId),
    sequence: input.sequence,
    participantId: requesterMember.participantId,
    memberId: requesterMember.memberId,
    runId: requesterRun.runId,
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    approvalKind: 'command' as const,
    requester: binding.requester,
    authority: Object.freeze({
      participantId: authorityMember.participantId,
      memberId: authorityMember.memberId,
      identity: binding.authority,
    }),
    reason: binding.reason,
  };
  if (decided[0] === undefined) {
    if (question === undefined) {
      return projectionResult({ status: 'waiting', code: 'live-authority-unavailable' });
    }
    const actions = Object.freeze(
      [
        Object.freeze({ decision: 'approve', command: Object.freeze({ id: CHATROOM_COMMAND_APPROVAL_APPROVE }) }),
        Object.freeze({ decision: 'reject', command: Object.freeze({ id: CHATROOM_COMMAND_APPROVAL_DENY }) }),
      ] as const,
    );
    const item: AgentConversationApprovalItem = Object.freeze({
      ...common,
      state: 'pending',
      agentGeneration: question.requester.agentGeneration,
      authorityBinding: question.authority,
      actions,
    });
    return projectionResult({
      status: 'projected',
      item,
    });
  }
  const state = approvalState(decided[0].data.outcome);
  const actions = Object.freeze([] as const);
  const item: AgentConversationApprovalItem = state === 'failed'
    ? Object.freeze({
      ...common,
      state,
      actions,
      diagnostic: Object.freeze({
        namespace: 'chatroom',
        key: 'agent.approval.unavailable',
        fallback: 'Approval unavailable',
      }),
    })
    : Object.freeze({ ...common, state, actions });
  return projectionResult({ status: 'projected', item });
}
