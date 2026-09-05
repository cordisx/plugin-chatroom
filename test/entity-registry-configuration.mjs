import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { configurationFromEntitySnapshot } from '../dist/entity-registry-configuration.js';

const digests = new Map([
  ['chatroom.generalist', 'sha256:d575374eff842409dc411d39812ec65657067446ffd991475efba6a497ec38f0'],
  ['chatroom.reviewer', 'sha256:5c52ac24a8eb4592c0919336fbc804bd117741c22b108af030c83b8ef590512d'],
  ['chatroom.integrator', 'sha256:cf89bc7dc1406f57369a29cfda1ad0bd826ea84f02b845a0660d36f7d269004b'],
  ['chatroom.documentation', 'sha256:64e5a6f1268a792380318e419520c7bdea9695ead0a0d08dfc30565b9273d045'],
  ['chatroom.qa', 'sha256:161da39865680f98bad1aef6aab6036b0d9921dfe7a88150d9252c06cce7d521'],
]);
const binding = {
  profileId: 'preview',
  installationId: 'chatroom-local',
  pluginId: 'chatroom',
  pluginGeneration: 3,
};
const owner = {
  profileId: binding.profileId,
  installationId: binding.installationId,
  pluginId: binding.pluginId,
};

const snapshot = () => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-snapshot.v1.schema.json',
  contract: 'cordisx.entity-registry-snapshot/v1',
  schemaVersion: 1,
  binding,
  registryRevision: 5,
  entities: CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions.map(definition => {
    const revision = digests.get(definition.identity.agentId);
    const rebound = {
      ...definition,
      identity: { agentId: definition.identity.agentId, revision },
      ...(definition.extends === undefined ? {} : {
        extends: definition.extends.map(parent => ({
          agentId: parent.agentId,
          revision: digests.get(parent.agentId),
        })),
      }),
    };
    return {
      identity: rebound.identity,
      digest: revision,
      definition: rebound,
      owner,
      access: 'owned',
      origin: 'materialized-template',
    };
  }),
});

test('current owned EntityRecords replace inline definitions and member revisions atomically', () => {
  const current = snapshot();
  current.entities.push({
    ...current.entities[0],
    identity: { agentId: 'shared.helper', revision: `sha256:${'f'.repeat(64)}` },
    digest: `sha256:${'f'.repeat(64)}`,
    definition: {
      ...current.entities[0].definition,
      identity: { agentId: 'shared.helper', revision: `sha256:${'f'.repeat(64)}` },
    },
    owner: { ...owner, installationId: 'another-installation', pluginId: 'another-plugin' },
    access: 'shared-read',
  });
  const configuration = configurationFromEntitySnapshot(
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    current,
  );

  assert.deepEqual(configuration.members.map(member => member.definition), [
    { agentId: 'chatroom.generalist', revision: digests.get('chatroom.generalist') },
    { agentId: 'chatroom.reviewer', revision: digests.get('chatroom.reviewer') },
    { agentId: 'chatroom.integrator', revision: digests.get('chatroom.integrator') },
    { agentId: 'chatroom.documentation', revision: digests.get('chatroom.documentation') },
    { agentId: 'chatroom.qa', revision: digests.get('chatroom.qa') },
  ]);
  assert.deepEqual(configuration.definitions, current.entities.slice(0, 5).map(record => record.definition));
  assert.deepEqual(configuration.members.map(member => member.reportsToMemberId), [
    undefined,
    'leader',
    'leader',
    'reviewer',
    'integrator',
  ]);
});

test('activation fails closed when a configured entity is absent', () => {
  const current = snapshot();
  current.entities = current.entities.filter(record => record.identity.agentId !== 'chatroom.qa');
  assert.throws(
    () => configurationFromEntitySnapshot(CHATROOM_DEFAULT_AGENT_CONFIGURATION, current),
    /Entity registry is missing chatroom\.qa/,
  );
});
