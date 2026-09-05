import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const source = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('registers one plugin-owned lazy React Room page through public CordisX modules', async () => {
  const [entry, loader, page, pageSource, css] = await Promise.all([
    source('src/chatroom.ts'),
    source('src/chatroom-page-loader.tsx'),
    source('src/chatroom-page.tsx'),
    source('src/chatroom-page-source.ts'),
    source('src/chatroom-page.css'),
  ]);

  assert.match(entry, /ctx\.pages\.register\(page, createLazyChatroomPage\(pageSource, product\.sidebarImages\)\)/u);
  assert.match(entry, /chrome: 'body-only'/u);
  assert.doesNotMatch(entry, /from '\.\/chatroom-page\.js'/u);
  assert.match(loader, /import\('\.\/chatroom-page\.js'\)/u);
  assert.match(loader, /loadModuleOnce/u);
  assert.match(loader, /lazy\(/u);
  assert.match(loader, /<Suspense fallback=\{null\}>/u);
  assert.match(loader, /defineReactPage/u);
  assert.match(page, /from 'cordisx\/react'/u);
  assert.match(page, /from 'cordisx\/ui'/u);
  assert.doesNotMatch(page, /defineReactPage/u);
  assert.match(page, /export function ChatroomPage/u);
  assert.match(page, /cx-chatroom-header/u);
  assert.match(page, /cx-chatroom-timeline/u);
  assert.match(page, /cx-chatroom-members/u);
  assert.match(page, /cx-chatroom-composer/u);
  assert.match(page, /ChatroomAvatar/u);
  assert.match(page, /ChatroomCompositeAvatar/u);
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.doesNotMatch(
    `${entry}\n${page}\n${pageSource}`,
    /ctx\.visuals|agentConversationShell|AgentConversationRenderer|renderer\/host-ui|data-cordisx-app-theme/u,
  );
});

test('preserves direct Agent Session delivery, replay, approval and first-message ordering', async () => {
  const [entry, page, pageSource, sessions] = await Promise.all([
    source('src/chatroom.ts'),
    source('src/chatroom-page.tsx'),
    source('src/chatroom-page-source.ts'),
    source('src/agent-session-controller.ts'),
  ]);

  assert.match(entry, /await agentSession\.hydrate\(\)/u);
  assert.match(pageSource, /sessions\.projectionForRoom/u);
  assert.match(pageSource, /sessions\.hydrateRoom/u);
  assert.match(pageSource, /sessions\.sendToRoom/u);
  assert.match(pageSource, /sessions\.answerApprovalItem/u);
  assert.match(pageSource, /decidePlaygroundAgentApprovalFromRoom/u);
  assert.match(sessions, /SessionEvent remains the durable fact/u);
  assert.ok(
    page.indexOf('await source.submit(roomId, draft)')
      < page.indexOf("await navigation.navigate({ id: 'room'"),
  );
  assert.match(entry, /pageSource\.dispose\(\)/u);
});

test('publishes only completed generic images to sidebar and semantic icons to Manager', async () => {
  const [entry, navigation, cache, manager] = await Promise.all([
    source('src/chatroom.ts'),
    source('src/room-navigation.ts'),
    source('src/sidebar-image-cache.ts'),
    source('src/room-manager-collection.ts'),
  ]);

  assert.match(entry, /cordisx\.navigation-collection\/v3/u);
  assert.match(navigation, /kind: 'image'/u);
  assert.match(navigation, /icon: 'host:layers'/u);
  assert.match(cache, /class ChatroomSidebarImageCache/u);
  assert.match(cache, /generation/u);
  assert.match(cache, /maximumEntries/u);
  assert.doesNotMatch(navigation, /room-composite-avatar|cloneAgentAvatarRef/u);
  assert.match(manager, /kind: 'semantic-icon', icon: 'host:layers'/u);
  assert.doesNotMatch(manager, /avatar-stack|cloneAgentAvatarRef/u);
});

test('pins OneWorks RC.8, defers its React renderer, and rejects a private React bundle', async () => {
  const [packageText, entry, avatar, renderer, build, notices] = await Promise.all([
    source('package.json'),
    source('src/chatroom.ts'),
    source('src/avatar.tsx'),
    source('src/avatar-renderer.tsx'),
    source('scripts/build-runtime-bundle.mjs'),
    source('THIRD_PARTY_NOTICES.md'),
  ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.devDependencies['@oneworks/avatar'], '1.0.0-rc.8');
  assert.equal(packageJson.devDependencies['@oneworks/avatar-react'], '1.0.0-rc.8');
  assert.match(entry, /avatarDevelopmentDependencies/u);
  assert.match(entry, /import\('@oneworks\/avatar-react'\)/u);
  assert.doesNotMatch(avatar, /from '@oneworks\/avatar-react'/u);
  assert.match(avatar, /import\('\.\/avatar-renderer\.js'\)/u);
  assert.match(avatar, /from 'cordisx\/react'/u);
  assert.match(renderer, /from '@oneworks\/avatar-react'/u);
  assert.match(renderer, /from 'cordisx\/react'/u);
  assert.match(build, /private React renderer/u);
  assert.match(build, /MAX_PLUGIN_RUNTIME_MODULE_BYTES = 24 \* 1024 \* 1024/u);
  assert.match(notices, /MIT License/u);
});

test('keeps the built runtime entry within the Host immutable-module ceiling', async () => {
  const metadata = await stat(new URL('../dist/chatroom.js', import.meta.url));
  assert.ok(metadata.size <= 24 * 1024 * 1024, `runtime entry is ${metadata.size} bytes`);
});
