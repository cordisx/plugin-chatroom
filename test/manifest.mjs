import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chatroomPlugin } from '../dist/index.js';
import { CHATROOM_SESSION_DETAIL_ROUTE } from '../dist/routes.js';

const manifest = JSON.parse(
  await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'),
);

test('declares v5 dynamic Session scopes bound to the same-plugin detail route', () => {
  assert.equal(manifest.id, 'org.cordisx.chatroom');
  assert.equal(manifest.name, 'Chatroom');
  assert.equal(manifest.schemaVersion, 5);
  assert.deepEqual(manifest.services, []);
  const routeBound = manifest.capabilities.filter(capability => capability.name !== 'agents.create');
  assert.equal(routeBound.length, 9);
  for (const capability of routeBound) {
    assert.equal(capability.required, false);
    assert.deepEqual(capability.scope.sessionIds, {
      kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId',
    });
  }
  assert.equal(JSON.stringify(manifest).includes('"*"'), false);
  assert.equal(JSON.stringify(manifest).includes('"sessionIds":[]'), false);
  assert.equal(CHATROOM_SESSION_DETAIL_ROUTE.id, 'room-session-detail');
  assert.match(CHATROOM_SESSION_DETAIL_ROUTE.path, /:sessionId/);
  assert.equal(CHATROOM_SESSION_DETAIL_ROUTE.param, 'sessionId');
  assert.deepEqual(CHATROOM_SESSION_DETAIL_ROUTE.detail, {
    kind: 'host', ref: 'chatroom.room-session-detail',
  });
  assert.equal(chatroomPlugin.routes[0], CHATROOM_SESSION_DETAIL_ROUTE);
  assert.equal(JSON.stringify(manifest).toLowerCase().includes('codex'), false);
});
