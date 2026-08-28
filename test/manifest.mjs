import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(
  await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'),
);

test('declares a host-neutral Chatroom plugin', () => {
  assert.equal(manifest.id, 'org.cordisx.chatroom');
  assert.equal(manifest.name, 'Chatroom');
  assert.deepEqual(manifest.capabilities, [
    'room.presentation',
    'message.ingress',
    'message.egress',
  ]);
  assert.equal(JSON.stringify(manifest).toLowerCase().includes('codex'), false);
});
