const member = (memberId, label, agentId, reportsToMemberId, role = 'member') =>
  Object.freeze({
    memberId,
    label,
    definition: Object.freeze({ agentId, revision: 'chatroom-internal-v1' }),
    role,
    attentionPolicy: role === 'leader' ? 'ambient' : 'mention-only',
    ...(reportsToMemberId === undefined ? {} : { reportsToMemberId }),
    relatedMemberIds: Object.freeze([]),
  });

const derivedDefinition = (memberId, label, parentAgentId) =>
  Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: Object.freeze({
      agentId: `chatroom.playground.${memberId}`,
      revision: 'chatroom-internal-v1',
    }),
    name: label,
    description: `${label} member for the Playground complex team.`,
    extends: Object.freeze([{ agentId: parentAgentId, revision: 'chatroom-internal-v1' }]),
    inherit: Object.freeze({
      promptSections: 'append',
      rules: 'append',
      skills: 'append',
      tools: 'merge',
      mcpServers: 'merge',
      runtimeDefaults: 'merge',
      avatar: 'inherit',
    }),
  });

const derivedMembers = Object.freeze([
  ['product-research', 'Product Research', 'chatroom.reviewer', 'reviewer'],
  ['product-design', 'Product Design', 'chatroom.documentation', 'product-research'],
  ['compliance', 'Compliance', 'chatroom.reviewer', 'reviewer'],
  ['localization', 'Localization', 'chatroom.documentation', 'documentation'],
  ['knowledge-base', 'Knowledge Base', 'chatroom.documentation', 'documentation'],
  ['frontend', 'Frontend', 'chatroom.integrator', 'integrator'],
  ['design-system', 'Design System', 'chatroom.documentation', 'frontend'],
  ['backend', 'Backend', 'chatroom.integrator', 'integrator'],
  ['api-platform', 'API Platform', 'chatroom.integrator', 'backend'],
  ['data-platform', 'Data Platform', 'chatroom.integrator', 'backend'],
  ['infrastructure', 'Infrastructure', 'chatroom.integrator', 'integrator'],
  ['automation', 'Automation', 'chatroom.qa', 'qa'],
  ['release-validation', 'Release Validation', 'chatroom.qa', 'qa'],
]);

export const PLAYGROUND_COMPLEX_TEAM_DEFINITIONS = Object.freeze(
  derivedMembers.map(([memberId, label, parentAgentId]) => derivedDefinition(memberId, label, parentAgentId)),
);

/** Playground-only complex organization. Production defaults remain five members. */
export const PLAYGROUND_COMPLEX_TEAM_MEMBERS = Object.freeze([
  member('leader', 'Lead', 'chatroom.generalist', undefined, 'leader'),
  member('reviewer', 'Reviewer', 'chatroom.reviewer', 'leader'),
  member('integrator', 'Integrator', 'chatroom.integrator', 'leader'),
  member('documentation', 'Documentation', 'chatroom.documentation', 'reviewer'),
  member('qa', 'QA', 'chatroom.qa', 'integrator'),
  ...derivedMembers.map(([memberId, label, _parentAgentId, reportsToMemberId]) =>
    member(memberId, label, `chatroom.playground.${memberId}`, reportsToMemberId)
  ),
]);
