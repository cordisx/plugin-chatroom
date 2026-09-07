import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8'))
  );
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
  const promptRoot = path.join(entityRoot, 'prompts');
  const actualPromptFiles = existsSync(promptRoot)
    ? readdirSync(promptRoot)
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(name => `prompts/${name}`)
    : [];
  assert.deepEqual(
    [...new Set(promptFiles.map(file => file.path))].sort(),
    actualPromptFiles,
    `${entity.agentId} must declare every and only its packaged prompt files`,
  );
  const digest = entityTreeDigest([{ path: 'entity.json', content: entityText }, ...promptFiles]);
  const { $schema: _schema, contract: _contract, schemaVersion: _version, agentId, promptSections, ...fields } = entity;
  return {
    entity,
    digest,
    definition: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
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

test('package v8 declares unique schema-valid production and Playground entity templates', () => {
  validate('plugin-package.v8.schema.json', packageManifest);
  const runtimeManifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, packageManifest.runtimeManifest.path),
    'utf8',
  ));
  validate('plugin-manifest.v8.schema.json', runtimeManifest);
  assert.equal(packageManifest.entityTemplates.length, 18);
  assert.deepEqual(packageManifest.entityTemplates.map(item => item.agentId), [
    'chatroom.generalist',
    'chatroom.reviewer',
    'chatroom.integrator',
    'chatroom.documentation',
    'chatroom.qa',
    'chatroom.playground.product-research',
    'chatroom.playground.product-design',
    'chatroom.playground.compliance',
    'chatroom.playground.localization',
    'chatroom.playground.knowledge-base',
    'chatroom.playground.frontend',
    'chatroom.playground.design-system',
    'chatroom.playground.backend',
    'chatroom.playground.api-platform',
    'chatroom.playground.data-platform',
    'chatroom.playground.infrastructure',
    'chatroom.playground.automation',
    'chatroom.playground.release-validation',
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
  const digestByAgentId = new Map(
    packageManifest.entityTemplates.map(declaration => [declaration.agentId, declaration.digest]),
  );
  for (const declaration of packageManifest.entityTemplates) {
    const { definition } = materializeTemplate(declaration);
    const legacy = legacyDefinitions.get(declaration.agentId);
    if (legacy === undefined) {
      assert.match(definition.identity.agentId, /^chatroom\.playground\./u);
      assert.equal(definition.extends?.length, 1);
      assert.equal(definition.extends[0].revision, digestByAgentId.get(definition.extends[0].agentId));
      assert.equal(definition.inherit.avatar, 'inherit');
      continue;
    }
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

test('package pins the exact experimental Protocol and Host agent-tools candidates with exact manifest bytes', () => {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.devDependencies['@cordisx/protocol'],
    'github:cordisx/cordisx-protocol#10d935066f95be1acfb262a112209b6135c58174',
  );
  assert.equal(
    packageJson.devDependencies.cordisx,
    'github:cordisx/cordisx#a4b9c0c8ef8197b0257d5b514fd396461862a851',
  );
  assert.equal(packageJson.main, packageManifest.entry);
  assert.equal(packageManifest.entry, './dist/runtime/chatroom.js');
  assert.equal(
    packageManifest.compatibility.protocolSchemas.includes(
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json',
    ),
    true,
  );
  assert.equal(
    packageManifest.compatibility.protocolSchemas.includes(
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v8.schema.json',
    ),
    true,
  );
  const runtimeManifest = readFileSync(path.join(repositoryRoot, packageManifest.runtimeManifest.path), 'utf8');
  const digest = `sha256:${createHash('sha256').update(runtimeManifest).digest('hex')}`;
  assert.equal(digest, packageManifest.runtimeManifest.digest);
});

test('built package entry delegates only through the declared runtime graph', () => {
  const artifact = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'dist/runtime/artifact.json'),
    'utf8',
  ));
  assert.equal(artifact.contract, 'cordisx.plugin-generation-artifact/v1');
  assert.equal(packageManifest.entry, `./dist/runtime/${artifact.entry.slice(2)}`);
  assert.deepEqual(artifact.initialStyles, []);
  assert.equal(
    artifact.files.filter(file =>
      file.kind === 'module'
      && file.path.includes('chatroom-page-')
      && !file.path.includes('chatroom-page-loader-')
    ).length,
    1,
  );
  const entry = readFileSync(path.join(repositoryRoot, packageManifest.entry), 'utf8');
  assert.ok(entry.length > 0);
  assert.equal(/(?:from|import)\s+["']@cordisx\/protocol/u.test(entry), false);
  assert.equal(entry.includes('team-architecture-page.css"'), false);
});
