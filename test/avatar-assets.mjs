import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';

const expected = Object.freeze([
  ['CHATROOM_ONEWORKS_RED_FOX_AVATAR_ASSET_REF', 'CHATROOM_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION'],
  ['CHATROOM_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF', 'CHATROOM_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION'],
  ['CHATROOM_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF', 'CHATROOM_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION'],
  ['CHATROOM_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF', 'CHATROOM_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REVISION'],
  ['CHATROOM_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF', 'CHATROOM_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REVISION'],
]);

async function importAssets() {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-avatar-assets-'));
  const source = await readFile(new URL('../src/avatar-assets.ts', import.meta.url), 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
    fileName: 'avatar-assets.ts',
  });
  await writeFile(join(directory, 'avatar-assets.js'), output.outputText);
  return { directory, module: await import(pathToFileURL(join(directory, 'avatar-assets.js')).href) };
}

test('resolves all five exact OneWorks RC.8 editor assets only at their pinned revisions', async () => {
  const imported = await importAssets();
  try {
    const refs = [];
    for (const [refName, revisionName] of expected) {
      const ref = imported.module[refName];
      const revision = imported.module[revisionName];
      refs.push(ref);
      const definition = imported.module.resolveOfficialOneWorksAvatarAsset(ref, revision);
      assert.equal(definition.schema, 'oneworks.avatar');
      assert.equal(definition.version, 1);
      assert.equal(imported.module.resolveOfficialOneWorksAvatarAsset(ref, `${revision}-changed`), undefined);
    }
    assert.equal(new Set(refs).size, 5);
    assert.equal(Object.keys(imported.module.CHATROOM_ONEWORKS_AVATAR_ASSET_PROVENANCE.definitions).length, 5);
    assert.equal(imported.module.CHATROOM_ONEWORKS_AVATAR_ASSET_PROVENANCE.renderer,
      '@oneworks/avatar-react@1.0.0-rc.8');
    assert.equal(Object.isFrozen(imported.module.CHATROOM_ONEWORKS_AVATAR_ASSET_PROVENANCE), true);
  } finally {
    await rm(imported.directory, { recursive: true, force: true });
  }
});
