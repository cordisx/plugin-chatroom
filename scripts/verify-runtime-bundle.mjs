import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PLUGIN_RUNTIME_MODULE_BYTES = 24 * 1024 * 1024;
const MAX_CHATROOM_INITIAL_GRAPH_BYTES = 2 * 1024 * 1024;
const MAX_CHATROOM_RUNTIME_GRAPH_BYTES = 4 * 1024 * 1024;
const runtimeRoot = fileURLToPath(new URL('../dist/runtime/', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(runtimeRoot, 'artifact.json'), 'utf8'));

if (
  manifest.contract !== 'cordisx.plugin-generation-artifact/v1'
  || manifest.schemaVersion !== 1
  || manifest.format !== 'browser-esm-graph'
) {
  throw new Error('Chatroom build did not emit a formal CordisX browser ESM graph.');
}
if (manifest.initialStyles.length !== 0) {
  throw new Error(`Chatroom activation unexpectedly owns initial styles: ${manifest.initialStyles.join(', ')}`);
}

const files = new Map(manifest.files.map(file => [file.path, file]));
const entry = files.get(manifest.entry);
if (entry?.kind !== 'module') throw new Error('Chatroom runtime entry is missing from its graph.');

let totalBytes = 0;
for (const file of manifest.files) {
  const bytes = await readFile(resolve(runtimeRoot, file.path.slice(2)));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.byteLength !== file.byteLength || digest !== file.digest) {
    throw new Error(`Chatroom runtime file does not match its manifest: ${file.path}`);
  }
  if (file.kind === 'module' && bytes.byteLength > MAX_PLUGIN_RUNTIME_MODULE_BYTES) {
    throw new Error(`Chatroom runtime module exceeds ${MAX_PLUGIN_RUNTIME_MODULE_BYTES} bytes: ${file.path}`);
  }
  totalBytes += bytes.byteLength;
}
if (totalBytes > MAX_CHATROOM_RUNTIME_GRAPH_BYTES) {
  throw new Error(`Chatroom runtime graph exceeds ${MAX_CHATROOM_RUNTIME_GRAPH_BYTES} bytes: ${totalBytes}`);
}

const staticClosure = new Set();
const visitStatic = path => {
  if (staticClosure.has(path)) return;
  const file = files.get(path);
  if (file?.kind !== 'module') throw new Error(`Chatroom static module is missing: ${path}`);
  staticClosure.add(path);
  for (const imported of file.imports) visitStatic(imported);
};
visitStatic(manifest.entry);
const initialBytes = [...staticClosure].reduce((sum, path) => sum + files.get(path).byteLength, 0);
if (initialBytes > MAX_CHATROOM_INITIAL_GRAPH_BYTES) {
  throw new Error(`Chatroom initial graph exceeds ${MAX_CHATROOM_INITIAL_GRAPH_BYTES} bytes: ${initialBytes}`);
}

const page = manifest.files.find(file => file.kind === 'module' && file.path.includes('chatroom-page-'));
const renderer = manifest.files.find(file => file.kind === 'module' && file.path.includes('avatar-renderer-'));
if (page === undefined || renderer === undefined) {
  throw new Error('Chatroom build did not preserve its page and Avatar renderer chunks.');
}
const initialDynamicImports = new Set([...staticClosure].flatMap(path => files.get(path).dynamicImports));
if (!initialDynamicImports.has(page.path) || initialDynamicImports.has(renderer.path)) {
  throw new Error('Chatroom page must be the only visual module reachable from activation demand.');
}
if (!page.dynamicImports.includes(renderer.path) || page.styles.length !== 1 || renderer.styles.length !== 1) {
  throw new Error('Chatroom page and Avatar renderer lazy ownership is incomplete.');
}

const [pageCss, rendererCss] = await Promise.all([
  readFile(resolve(runtimeRoot, page.styles[0].slice(2)), 'utf8'),
  readFile(resolve(runtimeRoot, renderer.styles[0].slice(2)), 'utf8'),
]);
if (!pageCss.includes('.cx-chatroom-page')) throw new Error('Chatroom page stylesheet is incomplete.');
if (
  !rendererCss.includes('.oneworks-avatar') || !rendererCss.includes('.interactive-avatar')
  || /oneworks-avatar-editor|animation-panel/u.test(rendererCss)
) {
  throw new Error('OneWorks renderer stylesheet is not renderer-only.');
}

const runtimeFiles = new Set();
const visitDirectory = async relativeDirectory => {
  for (const item of await readdir(resolve(runtimeRoot, relativeDirectory), { withFileTypes: true })) {
    const relative = relativeDirectory === '' ? item.name : `${relativeDirectory}/${item.name}`;
    const metadata = await lstat(resolve(runtimeRoot, relative));
    if (metadata.isSymbolicLink()) throw new Error(`Chatroom runtime graph contains a symlink: ${relative}`);
    if (metadata.isDirectory()) await visitDirectory(relative);
    else if (metadata.isFile()) runtimeFiles.add(`./${relative}`);
    else throw new Error(`Chatroom runtime graph contains a non-file entry: ${relative}`);
  }
};
await visitDirectory('');
const declaredFiles = new Set(['./artifact.json', ...manifest.files.map(file => file.path)]);
if (
  runtimeFiles.size !== declaredFiles.size
  || [...runtimeFiles].some(file => !declaredFiles.has(file))
) {
  throw new Error('Chatroom runtime graph contains undeclared or missing files.');
}
