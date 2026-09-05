import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { manifest, roomSessionDetailRoute } from '../dist/chatroom.js';

const exactApprovalScope = {
  sessionIds: {
    kind: 'host-route-param',
    routeId: 'room-session-detail',
    param: 'sessionId',
  },
};

const authorityRequesterScope = {
  authorityRequester: {
    kind: 'approval-authority-requester-route',
    requester: exactApprovalScope.sessionIds,
  },
};

test('publishes v8 package and source manifests with correlated Lead authority route', () => {
  const packageManifest = JSON.parse(readFileSync(
    new URL('../cordisx-package.json', import.meta.url),
    'utf8',
  ));
  const runtimeManifest = JSON.parse(readFileSync(
    new URL(`../${packageManifest.runtimeManifest.path.slice(2)}`, import.meta.url),
    'utf8',
  ));
  const staticCapabilities = runtimeManifest.capabilities;
  assert.equal(packageManifest.schemaVersion, 8);
  assert.equal(runtimeManifest.schemaVersion, 8);
  assert.equal(
    packageManifest.runtimeManifest.schema,
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json',
  );
  assert.deepEqual(staticCapabilities.map(item => item.name), [
    'agents.create',
    'agents.resume',
    'agents.get',
    'agents.message.submit',
    'agents.message.cancel',
    'sessions.get',
    'sessions.subscribe',
    'approvals.request',
    'approvals.answer',
  ]);
  assert.equal(staticCapabilities.slice(0, 7).every(item => item.required === true), true);
  assert.deepEqual(staticCapabilities.slice(7), [
    { name: 'approvals.request', required: false, scope: exactApprovalScope },
    { name: 'approvals.answer', required: false, scope: authorityRequesterScope },
  ]);
  assert.equal(staticCapabilities.some(item => item.name.includes('*')), false);
  assert.equal(new Set(staticCapabilities.map(item => item.name)).size, staticCapabilities.length);
  assert.deepEqual(runtimeManifest.services, []);
  assert.deepEqual(manifest, runtimeManifest);
});

test('keeps the ordinary Room route distinct from the exact Host-owned Session authority route', () => {
  assert.deepEqual(roomSessionDetailRoute, {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json',
    schemaVersion: 2,
    id: 'room-session-detail',
    path: '/main/chatroom/:roomId/session/:sessionId',
    outlet: 'main',
    page: 'room',
    title: { namespace: 'chatroom', key: 'route.title', fallback: 'New room' },
    description: { namespace: 'chatroom', key: 'route.description', fallback: 'Create or open a collaboration Room.' },
  });
  assert.equal((roomSessionDetailRoute.path.match(/:sessionId/gu) ?? []).length, 1);
  assert.equal(roomSessionDetailRoute.path.includes('*'), false);
  assert.equal(roomSessionDetailRoute.path, '/main/chatroom/:roomId/session/:sessionId');
});
