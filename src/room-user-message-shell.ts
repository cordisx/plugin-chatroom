import { projectRoomParticipant } from './conversation-model.js';
import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v11';
import { unprojectedAdmittedHumanMessages } from './room-admitted-human-history.js';
import type { Room } from './room.js';

type RoomUserMessage = Extract<AgentConversationItem, { source: { kind: 'room-user-message'; }; }>;

/** Real persisted user submissions, not reconstructed SessionEvents or acknowledgements. */
export function roomUserShellMessages(
  room: Room,
  admittedRoomItemIds: readonly string[] = [],
): readonly RoomUserMessage[] {
  return unprojectedAdmittedHumanMessages(room, admittedRoomItemIds).flatMap(item => {
    const retainedAuthor = room.participants.find(value =>
      value.id === item.author.participantId && value.kind === 'human'
    );
    if (retainedAuthor === undefined) return [];
    const author = projectRoomParticipant(retainedAuthor, room);
    if (author.role !== 'human') return [];
    return [{
      kind: 'message',
      itemId: item.itemId,
      messageId: item.messageId,
      sequence: item.sequence,
      source: { kind: 'room-user-message', roomId: room.id, messageId: item.messageId, sequence: item.sequence },
      author: { ...author, role: 'human' },
      semantic: { purpose: 'conversation' },
      body: item.body,
      timestamp: item.timestamp,
      // A persisted admission link proves submission, not Agent execution or completion.
      deliveryState: 'sent',
      runState: 'idle',
      ariaLive: 'off',
      reactions: item.reactions,
      actions: item.actions,
    }];
  });
}
