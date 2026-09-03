import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('keeps the static package manifest on the exact minimal runtime capability set', () => {
  const packageManifest = JSON.parse(readFileSync(
    new URL('../cordisx-package.json', import.meta.url), 'utf8',
  ));
  const runtimeManifest = JSON.parse(readFileSync(
    new URL(`../${packageManifest.runtimeManifest.path.slice(2)}`, import.meta.url), 'utf8',
  ));
  const staticCapabilities = runtimeManifest.capabilities;
  assert.equal(packageManifest.schemaVersion, 5);
  assert.equal(runtimeManifest.schemaVersion, 5);
  assert.deepEqual(staticCapabilities.map(item => item.name), [
    'agents.create', 'agents.resume', 'agents.get', 'agents.message.submit',
    'agents.message.cancel', 'sessions.get', 'sessions.subscribe', 'approvals.answer',
  ]);
  assert.equal(staticCapabilities.every(item => item.required === true), true);
  assert.equal(staticCapabilities.some(item => item.name.includes('*')), false);
  assert.equal(new Set(staticCapabilities.map(item => item.name)).size, staticCapabilities.length);
  assert.deepEqual(runtimeManifest.services, []);
});
