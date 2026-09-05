import type {
  CordisXCommands,
  CordisXI18n,
  CordisXLocalizedText,
  CordisXManagerContentNavigationDeclarationV2,
  CordisXManagerContentNavigationDeclarationV5,
  CordisXPageMetadataV3,
  CordisXPages,
  CordisXRouteDefinitionV2,
  CordisXRoutes,
  CordisXSlots,
} from 'cordisx/contracts';
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
} from 'cordisx/contracts';

import { createChatroomManagerCollectionPage } from './manager-pages.js';
import { ChatroomProductBase } from './product-base.js';
import { CHATROOM_COMMAND_ROOM_DELETE } from './room-management.js';
import {
  CHATROOM_MANAGER_ARCHIVED_REGISTRATION,
  CHATROOM_MANAGER_I18N_NAMESPACE,
  CHATROOM_MANAGER_ROOMS_REGISTRATION,
  ChatroomRoomManagerCollectionSource,
  ChatroomRoomManagerCoordinator,
  createChatroomManagerCommandHandler,
} from './room-manager-collection.js';

export type ChatroomManagerMessages = {
  'manager.navigation.title': undefined;
  'manager.navigation.description': undefined;
  'manager.page.title': undefined;
  'manager.page.rooms.description': undefined;
  'manager.page.archived.description': undefined;
  'manager.page.settings.description': undefined;
  'manager.tab.rooms': undefined;
  'manager.tab.archived': undefined;
  'manager.tab.settings': undefined;
  'manager.collection.rooms.label': undefined;
  'manager.collection.rooms.description': undefined;
  'manager.collection.rooms.empty.title': undefined;
  'manager.collection.rooms.empty.description': undefined;
  'manager.collection.archived.label': undefined;
  'manager.collection.archived.description': undefined;
  'manager.collection.archived.empty.title': undefined;
  'manager.collection.archived.empty.description': undefined;
  'manager.search.label': undefined;
  'manager.search.placeholder': undefined;
  'manager.search.no-match.title': undefined;
  'manager.search.no-match.description': undefined;
  'manager.room.title': { readonly title: string; };
  'navigation.rooms': undefined;
  'navigation.room.title': { readonly title: string; };
  'navigation.room.empty': undefined;
  'navigation.room.summary': { readonly summary: string; };
  'action.pin': undefined;
  'action.unpin': undefined;
  'action.archive': undefined;
  'action.restore': undefined;
  'action.delete': undefined;
  'confirmation.delete.title': undefined;
  'confirmation.delete.description': undefined;
  'confirmation.delete.confirm': undefined;
  'feedback.pinned': undefined;
  'feedback.unpinned': undefined;
  'feedback.pin-failed': undefined;
  'feedback.archived': undefined;
  'feedback.archive-failed': undefined;
  'feedback.restored': undefined;
  'feedback.restore-failed': undefined;
  'feedback.deleted': undefined;
  'feedback.delete-failed': undefined;
  'manager.action.rename': undefined;
  'manager.action.pin': undefined;
  'manager.action.unpin': undefined;
  'manager.action.archive': undefined;
  'manager.action.restore': undefined;
  'manager.action.delete': undefined;
  'manager.rename.title': undefined;
  'manager.rename.description': undefined;
  'manager.rename.label': undefined;
  'manager.rename.submit': undefined;
  'manager.delete.title': undefined;
  'manager.delete.description': undefined;
  'manager.delete.confirm': undefined;
  'manager.feedback.renamed': undefined;
  'manager.feedback.rename-failed': undefined;
  'manager.feedback.pinned': undefined;
  'manager.feedback.unpinned': undefined;
  'manager.feedback.pin-failed': undefined;
  'manager.feedback.archived': undefined;
  'manager.feedback.archive-failed': undefined;
  'manager.feedback.restored': undefined;
  'manager.feedback.restore-failed': undefined;
  'manager.feedback.deleted': undefined;
  'manager.feedback.delete-failed': undefined;
};

export const chatroomManagerMessage = (
  key: keyof ChatroomManagerMessages,
  fallback: string,
): CordisXLocalizedText => ({
  namespace: CHATROOM_MANAGER_I18N_NAMESPACE,
  key,
  fallback,
});

const message = chatroomManagerMessage;

export const CHATROOM_MANAGER_ROOMS_ROUTE_ID = 'manager-chat-rooms' as const;
export const CHATROOM_MANAGER_ARCHIVED_ROUTE_ID = 'manager-chat-archived' as const;
export const CHATROOM_MANAGER_SETTINGS_ROUTE_ID = 'manager-chat-settings' as const;

const roomsPage = Object.freeze(
  {
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: CHATROOM_MANAGER_ROOMS_ROUTE_ID,
    title: message('manager.page.title', 'Manage chats'),
    description: message('manager.page.rooms.description', 'Manage active chats.'),
    icon: 'host:chat',
    chrome: 'standard',
  } as const satisfies CordisXPageMetadataV3,
);

const archivedPage = Object.freeze(
  {
    ...roomsPage,
    id: CHATROOM_MANAGER_ARCHIVED_ROUTE_ID,
    description: message('manager.page.archived.description', 'Find, restore, or delete archived chats.'),
    icon: 'host:archive',
  } as const satisfies CordisXPageMetadataV3,
);

const settingsPage = Object.freeze(
  {
    ...roomsPage,
    id: CHATROOM_MANAGER_SETTINGS_ROUTE_ID,
    description: message('manager.page.settings.description', 'Choose how the Room composer sends messages.'),
    icon: 'host:settings',
  } as const satisfies CordisXPageMetadataV3,
);

const roomsRoute = Object.freeze(
  {
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: CHATROOM_MANAGER_ROOMS_ROUTE_ID,
    path: '/manager/extensions/chatroom/rooms',
    outlet: 'manager.content',
    page: CHATROOM_MANAGER_ROOMS_ROUTE_ID,
    title: message('manager.navigation.title', 'Manage chats'),
    description: message(
      'manager.navigation.description',
      'Search, organize, archive, restore, and delete Chatroom rooms.',
    ),
  } as const satisfies CordisXRouteDefinitionV2<'manager.content'>,
);

const archivedRoute = Object.freeze(
  {
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: CHATROOM_MANAGER_ARCHIVED_ROUTE_ID,
    path: '/manager/extensions/chatroom/archived',
    outlet: 'manager.content',
    page: CHATROOM_MANAGER_ARCHIVED_ROUTE_ID,
    title: message('manager.tab.archived', 'Archived'),
    description: message('manager.page.archived.description', 'Find, restore, or delete archived chats.'),
  } as const satisfies CordisXRouteDefinitionV2<'manager.content'>,
);

const settingsRoute = Object.freeze(
  {
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: CHATROOM_MANAGER_SETTINGS_ROUTE_ID,
    path: '/manager/extensions/chatroom/settings',
    outlet: 'manager.content',
    page: CHATROOM_MANAGER_SETTINGS_ROUTE_ID,
    title: message('manager.tab.settings', 'Settings'),
    description: message('manager.page.settings.description', 'Choose how the Room composer sends messages.'),
  } as const satisfies CordisXRouteDefinitionV2<'manager.content'>,
);

const tabs = Object.freeze([
  Object.freeze({
    id: 'rooms',
    route: { id: CHATROOM_MANAGER_ROOMS_ROUTE_ID },
    label: message('manager.tab.rooms', 'Rooms'),
  }),
  Object.freeze({
    id: 'archived',
    route: { id: CHATROOM_MANAGER_ARCHIVED_ROUTE_ID },
    label: message('manager.tab.archived', 'Archived'),
  }),
  Object.freeze({
    id: 'settings',
    route: { id: CHATROOM_MANAGER_SETTINGS_ROUTE_ID },
    label: message('manager.tab.settings', 'Settings'),
  }),
]);

export const CHATROOM_MANAGER_CONTENT_DECLARATIONS: readonly (
  CordisXManagerContentNavigationDeclarationV2 | CordisXManagerContentNavigationDeclarationV5
)[] = Object.freeze([
  Object.freeze(
    {
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
      schemaVersion: 2,
      id: 'rooms',
      route: { id: CHATROOM_MANAGER_ROOMS_ROUTE_ID },
      header: { title: { kind: 'route' } },
      tabs,
    } satisfies CordisXManagerContentNavigationDeclarationV2,
  ),
  Object.freeze(
    {
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
      schemaVersion: 2,
      id: 'archived',
      route: { id: CHATROOM_MANAGER_ARCHIVED_ROUTE_ID },
      header: { title: { kind: 'route' } },
      tabs,
    } satisfies CordisXManagerContentNavigationDeclarationV2,
  ),
  Object.freeze(
    {
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
      schemaVersion: 5,
      id: 'settings',
      route: { id: CHATROOM_MANAGER_SETTINGS_ROUTE_ID },
      header: { title: { kind: 'route' } },
      tabs,
      body: {
        kind: 'plugin-config-form',
        namespace: 'chatroom',
        defaultMaterialization: {
          mode: 'missing-only',
          fields: [{ path: ['shortcutPolicy'], value: 'enter' }],
        },
      },
    } satisfies CordisXManagerContentNavigationDeclarationV5,
  ),
]);

const english: Readonly<Record<keyof ChatroomManagerMessages, string>> = Object.freeze({
  'manager.navigation.title': 'Manage chats',
  'manager.navigation.description': 'Search, organize, archive, restore, and delete Chatroom rooms.',
  'manager.page.title': 'Manage chats',
  'manager.page.rooms.description': 'Manage active chats.',
  'manager.page.archived.description': 'Find, restore, or delete archived chats.',
  'manager.page.settings.description': 'Choose how the Room composer sends messages.',
  'manager.tab.rooms': 'Rooms',
  'manager.tab.archived': 'Archived',
  'manager.tab.settings': 'Settings',
  'manager.collection.rooms.label': 'Rooms',
  'manager.collection.rooms.description': 'Manage active chats.',
  'manager.collection.rooms.empty.title': 'No rooms yet',
  'manager.collection.rooms.empty.description': 'Rooms appear here after they are created.',
  'manager.collection.archived.label': 'Archived',
  'manager.collection.archived.description': 'Find and restore archived chats.',
  'manager.collection.archived.empty.title': 'No archived rooms',
  'manager.collection.archived.empty.description': 'Rooms you archive appear here.',
  'manager.search.label': 'Search chats',
  'manager.search.placeholder': 'Search titles and messages',
  'manager.search.no-match.title': 'No matching chats',
  'manager.search.no-match.description': 'Try another title or public message summary.',
  'manager.room.title': '{title}',
  'navigation.rooms': 'Chats',
  'navigation.room.title': '{title}',
  'navigation.room.empty': 'No messages yet',
  'navigation.room.summary': '{summary}',
  'action.pin': 'Pin',
  'action.unpin': 'Unpin',
  'action.archive': 'Archive',
  'action.restore': 'Restore',
  'action.delete': 'Delete',
  'confirmation.delete.title': 'Delete this room?',
  'confirmation.delete.description': 'Messages and room state will be permanently deleted.',
  'confirmation.delete.confirm': 'Delete room',
  'feedback.pinned': 'Room pinned',
  'feedback.unpinned': 'Room unpinned',
  'feedback.pin-failed': 'Could not update pin',
  'feedback.archived': 'Room archived',
  'feedback.archive-failed': 'Could not archive room',
  'feedback.restored': 'Room restored',
  'feedback.restore-failed': 'Could not restore room',
  'feedback.deleted': 'Room deleted',
  'feedback.delete-failed': 'Could not delete room',
  'manager.action.rename': 'Rename',
  'manager.action.pin': 'Pin',
  'manager.action.unpin': 'Unpin',
  'manager.action.archive': 'Archive',
  'manager.action.restore': 'Restore',
  'manager.action.delete': 'Delete',
  'manager.rename.title': 'Rename chat',
  'manager.rename.description': 'Choose a clear title for this chat.',
  'manager.rename.label': 'Chat title',
  'manager.rename.submit': 'Rename',
  'manager.delete.title': 'Delete this room?',
  'manager.delete.description': 'Messages and room state will be permanently deleted.',
  'manager.delete.confirm': 'Delete room',
  'manager.feedback.renamed': 'Chat renamed',
  'manager.feedback.rename-failed': 'Could not rename chat',
  'manager.feedback.pinned': 'Room pinned',
  'manager.feedback.unpinned': 'Room unpinned',
  'manager.feedback.pin-failed': 'Could not update pin',
  'manager.feedback.archived': 'Room archived',
  'manager.feedback.archive-failed': 'Could not archive room',
  'manager.feedback.restored': 'Room restored',
  'manager.feedback.restore-failed': 'Could not restore room',
  'manager.feedback.deleted': 'Room deleted',
  'manager.feedback.delete-failed': 'Could not delete room',
});

const simplifiedChinese: Readonly<Record<keyof ChatroomManagerMessages, string>> = Object.freeze({
  'manager.navigation.title': '管理聊天',
  'manager.navigation.description': '搜索、整理、归档、恢复或删除聊天房间。',
  'manager.page.title': '管理聊天',
  'manager.page.rooms.description': '管理活跃聊天。',
  'manager.page.archived.description': '查找、恢复或删除已归档聊天。',
  'manager.page.settings.description': '选择在房间输入框中发送消息的方式。',
  'manager.tab.rooms': '房间',
  'manager.tab.archived': '已归档',
  'manager.tab.settings': '设置',
  'manager.collection.rooms.label': '房间',
  'manager.collection.rooms.description': '管理活跃聊天。',
  'manager.collection.rooms.empty.title': '暂无房间',
  'manager.collection.rooms.empty.description': '创建房间后会显示在这里。',
  'manager.collection.archived.label': '已归档',
  'manager.collection.archived.description': '查找和恢复已归档聊天。',
  'manager.collection.archived.empty.title': '暂无已归档房间',
  'manager.collection.archived.empty.description': '归档的房间会显示在这里。',
  'manager.search.label': '搜索聊天',
  'manager.search.placeholder': '搜索标题和消息',
  'manager.search.no-match.title': '没有匹配的聊天',
  'manager.search.no-match.description': '请尝试其他标题或公开消息摘要。',
  'manager.room.title': '{title}',
  'navigation.rooms': '聊天',
  'navigation.room.title': '{title}',
  'navigation.room.empty': '暂无消息',
  'navigation.room.summary': '{summary}',
  'action.pin': '置顶',
  'action.unpin': '取消置顶',
  'action.archive': '归档',
  'action.restore': '恢复',
  'action.delete': '删除',
  'confirmation.delete.title': '删除这个房间？',
  'confirmation.delete.description': '消息和房间状态将被永久删除。',
  'confirmation.delete.confirm': '删除房间',
  'feedback.pinned': '已置顶房间',
  'feedback.unpinned': '已取消置顶',
  'feedback.pin-failed': '无法更新置顶状态',
  'feedback.archived': '已归档房间',
  'feedback.archive-failed': '无法归档房间',
  'feedback.restored': '已恢复房间',
  'feedback.restore-failed': '无法恢复房间',
  'feedback.deleted': '已删除房间',
  'feedback.delete-failed': '无法删除房间',
  'manager.action.rename': '重命名',
  'manager.action.pin': '置顶',
  'manager.action.unpin': '取消置顶',
  'manager.action.archive': '归档',
  'manager.action.restore': '恢复',
  'manager.action.delete': '删除',
  'manager.rename.title': '重命名聊天',
  'manager.rename.description': '为这个聊天选择一个清晰的标题。',
  'manager.rename.label': '聊天标题',
  'manager.rename.submit': '重命名',
  'manager.delete.title': '删除这个房间？',
  'manager.delete.description': '消息和房间状态将被永久删除。',
  'manager.delete.confirm': '删除房间',
  'manager.feedback.renamed': '已重命名聊天',
  'manager.feedback.rename-failed': '无法重命名聊天',
  'manager.feedback.pinned': '已置顶房间',
  'manager.feedback.unpinned': '已取消置顶',
  'manager.feedback.pin-failed': '无法更新置顶状态',
  'manager.feedback.archived': '已归档房间',
  'manager.feedback.archive-failed': '无法归档房间',
  'manager.feedback.restored': '已恢复房间',
  'manager.feedback.restore-failed': '无法恢复房间',
  'manager.feedback.deleted': '已删除房间',
  'manager.feedback.delete-failed': '无法删除房间',
});

export interface ChatroomManagerIntegrationContext {
  readonly i18n: CordisXI18n;
  readonly commands: CordisXCommands;
  readonly pages: CordisXPages;
  readonly routes: CordisXRoutes;
  readonly slots: CordisXSlots;
}

export interface ChatroomManagerIntegrationHandle {
  readonly product: ChatroomProductBase;
  dispose(): void;
}

/**
 * Integrator handoff for the Chatroom runtime owner. Host chrome and every
 * collection control remain outside this product-owned registration bundle.
 */
export async function registerChatroomManager(
  context: ChatroomManagerIntegrationContext,
  product: ChatroomProductBase,
): Promise<ChatroomManagerIntegrationHandle> {
  const coordinator = new ChatroomRoomManagerCoordinator(product.store);
  const disposers: Array<() => void> = [];
  let disposed = false;
  const retain = (dispose: () => void | Promise<void>): void => {
    disposers.push(() => {
      void dispose();
    });
  };
  try {
    retain(context.i18n.define<ChatroomManagerMessages>({
      namespace: CHATROOM_MANAGER_I18N_NAMESPACE,
      locale: 'en',
      default: true,
      messages: english,
    }));
    retain(context.i18n.define<ChatroomManagerMessages>({
      namespace: CHATROOM_MANAGER_I18N_NAMESPACE,
      locale: 'zh-CN',
      messages: simplifiedChinese,
    }));

    for (const registration of product.managementCommands) {
      const managerCommand = createChatroomManagerCommandHandler(
        coordinator,
        registration.id,
        registration.handle,
      );
      retain(context.commands.register({
        id: registration.id,
        title: message(
          `manager.action.${registration.id.slice('room.'.length)}` as keyof ChatroomManagerMessages,
          registration.id.slice('room.'.length),
        ),
      }, async commandContext => {
        const result = await managerCommand(commandContext);
        const hostContext = commandContext.hostContext;
        if (
          registration.id === CHATROOM_COMMAND_ROOM_DELETE
          && result.status === 'applied'
          && hostContext !== undefined
          && 'pointId' in hostContext
          && hostContext.pointId === 'sidebar.navigation.items'
        ) {
          await context.routes.navigate({ id: 'new-room' });
        }
        return result;
      }));
    }

    retain(context.pages.register<ChatroomManagerMessages>(
      roomsPage,
      createChatroomManagerCollectionPage(
        CHATROOM_MANAGER_ROOMS_REGISTRATION,
        () => new ChatroomRoomManagerCollectionSource(coordinator, 'active'),
      ),
    ));
    retain(context.pages.register<ChatroomManagerMessages>(
      archivedPage,
      createChatroomManagerCollectionPage(
        CHATROOM_MANAGER_ARCHIVED_REGISTRATION,
        () => new ChatroomRoomManagerCollectionSource(coordinator, 'archived'),
      ),
    ));
    // Navigation v5 replaces this metadata seat before the mount is called;
    // Chatroom deliberately contributes no settings body or form renderer.
    retain(context.pages.register<ChatroomManagerMessages>(settingsPage, () => undefined));

    retain(context.routes.register(roomsRoute));
    retain(context.routes.register(archivedRoute));
    retain(context.routes.register(settingsRoute));
    const navigation = context.slots.register({
      name: 'manager.settings.navigation-items',
      id: 'manage-chats',
      group: 'after-settings',
      order: 160,
    }, {
      route: { id: CHATROOM_MANAGER_ROOMS_ROUTE_ID },
    });
    disposers.push(() => navigation.dispose());
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    coordinator.dispose();
    throw error;
  }

  return Object.freeze({
    product,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) dispose();
      coordinator.dispose();
    },
  });
}
