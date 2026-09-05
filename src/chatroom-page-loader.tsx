import { type ComponentType, defineReactPage, lazy, Suspense } from 'cordisx/react';
import type { CordisXReactPageProps } from 'cordisx/contracts';

import type { ChatroomPageSource } from './chatroom-page-source.js';
import type { ChatroomSidebarImageCache } from './sidebar-image-cache.js';
import { loadModuleOnce } from './lazy-module.js';

type ChatroomPageComponent = ComponentType<
  CordisXReactPageProps & {
    readonly source: ChatroomPageSource;
    readonly imageCache: ChatroomSidebarImageCache;
  }
>;

type ChatroomPageModule = Readonly<{
  ChatroomPage: ChatroomPageComponent;
}>;

export const createChatroomPageModuleLoader = (
  load: () => Promise<ChatroomPageModule>,
): () => Promise<ChatroomPageModule> => loadModuleOnce(load);

/** Registration stays light; the page graph starts loading only on an actual mount. */
export function createLazyChatroomPage(
  source: ChatroomPageSource,
  imageCache: ChatroomSidebarImageCache,
) {
  const loadChatroomPageModule = createChatroomPageModuleLoader(
    () => import('./chatroom-page.js'),
  );
  const LazyChatroomPage = lazy(async () => ({
    default: (await loadChatroomPageModule()).ChatroomPage,
  }));
  return defineReactPage(props => (
    <Suspense fallback={null}>
      <LazyChatroomPage {...props} source={source} imageCache={imageCache} />
    </Suspense>
  ));
}
