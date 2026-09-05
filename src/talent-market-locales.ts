import type { CordisXI18n, CordisXLocalizationSeat, CordisXLocalizedText } from 'cordisx/contracts';

export const TALENT_MARKET_LOCALE_NAMESPACE = 'talent-market';

export interface TalentMarketMessages {
  readonly 'navigation.title': undefined;
  readonly 'navigation.description': undefined;
  readonly 'page.title': undefined;
  readonly 'page.description': undefined;
  readonly 'empty.title': undefined;
  readonly 'empty.description': undefined;
  readonly 'action.back': undefined;
}

export type TalentMarketDisposer = () => void | Promise<void>;

export interface TalentMarketLocaleRegistration {
  readonly localization: CordisXLocalizationSeat<TalentMarketMessages>;
  readonly disposers: readonly TalentMarketDisposer[];
}

const EN_MESSAGES = {
  'navigation.title': 'Talent marketplace',
  'navigation.description': 'A future home for sharing and discovering entities and organizational structures.',
  'page.title': 'Talent marketplace',
  'page.description': 'Share and discover entities and organizational structures when the talent marketplace launches.',
  'empty.title': 'Coming soon',
  'empty.description':
    'When the talent marketplace launches, you can share and discover entities and organizational structures here.',
  'action.back': 'Back',
} as const satisfies Readonly<Record<keyof TalentMarketMessages, string>>;

const ZH_CN_MESSAGES = {
  'navigation.title': '人才市场',
  'navigation.description': '未来可在此分享和发现实体与组织架构。',
  'page.title': '人才市场',
  'page.description': '人才市场上线后，可在此分享和发现实体与组织架构。',
  'empty.title': '即将推出',
  'empty.description': '人才市场上线后，你可以在这里分享和发现实体与组织架构。',
  'action.back': '返回',
} as const satisfies Readonly<Record<keyof TalentMarketMessages, string>>;

export function talentMarketMessage(key: keyof TalentMarketMessages): CordisXLocalizedText {
  return {
    namespace: TALENT_MARKET_LOCALE_NAMESPACE,
    key,
    fallback: EN_MESSAGES[key],
  };
}

export function registerTalentMarketLocales(
  i18n: CordisXI18n,
): TalentMarketLocaleRegistration {
  const disposers: TalentMarketDisposer[] = [];
  try {
    disposers.push(i18n.define<TalentMarketMessages>({
      namespace: TALENT_MARKET_LOCALE_NAMESPACE,
      locale: 'en',
      default: true,
      messages: EN_MESSAGES,
    }));
    disposers.push(i18n.define<TalentMarketMessages>({
      namespace: TALENT_MARKET_LOCALE_NAMESPACE,
      locale: 'zh-CN',
      messages: ZH_CN_MESSAGES,
    }));
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose();
    throw error;
  }
  return Object.freeze({
    localization: i18n.seat<TalentMarketMessages>(TALENT_MARKET_LOCALE_NAMESPACE),
    disposers: Object.freeze(disposers),
  });
}
