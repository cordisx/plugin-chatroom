import { copyFile, mkdir, readdir } from 'node:fs/promises';

const outputDirectory = new URL('../dist/', import.meta.url);

await mkdir(outputDirectory, { recursive: true });
const styles = (await readdir(new URL('../src/', import.meta.url))).filter(file => file.endsWith('.css'));
await Promise.all(styles.map(file =>
  copyFile(
    new URL(`../src/${file}`, import.meta.url),
    new URL(file, outputDirectory),
  )
));
