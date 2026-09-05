import { Fragment, type ReactNode, useMemo, useState, useSyncExternalStore } from 'cordisx/react';
import { defineReactPage } from 'cordisx/react';
import { EmptyState, MarkdownViewer, Select, SelectionRail } from 'cordisx/ui';
import type { CordisXLocalizationSeat, CordisXReactPageProps } from 'cordisx/contracts';
import {
  buildTeamArchitectureViewModel,
  type TeamArchitectureDataSource,
  type TeamEntityRelationshipFilter,
  type TeamEntityRoleFilter,
  type TeamEntitySessionFilter,
  type TeamEntityTreeNode,
  type TeamEntityViewModel,
} from './team-entity-view-model.js';
import teamArchitectureCss from './team-architecture-page.css?inline';

export type TeamArchitectureMessages = {
  'body.introduction': undefined;
  'search.label': undefined;
  'search.placeholder': undefined;
  'filter.role': undefined;
  'filter.role.all': undefined;
  'filter.role.leader': undefined;
  'filter.role.member': undefined;
  'filter.session': undefined;
  'filter.session.all': undefined;
  'filter.session.active': undefined;
  'filter.session.without-active': undefined;
  'filter.relationship': undefined;
  'filter.relationship.all': undefined;
  'filter.relationship.root': undefined;
  'filter.relationship.reports-to': undefined;
  'filter.relationship.unestablished': undefined;
  'summary.count': { matched: number; total: number; };
  'tree.heading': undefined;
  'tree.unestablished': undefined;
  'tree.unestablished.description': undefined;
  'tree.empty.title': undefined;
  'tree.empty.description': undefined;
  'entity.open': { label: string; };
  'entity.active-sessions': { count: number; };
  'entity.no-active-sessions': undefined;
  'entity.context': undefined;
  'entity.role.leader': undefined;
  'entity.role.member': undefined;
  'entity.relationship.root': undefined;
  'entity.relationship.reports-to': undefined;
  'entity.relationship.unestablished': undefined;
  'detail.missing.title': undefined;
  'detail.missing.description': undefined;
  'detail.record-title': { label: string; };
  'detail.record-description': { description: string; };
  'detail.identity': undefined;
  'detail.tab.overview': undefined;
  'detail.tab.prompts': undefined;
  'detail.tab.relationships': undefined;
  'detail.tab.capabilities': undefined;
  'detail.tab.sessions': undefined;
  'detail.member-id': undefined;
  'detail.definition-identity': undefined;
  'detail.definition-name': undefined;
  'detail.type': undefined;
  'detail.type.agent-member': undefined;
  'detail.role': undefined;
  'detail.attention': undefined;
  'detail.attention.ambient': undefined;
  'detail.attention.mention-only': undefined;
  'detail.status': undefined;
  'detail.status.active': undefined;
  'detail.status.without-active': undefined;
  'detail.relationships': undefined;
  'detail.manager': undefined;
  'detail.direct-reports': undefined;
  'detail.related': undefined;
  'detail.definition-inheritance': undefined;
  'detail.none': undefined;
  'detail.unestablished': undefined;
  'detail.prompts': undefined;
  'detail.prompts.note': undefined;
  'detail.prompt-inherit': undefined;
  'detail.prompt-upstream': undefined;
  'detail.prompt-section.id': undefined;
  'detail.prompt-section.provenance': undefined;
  'detail.provenance.direct': undefined;
  'detail.prompt.kind.introduction': undefined;
  'detail.prompt.kind.personality': undefined;
  'detail.prompt.kind.role': undefined;
  'detail.prompt.kind.operations': undefined;
  'detail.prompt.kind.tools': undefined;
  'detail.prompt.kind.knowledge': undefined;
  'detail.prompt.kind.memory-policy': undefined;
  'detail.prompt.kind.memory': undefined;
  'detail.prompt.kind.other': undefined;
  'detail.capabilities': undefined;
  'detail.capabilities.note': undefined;
  'detail.rules': undefined;
  'detail.skills': undefined;
  'detail.tools.include': undefined;
  'detail.tools.exclude': undefined;
  'detail.mcp.include': undefined;
  'detail.mcp.exclude': undefined;
  'detail.runtime': undefined;
  'detail.source': undefined;
  'detail.source.kind': undefined;
  'detail.source.contract': undefined;
  'detail.source.schema': undefined;
  'detail.source.revision': undefined;
  'detail.active-sessions': undefined;
  'detail.session.room': undefined;
  'detail.session.run': undefined;
  'detail.session.participant': undefined;
  'detail.session.status': undefined;
  'detail.session.target': undefined;
  'detail.unavailable': undefined;
};

type Translate = CordisXReactPageProps<TeamArchitectureMessages>['t'];

export type TeamEntityDetailTab = 'overview' | 'prompts' | 'relationships' | 'capabilities' | 'sessions';

export interface TeamArchitectureDetailRouteIds {
  readonly overview: string;
  readonly prompts: string;
  readonly relationships: string;
  readonly capabilities: string;
  readonly sessions: string;
}

interface TeamArchitecturePageProps extends CordisXReactPageProps<TeamArchitectureMessages> {
  readonly source: TeamArchitectureDataSource;
  readonly detailRouteIds: TeamArchitectureDetailRouteIds;
}

interface FactProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
}

function Fact({ label, children }: FactProps) {
  return (
    <div className="cx-team-architecture__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function roleLabel(entity: TeamEntityViewModel, t: Translate): string {
  return entity.role === 'leader' ? t('entity.role.leader') : t('entity.role.member');
}

function promptKindLabel(
  kind: TeamEntityViewModel['declaredCapabilities']['promptSections'][number]['kind'],
  t: Translate,
): string {
  if (kind === 'introduction') return t('detail.prompt.kind.introduction');
  if (kind === 'personality') return t('detail.prompt.kind.personality');
  if (kind === 'role') return t('detail.prompt.kind.role');
  if (kind === 'operations') return t('detail.prompt.kind.operations');
  if (kind === 'tools') return t('detail.prompt.kind.tools');
  if (kind === 'knowledge') return t('detail.prompt.kind.knowledge');
  if (kind === 'memory-policy') return t('detail.prompt.kind.memory-policy');
  if (kind === 'memory') return t('detail.prompt.kind.memory');
  return t('detail.prompt.kind.other');
}

function StringList({ values, empty }: { readonly values: readonly string[]; readonly empty: string; }) {
  if (values.length === 0) return <span className="cx-team-architecture__muted">{empty}</span>;
  return (
    <ul className="cx-team-architecture__tokens">
      {values.map(value => (
        <li key={value}>
          <code>{value}</code>
        </li>
      ))}
    </ul>
  );
}

interface TreeNodeViewProps {
  readonly node: TeamEntityTreeNode;
  readonly onSelect: (memberId: string) => void;
  readonly t: Translate;
}

function avatarInitials(label: string): string {
  const characters = Array.from(label.trim());
  if (characters.length === 0) return '?';
  const words = label.trim().split(/\s+/u);
  if (words.length > 1) return words.slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
  return characters.slice(0, 2).join('').toLocaleUpperCase();
}

function TreeNodeView({ node, onSelect, t }: TreeNodeViewProps) {
  const entity = node.entity;
  const hasChildren = node.children.length > 0;
  return (
    <div
      className="cx-team-architecture__branch"
      role="listitem"
    >
      <div className="cx-team-architecture__node-seat" data-has-children={hasChildren ? 'true' : undefined}>
        <button
          type="button"
          className="cx-team-architecture__entity"
          data-context-only={node.matches ? undefined : 'true'}
          onClick={() => onSelect(entity.memberId)}
          aria-label={t('entity.open', { label: entity.label })}
        >
          <span className="cx-team-architecture__avatar" aria-hidden="true">
            {avatarInitials(entity.label)}
          </span>
          <span className="cx-team-architecture__entity-main">
            <span className="cx-team-architecture__entity-title">{entity.label}</span>
            <span className="cx-team-architecture__entity-identity">{roleLabel(entity, t)}</span>
          </span>
          <span
            className={entity.sessionState === 'active'
              ? 'cx-team-architecture__session-state cx-team-architecture__session-state--active'
              : 'cx-team-architecture__session-state'}
          >
            <span className="cx-team-architecture__session-dot" aria-hidden="true" />
            {entity.sessionState === 'active'
              ? t('entity.active-sessions', { count: entity.activeSessions.length })
              : t('entity.no-active-sessions')}
          </span>
        </button>
      </div>
      {hasChildren && (
        <div className="cx-team-architecture__children" role="list">
          {node.children.map(child => (
            <TreeNodeView
              key={child.entity.memberId}
              node={child}
              onSelect={onSelect}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EntityReferenceList({
  memberIds,
  entities,
  empty,
}: {
  readonly memberIds: readonly string[];
  readonly entities: ReadonlyMap<string, TeamEntityViewModel>;
  readonly empty: string;
}) {
  if (memberIds.length === 0) return <span className="cx-team-architecture__muted">{empty}</span>;
  return (
    <ul className="cx-team-architecture__references">
      {memberIds.map(memberId => (
        <li key={memberId}>
          <span>{entities.get(memberId)?.label ?? memberId}</span>
          <code>{memberId}</code>
        </li>
      ))}
    </ul>
  );
}

function detailTabLabel(tab: TeamEntityDetailTab, t: Translate): string {
  if (tab === 'overview') return t('detail.tab.overview');
  if (tab === 'prompts') return t('detail.tab.prompts');
  if (tab === 'relationships') return t('detail.tab.relationships');
  if (tab === 'capabilities') return t('detail.tab.capabilities');
  return t('detail.tab.sessions');
}

function PromptWorkspace({ entity, t }: {
  readonly entity: TeamEntityViewModel;
  readonly t: Translate;
}) {
  const sections = entity.declaredCapabilities.promptSections;
  const [selectedId, setSelectedId] = useState(sections[0]?.sectionId ?? '');
  const selected = sections.find(section => section.sectionId === selectedId) ?? sections[0];
  if (selected === undefined) {
    return <EmptyState title={t('detail.none')} />;
  }
  const upstream = entity.extendsDefinitions.map(identity => `${identity.agentId}@${identity.revision}`);
  return (
    <section className="cx-team-architecture__section" aria-label={t('detail.tab.prompts')}>
      <div className="cx-team-architecture__prompt-metadata">
        <span>
          <strong>{t('detail.prompt-inherit')}</strong>{' '}
          <code>{entity.declaredCapabilities.inheritance?.promptSections ?? t('detail.unavailable')}</code>
        </span>
        <span>
          <strong>{t('detail.prompt-upstream')}</strong> {upstream.length === 0
            ? <span className="cx-team-architecture__muted">{t('detail.none')}</span>
            : upstream.map((identity, index) => (
              <Fragment key={identity}>
                {index === 0 ? null : ', '}
                <code>{identity}</code>
              </Fragment>
            ))}
        </span>
      </div>
      <div className="cx-team-architecture__prompt-workspace">
        <SelectionRail
          className="cx-team-architecture__prompt-selector"
          aria-label={t('detail.prompts')}
          value={selected.sectionId}
          options={sections.map(section => ({
            value: section.sectionId,
            label: promptKindLabel(section.kind, t),
            description: (
              <span>
                <code>{section.sectionId}</code> · {t('detail.provenance.direct')}
              </span>
            ),
            controls: 'team-entity-prompt-content',
          }))}
          onChange={setSelectedId}
          layout="responsive"
        />
        <div
          id="team-entity-prompt-content"
          className="cx-team-architecture__prompt-content"
          role="tabpanel"
          aria-label={`${promptKindLabel(selected.kind, t)} · ${selected.sectionId}`}
        >
          <MarkdownViewer
            aria-label={`${promptKindLabel(selected.kind, t)} · ${selected.sectionId}`}
            source={selected.text}
          />
        </div>
      </div>
    </section>
  );
}

function EntityDetail({ entity, entities, tab, t }: {
  readonly entity: TeamEntityViewModel;
  readonly entities: readonly TeamEntityViewModel[];
  readonly tab: TeamEntityDetailTab;
  readonly t: Translate;
}) {
  const byId = useMemo(() => new Map(entities.map(candidate => [candidate.memberId, candidate])), [entities]);
  const managerId = entity.relationships.reportsToMemberId;
  const manager = managerId === undefined ? undefined : byId.get(managerId);
  const capabilities = entity.declaredCapabilities;
  const runtime = [
    capabilities.runtime.adapterId,
    capabilities.runtime.providerId === undefined || capabilities.runtime.modelId === undefined
      ? undefined
      : `${capabilities.runtime.providerId}/${capabilities.runtime.modelId}`,
    capabilities.runtime.effort,
  ].filter((value): value is string => value !== undefined);
  let panel: ReactNode;
  if (tab === 'overview') {
    panel = (
      <section className="cx-team-architecture__section" aria-label={t('detail.tab.overview')}>
        <dl className="cx-team-architecture__facts">
          <Fact label={t('detail.member-id')}>
            <code>{entity.memberId}</code>
          </Fact>
          <Fact label={t('detail.definition-identity')}>
            <code>{entity.definitionIdentity.agentId}@{entity.definitionIdentity.revision}</code>
          </Fact>
          <Fact label={t('detail.definition-name')}>
            {entity.definitionName ?? t('detail.unavailable')}
          </Fact>
          <Fact label={t('detail.type')}>{t('detail.type.agent-member')}</Fact>
          <Fact label={t('detail.role')}>{roleLabel(entity, t)}</Fact>
          <Fact label={t('detail.attention')}>
            {entity.attentionPolicy === 'ambient'
              ? t('detail.attention.ambient')
              : t('detail.attention.mention-only')}
          </Fact>
          <Fact label={t('detail.source.kind')}>{entity.source.kind}</Fact>
          <Fact label={t('detail.source.contract')}>
            <code>{entity.source.contract ?? t('detail.unavailable')}</code>
          </Fact>
          <Fact label={t('detail.source.schema')}>
            <code>{entity.source.schema ?? t('detail.unavailable')}</code>
          </Fact>
          <Fact label={t('detail.source.revision')}>
            <code>{entity.definitionIdentity.revision}</code>
          </Fact>
        </dl>
      </section>
    );
  } else if (tab === 'prompts') {
    panel = (
      <PromptWorkspace
        key={`${entity.definitionIdentity.agentId}@${entity.definitionIdentity.revision}`}
        entity={entity}
        t={t}
      />
    );
  } else if (tab === 'relationships') {
    panel = (
      <section className="cx-team-architecture__section" aria-label={t('detail.tab.relationships')}>
        <dl className="cx-team-architecture__facts">
          <Fact label={t('detail.manager')}>
            {entity.relationships.kind === 'unestablished'
              ? <span className="cx-team-architecture__warning">{t('detail.unestablished')}</span>
              : managerId === undefined
              ? t('entity.relationship.root')
              : (
                <Fragment>
                  <span>{manager?.label ?? managerId}</span> <code>{managerId}</code>
                </Fragment>
              )}
          </Fact>
          <Fact label={t('detail.direct-reports')}>
            <EntityReferenceList
              memberIds={entity.relationships.directReportMemberIds}
              entities={byId}
              empty={t('detail.none')}
            />
          </Fact>
          <Fact label={t('detail.related')}>
            <EntityReferenceList
              memberIds={entity.relationships.relatedMemberIds}
              entities={byId}
              empty={t('detail.none')}
            />
          </Fact>
          <Fact label={t('detail.definition-inheritance')}>
            {entity.extendsDefinitions.length === 0
              ? <span className="cx-team-architecture__muted">{t('detail.none')}</span>
              : (
                <ul className="cx-team-architecture__references">
                  {entity.extendsDefinitions.map(identity => (
                    <li key={`${identity.agentId}@${identity.revision}`}>
                      <code>{identity.agentId}@{identity.revision}</code>
                    </li>
                  ))}
                </ul>
              )}
          </Fact>
        </dl>
      </section>
    );
  } else if (tab === 'capabilities') {
    panel = (
      <section className="cx-team-architecture__section" aria-label={t('detail.tab.capabilities')}>
        <p className="cx-team-architecture__section-note">{t('detail.capabilities.note')}</p>
        <dl className="cx-team-architecture__facts">
          <Fact label={t('detail.rules')}>
            <StringList values={capabilities.rules} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.skills')}>
            <StringList values={capabilities.skills} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.tools.include')}>
            <StringList values={capabilities.tools.include} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.tools.exclude')}>
            <StringList values={capabilities.tools.exclude} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.mcp.include')}>
            <StringList values={capabilities.mcpServers.include} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.mcp.exclude')}>
            <StringList values={capabilities.mcpServers.exclude} empty={t('detail.none')} />
          </Fact>
          <Fact label={t('detail.runtime')}>
            <StringList values={runtime} empty={t('detail.none')} />
          </Fact>
        </dl>
      </section>
    );
  } else {
    panel = (
      <section className="cx-team-architecture__section" aria-label={t('detail.tab.sessions')}>
        {entity.activeSessions.length === 0
          ? <EmptyState title={t('detail.status.without-active')} />
          : (
            <ul className="cx-team-architecture__sessions">
              {entity.activeSessions.map(session => (
                <li key={`${session.roomId}:${session.runId}`}>
                  <div className="cx-team-architecture__session-heading">
                    <strong>{session.runTitle}</strong>
                    <span className="cx-team-architecture__status cx-team-architecture__status--active">
                      {session.status}
                    </span>
                  </div>
                  <dl className="cx-team-architecture__facts">
                    <Fact label={t('detail.session.room')}>
                      <span>{session.roomTitle}</span> <code>{session.roomId}</code>
                    </Fact>
                    <Fact label={t('detail.session.run')}>
                      <code>{session.runId}</code>
                    </Fact>
                    <Fact label={t('detail.session.participant')}>
                      <code>{session.participantId}</code>
                    </Fact>
                    <Fact label={t('detail.session.status')}>{session.status}</Fact>
                    <Fact label={t('detail.session.target')}>
                      <code>{session.detailsUrl.target}: {session.detailsUrl.url}</code>
                    </Fact>
                  </dl>
                </li>
              ))}
            </ul>
          )}
      </section>
    );
  }
  return (
    <article className="cx-team-architecture__detail" aria-label={detailTabLabel(tab, t)}>
      <div className="cx-team-architecture__detail-panel" data-detail-tab={tab}>{panel}</div>
    </article>
  );
}

function TeamArchitectureRoot({
  snapshot,
  detailRouteIds,
  navigation,
  t,
}: Pick<TeamArchitecturePageProps, 'detailRouteIds' | 'navigation' | 't'> & {
  readonly snapshot: ReturnType<TeamArchitectureDataSource['getSnapshot']>;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<TeamEntityRoleFilter>('all');
  const [session, setSession] = useState<TeamEntitySessionFilter>('all');
  const [relationship, setRelationship] = useState<TeamEntityRelationshipFilter>('all');
  const model = useMemo(() =>
    buildTeamArchitectureViewModel(snapshot, {
      query,
      role,
      session,
      relationship,
    }), [query, relationship, role, session, snapshot]);
  const select = (memberId: string) => {
    void navigation.navigate({ id: detailRouteIds.overview, params: { memberId } });
  };
  const selectRole = (value: string) => {
    if (value === 'all' || value === 'leader' || value === 'member') setRole(value);
  };
  const selectSession = (value: string) => {
    if (value === 'all' || value === 'active' || value === 'without-active') setSession(value);
  };
  const selectRelationship = (value: string) => {
    if (value === 'all' || value === 'root' || value === 'reports-to' || value === 'unestablished') {
      setRelationship(value);
    }
  };
  return (
    <div className="cx-team-architecture">
      <div className="cx-team-architecture__controls">
        <label className="cx-team-architecture__search">
          <input
            type="search"
            aria-label={t('search.label')}
            value={query}
            placeholder={t('search.placeholder')}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <Select
          className="cx-team-architecture__filter"
          aria-label={t('filter.role')}
          value={role}
          options={[
            { value: 'all', label: t('filter.role.all') },
            { value: 'leader', label: t('filter.role.leader') },
            { value: 'member', label: t('filter.role.member') },
          ]}
          onChange={selectRole}
        />
        <Select
          className="cx-team-architecture__filter"
          aria-label={t('filter.session')}
          value={session}
          options={[
            { value: 'all', label: t('filter.session.all') },
            { value: 'active', label: t('filter.session.active') },
            { value: 'without-active', label: t('filter.session.without-active') },
          ]}
          onChange={selectSession}
        />
        <Select
          className="cx-team-architecture__filter"
          aria-label={t('filter.relationship')}
          value={relationship}
          options={[
            { value: 'all', label: t('filter.relationship.all') },
            { value: 'root', label: t('filter.relationship.root') },
            { value: 'reports-to', label: t('filter.relationship.reports-to') },
            { value: 'unestablished', label: t('filter.relationship.unestablished') },
          ]}
          onChange={selectRelationship}
        />
      </div>
      {model.matchedCount === 0
        ? <EmptyState title={t('tree.empty.title')} description={t('tree.empty.description')} />
        : (
          <div className="cx-team-architecture__groups">
            {model.roots.length > 0 && (
              <div className="cx-team-architecture__chart">
                <div
                  className="cx-team-architecture__chart-scroll"
                  role="region"
                  aria-label={t('tree.heading')}
                  tabIndex={0}
                >
                  <div className="cx-team-architecture__forest" role="list" aria-label={t('tree.heading')}>
                    {model.roots.map(node => (
                      <TreeNodeView
                        key={node.entity.memberId}
                        node={node}
                        onSelect={select}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
            {model.unestablished.length > 0 && (
              <section className="cx-team-architecture__unestablished" aria-labelledby="team-unestablished-heading">
                <h2 id="team-unestablished-heading">{t('tree.unestablished')}</h2>
                <div
                  className="cx-team-architecture__chart-scroll"
                  role="region"
                  aria-label={t('tree.unestablished')}
                  tabIndex={0}
                >
                  <div className="cx-team-architecture__forest" role="list" aria-label={t('tree.unestablished')}>
                    {model.unestablished.map(node => (
                      <TreeNodeView
                        key={node.entity.memberId}
                        node={node}
                        onSelect={select}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
    </div>
  );
}

function detailTabForRoute(
  routeId: string,
  detailRouteIds: TeamArchitectureDetailRouteIds,
): TeamEntityDetailTab | undefined {
  const matches = (localRouteId: string) => routeId === localRouteId || routeId.endsWith(`:${localRouteId}`);
  if (matches(detailRouteIds.overview)) return 'overview';
  if (matches(detailRouteIds.prompts)) return 'prompts';
  if (matches(detailRouteIds.relationships)) return 'relationships';
  if (matches(detailRouteIds.capabilities)) return 'capabilities';
  if (matches(detailRouteIds.sessions)) return 'sessions';
  return undefined;
}

function TeamArchitecturePage({ source, detailRouteIds, routeId, params, navigation, t }: TeamArchitecturePageProps) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const memberId = typeof params.memberId === 'string' ? params.memberId : undefined;
  let content: ReactNode;
  if (memberId === undefined) {
    content = (
      <TeamArchitectureRoot
        snapshot={snapshot}
        detailRouteIds={detailRouteIds}
        navigation={navigation}
        t={t}
      />
    );
  } else {
    const entities = projectEntities(snapshot);
    const entity = entities.find(candidate => candidate.memberId === memberId);
    const tab = detailTabForRoute(routeId, detailRouteIds);
    content = (
      <div className="cx-team-architecture">
        {entity === undefined || tab === undefined
          ? <EmptyState title={t('detail.missing.title')} description={t('detail.missing.description')} />
          : <EntityDetail entity={entity} entities={entities} tab={tab} t={t} />}
      </div>
    );
  }
  return (
    <Fragment>
      <style data-chatroom-team-architecture-styles="v1">{teamArchitectureCss}</style>
      {content}
    </Fragment>
  );
}

function projectEntities(snapshot: ReturnType<TeamArchitectureDataSource['getSnapshot']>) {
  return buildTeamArchitectureViewModel(snapshot).entities;
}

export function createTeamArchitecturePage(
  source: TeamArchitectureDataSource,
  detailRouteIds: TeamArchitectureDetailRouteIds,
  localization: CordisXLocalizationSeat<TeamArchitectureMessages>,
) {
  return defineReactPage<TeamArchitectureMessages>(props => (
    <TeamArchitecturePage {...props} t={localization.t} source={source} detailRouteIds={detailRouteIds} />
  ));
}
