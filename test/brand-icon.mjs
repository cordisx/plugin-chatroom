import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { icon } from '../dist/chatroom-brand-icon.js';

test('brand artwork preserves the selected PNG in the public module icon and runtime graph', async () => {
  const png = await readFile(new URL('../assets/chatroom.png', import.meta.url));
  assert.equal(
    createHash('sha256').update(png).digest('hex'),
    '6cfaaac15f1e7d325f2db248aaf28981c22460797f090ba30fc558a54d711620',
  );
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(icon.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(icon.data, 'base64'), png);
  assert.ok(icon.data.length <= 400_000);
  const entry = await readFile(new URL('../dist/chatroom.js', import.meta.url), 'utf8');
  assert.match(entry, /export \{ icon \} from '\.\/chatroom-brand-icon\.js'/u);
  const artifact = JSON.parse(await readFile(new URL('../dist/runtime/artifact.json', import.meta.url), 'utf8'));
  const modules = await Promise.all(
    artifact.files.filter(file => file.kind === 'module').map(file =>
      readFile(new URL(`../dist/runtime/${file.path.slice(2)}`, import.meta.url), 'utf8')
    ),
  );
  assert.ok(modules.some(module => module.includes(icon.data)), 'runtime graph retains the embedded PNG');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.files.includes('assets/chatroom.png'));
});
