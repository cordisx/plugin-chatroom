import type { CordisXCommandContext } from 'cordisx/contracts';

import { createRoom } from './room.js';
import type { DurableChatroomRoomStore } from './room-store.js';

export const CHATROOM_COMMAND_ROOM_PIN = 'room.pin';
export const CHATROOM_COMMAND_ROOM_ARCHIVE = 'room.archive';
export const CHATROOM_COMMAND_ROOM_RESTORE = 'room.restore';
export const CHATROOM_COMMAND_ROOM_DELETE = 'room.delete';
export const CHATROOM_COMMAND_ROOM_RENAME = 'room.rename';
export const CHATROOM_ROOM_TITLE_MAX_CODE_POINTS = 120;

export type ChatroomRoomManagementErrorCode =
  | 'invalid-arguments'
  | 'invalid-title'
  | 'room-unavailable';

export class ChatroomRoomManagementError extends Error {
  constructor(readonly code: ChatroomRoomManagementErrorCode, message: string) {
    super(message);
    this.name = 'ChatroomRoomManagementError';
  }
}

export type ChatroomRoomManagementCommand =
  | typeof CHATROOM_COMMAND_ROOM_PIN
  | typeof CHATROOM_COMMAND_ROOM_ARCHIVE
  | typeof CHATROOM_COMMAND_ROOM_RESTORE
  | typeof CHATROOM_COMMAND_ROOM_DELETE
  | typeof CHATROOM_COMMAND_ROOM_RENAME;

function argumentsFrom(context: CordisXCommandContext): Readonly<Record<string, unknown>> {
  const input = context.arguments;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatroomRoomManagementError('invalid-arguments', 'Room management requires structured arguments.');
  }
  return input as Readonly<Record<string, unknown>>;
}

function roomIdFrom(context: CordisXCommandContext): string {
  const record = argumentsFrom(context);
  if (Object.keys(record).length !== 1 || typeof record.roomId !== 'string' || record.roomId.length === 0) {
    throw new ChatroomRoomManagementError('invalid-arguments', 'Room management requires one structured roomId.');
  }
  return record.roomId;
}

function renameArgumentsFrom(context: CordisXCommandContext): Readonly<{ roomId: string; title: string; }> {
  const record = argumentsFrom(context);
  if (
    Object.keys(record).length !== 2
    || typeof record.roomId !== 'string'
    || record.roomId.length === 0
    || typeof record.title !== 'string'
  ) {
    throw new ChatroomRoomManagementError(
      'invalid-arguments',
      'Room rename requires exact structured roomId and title arguments.',
    );
  }
  const title = record.title.trim();
  if (
    title.length === 0
    || Array.from(title).length > CHATROOM_ROOM_TITLE_MAX_CODE_POINTS
    || /[\u0000-\u001F\u007F]/u.test(title)
  ) {
    throw new ChatroomRoomManagementError(
      'invalid-title',
      `Room title must contain 1-${CHATROOM_ROOM_TITLE_MAX_CODE_POINTS} code points without control characters.`,
    );
  }
  return { roomId: record.roomId, title };
}

async function updateRoom(
  store: DurableChatroomRoomStore,
  roomId: string,
  patch: Readonly<{ title?: string; pinned?: boolean; archived?: boolean; }>,
): Promise<void> {
  const room = store.rooms.get(roomId);
  if (room === undefined) throw new ChatroomRoomManagementError('room-unavailable', 'Room is unavailable.');
  await store.upsert(createRoom({ ...room, ...patch }));
}

export function createRoomManagementHandler(
  store: DurableChatroomRoomStore,
  command: ChatroomRoomManagementCommand,
) {
  return async (context: CordisXCommandContext): Promise<void> => {
    switch (command) {
      case CHATROOM_COMMAND_ROOM_PIN: {
        const roomId = roomIdFrom(context);
        const room = store.rooms.get(roomId);
        if (room === undefined) throw new ChatroomRoomManagementError('room-unavailable', 'Room is unavailable.');
        await updateRoom(store, roomId, { pinned: !room.pinned });
        return;
      }
      case CHATROOM_COMMAND_ROOM_ARCHIVE:
        await updateRoom(store, roomIdFrom(context), { archived: true, pinned: false });
        return;
      case CHATROOM_COMMAND_ROOM_RESTORE:
        await updateRoom(store, roomIdFrom(context), { archived: false });
        return;
      case CHATROOM_COMMAND_ROOM_DELETE: {
        const roomId = roomIdFrom(context);
        if (!await store.remove(roomId)) {
          throw new ChatroomRoomManagementError('room-unavailable', 'Room is unavailable.');
        }
        return;
      }
      case CHATROOM_COMMAND_ROOM_RENAME: {
        const rename = renameArgumentsFrom(context);
        const room = store.rooms.get(rename.roomId);
        if (room === undefined) throw new ChatroomRoomManagementError('room-unavailable', 'Room is unavailable.');
        if (room.title === rename.title) return;
        await updateRoom(store, rename.roomId, { title: rename.title });
        return;
      }
      default:
        throw new Error(`Unknown Room management command ${command}.`);
    }
  };
}
