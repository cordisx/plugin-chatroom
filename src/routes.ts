import type { AgentDetailReference } from '@cordisx/protocol/agents/v1';

/**
 * Same-plugin Host route used by deferred Session permission declarations.
 * The Host alone resolves `sessionId` from the active route instance and
 * authorizes the exact runtime scope `{ sessionIds: [id] }`.
 */
export const CHATROOM_SESSION_DETAIL_ROUTE = Object.freeze({
  id: 'room-session-detail',
  path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
  param: 'sessionId',
  detail: Object.freeze({
    kind: 'host', ref: 'chatroom.room-session-detail',
  } satisfies AgentDetailReference),
} as const);
