import type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4';

import { acknowledgeBehaviorForMember, type ChatroomAgentConfiguration } from './agent-definition.js';
import {
  createChatroomOpaqueId,
  createRoom,
  nextRoomTimelineSequence,
  replaceRoomRun,
  type Room,
  type RoomAcknowledgement,
  type RoomAcknowledgementPresentation,
  type RoomRun,
  type StoredRoomRunDetailsUrl,
} from './room.js';

const sameIdentity = (
  left: AgentLoopTaskBinding['definition'],
  right: AgentLoopTaskBinding['definition'],
) => left.agentId === right.agentId && left.revision === right.revision;

const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && left.state === right.state
  && sameIdentity(left.definition, right.definition);

const sameDetailsUrl = (left: StoredRoomRunDetailsUrl, right: StoredRoomRunDetailsUrl) =>
  left.url === right.url && left.target === right.target;

/** Chatroom's private persistence seam until the matching Protocol type lands. */
export function createStoredRoomRunDetailsUrl(input: {
  readonly url: string;
  readonly target: 'host' | 'external';
}): StoredRoomRunDetailsUrl {
  if (typeof input.url !== 'string' || input.url.trim() === '') {
    throw new Error('Accepted member presence requires a non-empty details URL.');
  }
  if (input.target !== 'host' && input.target !== 'external') {
    throw new Error('Accepted member presence requires a valid details URL target.');
  }
  if (input.target === 'host' && !input.url.startsWith('app:')) {
    throw new Error('Host task details URL must use the app scheme.');
  }
  if (input.target === 'external' && !/^(?:https|codex|claude):/.test(input.url)) {
    throw new Error('External task details URL uses an unsupported scheme.');
  }
  return Object.freeze({ url: input.url, target: input.target }) as StoredRoomRunDetailsUrl;
}

function requireRun(room: Room, runId: string): RoomRun {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  return run;
}

/**
 * Starts the single in-place member-presence lifecycle for a run. Existing
 * ready sessions are left alone unless the caller explicitly begins a rebind.
 */
export function beginRoomRunPresence(
  room: Room,
  runId: string,
  options: {
    readonly replacement?: boolean;
    readonly state?: 'inviting' | 'creating';
  } = {},
): Room {
  const run = requireRun(room, runId);
  const state = options.state ?? 'creating';
  if (
    (run.presence.state === 'joined' || run.presence.state === 'ready')
    && options.replacement !== true
  ) return room;
  if (run.presence.state === state && options.replacement !== true) return room;
  const attempt = (run.presence.state === 'inviting' || run.presence.state === 'creating')
    ? run.presence.attempt
    : run.presence.attempt + 1;
  return replaceRoomRun(room, runId, {
    ...run,
    status: 'creating',
    presence: {
      eventKey: run.presence.eventKey,
      participantId: run.presence.participantId,
      memberId: run.presence.memberId,
      runId: run.presence.runId,
      sequence: run.presence.sequence,
      state,
      attempt,
    },
  });
}

/**
 * Atomically persists binding + URL before presence becomes ready. It also
 * handles an accepted generation replacement without changing the event key.
 */
export function acceptRoomRunPresence(
  room: Room,
  runId: string,
  binding: AgentLoopTaskBinding,
  detailsUrlInput: StoredRoomRunDetailsUrl,
  options: { readonly acceptedState?: 'joined' | 'ready'; } = {},
): Room {
  const run = requireRun(room, runId);
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
  const acceptedState = options.acceptedState ?? 'ready';
  if (binding.state !== 'active') throw new Error('Ready member presence requires an active TaskBinding.');
  if (!sameIdentity(member.definition, binding.definition)) {
    throw new Error('TaskBinding Agent identity does not match the Room member.');
  }
  const detailsUrl = createStoredRoomRunDetailsUrl(detailsUrlInput);
  const alreadyJoined = run.taskBinding !== undefined && run.detailsUrl !== undefined;
  if (
    run.presence.state === acceptedState && alreadyJoined
    && sameBinding(run.taskBinding!, binding) && sameDetailsUrl(run.detailsUrl!, detailsUrl)
  ) return room;
  const memberships = room.memberships.map(candidate =>
    candidate.memberId === member.memberId
      ? { ...candidate, preferredRunId: runId }
      : candidate
  );
  const replacement: RoomRun = {
    ...run,
    status: 'active',
    taskBinding: binding,
    detailsUrl,
    agentLoopCursor: run.taskBinding !== undefined
        && (run.taskBinding.binding.bindingId !== binding.binding.bindingId
          || run.taskBinding.binding.generation !== binding.binding.generation)
      ? -1
      : run.agentLoopCursor,
    presence: {
      ...run.presence,
      state: acceptedState,
      attempt: run.presence.attempt,
    },
    ...(run.selfIntroduction !== undefined
        && (run.selfIntroduction.state === 'planned' || run.selfIntroduction.state === 'sending-unknown')
        && !sameBinding(run.selfIntroduction.binding, binding)
      ? {
        selfIntroduction: {
          ...run.selfIntroduction,
          state: 'attention' as const,
          attention: {
            code: 'binding-conflict' as const,
            diagnostic: 'The introduction request belongs to a retired binding generation.',
          },
        },
      }
      : {}),
  };
  return createRoom({ ...replaceRoomRun(room, runId, replacement), memberships });
}

export function failRoomRunPresence(
  room: Room,
  runId: string,
  input: {
    readonly code: string;
    readonly retryable: boolean;
    readonly diagnostic?: string;
    readonly retryCommand?: { readonly commandId: string; };
  },
): Room {
  if (input.code.trim() === '') throw new Error('Member presence failure code must be non-empty.');
  const run = requireRun(room, runId);
  const memberships = room.memberships.map(member => {
    if (member.preferredRunId !== runId) return member;
    return {
      memberId: member.memberId,
      participantId: member.participantId,
      label: member.label,
      definition: member.definition,
      avatar: member.avatar,
      role: member.role,
      attentionPolicy: member.attentionPolicy,
      ...(member.reportsToMemberId === undefined
        ? {}
        : { reportsToMemberId: member.reportsToMemberId }),
    };
  });
  if (
    run.presence.state === 'failed'
    && run.presence.failure?.code === input.code
    && run.presence.failure.retryable === input.retryable
    && run.presence.failure.diagnostic === input.diagnostic
    && run.presence.failure.retryCommand?.commandId === input.retryCommand?.commandId
    && memberships.every((member, index) => member === room.memberships[index])
  ) return room;
  const failed = replaceRoomRun(room, runId, {
    ...run,
    status: 'failed',
    presence: {
      ...run.presence,
      state: 'failed',
      attempt: run.presence.attempt,
      failure: {
        code: input.code,
        retryable: input.retryable,
        ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
        ...(input.retryCommand === undefined ? {} : {
          retryCommand: { commandId: input.retryCommand.commandId },
        }),
      },
    },
  });
  return createRoom({ ...failed, memberships });
}

const acknowledgementKey = (
  userItemId: string,
  participantId: string,
  memberId: string,
  runId: string,
) =>
  `ack:${userItemId.length}:${userItemId}:${participantId.length}:${participantId}:${memberId.length}:${memberId}:${runId.length}:${runId}`;

function presentationFor(
  behavior: ReturnType<typeof acknowledgeBehaviorForMember>,
  memberId: string,
  participantId: string,
  memberLabel: string,
  stableKey: string,
): RoomAcknowledgementPresentation {
  if (behavior.mode === 'reaction') {
    return {
      kind: 'reaction',
      source: 'chatroom-acknowledgement',
      reactionId: createChatroomOpaqueId('reaction', stableKey),
      actorParticipantId: participantId,
      value: { kind: 'emoji', emoji: behavior.pendingReaction },
      state: 'pending',
    };
  }
  if (behavior.mode === 'message') {
    return {
      kind: 'canned-message',
      source: 'chatroom-acknowledgement',
      authorParticipantId: participantId,
      authorMemberId: memberId,
      text: behavior.messageTemplate.replaceAll('{member}', memberLabel),
    };
  }
  return { kind: 'none', source: 'chatroom-acknowledgement' };
}

export interface PrepareRoomAcknowledgementResult {
  readonly room: Room;
  readonly acknowledgement: RoomAcknowledgement;
  /** False means this exact delivery was already persisted before reload/retry. */
  readonly created: boolean;
}

/** Persist deterministic acknowledgement state before claiming AgentLoop send. */
export function prepareRoomAcknowledgement(
  room: Room,
  configuration: ChatroomAgentConfiguration,
  input: { readonly userItemId: string; readonly memberId: string; readonly runId: string; },
): PrepareRoomAcknowledgementResult {
  const run = requireRun(room, input.runId);
  if (run.memberId !== input.memberId) throw new Error('Acknowledgement must target its exact member run.');
  const member = room.memberships.find(candidate => candidate.memberId === input.memberId);
  if (member === undefined) throw new Error('Acknowledgement member is unavailable.');
  const key = acknowledgementKey(input.userItemId, member.participantId, input.memberId, input.runId);
  const existing = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (existing !== undefined) return { room, acknowledgement: existing, created: false };
  const behavior = acknowledgeBehaviorForMember(configuration, input.memberId);
  const presentation = presentationFor(behavior, member.memberId, member.participantId, member.label, key);
  const userItem = room.items.find(item => item.itemId === input.userItemId);
  const sequence = presentation.kind === 'canned-message'
    ? nextRoomTimelineSequence(room)
    : userItem?.sequence ?? room.timelineSequence;
  const acknowledgement: RoomAcknowledgement = {
    acknowledgementKey: key,
    userItemId: input.userItemId,
    participantId: member.participantId,
    memberId: input.memberId,
    runId: input.runId,
    sequence,
    timestamp: userItem?.kind === 'message' ? userItem.timestamp : new Date(0).toISOString(),
    behavior,
    state: 'pending',
    dispatchState: 'pending',
    presentation,
  };
  const next = createRoom({
    ...room,
    acknowledgements: [...room.acknowledgements, acknowledgement],
    timelineSequence: Math.max(room.timelineSequence, sequence),
  });
  return {
    room: next,
    acknowledgement: next.acknowledgements.find(candidate => candidate.acknowledgementKey === key)!,
    created: true,
  };
}

function replaceAcknowledgement(
  room: Room,
  key: string,
  update: (current: RoomAcknowledgement) => RoomAcknowledgement,
): Room {
  const index = room.acknowledgements.findIndex(candidate => candidate.acknowledgementKey === key);
  if (index < 0) throw new Error('Room acknowledgement is unavailable.');
  const acknowledgements = [...room.acknowledgements];
  const replacement = update(acknowledgements[index]);
  acknowledgements[index] = replacement;
  const outbox = room.outbox.map(item =>
    item.acknowledgementKey === key
      ? { ...item, acknowledge: { state: replacement.state } }
      : item
  );
  return createRoom({ ...room, acknowledgements, outbox });
}

export function claimRoomAcknowledgementDispatch(
  room: Room,
  key: string,
): { readonly room: Room; readonly claimed: boolean; } {
  const current = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (current === undefined) throw new Error('Room acknowledgement is unavailable.');
  if (current.dispatchState !== 'pending') return { room, claimed: false };
  return {
    room: replaceAcknowledgement(room, key, item => ({ ...item, dispatchState: 'sending' })),
    claimed: true,
  };
}

export function markRoomAcknowledgementSent(room: Room, key: string): Room {
  const current = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (current?.dispatchState === 'accepted') return room;
  return replaceAcknowledgement(room, key, item => ({ ...item, dispatchState: 'accepted' }));
}

export function completeRoomAcknowledgement(room: Room, key: string): Room {
  const current = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (current?.state === 'completed') return room;
  return replaceAcknowledgement(room, key, item => ({
    ...item,
    state: 'completed',
    ...(item.presentation.kind === 'reaction'
      ? {
        presentation: {
          ...item.presentation,
          value: { kind: 'emoji' as const, emoji: item.behavior.completedReaction },
          state: 'completed' as const,
        },
      }
      : {}),
    failureCode: undefined,
  }));
}

export function failRoomAcknowledgement(room: Room, key: string, code: string): Room {
  if (code.trim() === '') throw new Error('Acknowledgement failure code must be non-empty.');
  const current = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (current?.state === 'failed' && current.failureCode === code) return room;
  return replaceAcknowledgement(room, key, item => ({
    ...item,
    state: 'failed',
    ...(item.presentation.kind === 'reaction'
      ? {
        presentation: {
          ...item.presentation,
          value: { kind: 'emoji' as const, emoji: item.behavior.failedReaction },
          state: 'failed' as const,
        },
      }
      : {}),
    failureCode: code,
  }));
}

/** Failure to persist/deliver the deterministic Chatroom acknowledgement effect. */
export function failRoomAcknowledgementDispatch(room: Room, key: string, code: string): Room {
  if (code.trim() === '') throw new Error('Acknowledgement dispatch failure code must be non-empty.');
  const current = room.acknowledgements.find(candidate => candidate.acknowledgementKey === key);
  if (current?.dispatchState === 'failed' && current.failureCode === code) return room;
  return replaceAcknowledgement(room, key, item => ({
    ...item,
    state: 'failed',
    dispatchState: 'failed',
    ...(item.presentation.kind === 'reaction'
      ? {
        presentation: {
          ...item.presentation,
          value: { kind: 'emoji' as const, emoji: item.behavior.failedReaction },
          state: 'failed' as const,
        },
      }
      : {}),
    failureCode: code,
  }));
}
