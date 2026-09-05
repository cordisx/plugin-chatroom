import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fileURLToPath(new URL('../dist/runtime/', import.meta.url));

test('leases the formal Chatroom graph through the pinned Host immutable-runtime loader', async () => {
  const hostContracts = import.meta.resolve('cordisx/contracts');
  const hostLoader = await import(new URL('./launcher/plugin-generation-loader.js', hostContracts));
  const artifact = await hostLoader.readPluginGenerationArtifactV1(runtimeRoot);
  assert.equal(artifact?.contract, 'cordisx.plugin-generation-artifact/v1');

  const server = await hostLoader.startPluginGenerationArtifactServer();
  try {
    const loaded = await hostLoader.loadPluginGenerationArtifactForRuntime(
      {
        packageIdentity: {
          pluginId: 'chatroom',
          version: '0.1.0',
          integrity: `sha256:${'0'.repeat(64)}`,
        },
        artifactDirectory: runtimeRoot,
        runtimeEntry: artifact.entry,
      },
      'chatroom-test-generation',
      server,
    );

    assert.equal(loaded.kind, 'browser-esm-graph');
    assert.deepEqual(loaded.lease.initialStyleUrls, []);
    assert.match(loaded.runtimeArtifactSource, /__cordisxPluginGenerationResourcesV1/u);
    assert.equal(loaded.runtimeArtifactSource.includes(loaded.lease.entryUrl), true);
    assert.deepEqual(server.requestTrace(), []);

    const response = await fetch(loaded.lease.entryUrl);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      await readFile(resolve(runtimeRoot, artifact.entry.slice(2)), 'utf8'),
    );
    assert.deepEqual(server.requestTrace(), [{
      method: 'GET',
      leaseId: loaded.lease.leaseId,
      artifactPath: artifact.entry,
      status: 200,
    }]);

    loaded.lease.retire();
    assert.equal((await fetch(loaded.lease.entryUrl)).status, 404);
  } finally {
    await server.close();
  }
});
