import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../src/team-architecture-page.css', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);
const destination = new URL('team-architecture-page.css', outputDirectory);

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);
