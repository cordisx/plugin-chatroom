import { fileURLToPath } from 'node:url';

import { cordisXPluginViteConfig } from 'cordisx/vite';

const projectRoot = fileURLToPath(new URL('./', import.meta.url));

export default cordisXPluginViteConfig({
  root: projectRoot,
  entry: './src/chatroom.ts',
  outDir: './dist/runtime',
  entryFileName: 'chatroom.js',
});
