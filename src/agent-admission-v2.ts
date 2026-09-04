import type {
  AgentAdmission,
  AgentHandle,
} from '@cordisx/protocol/agents/v1';
import type {
  AgentAdmissionReservationService,
  AgentCommandOrigin,
} from '@cordisx/protocol/agent-admission/v2';

/**
 * The minimum Room identity the public v2 reservation contract must attest.
 * This is intentionally structural so the adapter stays independent of the
 * Host runtime and of Chatroom's durable Room implementation.
 */
export interface ChatroomAdmissionTarget {
  readonly roomId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
}

export interface ChatroomAdmissionMessage {
  readonly text: string;
}

export interface ChatroomAgentAdmissionV2Request {
  /** Obtained by Chatroom's exact ensureOwner/acquire path. */
  readonly handle: AgentHandle;
  /** Host-generated capability from one Shell v8 composer-submit command. */
  readonly origin: AgentCommandOrigin;
  /** Exact durable Room/member/run which Chatroom is about to dispatch to. */
  readonly target: ChatroomAdmissionTarget;
  /** The exact dispatch text; never a Chatroom-generated driver message. */
  readonly message: ChatroomAdmissionMessage;
}

export type ChatroomAgentAdmissionV2Result =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted' };
  }
  | {
    readonly status: 'denied';
    readonly code: 'not-owner' | 'origin-denied' | 'stale' | 'command-complete' | 'reused';
  };

function requireExactOrigin(
  origin: AgentCommandOrigin,
  target: ChatroomAdmissionTarget,
): void {
  if (origin.scope !== 'composer-submit') {
    throw new Error('Chatroom admission origin must be a composer-submit capability.');
  }
  if (origin.room.roomId !== target.roomId
    || origin.room.participantId !== target.participantId
    || origin.room.memberId !== target.memberId
    || origin.room.runId !== target.runId) {
    throw new Error('Chatroom admission origin does not match the exact Room member run.');
  }
}

/**
 * Performs the only permitted v2 pre-submit dispatch: reserve, then submit
 * the returned one-shot reservation. It deliberately has no Agent driver
 * dependency, so a reservation refusal or error cannot fall back to send,
 * followup, steer, or inject.
 */
export async function submitChatroomAgentAdmissionV2(
  service: AgentAdmissionReservationService,
  request: ChatroomAgentAdmissionV2Request,
): Promise<ChatroomAgentAdmissionV2Result> {
  requireExactOrigin(request.origin, request.target);
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom admission message must not be empty.');
  }
  const reserved = await service.reserve({
    handle: request.handle,
    origin: request.origin,
    message: request.message,
  });
  if (reserved.status === 'denied') {
    return { status: 'denied', code: reserved.code };
  }
  return { status: 'accepted', admission: await reserved.reservation.submit() };
}
