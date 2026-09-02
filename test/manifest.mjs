import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chatroomPlugin } from '../dist/index.js';
import { CHATROOM_SESSION_DETAIL_ROUTE } from '../dist/routes.js';

const manifestText = await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText);
const packageManifest = JSON.parse(
  await readFile(new URL('../cordisx-package.json', import.meta.url), 'utf8'),
);
const npmPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('declares v5 dynamic Session scopes bound to the same-plugin detail route', () => {
  assert.equal(manifest.id, 'org.cordisx.chatroom');
  assert.equal(manifest.name, 'Chatroom');
  assert.equal(manifest.schemaVersion, 5);
  assert.deepEqual(manifest.services, []);
  const routeBound = manifest.capabilities.filter(capability => capability.name !== 'agents.create');
  assert.equal(routeBound.length, 10);
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

test('packages the activatable entry with an exact neutral Protocol dependency and manifest digest', () => {
  assert.equal(packageManifest.id, 'org.cordisx.chatroom');
  assert.equal(packageManifest.entry, './dist/chatroom.js');
  assert.equal(packageManifest.runtimeManifest.path, './plugin/manifest.json');
  assert.equal(packageManifest.runtimeManifest.digest,
    `sha256:${createHash('sha256').update(manifestText).digest('hex')}`);
  assert.equal(npmPackage.dependencies['@cordisx/protocol'],
    'github:cordisx/cordisx-protocol#d1b3486df18034bb5aecde090b3bd1b29b2c55d8');
});
