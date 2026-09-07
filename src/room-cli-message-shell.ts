import type { AgentConversationPluginCommandMessage } from '@cordisx/protocol/agent-conversation-shell/v10';
import { text } from './conversation-model.js';
import type { Room } from './room.js';

/** The same committed Room facts, expressed through the public Shell source. */
export function roomCliShellMessages(room: Room): readonly AgentConversationPluginCommandMessage[] {
  return (room.cliMessages ?? []).slice(-500).flatMap(message => {
    const member = room.memberships.find(value => value.memberId === message.memberId);
    if (member?.participantId !== message.participantId) return [];
    return [{
      kind: 'message',
      itemId: message.messageId,
      messageId: message.messageId,
      sequence: message.sequence,
      source: {
        kind: 'plugin-command',
        roomId: message.roomId,
        messageId: message.messageId,
        sessionId: message.sessionId,
        participantId: message.participantId,
        memberId: message.memberId,
        runId: message.runId,
        operationId: message.operationId,
        sequence: message.sequence,
      },
      author: {
        participantId: member.participantId,
        role: 'agent',
        displayName: text('participant.name', member.label),
        avatar: member.avatar,
        agentIdentity: member.definition,
      },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: text('message.cli', message.text) }],
      timestamp: message.timestamp,
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      reactions: [],
      actions: [],
    }];
  });
}
