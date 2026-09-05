import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXI18n,
  type CordisXLocaleCatalog,
  type CordisXManagerContentNavigationDeclarationV1,
  type CordisXManagerContentNavigationDeclarationV2,
  type CordisXManagerContentNavigationDeclarationV3,
  type CordisXManagerContentRecordTitleV1,
  type CordisXPageMetadataV3,
  type CordisXPages,
  type CordisXRouteDefinitionV2,
  type CordisXRoutes,
  type CordisXSlots,
} from 'cordisx/contracts';
import { agentAvatarForDefinition } from './agent-definition.js';
import {
  createTeamArchitecturePage,
  type TeamArchitectureDetailRouteIds,
  type TeamArchitectureMessages,
  type TeamEntityDetailTab,
} from './team-architecture-page.js';
import type { TeamArchitectureDataSnapshot, TeamArchitectureDataSource } from './team-entity-view-model.js';

export const TEAM_ARCHITECTURE_LOCALE_NAMESPACE = 'org.cordisx.chatroom.team-architecture' as const;
export const TEAM_ARCHITECTURE_PAGE_ID = 'org.cordisx.chatroom.manager.team-architecture' as const;
export const TEAM_ARCHITECTURE_ROUTE_ID = 'org.cordisx.chatroom.manager.team-architecture.root' as const;
export const TEAM_ARCHITECTURE_DETAIL_ROUTE_ID = 'org.cordisx.chatroom.manager.team-architecture.detail' as const;
export const TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID =
  'org.cordisx.chatroom.manager.team-architecture.detail.prompts' as const;
export const TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID =
  'org.cordisx.chatroom.manager.team-architecture.detail.relationships' as const;
export const TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID =
  'org.cordisx.chatroom.manager.team-architecture.detail.capabilities' as const;
export const TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID =
  'org.cordisx.chatroom.manager.team-architecture.detail.sessions' as const;

export const TEAM_ARCHITECTURE_DETAIL_ROUTE_IDS: TeamArchitectureDetailRouteIds = Object.freeze({
  overview: TEAM_ARCHITECTURE_DETAIL_ROUTE_ID,
  prompts: TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID,
  relationships: TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
  capabilities: TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
  sessions: TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID,
});

const message = (key: keyof TeamArchitectureMessages, fallback: string) =>
  Object.freeze({
    namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
    key,
    fallback,
  });

export const TEAM_ARCHITECTURE_PAGE: CordisXPageMetadataV3 = Object.freeze({
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: TEAM_ARCHITECTURE_PAGE_ID,
  title: message('tree.heading', '团队架构'),
  description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  icon: 'host:hierarchy',
  chrome: 'standard',
});

export const TEAM_ARCHITECTURE_ROUTES: readonly CordisXRouteDefinitionV2<'manager.content'>[] = Object.freeze([
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('tree.heading', '团队架构'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_DETAIL_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture/:memberId',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('detail.identity', '成员详情'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture/:memberId/prompts',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('detail.tab.prompts', '提示词'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture/:memberId/relationships',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('detail.tab.relationships', '关系'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture/:memberId/capabilities',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('detail.tab.capabilities', '能力'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
  Object.freeze({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID,
    path: '/manager/extensions/chatroom/team-architecture/:memberId/sessions',
    outlet: 'manager.content',
    page: TEAM_ARCHITECTURE_PAGE_ID,
    title: message('detail.tab.sessions', '会话'),
    description: message('body.introduction', '查看真实 Agent 成员、汇报关系、声明能力和活跃会话。'),
  }),
]);

/**
 * Projection fragment owned by Team Architecture. The Chatroom integrator must
 * combine this with sibling Manager features and call replaceProjection once.
 */
export const TEAM_ARCHITECTURE_MANAGER_CONTENT_DECLARATIONS: readonly CordisXManagerContentNavigationDeclarationV1[] =
  Object.freeze([
    Object.freeze({
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
      schemaVersion: 1,
      id: 'team-architecture-root',
      route: Object.freeze({ id: TEAM_ARCHITECTURE_ROUTE_ID }),
      header: Object.freeze({ title: Object.freeze({ kind: 'route' as const }) }),
    }),
  ]);

type TeamArchitectureManagerContentNavigationDeclaration =
  | CordisXManagerContentNavigationDeclarationV1
  | CordisXManagerContentNavigationDeclarationV2
  | CordisXManagerContentNavigationDeclarationV3;

function detailTabs(memberId: string): NonNullable<CordisXManagerContentNavigationDeclarationV2['tabs']> {
  return Object.freeze([
    Object.freeze({
      id: 'overview' satisfies TeamEntityDetailTab,
      route: Object.freeze({ id: TEAM_ARCHITECTURE_DETAIL_ROUTE_ID, params: Object.freeze({ memberId }) }),
      label: message('detail.tab.overview', '概览'),
    }),
    Object.freeze({
      id: 'prompts' satisfies TeamEntityDetailTab,
      route: Object.freeze({
        id: TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID,
        params: Object.freeze({ memberId }),
      }),
      label: message('detail.tab.prompts', '提示词'),
    }),
    Object.freeze({
      id: 'relationships' satisfies TeamEntityDetailTab,
      route: Object.freeze({
        id: TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
        params: Object.freeze({ memberId }),
      }),
      label: message('detail.tab.relationships', '关系'),
    }),
    Object.freeze({
      id: 'capabilities' satisfies TeamEntityDetailTab,
      route: Object.freeze({
        id: TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
        params: Object.freeze({ memberId }),
      }),
      label: message('detail.tab.capabilities', '能力'),
    }),
    Object.freeze({
      id: 'sessions' satisfies TeamEntityDetailTab,
      route: Object.freeze({
        id: TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID,
        params: Object.freeze({ memberId }),
      }),
      label: message('detail.tab.sessions', '会话'),
    }),
  ]);
}

export function teamArchitectureManagerContentDeclarations(
  snapshot: Pick<TeamArchitectureDataSnapshot, 'configuration'>,
): readonly TeamArchitectureManagerContentNavigationDeclaration[] {
  const detailRoutes = Object.freeze([
    Object.freeze({ tab: 'overview' as const, routeId: TEAM_ARCHITECTURE_DETAIL_ROUTE_ID }),
    Object.freeze({ tab: 'prompts' as const, routeId: TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID }),
    Object.freeze({
      tab: 'relationships' as const,
      routeId: TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
    }),
    Object.freeze({
      tab: 'capabilities' as const,
      routeId: TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
    }),
    Object.freeze({ tab: 'sessions' as const, routeId: TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID }),
  ]);
  const details = snapshot.configuration.members.flatMap((member, index) => {
    const tabs = detailTabs(member.memberId);
    const definition = snapshot.configuration.definitions.find(candidate => (
      candidate.identity.agentId === member.definition.agentId
      && candidate.identity.revision === member.definition.revision
    ));
    const definitionDisplayName = definition?.name ?? member.label;
    return detailRoutes.map((
      { tab, routeId },
    ): CordisXManagerContentNavigationDeclarationV2 | CordisXManagerContentNavigationDeclarationV3 =>
      Object.freeze({
        ...(definition === undefined
          ? {
            $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2,
            schemaVersion: 2 as const,
          }
          : {
            $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3,
            schemaVersion: 3 as const,
          }),
        id: `team-architecture-detail-${index + 1}-${tab}`,
        route: Object.freeze({
          id: routeId,
          params: Object.freeze({ memberId: member.memberId }),
        }),
        parentRoute: Object.freeze({ id: TEAM_ARCHITECTURE_ROUTE_ID }),
        header: Object.freeze({
          title: Object.freeze({
            kind: 'record',
            recordIdParam: 'memberId',
            fallback: message('detail.identity', '成员详情'),
          }),
        }),
        tabs,
        ...(definition === undefined ? {} : {
          ...(tab !== 'overview' ? {} : {
            subject: Object.freeze({
              kind: 'agent-definition' as const,
              identity: Object.freeze({ ...member.definition }),
            }),
          }),
          recordSummary: Object.freeze({
            leadingVisual: Object.freeze({
              kind: 'agent-avatar' as const,
              avatar: agentAvatarForDefinition(member.definition, snapshot.configuration.definitions),
            }),
            title: Object.freeze({
              namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
              key: 'detail.record-title',
              params: Object.freeze({ label: definitionDisplayName }),
              fallback: definitionDisplayName,
            }),
            ...(definition.description === undefined ? {} : {
              description: Object.freeze({
                namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
                key: 'detail.record-description',
                params: Object.freeze({ description: definition.description }),
                fallback: definition.description,
              }),
            }),
          }),
        }),
      })
    );
  });
  return Object.freeze([...TEAM_ARCHITECTURE_MANAGER_CONTENT_DECLARATIONS, ...details]);
}

export function teamArchitectureManagerContentRecordTitles(
  snapshot: Pick<TeamArchitectureDataSnapshot, 'configuration'>,
): readonly CordisXManagerContentRecordTitleV1[] {
  return Object.freeze(snapshot.configuration.members.map(member =>
    Object.freeze({
      id: member.memberId,
      title: Object.freeze({
        namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
        key: 'detail.record-title',
        params: Object.freeze({ label: member.label }),
        fallback: member.label,
      }),
    })
  ));
}

type TeamArchitectureMessageCatalog = Readonly<
  {
    [Key in keyof TeamArchitectureMessages]: string;
  }
>;

const zhCNMessages: TeamArchitectureMessageCatalog = Object.freeze({
  'body.introduction': '以配置中的稳定成员身份展示真实组织关系；定义继承与关联关系不会被当作上下级。',
  'search.label': '搜索团队成员',
  'search.placeholder': '成员名称、成员 ID、Agent ID、版本或声明能力',
  'filter.role': '角色',
  'filter.role.all': '全部角色',
  'filter.role.leader': '负责人',
  'filter.role.member': '成员',
  'filter.session': '会话',
  'filter.session.all': '全部会话状态',
  'filter.session.active': '有活跃会话',
  'filter.session.without-active': '暂无活跃会话',
  'filter.relationship': '关系',
  'filter.relationship.all': '全部关系',
  'filter.relationship.root': '架构根节点',
  'filter.relationship.reports-to': '已建立汇报关系',
  'filter.relationship.unestablished': '未建立关系',
  'summary.count': '显示 {matched} / {total} 个成员',
  'tree.heading': '团队架构',
  'tree.unestablished': '未建立关系',
  'tree.unestablished.description': '这些成员没有真实 reportsToMemberId，未被推测挂载到任何负责人。',
  'tree.empty.title': '没有匹配的团队成员',
  'tree.empty.description': '调整搜索词或筛选条件后重试。',
  'entity.open': '查看 {label} 的详情',
  'entity.active-sessions': '{count} 个活跃会话',
  'entity.no-active-sessions': '暂无活跃会话',
  'entity.context': '关系上下文',
  'entity.role.leader': '负责人',
  'entity.role.member': '成员',
  'entity.relationship.root': '根节点',
  'entity.relationship.reports-to': '已建立汇报关系',
  'entity.relationship.unestablished': '未建立关系',
  'detail.missing.title': '成员不存在',
  'detail.missing.description': '当前 Agent 配置中没有该稳定 memberId。',
  'detail.record-title': '{label}',
  'detail.record-description': '{description}',
  'detail.identity': '成员详情',
  'detail.tab.overview': '概览',
  'detail.tab.prompts': '提示词',
  'detail.tab.relationships': '关系',
  'detail.tab.capabilities': '能力',
  'detail.tab.sessions': '会话',
  'detail.member-id': '成员 ID',
  'detail.definition-identity': 'Agent 定义身份',
  'detail.definition-name': '定义名称',
  'detail.type': '类型',
  'detail.type.agent-member': 'Agent 成员',
  'detail.role': '角色',
  'detail.attention': '关注策略',
  'detail.attention.ambient': '环境感知',
  'detail.attention.mention-only': '仅被提及时',
  'detail.status': '状态',
  'detail.status.active': '有活跃会话',
  'detail.status.without-active': '暂无活跃会话',
  'detail.relationships': '关系',
  'detail.manager': '上级',
  'detail.direct-reports': '直接下属',
  'detail.related': '关联成员',
  'detail.definition-inheritance': '定义继承',
  'detail.none': '无',
  'detail.unestablished': '未建立关系',
  'detail.prompts': '提示词配置',
  'detail.prompts.note':
    '按 AgentDefinition 中的来源顺序展示直接声明；当前没有权威 effective resolver 或逐项继承来源，因此不会推导或暗示继承后的有效提示词。',
  'detail.prompt-inherit': '提示词继承模式',
  'detail.prompt-upstream': '上游定义',
  'detail.prompt-section.id': '分区 ID',
  'detail.prompt-section.provenance': '来源',
  'detail.provenance.direct': '直接声明',
  'detail.prompt.kind.introduction': '介绍',
  'detail.prompt.kind.personality': '人格',
  'detail.prompt.kind.role': '角色',
  'detail.prompt.kind.operations': '操作',
  'detail.prompt.kind.tools': '工具',
  'detail.prompt.kind.knowledge': '知识',
  'detail.prompt.kind.memory-policy': '记忆策略',
  'detail.prompt.kind.memory': '记忆',
  'detail.prompt.kind.other': '其他',
  'detail.capabilities': '声明能力',
  'detail.capabilities.note': '仅展示当前 AgentDefinition 直接声明的数据，不推导继承后的有效能力。',
  'detail.rules': '规则',
  'detail.skills': '技能',
  'detail.tools.include': '包含工具',
  'detail.tools.exclude': '排除工具',
  'detail.mcp.include': '包含 MCP 服务',
  'detail.mcp.exclude': '排除 MCP 服务',
  'detail.runtime': '运行默认值',
  'detail.source': '来源与版本',
  'detail.source.kind': '来源',
  'detail.source.contract': '契约',
  'detail.source.schema': 'Schema',
  'detail.source.revision': 'Revision',
  'detail.active-sessions': '活跃会话',
  'detail.session.room': 'Room',
  'detail.session.run': 'Run',
  'detail.session.participant': 'Participant',
  'detail.session.status': '运行状态',
  'detail.session.target': '详情目标',
  'detail.unavailable': '不可用',
});

const enMessages: TeamArchitectureMessageCatalog = Object.freeze({
  'body.introduction':
    'Shows real reporting lines from stable configured member identities. Definition inheritance and related-member links never become hierarchy.',
  'search.label': 'Search team members',
  'search.placeholder': 'Name, member ID, Agent ID, revision, or declared capability',
  'filter.role': 'Role',
  'filter.role.all': 'All roles',
  'filter.role.leader': 'Leader',
  'filter.role.member': 'Member',
  'filter.session': 'Sessions',
  'filter.session.all': 'All session states',
  'filter.session.active': 'Has active sessions',
  'filter.session.without-active': 'No active sessions',
  'filter.relationship': 'Relationship',
  'filter.relationship.all': 'All relationships',
  'filter.relationship.root': 'Organization root',
  'filter.relationship.reports-to': 'Reporting line established',
  'filter.relationship.unestablished': 'Relationship not established',
  'summary.count': 'Showing {matched} of {total} members',
  'tree.heading': 'Team architecture',
  'tree.unestablished': 'Relationship not established',
  'tree.unestablished.description':
    'These members have no real reportsToMemberId and are not attached to a guessed manager.',
  'tree.empty.title': 'No team members match',
  'tree.empty.description': 'Adjust the search or filters and try again.',
  'entity.open': 'View details for {label}',
  'entity.active-sessions': '{count} active sessions',
  'entity.no-active-sessions': 'No active sessions',
  'entity.context': 'Relationship context',
  'entity.role.leader': 'Leader',
  'entity.role.member': 'Member',
  'entity.relationship.root': 'Root',
  'entity.relationship.reports-to': 'Reporting line established',
  'entity.relationship.unestablished': 'Relationship not established',
  'detail.missing.title': 'Member not found',
  'detail.missing.description': 'The current Agent configuration does not contain this stable memberId.',
  'detail.record-title': '{label}',
  'detail.record-description': '{description}',
  'detail.identity': 'Member details',
  'detail.tab.overview': 'Overview',
  'detail.tab.prompts': 'Prompts',
  'detail.tab.relationships': 'Relationships',
  'detail.tab.capabilities': 'Capabilities',
  'detail.tab.sessions': 'Sessions',
  'detail.member-id': 'Member ID',
  'detail.definition-identity': 'Agent definition identity',
  'detail.definition-name': 'Definition name',
  'detail.type': 'Type',
  'detail.type.agent-member': 'Agent member',
  'detail.role': 'Role',
  'detail.attention': 'Attention policy',
  'detail.attention.ambient': 'Ambient',
  'detail.attention.mention-only': 'Mention only',
  'detail.status': 'Status',
  'detail.status.active': 'Has active sessions',
  'detail.status.without-active': 'No active sessions',
  'detail.relationships': 'Relationships',
  'detail.manager': 'Manager',
  'detail.direct-reports': 'Direct reports',
  'detail.related': 'Related members',
  'detail.definition-inheritance': 'Definition inheritance',
  'detail.none': 'None',
  'detail.unestablished': 'Relationship not established',
  'detail.prompts': 'Prompt configuration',
  'detail.prompts.note':
    'Direct declarations are shown in AgentDefinition source order. No authoritative effective resolver or per-item inheritance provenance is available, so effective inherited prompts are neither inferred nor implied.',
  'detail.prompt-inherit': 'Prompt inheritance mode',
  'detail.prompt-upstream': 'Upstream definitions',
  'detail.prompt-section.id': 'Section ID',
  'detail.prompt-section.provenance': 'Provenance',
  'detail.provenance.direct': 'Direct declaration',
  'detail.prompt.kind.introduction': 'Introduction',
  'detail.prompt.kind.personality': 'Personality',
  'detail.prompt.kind.role': 'Role',
  'detail.prompt.kind.operations': 'Operations',
  'detail.prompt.kind.tools': 'Tools',
  'detail.prompt.kind.knowledge': 'Knowledge',
  'detail.prompt.kind.memory-policy': 'Memory policy',
  'detail.prompt.kind.memory': 'Memory',
  'detail.prompt.kind.other': 'Other',
  'detail.capabilities': 'Declared capabilities',
  'detail.capabilities.note':
    'Only declarations on the current AgentDefinition are shown. Effective inherited capabilities are not inferred.',
  'detail.rules': 'Rules',
  'detail.skills': 'Skills',
  'detail.tools.include': 'Included tools',
  'detail.tools.exclude': 'Excluded tools',
  'detail.mcp.include': 'Included MCP servers',
  'detail.mcp.exclude': 'Excluded MCP servers',
  'detail.runtime': 'Runtime defaults',
  'detail.source': 'Source and revision',
  'detail.source.kind': 'Source',
  'detail.source.contract': 'Contract',
  'detail.source.schema': 'Schema',
  'detail.source.revision': 'Revision',
  'detail.active-sessions': 'Active sessions',
  'detail.session.room': 'Room',
  'detail.session.run': 'Run',
  'detail.session.participant': 'Participant',
  'detail.session.status': 'Run status',
  'detail.session.target': 'Details target',
  'detail.unavailable': 'Unavailable',
});

export const TEAM_ARCHITECTURE_LOCALES: readonly CordisXLocaleCatalog<TeamArchitectureMessages>[] = Object.freeze([
  Object.freeze({
    namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
    locale: 'zh-CN',
    default: true,
    messages: zhCNMessages,
  }),
  Object.freeze({
    namespace: TEAM_ARCHITECTURE_LOCALE_NAMESPACE,
    locale: 'en',
    messages: enMessages,
  }),
]);

export interface TeamArchitectureRegistrationContext {
  readonly i18n: CordisXI18n;
  readonly pages: CordisXPages;
  readonly routes: CordisXRoutes;
  readonly slots: CordisXSlots;
}

export type TeamArchitectureDisposer = () => void | Promise<void>;

/**
 * Registers only independently composable contributions. Manager-content
 * projection replacement stays with the Chatroom integrator so sibling
 * features cannot overwrite one another.
 */
export function registerTeamArchitectureManagerContributions(
  context: TeamArchitectureRegistrationContext,
  source: TeamArchitectureDataSource,
): readonly TeamArchitectureDisposer[] {
  const disposers: TeamArchitectureDisposer[] = [() => source.dispose()];
  try {
    disposers.push(...TEAM_ARCHITECTURE_LOCALES.map(catalog => context.i18n.define(catalog)));
    const pageMount = createTeamArchitecturePage(
      source,
      TEAM_ARCHITECTURE_DETAIL_ROUTE_IDS,
      context.i18n.seat<TeamArchitectureMessages>(TEAM_ARCHITECTURE_LOCALE_NAMESPACE),
    );
    disposers.push(context.pages.register(TEAM_ARCHITECTURE_PAGE, pageMount));
    disposers.push(...TEAM_ARCHITECTURE_ROUTES.map(route => context.routes.register(route)));
    disposers.push(context.slots.inject('manager.settings.navigation-items', () =>
      context.slots.register({
        name: 'manager.settings.navigation-items',
        id: 'team-architecture',
        group: 'after-settings',
        order: 200,
        disabled: Object.freeze({ value: false }),
      }, Object.freeze({ route: Object.freeze({ id: TEAM_ARCHITECTURE_ROUTE_ID }) }))));
  } catch (error) {
    for (const dispose of disposers.reverse()) void dispose();
    throw error;
  }
  return Object.freeze(disposers);
}
