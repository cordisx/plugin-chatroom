import type { ChatroomAgentConfiguration } from './agent-definition.js';
import { createRoom, expandRoomMemberships } from './room.js';
import type { DurableChatroomRoomStore } from './room-store.js';

/** Prepare Room business state only. No Agent, Session, acknowledgement or first input is created. */
export function createRoomTaskBootstrap(store: DurableChatroomRoomStore, configuration: ChatroomAgentConfiguration) {
  return async (input: unknown, signal?: AbortSignal) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { status: 'rejected', code: 'invalid-input' };
    }
    const value = input as Record<string, unknown>;
    if (
      !Object.keys(value).every(key => ['roomId', 'title'].includes(key))
      || typeof value.roomId !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(value.roomId)
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160
    ) {
      return { status: 'rejected', code: 'invalid-input' };
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (signal?.aborted) return { status: 'rejected', code: 'unavailable' };
      const existing = store.rooms.get(value.roomId);
      if (existing !== undefined) {
        return existing.title === value.title && !existing.archived
          ? { status: 'accepted', roomId: existing.id, disposition: 'replayed' }
          : { status: 'rejected', code: 'operation-conflict' };
      }
      const memberships = expandRoomMemberships(configuration);
      try {
        await store.upsert(createRoom({
          id: value.roomId,
          title: value.title,
          memberships,
          seedLeaderIds: configuration.seedLeaderIds,
          participants: [
            { id: 'user', name: 'You', kind: 'human' },
            ...memberships.map(member => ({
              id: member.participantId,
              name: member.label,
              kind: 'agent' as const,
              avatar: member.avatar,
            })),
          ],
          participantPresentation: { multiParticipant: true, participantPresentation: 'host-initials' },
        }));
        return { status: 'accepted', roomId: value.roomId, disposition: 'created' };
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'conflict') {
          return { status: 'rejected', code: 'unavailable' };
        }
      }
    }
    return { status: 'rejected', code: 'unavailable' };
  };
}
