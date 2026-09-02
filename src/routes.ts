import type { AgentDetailReference } from '@cordisx/protocol/agents/v1';
import {
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXRouteDefinitionV2,
} from 'cordisx/contracts';

export const CHATROOM_ROOM_PAGE_ID = 'chatroom-room' as const;

/**
 * Same-plugin Host route used by deferred Session permission declarations.
 * The Host alone resolves `sessionId` from the active route instance and
 * authorizes the exact runtime scope `{ sessionIds: [id] }`.
 */
export const CHATROOM_SESSION_DETAIL_ROUTE = Object.freeze({
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'room-session-detail',
  path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
  outlet: 'main',
  page: CHATROOM_ROOM_PAGE_ID,
  title: {
    namespace: 'chatroom',
    key: 'page.title',
    fallback: 'Chatroom',
  },
  description: {
    namespace: 'chatroom',
    key: 'route.description',
    fallback: 'Open an exact Room Agent session.',
  },
  param: 'sessionId',
  detail: Object.freeze({
    kind: 'host', ref: 'chatroom.room-session-detail',
  } satisfies AgentDetailReference),
} as const satisfies CordisXRouteDefinitionV2<'main'> & {
  readonly param: 'sessionId';
  readonly detail: AgentDetailReference;
});
