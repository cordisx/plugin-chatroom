import type {
  AgentAdmission,
  AgentHandle,
} from '@cordisx/protocol/agents/v1';
import type {
  AgentAdmissionTarget,
  AgentAdmissionTargetOriginService,
  AgentAdmissionTargetReservationService,
} from '@cordisx/protocol/agent-admission/v3';
import type { AgentCommandOrigin } from '@cordisx/protocol/agent-admission/v1';

export interface ChatroomAdmissionMessage {
  readonly text: string;
}

export interface ChatroomAgentAdmissionV3Request {
  /** Obtained by Chatroom's exact ensureOwner/acquire path for this target. */
  readonly handle: AgentHandle;
  /** The one Shell v8 composer-submit capability shared only as an input to issue(). */
  readonly origin: AgentCommandOrigin;
  /** Exact Room-local target for this one delivery. */
  readonly target: AgentAdmissionTarget;
  /** The exact dispatch text; never a Chatroom-generated driver message. */
  readonly message: ChatroomAdmissionMessage;
}

export type ChatroomAgentAdmissionV3Result =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted' };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'issue' | 'reserve';
    readonly code: 'not-owner' | 'origin-denied' | 'target-denied' | 'target-mismatch'
      | 'stale' | 'command-complete' | 'reused';
  };

/**
 * Performs the only permitted v3 pre-submit dispatch for one Room delivery:
 * issue a target-scoped opaque origin, reserve that target's exact owner, and
 * submit its one-shot reservation. It deliberately has no Agent driver
 * dependency, so an issue/reservation denial or error cannot fall back to
 * send, followup, steer, or inject.
 */
export async function submitChatroomAgentAdmissionV3(
  origins: AgentAdmissionTargetOriginService,
  reservations: AgentAdmissionTargetReservationService,
  request: ChatroomAgentAdmissionV3Request,
): Promise<ChatroomAgentAdmissionV3Result> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom admission message must not be empty.');
  }
  const issued = await origins.issue({ origin: request.origin, target: request.target });
  if (issued.status === 'denied') {
    return { status: 'denied', stage: 'issue', code: issued.code };
  }
  const reserved = await reservations.reserve({
    handle: request.handle,
    origin: issued.origin,
    message: request.message,
  });
  if (reserved.status === 'denied') {
    return { status: 'denied', stage: 'reserve', code: reserved.code };
  }
  return { status: 'accepted', admission: await reserved.reservation.submit() };
}
