import { CHATROOM_SESSION_DETAIL_ROUTE } from './routes.js';

/** Host-neutral Chatroom consumer surface. */
export const chatroomPlugin = {
  id: 'org.cordisx.chatroom',
  name: 'Chatroom',
  version: '0.1.0',
  routes: Object.freeze([CHATROOM_SESSION_DETAIL_ROUTE]),
} as const;

export * from './agent-definition.js';
export * from './agent-session-controller.js';
export * from './chatroom.js';
export * from './conversation-source.js';
export * from './engagement-config.js';
export * from './room.js';
export * from './room-store.js';
export * from './room-target.js';
export * from './routes.js';
export * from './session-presentation.js';
export * from './manager-chat.js';
export * from './product-base.js';
export * from './room-management.js';
export * from './room-manager-collection.js';
export * from './room-navigation.js';
export * from './talent-market-locales.js';
export * from './talent-market-page.js';
export * from './team-architecture-navigation.js';
export * from './team-architecture-page.js';
export * from './team-entity-view-model.js';
