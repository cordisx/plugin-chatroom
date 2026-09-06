import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION, parseChatroomAgentConfiguration } from '../dist/agent-definition.js';
import {
  projectTeamEntities,
  teamEntityLocalHierarchy,
  teamEntityPromptSources,
} from '../dist/team-entity-view-model.js';
import {
  PLAYGROUND_COMPLEX_TEAM_DEFINITIONS,
  PLAYGROUND_COMPLEX_TEAM_MEMBERS,
} from './fixtures/playground-complex-team.mjs';

const complexConfiguration = () =>
  parseChatroomAgentConfiguration({
    ...CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    seedLeaderIds: ['leader'],
    members: PLAYGROUND_COMPLEX_TEAM_MEMBERS,
    definitions: [
      ...CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions,
      ...PLAYGROUND_COMPLEX_TEAM_DEFINITIONS,
    ],
  });

test('keeps the complex organization Playground-only with 18 members and at least four levels', () => {
  assert.equal(CHATROOM_DEFAULT_AGENT_CONFIGURATION.members.length, 5);
  const configuration = complexConfiguration();
  assert.equal(configuration.members.length, 18);
  const byId = new Map(configuration.members.map(value => [value.memberId, value]));
  const depth = memberId => {
    let current = byId.get(memberId);
    let value = 1;
    while (current?.reportsToMemberId !== undefined) {
      value += 1;
      current = byId.get(current.reportsToMemberId);
    }
    return value;
  };
  assert.ok(Math.max(...configuration.members.map(value => depth(value.memberId))) >= 4);
});

test('groups prompt sources in upstream-then-current order with friendly definition names', () => {
  const entities = projectTeamEntities(complexConfiguration(), []);
  const reviewer = entities.find(entity => entity.memberId === 'reviewer');
  assert.ok(reviewer);
  const sources = teamEntityPromptSources(reviewer, entities);
  assert.deepEqual(sources.map(source => source.kind), ['upstream', 'current']);
  assert.deepEqual(sources.map(source => source.label), ['Chatroom Agent', 'Chatroom Reviewer']);
  assert.equal(sources.every(source => !source.label.includes('chatroom-internal-v1')), true);
});

const flattenSubtreeLabels = node => [
  node.entity.label,
  ...node.children.flatMap(flattenSubtreeLabels),
];

test('projects direct parents and the complete scoped descendant tree without siblings', () => {
  const entities = projectTeamEntities(complexConfiguration(), []);
  const backend = entities.find(entity => entity.memberId === 'backend');
  assert.ok(backend);
  const backendHierarchy = teamEntityLocalHierarchy(backend, entities);
  assert.deepEqual(backendHierarchy.parents.map(entity => entity.label), ['Integrator']);
  assert.deepEqual(flattenSubtreeLabels(backendHierarchy.subtree), [
    'Backend',
    'API Platform',
    'Data Platform',
  ]);

  const integrator = entities.find(entity => entity.memberId === 'integrator');
  assert.ok(integrator);
  const integratorHierarchy = teamEntityLocalHierarchy(integrator, entities);
  assert.deepEqual(integratorHierarchy.parents.map(entity => entity.label), ['Lead']);
  assert.deepEqual(flattenSubtreeLabels(integratorHierarchy.subtree), [
    'Integrator',
    'Backend',
    'API Platform',
    'Data Platform',
    'Frontend',
    'Design System',
    'Infrastructure',
    'QA',
    'Automation',
    'Release Validation',
  ]);
  assert.equal(
    flattenSubtreeLabels(integratorHierarchy.subtree).some(label =>
      ['Reviewer', 'Documentation', 'Product Research', 'Product Design'].includes(label)
    ),
    false,
  );

  const frontend = entities.find(entity => entity.memberId === 'frontend');
  assert.ok(frontend);
  const multiParentEntities = entities.map(entity =>
    entity.memberId !== backend.memberId
      ? entity
      : {
        ...entity,
        relationships: {
          ...entity.relationships,
          directReportMemberIds: [...entity.relationships.directReportMemberIds, frontend.memberId],
        },
      }
  );
  assert.deepEqual(
    teamEntityLocalHierarchy(frontend, multiParentEntities).parents.map(entity => entity.memberId),
    ['integrator', 'backend'],
  );
  assert.deepEqual(flattenSubtreeLabels(teamEntityLocalHierarchy(frontend, multiParentEntities).subtree), [
    'Frontend',
    'Design System',
  ]);
});
