import type { Room } from './room-model.js';

/** Host-authenticated scope, independently rechecked against the Room on every call. */
export interface ChatroomCliScope {
  readonly roomId: string;
  readonly participantId: string;
  readonly memberId: string;
  readonly runId: string;
  readonly sessionId: string;
}

/** A real Room message and its durable idempotency identity in the existing Room document. */
export interface RoomCliMessage extends ChatroomCliScope {
  readonly operationId: string;
  readonly messageId: string;
  readonly text: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export const MAX_ROOM_CLI_MESSAGES = 4096;
export const MAX_CLI_TEXT_LENGTH = 16000;
export const CLI_OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sameCliSender(left: ChatroomCliScope, right: ChatroomCliScope): boolean {
  return left.roomId === right.roomId && left.participantId === right.participantId
    && left.memberId === right.memberId && left.runId === right.runId && left.sessionId === right.sessionId;
}

export function cliScopeMatchesRoom(room: Room, scope: ChatroomCliScope): boolean {
  const member = room.memberships.find(value => value.memberId === scope.memberId);
  const run = room.runs.find(value => value.runId === scope.runId);
  return room.id === scope.roomId && !room.archived
    && member?.participantId === scope.participantId && run?.memberId === scope.memberId
    && run.sessionId === scope.sessionId && run.status !== 'stopped' && run.status !== 'failed';
}

export function freezeRoomCliMessages(messages: readonly RoomCliMessage[] = []): readonly RoomCliMessage[] {
  if (messages.length > MAX_ROOM_CLI_MESSAGES) throw new Error('Room CLI message capacity exceeded.');
  const keys = new Set<string>();
  const messageIds = new Set<string>();
  return Object.freeze(messages.map(value => {
    const ids = [value.roomId, value.participantId, value.memberId, value.runId, value.sessionId, value.messageId];
    if (
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(id))
      || !CLI_OPERATION_PATTERN.test(value.operationId)
      || typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > MAX_CLI_TEXT_LENGTH
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isFinite(Date.parse(value.timestamp))
    ) throw new Error('Invalid Room CLI message.');
    const key = JSON.stringify([...ids.slice(0, 5), value.operationId]);
    if (keys.has(key)) throw new Error('Duplicate Room CLI operation.');
    if (messageIds.has(value.messageId)) throw new Error('Duplicate Room CLI message identity.');
    keys.add(key);
    messageIds.add(value.messageId);
    return Object.freeze({ ...value });
  }));
}
