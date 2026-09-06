const member = (memberId, label, title, agentId, reportsToMemberId, role = 'member') =>
  Object.freeze({
    memberId,
    label,
    title,
    definition: Object.freeze({ agentId, revision: 'chatroom-internal-v1' }),
    role,
    attentionPolicy: role === 'leader' ? 'ambient' : 'mention-only',
    ...(reportsToMemberId === undefined ? {} : { reportsToMemberId }),
    relatedMemberIds: Object.freeze([]),
  });

const derivedDefinition = (memberId, title, parentAgentId) =>
  Object.freeze({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: Object.freeze({
      agentId: `chatroom.playground.${memberId}`,
      revision: 'chatroom-internal-v1',
    }),
    name: title,
    description: `${title} member for the Playground complex team.`,
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
  ['product-research', 'Taylor Xu', 'Product Research', 'chatroom.reviewer', 'reviewer'],
  ['product-design', 'Quinn Zhao', 'Product Design', 'chatroom.documentation', 'product-research'],
  ['compliance', 'Reese Sun', 'Compliance', 'chatroom.reviewer', 'reviewer'],
  ['localization', 'Parker Liu', 'Localization', 'chatroom.documentation', 'documentation'],
  ['knowledge-base', 'Sydney Gu', 'Knowledge Base', 'chatroom.documentation', 'documentation'],
  ['frontend', 'Cameron He', 'Frontend', 'chatroom.integrator', 'integrator'],
  ['design-system', 'Drew Tang', 'Design System', 'chatroom.documentation', 'frontend'],
  ['backend', 'Rowan Zhou', 'Backend', 'chatroom.integrator', 'integrator'],
  ['api-platform', 'Blake Yang', 'API Platform', 'chatroom.integrator', 'backend'],
  ['data-platform', 'Sage Han', 'Data Platform', 'chatroom.integrator', 'backend'],
  ['infrastructure', 'Alex Gao', 'Infrastructure', 'chatroom.integrator', 'integrator'],
  ['automation', 'Jamie Luo', 'Automation', 'chatroom.qa', 'qa'],
  ['release-validation', 'Robin Fang', 'Release Validation', 'chatroom.qa', 'qa'],
]);

export const PLAYGROUND_COMPLEX_TEAM_DEFINITIONS = Object.freeze(
  derivedMembers.map(([memberId, _label, title, parentAgentId]) => derivedDefinition(memberId, title, parentAgentId)),
);

/** Playground-only complex organization. Production defaults remain five members. */
export const PLAYGROUND_COMPLEX_TEAM_MEMBERS = Object.freeze([
  member('leader', 'Avery Chen', 'Team Lead', 'chatroom.generalist', undefined, 'leader'),
  member('reviewer', 'Riley Park', 'Reviewer', 'chatroom.reviewer', 'leader'),
  member('integrator', 'Morgan Lee', 'Integrator', 'chatroom.integrator', 'leader'),
  member('documentation', 'Casey Wu', 'Documentation', 'chatroom.documentation', 'reviewer'),
  member('qa', 'Jordan Lin', 'QA', 'chatroom.qa', 'integrator'),
  ...derivedMembers.map(([memberId, label, title, _parentAgentId, reportsToMemberId]) =>
    member(memberId, label, title, `chatroom.playground.${memberId}`, reportsToMemberId)
  ),
]);
