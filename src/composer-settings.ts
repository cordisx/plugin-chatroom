import Schema from '@deepseek-ai/schemastery';

export type ChatroomComposerShortcutPolicy = 'enter' | 'mod-enter';

export interface ChatroomSettingsService {
  get<T = unknown>(): T;
  watch<T = unknown>(listener: (value: T) => void): () => void;
}

export const CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY = 'enter' as const;

const label = (en: string, zh: string) => ({ en, 'zh-CN': zh });

/**
 * Host-rendered, Host-persisted Chatroom configuration. The plugin consumes
 * only the resolved initial value and committed live updates.
 */
export const Config = Schema.object({
  shortcutPolicy: Schema.union([
    Schema.const('enter').extra('extra', { label: label('Enter sends', 'Enter 发送') }),
    Schema.const('mod-enter').extra('extra', {
      label: label('Command/Ctrl+Enter sends', 'Command/Ctrl+Enter 发送'),
    }),
  ])
    .default(CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY)
    .role('radio')
    .extra('extra', {
      label: label('Send shortcut', '发送快捷键'),
    })
    .description('Choose Enter or Command/Ctrl+Enter to send a message.')
    .i18n(label(
      'Choose Enter or Command/Ctrl+Enter to send a message.',
      '选择使用 Enter 或 Command/Ctrl+Enter 发送消息。',
    )),
}).extra('extra', {
  cordisxForm: {
    version: 2,
    fields: [{
      path: ['shortcutPolicy'],
      presenter: { version: 1, kind: 'choice.select' },
      choices: [
        {
          value: 'enter',
          label: { key: 'composer.shortcut.enter', fallback: 'Enter sends' },
        },
        {
          value: 'mod-enter',
          label: { key: 'composer.shortcut.mod-enter', fallback: 'Command/Ctrl+Enter sends' },
        },
      ],
    }],
  },
});

export const configApplies = 'live' as const;

export function composerShortcutPolicyFromConfig(value: unknown): ChatroomComposerShortcutPolicy {
  if (value === undefined || value === null) return CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chatroom configuration must be an object.');
  }
  const shortcutPolicy = (value as { readonly shortcutPolicy?: unknown }).shortcutPolicy;
  if (shortcutPolicy === undefined) return CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY;
  if (shortcutPolicy === 'enter' || shortcutPolicy === 'mod-enter') return shortcutPolicy;
  throw new Error('Chatroom shortcutPolicy is invalid.');
}

/** One read-only view over the Host-owned committed configuration ledger. */
export class ChatroomComposerSettings {
  private disposed = false;
  private policy: ChatroomComposerShortcutPolicy;
  private readonly listeners = new Set<(policy: ChatroomComposerShortcutPolicy) => void>();
  private readonly unwatch: () => void;

  constructor(settings: ChatroomSettingsService) {
    this.policy = composerShortcutPolicyFromConfig(settings.get());
    this.unwatch = settings.watch(value => {
      if (this.disposed) return;
      let next: ChatroomComposerShortcutPolicy;
      try {
        next = composerShortcutPolicyFromConfig(value);
      } catch {
        // Host validation prevents invalid committed values. Retaining the
        // last valid projection is the consumer-side fail-closed boundary.
        return;
      }
      if (next === this.policy) return;
      this.policy = next;
      for (const listener of this.listeners) listener(next);
    });
  }

  get current(): ChatroomComposerShortcutPolicy {
    return this.policy;
  }

  subscribe(listener: (policy: ChatroomComposerShortcutPolicy) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.unwatch();
  }
}
