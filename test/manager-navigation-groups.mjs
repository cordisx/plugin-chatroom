import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('declares exact v9 Manager navigation groups for all Chatroom destinations', async () => {
  const [manager, team, talent] = await Promise.all([
    readFile(new URL('../src/manager-chat.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-navigation.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/talent-market-page.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of [manager, team, talent]) {
    assert.match(source, /CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9/u);
    assert.match(source, /\$schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,[\s\S]*?schemaVersion: 9/u);
  }
  assert.match(manager, /id: 'manage-chats'[\s\S]*?navigationGroup: \{ id: 'collaboration' \}/u);
  assert.match(
    team,
    /id: 'team-architecture'[\s\S]*?navigationGroup: Object\.freeze\(\{ id: 'collaboration' as const \}\)/u,
  );
  assert.match(talent, /id: TALENT_MARKET_NAVIGATION_ID[\s\S]*?navigationGroup: \{ id: 'resources' \}/u);
});
