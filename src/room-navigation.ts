import type { NavigationCollectionActions } from '@cordisx/protocol/navigation-collection-actions/v1';
import type {
  CordisXLocalizedText,
  CordisXNavigationCollectionSnapshotV3,
  CordisXNavigationCollectionSourceV3,
} from 'cordisx/contracts';

import { text } from './conversation-model.js';
import {
  CHATROOM_COMMAND_ROOM_ARCHIVE,
  CHATROOM_COMMAND_ROOM_DELETE,
  CHATROOM_COMMAND_ROOM_PIN,
  CHATROOM_COMMAND_ROOM_RESTORE,
} from './room-management.js';
import type { Room } from './room.js';
import { ChatroomRoomRegistry } from './room.js';
import { roomAvatarFingerprint } from './avatar-fingerprint.js';
import type { ChatroomSidebarImageCache } from './sidebar-image-cache.js';

export type ChatroomRoomNavigationMode = 'active' | 'archived';

function localized(key: string, fallback: string): CordisXLocalizedText {
  return { namespace: 'chatroom', key, fallback };
}

export function latestRoomMessage(room: Room) {
  return room.items
    .filter(item => item.kind === 'message')
    .sort((left, right) => right.sequence - left.sequence)[0];
}

export function roomMessageSummary(room: Room): CordisXLocalizedText {
  const message = latestRoomMessage(room);
  if (message === undefined) return localized('navigation.room.empty', 'No messages yet');
  const plain = message.body
    .map(part => part.text.fallback ?? part.text.key)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const summary = Array.from(plain || 'No messages yet').slice(0, 180).join('');
  return { namespace: 'chatroom', key: 'navigation.room.summary', params: { summary }, fallback: summary };
}

function feedback(successKey: string, success: string, failureKey: string, failure: string) {
  return { success: localized(successKey, success), failure: localized(failureKey, failure) };
}

function roomActions(room: Room, mode: ChatroomRoomNavigationMode): NavigationCollectionActions {
  const roomArguments = { roomId: room.id } as const;
  const direct = mode === 'active'
    ? [{
      kind: 'command' as const,
      id: 'pin',
      label: localized(room.pinned ? 'action.unpin' : 'action.pin', room.pinned ? 'Unpin' : 'Pin'),
      icon: (room.pinned ? 'host:pinned' : 'host:pin') as 'host:pin' | 'host:pinned',
      placement: 'direct' as const,
      tone: 'neutral' as const,
      pressed: room.pinned,
      disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_PIN, arguments: roomArguments },
      feedback: feedback(
        room.pinned ? 'feedback.unpinned' : 'feedback.pinned',
        room.pinned ? 'Room unpinned' : 'Room pinned',
        'feedback.pin-failed',
        'Could not update pin',
      ),
    }, {
      kind: 'command' as const,
      id: 'archive',
      label: localized('action.archive', 'Archive'),
      icon: 'host:archive' as const,
      placement: 'direct' as const,
      tone: 'neutral' as const,
      pressed: false,
      disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_ARCHIVE, arguments: roomArguments },
      feedback: feedback('feedback.archived', 'Room archived', 'feedback.archive-failed', 'Could not archive Room'),
    }]
    : [{
      kind: 'command' as const,
      id: 'restore',
      label: localized('action.restore', 'Restore'),
      icon: 'host:restore' as const,
      placement: 'direct' as const,
      tone: 'neutral' as const,
      pressed: false,
      disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_RESTORE, arguments: roomArguments },
      feedback: feedback('feedback.restored', 'Room restored', 'feedback.restore-failed', 'Could not restore Room'),
    }];
  return Object.freeze([
    ...direct,
    {
      kind: 'copy-route-link',
      id: 'copy-link',
      label: localized('action.copy-link', 'Copy deep link'),
      icon: 'host:link',
      placement: 'overflow',
      tone: 'neutral',
      pressed: false,
      disabled: { value: false },
      feedback: feedback('feedback.link-copied', 'Deep link copied', 'feedback.copy-failed', 'Could not copy'),
    },
    {
      kind: 'copy-text',
      id: 'copy-id',
      label: localized('action.copy-id', 'Copy Room ID'),
      icon: 'host:copy',
      placement: 'overflow',
      tone: 'neutral',
      pressed: false,
      disabled: { value: false },
      text: { value: room.id },
      feedback: feedback('feedback.id-copied', 'Room ID copied', 'feedback.copy-failed', 'Could not copy'),
    },
    {
      kind: 'command',
      id: 'delete',
      label: localized('action.delete', 'Delete'),
      icon: 'host:delete',
      placement: 'overflow',
      tone: 'danger',
      pressed: false,
      disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_DELETE, arguments: roomArguments },
      confirmation: {
        title: localized('confirmation.delete.title', 'Delete this Room?'),
        description: localized(
          'confirmation.delete.description',
          'Messages and Room state will be permanently deleted.',
        ),
        confirmLabel: localized('confirmation.delete.confirm', 'Delete Room'),
      },
      feedback: feedback('feedback.deleted', 'Room deleted', 'feedback.delete-failed', 'Could not delete Room'),
    },
  ]);
}

/** Data-only v3 Room projection. CordisX owns every row, action, menu and feedback node. */
export class ChatroomRoomNavigationCollection implements CordisXNavigationCollectionSourceV3 {
  private readonly listeners = new Set<() => void>();
  private readonly itemIds = new Map<string, string>();
  private readonly unsubscribeRegistry: () => void;
  private readonly unsubscribeImages?: () => void;
  private revision = 0;
  private nextItemId = 1;
  private disposed = false;

  constructor(
    private readonly rooms: ChatroomRoomRegistry,
    private readonly mode: ChatroomRoomNavigationMode = 'active',
    private readonly images?: ChatroomSidebarImageCache,
  ) {
    this.unsubscribeRegistry = rooms.subscribe(() => this.refresh());
    this.unsubscribeImages = images?.subscribe(() => this.refresh());
  }

  snapshot(): CordisXNavigationCollectionSnapshotV3 {
    const rooms = this.rooms.snapshot()
      .filter(room => room.archived === (this.mode === 'archived'))
      .sort((left, right) =>
        Number(right.pinned) - Number(left.pinned)
        || (latestRoomMessage(right)?.sequence ?? -1) - (latestRoomMessage(left)?.sequence ?? -1)
        || left.id.localeCompare(right.id)
      )
      .slice(0, 500);
    return {
      revision: this.revision,
      items: rooms.map((room, order) => {
        const participants = room.participants.map(participant => ({
          id: participant.id,
          name: participant.name,
          ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
        }));
        const fingerprint = roomAvatarFingerprint(participants);
        const image = this.images?.get(room.id, fingerprint);
        const leadingVisual = image === undefined ? undefined : Object.freeze({
          kind: 'image' as const,
          image,
        });
        return {
          id: this.itemIdFor(room.id),
          label: text('navigation.room.title', room.title),
          description: roomMessageSummary(room),
          ...(leadingVisual === undefined ? { icon: 'host:layers' as const } : { leadingVisual }),
          route: { id: 'room', params: { roomId: room.id } },
          actions: roomActions(room, this.mode),
          order,
        };
      }),
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
    this.unsubscribeImages?.();
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
