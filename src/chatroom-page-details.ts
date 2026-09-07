import type { EntityRegistry } from '@cordisx/protocol/entities/v1';
import type {
  AgentDetailNavigationService,
  AgentSessionDetailReferenceService,
} from '@cordisx/protocol/agent-detail-navigation/v1';
import type { AgentConversationActiveRunDescriptor } from '@cordisx/protocol/agent-conversation-shell/v7';
import type { SessionId } from '@cordisx/protocol/sessions/v1';

import type { Room } from './room.js';
import type { DurableChatroomRoomStore } from './room-store.js';
import { executeRoomProfileCommand } from './room-profile.js';

export interface ChatroomPageDetailServices {
  readonly entities: Pick<EntityRegistry, 'get'>;
  readonly references: AgentSessionDetailReferenceService;
  readonly navigation: AgentDetailNavigationService;
  readonly rooms: DurableChatroomRoomStore;
}

export interface ChatroomMemberSession {
  /** Rendering key only. Never displayed as product copy. */
  readonly sessionId: SessionId;
  readonly title: string;
  readonly phase?: AgentConversationActiveRunDescriptor['lifecycle']['phase'];
}

/** One list from the existing Room relationships, enriched only by matching live facts. */
export function memberSessions(
  room: Room,
  participantId: string,
  activeRuns: readonly AgentConversationActiveRunDescriptor[],
): readonly ChatroomMemberSession[] {
  const member = room.memberships.find(candidate => candidate.participantId === participantId);
  if (member === undefined) return [];
  const sessions = new Map<SessionId, ChatroomMemberSession>();
  for (const run of room.runs) {
    if (run.memberId !== member.memberId || run.sessionId === undefined) continue;
    const active = activeRuns.find(candidate =>
      candidate.sessionId === run.sessionId && candidate.runId === run.runId
      && candidate.memberId === member.memberId && candidate.participantId === participantId
    );
    const previous = sessions.get(run.sessionId);
    sessions.set(run.sessionId, {
      sessionId: run.sessionId,
      title: run.title,
      ...(active === undefined
        ? previous?.phase === undefined ? {} : { phase: previous.phase }
        : { phase: active.lifecycle.phase }),
    });
  }
  return [...sessions.values()];
}

/** Presentation actions use existing owner services; this class stores no Session facts. */
export class ChatroomPageDetails {
  constructor(private readonly services: ChatroomPageDetailServices) {}

  async entity(room: Room, participantId: string) {
    const member = room.memberships.find(candidate => candidate.participantId === participantId);
    if (member === undefined) return undefined;
    const result = await this.services.entities.get(member.definition);
    if (result.status !== 'found') return undefined;
    // Keep the exact frozen revision even if a provider violates its response contract.
    if (
      result.entity.identity.agentId !== member.definition.agentId
      || result.entity.identity.revision !== member.definition.revision
    ) return undefined;
    return result.entity;
  }

  async openSession(room: Room, participantId: string, sessionId: SessionId): Promise<boolean> {
    if (!memberSessions(room, participantId, []).some(session => session.sessionId === sessionId)) return false;
    const reference = await this.services.references.get({ sessionId });
    if (reference.status !== 'accepted' || reference.sessionId !== sessionId) return false;
    return (await this.services.navigation.open({ target: reference.target })).status === 'accepted';
  }

  profile(roomId: string) {
    return this.services.rooms.document(roomId);
  }

  async saveProfile(roomId: string, expectedRevision: number, name: string, description: string): Promise<void> {
    await executeRoomProfileCommand(this.services.rooms, {
      type: 'replace-room-profile',
      roomId,
      expectedRevision,
      name,
      description,
    });
  }
}
