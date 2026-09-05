import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = resolve(repositoryRoot, 'dist/runtime');
const readRuntime = file => readFile(resolve(runtimeRoot, file.replace(/^\.\//u, '')), 'utf8');

const hostSharedImports = new Set([
  'cordisx/contracts',
  'cordisx/react',
  'cordisx/react/jsx-runtime',
  'cordisx/react/jsx-dev-runtime',
  'cordisx/ui',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
]);

const artifact = JSON.parse(await readRuntime('./artifact.json'));
const files = new Map(artifact.files.map(file => [file.path, file]));
const page = artifact.files.find(file => file.kind === 'module' && file.path.includes('chatroom-page-'));
const renderer = artifact.files.find(file => file.kind === 'module' && file.path.includes('avatar-renderer-'));

test('emits page and Avatar renderer as nested immutable runtime chunks', async () => {
  assert.equal(artifact.contract, 'cordisx.plugin-generation-artifact/v1');
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.format, 'browser-esm-graph');
  assert.deepEqual(artifact.initialStyles, []);
  assert.ok(page);
  assert.ok(renderer);

  const staticClosure = new Set();
  const visitStatic = path => {
    if (staticClosure.has(path)) return;
    const file = files.get(path);
    assert.equal(file?.kind, 'module', `missing static module ${path}`);
    staticClosure.add(path);
    for (const imported of file.imports) visitStatic(imported);
  };
  visitStatic(artifact.entry);
  const initialDynamicImports = [
    ...new Set([...staticClosure]
      .flatMap(path => files.get(path).dynamicImports)),
  ];
  assert.deepEqual(initialDynamicImports, [page.path]);
  assert.deepEqual(page.dynamicImports, [renderer.path]);
  assert.equal(page.styles.length, 1);
  assert.equal(renderer.styles.length, 1);
  assert.notEqual(page.styles[0], renderer.styles[0]);

  const [entryBytes, pageBytes, rendererBytes, pageCss, rendererCss] = await Promise.all([
    Promise.all([...staticClosure].map(async path => (await stat(resolve(runtimeRoot, path.slice(2)))).size))
      .then(sizes => sizes.reduce((sum, size) => sum + size, 0)),
    stat(resolve(runtimeRoot, page.path.slice(2))).then(value => value.size),
    stat(resolve(runtimeRoot, renderer.path.slice(2))).then(value => value.size),
    readRuntime(page.styles[0]),
    readRuntime(renderer.styles[0]),
  ]);
  assert.ok(entryBytes <= 2 * 1024 * 1024, `initial static closure is ${entryBytes} bytes`);
  assert.ok(pageBytes <= 2 * 1024 * 1024, `page module is ${pageBytes} bytes`);
  assert.ok(rendererBytes <= 2 * 1024 * 1024, `renderer module is ${rendererBytes} bytes`);
  assert.match(pageCss, /\.cx-chatroom-page/u);
  assert.match(rendererCss, /\.oneworks-avatar/u);
  assert.match(rendererCss, /\.interactive-avatar/u);
  assert.doesNotMatch(rendererCss, /oneworks-avatar-editor|animation-panel/u);
});

test('keeps every emitted ESM edge contained, immutable, and Host-shared', async () => {
  assert.deepEqual([...artifact.sharedImports].sort(), artifact.sharedImports);
  assert.equal(artifact.sharedImports.every(item => hostSharedImports.has(item)), true);

  for (const file of artifact.files) {
    const target = resolve(runtimeRoot, file.path.slice(2));
    const escaped = relative(runtimeRoot, target);
    assert.equal(escaped.startsWith('..') || escaped === '', false, `unsafe path ${file.path}`);
    const bytes = await readFile(target);
    assert.equal(bytes.byteLength, file.byteLength, `byte length drift for ${file.path}`);
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      file.digest,
      `digest drift for ${file.path}`,
    );
    if (file.kind !== 'module') continue;
    for (const edge of [...file.imports, ...file.dynamicImports, ...file.styles, ...file.assets]) {
      assert.ok(files.has(edge), `${file.path} has undeclared edge ${edge}`);
    }
    const source = bytes.toString('utf8');
    const specifiers = [...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu,
    )].map(match => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        assert.equal(hostSharedImports.has(specifier), true, `${file.path} has bare import ${specifier}`);
        continue;
      }
      const imported = resolve(dirname(target), specifier);
      const importedPath = relative(runtimeRoot, imported);
      assert.equal(importedPath.startsWith('..') || importedPath === '', false, `${file.path} escapes to ${specifier}`);
      assert.equal((await stat(imported)).isFile(), true, `${file.path} misses ${specifier}`);
    }
  }
});
