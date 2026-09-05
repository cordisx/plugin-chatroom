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
  assert.match(page, /import '\.\/chatroom-page\.css'/u);
  assert.doesNotMatch(page, /data-chatroom-page-styles|CHATROOM_AVATAR_VENDOR_STYLES/u);
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

test('pins OneWorks RC.9 and produces the lazy graph through the public CordisX Vite config', async () => {
  const [packageText, entry, avatar, renderer, viteConfig, verify, notices] = await Promise.all([
    source('package.json'),
    source('src/chatroom.ts'),
    source('src/avatar.tsx'),
    source('src/avatar-renderer.tsx'),
    source('vite.config.mjs'),
    source('scripts/verify-runtime-bundle.mjs'),
    source('THIRD_PARTY_NOTICES.md'),
  ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.devDependencies['@oneworks/avatar'], '1.0.0-rc.9');
  assert.equal(packageJson.devDependencies['@oneworks/avatar-react'], '1.0.0-rc.9');
  assert.match(notices, /abce277ee9a9d846ef6964766d3be8938d787ffc/u);
  assert.match(
    notices,
    /sha512-3EmbF3iWZ9qD9vxFYI0aMzINFoIYG38UIu3ngsK6QfWm6sqZf46e29G\+BX0UiIERQ3ntWNzRun8FA5mpGMQcxw==/u,
  );
  assert.match(
    notices,
    /sha512-HqxGcmweaIyS1ppM\+uJuUJ6NyZWdZnJHGTYyOm385tw21hcYYeFLUqu\+l45D0XtsrPlPRA34h3mYdrgnRmDXUQ==/u,
  );
  assert.match(entry, /avatarDevelopmentDependencies/u);
  assert.match(entry, /import\('@oneworks\/avatar-react\/renderer'\)/u);
  assert.doesNotMatch(avatar, /from '@oneworks\/avatar-react'/u);
  assert.match(avatar, /import\('\.\/avatar-renderer\.js'\)/u);
  assert.match(avatar, /from 'cordisx\/react'/u);
  assert.match(renderer, /from '@oneworks\/avatar-react\/renderer'/u);
  assert.match(renderer, /import '@oneworks\/avatar-react\/renderer\.css'/u);
  assert.doesNotMatch(renderer, /@oneworks\/avatar-react(?:'|\/style\.css)/u);
  assert.match(renderer, /from 'cordisx\/react'/u);
  assert.match(viteConfig, /cordisXPluginViteConfig/u);
  assert.match(viteConfig, /from 'cordisx\/vite'/u);
  assert.match(viteConfig, /outDir: '\.\/dist\/runtime'/u);
  assert.match(viteConfig, /entryFileName: 'chatroom\.js'/u);
  assert.match(verify, /MAX_PLUGIN_RUNTIME_MODULE_BYTES = 24 \* 1024 \* 1024/u);
  assert.match(verify, /MAX_CHATROOM_INITIAL_GRAPH_BYTES = 2 \* 1024 \* 1024/u);
  assert.match(verify, /cordisx\.plugin-generation-artifact\/v1/u);
  assert.match(notices, /MIT License/u);
});

test('keeps the built runtime root entry within the Chatroom initial-module ceiling', async () => {
  const metadata = await stat(new URL('../dist/runtime/chatroom.js', import.meta.url));
  assert.ok(metadata.size <= 2 * 1024 * 1024, `runtime entry is ${metadata.size} bytes`);
});
