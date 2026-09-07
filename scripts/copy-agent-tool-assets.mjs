import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const source = new URL('../src/', import.meta.url);
const output = new URL('../dist/agent-tools/', import.meta.url);
await mkdir(output, { recursive: true });
await Promise.all(['cli', 'skills'].map(path => cp(new URL(path, source), new URL(path, output), { recursive: true })));
const descriptor = JSON.parse(await readFile(new URL('cordisx-agent-tools.json', source), 'utf8'));
const packaged = {
  ...descriptor,
  skills: descriptor.skills.map(skill => ({ ...skill, path: `./dist/agent-tools/${skill.path.slice(2)}` })),
  commands: descriptor.commands.map(command => ({ ...command, entry: `./dist/agent-tools/${command.entry.slice(2)}` })),
};
await writeFile(new URL('../cordisx-agent-tools.json', import.meta.url), `${JSON.stringify(packaged, null, 2)}\n`);
