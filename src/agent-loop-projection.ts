import type {
  AgentConversationItem,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v3';
import type { AgentLoopEvent } from '@cordisx/protocol/agent-loop/v4';

import { projectRoomParticipant, text } from './conversation-model.js';
import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
} from './conversation-model.js';
import { canonicalRoomPayloadHash } from './room-delivery.js';
import { completeRoomAcknowledgement, failRoomAcknowledgement } from './room-engagement.js';
import {
  memberSelfIntroductionMatchesProjection,
  projectMemberSelfIntroduction,
  requireMemberSelfIntroductionAttention,
  updateApprovalDecision,
} from './room-agent-operations.js';
import {
  closeRoomRun,
  createChatroomOpaqueId,
  createRoom,
  nextRoomTimelineSequence,
  replaceRoomRun,
  replaceRoomRunProjection,
  type Room,
  type RoomImageReference,
  roomRunOwnsAgentLoopBinding,
  type RoomRunPublicProjection,
  roomRunPublicProjectionForItem,
  roomRunPublicProjectionMatchesItem,
  type RoomRunStatus,
} from './room.js';

export interface AgentLoopProjectionResult {
  readonly accepted: boolean;
  readonly room: Room;
}

const memberParticipant = (room: Room, runId: string): AgentConversationParticipant => {
  const run = room.runs.find(candidate => candidate.runId === runId)!;
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  const participant = room.participants.find(candidate => candidate.id === member.participantId);
  return projectRoomParticipant(
    participant ?? {
      id: member.participantId,
      name: member.label,
      kind: 'agent',
      avatar: member.avatar,
    },
    room,
  );
};

const advance = (room: Room, runId: string, eventCursor: number, status?: RoomRunStatus) =>
  replaceRoomRunProjection(room, runId, { eventCursor, ...(status === undefined ? {} : { status }) });

const publicEventItemId = (
  namespace: 'agent-message' | 'agent-status' | 'agent-approval',
  runId: string,
  event: AgentLoopEvent,
  semantic: Readonly<Record<string, string | number | boolean | null>>,
) =>
  createChatroomOpaqueId(
    namespace,
    runId,
    canonicalRoomPayloadHash({
      type: event.type,
      turn: event.turn ?? null,
      operationId: event.causation?.operationId ?? null,
      ...semantic,
    }),
  );

const appendItem = (
  room: Room,
  runId: string,
  eventCursor: number,
  item: Extract<AgentConversationItem, { kind: 'message' | 'status'; }>,
  status?: RoomRunStatus,
  images?: readonly RoomImageReference[],
) => {
  // A rebind owns a new binding generation and therefore resumes at cursor -1,
  // but the provider may replay the same logical task event log. Public item
  // identity is scoped by Room run plus provider-stable message/turn/causation
  // semantics. Binding-scoped eventId/sequence never participates, so an exact
  // replay advances only the new generation's cursor and keeps the first
  // durable public projection unchanged.
  const correlation: RoomRunPublicProjection = roomRunPublicProjectionForItem(item);
  const compatibleCorrelation = (candidate: RoomRunPublicProjection) =>
    candidate.kind === correlation.kind
    && candidate.association === correlation.association;
  const run = room.runs.find(candidate => candidate.runId === runId)!;
  const recorded = run.publicProjections?.find(candidate => candidate.itemId === item.itemId);
  if (recorded !== undefined) {
    const visible = room.items.find(candidate => candidate.itemId === item.itemId);
    if (
      !compatibleCorrelation(recorded)
      || (visible !== undefined && !roomRunPublicProjectionMatchesItem(recorded, visible))
    ) {
      throw new Error('AgentLoop public projection identity collided with an incompatible Room item.');
    }
    return replaceRoomRunProjection(room, runId, {
      eventCursor,
      ...(status === undefined ? {} : { status }),
    });
  }
  const existing = room.items.find(candidate => candidate.itemId === item.itemId);
  if (existing !== undefined) {
    if (!roomRunPublicProjectionMatchesItem(correlation, existing)) {
      throw new Error('AgentLoop public projection identity collided with an incompatible Room item.');
    }
    return replaceRoomRunProjection(room, runId, {
      eventCursor,
      publicProjection: correlation,
      ...(status === undefined ? {} : { status }),
    });
  }
  return replaceRoomRunProjection(room, runId, {
    items: [...room.items, item],
    imageReferences: images === undefined ? room.imageReferences : [...room.imageReferences, ...images],
    eventCursor,
    publicProjection: correlation,
    ...(status === undefined ? {} : { status }),
  });
};

function messageProjection(room: Room, runId: string, event: Extract<AgentLoopEvent, { type: 'message'; }>): Room {
  // The private session's echoed user message is not part of the public aggregate.
  if (event.message.role !== 'assistant') return advance(room, runId, event.sequence);
  const itemId = publicEventItemId('agent-message', runId, event, {
    messageId: event.message.messageId,
    role: event.message.role,
    purpose: event.message.purpose,
  });
  const images: RoomImageReference[] = [];
  const body = event.message.content.map((part, contentIndex) => {
    if (part.kind === 'text') return { kind: 'text' as const, text: text('agent.message.text', part.text) };
    images.push(Object.freeze({
      itemId,
      contentIndex,
      kind: 'image-ref' as const,
      ref: part.ref,
      mediaType: part.mediaType,
      ...(part.alt === undefined ? {} : { alt: part.alt }),
      state: 'unsupported' as const,
    }));
    const label = part.alt?.trim() || 'Image attachment';
    return { kind: 'text' as const, text: text('agent.image.unsupported', `${label} is not supported yet.`) };
  }) as [{ kind: 'text'; text: ReturnType<typeof text>; }, ...{ kind: 'text'; text: ReturnType<typeof text>; }[]];
  const participant = memberParticipant(room, runId);
  if (
    event.message.purpose === 'member-self-introduction'
    && (participant.role !== 'agent' || participant.agentIdentity === undefined)
  ) {
    throw new Error('Member self-introduction requires an exact Agent identity.');
  }
  const common = {
    kind: 'message',
    itemId,
    messageId: itemId,
    sequence: nextRoomTimelineSequence(room),
    source: 'agent-loop',
    body,
    reactions: [],
    timestamp: event.occurredAt,
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'polite',
    actions: [],
  } as const;
  if (event.message.purpose !== 'member-self-introduction') {
    const acceptedTurn = room.deliveries.some(candidate =>
      candidate.runId === runId
      && candidate.stage === 'send'
      && candidate.state === 'accepted'
      && candidate.acceptance?.kind === 'send'
      && candidate.acceptance.turn === event.turn
    );
    if (!acceptedTurn) return advance(room, runId, event.sequence);
    return appendItem(
      room,
      runId,
      event.sequence,
      {
        ...common,
        author: participant,
        semantic: {
          purpose: 'conversation',
          ...(event.causation === undefined ? {} : { causation: event.causation }),
        },
      },
      'running',
      images,
    );
  }
  const introductionEvent = event as typeof event & {
    readonly turn: string;
    readonly causation: { readonly operationId: string; };
  };
  const agentParticipant = participant as Extract<AgentConversationParticipant, { role: 'agent'; }> & {
    readonly agentIdentity: NonNullable<Extract<AgentConversationParticipant, { role: 'agent'; }>['agentIdentity']>;
  };
  const introductionProjection = {
    operationId: introductionEvent.causation.operationId,
    binding: event.binding,
    participantId: participant.participantId,
    memberId: room.runs.find(candidate => candidate.runId === runId)!.memberId,
    turn: introductionEvent.turn,
    messageId: event.message.messageId,
  };
  // A rebound logical task can replay an introduction created by an older
  // owner document. It is valid task history, but it does not belong to this
  // Room's durable request. Consume it without projecting a foreign message
  // so later conversation terminal events cannot be blocked behind it.
  if (!memberSelfIntroductionMatchesProjection(room, runId, introductionProjection)) {
    return advance(room, runId, event.sequence);
  }
  const projected = appendItem(
    room,
    runId,
    event.sequence,
    {
      ...common,
      author: agentParticipant,
      semantic: {
        purpose: 'member-self-introduction',
        causation: introductionEvent.causation,
        participantId: agentParticipant.participantId,
        memberId: room.runs.find(candidate => candidate.runId === runId)!.memberId,
        runId,
        binding: event.binding,
        turn: introductionEvent.turn,
      },
    },
    'running',
    images,
  );
  return projectMemberSelfIntroduction(projected, runId, introductionProjection);
}

const approvalItemId = (runId: string, event: Extract<AgentLoopEvent, { type: 'approval'; }>) =>
  createChatroomOpaqueId(
    'agent-approval',
    runId,
    canonicalRoomPayloadHash({
      turn: event.turn,
      approvalId: event.approval.approvalId,
      approvalKind: event.approval.kind,
    }),
  );

function projectApproval(room: Room, runId: string, event: Extract<AgentLoopEvent, { type: 'approval'; }>): Room {
  const run = room.runs.find(candidate => candidate.runId === runId)!;
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  const itemId = approvalItemId(runId, event);
  const current = room.items.find(candidate => candidate.itemId === itemId);
  const stableBinding = current?.kind === 'approval' ? current.binding : event.binding;
  const base = {
    kind: 'approval' as const,
    itemId,
    sequence: current?.sequence ?? nextRoomTimelineSequence(room),
    participantId: member.participantId,
    memberId: member.memberId,
    runId,
    binding: stableBinding,
    turn: event.turn,
    approvalId: event.approval.approvalId,
    approvalKind: event.approval.kind,
  };
  const next: Extract<AgentConversationItem, { kind: 'approval'; }> = event.approval.state === 'pending'
    ? {
      ...base,
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE } },
        { decision: 'deny', command: { id: CHATROOM_COMMAND_APPROVAL_DENY } },
        { decision: 'cancel', command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL } },
      ],
    }
    : event.approval.outcome === 'expired'
    ? {
      ...base,
      state: 'failed',
      actions: [],
      diagnostic: text('agent.approval.expired', 'Approval expired'),
    }
    : { ...base, state: event.approval.outcome, actions: [] };
  const correlation = roomRunPublicProjectionForItem(next);
  const recorded = run.publicProjections?.find(candidate => candidate.itemId === itemId);
  if (
    recorded !== undefined && (recorded.kind !== 'approval'
      || recorded.association !== correlation.association
      || (current !== undefined && !roomRunPublicProjectionMatchesItem(recorded, current)))
  ) {
    throw new Error('AgentLoop public projection identity collided with an incompatible Room item.');
  }
  if (current !== undefined && current.kind !== 'approval') {
    throw new Error('AgentLoop public projection identity collided with an incompatible Room item.');
  }
  if (current?.kind === 'approval') {
    if (
      current.participantId !== next.participantId || current.memberId !== next.memberId
      || current.runId !== next.runId || current.turn !== next.turn
      || current.approvalId !== next.approvalId || current.approvalKind !== next.approvalKind
    ) {
      throw new Error('AgentLoop approval update changed its exact association.');
    }
    if (current.state !== 'pending' && next.state === 'pending') {
      return replaceRoomRunProjection(room, runId, { eventCursor: event.sequence, status: 'running' });
    }
    if (current.state !== 'pending' && current.state !== next.state) {
      throw new Error('AgentLoop approval resolved to conflicting terminal outcomes.');
    }
  }
  let projected = replaceRoomRunProjection(room, runId, {
    items: current === undefined
      ? [...room.items, next]
      : room.items.map(item => item.itemId === itemId ? next : item),
    eventCursor: event.sequence,
    status: event.approval.state === 'pending' ? 'waiting' : 'running',
    ...(recorded === undefined ? { publicProjection: correlation } : {}),
  });
  if (event.approval.state === 'resolved' && event.approval.outcome !== 'expired') {
    const operationId = (event as typeof event & { causation: { operationId: string; }; }).causation.operationId;
    const decision = projected.approvalDecisions.find(candidate => candidate.operationId === operationId);
    if (
      decision === undefined || decision.runId !== runId || decision.turn !== event.turn
      || decision.approvalId !== event.approval.approvalId
      || decision.decision !== event.approval.outcome
    ) {
      throw new Error('Approval result event did not match its durable decision causation.');
    }
    projected = updateApprovalDecision(projected, operationId, candidate => ({
      ...candidate,
      state: 'completed',
      attention: undefined,
    }));
  }
  return projected;
}

function statusProjection(
  room: Room,
  runId: string,
  eventSequence: number,
  itemId: string,
  key: string,
  fallback: string,
  state: 'info' | 'working' | 'warning' | 'error',
  runStatus: RoomRunStatus,
): Room {
  return appendItem(room, runId, eventSequence, {
    kind: 'status',
    itemId,
    sequence: nextRoomTimelineSequence(room),
    label: text(key, fallback),
    state,
    ariaLive: state === 'working' ? 'off' : 'polite',
  }, runStatus);
}

/** Projects one run's public events and fences every event by run binding generation and cursor. */
export function projectAgentLoopEvent(room: Room, runId: string, event: AgentLoopEvent): AgentLoopProjectionResult {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (
    run === undefined || !roomRunOwnsAgentLoopBinding(room, runId, event.binding)
    || event.sequence <= (run.agentLoopCursor ?? -1)
  ) {
    return { accepted: false, room };
  }
  if (event.type === 'message') return { accepted: true, room: messageProjection(room, runId, event) };
  if (event.type === 'approval') {
    return { accepted: true, room: projectApproval(room, runId, event) };
  }
  switch (event.lifecycle.phase) {
    case 'turn.started':
      return { accepted: true, room: advance(room, runId, event.sequence, 'running') };
    case 'turn.completed':
      return {
        accepted: true,
        room: advance(updateCausationAcknowledgement(room, runId, event, 'completed'), runId, event.sequence, 'active'),
      };
    case 'turn.cancelled': {
      const cancelledEvent = event as typeof event & { causation: { operationId: string; }; };
      const operationId = cancelledEvent.causation.operationId;
      const current = room.runs.find(candidate => candidate.runId === runId)!;
      const introduction = current.selfIntroduction;
      if (
        introduction === undefined || (introduction.operationId !== operationId
          && introduction.cancellation?.operationId !== operationId)
      ) {
        throw new Error('Cancelled turn did not match its durable member self-introduction causation.');
      }
      const cancelled = replaceRoomRun(room, runId, {
        ...current,
        status: 'active',
        selfIntroduction: { ...introduction, state: 'cancelled' },
      });
      return { accepted: true, room: advance(cancelled, runId, event.sequence, 'active') };
    }
    case 'turn.failed': {
      const updated = updateCausationAcknowledgement(
        room,
        runId,
        event,
        'failed',
        event.lifecycle.failure.code,
      );
      const introduction = updated.runs.find(candidate => candidate.runId === runId)!.selfIntroduction;
      const withIntroduction = introduction?.operationId === event.causation?.operationId
        ? requireMemberSelfIntroductionAttention(
          updated,
          runId,
          'introduction-unavailable',
          event.lifecycle.failure.code,
        )
        : updated;
      return {
        accepted: true,
        room: statusProjection(
          withIntroduction,
          runId,
          event.sequence,
          publicEventItemId('agent-status', runId, event, {
            lifecyclePhase: event.lifecycle.phase,
            failureCode: event.lifecycle.failure.code,
            retryable: event.lifecycle.failure.retryable,
          }),
          'agent.lifecycle.failed',
          'Agent run failed',
          'error',
          'failed',
        ),
      };
    }
    case 'binding.closed': {
      const closed = closeRoomRun(room, runId, event.binding);
      return { accepted: true, room: advance(closed, runId, event.sequence, 'stopped') };
    }
    case 'binding.created':
    case 'binding.bound':
      return { accepted: true, room: advance(room, runId, event.sequence, 'active') };
  }
}

function updateCausationAcknowledgement(
  room: Room,
  runId: string,
  event: Extract<AgentLoopEvent, { type: 'lifecycle'; }>,
  state: 'completed' | 'failed',
  failureCode = 'agent-loop-failed',
): Room {
  const operationId = event.causation?.operationId;
  const delivery = operationId === undefined
    ? room.deliveries.find(candidate =>
      candidate.stage === 'send'
      && candidate.runId === runId
      && candidate.state === 'accepted'
      && candidate.acceptance?.kind === 'send'
      && candidate.acceptance.turn === event.turn
    )
    : room.deliveries.find(candidate =>
      candidate.operationId === operationId
      && candidate.stage === 'send' && candidate.runId === runId
    );
  if (delivery?.operation.kind !== 'send') return room;
  const sendOperation = delivery.operation;
  const acknowledgement = room.acknowledgements.find(candidate =>
    candidate.acknowledgementKey === sendOperation.acknowledgementKey
  );
  // Acknowledgement is first-terminal-wins. Replayed or contradictory late
  // lifecycle events may advance the cursor, but cannot replace its outcome.
  if (acknowledgement?.state !== 'pending') return room;
  const acknowledged = state === 'completed'
    ? completeRoomAcknowledgement(room, sendOperation.acknowledgementKey)
    : failRoomAcknowledgement(room, sendOperation.acknowledgementKey, failureCode);
  return createRoom({
    ...acknowledged,
    items: acknowledged.items.map(item =>
      item.kind === 'message' && item.itemId === delivery.userItemId
        ? { ...item, runState: state === 'completed' ? 'idle' as const : 'failed' as const }
        : item
    ),
  });
}
