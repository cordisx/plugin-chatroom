import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY,
  ChatroomComposerSettings,
  composerShortcutPolicyFromConfig,
  Config,
  configApplies,
} from '../dist/composer-settings.js';
import { CHATROOM_MANAGER_CONTENT_DECLARATIONS } from '../dist/manager-chat.js';

function settingsFixture(initial) {
  let value = initial;
  let disposed = false;
  const listeners = new Set();
  return {
    service: {
      get: () => value,
      watch(listener) {
        listeners.add(listener);
        return () => {
          disposed = true;
          listeners.delete(listener);
        };
      },
    },
    commit(next) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    get disposed() {
      return disposed;
    },
  };
}

test('Config declares one live closed shortcut setting with the accepted default and localized copy', () => {
  assert.equal(configApplies, 'live');
  assert.equal(CHATROOM_DEFAULT_COMPOSER_SHORTCUT_POLICY, 'enter');
  assert.deepEqual(Config({}), { shortcutPolicy: 'enter' });
  assert.deepEqual(Config({ shortcutPolicy: 'mod-enter' }), { shortcutPolicy: 'mod-enter' });
  assert.throws(() => Config({ shortcutPolicy: 'future' }));

  const envelope = JSON.parse(JSON.stringify(Config));
  const field = envelope.refs[envelope.refs[envelope.uid].dict.shortcutPolicy];
  const form = envelope.refs[envelope.uid].meta.extra.cordisxForm;
  assert.equal(field.meta.default, 'enter');
  assert.deepEqual(field.list.map(ref => envelope.refs[ref].value), ['enter', 'mod-enter']);
  assert.deepEqual(field.list.map(ref => envelope.refs[ref].meta.extra.label), [
    { en: 'Enter sends', 'zh-CN': 'Enter 发送' },
    { en: 'Command/Ctrl+Enter sends', 'zh-CN': 'Command/Ctrl+Enter 发送' },
  ]);
  assert.deepEqual(field.meta.extra.label, { en: 'Send shortcut', 'zh-CN': '发送快捷键' });
  assert.equal(field.meta.description.en, 'Choose Enter or Command/Ctrl+Enter to send a message.');
  assert.equal(field.meta.description['zh-CN'], '选择使用 Enter 或 Command/Ctrl+Enter 发送消息。');
  assert.deepEqual(form, {
    version: 2,
    fields: [{
      path: ['shortcutPolicy'],
      presenter: { version: 1, kind: 'choice.select' },
      choices: [
        { value: 'enter', label: { key: 'composer.shortcut.enter', fallback: 'Enter sends' } },
        { value: 'mod-enter', label: { key: 'composer.shortcut.mod-enter', fallback: 'Command/Ctrl+Enter sends' } },
      ],
    }],
  });
});

test('Manager settings is a Host-owned v5 form with missing-only default materialization', () => {
  const settings = CHATROOM_MANAGER_CONTENT_DECLARATIONS.find(item => item.id === 'settings');
  assert.deepEqual(settings, {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v5.schema.json',
    schemaVersion: 5,
    id: 'settings',
    route: { id: 'manager-chat-settings' },
    header: { title: { kind: 'route' } },
    tabs: settings.tabs,
    body: {
      kind: 'plugin-config-form',
      namespace: 'chatroom',
      defaultMaterialization: {
        mode: 'missing-only',
        fields: [{ path: ['shortcutPolicy'], value: 'enter' }],
      },
    },
  });
});

test('reads initial Host settings, watches committed changes, preserves existing values, and disposes cleanly', () => {
  assert.equal(composerShortcutPolicyFromConfig({}), 'enter');
  assert.equal(composerShortcutPolicyFromConfig({ shortcutPolicy: 'mod-enter' }), 'mod-enter');
  assert.throws(() => composerShortcutPolicyFromConfig({ shortcutPolicy: 'future' }));

  const host = settingsFixture({ shortcutPolicy: 'mod-enter' });
  const firstRuntime = new ChatroomComposerSettings(host.service);
  assert.equal(firstRuntime.current, 'mod-enter');
  const observed = [];
  firstRuntime.subscribe(policy => observed.push(policy));
  host.commit({ shortcutPolicy: 'enter' });
  host.commit({ shortcutPolicy: 'future' });
  host.commit({ shortcutPolicy: 'mod-enter' });
  assert.deepEqual(observed, ['enter', 'mod-enter']);
  assert.equal(firstRuntime.current, 'mod-enter');
  firstRuntime.dispose();
  assert.equal(host.disposed, true);
  host.commit({ shortcutPolicy: 'enter' });
  assert.deepEqual(observed, ['enter', 'mod-enter']);

  const reloaded = settingsFixture({ shortcutPolicy: 'mod-enter' });
  const secondRuntime = new ChatroomComposerSettings(reloaded.service);
  assert.equal(secondRuntime.current, 'mod-enter');
  secondRuntime.dispose();
});
