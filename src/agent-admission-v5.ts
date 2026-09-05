import type {
  AgentAdmission,
  AgentHandle,
} from '@cordisx/protocol/agents/v1';
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4';
import type {
  AgentAdmissionBootstrapRoomReservationResult,
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetOrigin,
  AgentAdmissionBootstrapRoomTargetResult,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5';

import type { ChatroomAdmissionMessage } from './agent-admission-v4.js';

export type ChatroomAgentAdmissionV5Result =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted' };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'issue';
    readonly code: Extract<AgentAdmissionBootstrapRoomTargetResult, { readonly status: 'denied' }>['code'];
  }
  | {
    readonly status: 'denied';
    readonly stage: 'reserve';
    readonly code: Extract<AgentAdmissionBootstrapRoomReservationResult, { readonly status: 'denied' }>['code'];
  };

/**
 * Commits one already-persisted Room delivery to the still-live bootstrap
 * command. The returned receipt deliberately stays Host-owned: v5 captures
 * the same-binding Room source during the one-shot reservation submit.
 */
export async function issueChatroomAgentAdmissionBootstrapRoomTarget(
  targets: AgentAdmissionBootstrapRoomTargetService,
  origin: AgentBootstrapCommandOrigin,
  target: AgentAdmissionBootstrapRoomTarget,
): Promise<
  | { readonly status: 'issued'; readonly origin: AgentAdmissionBootstrapRoomTargetOrigin }
  | Extract<ChatroomAgentAdmissionV5Result, { readonly stage: 'issue' }>
> {
  const issued = await targets.issue({ origin, target });
  return issued.status === 'issued'
    ? { status: 'issued', origin: issued.origin }
    : { status: 'denied', stage: 'issue', code: issued.code };
}

/**
 * Performs the only allowed post-acquire v5 operation: reserve the exact
 * AgentHandle against the opaque target origin, then invoke the reservation's
 * one-shot submit. There is intentionally no Agent driver fallback.
 */
export async function submitChatroomAgentAdmissionBootstrapRoomReservation(
  reservations: AgentAdmissionBootstrapRoomReservationService,
  request: Readonly<{
    handle: AgentHandle;
    origin: AgentAdmissionBootstrapRoomTargetOrigin;
    message: ChatroomAdmissionMessage;
  }>,
): Promise<ChatroomAgentAdmissionV5Result> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom bootstrap Room admission message must not be empty.');
  }
  const reserved = await reservations.reserve({
    handle: request.handle,
    origin: request.origin,
    message: request.message,
  });
  if (reserved.status === 'denied') {
    return { status: 'denied', stage: 'reserve', code: reserved.code };
  }
  return { status: 'accepted', admission: await reserved.reservation.submit() };
}
