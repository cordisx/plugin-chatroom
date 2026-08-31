import type {
  AgentDefinition,
  AgentDefinitionIdentity,
  AgentFilter,
  AgentInheritanceMode,
  AgentObjectInheritanceMode,
} from '@cordisx/protocol/agent-loop/v2';
import {
  cloneAgentAvatarRef,
  createGeneratedAgentAvatarRef,
  resolveAgentDefinitionAvatar,
  type AgentAvatarInheritanceMode,
  type AgentAvatarRef,
} from '@cordisx/protocol/agent-avatar/v1';
import {
  parseChatroomAcknowledgeOverride,
  resolveChatroomAcknowledgeBehavior,
  type ChatroomAcknowledgeBehavior,
  type ChatroomAcknowledgeOverride,
} from './engagement-config.js';

export type {
  ChatroomAcknowledgeBehavior,
  ChatroomAcknowledgeMode,
  ChatroomAcknowledgeOverride,
} from './engagement-config.js';

export type {
  AgentDefinition,
  AgentDefinitionIdentity,
  AgentFilter,
  AgentInheritanceMode,
  AgentObjectInheritanceMode,
} from '@cordisx/protocol/agent-loop/v2';
export type { AgentAvatarInheritanceMode, AgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1';

export const AGENT_DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json' as const;
export const AGENT_DEFINITION_CONTRACT = 'cordisx.agent-definition/v1' as const;

export interface ChatroomAgentConfiguration {
  readonly seedLeaderIds: readonly [string, ...string[]];
  readonly members: readonly [ChatroomAgentMemberConfiguration, ...ChatroomAgentMemberConfiguration[]];
  readonly definitions: readonly [AgentDefinition, ...AgentDefinition[]];
  /** Chatroom behavior only; it is never serialized into AgentDefinition or prompts. */
  readonly acknowledge?: ChatroomAcknowledgeOverride;
}

export interface ChatroomAgentMemberConfiguration {
  readonly memberId: string;
  readonly participantId?: string;
  readonly label: string;
  readonly definition: AgentDefinitionIdentity;
  readonly role: 'leader' | 'member';
  readonly attentionPolicy: 'ambient' | 'mention-only';
  readonly reportsToMemberId?: string;
  /** Directed discovery edges used only while creating a Room snapshot. */
  readonly relatedMemberIds?: readonly string[];
  /** Overrides the Chatroom-level acknowledgement defaults for this member. */
  readonly acknowledge?: ChatroomAcknowledgeOverride;
}

export function acknowledgeBehaviorForMember(
  configuration: ChatroomAgentConfiguration,
  memberId: string,
): ChatroomAcknowledgeBehavior {
  const member = configuration.members.find(candidate => candidate.memberId === memberId);
  if (member === undefined) throw new Error('Acknowledgement member is not configured.');
  return resolveChatroomAcknowledgeBehavior(configuration.acknowledge, member.acknowledge);
}

const identityKey = (identity: AgentDefinitionIdentity) =>
  `${identity.agentId.length}:${identity.agentId}${identity.revision.length}:${identity.revision}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function parseIdentity(value: unknown, field: string): AgentDefinitionIdentity {
  if (!isRecord(value)) throw new Error(`${field} must be an Agent identity.`);
  return Object.freeze({
    agentId: requiredString(value.agentId, `${field}.agentId`),
    revision: requiredString(value.revision, `${field}.revision`),
  });
}

function stringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const result = value.map((item, index) => requiredString(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains a duplicate value.`);
  return Object.freeze(result);
}

function parseFilter(value: unknown, field: string): AgentFilter | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be a filter.`);
  const include = stringList(value.include, `${field}.include`);
  const exclude = stringList(value.exclude, `${field}.exclude`);
  return Object.freeze({ ...(include === undefined ? {} : { include }), ...(exclude === undefined ? {} : { exclude }) });
}

const orderedModes = new Set<AgentInheritanceMode>(['append', 'prepend', 'merge', 'replace', 'none']);
const objectModes = new Set<AgentObjectInheritanceMode>(['merge', 'replace', 'none']);
const avatarModes = new Set<AgentAvatarInheritanceMode>(['inherit', 'none']);
const promptKinds = new Set<NonNullable<AgentDefinition['promptSections']>[number]['kind']>([
  'introduction', 'personality', 'role', 'operations', 'tools', 'knowledge', 'memory-policy', 'memory', 'other',
]);

function mode<T extends string>(value: unknown, field: string, accepted: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !accepted.has(value as T)) throw new Error(`${field} has an unsupported inheritance mode.`);
  return value as T;
}

function parseDefinition(value: unknown, index: number): AgentDefinition {
  const field = `definitions[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an AgentDefinition.`);
  if (value.$schema !== AGENT_DEFINITION_SCHEMA || value.contract !== AGENT_DEFINITION_CONTRACT || value.schemaVersion !== 1) {
    throw new Error(`${field} does not use the AgentDefinition v1 contract.`);
  }
  if (!isRecord(value.inherit)) throw new Error(`${field}.inherit is required.`);
  const parents = value.extends === undefined
    ? undefined
    : Array.isArray(value.extends)
      ? Object.freeze(value.extends.map((item, parentIndex) => parseIdentity(item, `${field}.extends[${parentIndex}]`)))
      : (() => { throw new Error(`${field}.extends must be an array.`); })();
  const promptSections = value.promptSections === undefined
    ? undefined
    : Array.isArray(value.promptSections)
      ? Object.freeze(value.promptSections.map((item, sectionIndex) => {
        if (!isRecord(item)) throw new Error(`${field}.promptSections[${sectionIndex}] must be a section.`);
        const kind = requiredString(item.kind, `${field}.promptSections[${sectionIndex}].kind`);
        if (!promptKinds.has(kind as NonNullable<AgentDefinition['promptSections']>[number]['kind'])) {
          throw new Error(`${field}.promptSections[${sectionIndex}].kind is unsupported.`);
        }
        return Object.freeze({
          sectionId: requiredString(item.sectionId, `${field}.promptSections[${sectionIndex}].sectionId`),
          kind: kind as NonNullable<AgentDefinition['promptSections']>[number]['kind'],
          text: requiredString(item.text, `${field}.promptSections[${sectionIndex}].text`),
        });
      }))
      : (() => { throw new Error(`${field}.promptSections must be an array.`); })();
  if (promptSections !== undefined && new Set(promptSections.map(section => section.sectionId)).size !== promptSections.length) {
    throw new Error(`${field}.promptSections contains a duplicate sectionId.`);
  }
  const runtime = value.runtimeDefaults;
  if (runtime !== undefined && !isRecord(runtime)) throw new Error(`${field}.runtimeDefaults must be an object.`);
  const runtimeDefaults = runtime === undefined ? undefined : Object.freeze({
    ...(runtime.adapterId === undefined ? {} : { adapterId: requiredString(runtime.adapterId, `${field}.runtimeDefaults.adapterId`) }),
    ...(runtime.model === undefined ? {} : (() => {
      if (!isRecord(runtime.model)) throw new Error(`${field}.runtimeDefaults.model must be an object.`);
      return { model: Object.freeze({
        providerId: requiredString(runtime.model.providerId, `${field}.runtimeDefaults.model.providerId`),
        modelId: requiredString(runtime.model.modelId, `${field}.runtimeDefaults.model.modelId`),
      }) };
    })()),
    ...(runtime.effort === undefined ? {} : (() => {
      if (!['low', 'medium', 'high', 'xhigh'].includes(String(runtime.effort))) throw new Error(`${field}.runtimeDefaults.effort is unsupported.`);
      return { effort: runtime.effort as 'low' | 'medium' | 'high' | 'xhigh' };
    })()),
  });
  const name = optionalString(value.name, `${field}.name`);
  const description = optionalString(value.description, `${field}.description`);
  const avatar = value.avatar === undefined ? undefined : cloneAgentAvatarRef(value.avatar);
  const rules = stringList(value.rules, `${field}.rules`);
  const skills = stringList(value.skills, `${field}.skills`);
  const tools = parseFilter(value.tools, `${field}.tools`);
  const mcpServers = parseFilter(value.mcpServers, `${field}.mcpServers`);
  return Object.freeze({
    $schema: AGENT_DEFINITION_SCHEMA,
    contract: AGENT_DEFINITION_CONTRACT,
    schemaVersion: 1,
    identity: parseIdentity(value.identity, `${field}.identity`),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(avatar === undefined ? {} : { avatar }),
    ...(parents === undefined ? {} : { extends: parents }),
    inherit: Object.freeze({
      promptSections: mode(value.inherit.promptSections, `${field}.inherit.promptSections`, orderedModes),
      rules: mode(value.inherit.rules, `${field}.inherit.rules`, orderedModes),
      skills: mode(value.inherit.skills, `${field}.inherit.skills`, orderedModes),
      tools: mode(value.inherit.tools, `${field}.inherit.tools`, objectModes),
      mcpServers: mode(value.inherit.mcpServers, `${field}.inherit.mcpServers`, objectModes),
      runtimeDefaults: mode(value.inherit.runtimeDefaults, `${field}.inherit.runtimeDefaults`, objectModes),
      ...(value.inherit.avatar === undefined ? {} : {
        avatar: mode(value.inherit.avatar, `${field}.inherit.avatar`, avatarModes),
      }),
    }),
    ...(promptSections === undefined ? {} : { promptSections }),
    ...(rules === undefined ? {} : { rules }),
    ...(skills === undefined ? {} : { skills }),
    ...(tools === undefined ? {} : { tools }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(runtimeDefaults === undefined ? {} : { runtimeDefaults }),
  });
}

function validateCatalog(selections: readonly AgentDefinitionIdentity[], definitions: readonly AgentDefinition[]): void {
  const catalog = new Map<string, AgentDefinition>();
  for (const candidate of definitions) {
    const key = identityKey(candidate.identity);
    if (catalog.has(key)) throw new Error('AgentDefinition catalog contains a duplicate identity.');
    catalog.set(key, candidate);
  }
  const visiting = new Set<string>();
  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('AgentDefinition catalog contains an inheritance cycle.');
    if (reachable.has(key)) return;
    const candidate = catalog.get(key);
    if (candidate === undefined) throw new Error('AgentDefinition catalog is missing an ancestor.');
    visiting.add(key);
    for (const parent of candidate.extends ?? []) {
      const parentKey = identityKey(parent);
      if (parentKey === key) throw new Error('AgentDefinition cannot extend itself.');
      visit(parentKey);
    }
    visiting.delete(key);
    reachable.add(key);
  };
  for (const selection of selections) {
    const leafKey = identityKey(selection);
    if (!catalog.has(leafKey)) throw new Error('Selected AgentDefinition is missing from the catalog.');
    visit(leafKey);
  }
  if (reachable.size !== catalog.size) throw new Error('AgentDefinition catalog contains an unreachable definition.');
}

/** Returns the exact target-plus-ancestor closure required by one create-or-bind command. */
export function agentDefinitionCatalogFor(
  selection: AgentDefinitionIdentity,
  definitions: readonly [AgentDefinition, ...AgentDefinition[]],
): readonly [AgentDefinition, ...AgentDefinition[]] {
  const catalog = new Map(definitions.map(definition => [identityKey(definition.identity), definition]));
  const reachable = new Set<string>();
  const visit = (identity: AgentDefinitionIdentity): void => {
    const key = identityKey(identity);
    if (reachable.has(key)) return;
    const definition = catalog.get(key);
    if (definition === undefined) throw new Error('AgentDefinition catalog is missing an ancestor.');
    reachable.add(key);
    for (const parent of definition.extends ?? []) visit(parent);
  };
  visit(selection);
  const closure = definitions.filter(definition => reachable.has(identityKey(definition.identity)));
  validateCatalog([selection], closure);
  return Object.freeze(closure) as unknown as readonly [AgentDefinition, ...AgentDefinition[]];
}

/** Resolve one definition's immutable public Avatar ref with Protocol-owned semantics. */
export function agentAvatarForDefinition(
  selection: AgentDefinitionIdentity,
  definitions: readonly [AgentDefinition, ...AgentDefinition[]],
): AgentAvatarRef {
  const catalog = new Map(definitions.map(definition => [identityKey(definition.identity), definition]));
  const resolved = new Map<string, AgentAvatarRef>();
  const resolving = new Set<string>();
  const resolve = (identity: AgentDefinitionIdentity): AgentAvatarRef => {
    const key = identityKey(identity);
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;
    if (resolving.has(key)) throw new Error('AgentDefinition catalog contains an inheritance cycle.');
    const definition = catalog.get(key);
    if (definition === undefined) throw new Error('AgentDefinition catalog is missing an ancestor.');
    resolving.add(key);
    const parentAvatars = (definition.extends ?? []).map(resolve);
    const avatar = resolveAgentDefinitionAvatar({
      agentId: definition.identity.agentId,
      inherit: definition.inherit.avatar ?? 'none',
      ...(definition.avatar === undefined ? {} : { avatar: definition.avatar }),
      ...(parentAvatars.length === 0 ? {} : { parentAvatars }),
    });
    resolving.delete(key);
    resolved.set(key, avatar);
    return avatar;
  };
  return resolve(selection);
}

export function parseChatroomAgentConfiguration(value: unknown): ChatroomAgentConfiguration {
  if (!isRecord(value)) throw new Error('Agent configuration must be an object.');
  const seedLeaderIds = stringList(value.seedLeaderIds, 'seedLeaderIds');
  if (seedLeaderIds === undefined || seedLeaderIds.length === 0) {
    throw new Error('seedLeaderIds must be a non-empty array.');
  }
  if (!Array.isArray(value.members) || value.members.length === 0) {
    throw new Error('members must be a non-empty array.');
  }
  const members = Object.freeze(value.members.map((candidate, index) => {
    const field = `members[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${field} must be a member.`);
    const role = requiredString(candidate.role, `${field}.role`);
    if (role !== 'leader' && role !== 'member') throw new Error(`${field}.role is unsupported.`);
    const attentionPolicy = requiredString(candidate.attentionPolicy, `${field}.attentionPolicy`);
    if (attentionPolicy !== 'ambient' && attentionPolicy !== 'mention-only') {
      throw new Error(`${field}.attentionPolicy is unsupported.`);
    }
    return Object.freeze({
      memberId: requiredString(candidate.memberId, `${field}.memberId`),
      ...(candidate.participantId === undefined ? {} : {
        participantId: requiredString(candidate.participantId, `${field}.participantId`),
      }),
      label: requiredString(candidate.label, `${field}.label`),
      definition: parseIdentity(candidate.definition, `${field}.definition`),
      role,
      attentionPolicy,
      ...(candidate.reportsToMemberId === undefined ? {} : {
        reportsToMemberId: requiredString(candidate.reportsToMemberId, `${field}.reportsToMemberId`),
      }),
      ...(candidate.relatedMemberIds === undefined ? {} : {
        relatedMemberIds: stringList(candidate.relatedMemberIds, `${field}.relatedMemberIds`),
      }),
      ...(candidate.acknowledge === undefined ? {} : {
        acknowledge: parseChatroomAcknowledgeOverride(candidate.acknowledge, `${field}.acknowledge`),
      }),
    });
  })) as readonly [ChatroomAgentMemberConfiguration, ...ChatroomAgentMemberConfiguration[]];
  if (new Set(members.map(member => member.memberId)).size !== members.length) {
    throw new Error('members contains a duplicate memberId.');
  }
  const memberById = new Map(members.map(member => [member.memberId, member]));
  for (const seedLeaderId of seedLeaderIds) {
    if (memberById.get(seedLeaderId)?.role !== 'leader') {
      throw new Error('seedLeaderIds must reference configured leaders.');
    }
  }
  for (const member of members) {
    if (member.reportsToMemberId === member.memberId) throw new Error('A member cannot report to itself.');
    if (member.reportsToMemberId !== undefined && !memberById.has(member.reportsToMemberId)) {
      throw new Error('reportsToMemberId must reference a configured member.');
    }
    for (const relatedId of member.relatedMemberIds ?? []) {
      if (!memberById.has(relatedId)) throw new Error('relatedMemberIds must reference configured members.');
    }
  }
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const visitManager = (memberId: string): void => {
    if (visiting.has(memberId)) throw new Error('Agent team reporting graph contains a cycle.');
    if (resolved.has(memberId)) return;
    visiting.add(memberId);
    const manager = memberById.get(memberId)?.reportsToMemberId;
    if (manager !== undefined) visitManager(manager);
    visiting.delete(memberId);
    resolved.add(memberId);
  };
  for (const member of members) visitManager(member.memberId);
  if (!Array.isArray(value.definitions) || value.definitions.length === 0) {
    throw new Error('definitions must be a non-empty array.');
  }
  const definitions = Object.freeze(value.definitions.map(parseDefinition)) as readonly [AgentDefinition, ...AgentDefinition[]];
  validateCatalog(members.map(member => member.definition), definitions);
  return Object.freeze({
    seedLeaderIds: Object.freeze([...seedLeaderIds]) as readonly [string, ...string[]],
    members,
    definitions,
    ...(value.acknowledge === undefined ? {} : {
      acknowledge: parseChatroomAcknowledgeOverride(value.acknowledge, 'acknowledge'),
    }),
  });
}

export const CHATROOM_DEFAULT_AGENT = Object.freeze({
  $schema: AGENT_DEFINITION_SCHEMA,
  contract: AGENT_DEFINITION_CONTRACT,
  schemaVersion: 1,
  identity: Object.freeze({ agentId: 'chatroom.generalist', revision: 'chatroom-internal-v1' }),
  name: 'Chatroom Agent',
  description: 'An internal Agent for focused Room conversations.',
  avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'chatroom-fox' }),
  extends: Object.freeze([]),
  inherit: Object.freeze({
    promptSections: 'append', rules: 'merge', skills: 'merge',
    tools: 'replace', mcpServers: 'replace', runtimeDefaults: 'merge',
  }),
  promptSections: Object.freeze([
    Object.freeze({ sectionId: 'introduction', kind: 'introduction', text: 'You are the Agent assigned to this Chatroom Room.' }),
    Object.freeze({ sectionId: 'personality', kind: 'personality', text: 'Be concise, direct, and honest about unavailable capabilities.' }),
    Object.freeze({ sectionId: 'memory', kind: 'memory', text: 'Use only the context of the TaskBinding attached to this Room.' }),
  ]),
  rules: Object.freeze(['chatroom.room-isolation', 'chatroom.no-fabricated-replies']),
  skills: Object.freeze([]),
  tools: Object.freeze({ include: Object.freeze(['read', 'search']), exclude: Object.freeze(['external-channel']) }),
  mcpServers: Object.freeze({ exclude: Object.freeze(['external-channel']) }),
  runtimeDefaults: Object.freeze({ adapterId: 'codex', effort: 'medium' }),
} as const satisfies AgentDefinition);

export const CHATROOM_DEFAULT_REVIEWER = Object.freeze({
  $schema: AGENT_DEFINITION_SCHEMA,
  contract: AGENT_DEFINITION_CONTRACT,
  schemaVersion: 1,
  identity: Object.freeze({ agentId: 'chatroom.reviewer', revision: 'chatroom-internal-v1' }),
  name: 'Chatroom Reviewer',
  description: 'A second team member for focused review inside a Room.',
  avatar: createGeneratedAgentAvatarRef({
    namespace: 'agent-definition', agentId: 'chatroom-reviewer-animal',
  }),
  extends: Object.freeze([CHATROOM_DEFAULT_AGENT.identity]),
  inherit: Object.freeze({
    promptSections: 'append', rules: 'append', skills: 'append',
    tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
  }),
  promptSections: Object.freeze([
    Object.freeze({ sectionId: 'reviewer-role', kind: 'role', text: 'Review the work assigned to your member runs.' }),
  ]),
  rules: Object.freeze(['chatroom.public-room-summary-only']),
} as const satisfies AgentDefinition);

export const CHATROOM_DEFAULT_AGENT_CONFIGURATION = Object.freeze({
  seedLeaderIds: Object.freeze(['leader']),
  acknowledge: Object.freeze({
    mode: 'reaction', pendingReaction: '👀', completedReaction: '✅', failedReaction: '⚠️',
    messageTemplate: 'I’ll take a look.',
  }),
  members: Object.freeze([
    Object.freeze({
      memberId: 'leader', label: 'Lead', definition: CHATROOM_DEFAULT_AGENT.identity,
      role: 'leader', attentionPolicy: 'ambient', relatedMemberIds: Object.freeze([]),
    }),
    Object.freeze({
      memberId: 'reviewer', label: 'Reviewer', definition: CHATROOM_DEFAULT_REVIEWER.identity,
      role: 'member', attentionPolicy: 'mention-only', reportsToMemberId: 'leader', relatedMemberIds: Object.freeze([]),
    }),
  ]),
  definitions: Object.freeze([CHATROOM_DEFAULT_AGENT, CHATROOM_DEFAULT_REVIEWER]),
} as const satisfies ChatroomAgentConfiguration);
