import type { AgentAdmission, AgentHandle } from '@cordisx/protocol/agents/v1';
import type { AgentAdmissionTarget } from '@cordisx/protocol/agent-admission/v3';
import type {
  AgentAdmissionBootstrapReservationService,
  AgentAdmissionBootstrapTargetOrigin,
  AgentAdmissionBootstrapTargetService,
  AgentBootstrapCommandOrigin,
} from '@cordisx/protocol/agent-admission/v4';

export interface ChatroomAdmissionMessage {
  readonly text: string;
}

export type ChatroomAgentAdmissionV4Result =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted'; };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'issue' | 'reserve';
    readonly code:
      | 'not-owner'
      | 'origin-denied'
      | 'target-denied'
      | 'target-mismatch'
      | 'stale'
      | 'command-complete'
      | 'duplicate-target'
      | 'reused';
  };

/**
 * Declares the exact freshly persisted Room target before Chatroom acquires
 * its Agent. The opaque result is the only authority accepted by v4 reserve.
 */
export async function issueChatroomAgentAdmissionBootstrapTarget(
  targets: AgentAdmissionBootstrapTargetService,
  origin: AgentBootstrapCommandOrigin,
  target: AgentAdmissionTarget,
): Promise<
  | { readonly status: 'issued'; readonly origin: AgentAdmissionBootstrapTargetOrigin; }
  | Extract<ChatroomAgentAdmissionV4Result, { readonly status: 'denied'; }>
> {
  const issued = await targets.issue({ origin, target });
  return issued.status === 'issued'
    ? issued
    : { status: 'denied', stage: 'issue', code: issued.code };
}

/**
 * Performs the only permitted post-acquire operation for a bootstrap target:
 * reserve the exact AgentHandle and invoke that reservation's one-shot
 * submit. There is deliberately no driver dependency or legacy fallback.
 */
export async function submitChatroomAgentAdmissionBootstrapReservation(
  reservations: AgentAdmissionBootstrapReservationService,
  request: Readonly<{
    handle: AgentHandle;
    origin: AgentAdmissionBootstrapTargetOrigin;
    message: ChatroomAdmissionMessage;
  }>,
): Promise<ChatroomAgentAdmissionV4Result> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom bootstrap admission message must not be empty.');
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
