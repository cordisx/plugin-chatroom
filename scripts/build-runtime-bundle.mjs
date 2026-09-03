import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  bundle: true,
  entryPoints: ['src/chatroom.ts'],
  external: [
    'cordisx/react',
    'cordisx/react/jsx-runtime',
    'cordisx/react/jsx-dev-runtime',
    'cordisx/ui',
  ],
  format: 'esm',
  loader: { '.css': 'text' },
  outfile: 'dist/chatroom.js',
  platform: 'browser',
  sourcemap: false,
  target: ['chrome120'],
});
