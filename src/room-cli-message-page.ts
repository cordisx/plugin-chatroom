import type { AgentConversationMessageItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type { Room } from './room.js';
import { text } from './conversation-model.js';

/** Chatroom page-owned data; it is not a fabricated SessionEvent or Shell source. */
export type ChatroomCliPageMessage = Omit<AgentConversationMessageItem, 'source'> & {
  readonly source: 'chatroom-cli';
};

export function roomCliPageMessages(room: Room): readonly ChatroomCliPageMessage[] {
  return (room.cliMessages ?? []).slice(-500).flatMap(message => {
    const member = room.memberships.find(value => value.memberId === message.memberId);
    if (member?.participantId !== message.participantId) return [];
    return [{
      kind: 'message',
      source: 'chatroom-cli',
      itemId: message.messageId,
      messageId: message.messageId,
      sequence: message.sequence,
      timestamp: message.timestamp,
      author: {
        participantId: member.participantId,
        role: 'agent',
        displayName: text('participant.name', member.label),
        avatar: member.avatar,
        agentIdentity: member.definition,
      },
      semantic: { purpose: 'conversation', causation: { operationId: message.operationId } },
      body: [{ kind: 'text', text: text('message.cli', message.text) }],
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      reactions: [],
      actions: [],
    }];
  });
}
