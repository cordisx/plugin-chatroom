import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  CHATROOM_DEFAULT_AGENT,
  CHATROOM_DEFAULT_DOCUMENTATION,
  CHATROOM_DEFAULT_INTEGRATOR,
  CHATROOM_DEFAULT_QA,
  CHATROOM_DEFAULT_REVIEWER,
} from '../dist/agent-definition.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageManifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'cordisx-package.json'), 'utf8'));
const protocolEntry = new URL(import.meta.resolve('@cordisx/protocol/entities/v1'));
const schemaNames = [
  'ui-common.v1.schema.json',
  'channel-common.v1.schema.json',
  'host-dom-common.v1.schema.json',
  'platform-session.v1.schema.json',
  'route.v2.schema.json',
  'session-common.v1.schema.json',
  'agent-loop-common.v1.schema.json',
  'agents-common.v1.schema.json',
  'agent-avatar.v1.schema.json',
  'platform-model.v1.schema.json',
  'agent-definition.v1.schema.json',
  'plugin-lifecycle-common.v1.schema.json',
  'entity-common.v1.schema.json',
  'entity-file.v1.schema.json',
  'entity-template-declaration.v1.schema.json',
  'plugin-package.v5.schema.json',
  'plugin-manifest.v5.schema.json',
  'plugin-manifest.v6.schema.json',
  'plugin-package.v6.schema.json',
  'plugin-manifest.v8.schema.json',
  'plugin-package.v8.schema.json',
];
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const schemas = new Map(schemaNames.map(name => {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}`, protocolEntry), 'utf8'));
  ajv.addSchema(schema);
  return [name, schema];
}));

const validate = (name, value) => {
  const validator = ajv.getSchema(schemas.get(name).$id);
  assert.ok(validator, `${name} must compile`);
  assert.equal(validator(value), true, JSON.stringify(validator.errors));
};

const entityTreeDigest = files => {
  const chunks = [Buffer.from('cordisx.entity-tree/v1\0', 'utf8')];
  const ordered = [...files].sort((left, right) =>
    Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')));
  for (const file of ordered) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const contentBytes = Buffer.from(file.content, 'utf8');
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(contentBytes.length));
    chunks.push(pathLength, pathBytes, contentLength, contentBytes);
  }
  return `sha256:${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`;
};

const legacyDefinitions = new Map([
  CHATROOM_DEFAULT_AGENT,
  CHATROOM_DEFAULT_REVIEWER,
  CHATROOM_DEFAULT_INTEGRATOR,
  CHATROOM_DEFAULT_DOCUMENTATION,
  CHATROOM_DEFAULT_QA,
].map(definition => [definition.identity.agentId, definition]));

const materializeTemplate = declaration => {
  const entityPath = path.join(repositoryRoot, declaration.entityPath);
  const entityText = readFileSync(entityPath, 'utf8');
  const entity = JSON.parse(entityText);
  const entityRoot = path.dirname(entityPath);
  const promptFiles = [];
  const promptByPath = new Map();
  for (const section of entity.promptSections ?? []) {
    assert.equal(section.source.kind, 'markdown', `${entity.agentId} prompts must be editable Markdown files`);
    const relativePath = section.source.path.slice(2);
    const text = readFileSync(path.join(entityRoot, relativePath), 'utf8');
    promptFiles.push({ path: relativePath, content: text });
    promptByPath.set(section.source.path, text);
  }
  const actualPromptFiles = readdirSync(path.join(entityRoot, 'prompts'))
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `prompts/${name}`);
  assert.deepEqual([...new Set(promptFiles.map(file => file.path))].sort(), actualPromptFiles,
    `${entity.agentId} must declare every and only its packaged prompt files`);
  const digest = entityTreeDigest([{ path: 'entity.json', content: entityText }, ...promptFiles]);
  const { $schema: _schema, contract: _contract, schemaVersion: _version,
    agentId, promptSections, ...fields } = entity;
  return {
    entity,
    digest,
    definition: {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
      contract: 'cordisx.agent-definition/v1',
      schemaVersion: 1,
      identity: { agentId, revision: digest },
      ...fields,
      ...(promptSections === undefined ? {} : {
        promptSections: promptSections.map(section => ({
          sectionId: section.sectionId,
          kind: section.kind,
          text: promptByPath.get(section.source.path),
        })),
      }),
    },
  };
};

test('package v8 declares five schema-valid entity templates with exact framed digests', () => {
  validate('plugin-package.v8.schema.json', packageManifest);
  const runtimeManifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, packageManifest.runtimeManifest.path), 'utf8',
  ));
  validate('plugin-manifest.v8.schema.json', runtimeManifest);
  assert.equal(packageManifest.entityTemplates.length, 5);
  assert.deepEqual(packageManifest.entityTemplates.map(item => item.agentId), [
    'chatroom.generalist',
    'chatroom.reviewer',
    'chatroom.integrator',
    'chatroom.documentation',
    'chatroom.qa',
  ]);
  for (const declaration of packageManifest.entityTemplates) {
    validate('entity-template-declaration.v1.schema.json', declaration);
    assert.equal(declaration.entityPath, `./entities/${declaration.agentId}/entity.json`);
    const materialized = materializeTemplate(declaration);
    validate('entity-file.v1.schema.json', materialized.entity);
    validate('agent-definition.v1.schema.json', materialized.definition);
    assert.equal(materialized.digest, declaration.digest);
    for (const forbidden of ['identity', 'revision', 'digest', 'expectedDigest']) {
      assert.equal(forbidden in materialized.entity, false, `${declaration.agentId} source must omit ${forbidden}`);
    }
  }
});

test('templates preserve every accepted definition field while revision becomes the content digest', () => {
  const digestByAgentId = new Map(packageManifest.entityTemplates.map(declaration =>
    [declaration.agentId, declaration.digest]));
  for (const declaration of packageManifest.entityTemplates) {
    const { definition } = materializeTemplate(declaration);
    const legacy = legacyDefinitions.get(declaration.agentId);
    assert.ok(legacy);
    const expected = {
      ...legacy,
      identity: { agentId: legacy.identity.agentId, revision: declaration.digest },
      ...(legacy.extends === undefined ? {} : {
        extends: legacy.extends.map(parent => ({
          agentId: parent.agentId,
          revision: digestByAgentId.get(parent.agentId),
        })),
      }),
      ...(legacy.promptSections === undefined ? {} : {
        promptSections: legacy.promptSections.map(section => ({ ...section, text: `${section.text}\n` })),
      }),
    };
    assert.deepEqual(definition, expected);
  }
});

test('package pins the exact Protocol bootstrap-route and Host runtime releases with exact manifest bytes', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.devDependencies['@cordisx/protocol'],
    'github:cordisx/cordisx-protocol#be4905a7471e9829d2b834d9c3f17ac2404951f3');
  assert.equal(packageJson.devDependencies.cordisx,
    'github:cordisx/cordisx#08e73f7e2a3fc8e597bddc3d4806194f1cafece9');
  assert.equal(packageManifest.entry, './dist/chatroom.js');
  assert.equal(packageManifest.compatibility.protocolSchemas.includes(
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'), true);
  assert.equal(packageManifest.compatibility.protocolSchemas.includes(
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json'), true);
  const runtimeManifest = readFileSync(path.join(repositoryRoot, packageManifest.runtimeManifest.path), 'utf8');
  const digest = `sha256:${createHash('sha256').update(runtimeManifest).digest('hex')}`;
  assert.equal(digest, packageManifest.runtimeManifest.digest);
});

test('built package entry is self-contained apart from Host virtual modules', () => {
  const entry = readFileSync(path.join(repositoryRoot, packageManifest.entry), 'utf8');
  assert.ok(entry.length > 0);
  assert.equal(/(?:from|import)\s+["']@cordisx\/protocol/u.test(entry), false);
  assert.equal(/from\s+["']\.\.?\//u.test(entry), false);
  assert.equal(/import\s+["']\.\.?\//u.test(entry), false);
  assert.equal(entry.includes('team-architecture-page.css"'), false);
});
