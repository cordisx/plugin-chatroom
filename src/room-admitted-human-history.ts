import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v3';
import type { Room } from './room.js';

/** Read-only persisted Room facts missing from the current verified Session projection. */
export function unprojectedAdmittedHumanMessages(
  room: Room,
  admittedRoomItemIds: readonly string[] = [],
): readonly Extract<AgentConversationItem, { kind: 'message'; }>[] {
  const represented = new Set(admittedRoomItemIds);
  const admitted = new Set((room.admissionMessageLinks ?? []).map(link => link.itemId));
  return room.items.flatMap(item =>
    item.kind === 'message' && item.author.role === 'human' && item.semantic.purpose === 'conversation'
      && admitted.has(item.itemId) && !represented.has(item.itemId)
      ? [item]
      : []
  );
}
