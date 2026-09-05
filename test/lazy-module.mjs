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
