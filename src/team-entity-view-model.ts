import {
  agentAvatarForDefinition,
  type AgentDefinition,
  type AgentDefinitionIdentity,
} from './agent-definition.js';
import type {
  ChatroomRoomRegistry,
  Room,
  RoomRun,
  StoredRoomRunDetailsUrl,
} from './room.js';
import type { ChatroomAgentConfiguration } from './agent-definition.js';

export type TeamEntityRoleFilter = 'all' | 'leader' | 'member';
export type TeamEntitySessionFilter = 'all' | 'active' | 'without-active';
export type TeamEntityRelationshipFilter = 'all' | 'root' | 'reports-to' | 'unestablished';

export interface TeamEntityFilters {
  readonly query?: string;
  readonly role?: TeamEntityRoleFilter;
  readonly session?: TeamEntitySessionFilter;
  readonly relationship?: TeamEntityRelationshipFilter;
}

export interface TeamEntityActiveSession {
  readonly roomId: string;
  readonly roomTitle: string;
  readonly participantId: string;
  readonly runId: string;
  readonly runTitle: string;
  readonly status: RoomRun['status'];
  readonly detailsUrl: StoredRoomRunDetailsUrl;
}

export interface TeamEntityDeclaredCapabilities {
  readonly promptSections: readonly Readonly<{
    readonly sectionId: string;
    readonly kind: NonNullable<AgentDefinition['promptSections']>[number]['kind'];
    readonly text: string;
    readonly provenance: 'direct';
  }>[];
  readonly rules: readonly string[];
  readonly skills: readonly string[];
  readonly tools: Readonly<{
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  }>;
  readonly mcpServers: Readonly<{
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  }>;
  readonly runtime: Readonly<{
    readonly adapterId?: string;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh';
  }>;
  readonly inheritance?: Readonly<{
    readonly promptSections: AgentDefinition['inherit']['promptSections'];
    readonly rules: AgentDefinition['inherit']['rules'];
    readonly skills: AgentDefinition['inherit']['skills'];
    readonly tools: AgentDefinition['inherit']['tools'];
    readonly mcpServers: AgentDefinition['inherit']['mcpServers'];
    readonly runtimeDefaults: AgentDefinition['inherit']['runtimeDefaults'];
    readonly avatar?: NonNullable<AgentDefinition['inherit']['avatar']>;
  }>;
}

export interface TeamEntityViewModel {
  /** Stable organization-node identity. Never substitute a title or participant id. */
  readonly memberId: string;
  readonly label: string;
  readonly entityType: 'agent-member';
  readonly role: 'leader' | 'member';
  readonly attentionPolicy: 'ambient' | 'mention-only';
  readonly definitionIdentity: AgentDefinitionIdentity;
  /** Same structured identity avatar consumed by Room and Host identity-detail surfaces. */
  readonly avatar: NonNullable<AgentDefinition['avatar']>;
  readonly definitionName?: string;
  readonly description?: string;
  readonly definitionAvailable: boolean;
  readonly declaredCapabilities: TeamEntityDeclaredCapabilities;
  readonly relationships: Readonly<{
    readonly kind: 'root' | 'reports-to' | 'unestablished';
    readonly reportsToMemberId?: string;
    readonly directReportMemberIds: readonly string[];
    readonly relatedMemberIds: readonly string[];
  }>;
  /** Definition inheritance is intentionally separate from the organization graph. */
  readonly extendsDefinitions: readonly AgentDefinitionIdentity[];
  readonly source: Readonly<{
    readonly kind: 'agent-configuration';
    readonly contract?: string;
    readonly schema?: string;
    readonly schemaVersion?: number;
  }>;
  readonly sessionState: 'active' | 'without-active';
  readonly activeSessions: readonly TeamEntityActiveSession[];
}

export interface TeamEntityTreeNode {
  readonly entity: TeamEntityViewModel;
  /** True only for a direct search/filter match; false means retained ancestor context. */
  readonly matches: boolean;
  readonly children: readonly TeamEntityTreeNode[];
}

export interface TeamArchitectureViewModel {
  readonly entities: readonly TeamEntityViewModel[];
  readonly roots: readonly TeamEntityTreeNode[];
  readonly unestablished: readonly TeamEntityTreeNode[];
  readonly matchedMemberIds: ReadonlySet<string>;
  readonly matchedCount: number;
  readonly totalCount: number;
}

export interface TeamArchitectureDataSnapshot {
  readonly revision: number;
  readonly configuration: ChatroomAgentConfiguration;
  readonly rooms: readonly Room[];
}

export interface TeamArchitectureDataSource {
  getSnapshot(): TeamArchitectureDataSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const identityKey = (identity: AgentDefinitionIdentity): string =>
  `${identity.agentId.length}:${identity.agentId}${identity.revision.length}:${identity.revision}`;

const sameIdentity = (left: AgentDefinitionIdentity, right: AgentDefinitionIdentity): boolean =>
  left.agentId === right.agentId && left.revision === right.revision;

const sorted = (values: readonly string[] | undefined): readonly string[] =>
  Object.freeze([...(values ?? [])].sort((left, right) => left.localeCompare(right)));

const declared = (values: readonly string[] | undefined): readonly string[] =>
  Object.freeze([...(values ?? [])]);

const declaredCapabilitiesFor = (definition: AgentDefinition | undefined): TeamEntityDeclaredCapabilities =>
  Object.freeze({
    promptSections: Object.freeze((definition?.promptSections ?? []).map(section => Object.freeze({
      sectionId: section.sectionId,
      kind: section.kind,
      text: section.text,
      provenance: 'direct' as const,
    }))),
    rules: declared(definition?.rules),
    skills: declared(definition?.skills),
    tools: Object.freeze({
      include: declared(definition?.tools?.include),
      exclude: declared(definition?.tools?.exclude),
    }),
    mcpServers: Object.freeze({
      include: declared(definition?.mcpServers?.include),
      exclude: declared(definition?.mcpServers?.exclude),
    }),
    runtime: Object.freeze({
      ...(definition?.runtimeDefaults?.adapterId === undefined
        ? {} : { adapterId: definition.runtimeDefaults.adapterId }),
      ...(definition?.runtimeDefaults?.model === undefined ? {} : {
        providerId: definition.runtimeDefaults.model.providerId,
        modelId: definition.runtimeDefaults.model.modelId,
      }),
      ...(definition?.runtimeDefaults?.effort === undefined
        ? {} : { effort: definition.runtimeDefaults.effort }),
    }),
    ...(definition === undefined ? {} : {
      inheritance: Object.freeze({
        promptSections: definition.inherit.promptSections,
        rules: definition.inherit.rules,
        skills: definition.inherit.skills,
        tools: definition.inherit.tools,
        mcpServers: definition.inherit.mcpServers,
        runtimeDefaults: definition.inherit.runtimeDefaults,
        ...(definition.inherit.avatar === undefined ? {} : { avatar: definition.inherit.avatar }),
      }),
    }),
  });

const activeSessionsFor = (
  memberId: string,
  definition: AgentDefinitionIdentity,
  rooms: readonly Room[],
): readonly TeamEntityActiveSession[] => Object.freeze(rooms.flatMap(room => {
  const membership = room.memberships.find(candidate =>
    candidate.memberId === memberId && sameIdentity(candidate.definition, definition));
  if (membership === undefined) return [];
  return room.runs.flatMap(run => {
    if (run.memberId !== memberId
      || run.taskBinding?.state !== 'active'
      || !sameIdentity(run.taskBinding.definition, definition)
      || run.detailsUrl === undefined
      || (run.presence.state !== 'joined' && run.presence.state !== 'ready')) return [];
    return [Object.freeze({
      roomId: room.id,
      roomTitle: room.title,
      participantId: membership.participantId,
      runId: run.runId,
      runTitle: run.title,
      status: run.status,
      detailsUrl: Object.freeze({ ...run.detailsUrl }),
    })];
  });
}).sort((left, right) => left.roomTitle.localeCompare(right.roomTitle)
  || left.runTitle.localeCompare(right.runTitle)
  || left.runId.localeCompare(right.runId)));

const relationshipKindFor = (
  memberId: string,
  role: 'leader' | 'member',
  reportsToMemberId: string | undefined,
  seedLeaderIds: ReadonlySet<string>,
): TeamEntityViewModel['relationships']['kind'] => {
  if (reportsToMemberId !== undefined) return 'reports-to';
  if (role === 'leader' || seedLeaderIds.has(memberId)) return 'root';
  return 'unestablished';
};

export function projectTeamEntities(
  configuration: ChatroomAgentConfiguration,
  rooms: readonly Room[],
): readonly TeamEntityViewModel[] {
  const definitions = new Map(configuration.definitions.map(definition =>
    [identityKey(definition.identity), definition]));
  const seedLeaderIds = new Set(configuration.seedLeaderIds);
  const directReports = new Map<string, string[]>();
  for (const member of configuration.members) {
    if (member.reportsToMemberId === undefined) continue;
    const reports = directReports.get(member.reportsToMemberId) ?? [];
    reports.push(member.memberId);
    directReports.set(member.reportsToMemberId, reports);
  }
  return Object.freeze(configuration.members.map(member => {
    const definition = definitions.get(identityKey(member.definition));
    const activeSessions = activeSessionsFor(member.memberId, member.definition, rooms);
    return Object.freeze({
      memberId: member.memberId,
      label: member.label,
      entityType: 'agent-member' as const,
      role: member.role,
      attentionPolicy: member.attentionPolicy,
      definitionIdentity: Object.freeze({ ...member.definition }),
      avatar: agentAvatarForDefinition(member.definition, configuration.definitions),
      ...(definition?.name === undefined ? {} : { definitionName: definition.name }),
      ...(definition?.description === undefined ? {} : { description: definition.description }),
      definitionAvailable: definition !== undefined,
      declaredCapabilities: declaredCapabilitiesFor(definition),
      relationships: Object.freeze({
        kind: relationshipKindFor(
          member.memberId,
          member.role,
          member.reportsToMemberId,
          seedLeaderIds,
        ),
        ...(member.reportsToMemberId === undefined
          ? {} : { reportsToMemberId: member.reportsToMemberId }),
        directReportMemberIds: sorted(directReports.get(member.memberId)),
        relatedMemberIds: sorted(member.relatedMemberIds),
      }),
      extendsDefinitions: Object.freeze((definition?.extends ?? []).map(identity =>
        Object.freeze({ ...identity }))),
      source: Object.freeze({
        kind: 'agent-configuration' as const,
        ...(definition?.contract === undefined ? {} : { contract: definition.contract }),
        ...(definition?.$schema === undefined ? {} : { schema: definition.$schema }),
        ...(definition?.schemaVersion === undefined ? {} : { schemaVersion: definition.schemaVersion }),
      }),
      sessionState: activeSessions.length === 0 ? 'without-active' as const : 'active' as const,
      activeSessions,
    });
  }));
}

const searchableTextFor = (entity: TeamEntityViewModel): string => [
  entity.memberId,
  entity.label,
  entity.definitionIdentity.agentId,
  entity.definitionIdentity.revision,
  entity.definitionName,
  entity.description,
  entity.relationships.reportsToMemberId,
  ...entity.relationships.directReportMemberIds,
  ...entity.relationships.relatedMemberIds,
  ...entity.extendsDefinitions.flatMap(identity => [identity.agentId, identity.revision]),
  ...entity.declaredCapabilities.rules,
  ...entity.declaredCapabilities.skills,
  ...entity.declaredCapabilities.tools.include,
  ...entity.declaredCapabilities.tools.exclude,
  ...entity.declaredCapabilities.mcpServers.include,
  ...entity.declaredCapabilities.mcpServers.exclude,
].filter((value): value is string => value !== undefined).join('\n').toLocaleLowerCase();

const matchesFilters = (entity: TeamEntityViewModel, filters: TeamEntityFilters): boolean => {
  const query = filters.query?.trim().toLocaleLowerCase();
  if (query !== undefined && query !== '' && !searchableTextFor(entity).includes(query)) return false;
  if (filters.role !== undefined && filters.role !== 'all' && entity.role !== filters.role) return false;
  if (filters.session !== undefined && filters.session !== 'all'
    && entity.sessionState !== filters.session) return false;
  return filters.relationship === undefined || filters.relationship === 'all'
    || entity.relationships.kind === filters.relationship;
};

export function buildTeamArchitectureViewModel(
  snapshot: Pick<TeamArchitectureDataSnapshot, 'configuration' | 'rooms'>,
  filters: TeamEntityFilters = {},
): TeamArchitectureViewModel {
  const entities = projectTeamEntities(snapshot.configuration, snapshot.rooms);
  const byId = new Map(entities.map(entity => [entity.memberId, entity]));
  const matchedMemberIds = new Set(entities.filter(entity => matchesFilters(entity, filters))
    .map(entity => entity.memberId));
  const children = new Map<string, TeamEntityViewModel[]>();
  for (const entity of entities) {
    const managerId = entity.relationships.reportsToMemberId;
    if (managerId === undefined || !byId.has(managerId)) continue;
    const reports = children.get(managerId) ?? [];
    reports.push(entity);
    children.set(managerId, reports);
  }
  const buildNode = (entity: TeamEntityViewModel): TeamEntityTreeNode | undefined => {
    const childNodes = (children.get(entity.memberId) ?? [])
      .sort((left, right) => left.label.localeCompare(right.label) || left.memberId.localeCompare(right.memberId))
      .flatMap(child => {
        const node = buildNode(child);
        return node === undefined ? [] : [node];
      });
    const matches = matchedMemberIds.has(entity.memberId);
    if (!matches && childNodes.length === 0) return undefined;
    return Object.freeze({ entity, matches, children: Object.freeze(childNodes) });
  };
  const roots = entities.filter(entity => entity.relationships.kind === 'root')
    .sort((left, right) => left.label.localeCompare(right.label) || left.memberId.localeCompare(right.memberId))
    .flatMap(entity => {
      const node = buildNode(entity);
      return node === undefined ? [] : [node];
    });
  const unestablished = entities.filter(entity => entity.relationships.kind === 'unestablished')
    .sort((left, right) => left.label.localeCompare(right.label) || left.memberId.localeCompare(right.memberId))
    .flatMap(entity => {
      const node = buildNode(entity);
      return node === undefined ? [] : [node];
    });
  return Object.freeze({
    entities,
    roots: Object.freeze(roots),
    unestablished: Object.freeze(unestablished),
    matchedMemberIds,
    matchedCount: matchedMemberIds.size,
    totalCount: entities.length,
  });
}

export function createTeamArchitectureDataSource(
  configuration: ChatroomAgentConfiguration,
  registry: ChatroomRoomRegistry,
): TeamArchitectureDataSource {
  let revision = 0;
  let disposed = false;
  let snapshot: TeamArchitectureDataSnapshot = Object.freeze({
    revision,
    configuration,
    rooms: Object.freeze([...registry.snapshot()]),
  });
  const listeners = new Set<() => void>();
  const unsubscribeRegistry = registry.subscribe(() => {
    if (disposed) return;
    revision += 1;
    snapshot = Object.freeze({
      revision,
      configuration,
      rooms: Object.freeze([...registry.snapshot()]),
    });
    for (const listener of listeners) listener();
  });
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribeRegistry();
    },
  });
}
