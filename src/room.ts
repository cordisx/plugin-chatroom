import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1';
import type { MessageId, SessionId } from '@cordisx/protocol/sessions/v1';
import {
  cloneAgentAvatarRef,
  createGeneratedAgentAvatarRef,
  type AgentAvatarRef,
} from '@cordisx/protocol/agent-avatar/v1';

import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  agentAvatarForDefinition,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';

export const CHATROOM_SHELL_OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

const encodeOpaqueIdPart = (value: string): string => Array.from(value, character =>
  /^[A-Za-z0-9_-]$/.test(character)
    ? character
    : `~${character.codePointAt(0)!.toString(16)}~`).join('');

/** Stable domain identity encoder. It never creates an Agent or Session identity. */
export function createChatroomOpaqueId(namespace: string, ...parts: readonly string[]): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(namespace)) throw new Error('Opaque ID namespace is invalid.');
  const result = [namespace, ...parts.map(part =>
    `${Array.from(part).length}.${encodeOpaqueIdPart(part)}`)].join('.');
  if (result.length > 512) throw new Error('Opaque ID exceeds the formal Shell limit.');
  return result;
}

function requireDomainId(value: string, field: string): void {
  if (value.length < 1 || value.length > 512 || !CHATROOM_SHELL_OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a Chatroom domain ID.`);
  }
}

export type RoomRunStatus =
  | 'creating' | 'active' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface RoomRunPresence {
  readonly eventKey: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly state: 'inviting' | 'creating' | 'joined' | 'ready' | 'failed';
  readonly attempt: number;
  readonly failure?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly diagnostic?: string;
  };
}

/** Chatroom correlation only; acceptance and output remain Session facts. */
export interface RoomMemberSelfIntroduction {
  readonly requestMessageId: MessageId;
  readonly correlationId: string;
  readonly requestedAt: string;
}

export interface RoomMembership {
  readonly memberId: string;
  readonly participantId: string;
  readonly label: string;
  readonly definition: AgentDefinitionIdentity;
  readonly avatar: AgentAvatarRef;
  readonly role: 'leader' | 'member';
  readonly attentionPolicy: 'ambient' | 'mention-only';
  readonly reportsToMemberId?: string;
  readonly preferredRunId?: string;
}

export interface RoomRun {
  /** Chatroom business identity. It is never sent as a runtime run id. */
  readonly runId: string;
  readonly memberId: string;
  readonly title: string;
  readonly status: RoomRunStatus;
  /** Sole persisted runtime identity; AgentId has the same value. */
  readonly sessionId?: SessionId;
  readonly presence: RoomRunPresence;
  readonly selfIntroduction?: RoomMemberSelfIntroduction;
}

export interface RoomParticipant {
  readonly id: string;
  readonly name: string;
  readonly kind: 'human' | 'agent' | 'system';
  readonly avatar?: AgentAvatarRef;
}

export interface Room {
  readonly id: string;
  readonly title: string;
  /** Chatroom-owned Manager/sidebar state; unrelated to Agent or Session truth. */
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly description?: string;
  readonly memberships: readonly [RoomMembership, ...RoomMembership[]];
  readonly seedLeaderIds: readonly string[];
  readonly runs: readonly RoomRun[];
  readonly timelineSequence: number;
  readonly participants: readonly RoomParticipant[];
}

type RoomMembershipInput = Omit<RoomMembership, 'avatar' | 'participantId'> & {
  readonly avatar?: AgentAvatarRef;
  readonly participantId?: string;
};

export interface CreateRoomInput {
  readonly id: string;
  readonly title: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly description?: string;
  readonly memberships?: readonly RoomMembershipInput[];
  readonly seedLeaderIds?: readonly string[];
  readonly runs?: readonly RoomRun[];
  readonly timelineSequence?: number;
  readonly participants?: readonly RoomParticipant[];
  readonly configuration?: ChatroomAgentConfiguration;
}

const presenceKey = (participantId: string, memberId: string, runId: string) =>
  createChatroomOpaqueId('member-presence', participantId, memberId, runId);

function defaultPresence(member: RoomMembership, runId: string): RoomRunPresence {
  return Object.freeze({
    eventKey: presenceKey(member.participantId, member.memberId, runId),
    participantId: member.participantId,
    memberId: member.memberId,
    runId,
    sequence: -1,
    state: 'creating',
    attempt: 1,
  });
}

function freezePresence(value: RoomRunPresence): RoomRunPresence {
  return Object.freeze({
    ...value,
    ...(value.failure === undefined ? {} : { failure: Object.freeze({ ...value.failure }) }),
  });
}

function freezeRun(run: RoomRun): RoomRun {
  return Object.freeze({
    ...run,
    presence: freezePresence(run.presence),
    ...(run.selfIntroduction === undefined
      ? {}
      : { selfIntroduction: Object.freeze({ ...run.selfIntroduction }) }),
  });
}

function membershipInputs(configuration: ChatroomAgentConfiguration): readonly RoomMembershipInput[] {
  return configuration.members.map(member => ({
    memberId: member.memberId,
    ...(member.participantId === undefined ? {} : { participantId: member.participantId }),
    label: member.label,
    definition: member.definition,
    role: member.role,
    attentionPolicy: member.attentionPolicy,
    ...(member.reportsToMemberId === undefined ? {} : { reportsToMemberId: member.reportsToMemberId }),
    avatar: agentAvatarForDefinition(member.definition, configuration.definitions),
  }));
}

export function createRoom(input: CreateRoomInput): Room {
  requireDomainId(input.id, 'Room id');
  if (input.title.trim() === '') throw new Error('Room title must not be empty.');
  const configuration = input.configuration ?? CHATROOM_DEFAULT_AGENT_CONFIGURATION;
  const rawMemberships = input.memberships ?? membershipInputs(configuration);
  if (rawMemberships.length === 0) throw new Error('Room requires at least one member.');
  const memberships = rawMemberships.map(member => {
    const participantId = member.participantId ?? member.memberId;
    requireDomainId(member.memberId, 'Room memberId');
    requireDomainId(participantId, 'Room participantId');
    return Object.freeze({
      ...member,
      participantId,
      avatar: cloneAgentAvatarRef(member.avatar ?? createGeneratedAgentAvatarRef({
        namespace: 'agent-definition', agentId: member.definition.agentId,
      })),
      definition: Object.freeze({ ...member.definition }),
    });
  }) as [RoomMembership, ...RoomMembership[]];
  if (new Set(memberships.map(member => member.memberId)).size !== memberships.length) {
    throw new Error('Room member ids must be unique.');
  }
  if (new Set(memberships.map(member => member.participantId)).size !== memberships.length) {
    throw new Error('Room participant ids must be unique.');
  }
  const memberById = new Map(memberships.map(member => [member.memberId, member]));
  const seedLeaderIds = Object.freeze([...(input.seedLeaderIds ?? configuration.seedLeaderIds)]);
  for (const seedLeaderId of seedLeaderIds) {
    if (memberById.get(seedLeaderId)?.role !== 'leader') throw new Error('Room seed leader is unavailable.');
  }
  for (const member of memberships) {
    if (member.reportsToMemberId !== undefined && !memberById.has(member.reportsToMemberId)) {
      throw new Error('Room reporting parent is unavailable.');
    }
  }
  const runs = Object.freeze([...(input.runs ?? [])].map(freezeRun));
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('Room run ids must be unique.');
  const sessionIds = runs.flatMap(run => run.sessionId === undefined ? [] : [run.sessionId]);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('A Session may belong to only one Room run.');
  for (const run of runs) {
    requireDomainId(run.runId, 'Room runId');
    const member = memberById.get(run.memberId);
    if (member === undefined) throw new Error('Room run member is unavailable.');
    if (run.presence.eventKey !== presenceKey(member.participantId, member.memberId, run.runId)
      || run.presence.participantId !== member.participantId
      || run.presence.memberId !== member.memberId
      || run.presence.runId !== run.runId) {
      throw new Error('Room run presence identity changed.');
    }
  }
  const participants = Object.freeze([...(input.participants ?? memberships.map(member => ({
    id: member.participantId,
    name: member.label,
    kind: 'agent' as const,
    avatar: member.avatar,
  })))].map(participant => Object.freeze({
    ...participant,
    ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
  })));
  return Object.freeze({
    id: input.id,
    title: input.title,
    pinned: input.pinned === true,
    archived: input.archived === true,
    ...(input.description === undefined ? {} : { description: input.description }),
    memberships: Object.freeze(memberships) as readonly [RoomMembership, ...RoomMembership[]],
    seedLeaderIds,
    runs,
    timelineSequence: input.timelineSequence ?? 0,
    participants,
  });
}

export function addRoomRun(
  room: Room,
  run: Omit<RoomRun, 'presence'> & { readonly presence?: RoomRunPresence },
): Room {
  if (room.runs.some(candidate => candidate.runId === run.runId)) throw new Error('Room run id already exists.');
  const member = room.memberships.find(candidate => candidate.memberId === run.memberId);
  if (member === undefined) throw new Error('Room run member is unavailable.');
  return createRoom({
    ...room,
    runs: [...room.runs, { ...run, presence: run.presence ?? defaultPresence(member, run.runId) }],
  });
}

export function replaceRoomRun(room: Room, runId: string, replacement: RoomRun): Room {
  const index = room.runs.findIndex(run => run.runId === runId);
  if (index < 0 || replacement.runId !== runId) throw new Error('Room run is unavailable.');
  const runs = [...room.runs];
  runs[index] = replacement;
  return createRoom({ ...room, runs });
}

export function bindRoomRunSession(room: Room, runId: string, sessionId: SessionId): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  if (run.sessionId !== undefined && run.sessionId !== sessionId) {
    throw new Error('Room run is already bound to a different Session.');
  }
  if (room.runs.some(candidate => candidate.runId !== runId && candidate.sessionId === sessionId)) {
    throw new Error('Session already belongs to another Room run.');
  }
  if (run.sessionId === sessionId && run.status === 'active' && run.presence.state === 'ready') return room;
  return replaceRoomRun(room, runId, {
    ...run,
    sessionId,
    status: 'active',
    presence: {
      ...run.presence,
      state: 'ready',
      sequence: Math.max(run.presence.sequence, room.timelineSequence),
      failure: undefined,
    },
  });
}

export function updateRoomRunPresence(
  room: Room,
  runId: string,
  update: Pick<RoomRunPresence, 'state'> & Partial<Pick<RoomRunPresence, 'attempt' | 'sequence' | 'failure'>>,
): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  return replaceRoomRun(room, runId, {
    ...run,
    presence: {
      ...run.presence,
      ...update,
      ...(update.failure === undefined ? { failure: undefined } : { failure: update.failure }),
    },
  });
}

export function recordRoomMemberSelfIntroduction(
  room: Room,
  runId: string,
  introduction: RoomMemberSelfIntroduction,
): Room {
  const run = room.runs.find(candidate => candidate.runId === runId);
  if (run === undefined) throw new Error('Room run is unavailable.');
  const prior = run.selfIntroduction;
  if (prior !== undefined && (prior.requestMessageId !== introduction.requestMessageId
    || prior.correlationId !== introduction.correlationId)) {
    throw new Error('Room self-introduction identity changed.');
  }
  return prior === undefined
    ? replaceRoomRun(room, runId, { ...run, selfIntroduction: introduction })
    : room;
}

export function roomRunForSession(room: Room, sessionId: SessionId): RoomRun | undefined {
  return room.runs.find(run => run.sessionId === sessionId);
}

export function approvalAuthorityMemberIds(room: Room, memberId: string): readonly string[] {
  const memberById = new Map(room.memberships.map(member => [member.memberId, member]));
  if (!memberById.has(memberId)) throw new Error('Room member is unavailable.');
  const result: string[] = [];
  const visited = new Set<string>([memberId]);
  let current = memberById.get(memberId)?.reportsToMemberId;
  while (current !== undefined) {
    if (visited.has(current)) throw new Error('Room reporting hierarchy contains a cycle.');
    visited.add(current);
    result.push(current);
    current = memberById.get(current)?.reportsToMemberId;
  }
  return Object.freeze(result);
}

/** Observable Room domain registry. SessionEvent history never enters this store. */
export class ChatroomRoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly listeners = new Set<() => void>();

  constructor(rooms: readonly Room[] = []) {
    this.replaceAll(rooms);
  }

  snapshot(): readonly Room[] {
    return Object.freeze([...this.rooms.values()]);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  replace(room: Room): void {
    const next = createRoom(room);
    this.rooms.set(next.id, next);
    this.emit();
  }

  remove(roomId: string): boolean {
    const removed = this.rooms.delete(roomId);
    if (removed) this.emit();
    return removed;
  }

  replaceAll(rooms: readonly Room[]): void {
    const next = rooms.map(createRoom);
    if (new Set(next.map(room => room.id)).size !== next.length) {
      throw new Error('Room registry contains duplicate Room ids.');
    }
    this.rooms.clear();
    for (const room of next) this.rooms.set(room.id, room);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
