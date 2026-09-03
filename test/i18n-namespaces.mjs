import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps base Chatroom and Manager catalogs in independent namespaces', async () => {
  const chatroom = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../src/manager-chat.ts', import.meta.url), 'utf8');
  const collection = await readFile(new URL('../src/room-manager-collection.ts', import.meta.url), 'utf8');

  assert.match(chatroom, /namespace: 'chatroom',[\s\S]*?'navigation\.title': '新建房间'/u);
  assert.doesNotMatch(manager, /namespace: 'chatroom'/u);
  assert.match(collection, /CHATROOM_MANAGER_I18N_NAMESPACE = 'chatroom-manager'/u);
  assert.equal(
    (manager.match(/namespace: CHATROOM_MANAGER_I18N_NAMESPACE/gu) ?? []).length,
    3,
  );
  assert.equal(
    (collection.match(/namespace: CHATROOM_MANAGER_I18N_NAMESPACE/gu) ?? []).length,
    1,
  );
});
