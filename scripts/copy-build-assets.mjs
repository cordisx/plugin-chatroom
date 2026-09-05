import { copyFile, mkdir } from 'node:fs/promises';

const outputDirectory = new URL('../dist/', import.meta.url);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  'team-architecture-page.css',
  'chatroom-page.css',
].map(file =>
  copyFile(
    new URL(`../src/${file}`, import.meta.url),
    new URL(file, outputDirectory),
  )
));
