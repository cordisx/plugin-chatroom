import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_DEFINITION_CONTRACT,
  AGENT_DEFINITION_SCHEMA,
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  agentAvatarForDefinition,
  agentDefinitionCatalogFor,
  parseChatroomAgentConfiguration,
} from '../dist/agent-definition.js';

const inherit = Object.freeze({
  promptSections: 'append', rules: 'merge', skills: 'merge',
  tools: 'replace', mcpServers: 'replace', runtimeDefaults: 'merge',
});

const definition = (agentId, revision, extra = {}) => ({
  $schema: AGENT_DEFINITION_SCHEMA,
  contract: AGENT_DEFINITION_CONTRACT,
  schemaVersion: 1,
  identity: { agentId, revision },
  inherit,
  ...extra,
});

const team = (definitions, members = definitions.map((item, index) => ({
  memberId: index === 0 ? 'leader' : `member-${index}`,
  label: index === 0 ? 'Lead' : `Member ${index}`,
  definition: item.identity,
  role: index === 0 ? 'leader' : 'member',
  attentionPolicy: index === 0 ? 'ambient' : 'mention-only',
  ...(index === 0 ? {} : { reportsToMemberId: 'leader' }),
}))) => ({ seedLeaderIds: ['leader'], members, definitions });

test('parses and freezes a complete OneWorks-style Agent catalog', () => {
  const base = definition('base', 'v1', {
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'You are an Agent.' }],
    rules: ['base-rule'], skills: ['base-skill'], tools: { include: ['read'] },
    mcpServers: { exclude: ['external-channel'] }, runtimeDefaults: { adapterId: 'codex', effort: 'medium' },
  });
  const leaf = definition('reviewer', 'v2', {
    extends: [base.identity],
    promptSections: [
      { sectionId: 'personality', kind: 'personality', text: 'Be direct.' },
      { sectionId: 'memory', kind: 'memory', text: 'Use only this task context.' },
    ],
    rules: ['review-rule'], skills: ['review-skill'],
    tools: { include: ['search'] }, mcpServers: { exclude: ['production'] },
    runtimeDefaults: { model: { providerId: 'openai', modelId: 'gpt-5' }, effort: 'high' },
  });
  const parsed = parseChatroomAgentConfiguration(team([base, leaf], [
    { memberId: 'leader', label: 'Reviewer', definition: leaf.identity, role: 'leader', attentionPolicy: 'ambient' },
  ]));

  assert.deepEqual(parsed.members[0].definition, { agentId: 'reviewer', revision: 'v2' });
  assert.deepEqual(parsed.definitions[1].promptSections.map(section => section.kind), ['personality', 'memory']);
  assert.deepEqual(parsed.definitions[1].runtimeDefaults, {
    model: { providerId: 'openai', modelId: 'gpt-5' }, effort: 'high',
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.definitions), true);
  assert.equal(Object.isFrozen(parsed.definitions[1].promptSections), true);
});

test('rejects missing ancestors, cycles, duplicates, and unreachable definitions', () => {
  const base = definition('base', 'v1');
  const leaf = definition('leaf', 'v1', { extends: [base.identity] });
  assert.throws(
    () => parseChatroomAgentConfiguration(team([leaf])),
    /missing an ancestor/,
  );
  assert.throws(
    () => parseChatroomAgentConfiguration(team([base, base], [{ memberId: 'leader', label: 'Lead', definition: base.identity, role: 'leader', attentionPolicy: 'ambient' }])),
    /duplicate identity/,
  );
  assert.throws(
    () => parseChatroomAgentConfiguration(team([base, definition('extra', 'v1')], [{ memberId: 'leader', label: 'Lead', definition: base.identity, role: 'leader', attentionPolicy: 'ambient' }])),
    /unreachable definition/,
  );
  const first = definition('first', 'v1', { extends: [{ agentId: 'second', revision: 'v1' }] });
  const second = definition('second', 'v1', { extends: [first.identity] });
  assert.throws(
    () => parseChatroomAgentConfiguration(team([first, second], [{ memberId: 'leader', label: 'Lead', definition: first.identity, role: 'leader', attentionPolicy: 'ambient' }])),
    /inheritance cycle/,
  );
});

test('ships introduction, personality, and memory with isolated runtime/filter defaults', () => {
  const parsed = parseChatroomAgentConfiguration(CHATROOM_DEFAULT_AGENT_CONFIGURATION);
  const selected = parsed.definitions[0];
  assert.equal(parsed.members.length, 2);
  assert.deepEqual(parsed.seedLeaderIds, ['leader']);
  assert.deepEqual(parsed.members.map(member => [member.role, member.attentionPolicy]), [
    ['leader', 'ambient'], ['member', 'mention-only'],
  ]);
  assert.deepEqual(selected.promptSections.map(section => section.kind), ['introduction', 'personality', 'memory']);
  assert.deepEqual(selected.tools, { include: ['read', 'search'], exclude: ['external-channel'] });
  assert.deepEqual(selected.mcpServers, { exclude: ['external-channel'] });
  assert.deepEqual(selected.runtimeDefaults, { adapterId: 'codex', effort: 'medium' });
  assert.deepEqual(parsed.definitions.map(item => item.avatar), [
    {
      kind: 'generated', algorithm: 'oneworks-avatar-seed', algorithmVersion: 1,
      seed: 'cordisx.agent-avatar.seed/v1:agent-definition:12:chatroom-fox',
    },
    {
      kind: 'generated', algorithm: 'oneworks-avatar-seed', algorithmVersion: 1,
      seed: 'cordisx.agent-avatar.seed/v1:agent-definition:24:chatroom-reviewer-animal',
    },
  ]);
  assert.deepEqual(parsed.members.map(member => agentAvatarForDefinition(member.definition, parsed.definitions)),
    parsed.definitions.map(item => item.avatar));
});

test('builds one exact target ancestor closure without unrelated child definitions', () => {
  const parsed = parseChatroomAgentConfiguration(CHATROOM_DEFAULT_AGENT_CONFIGURATION);
  const lead = agentDefinitionCatalogFor(parsed.members[0].definition, parsed.definitions);
  const reviewer = agentDefinitionCatalogFor(parsed.members[1].definition, parsed.definitions);

  assert.deepEqual(lead.map(definition => definition.identity.agentId), ['chatroom.generalist']);
  assert.deepEqual(reviewer.map(definition => definition.identity.agentId), ['chatroom.generalist', 'chatroom.reviewer']);
});

test('parses, freezes, and resolves formal Agent Avatar inheritance', () => {
  const parent = definition('parent', 'v1', {
    avatar: { kind: 'asset', ref: 'avatar-assets:parent', revision: 'avatar-assets:revision-1' },
  });
  const laterParent = definition('later-parent', 'v1', {
    avatar: { kind: 'definition', ref: 'avatar-definitions:later', schema: 'oneworks.avatar', definitionVersion: 1 },
  });
  const child = definition('child', 'v2', {
    extends: [parent.identity, laterParent.identity],
    inherit: { ...inherit, avatar: 'inherit' },
  });
  const parsed = parseChatroomAgentConfiguration(team([parent, laterParent, child], [{
    memberId: 'leader', label: 'Child', definition: child.identity, role: 'leader', attentionPolicy: 'ambient',
  }]));

  assert.deepEqual(parsed.definitions[0].avatar, {
    kind: 'asset', ref: 'avatar-assets:parent', revision: 'avatar-assets:revision-1',
  });
  assert.equal(Object.isFrozen(parsed.definitions[0].avatar), true);
  assert.deepEqual(agentAvatarForDefinition(child.identity, parsed.definitions), parsed.definitions[1].avatar);
});

test('uses formal child-identity fallback and rejects raw Avatar assets', () => {
  const first = parseChatroomAgentConfiguration(team([definition(' reviewer ', 'v1')]));
  const second = parseChatroomAgentConfiguration(team([definition(' reviewer ', 'v9')]));
  const expected = {
    kind: 'generated', algorithm: 'oneworks-avatar-seed', algorithmVersion: 1,
    seed: 'cordisx.agent-avatar.seed/v1:agent-definition:8:reviewer',
  };
  assert.deepEqual(agentAvatarForDefinition(first.members[0].definition, first.definitions), expected);
  assert.deepEqual(agentAvatarForDefinition(second.members[0].definition, second.definitions), expected);

  const parent = definition('parent', 'v1', { avatar: { kind: 'asset', ref: 'avatar-assets:parent' } });
  const child = definition('child-none', 'v1', {
    extends: [parent.identity], inherit: { ...inherit, avatar: 'none' },
  });
  const none = parseChatroomAgentConfiguration(team([parent, child], [{
    memberId: 'leader', label: 'Child', definition: child.identity, role: 'leader', attentionPolicy: 'ambient',
  }]));
  assert.equal(agentAvatarForDefinition(child.identity, none.definitions).seed,
    'cordisx.agent-avatar.seed/v1:agent-definition:10:child-none');

  assert.throws(() => parseChatroomAgentConfiguration(team([definition('bad', 'v1', {
    avatar: { kind: 'asset', ref: 'https://example.test/avatar.png' },
  })])), /qualified opaque ref/);
});

test('supports multiple leaders, leader-to-leader reporting, and rejects reporting cycles', () => {
  const base = definition('base', 'v1');
  const parsed = parseChatroomAgentConfiguration({
    seedLeaderIds: ['root'], definitions: [base], members: [
      { memberId: 'root', label: 'Root', definition: base.identity, role: 'leader', attentionPolicy: 'ambient' },
      { memberId: 'area', label: 'Area', definition: base.identity, role: 'leader', attentionPolicy: 'ambient', reportsToMemberId: 'root' },
    ],
  });
  assert.deepEqual(parsed.members.map(member => [member.memberId, member.reportsToMemberId]), [
    ['root', undefined], ['area', 'root'],
  ]);
  assert.throws(() => parseChatroomAgentConfiguration({
    ...parsed,
    seedLeaderIds: ['root'],
    members: [
      { ...parsed.members[0], reportsToMemberId: 'area' },
      parsed.members[1],
    ],
  }), /reporting graph contains a cycle/);
});
