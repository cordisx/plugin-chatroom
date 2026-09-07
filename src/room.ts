import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';
import type { MessageId, SessionId } from '@cordisx/protocol/sessions/v1';

import {
  CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS,
  type Room,
  type RoomAdmissionMessageLink,
  type RoomImageReference,
  type RoomRun,
  type RoomRunPresence,
  type RoomRunPublicProjection,
  type RoomRunStatus,
  type RoomSessionSelfIntroduction,
} from './room-model.js';
import { presenceEventKey, sameBinding, sameIdentity } from './room-snapshot-values.js';
import { createRoom } from './room-snapshot.js';
export type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';
export {
  AGENT_LOOP_TASK_BINDING_CONTRACT,
  AGENT_LOOP_TASK_BINDING_SCHEMA,
  CHATROOM_MAX_ADMISSION_MESSAGE_LINKS,
  CHATROOM_MAX_APPROVAL_DECISIONS,
  CHATROOM_MAX_PLAYGROUND_AGENT_APPROVALS,
  CHATROOM_MAX_PLAYGROUND_AGENT_EGRESSES,
  CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS,
  CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS,
  CHATROOM_SHELL_OPAQUE_ID_PATTERN,
  createChatroomOpaqueId,
  type OpaqueConversationHandle,
  type OpaqueRunHandle,
  type Room,
  type RoomAcknowledgement,
  type RoomAcknowledgementPresentation,
  type RoomAdmissionMessageLink,
  type RoomApprovalDecision,
  type RoomChannelLink,
  type RoomDelivery,
  type RoomDeliveryAcceptance,
  type RoomDeliveryAttentionCode,
  type RoomDeliveryOperation,
  type RoomDeliveryPayload,
  type RoomImageReference,
  type RoomMemberSelfIntroduction,
  type RoomMemberSelfIntroductionAttentionCode,
  type RoomMembership,
  type RoomOutboxCreateStage,
  type RoomOutboxDelivery,
  type RoomOutboxStageState,
  type RoomParticipant,
  type RoomParticipantPresentation,
  type RoomPlaygroundAgentApproval,
  type RoomPlaygroundAgentApprovalDecisionAttempt,
  type RoomPlaygroundAgentEgress,
  type RoomReactionValue,
  type RoomRun,
  type RoomRunPresence,
  type RoomRunPublicProjection,
  roomRunPublicProjectionForItem,
  roomRunPublicProjectionMatchesItem,
  type RoomRunStatus,
  type RoomSessionSelfIntroduction,
  type StoredRoomRunDetailsUrl,
} from './room-model.js';
export { expandRoomMemberships } from './room-snapshot-values.js';
export { createRoom } from './room-snapshot.js';
const sameAdmissionMessageLink = (
  left: RoomAdmissionMessageLink,
  right: RoomAdmissionMessageLink,
): boolean =>
  left.roomId === right.roomId
  && left.itemId === right.itemId
  && left.participantId === right.participantId
  && left.memberId === right.memberId
  && left.runId === right.runId
  && left.sessionId === right.sessionId
  && left.messageId === right.messageId
  && left.owner.pluginId === right.owner.pluginId
  && left.owner.generation === right.owner.generation
  && left.appendAfterItemId === right.appendAfterItemId;

/**
 * Records the public result of an accepted admission reservation. The
 * stored association is idempotent for the exact `{sessionId,messageId}` and
 * rejects any attempt to repurpose that immutable Host message identity.
 */
export function recordRoomAdmissionMessageLink(
  room: Room,
  link: RoomAdmissionMessageLink,
): Room {
  const existing = room.admissionMessageLinks?.find(candidate =>
    candidate.sessionId === link.sessionId && candidate.messageId === link.messageId
  );
  if (existing !== undefined) {
    if (!sameAdmissionMessageLink(existing, link)) {
      throw new Error('Room admission Session/message identity was reused with a different correlation.');
    }
    return room;
  }
  return createRoom({
    ...room,
    admissionMessageLinks: [...(room.admissionMessageLinks ?? []), link],
  });
}

/** Exact Room-owned join; callers must additionally validate Session provenance. */
export function roomAdmissionMessageLinkFor(
  room: Room,
  sessionId: SessionId,
  messageId: MessageId,
): RoomAdmissionMessageLink | undefined {
  return room.admissionMessageLinks?.find(link => link.sessionId === sessionId && link.messageId === messageId);
}

export function addRoomRun(
  room: Room,
  run: Omit<RoomRun, 'agentLoopCursor' | 'presence'> & {
    readonly agentLoopCursor?: number;
    readonly presence?: RoomRunPresence;
  },
): Room {
  if (!room.memberships.some(member => member.memberId === run.memberId)) {
    throw new Error('Room run must reference a member.');
  }
  if (room.runs.some(candidate => candidate.runId === run.runId)) throw new Error('Room run id already exists.');
  const presenceSequence = run.presence?.sequence ?? nextRoomTimelineSequence(room);
  return createRoom({
    ...room,
    timelineSequence: Math.max(room.timelineSequence, presenceSequence),
    runs: [...room.runs, {
      ...run,
      agentLoopCursor: run.agentLoopCursor ?? -1,
      presence: run.presence ?? (() => {
        const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
        return {
          eventKey: presenceEventKey(member.participantId, run.memberId, run.runId),
          participantId: member.participantId,
          memberId: run.memberId,
          runId: run.runId,
          sequence: presenceSequence,
          state: 'creating' as const,
          attempt: 1,
        };
      })(),
    }],
  });
}

export function bindRoomRun(room: Room, runId: string, binding: AgentLoopTaskBinding): Room {
  if (binding.state !== 'active') throw new Error('Room run requires an active TaskBinding.');
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  if (!sameIdentity(member.definition, binding.definition)) {
    throw new Error('TaskBinding Agent identity does not match the Room member.');
  }
  if (run.taskBinding !== undefined) {
    if (sameBinding(run.taskBinding, binding) && run.taskBinding.state === binding.state) return room;
    throw new Error('Room run is already isolated to a different TaskBinding.');
  }
  const memberships = room.memberships.map(candidate =>
    candidate.memberId === member.memberId
      ? { ...candidate, preferredRunId: runId }
      : candidate
  );
  return createRoom({
    ...replaceRoomRun(room, runId, { ...run, status: 'active', taskBinding: binding }),
    memberships,
  });
}

/**
 * Atomically moves one run to the Agent/Session authority. Legacy AgentLoop
 * identity and replay state are removed instead of being kept as a second
 * runtime truth.
 */
export function bindRoomRunSession(room: Room, runId: string, sessionId: SessionId): Room {
  if (sessionId.trim() === '') throw new Error('Room run SessionId must not be empty.');
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  if (run.sessionId !== undefined && run.sessionId !== sessionId) {
    throw new Error('Room run is already bound to a different Session.');
  }
  if (room.runs.some(candidate => candidate.runId !== runId && candidate.sessionId === sessionId)) {
    throw new Error('Session already belongs to another Room run.');
  }
  const migrated: RoomRun = {
    runId: run.runId,
    memberId: run.memberId,
    title: run.title,
    sessionId,
    ...(run.collaborationMode === undefined ? {} : { collaborationMode: run.collaborationMode }),
    status: 'active',
    ...(run.sessionSelfIntroduction === undefined ? {} : {
      sessionSelfIntroduction: run.sessionSelfIntroduction,
    }),
    presence: {
      ...run.presence,
      state: 'ready',
      sequence: Math.max(run.presence.sequence, room.timelineSequence),
      failure: undefined,
    },
  };
  return createRoom({
    ...room,
    runs: room.runs.map(candidate => candidate.runId === runId ? migrated : candidate),
    deliveries: room.deliveries.filter(delivery => delivery.runId !== runId),
    outbox: room.outbox.filter(delivery => delivery.runId !== runId),
    approvalDecisions: room.approvalDecisions.filter(decision => decision.runId !== runId),
  });
}

export function recordRoomSessionSelfIntroduction(
  room: Room,
  runId: string,
  introduction: RoomSessionSelfIntroduction,
): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run?.sessionId === undefined) throw new Error('Session-backed Room run is unavailable.');
  const prior = run.sessionSelfIntroduction;
  if (
    prior !== undefined && (prior.requestMessageId !== introduction.requestMessageId
      || prior.correlationId !== introduction.correlationId)
  ) {
    throw new Error('Room Session self-introduction identity changed.');
  }
  return prior === undefined
    ? replaceRoomRun(room, runId, { ...run, sessionSelfIntroduction: introduction })
    : room;
}

export function roomRunForSession(room: Room, sessionId: SessionId): RoomRun | undefined {
  return room.runs.find(run => run.sessionId === sessionId);
}

export function approvalAuthorityMemberIds(room: Room, memberId: string): readonly string[] {
  const members = new Map(room.memberships.map(member => [member.memberId, member]));
  if (!members.has(memberId)) throw new Error('Room member is unavailable.');
  const result: string[] = [];
  const visited = new Set<string>([memberId]);
  let current = members.get(memberId)?.reportsToMemberId;
  while (current !== undefined) {
    if (visited.has(current)) throw new Error('Room reporting hierarchy contains a cycle.');
    visited.add(current);
    result.push(current);
    current = members.get(current)?.reportsToMemberId;
  }
  return Object.freeze(result);
}

export function closeRoomRun(room: Room, runId: string, binding: AgentLoopTaskBinding['binding']): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  const current = run?.taskBinding;
  if (
    run === undefined || current === undefined
    || current.binding.bindingId !== binding.bindingId
    || current.binding.generation !== binding.generation
  ) {
    throw new Error('TaskBinding does not belong to the Room run.');
  }
  if (current.state === 'closed') return room;
  return replaceRoomRun(room, runId, {
    ...run,
    status: run.status === 'failed' ? 'failed' : 'stopped',
    taskBinding: { ...current, state: 'closed' },
  });
}

export function roomRunOwnsAgentLoopBinding(
  room: Room,
  runId: string,
  binding: Readonly<{ bindingId: string; generation: number; }>,
): boolean {
  const current = room.runs.find(run => run.runId === runId)?.taskBinding;
  return current?.state === 'active'
    && current.binding.bindingId === binding.bindingId
    && current.binding.generation === binding.generation;
}

export function replaceRoomRun(room: Room, runId: string, replacement: RoomRun): Room {
  const index = room.runs.findIndex(run => run.runId === runId);
  if (index < 0 || replacement.runId !== runId) throw new Error('Room run is unavailable.');
  const runs = [...room.runs];
  runs[index] = replacement;
  return createRoom({ ...room, runs });
}

export function replaceRoomRunProjection(
  room: Room,
  runId: string,
  input: {
    readonly items?: readonly AgentConversationItem[];
    readonly imageReferences?: readonly RoomImageReference[];
    readonly eventCursor: number;
    readonly status?: RoomRunStatus;
    readonly taskBinding?: AgentLoopTaskBinding;
    readonly publicProjection?: RoomRunPublicProjection;
  },
): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const items = input.items === undefined ? room.items : input.items.slice(-500);
  const publicProjections = run.publicProjections ?? [];
  if (
    input.publicProjection !== undefined
    && publicProjections.length >= CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS
  ) {
    throw new Error(`Room run exceeds its ${CHATROOM_MAX_RUN_PUBLIC_PROJECTIONS}-projection replay limit.`);
  }
  return createRoom({
    ...room,
    items,
    timelineSequence: Math.max(room.timelineSequence, ...items.map(item => item.sequence)),
    imageReferences: input.imageReferences ?? room.imageReferences,
    runs: room.runs.map(candidate =>
      candidate.runId === runId
        ? {
          ...run,
          agentLoopCursor: input.eventCursor,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.taskBinding === undefined ? {} : { taskBinding: input.taskBinding }),
          publicProjections: input.publicProjection === undefined
            ? publicProjections
            : [...publicProjections, input.publicProjection],
        }
        : candidate
    ),
  });
}

export function nextRoomTimelineSequence(room: Room): number {
  return room.timelineSequence + 1;
}

export class ChatroomRoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly listeners = new Set<(roomId: string) => void>();

  constructor(initialRooms: readonly Room[] = []) {
    for (const room of initialRooms) this.rooms.set(room.id, room);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }
  snapshot(): readonly Room[] {
    return [...this.rooms.values()];
  }

  upsert(room: Room): void {
    this.rooms.set(room.id, room);
    for (const listener of this.listeners) listener(room.id);
  }

  remove(roomId: string): void {
    this.rooms.delete(roomId);
    for (const listener of this.listeners) listener(roomId);
  }

  /** Atomically replaces the complete durable snapshot before notifying readers. */
  replaceAll(rooms: readonly Room[]): void {
    const previousIds = new Set(this.rooms.keys());
    this.rooms.clear();
    for (const room of rooms) this.rooms.set(room.id, room);
    const changedIds = new Set([...previousIds, ...rooms.map(room => room.id)]);
    for (const roomId of changedIds) {
      for (const listener of this.listeners) listener(roomId);
    }
  }

  subscribe(listener: (roomId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
