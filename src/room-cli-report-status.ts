import type { AgentConversationItem } from '@cordisx/protocol/agent-conversation-shell/v7';
import type { SessionEvent } from '@cordisx/protocol/sessions/v1';
import { text } from './conversation-model.js';
import { createChatroomOpaqueId, type Room, type RoomRun } from './room.js';

/** An observed missing report is a status, never an invented CLI error or message. */
export function roomCliReportStatus(
  room: Room,
  run: RoomRun,
  events: readonly SessionEvent[],
  sequenceFor: (eventSeq: number) => number,
): Extract<AgentConversationItem, { kind: 'status'; }> | undefined {
  if (run.collaborationMode !== 'cli') return undefined;
  const lifecycle = events.filter(event => event.type === 'turn/start' || event.type === 'turn/end')
    .sort((left, right) => left.seq - right.seq);
  const end = lifecycle.at(-1);
  if (end?.type !== 'turn/end') return undefined;
  const start = lifecycle.findLast(event => event.type === 'turn/start' && event.data.turn === end.data.turn);
  if (start === undefined) return undefined;
  if (
    room.cliMessages?.some(message =>
      message.sessionId === run.sessionId && message.runId === run.runId
      && Date.parse(message.timestamp) >= start.time
    )
  ) return undefined;
  return {
    kind: 'status',
    itemId: createChatroomOpaqueId('cli-unreported', run.runId, String(end.data.turn)),
    sequence: sequenceFor(end.seq),
    label: text('agent.cli.unreported', 'Agent execution ended without a Room report. Check the task history.'),
    state: 'warning',
    ariaLive: 'polite',
  };
}
