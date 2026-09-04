import type {
  CordisXCommandContext,
  CordisXOwnerDocumentsV1,
} from 'cordisx/contracts';

import {
  CHATROOM_COMMAND_ROOM_ARCHIVE,
  CHATROOM_COMMAND_ROOM_DELETE,
  CHATROOM_COMMAND_ROOM_PIN,
  CHATROOM_COMMAND_ROOM_RENAME,
  CHATROOM_COMMAND_ROOM_RESTORE,
  createRoomManagementHandler,
  type ChatroomRoomManagementCommand,
} from './room-management.js';
import { ChatroomRoomNavigationCollection } from './room-navigation.js';
import { DurableChatroomRoomStore } from './room-store.js';
import { ChatroomSidebarImageCache } from './sidebar-image-cache.js';

export interface ChatroomRoomManagementRegistration {
  readonly id: ChatroomRoomManagementCommand;
  readonly handle: (context: CordisXCommandContext) => Promise<void>;
}

/**
 * Host-neutral product base shared by room navigation and management consumers.
 * It owns no page, route, DOM, or runtime simulation projection.
 */
export class ChatroomProductBase {
  readonly sidebarImages: ChatroomSidebarImageCache;
  readonly activeRooms: ChatroomRoomNavigationCollection;
  readonly archivedRooms: ChatroomRoomNavigationCollection;
  readonly managementCommands: readonly ChatroomRoomManagementRegistration[];
  private disposed = false;

  private constructor(readonly store: DurableChatroomRoomStore) {
    this.sidebarImages = new ChatroomSidebarImageCache();
    this.activeRooms = new ChatroomRoomNavigationCollection(store.rooms, 'active', this.sidebarImages);
    this.archivedRooms = new ChatroomRoomNavigationCollection(store.rooms, 'archived', this.sidebarImages);
    this.managementCommands = Object.freeze(([
      CHATROOM_COMMAND_ROOM_PIN,
      CHATROOM_COMMAND_ROOM_RENAME,
      CHATROOM_COMMAND_ROOM_ARCHIVE,
      CHATROOM_COMMAND_ROOM_RESTORE,
      CHATROOM_COMMAND_ROOM_DELETE,
    ] as const).map(id => Object.freeze({ id, handle: createRoomManagementHandler(store, id) })));
  }

  static async open(documents: CordisXOwnerDocumentsV1): Promise<ChatroomProductBase> {
    return new ChatroomProductBase(await DurableChatroomRoomStore.openOwnerDocuments(documents));
  }

  /** Attach product projections to the runtime's single authoritative Room store. */
  static attach(store: DurableChatroomRoomStore): ChatroomProductBase {
    return new ChatroomProductBase(store);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRooms.dispose();
    this.archivedRooms.dispose();
    this.sidebarImages.dispose();
    this.store.dispose();
  }
}
