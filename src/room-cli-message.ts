import { createRoom, nextRoomTimelineSequence } from './room.js';
import { ChatroomRoomStoreError, type DurableChatroomRoomStore } from './room-store.js';
import {
  type ChatroomCliScope,
  CLI_OPERATION_PATTERN,
  cliScopeMatchesRoom,
  MAX_CLI_TEXT_LENGTH,
  MAX_ROOM_CLI_MESSAGES,
  type RoomCliMessage,
  sameCliSender,
} from './room-cli-message-model.js';

export interface ChatroomCliSendInput {
  readonly operationId: string;
  readonly text: string;
  readonly roomId?: string;
}

export type ChatroomCliResult =
  | {
    readonly status: 'accepted';
    readonly operationId: string;
    readonly roomId: string;
    readonly messageId: string;
    readonly memberId: string;
    readonly disposition: 'created' | 'replayed';
  }
  | {
    readonly status: 'rejected';
    readonly code: 'invalid-input' | 'unauthorized' | 'stale-binding' | 'operation-conflict' | 'unavailable';
  };

export function isChatroomCliSendInput(value: unknown): value is ChatroomCliSendInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ['operationId', 'text', 'roomId'].includes(key))
    && typeof input.operationId === 'string' && CLI_OPERATION_PATTERN.test(input.operationId)
    && typeof input.text === 'string' && input.text.trim() !== '' && input.text.length <= MAX_CLI_TEXT_LENGTH
    && (input.roomId === undefined || typeof input.roomId === 'string' && input.roomId.length > 0);
}

const receipt = (message: RoomCliMessage, disposition: 'created' | 'replayed'): ChatroomCliResult => ({
  status: 'accepted',
  operationId: message.operationId,
  roomId: message.roomId,
  messageId: message.messageId,
  memberId: message.memberId,
  disposition,
});

/** Caller must obtain scope from the Host handler context, never from CLI input. */
export function createChatroomCliMessageHandler(store: DurableChatroomRoomStore) {
  return async (scope: ChatroomCliScope, value: unknown, signal?: AbortSignal): Promise<ChatroomCliResult> => {
    if (!isChatroomCliSendInput(value)) return { status: 'rejected', code: 'invalid-input' };
    if (value.roomId !== undefined && value.roomId !== scope.roomId) {
      return { status: 'rejected', code: 'unauthorized' };
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (signal?.aborted) return { status: 'rejected', code: 'unavailable' };
      const document = store.document(scope.roomId);
      if (document === undefined || !cliScopeMatchesRoom(document.room, scope)) {
        return { status: 'rejected', code: 'stale-binding' };
      }
      const messages = document.room.cliMessages ?? [];
      const existing = messages.find(message =>
        sameCliSender(message, scope) && message.operationId === value.operationId
      );
      if (existing !== undefined) {
        return existing.text === value.text
          ? receipt(existing, 'replayed')
          : { status: 'rejected', code: 'operation-conflict' };
      }
      // Do not evict deduplication evidence and silently allow an old operation to execute again.
      if (messages.length >= MAX_ROOM_CLI_MESSAGES) return { status: 'rejected', code: 'unavailable' };
      const message: RoomCliMessage = {
        ...scope,
        operationId: value.operationId,
        messageId: `chatroom-cli.${crypto.randomUUID()}`,
        text: value.text,
        sequence: nextRoomTimelineSequence(document.room),
        timestamp: new Date().toISOString(),
      };
      try {
        await store.compareAndSwap(
          document.revision,
          createRoom({
            ...document.room,
            runs: document.room.runs.map(run =>
              run.runId === scope.runId && run.sessionId === undefined
                ? { ...run, sessionId: scope.sessionId, collaborationMode: 'cli' as const }
                : run
            ),
            cliMessages: [...messages, message],
            timelineSequence: message.sequence,
          }),
        );
        return receipt(message, 'created');
      } catch (error) {
        if (!(error instanceof ChatroomRoomStoreError) || error.code !== 'conflict') {
          return { status: 'rejected', code: 'unavailable' };
        }
      }
    }
    return { status: 'rejected', code: 'unavailable' };
  };
}
