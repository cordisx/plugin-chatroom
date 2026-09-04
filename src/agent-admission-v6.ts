import type {
  AgentAdmission,
  AgentHandle,
} from '@cordisx/protocol/agents/v1';
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4';
import type {
  AgentAdmissionBootstrapRouteContinuation,
  AgentAdmissionBootstrapRouteDeclarationResult,
  AgentAdmissionBootstrapRouteDeclarationService,
  AgentAdmissionBootstrapRouteReservationResult,
  AgentAdmissionBootstrapRouteReservationService,
  AgentAdmissionBootstrapRouteTarget,
} from '@cordisx/protocol/agent-admission/v6';

import type { ChatroomAdmissionMessage } from './agent-admission-v4.js';

export type ChatroomAgentAdmissionV6Result =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted' };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'declare';
    readonly code: Extract<AgentAdmissionBootstrapRouteDeclarationResult, { readonly status: 'denied' }>['code'];
  }
  | {
    readonly status: 'denied';
    readonly stage: 'reserve';
    readonly code: Extract<AgentAdmissionBootstrapRouteReservationResult, { readonly status: 'denied' }>['code'];
  };

/**
 * Declares the exact persisted Room delivery and its future same-owner Room
 * route before Chatroom acquires the target Agent. The continuation stays
 * opaque: only Host route activation may claim it after accepted submission.
 */
export async function declareChatroomAgentAdmissionBootstrapRoute(
  declarations: AgentAdmissionBootstrapRouteDeclarationService,
  origin: AgentBootstrapCommandOrigin,
  target: AgentAdmissionBootstrapRouteTarget,
): Promise<
  | { readonly status: 'declared'; readonly continuation: AgentAdmissionBootstrapRouteContinuation }
  | Extract<ChatroomAgentAdmissionV6Result, { readonly stage: 'declare' }>
> {
  const declared = await declarations.declare({ origin, target });
  return declared.status === 'declared'
    ? declared
    : { status: 'denied', stage: 'declare', code: declared.code };
}

/**
 * Performs the only permitted post-acquire operation for a declared Room
 * continuation: reserve the exact AgentHandle, then invoke its one-shot
 * submit. There is no direct driver dispatch or plugin-side route claim.
 */
export async function submitChatroomAgentAdmissionBootstrapRouteReservation(
  reservations: AgentAdmissionBootstrapRouteReservationService,
  request: Readonly<{
    handle: AgentHandle;
    continuation: AgentAdmissionBootstrapRouteContinuation;
    message: ChatroomAdmissionMessage;
  }>,
): Promise<ChatroomAgentAdmissionV6Result> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom bootstrap route admission message must not be empty.');
  }
  const reserved = await reservations.reserve({
    handle: request.handle,
    continuation: request.continuation,
    message: request.message,
  });
  if (reserved.status === 'denied') {
    return { status: 'denied', stage: 'reserve', code: reserved.code };
  }
  return { status: 'accepted', admission: await reserved.reservation.submit() };
}
