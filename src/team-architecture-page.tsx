import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'cordisx/react';
import { defineReactPage } from 'cordisx/react';
import { AgentAvatar, Button, EmptyState, MarkdownViewer, Select } from 'cordisx/ui';
import type { CordisXLocalizationSeat, CordisXReactPageProps } from 'cordisx/contracts';
import {
  buildTeamArchitectureViewModel,
  type TeamArchitectureDataSource,
  teamEntityLocalHierarchy,
  teamEntityPromptSources,
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
  'detail.prompt-inherit.append': undefined;
  'detail.prompt-inherit.replace': undefined;
  'detail.prompt-upstream': undefined;
  'detail.prompt-current': undefined;
  'detail.prompt-self': { label: string; };
  'detail.prompt-unconfigured': undefined;
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

function EntityCard({ entity, current, contextOnly, onSelect, t }: {
  readonly entity: TeamEntityViewModel;
  readonly current?: boolean;
  readonly contextOnly?: boolean;
  readonly onSelect?: (memberId: string) => void;
  readonly t: Translate;
}) {
  const content = (
    <>
      <span className="cx-team-architecture__avatar" aria-hidden="true">
        <AgentAvatar participant={{ id: entity.memberId, name: entity.label, avatar: entity.avatar }} />
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
    </>
  );
  return onSelect === undefined
    ? (
      <div className="cx-team-architecture__entity" data-current={current ? 'true' : undefined}>
        {content}
      </div>
    )
    : (
      <button
        type="button"
        className="cx-team-architecture__entity"
        data-current={current ? 'true' : undefined}
        data-context-only={contextOnly ? 'true' : undefined}
        onClick={() => onSelect(entity.memberId)}
        aria-label={t('entity.open', { label: entity.label })}
      >
        {content}
      </button>
    );
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
        <EntityCard entity={entity} contextOnly={!node.matches} onSelect={onSelect} t={t} />
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

function detailTabLabel(tab: TeamEntityDetailTab, t: Translate): string {
  if (tab === 'overview') return t('detail.tab.overview');
  if (tab === 'prompts') return t('detail.tab.prompts');
  if (tab === 'relationships') return t('detail.tab.relationships');
  if (tab === 'capabilities') return t('detail.tab.capabilities');
  return t('detail.tab.sessions');
}

function PromptWorkspace({ entity, entities, t }: {
  readonly entity: TeamEntityViewModel;
  readonly entities: readonly TeamEntityViewModel[];
  readonly t: Translate;
}) {
  const sourceModels = teamEntityPromptSources(entity, entities);
  const promptKinds = [
    'introduction',
    'personality',
    'role',
    'operations',
    'tools',
    'knowledge',
    'memory-policy',
    'memory',
    'other',
  ] as const;
  const nodes = promptKinds.map(kind => ({
    kind,
    id: `kind:${kind}`,
    sources: sourceModels.map((source, sourceIndex) => ({
      id: `source:${kind}:${sourceIndex}`,
      kind,
      source,
      sections: source.promptSections.filter(section => section.kind === kind),
    })),
  }));
  const currentSourceIndex = Math.max(0, sourceModels.length - 1);
  const currentFirstKind = sourceModels[currentSourceIndex]?.promptSections[0]?.kind ?? promptKinds[0];
  const initialSelectedId = `source:${currentFirstKind}:${currentSourceIndex}`;
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<string>>(() => new Set(promptKinds));
  const [focusId, setFocusId] = useState(`kind:${promptKinds[0]}`);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const visibleIds = nodes.flatMap(node => [
    node.id,
    ...(expandedKinds.has(node.kind) ? node.sources.map(source => source.id) : []),
  ]);
  const selected = nodes.flatMap(node => node.sources).find(source => source.id === selectedId)
    ?? nodes[0].sources[currentSourceIndex];
  useEffect(() => {
    itemRefs.current.get(focusId)?.focus();
  }, [expandedKinds, focusId]);
  const focusRelative = (offset: number) => {
    const index = visibleIds.indexOf(focusId);
    const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, index + offset))];
    if (next !== undefined) setFocusId(next);
  };
  const toggleKind = (kind: string, expanded?: boolean) => {
    setExpandedKinds(current => {
      const next = new Set(current);
      const shouldExpand = expanded ?? !next.has(kind);
      if (shouldExpand) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };
  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const kindNode = nodes.find(node => node.id === focusId);
    const sourceNode = nodes.find(node => node.sources.some(source => source.id === focusId));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRelative(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'ArrowRight' && kindNode !== undefined) {
      event.preventDefault();
      if (!expandedKinds.has(kindNode.kind)) toggleKind(kindNode.kind, true);
      else if (kindNode.sources[0] !== undefined) setFocusId(kindNode.sources[0].id);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (sourceNode !== undefined) setFocusId(sourceNode.id);
      else if (kindNode !== undefined && expandedKinds.has(kindNode.kind)) toggleKind(kindNode.kind, false);
    } else if ((event.key === 'Enter' || event.key === ' ') && kindNode !== undefined) {
      event.preventDefault();
      toggleKind(kindNode.kind);
    } else if ((event.key === 'Enter' || event.key === ' ') && sourceNode !== undefined) {
      event.preventDefault();
      setSelectedId(focusId);
    }
  };
  const inheritance = entity.declaredCapabilities.inheritance?.promptSections;
  const inheritanceLabel = inheritance === 'append'
    ? t('detail.prompt-inherit.append')
    : inheritance === 'replace'
    ? t('detail.prompt-inherit.replace')
    : t('detail.unavailable');
  return (
    <section className="cx-team-architecture__section" aria-label={t('detail.tab.prompts')}>
      <div className="cx-team-architecture__prompt-metadata">
        <span>
          <strong>{t('detail.prompt-inherit')}</strong> {inheritanceLabel}
        </span>
        <span>
          <strong>{t('detail.prompt-upstream')}</strong> {sourceModels.length <= 1
            ? <span className="cx-team-architecture__muted">{t('detail.none')}</span>
            : sourceModels.slice(0, -1).map((source, index) => (
              <Fragment key={`${source.identity.agentId}@${source.identity.revision}`}>
                {index === 0 ? null : ', '}
                <span>{source.label}</span>
              </Fragment>
            ))}
        </span>
      </div>
      <div className="cx-team-architecture__prompt-workspace">
        <nav className="cx-team-architecture__prompt-selector" aria-label={t('detail.prompts')}>
          <div className="cx-team-architecture__prompt-tree" role="tree" onKeyDown={onTreeKeyDown}>
            {nodes.map(node => (
              <div className="cx-team-architecture__prompt-kind" key={node.id}>
                <button
                  ref={element => {
                    if (element === null) itemRefs.current.delete(node.id);
                    else itemRefs.current.set(node.id, element);
                  }}
                  type="button"
                  role="treeitem"
                  aria-expanded={expandedKinds.has(node.kind)}
                  tabIndex={focusId === node.id ? 0 : -1}
                  onFocus={() => setFocusId(node.id)}
                  onClick={() => toggleKind(node.kind)}
                >
                  {promptKindLabel(node.kind, t)}
                </button>
                {!expandedKinds.has(node.kind) ? null : (
                  <div role="group">
                    {node.sources.map(source => (
                      <button
                        ref={element => {
                          if (element === null) itemRefs.current.delete(source.id);
                          else itemRefs.current.set(source.id, element);
                        }}
                        key={source.id}
                        type="button"
                        role="treeitem"
                        aria-selected={source.id === selectedId}
                        aria-controls="team-entity-prompt-content"
                        tabIndex={focusId === source.id ? 0 : -1}
                        onFocus={() => setFocusId(source.id)}
                        onClick={() => setSelectedId(source.id)}
                      >
                        <span>
                          {source.source.kind === 'current'
                            ? t('detail.prompt-self', { label: entity.label })
                            : source.source.label}
                        </span>
                        {source.sections.length === 0
                          ? <small>{t('detail.prompt-unconfigured')}</small>
                          : <small>{source.source.label}</small>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </nav>
        <div
          id="team-entity-prompt-content"
          className="cx-team-architecture__prompt-content"
          role="tabpanel"
          aria-label={`${promptKindLabel(selected.kind, t)} · ${selected.source.label}`}
        >
          {selected.sections.length === 0
            ? <EmptyState title={t('detail.prompt-unconfigured')} />
            : selected.sections.map(section => (
              <div className="cx-team-architecture__prompt-document" key={section.sectionId}>
                <code>{section.sectionId}</code>
                <MarkdownViewer
                  aria-label={`${promptKindLabel(section.kind, t)} · ${selected.source.label}`}
                  source={section.text}
                />
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

function RelationshipHierarchy({ entity, entities, onSelect, t }: {
  readonly entity: TeamEntityViewModel;
  readonly entities: readonly TeamEntityViewModel[];
  readonly onSelect: (memberId: string) => void;
  readonly t: Translate;
}) {
  const { parents, children } = teamEntityLocalHierarchy(entity, entities);
  return (
    <section className="cx-team-architecture__section" aria-label={t('detail.tab.relationships')}>
      <div className="cx-team-architecture__relationship-map" role="group" aria-label={t('detail.relationships')}>
        {parents.length === 0 ? null : (
          <>
            <div className="cx-team-architecture__relationship-level" data-level="parents">
              <span className="cx-team-architecture__relationship-level-label">{t('detail.manager')}</span>
              <div className="cx-team-architecture__relationship-row">
                {parents.map(parent => <EntityCard key={parent.memberId} entity={parent} onSelect={onSelect} t={t} />)}
              </div>
            </div>
            <span className="cx-team-architecture__relationship-connector" aria-hidden="true" />
          </>
        )}
        <div className="cx-team-architecture__relationship-level" data-level="current">
          <div className="cx-team-architecture__relationship-row">
            <EntityCard entity={entity} current t={t} />
          </div>
        </div>
        <span className="cx-team-architecture__relationship-connector" aria-hidden="true" />
        <div className="cx-team-architecture__relationship-level" data-level="children">
          <span className="cx-team-architecture__relationship-level-label">{t('detail.direct-reports')}</span>
          <div className="cx-team-architecture__relationship-row">
            {children.length === 0
              ? <span className="cx-team-architecture__muted">{t('detail.none')}</span>
              : children.map(child => <EntityCard key={child.memberId} entity={child} onSelect={onSelect} t={t} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function SessionDetailTarget({ session, source, t }: {
  readonly session: TeamEntityViewModel['activeSessions'][number];
  readonly source: TeamArchitectureDataSource;
  readonly t: Translate;
}) {
  const [opening, setOpening] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  if (session.detail === undefined || unavailable) {
    return <span className="cx-team-architecture__muted">{t('detail.unavailable')}</span>;
  }
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={opening}
      onClick={() => {
        setOpening(true);
        void source.openSessionDetail(session.sessionId).then(opened => {
          if (!opened) setUnavailable(true);
          setOpening(false);
        }).catch(() => {
          setUnavailable(true);
          setOpening(false);
        });
      }}
    >
      {t('detail.session.target')}
    </Button>
  );
}

function EntityDetail({ entity, entities, tab, source, onSelect, t }: {
  readonly entity: TeamEntityViewModel;
  readonly entities: readonly TeamEntityViewModel[];
  readonly tab: TeamEntityDetailTab;
  readonly source: TeamArchitectureDataSource;
  readonly onSelect: (memberId: string) => void;
  readonly t: Translate;
}) {
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
        entities={entities}
        t={t}
      />
    );
  } else if (tab === 'relationships') {
    panel = <RelationshipHierarchy entity={entity} entities={entities} onSelect={onSelect} t={t} />;
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
                      <SessionDetailTarget session={session} source={source} t={t} />
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
          : (
            <EntityDetail
              entity={entity}
              entities={entities}
              tab={tab}
              source={source}
              onSelect={targetMemberId => {
                void navigation.navigate({ id: detailRouteIds.overview, params: { memberId: targetMemberId } });
              }}
              t={t}
            />
          )}
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
