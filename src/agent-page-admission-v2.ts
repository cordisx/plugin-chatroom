import type { AgentAdmission, AgentHandle } from '@cordisx/protocol/agents/v1';
import type {
  AgentPageAdmissionReservationResult,
  AgentPageAdmissionReservationService,
  AgentPageAdmissionRouteContinuation,
  AgentPageAdmissionRouteDeclarationResult,
  AgentPageAdmissionRouteDeclarationService,
  AgentPageAdmissionRouteReservationResult,
  AgentPageAdmissionRouteReservationService,
  AgentPageAdmissionRouteTarget,
  AgentPageAdmissionTarget,
  AgentPageAdmissionTargetOrigin,
  AgentPageAdmissionTargetResult,
  AgentPageAdmissionTargetService,
  AgentPageComposerOrigin,
} from '@cordisx/protocol/agent-page-admission/v2';

export interface ChatroomPageAdmissionMessage {
  readonly text: string;
}

export type ChatroomPageAdmissionTargetResult =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted'; };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'issue';
    readonly code: Extract<AgentPageAdmissionTargetResult, { readonly status: 'denied'; }>['code'];
  }
  | {
    readonly status: 'denied';
    readonly stage: 'reserve';
    readonly code: Extract<AgentPageAdmissionReservationResult, { readonly status: 'denied'; }>['code'];
  };

export type ChatroomPageAdmissionRouteResult =
  | {
    readonly status: 'accepted';
    readonly admission: AgentAdmission & { readonly status: 'accepted'; };
  }
  | {
    readonly status: 'denied';
    readonly stage: 'declare';
    readonly code: Extract<AgentPageAdmissionRouteDeclarationResult, { readonly status: 'denied'; }>['code'];
  }
  | {
    readonly status: 'denied';
    readonly stage: 'reserve';
    readonly code: Extract<AgentPageAdmissionRouteReservationResult, { readonly status: 'denied'; }>['code'];
  };

/** Declares an existing-Room target before Chatroom acquires its exact Agent. */
export async function issueChatroomPageAdmissionTarget(
  targets: AgentPageAdmissionTargetService,
  origin: AgentPageComposerOrigin,
  target: AgentPageAdmissionTarget,
): Promise<
  | { readonly status: 'issued'; readonly origin: AgentPageAdmissionTargetOrigin; }
  | Extract<ChatroomPageAdmissionTargetResult, { readonly stage: 'issue'; }>
> {
  const issued = await targets.issue({ origin, target });
  if (issued.status === 'denied') {
    return { status: 'denied', stage: 'issue', code: issued.code };
  }
  return { status: 'issued', origin: issued.origin };
}

/** Reserves one issued existing-Room target and submits it exactly once. */
export async function submitChatroomPageAdmissionReservation(
  reservations: AgentPageAdmissionReservationService,
  request: Readonly<{
    handle: AgentHandle;
    origin: AgentPageAdmissionTargetOrigin;
    message: ChatroomPageAdmissionMessage;
  }>,
): Promise<ChatroomPageAdmissionTargetResult> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom page admission message must not be empty.');
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

/** Declares a fresh-Room target and its destination route before acquisition. */
export async function declareChatroomPageAdmissionRoute(
  declarations: AgentPageAdmissionRouteDeclarationService,
  origin: AgentPageComposerOrigin,
  target: AgentPageAdmissionRouteTarget,
): Promise<
  | { readonly status: 'declared'; readonly continuation: AgentPageAdmissionRouteContinuation; }
  | Extract<ChatroomPageAdmissionRouteResult, { readonly stage: 'declare'; }>
> {
  const declared = await declarations.declare({ origin, target });
  if (declared.status === 'denied') {
    return { status: 'denied', stage: 'declare', code: declared.code };
  }
  return { status: 'declared', continuation: declared.continuation };
}

/** Reserves one declared fresh-Room target; only its one-shot submit dispatches. */
export async function submitChatroomPageAdmissionRouteReservation(
  reservations: AgentPageAdmissionRouteReservationService,
  request: Readonly<{
    handle: AgentHandle;
    continuation: AgentPageAdmissionRouteContinuation;
    message: ChatroomPageAdmissionMessage;
  }>,
): Promise<ChatroomPageAdmissionRouteResult> {
  if (request.message.text.trim() === '') {
    throw new Error('Chatroom fresh page admission message must not be empty.');
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

export type { AgentPageAdmissionRouteContinuation, AgentPageAdmissionTargetOrigin };
