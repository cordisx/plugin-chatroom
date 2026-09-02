import { createRoom, type Room } from './room.js';
import {
  ChatroomRoomStoreError,
  type ChatroomRoomDocument,
  type DurableChatroomRoomStore,
} from './room-store.js';

export const CHATROOM_ROOM_NAME_MAX_LENGTH = 200 as const;
export const CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH = 2_000 as const;

export interface ReplaceRoomProfileCommand {
  readonly type: 'replace-room-profile';
  readonly roomId: string;
  /** Whole-registry owner-document revision used for the durable CAS. */
  readonly expectedRevision: number;
  readonly name: string;
  readonly description?: string;
}

const normalizeRequired = (value: string, field: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be non-empty.`);
  if (Array.from(normalized).length > maximum) throw new Error(`${field} exceeds its maximum length.`);
  return normalized;
};

const normalizeOptional = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === '') return undefined;
  if (Array.from(normalized).length > CHATROOM_ROOM_DESCRIPTION_MAX_LENGTH) {
    throw new Error('Room description exceeds its maximum length.');
  }
  return normalized;
};

/** Pure Chatroom domain update. Participant/membership/run snapshots remain untouched and ordered. */
export function replaceRoomProfile(
  room: Room,
  input: Pick<ReplaceRoomProfileCommand, 'name' | 'description'>,
): Room {
  const title = normalizeRequired(input.name, 'Room name', CHATROOM_ROOM_NAME_MAX_LENGTH);
  const description = normalizeOptional(input.description);
  if (room.title === title && room.description === description) return room;
  return createRoom({
    ...room,
    title,
    ...(description === undefined ? { description: undefined } : { description }),
  });
}

/**
 * API-name-independent command adapter for a future Host-owned Room settings
 * surface. It only performs the existing durable owner-document CAS and never
 * invents Shell v2 fields or Host routes.
 */
export async function executeRoomProfileCommand(
  store: DurableChatroomRoomStore,
  command: ReplaceRoomProfileCommand,
): Promise<ChatroomRoomDocument> {
  if (command.type !== 'replace-room-profile') throw new Error('Room profile command is unsupported.');
  const current = store.document(command.roomId);
  if (current === undefined) {
    throw new ChatroomRoomStoreError('invalid-document', 'Room profile target is unavailable.', true);
  }
  if (command.expectedRevision !== current.revision) {
    throw new ChatroomRoomStoreError('conflict', 'Room profile changed concurrently.', true);
  }
  const replacement = replaceRoomProfile(current.room, command);
  if (replacement === current.room) return current;
  const committed = await store.compareAndSwap(command.expectedRevision, replacement);
  if (committed === undefined) {
    throw new ChatroomRoomStoreError('conflict', 'Room profile changed concurrently.', true);
  }
  return committed;
}
