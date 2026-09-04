import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';

const validPngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const grayscalePngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function importCache() {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-sidebar-images-'));
  const source = await readFile(new URL('../src/sidebar-image-cache.ts', import.meta.url), 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
    fileName: 'sidebar-image-cache.ts',
  });
  await writeFile(join(directory, 'sidebar-image-cache.js'), output.outputText);
  return {
    directory,
    module: await import(pathToFileURL(join(directory, 'sidebar-image-cache.js')).href),
  };
}

const snapshot = module => ({
  $schema: module.CHATROOM_SIDEBAR_IMAGE_SCHEMA,
  contract: module.CHATROOM_SIDEBAR_IMAGE_CONTRACT,
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  data: validPngData,
  width: 1,
  height: 1,
});

test('accepts only the current async capture generation and freezes completed values', async () => {
  const imported = await importCache();
  try {
    const cache = new imported.module.ChatroomSidebarImageCache(2);
    const stale = cache.begin('room-a', 'avatar-a');
    const current = cache.begin('room-a', 'avatar-a');
    assert.equal(stale.publish(snapshot(imported.module)), false);
    assert.equal(current.publish(snapshot(imported.module)), true);
    const retained = cache.get('room-a', 'avatar-a');
    assert.equal(Object.isFrozen(retained), true);
    assert.equal(retained.data, validPngData);
    cache.dispose();
    assert.equal(current.publish(snapshot(imported.module)), false);
    assert.equal(cache.get('room-a', 'avatar-a'), undefined);
  } finally {
    await rm(imported.directory, { recursive: true, force: true });
  }
});

test('bounds completed PNGs with LRU eviction and fences evicted producers', async () => {
  const imported = await importCache();
  try {
    const cache = new imported.module.ChatroomSidebarImageCache(2);
    const first = cache.begin('room-a', 'a');
    const second = cache.begin('room-b', 'b');
    first.publish(snapshot(imported.module));
    second.publish(snapshot(imported.module));
    assert.notEqual(cache.get('room-a', 'a'), undefined);
    cache.begin('room-c', 'c').publish(snapshot(imported.module));
    assert.equal(cache.get('room-b', 'b'), undefined);
    assert.equal(cache.size, 2);
    assert.equal(second.publish(snapshot(imported.module)), false);
    for (let index = 0; index < 100; index += 1) cache.begin(`transient-${index}`, 'capture');
    assert.ok(cache.generations.size <= 4);
    cache.dispose();
  } finally {
    await rm(imported.directory, { recursive: true, force: true });
  }
});

test('rejects contract-invalid and semantically invalid PNG snapshots', async () => {
  const imported = await importCache();
  try {
    const cache = new imported.module.ChatroomSidebarImageCache();
    const malformed = cache.begin('room-a', 'a');
    assert.throws(() => malformed.publish({ ...snapshot(imported.module), data: '!!!!' }), /invalid/u);
    const oversized = cache.begin('room-a', 'a');
    assert.throws(() => oversized.publish({ ...snapshot(imported.module), width: 257 }), /invalid/u);
    const nonPng = cache.begin('room-a', 'a');
    assert.throws(() => nonPng.publish({ ...snapshot(imported.module), data: 'YWJjZA==' }), /not a PNG/u);
    const dimensions = cache.begin('room-a', 'a');
    assert.throws(() => dimensions.publish({ ...snapshot(imported.module), width: 2 }), /dimensions/u);
    const grayscale = cache.begin('room-a', 'a');
    assert.throws(() => grayscale.publish({ ...snapshot(imported.module), data: grayscalePngData }), /RGBA/u);
    const badCrc = cache.begin('room-a', 'a');
    const corruptedBytes = Buffer.from(validPngData, 'base64');
    corruptedBytes[29] ^= 1;
    assert.throws(() => badCrc.publish({
      ...snapshot(imported.module), data: corruptedBytes.toString('base64'),
    }), /CRC/u);
    const unknownField = cache.begin('room-a', 'a');
    assert.throws(() => unknownField.publish({ ...snapshot(imported.module), unexpected: true }), /invalid/u);
    cache.dispose();
  } finally {
    await rm(imported.directory, { recursive: true, force: true });
  }
});

test('closes every decoded bitmap when one composite input fails', async () => {
  const imported = await importCache();
  const previousDocument = globalThis.document;
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  let closed = 0;
  try {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
      }),
    };
    let call = 0;
    globalThis.createImageBitmap = async () => {
      call += 1;
      if (call === 2) throw new Error('decode failed');
      return { close: () => { closed += 1; } };
    };
    await assert.rejects(
      imported.module.composeChatroomSidebarSnapshots([
        snapshot(imported.module),
        snapshot(imported.module),
        snapshot(imported.module),
      ], 3),
      /decode failed/u,
    );
    assert.equal(closed, 2);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousCreateImageBitmap;
    await rm(imported.directory, { recursive: true, force: true });
  }
});
