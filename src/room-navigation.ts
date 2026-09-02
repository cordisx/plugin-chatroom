import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';
import type {
  CordisXLocalizedText,
  CordisXNavigationCollectionLeadingVisual,
  CordisXNavigationCollectionSnapshotV2,
  CordisXNavigationCollectionSourceV2,
  NavigationCollectionActions,
} from 'cordisx/contracts';
import { CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS } from 'cordisx/contracts';

import {
  CHATROOM_COMMAND_ROOM_ARCHIVE,
  CHATROOM_COMMAND_ROOM_DELETE,
  CHATROOM_COMMAND_ROOM_PIN,
  CHATROOM_COMMAND_ROOM_RESTORE,
} from './room-management.js';
import type { Room } from './room.js';
import { ChatroomRoomRegistry } from './room.js';

export type ChatroomRoomNavigationMode = 'active' | 'archived';

function roomLeadingVisual(room: Room): CordisXNavigationCollectionLeadingVisual {
  const seenParticipantIds = new Set<string>();
  const participants = [];
  for (const participant of room.participants) {
    if (seenParticipantIds.has(participant.id)) continue;
    seenParticipantIds.add(participant.id);
    participants.push(Object.freeze({
      participantId: participant.id,
      ...(participant.avatar === undefined ? {} : { avatar: cloneAgentAvatarRef(participant.avatar) }),
    }));
    if (participants.length === CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS) break;
  }
  return Object.freeze({ kind: 'room-composite-avatar', participants: Object.freeze(participants) });
}

function localized(key: string, fallback: string): CordisXLocalizedText {
  return { namespace: 'chatroom', key, fallback };
}

/**
 * SessionEvent is the only durable conversation history. Room navigation never
 * stores or invents a parallel latest-message ledger.
 */
export function latestRoomMessage(_room: Room): undefined {
  return undefined;
}

export function roomMessageSummary(room: Room): CordisXLocalizedText {
  const summary = Array.from(room.description?.trim() || 'Session history is available when the Room is open.')
    .slice(0, 180).join('');
  return { namespace: 'chatroom', key: 'navigation.room.summary', params: { summary }, fallback: summary };
}

function feedback(successKey: string, success: string, failureKey: string, failure: string) {
  return { success: localized(successKey, success), failure: localized(failureKey, failure) };
}

function roomActions(room: Room, mode: ChatroomRoomNavigationMode): NavigationCollectionActions {
  const roomArguments = { roomId: room.id } as const;
  const direct = mode === 'active'
    ? [{
        kind: 'command' as const, id: 'pin',
        label: localized(room.pinned ? 'action.unpin' : 'action.pin', room.pinned ? 'Unpin' : 'Pin'),
        icon: (room.pinned ? 'host:pinned' : 'host:pin') as 'host:pin' | 'host:pinned', placement: 'direct' as const, tone: 'neutral' as const,
        pressed: room.pinned, disabled: { value: false },
        command: { id: CHATROOM_COMMAND_ROOM_PIN, arguments: roomArguments },
        feedback: feedback(room.pinned ? 'feedback.unpinned' : 'feedback.pinned', room.pinned ? 'Room unpinned' : 'Room pinned', 'feedback.pin-failed', 'Could not update pin'),
      }, {
        kind: 'command' as const, id: 'archive', label: localized('action.archive', 'Archive'),
        icon: 'host:archive' as const, placement: 'direct' as const, tone: 'neutral' as const,
        pressed: false, disabled: { value: false },
        command: { id: CHATROOM_COMMAND_ROOM_ARCHIVE, arguments: roomArguments },
        feedback: feedback('feedback.archived', 'Room archived', 'feedback.archive-failed', 'Could not archive Room'),
      }]
    : [{
        kind: 'command' as const, id: 'restore', label: localized('action.restore', 'Restore'),
        icon: 'host:restore' as const, placement: 'direct' as const, tone: 'neutral' as const,
        pressed: false, disabled: { value: false },
        command: { id: CHATROOM_COMMAND_ROOM_RESTORE, arguments: roomArguments },
        feedback: feedback('feedback.restored', 'Room restored', 'feedback.restore-failed', 'Could not restore Room'),
      }];
  return Object.freeze([
    ...direct,
    {
      kind: 'copy-route-link', id: 'copy-link', label: localized('action.copy-link', 'Copy deep link'),
      icon: 'host:link',
      placement: 'overflow', tone: 'neutral', pressed: false, disabled: { value: false },
      feedback: feedback('feedback.link-copied', 'Deep link copied', 'feedback.copy-failed', 'Could not copy'),
    },
    {
      kind: 'copy-text', id: 'copy-id', label: localized('action.copy-id', 'Copy Room ID'),
      icon: 'host:copy',
      placement: 'overflow', tone: 'neutral', pressed: false, disabled: { value: false },
      text: { value: room.id },
      feedback: feedback('feedback.id-copied', 'Room ID copied', 'feedback.copy-failed', 'Could not copy'),
    },
    {
      kind: 'command', id: 'delete', label: localized('action.delete', 'Delete'),
      icon: 'host:delete',
      placement: 'overflow', tone: 'danger', pressed: false, disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_DELETE, arguments: roomArguments },
      confirmation: {
        title: localized('confirmation.delete.title', 'Delete this Room?'),
        description: localized('confirmation.delete.description', 'Messages and Room state will be permanently deleted.'),
        confirmLabel: localized('confirmation.delete.confirm', 'Delete Room'),
      },
      feedback: feedback('feedback.deleted', 'Room deleted', 'feedback.delete-failed', 'Could not delete Room'),
    },
  ]);
}

/** Data-only v2 Room projection. Host owns every row, action, menu and feedback node. */
export class ChatroomRoomNavigationCollection implements CordisXNavigationCollectionSourceV2 {
  private readonly listeners = new Set<() => void>();
  private readonly itemIds = new Map<string, string>();
  private readonly unsubscribeRegistry: () => void;
  private revision = 0;
  private nextItemId = 1;
  private disposed = false;

  constructor(
    private readonly rooms: ChatroomRoomRegistry,
    private readonly mode: ChatroomRoomNavigationMode = 'active',
  ) {
    this.unsubscribeRegistry = rooms.subscribe(() => this.refresh());
  }

  snapshot(): CordisXNavigationCollectionSnapshotV2 {
    const rooms = this.rooms.snapshot()
      .filter(room => room.archived === (this.mode === 'archived'))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || left.id.localeCompare(right.id))
      .slice(0, 500);
    return {
      revision: this.revision,
      items: rooms.map((room, order) => ({
        id: this.itemIdFor(room.id),
        label: {
          namespace: 'chatroom',
          key: 'navigation.room.title',
          params: { title: room.title },
          fallback: room.title,
        },
        description: roomMessageSummary(room),
        leadingVisual: roomLeadingVisual(room),
        route: { id: 'room', params: { roomId: room.id } },
        actions: roomActions(room, this.mode),
        order,
      })),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRegistry();
    this.listeners.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private itemIdFor(roomId: string): string {
    let itemId = this.itemIds.get(roomId);
    if (itemId === undefined) {
      itemId = `room-${this.nextItemId++}`;
      this.itemIds.set(roomId, itemId);
    }
    return itemId;
  }
}
