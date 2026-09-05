import assert from 'node:assert/strict';
import test from 'node:test';

import { loadModuleOnce } from '../dist/lazy-module.js';

test('defers a module until first demand and reuses the owning loader request', async () => {
  let loads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const load = loadModuleOnce(async () => {
    loads += 1;
    await pending;
    return Object.freeze({ page: 'chatroom' });
  });

  assert.equal(loads, 0, 'registration does not start the module request');
  const first = load();
  const second = load();
  assert.equal(loads, 1, 'concurrent and repeated demand shares one request');
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { page: 'chatroom' });
  assert.equal(await load(), await first, 'a later page open reuses the loaded module');
  assert.equal(loads, 1);
});

test('keeps a failed retired loader isolated from its replacement', async () => {
  let retiredLoads = 0;
  const failure = new Error('retired generation failed');
  const retired = loadModuleOnce(async () => {
    retiredLoads += 1;
    throw failure;
  });
  await assert.rejects(retired(), failure);
  await assert.rejects(retired(), failure);
  assert.equal(retiredLoads, 1, 'one owner does not retry a rejected immutable module');

  let replacementLoads = 0;
  const replacement = loadModuleOnce(async () => {
    replacementLoads += 1;
    return Object.freeze({ page: 'replacement' });
  });
  assert.deepEqual(await replacement(), { page: 'replacement' });
  assert.equal(replacementLoads, 1, 'a replacement owns an independent module request');
});
