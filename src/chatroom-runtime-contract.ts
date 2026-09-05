import type { PluginRuntimeManifestV8 } from '@cordisx/protocol/plugin-manifest/v8';
import { CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts';

export const manifest = {
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json',
  schemaVersion: 8,
  id: 'chatroom',
  name: 'Chatroom',
  capabilities: [
    { name: 'agents.create', required: true, scope: {} },
    { name: 'agents.resume', required: true, scope: {} },
    { name: 'agents.get', required: true, scope: {} },
    { name: 'agents.message.submit', required: true, scope: {} },
    { name: 'agents.message.cancel', required: true, scope: {} },
    { name: 'sessions.get', required: true, scope: {} },
    { name: 'sessions.subscribe', required: true, scope: {} },
    {
      name: 'approvals.request',
      required: false,
      scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
    },
    {
      name: 'approvals.answer',
      required: false,
      scope: {
        authorityRequester: {
          kind: 'approval-authority-requester-route',
          requester: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' },
        },
      },
    },
  ],
  services: [],
} as const satisfies PluginRuntimeManifestV8;

/** Host-owned exact Session authority route; ordinary Room navigation remains unchanged. */
export const roomSessionDetailRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'room-session-detail',
  path: '/main/chatroom/:roomId/session/:sessionId',
  outlet: 'main',
  page: 'room',
  title: { namespace: 'chatroom', key: 'route.title', fallback: 'New room' },
  description: {
    namespace: 'chatroom',
    key: 'route.description',
    fallback: 'Create or open a collaboration Room.',
  },
} as const;
