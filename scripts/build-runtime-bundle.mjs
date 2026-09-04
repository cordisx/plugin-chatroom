import { build } from 'esbuild';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Keep this release gate aligned with CordisX's generic immutable runtime-entry ceiling.
const MAX_PLUGIN_RUNTIME_MODULE_BYTES = 24 * 1024 * 1024;
const runtimeEntry = fileURLToPath(new URL('../dist/chatroom.js', import.meta.url));

const result = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  alias: {
    react: 'cordisx/react',
    'react/jsx-runtime': 'cordisx/react/jsx-runtime',
    'react/jsx-dev-runtime': 'cordisx/react/jsx-dev-runtime',
  },
  plugins: [{
    name: 'cordisx-shared-react-dom-peer',
    setup(bundle) {
      // Third-party React components declare ReactDOM as a peer. Match
      // CordisX's public plugin builder: provide that peer from the shared
      // runtime instead of bundling a second renderer. Plugin source itself
      // imports React and UI only through the public cordisx/* modules.
      bundle.onResolve({ filter: /^react-dom(?:\/client)?$/ }, args =>
        args.importer.includes('/@oneworks/avatar-react/')
          ? { path: args.path, namespace: 'cordisx-shared-react-dom-peer' }
          : undefined);
      bundle.onLoad({ filter: /.*/, namespace: 'cordisx-shared-react-dom-peer' }, args => {
        const client = args.path.endsWith('/client');
        const names = client ? ['createRoot', 'hydrateRoot', 'version'] : [
          'createPortal', 'flushSync', 'prefetchDNS', 'preconnect', 'preinit',
          'preinitModule', 'preload', 'preloadModule', 'requestFormReset',
          'useFormState', 'useFormStatus', 'version',
        ];
        return {
          contents: `const current = () => {
  const runtime = globalThis.__cordisxSharedReactRuntime;
  if (runtime === undefined) throw new Error('CordisX shared React runtime is unavailable');
  return runtime.${client ? 'reactDomClient' : 'reactDom'};
};
export default new Proxy({}, { get(_target, key) {
  const value = current()[key];
  return typeof value === 'function' ? value.bind(current()) : value;
} });
${names.filter(name => name !== 'version').map(name => `export const ${name} = (...args) => current().${name}(...args);`).join('\n')}
export const version = '19.2.8';`,
          loader: 'js',
        };
      });
    },
  }],
  bundle: true,
  entryPoints: ['src/chatroom.ts'],
  external: [
    'cordisx/contracts',
    'cordisx/react',
    'cordisx/react/jsx-runtime',
    'cordisx/react/jsx-dev-runtime',
    'cordisx/ui',
  ],
  format: 'esm',
  loader: { '.css': 'text' },
  metafile: true,
  outfile: 'dist/chatroom.js',
  platform: 'browser',
  sourcemap: false,
  target: ['chrome120'],
});

const runtimeMetadata = await stat(runtimeEntry);
if (runtimeMetadata.size > MAX_PLUGIN_RUNTIME_MODULE_BYTES) {
  throw new Error(
    `Chatroom runtime entry exceeds the CordisX ${MAX_PLUGIN_RUNTIME_MODULE_BYTES}-byte limit: ${runtimeMetadata.size}`,
  );
}

const privateRenderer = Object.keys(result.metafile.inputs).find(input =>
  /(?:^|\/)node_modules\/(?:react|react-dom)(?:\/|$)/u.test(input.replaceAll('\\', '/')),
);
if (privateRenderer !== undefined) {
  throw new Error(`Chatroom bundle contains a private React renderer: ${privateRenderer}`);
}
