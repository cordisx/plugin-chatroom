import type {
  CordisXCommandContext,
  ManagerCollectionAction,
  ManagerCollectionActionResultV1,
  ManagerCollectionDisplayText,
  ManagerCollectionItem,
  ManagerCollectionLeadingVisual,
  ManagerCollectionQueryV1,
  ManagerCollectionRegistrationV1,
  ManagerCollectionSnapshotV1,
  ManagerCollectionSourceV1,
  NavigationCollectionActionFeedback,
} from 'cordisx/contracts';

import {
  CHATROOM_COMMAND_ROOM_ARCHIVE,
  CHATROOM_COMMAND_ROOM_DELETE,
  CHATROOM_COMMAND_ROOM_PIN,
  CHATROOM_COMMAND_ROOM_RENAME,
  CHATROOM_COMMAND_ROOM_RESTORE,
  CHATROOM_ROOM_TITLE_MAX_CODE_POINTS,
  ChatroomRoomManagementError,
  type ChatroomRoomManagementCommand,
} from './room-management.js';
import { latestRoomMessage, roomMessageSummary } from './room-navigation.js';
import type { Room } from './room.js';
import {
  ChatroomRoomStoreError,
  type DurableChatroomRoomStore,
} from './room-store.js';

const REGISTRATION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-registration.v1.schema.json' as const;
const SNAPSHOT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-snapshot.v1.schema.json' as const;
const ACTION_RESULT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-collection-action-result.v1.schema.json' as const;

export const CHATROOM_MANAGER_ROOMS_COLLECTION_ID = 'rooms' as const;
export const CHATROOM_MANAGER_ARCHIVED_COLLECTION_ID = 'archived-rooms' as const;
export const CHATROOM_MANAGER_I18N_NAMESPACE = 'chatroom-manager' as const;
export type ChatroomManagerRoomMode = 'active' | 'archived';

const localized = (
  key: string,
  fallback: string,
  params?: Readonly<Record<string, string | number | boolean | null>>,
): ManagerCollectionDisplayText => ({
  namespace: CHATROOM_MANAGER_I18N_NAMESPACE,
  key,
  fallback,
  ...(params === undefined ? {} : { params }),
});

const feedback = (
  successKey: string,
  success: string,
  failureKey: string,
  failure: string,
): NavigationCollectionActionFeedback => ({
  success: localized(successKey, success),
  failure: localized(failureKey, failure),
});

const compareOpaqueIds = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

const search = Object.freeze({
  fields: ['title', 'summary'] as const,
  normalization: 'nfkc-casefold' as const,
  label: localized('manager.search.label', 'Search chats'),
  placeholder: localized('manager.search.placeholder', 'Search titles and messages'),
  noMatchTitle: localized('manager.search.no-match.title', 'No matching chats'),
  noMatchDescription: localized(
    'manager.search.no-match.description',
    'Try another title or public message summary.',
  ),
});

export const CHATROOM_MANAGER_ROOMS_REGISTRATION = Object.freeze({
  $schema: REGISTRATION_SCHEMA,
  contract: 'cordisx.manager-collection-registration/v1',
  schemaVersion: 1,
  id: CHATROOM_MANAGER_ROOMS_COLLECTION_ID,
  label: localized('manager.collection.rooms.label', 'Rooms'),
  description: localized('manager.collection.rooms.description', 'Manage active chats.'),
  views: Object.freeze([Object.freeze({
    id: 'active',
    label: localized('manager.tab.rooms', 'Rooms'),
    emptyTitle: localized('manager.collection.rooms.empty.title', 'No rooms yet'),
    emptyDescription: localized(
      'manager.collection.rooms.empty.description',
      'Rooms appear here after they are created.',
    ),
  })]),
  defaultView: 'active',
  search,
} as const satisfies ManagerCollectionRegistrationV1);

export const CHATROOM_MANAGER_ARCHIVED_REGISTRATION = Object.freeze({
  $schema: REGISTRATION_SCHEMA,
  contract: 'cordisx.manager-collection-registration/v1',
  schemaVersion: 1,
  id: CHATROOM_MANAGER_ARCHIVED_COLLECTION_ID,
  label: localized('manager.collection.archived.label', 'Archived'),
  description: localized('manager.collection.archived.description', 'Find and restore archived chats.'),
  views: Object.freeze([Object.freeze({
    id: 'archived',
    label: localized('manager.tab.archived', 'Archived'),
    emptyTitle: localized('manager.collection.archived.empty.title', 'No archived rooms'),
    emptyDescription: localized(
      'manager.collection.archived.empty.description',
      'Rooms you archive appear here.',
    ),
  })]),
  defaultView: 'archived',
  search,
} as const satisfies ManagerCollectionRegistrationV1);

/** Shared product-lifetime identities and monotonic revision for page-scoped sources and commands. */
export class ChatroomRoomManagerCoordinator {
  private readonly listeners = new Set<() => void>();
  private readonly itemIds = new Map<string, string>();
  private readonly unsubscribeRooms: () => void;
  private nextItemId = 1;
  private revision = 0;
  private disposed = false;

  constructor(readonly store: DurableChatroomRoomStore) {
    this.unsubscribeRooms = store.rooms.subscribe(() => this.refresh());
  }

  currentRevision(): number { return this.revision; }

  itemIdFor(roomId: string): string {
    let itemId = this.itemIds.get(roomId);
    if (itemId === undefined) {
      itemId = `room-${this.nextItemId++}`;
      this.itemIds.set(roomId, itemId);
    }
    return itemId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRooms();
    this.listeners.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

function publicRoomTitle(room: Room): string {
  const title = Array.from(room.title.replace(/[\u0000-\u001F\u007F]/gu, '\uFFFD'))
    .slice(0, CHATROOM_ROOM_TITLE_MAX_CODE_POINTS)
    .join('');
  return title.trim() || 'Untitled room';
}

function roomLeadingVisual(room: Room): ManagerCollectionLeadingVisual {
  void room;
  return Object.freeze({ kind: 'semantic-icon', icon: 'host:layers' });
}

function renameAction(room: Room): ManagerCollectionAction {
  const initialValue = publicRoomTitle(room);
  return Object.freeze({
    kind: 'text-input-command',
    id: 'rename',
    label: localized('manager.action.rename', 'Rename'),
    placement: 'overflow',
    tone: 'neutral',
    pressed: false,
    disabled: { value: false },
    command: { id: CHATROOM_COMMAND_ROOM_RENAME, arguments: { roomId: room.id } },
    input: {
      argument: 'title',
      title: localized('manager.rename.title', 'Rename chat'),
      description: localized('manager.rename.description', 'Choose a clear title for this chat.'),
      label: localized('manager.rename.label', 'Chat title'),
      submitLabel: localized('manager.rename.submit', 'Rename'),
      initialValue,
      minLength: 1,
      maxLength: CHATROOM_ROOM_TITLE_MAX_CODE_POINTS,
      trim: 'both' as const,
    },
    feedback: feedback(
      'manager.feedback.renamed', 'Chat renamed',
      'manager.feedback.rename-failed', 'Could not rename chat',
    ),
  });
}

function deleteAction(room: Room): ManagerCollectionAction {
  return Object.freeze({
    kind: 'command',
    id: 'delete',
    label: localized('manager.action.delete', 'Delete'),
    icon: 'host:delete',
    placement: 'overflow',
    tone: 'danger',
    pressed: false,
    disabled: { value: false },
    command: { id: CHATROOM_COMMAND_ROOM_DELETE, arguments: { roomId: room.id } },
    confirmation: {
      title: localized('manager.delete.title', 'Delete this room?'),
      description: localized(
        'manager.delete.description',
        'Messages and room state will be permanently deleted.',
      ),
      confirmLabel: localized('manager.delete.confirm', 'Delete room'),
    },
    feedback: feedback(
      'manager.feedback.deleted', 'Room deleted',
      'manager.feedback.delete-failed', 'Could not delete room',
    ),
  });
}

function roomActions(room: Room, mode: ChatroomManagerRoomMode): readonly ManagerCollectionAction[] {
  if (mode === 'archived') {
    return Object.freeze([Object.freeze({
      kind: 'command',
      id: 'restore',
      label: localized('manager.action.restore', 'Restore'),
      icon: 'host:restore',
      placement: 'direct',
      tone: 'neutral',
      pressed: false,
      disabled: { value: false },
      command: { id: CHATROOM_COMMAND_ROOM_RESTORE, arguments: { roomId: room.id } },
      feedback: feedback(
        'manager.feedback.restored', 'Room restored',
        'manager.feedback.restore-failed', 'Could not restore room',
      ),
    }), deleteAction(room)]);
  }
  return Object.freeze([Object.freeze({
    kind: 'command',
    id: 'pin',
    label: localized(room.pinned ? 'manager.action.unpin' : 'manager.action.pin', room.pinned ? 'Unpin' : 'Pin'),
    icon: room.pinned ? 'host:pinned' : 'host:pin',
    placement: 'direct',
    tone: 'neutral',
    pressed: room.pinned,
    disabled: { value: false },
    command: { id: CHATROOM_COMMAND_ROOM_PIN, arguments: { roomId: room.id } },
    feedback: feedback(
      room.pinned ? 'manager.feedback.unpinned' : 'manager.feedback.pinned',
      room.pinned ? 'Room unpinned' : 'Room pinned',
      'manager.feedback.pin-failed', 'Could not update pin',
    ),
  }), Object.freeze({
    kind: 'command',
    id: 'archive',
    label: localized('manager.action.archive', 'Archive'),
    icon: 'host:archive',
    placement: 'direct',
    tone: 'neutral',
    pressed: false,
    disabled: { value: false },
    command: { id: CHATROOM_COMMAND_ROOM_ARCHIVE, arguments: { roomId: room.id } },
    feedback: feedback(
      'manager.feedback.archived', 'Room archived',
      'manager.feedback.archive-failed', 'Could not archive room',
    ),
  }), renameAction(room), deleteAction(room)]);
}

/** Search deliberately returns the complete selected view; the Host owns the exact final filter. */
export class ChatroomRoomManagerCollectionSource implements ManagerCollectionSourceV1 {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeCoordinator: () => void;
  private disposed = false;

  constructor(
    private readonly coordinator: ChatroomRoomManagerCoordinator,
    private readonly mode: ChatroomManagerRoomMode,
  ) {
    this.unsubscribeCoordinator = coordinator.subscribe(() => this.refresh());
  }

  snapshot(query: ManagerCollectionQueryV1, signal: AbortSignal): ManagerCollectionSnapshotV1 {
    if (signal.aborted) throw new Error('Manager collection query was aborted.');
    const collectionId = this.mode === 'active'
      ? CHATROOM_MANAGER_ROOMS_COLLECTION_ID
      : CHATROOM_MANAGER_ARCHIVED_COLLECTION_ID;
    const view = this.mode;
    if (query.collectionId !== collectionId || query.view !== view) {
      throw new Error('Manager collection query does not match this source.');
    }
    const rooms = this.coordinator.store.rooms.snapshot()
      .filter(room => room.archived === (this.mode === 'archived'))
      .sort((left, right) => (this.mode === 'active' ? Number(right.pinned) - Number(left.pinned) : 0)
        || (latestRoomMessage(right)?.sequence ?? -1) - (latestRoomMessage(left)?.sequence ?? -1)
        || compareOpaqueIds(left.id, right.id));
    if (rooms.length > 1000) {
      throw new Error('Manager collection selected view exceeds the 1000-row snapshot bound.');
    }
    const items = rooms.map((room, order): ManagerCollectionItem => {
      const title = publicRoomTitle(room);
      const summary = roomMessageSummary(room);
      return Object.freeze({
        id: this.coordinator.itemIdFor(room.id),
        title: localized('manager.room.title', title, { title }),
        summary: { ...summary, fallback: summary.fallback ?? 'No messages yet' },
        leadingVisual: roomLeadingVisual(room),
        route: { id: 'room', params: { roomId: room.id } },
        order,
        disabled: { value: false },
        actions: roomActions(room, this.mode),
      });
    });
    if (signal.aborted) throw new Error('Manager collection query was aborted.');
    return Object.freeze({
      $schema: SNAPSHOT_SCHEMA,
      contract: 'cordisx.manager-collection-snapshot/v1',
      schemaVersion: 1,
      collectionId,
      queryRevision: query.queryRevision,
      view,
      normalizedSearch: query.search.normalized,
      revision: this.coordinator.currentRevision(),
      items: Object.freeze(items),
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeCoordinator();
    this.listeners.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

const actionIdFor = (command: ChatroomRoomManagementCommand): string => ({
  [CHATROOM_COMMAND_ROOM_PIN]: 'pin',
  [CHATROOM_COMMAND_ROOM_RENAME]: 'rename',
  [CHATROOM_COMMAND_ROOM_ARCHIVE]: 'archive',
  [CHATROOM_COMMAND_ROOM_RESTORE]: 'restore',
  [CHATROOM_COMMAND_ROOM_DELETE]: 'delete',
})[command];

function appliedCodeFor(command: ChatroomRoomManagementCommand, room: Room): string {
  switch (command) {
    case CHATROOM_COMMAND_ROOM_PIN: return room.pinned ? 'room-unpinned' : 'room-pinned';
    case CHATROOM_COMMAND_ROOM_RENAME: return 'room-renamed';
    case CHATROOM_COMMAND_ROOM_ARCHIVE: return 'room-archived';
    case CHATROOM_COMMAND_ROOM_RESTORE: return 'room-restored';
    case CHATROOM_COMMAND_ROOM_DELETE: return 'room-deleted';
    default: throw new Error(`Unknown Room management command ${command}.`);
  }
}

function roomIdFromContext(context: CordisXCommandContext): string | undefined {
  const input = context.arguments;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const roomId = (input as Readonly<Record<string, unknown>>).roomId;
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : undefined;
}

function collectionIdFor(command: ChatroomRoomManagementCommand, room?: Room): string {
  if (command === CHATROOM_COMMAND_ROOM_RESTORE || room?.archived === true) {
    return CHATROOM_MANAGER_ARCHIVED_COLLECTION_ID;
  }
  return CHATROOM_MANAGER_ROOMS_COLLECTION_ID;
}

function result(
  collectionId: string,
  itemId: string,
  actionId: string,
  status: 'applied' | 'rejected' | 'conflict' | 'unavailable',
  code: string,
  revision?: number,
): ManagerCollectionActionResultV1 {
  const base = {
    $schema: ACTION_RESULT_SCHEMA,
    contract: 'cordisx.manager-collection-action-result/v1' as const,
    schemaVersion: 1 as const,
    collectionId, itemId, actionId, code,
  };
  return status === 'applied'
    ? Object.freeze({ ...base, status, revision: revision! })
    : Object.freeze({ ...base, status });
}

/** Wraps product commands with the exact Manager collection action-result handshake. */
export function createChatroomManagerCommandHandler(
  coordinator: ChatroomRoomManagerCoordinator,
  command: ChatroomRoomManagementCommand,
  handle: (context: CordisXCommandContext) => Promise<void>,
): (context: CordisXCommandContext) => Promise<ManagerCollectionActionResultV1> {
  return async context => {
    const roomId = roomIdFromContext(context);
    const room = roomId === undefined ? undefined : coordinator.store.rooms.get(roomId);
    const collectionId = collectionIdFor(command, room);
    const itemId = roomId === undefined ? 'room-invalid' : coordinator.itemIdFor(roomId);
    const actionId = actionIdFor(command);
    if (context.signal.aborted) {
      return result(collectionId, itemId, actionId, 'unavailable', 'operation-aborted');
    }
    if (roomId === undefined) {
      return result(collectionId, itemId, actionId, 'rejected', 'invalid-arguments');
    }
    if (room === undefined) {
      return result(collectionId, itemId, actionId, 'rejected', 'room-unavailable');
    }
    if (command === CHATROOM_COMMAND_ROOM_RENAME) {
      const input = context.arguments as Readonly<Record<string, unknown>>;
      if (Object.keys(input).length === 2
        && typeof input.title === 'string'
        && room.title === input.title.trim()) {
        return result(collectionId, itemId, actionId, 'rejected', 'title-unchanged');
      }
    }
    const appliedCode = appliedCodeFor(command, room);
    try {
      await handle(context);
      return result(
        collectionId,
        itemId,
        actionId,
        'applied',
        appliedCode,
        coordinator.currentRevision(),
      );
    } catch (error) {
      if (error instanceof ChatroomRoomManagementError) {
        return result(collectionId, itemId, actionId, 'rejected', error.code);
      }
      if (error instanceof ChatroomRoomStoreError) {
        return error.code === 'conflict'
          ? result(collectionId, itemId, actionId, 'conflict', 'room-store-conflict')
          : result(collectionId, itemId, actionId, 'unavailable', `room-store-${error.code}`);
      }
      return result(collectionId, itemId, actionId, 'unavailable', 'room-operation-failed');
    }
  };
}
