import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('loads the built Chatroom entry through the pinned Host immutable-runtime loader', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-runtime-load-'));
  try {
    const entry = new URL('../dist/chatroom.js', import.meta.url);
    const metadata = await stat(entry);
    const hostContracts = import.meta.resolve('cordisx/contracts');
    const hostLoader = await import(new URL('./launcher/plugin-generation-loader.js', hostContracts));
    assert.equal(hostLoader.MAX_PLUGIN_RUNTIME_MODULE_BYTES, 24 * 1024 * 1024);
    assert.ok(metadata.size <= hostLoader.MAX_PLUGIN_RUNTIME_MODULE_BYTES);

    await copyFile(entry, join(directory, 'module.js'));
    const loaded = await hostLoader.loadPluginGenerationArtifact({
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    });
    assert.match(loaded, /__cordisxPendingPluginModuleFactoryV1/u);
    assert.match(loaded, /cordisx\.navigation-collection\/v3/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
