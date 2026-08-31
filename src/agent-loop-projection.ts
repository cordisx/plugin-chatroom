import type { AgentConversationItem, AgentConversationParticipant } from '@cordisx/protocol/agent-conversation-shell/v2';
import type { AgentLoopEvent } from '@cordisx/protocol/agent-loop/v2';

import { projectRoomParticipant, text } from './conversation-model.js';
import { canonicalRoomPayloadHash } from './room-delivery.js';
import { completeRoomAcknowledgement, failRoomAcknowledgement } from './room-engagement.js';
import {
  closeRoomRun,
  createRoom,
  nextRoomTimelineSequence,
  replaceRoomRunProjection,
  roomRunPublicProjectionForItem,
  roomRunPublicProjectionMatchesItem,
  roomRunOwnsAgentLoopBinding,
  createChatroomOpaqueId,
  type Room,
  type RoomImageReference,
  type RoomRunPublicProjection,
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
  return projectRoomParticipant(participant ?? {
    id: member.participantId,
    name: member.label,
    kind: 'agent',
    avatar: member.avatar,
  }, room);
};

const advance = (room: Room, runId: string, eventCursor: number, status?: RoomRunStatus) =>
  replaceRoomRunProjection(room, runId, { eventCursor, ...(status === undefined ? {} : { status }) });

const publicEventItemId = (
  namespace: 'agent-message' | 'agent-status',
  runId: string,
  event: AgentLoopEvent,
  semantic: Readonly<Record<string, string | number | boolean | null>>,
) => createChatroomOpaqueId(namespace, runId, canonicalRoomPayloadHash({
  type: event.type,
  turn: event.turn ?? null,
  operationId: event.causation?.operationId ?? null,
  ...semantic,
}));

const appendItem = (
  room: Room,
  runId: string,
  eventCursor: number,
  item: Extract<AgentConversationItem, { kind: 'message' | 'status' }>,
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
  const compatibleCorrelation = (candidate: RoomRunPublicProjection) => candidate.kind === correlation.kind
    && candidate.association === correlation.association;
  const run = room.runs.find(candidate => candidate.runId === runId)!;
  const recorded = run.publicProjections?.find(candidate => candidate.itemId === item.itemId);
  if (recorded !== undefined) {
    const visible = room.items.find(candidate => candidate.itemId === item.itemId);
    if (!compatibleCorrelation(recorded)
      || (visible !== undefined && !roomRunPublicProjectionMatchesItem(recorded, visible))) {
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

function messageProjection(room: Room, runId: string, event: Extract<AgentLoopEvent, { type: 'message' }>): Room {
  // The private session's echoed user message is not part of the public aggregate.
  if (event.message.role !== 'assistant') return advance(room, runId, event.sequence);
  const itemId = publicEventItemId('agent-message', runId, event, {
    messageId: event.message.messageId,
    role: event.message.role,
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
  }) as [{ kind: 'text'; text: ReturnType<typeof text> }, ...{ kind: 'text'; text: ReturnType<typeof text> }[]];
  return appendItem(room, runId, event.sequence, {
    kind: 'message',
    itemId,
    messageId: itemId,
    sequence: nextRoomTimelineSequence(room),
    source: 'agent-loop',
    author: memberParticipant(room, runId),
    body,
    reactions: [],
    timestamp: event.occurredAt,
    deliveryState: 'delivered',
    runState: 'idle',
    ariaLive: 'polite',
    actions: [],
  }, 'running', images);
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
  if (run === undefined || !roomRunOwnsAgentLoopBinding(room, runId, event.binding)
    || event.sequence <= run.agentLoopCursor) {
    return { accepted: false, room };
  }
  if (event.type === 'message') return { accepted: true, room: messageProjection(room, runId, event) };
  if (event.type === 'approval') {
    const itemId = publicEventItemId('agent-status', runId, event, {
      approvalId: event.approval.approvalId,
      approvalState: event.approval.state,
      approvalOutcome: event.approval.state === 'resolved' ? event.approval.outcome : null,
    });
    if (event.approval.state === 'pending') {
      return { accepted: true, room: statusProjection(room, runId, event.sequence, itemId, 'agent.approval.pending', 'Waiting for approval', 'warning', 'waiting') };
    }
    const approved = event.approval.outcome === 'approved';
    return {
      accepted: true,
      room: statusProjection(
        room, runId, event.sequence, itemId, 'agent.approval.resolved',
        approved ? 'Approval completed' : `Approval ${event.approval.outcome}`,
        approved ? 'info' : 'warning', 'running',
      ),
    };
  }
  switch (event.lifecycle.phase) {
    case 'turn.started':
      return { accepted: true, room: advance(room, runId, event.sequence, 'running') };
    case 'turn.completed':
      return {
        accepted: true,
        room: advance(updateCausationAcknowledgement(room, runId, event, 'completed'), runId, event.sequence, 'active'),
      };
    case 'turn.failed': {
      const updated = updateCausationAcknowledgement(
        room, runId, event, 'failed', event.lifecycle.failure.code,
      );
      return {
        accepted: true,
        room: statusProjection(
          updated,
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
  event: Extract<AgentLoopEvent, { type: 'lifecycle' }>,
  state: 'completed' | 'failed',
  failureCode = 'agent-loop-failed',
): Room {
  const operationId = event.causation?.operationId;
  if (operationId === undefined) return room;
  const delivery = room.deliveries.find(candidate => candidate.operationId === operationId
    && candidate.stage === 'send' && candidate.runId === runId);
  if (delivery?.operation.kind !== 'send') return room;
  const acknowledged = state === 'completed'
    ? completeRoomAcknowledgement(room, delivery.operation.acknowledgementKey)
    : failRoomAcknowledgement(room, delivery.operation.acknowledgementKey, failureCode);
  return createRoom({
    ...acknowledged,
    items: acknowledged.items.map(item => item.kind === 'message' && item.itemId === delivery.userItemId
      ? { ...item, runState: state === 'completed' ? 'idle' as const : 'failed' as const }
      : item),
  });
}
