import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { apply, inject, manifest } from '../dist/chatroom.js';

test('exports a normal CordisX plugin module', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'chatroom');
  assert.deepEqual(manifest.capabilities.map(item => item.name), [
    'tasks.create', 'tasks.content.read', 'turns.submit', 'turns.introduce', 'approvals.decide',
  ]);
  assert.equal(manifest.capabilities.every(item => item.required === true), true);
  assert.deepEqual(inject, [
    'i18n', 'commands', 'pages', 'routes', 'slots', 'agentConversationShell', 'agentLoop', 'documents',
  ]);
  assert.equal(typeof apply, 'function');
});

test('keeps the static package manifest on the exact minimal runtime capability set', () => {
  const packageManifest = JSON.parse(readFileSync(
    new URL('../cordisx-package.json', import.meta.url), 'utf8',
  ));
  const staticCapabilities = packageManifest.runtimeManifest.capabilities;
  assert.deepEqual(staticCapabilities, manifest.capabilities);
  assert.deepEqual(staticCapabilities.map(item => item.name), [
    'tasks.create', 'tasks.content.read', 'turns.submit', 'turns.introduce', 'approvals.decide',
  ]);
  assert.equal(staticCapabilities.every(item => item.required === true), true);
  assert.equal(staticCapabilities.some(item => item.name.includes('*')), false);
  assert.equal(new Set(staticCapabilities.map(item => item.name)).size, staticCapabilities.length);
});
