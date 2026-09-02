import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXI18n,
  type CordisXManagerContentNavigationDeclarationV1,
  type CordisXPageMetadataV3,
  type CordisXPages,
  type CordisXReactPageComponent,
  type CordisXRouteDefinitionV2,
  type CordisXRoutes,
  type CordisXSlots,
} from 'cordisx/contracts';
import { createElement, defineReactPage } from 'cordisx/react';
import { Button, EmptyState } from 'cordisx/ui';

import {
  registerTalentMarketLocales,
  talentMarketMessage,
  type TalentMarketDisposer,
  type TalentMarketMessages,
} from './talent-market-locales.js';

export const TALENT_MARKET_PAGE_ID = 'talent-market';
export const TALENT_MARKET_ROUTE_ID = 'talent-market';
export const TALENT_MARKET_NAVIGATION_ID = 'talent-market';

export interface TalentMarketHostContext {
  readonly i18n: CordisXI18n;
  readonly pages: CordisXPages;
  readonly routes: CordisXRoutes;
  readonly slots: CordisXSlots;
}

export const talentMarketPage = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: TALENT_MARKET_PAGE_ID,
  title: talentMarketMessage('page.title'),
  description: talentMarketMessage('page.description'),
  icon: 'host:people-search',
  chrome: 'standard',
} as const satisfies CordisXPageMetadataV3;

export const talentMarketRoute = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: TALENT_MARKET_ROUTE_ID,
  path: '/manager/extensions/chatroom/talent-market',
  outlet: 'manager.content',
  page: TALENT_MARKET_PAGE_ID,
  title: talentMarketMessage('navigation.title'),
  description: talentMarketMessage('navigation.description'),
} as const satisfies CordisXRouteDefinitionV2<'manager.content'>;

export const TALENT_MARKET_MANAGER_CONTENT_DECLARATIONS:
readonly CordisXManagerContentNavigationDeclarationV1[] = Object.freeze([
  Object.freeze({
    $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
    schemaVersion: 1,
    id: 'talent-market-root',
    route: Object.freeze({ id: TALENT_MARKET_ROUTE_ID }),
    header: Object.freeze({ title: Object.freeze({ kind: 'route' as const }) }),
  }),
]);

export function registerTalentMarket(
  context: TalentMarketHostContext,
): readonly TalentMarketDisposer[] {
  const localeRegistration = registerTalentMarketLocales(context.i18n);
  const { localization } = localeRegistration;
  const disposers: TalentMarketDisposer[] = [...localeRegistration.disposers];
  const TalentMarketPage: CordisXReactPageComponent<TalentMarketMessages> = ({ navigation }) => createElement(EmptyState, {
    'data-chatroom-talent-market-empty': 'true',
    title: localization.t('empty.title'),
    description: localization.t('empty.description'),
    action: createElement(Button, {
      type: 'button',
      variant: 'secondary',
      'data-chatroom-talent-market-back': 'true',
      onClick: () => void navigation.back('manager.content'),
    }, localization.t('action.back')),
  });

  try {
    disposers.push(
      context.pages.register(talentMarketPage, defineReactPage<TalentMarketMessages>(TalentMarketPage)),
      context.routes.register(talentMarketRoute),
      context.slots.register({
        name: 'manager.settings.navigation-items',
        id: TALENT_MARKET_NAVIGATION_ID,
        group: 'after-settings',
        order: 240,
      }, {
        route: { id: TALENT_MARKET_ROUTE_ID },
      }),
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose();
    throw error;
  }
  return Object.freeze(disposers);
}
