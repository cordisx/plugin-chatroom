import assert from 'node:assert/strict';
import test from 'node:test';

import { selectChatroomPageMount } from '../dist/chatroom-page-surface.js';

test('selects the public Host Shell v12 mount without creating the plugin page fallback', async () => {
  const mount = () => {};
  let fallbackCalls = 0;
  const registrations = [];
  const selected = await selectChatroomPageMount(
    {
      registerSourceV12(factory, options) {
        registrations.push({ factory, options });
        return { mount, dispose() {} };
      },
    },
    () => ({ snapshot() {}, subscribe() {}, dispose() {} }),
    async () => {
      fallbackCalls += 1;
      return () => {};
    },
  );

  assert.equal(selected, mount);
  assert.equal(fallbackCalls, 0);
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options, { composer: { mode: 'page-composer-v2' } });
});

test('retains the lazy plugin page only when the public Host Shell is absent', async () => {
  const fallbackMount = () => {};
  let fallbackCalls = 0;
  const selected = await selectChatroomPageMount(undefined, () => {
    throw new Error('A missing Host Shell must not register a source.');
  }, async () => {
    fallbackCalls += 1;
    return fallbackMount;
  });

  assert.equal(selected, fallbackMount);
  assert.equal(fallbackCalls, 1);
});
