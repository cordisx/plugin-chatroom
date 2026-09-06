import assert from 'node:assert/strict';
import test from 'node:test';

import { CHATROOM_DEFAULT_AGENT_CONFIGURATION, parseChatroomAgentConfiguration } from '../dist/agent-definition.js';
import {
  buildTeamArchitectureViewModel,
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
  assert.equal(new Set(configuration.members.map(member => member.label)).size, 18);
  assert.equal(configuration.members.find(member => member.memberId === 'leader')?.label, 'Avery Chen');
  assert.equal(configuration.members.find(member => member.memberId === 'leader')?.title, 'Team Lead');
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

const flattenSubtreeMemberIds = node => [
  node.entity.memberId,
  ...node.children.flatMap(flattenSubtreeMemberIds),
];

test('projects direct parents and the complete scoped descendant tree without siblings', () => {
  const entities = projectTeamEntities(complexConfiguration(), []);
  const backend = entities.find(entity => entity.memberId === 'backend');
  assert.ok(backend);
  const backendHierarchy = teamEntityLocalHierarchy(backend, entities);
  assert.deepEqual(backendHierarchy.parents.map(entity => entity.memberId), ['integrator']);
  assert.deepEqual(flattenSubtreeMemberIds(backendHierarchy.subtree), [
    'backend',
    'api-platform',
    'data-platform',
  ]);

  const integrator = entities.find(entity => entity.memberId === 'integrator');
  assert.ok(integrator);
  const integratorHierarchy = teamEntityLocalHierarchy(integrator, entities);
  assert.deepEqual(integratorHierarchy.parents.map(entity => entity.memberId), ['leader']);
  assert.deepEqual(flattenSubtreeMemberIds(integratorHierarchy.subtree), [
    'integrator',
    'backend',
    'api-platform',
    'data-platform',
    'frontend',
    'design-system',
    'infrastructure',
    'qa',
    'automation',
    'release-validation',
  ]);
  assert.equal(
    flattenSubtreeMemberIds(integratorHierarchy.subtree).some(memberId =>
      ['reviewer', 'documentation', 'product-research', 'product-design'].includes(memberId)
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
  assert.deepEqual(flattenSubtreeMemberIds(teamEntityLocalHierarchy(frontend, multiParentEntities).subtree), [
    'frontend',
    'design-system',
  ]);
});

test('projects and searches chosen member names separately from optional job titles', () => {
  const configuration = complexConfiguration();
  const entities = projectTeamEntities(configuration, []);
  const leader = entities.find(entity => entity.memberId === 'leader');
  assert.equal(leader?.label, 'Avery Chen');
  assert.equal(leader?.title, 'Team Lead');
  const titleSearch = buildTeamArchitectureViewModel(
    { configuration, rooms: [] },
    { query: 'Team Lead' },
  );
  assert.deepEqual([...titleSearch.matchedMemberIds], ['leader']);

  const legacy = projectTeamEntities(CHATROOM_DEFAULT_AGENT_CONFIGURATION, []);
  assert.equal(legacy.every(entity => entity.title === undefined), true);
  assert.equal(legacy[0].label, CHATROOM_DEFAULT_AGENT_CONFIGURATION.members[0].label);
});

test('keeps every ancestor on a deep search path so the canvas can reveal the match', () => {
  const configuration = complexConfiguration();
  const model = buildTeamArchitectureViewModel(
    { configuration, rooms: [] },
    { query: 'API Platform' },
  );
  assert.deepEqual([...model.matchedMemberIds], ['api-platform']);
  assert.deepEqual(model.roots.flatMap(flattenSubtreeMemberIds), [
    'leader',
    'integrator',
    'backend',
    'api-platform',
  ]);
});
