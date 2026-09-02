import { createElement, useEffect } from 'cordisx/react';
import { defineReactPage } from 'cordisx/react';
import type {
  CordisXPageMount,
  CordisXReactPageProps,
  ManagerCollectionRegistrationV1,
  ManagerCollectionSourceV1,
} from 'cordisx/contracts';
import { EmptyState } from 'cordisx/ui';

import type { ChatroomManagerMessages } from './manager-chat.js';

export function createChatroomManagerCollectionPage(
  registration: ManagerCollectionRegistrationV1,
  createSource: () => ManagerCollectionSourceV1,
): CordisXPageMount<ChatroomManagerMessages> {
  return defineReactPage<ChatroomManagerMessages>(function ChatroomManagerCollectionPage({
    managerCollection,
  }: CordisXReactPageProps<ChatroomManagerMessages>) {
    useEffect(() => {
      if (managerCollection === undefined) return;
      const handle = managerCollection.register(registration, createSource());
      return () => handle.dispose();
    }, [managerCollection]);
    return null;
  });
}

export const chatroomManagerSettingsPage = defineReactPage<ChatroomManagerMessages>(
  function ChatroomManagerSettingsPage({ t }: CordisXReactPageProps<ChatroomManagerMessages>) {
    return createElement(EmptyState, {
      title: t('manager.settings.empty.title'),
      description: t('manager.settings.empty.description'),
    });
  },
);
