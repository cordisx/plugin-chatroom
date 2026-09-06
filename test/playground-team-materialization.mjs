import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION } from '../dist/agent-definition.js';
import { configurationFromEntitySnapshot } from '../dist/entity-registry-configuration.js';
import { chatroomAgentConfigurationFromRuntimeConfig } from '../dist/runtime-config.js';
import { projectTeamEntities } from '../dist/team-entity-view-model.js';
import { PLAYGROUND_COMPLEX_TEAM_MEMBERS } from './fixtures/playground-complex-team.mjs';
import { materializePlaygroundTeamProfile } from './fixtures/playground-profile-config.mjs';

const team = {
  ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  seedLeaderIds: ['leader'],
  members: PLAYGROUND_COMPLEX_TEAM_MEMBERS,
};

const entitySnapshot = () => {
  const binding = {
    profileId: 'playground',
    installationId: 'chatroom-local',
    pluginId: 'chatroom',
    pluginGeneration: 1,
  };
  const revisionByAgentId = new Map(CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions.map((definition, index) => [
    definition.identity.agentId,
    `sha256:${String(index + 1).repeat(64)}`,
  ]));
  return {
    binding,
    entities: CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions.map(definition => {
      const revision = revisionByAgentId.get(definition.identity.agentId);
      const rebound = {
        ...definition,
        identity: { agentId: definition.identity.agentId, revision },
        extends: (definition.extends ?? []).map(parent => ({
          agentId: parent.agentId,
          revision: revisionByAgentId.get(parent.agentId),
        })),
      };
      return {
        identity: rebound.identity,
        digest: revision,
        definition: rebound,
        owner: {
          profileId: binding.profileId,
          installationId: binding.installationId,
          pluginId: binding.pluginId,
        },
        access: 'owned',
      };
    }),
  };
};

test('materializes the 18-member team through Host profile precedence and the apply entity path', () => {
  const plugin = {
    id: 'chatroom',
    config: { team },
    profiles: {
      playground: { revision: 1, config: { shortcutPolicy: 'mod-enter' } },
    },
  };
  assert.equal(
    chatroomAgentConfigurationFromRuntimeConfig(plugin.profiles.playground.config).members.length,
    5,
    'Host profile precedence explains the prior fallback to production defaults',
  );
  const materialized = materializePlaygroundTeamProfile(plugin);
  const runtimeConfig = materialized.profiles.playground.config;
  assert.equal(runtimeConfig.shortcutPolicy, 'mod-enter');
  const configured = chatroomAgentConfigurationFromRuntimeConfig(runtimeConfig);
  assert.equal(configured.members.length, 18);
  const rebound = configurationFromEntitySnapshot(configured, entitySnapshot());
  const entities = projectTeamEntities(rebound, []);
  assert.equal(entities.length, 18);
  const byId = new Map(entities.map(entity => [entity.memberId, entity]));
  const depth = memberId => {
    let current = byId.get(memberId);
    let value = 1;
    while (current?.relationships.reportsToMemberId !== undefined) {
      value += 1;
      current = byId.get(current.relationships.reportsToMemberId);
    }
    return value;
  };
  assert.ok(Math.max(...entities.map(entity => depth(entity.memberId))) >= 4);
  assert.equal(CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.length, 5);
});
