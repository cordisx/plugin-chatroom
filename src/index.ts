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
export * from './engagement-config.js';
export * from './room.js';
export * from './room-store.js';
export * from './room-target.js';
export * from './routes.js';
