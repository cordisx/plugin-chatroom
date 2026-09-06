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

/** Playground-only complex organization. Production defaults remain five members. */
export const PLAYGROUND_COMPLEX_TEAM_MEMBERS = Object.freeze([
  member('leader', 'Lead', 'chatroom.generalist', undefined, 'leader'),
  member('reviewer', 'Reviewer', 'chatroom.reviewer', 'leader'),
  member('integrator', 'Integrator', 'chatroom.integrator', 'leader'),
  member('documentation', 'Documentation', 'chatroom.documentation', 'reviewer'),
  member('qa', 'QA', 'chatroom.qa', 'integrator'),
  member('product-research', 'Product Research', 'chatroom.reviewer', 'reviewer'),
  member('product-design', 'Product Design', 'chatroom.documentation', 'product-research'),
  member('compliance', 'Compliance', 'chatroom.reviewer', 'reviewer'),
  member('localization', 'Localization', 'chatroom.documentation', 'documentation'),
  member('knowledge-base', 'Knowledge Base', 'chatroom.documentation', 'documentation'),
  member('frontend', 'Frontend', 'chatroom.integrator', 'integrator'),
  member('design-system', 'Design System', 'chatroom.documentation', 'frontend'),
  member('backend', 'Backend', 'chatroom.integrator', 'integrator'),
  member('api-platform', 'API Platform', 'chatroom.integrator', 'backend'),
  member('data-platform', 'Data Platform', 'chatroom.integrator', 'backend'),
  member('infrastructure', 'Infrastructure', 'chatroom.integrator', 'integrator'),
  member('automation', 'Automation', 'chatroom.qa', 'qa'),
  member('release-validation', 'Release Validation', 'chatroom.qa', 'qa'),
]);
