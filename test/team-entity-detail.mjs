import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';
import {
  PLAYGROUND_COMPLEX_TEAM_DEFINITIONS,
  PLAYGROUND_COMPLEX_TEAM_MEMBERS,
} from './fixtures/playground-complex-team.mjs';

const sourceFiles = ['engagement-config', 'agent-definition', 'team-architecture-navigation'];

async function importCurrentNavigation() {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-team-detail-'));
  try {
    await Promise.all(sourceFiles.map(async name => {
      const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      const output = typescript.transpileModule(source, {
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2022,
        },
        fileName: `${name}.ts`,
      });
      await writeFile(join(directory, `${name}.js`), output.outputText);
    }));
    await writeFile(
      join(directory, 'team-architecture-page.js'),
      [
        "export const createTeamArchitecturePage = () => { throw new Error('page rendering is not used by this test'); };",
      ].join('\n'),
    );
    return {
      directory,
      agentDefinition: await import(pathToFileURL(join(directory, 'agent-definition.js')).href),
      navigation: await import(pathToFileURL(join(directory, 'team-architecture-navigation.js')).href),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function resolveExactOverview(declarations, identity) {
  return declarations.find(declaration =>
    declaration.subject?.kind === 'agent-definition'
    && declaration.subject.identity.agentId === identity.agentId
    && declaration.subject.identity.revision === identity.revision
  );
}

test('registers all 18 Playground members as unique exact Manager definition subjects', async () => {
  const modules = await importCurrentNavigation();
  try {
    const configuration = modules.agentDefinition.parseChatroomAgentConfiguration({
      ...modules.agentDefinition.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      seedLeaderIds: ['leader'],
      members: PLAYGROUND_COMPLEX_TEAM_MEMBERS,
      definitions: [
        ...modules.agentDefinition.CHATROOM_DEFAULT_AGENT_CONFIGURATION.definitions,
        ...PLAYGROUND_COMPLEX_TEAM_DEFINITIONS,
      ],
    });
    const declarations = modules.navigation.teamArchitectureManagerContentDeclarations({ configuration });
    const subjects = declarations.flatMap(declaration =>
      declaration.subject?.kind === 'agent-definition' ? [declaration.subject.identity] : []
    );
    assert.equal(subjects.length, 18);
    assert.equal(new Set(subjects.map(identity => `${identity.agentId}@${identity.revision}`)).size, 18);
  } finally {
    await rm(modules.directory, { recursive: true, force: true });
  }
});

test('declares exact Agent identities and one stable Host record summary across all five tabs', async () => {
  const modules = await importCurrentNavigation();
  try {
    const configuration = modules.agentDefinition.parseChatroomAgentConfiguration(
      modules.agentDefinition.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    );
    const declarations = modules.navigation.teamArchitectureManagerContentDeclarations({ configuration });
    assert.deepEqual(
      modules.navigation.teamArchitectureManagerContentDeclarations({ configuration }),
      declarations,
      'reload/reprojection must not renumber or relabel detail declarations',
    );
    const details = declarations.filter(declaration => declaration.route.params?.memberId !== undefined);
    const leadOverview = details.find(declaration =>
      declaration.route.params.memberId === 'leader'
      && declaration.route.id === modules.navigation.TEAM_ARCHITECTURE_DETAIL_ROUTE_ID
    );
    assert.equal(leadOverview?.recordSummary?.title.fallback, 'Lead');
    const pageById = new Map([
      modules.navigation.TEAM_ARCHITECTURE_PAGE,
      ...modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGES,
    ].map(page => [page.id, page]));
    assert.deepEqual(
      modules.navigation.TEAM_ARCHITECTURE_ROUTES.map(route => [route.id, route.page, pageById.get(route.page)?.icon]),
      [
        [modules.navigation.TEAM_ARCHITECTURE_ROUTE_ID, modules.navigation.TEAM_ARCHITECTURE_PAGE_ID, 'host:hierarchy'],
        [
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_ROUTE_ID,
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGE_IDS.overview,
          'host:info',
        ],
        [
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID,
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGE_IDS.prompts,
          'host:files',
        ],
        [
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGE_IDS.relationships,
          'host:hierarchy',
        ],
        [
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGE_IDS.capabilities,
          'host:layers',
        ],
        [
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID,
          modules.navigation.TEAM_ARCHITECTURE_DETAIL_PAGE_IDS.sessions,
          'host:history',
        ],
      ],
    );

    assert.equal(details.length, 25);
    for (const member of configuration.members) {
      const memberDetails = details.filter(declaration => declaration.route.params.memberId === member.memberId);
      const definition = configuration.definitions.find(candidate =>
        candidate.identity.agentId === member.definition.agentId
        && candidate.identity.revision === member.definition.revision
      );
      assert.ok(definition);
      assert.equal(memberDetails.length, 5);
      assert.deepEqual(memberDetails.map(declaration => declaration.schemaVersion), [3, 3, 3, 3, 3]);
      assert.deepEqual(memberDetails.map(declaration => declaration.route.id), [
        modules.navigation.TEAM_ARCHITECTURE_DETAIL_ROUTE_ID,
        modules.navigation.TEAM_ARCHITECTURE_DETAIL_PROMPTS_ROUTE_ID,
        modules.navigation.TEAM_ARCHITECTURE_DETAIL_RELATIONSHIPS_ROUTE_ID,
        modules.navigation.TEAM_ARCHITECTURE_DETAIL_CAPABILITIES_ROUTE_ID,
        modules.navigation.TEAM_ARCHITECTURE_DETAIL_SESSIONS_ROUTE_ID,
      ]);
      assert.equal(memberDetails.every(declaration => declaration.route.params.memberId === member.memberId), true);
      assert.deepEqual(memberDetails.map(declaration => declaration.tabs.map(tab => tab.route.params.memberId)), [
        [member.memberId, member.memberId, member.memberId, member.memberId, member.memberId],
        [member.memberId, member.memberId, member.memberId, member.memberId, member.memberId],
        [member.memberId, member.memberId, member.memberId, member.memberId, member.memberId],
        [member.memberId, member.memberId, member.memberId, member.memberId, member.memberId],
        [member.memberId, member.memberId, member.memberId, member.memberId, member.memberId],
      ]);
      const [overview, ...otherTabs] = memberDetails;
      assert.deepEqual(overview.subject, { kind: 'agent-definition', identity: member.definition });
      assert.equal(otherTabs.every(declaration => declaration.subject === undefined), true);
      assert.equal(overview.recordSummary.title.fallback, member.label);
      assert.equal(overview.recordSummary.description?.fallback, definition.description);
      assert.deepEqual(
        memberDetails.map(declaration => declaration.recordSummary),
        Array.from({ length: 5 }, () => overview.recordSummary),
      );
      assert.deepEqual(resolveExactOverview(declarations, member.definition), overview);
    }

    assert.equal(
      resolveExactOverview(declarations, {
        agentId: configuration.members[0].definition.agentId,
        revision: 'stale-revision',
      }),
      undefined,
    );
    assert.equal(
      resolveExactOverview(declarations, {
        agentId: 'chatroom.missing',
        revision: configuration.members[0].definition.revision,
      }),
      undefined,
    );
  } finally {
    await rm(modules.directory, { recursive: true, force: true });
  }
});

test('fails the Manager subject and summary closed when a member identity is stale', async () => {
  const modules = await importCurrentNavigation();
  try {
    const current = modules.agentDefinition.parseChatroomAgentConfiguration(
      modules.agentDefinition.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    );
    const staleMember = Object.freeze({
      ...current.members[1],
      definition: Object.freeze({ ...current.members[1].definition, revision: 'stale-revision' }),
    });
    const configuration = Object.freeze({
      ...current,
      members: Object.freeze([current.members[0], staleMember, ...current.members.slice(2)]),
    });
    const declarations = modules.navigation.teamArchitectureManagerContentDeclarations({ configuration });
    const staleDetails = declarations.filter(declaration =>
      declaration.route.params?.memberId === staleMember.memberId
    );

    assert.equal(staleDetails.length, 5);
    assert.equal(staleDetails.every(declaration => declaration.schemaVersion === 2), true);
    assert.equal(staleDetails.every(declaration => declaration.subject === undefined), true);
    assert.equal(staleDetails.every(declaration => declaration.recordSummary === undefined), true);
    assert.equal(resolveExactOverview(declarations, staleMember.definition), undefined);
  } finally {
    await rm(modules.directory, { recursive: true, force: true });
  }
});

test('uses public Host avatars and Markdown with cardless responsive prompt and relationship workspaces', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.css', import.meta.url), 'utf8'),
  ]);

  assert.match(
    page,
    /HorizontalSplitPane,[\s\S]*?HoverCard,[\s\S]*?Icon,[\s\S]*?PanZoomCanvas,[\s\S]*?from 'cordisx\/ui';/u,
  );
  assert.doesNotMatch(page, /from ['"](?:tdesign-react|react-markdown|rehype-|remark-)/u);
  assert.match(page, /teamEntityPromptSources\(entity, entities\)/u);
  assert.match(
    page,
    /const promptKinds = \[[\s\S]*?'introduction'[\s\S]*?'personality'[\s\S]*?'role'[\s\S]*?'operations'[\s\S]*?'tools'[\s\S]*?'knowledge'[\s\S]*?'memory-policy'[\s\S]*?'memory'[\s\S]*?'other'/u,
  );
  assert.match(page, /const nodes = promptKinds\.map\(kind => \(\{[\s\S]*?sources: sourceModels\.map/u);
  assert.match(page, /role="tree"/u);
  assert.match(page, /role="treeitem"/u);
  assert.match(page, /role="group"/u);
  assert.match(page, /aria-expanded=\{expandedKinds\.has\(node\.kind\)\}/u);
  assert.match(page, /aria-controls=\{`team-prompt-group-\$\{node\.kind\}`\}/u);
  assert.match(page, /aria-selected=\{source\.id === selectedId\}/u);
  assert.match(page, /name=\{expandedKinds\.has\(node\.kind\) \? 'folder-open' : 'folder'\}/u);
  assert.match(page, /<Icon name="file" aria-hidden="true" \/>/u);
  assert.match(page, /event\.key === 'ArrowDown'/u);
  assert.match(page, /event\.key === 'ArrowRight'/u);
  assert.match(page, /event\.key === 'ArrowLeft'/u);
  assert.match(page, /event\.key === 'Enter' \|\| event\.key === ' '/u);
  assert.match(page, /<MarkdownViewer[\s\S]*?source=\{section\.text\}/u);
  assert.match(page, /<EmptyState title=\{t\('detail\.prompt-unconfigured'\)\} \/>/u);
  assert.match(page, /teamEntityLocalHierarchy\(entity, entities\)/u);
  assert.match(page, /const \{ parents, subtree \} = teamEntityLocalHierarchy/u);
  assert.match(page, /<EntityTreeCanvas[\s\S]*?nodes=\{nodes\}[\s\S]*?currentMemberId=\{entity\.memberId\}/u);
  assert.match(page, /function EntityCard/u);
  assert.doesNotMatch(page, /relationship-(?:card|map|level|level-label|row|connector)/u);
  assert.doesNotMatch(css, /relationship-(?:card|map|level|level-label|row|connector)/u);
  assert.doesNotMatch(page, />└</u);
  assert.doesNotMatch(page, /cx-team-architecture__prompt-metadata/u);
  assert.doesNotMatch(page, /t\('detail\.prompt-(?:inherit|upstream)'\)/u);
  assert.doesNotMatch(page, /<h3/u);
  assert.doesNotMatch(page, /cx-team-architecture__detail-(?:heading|eyebrow)/u);

  const sectionRule = css.match(/\.cx-team-architecture__section \{([^}]*)\}/u)?.[1] ?? '';
  assert.doesNotMatch(sectionRule, /(?:border|background|border-radius|padding)\s*:/u);
  assert.doesNotMatch(css, /cx-team-architecture__prompt-metadata/u);
});

test('reuses one compact member card with full Host HoverCard details across both trees', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.css', import.meta.url), 'utf8'),
  ]);

  assert.match(page, /const title = entity\.title \?\? roleLabel\(entity, t\);/u);
  assert.match(page, /<HoverCard[\s\S]*?placement="top"[\s\S]*?trigger=\{[\s\S]*?<button/u);
  assert.match(page, /content=\{[\s\S]*?<Stack gap="small">/u);
  assert.match(page, /<strong>\{entity\.label\}<\/strong>/u);
  assert.match(page, /\{title\}<\/Text>/u);
  assert.match(page, /<code>\{entity\.memberId\}<\/code>/u);
  assert.match(page, /entity\.definitionName/u);
  assert.match(page, /entity\.description/u);
  assert.match(page, /\{sessionStatus\}<\/Text>/u);
  assert.doesNotMatch(page, /cx-team-architecture__session-(?:state|dot)/u);
  assert.doesNotMatch(css, /cx-team-architecture__session-(?:state|dot)/u);
  assert.match(page, /<TreeNodeView[\s\S]*?<EntityCard/u);
  assert.match(page, /<EntityCard entity=\{parent\} onSelect=\{onSelect\} t=\{t\} \/>/u);

  const entityRule = css.match(/\.cx-team-architecture__entity \{([^}]*)\}/u)?.[1] ?? '';
  const avatarRule = css.match(/\.cx-team-architecture__avatar \{([^}]*)\}/u)?.[1] ?? '';
  const forestRule = css.match(/\.cx-team-architecture__forest \{([^}]*)\}/u)?.[1] ?? '';
  const childrenRule = css.match(/\.cx-team-architecture__children \{([^}]*)\}/u)?.[1] ?? '';
  const viewportRule = css.match(/\.cx-team-architecture__tree-viewport \{([^}]*)\}/u)?.[1] ?? '';
  const nameRule = css.match(/\.cx-team-architecture__entity-title \{([^}]*)\}/u)?.[1] ?? '';
  const titleRule = css.match(/\.cx-team-architecture__entity-identity \{([^}]*)\}/u)?.[1] ?? '';
  const connectorRule = css.match(
    /\.cx-team-architecture__node-seat\[data-has-children='true'\]::after \{([^}]*)\}/u,
  )?.[1] ?? '';
  assert.match(entityRule, /width: fit-content;/u);
  assert.match(entityRule, /max-width: 190px;/u);
  assert.match(entityRule, /height: 48px;/u);
  assert.match(entityRule, /border: 0;/u);
  assert.match(entityRule, /background: transparent;/u);
  assert.match(entityRule, /box-shadow: none;/u);
  assert.match(avatarRule, /width: 32px;/u);
  assert.match(avatarRule, /height: 32px;/u);
  assert.match(forestRule, /gap: 24px;/u);
  assert.match(childrenRule, /gap: 12px;/u);
  assert.match(viewportRule, /height: 100%;/u);
  assert.match(connectorRule, /left: var\(--cx-team-avatar-center\);/u);
  for (const rule of [nameRule, titleRule]) {
    assert.match(rule, /overflow: hidden;/u);
    assert.match(rule, /min-width: 0;/u);
    assert.match(rule, /text-overflow: ellipsis;/u);
    assert.match(rule, /white-space: nowrap;/u);
  }
});

test('uses Host pan zoom, depth-three expansion, search reveal, and icon-leading compact filters', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.css', import.meta.url), 'utf8'),
  ]);

  assert.match(page, /expandableMemberIds\(nodes, startDepth, 3\)/u);
  assert.match(page, /const effectiveExpanded = revealMatches \? allExpanded : expandedMemberIds;/u);
  assert.match(page, /if \(revealMatches\) return;/u);
  assert.match(page, /\{expanded && \([\s\S]*?node\.children\.map/u);
  assert.match(page, /aria-expanded=\{hasChildren \? expanded : undefined\}/u);
  assert.match(page, /t\('tree\.expand',[\s\S]*?count: node\.children\.length/u);
  assert.match(page, /<PanZoomCanvas[\s\S]*?fill[\s\S]*?controllerRef=\{canvas\}[\s\S]*?minScale=\{0\.3\}/u);
  assert.match(page, /canvas\.current\?\.fitToView\(\)/u);
  assert.match(page, /canvas\.current\?\.reset\(\)/u);
  assert.doesNotMatch(page, /cx-team-architecture__chart-scroll/u);
  assert.doesNotMatch(css, /cx-team-architecture__chart-scroll/u);
  assert.doesNotMatch(css, /100vh|calc\([^)]*vh|\.cxr-|data-cordisx-page/u);

  for (const icon of ['role', 'session', 'relationship']) {
    assert.match(
      page,
      new RegExp(`density="compact"[\\s\\S]*?prefixIcon=\\{<Icon name="${icon}" aria-hidden="true" \\/>\\}`),
    );
  }
  assert.doesNotMatch(css, /cx-team-architecture__filter/u);

  const rootRule = css.match(/\.cx-team-architecture:not\(\[data-detail-tab\]\) \{([^}]*)\}/u)?.[1] ?? '';
  const groupsRule = css.match(/\.cx-team-architecture__groups \{([^}]*)\}/u)?.[1] ?? '';
  const canvasRule = css.match(/\.cx-team-architecture__tree-canvas \{([^}]*)\}/u)?.[1] ?? '';
  const viewportRule = css.match(/\.cx-team-architecture__tree-viewport \{([^}]*)\}/u)?.[1] ?? '';
  assert.doesNotMatch(viewportRule, /overflow/u);
  for (const rule of [rootRule, groupsRule, canvasRule, viewportRule]) {
    assert.match(rule, /height: 100%;/u);
    assert.match(rule, /min-height: 0;/u);
  }
});

test('renders a compact IDE prompt tree with guide lines and independent pane scrolling', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.css', import.meta.url), 'utf8'),
  ]);

  assert.match(page, /id=\{`team-prompt-group-\$\{node\.kind\}`\}[\s\S]*?role="group"/u);
  assert.match(page, /data-unconfigured=\{source\.sections\.length === 0 \? 'true' : undefined\}/u);
  assert.match(page, /className="cx-team-architecture" data-detail-tab=\{tab\}/u);
  assert.match(
    page,
    /<HorizontalSplitPane[\s\S]*?initialLeftSize=\{270\}[\s\S]*?minLeftSize=\{220\}[\s\S]*?maxLeftSize=\{360\}[\s\S]*?separatorLabel=\{t\('detail\.prompts'\)\}/u,
  );
  assert.match(page, /left=\{[\s\S]*?cx-team-architecture__prompt-selector/u);
  assert.match(page, /right=\{[\s\S]*?cx-team-architecture__prompt-content/u);
  assert.doesNotMatch(page, /prompt-chevron|<svg|host:folder|host:files/u);
  assert.doesNotMatch(css, /prompt-chevron|prompt-icon/u);
  assert.match(
    css,
    /\.cx-team-architecture__prompt-kind button \{[\s\S]*?min-height: 26px;[\s\S]*?padding: 2px 6px;/u,
  );
  assert.match(css, /\.cx-team-architecture__prompt-kind > \[role='group'\]::before/u);
  assert.match(css, /\.cx-team-architecture__prompt-kind > \[role='group'\] > button::before/u);
  const workspaceRule = css.match(/\.cx-team-architecture__prompt-workspace \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(workspaceRule, /height: 100%;/u);
  assert.match(workspaceRule, /min-height: 0;/u);
  assert.match(workspaceRule, /overflow: hidden;/u);
  assert.doesNotMatch(workspaceRule, /display:|grid-template-columns:/u);
  const sharedPaneRule = css.match(
    /\.cx-team-architecture__prompt-selector,\s*\.cx-team-architecture__prompt-content \{([^}]*)\}/u,
  )?.[1] ?? '';
  const selectorRule = css.match(/\.cx-team-architecture__prompt-selector \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(sharedPaneRule, /min-height: 0;/u);
  assert.match(sharedPaneRule, /overscroll-behavior: contain;/u);
  assert.match(selectorRule, /overflow-y: auto;/u);
  assert.match(css, /\.cx-team-architecture__prompt-content \{\s*overflow: auto;/u);
});

test('keeps active Session detail navigation unavailable until a public Host action exists', async () => {
  const [viewModel, page] = await Promise.all([
    readFile(new URL('../src/team-entity-view-model.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(viewModel, /readonly detail\?: AgentDetailReference;/u);
  assert.match(viewModel, /services\.references\.get\(\{ sessionId \}\)/u);
  assert.match(viewModel, /services\.navigation\.open\(\{ target \}\)/u);
  assert.match(viewModel, /const epoch = \+\+detailEpoch;/u);
  assert.match(viewModel, /epoch !== detailEpoch/u);
  assert.match(viewModel, /Never infer it from[\s\S]*?URL, current Agent, or mutable entity record/u);
  assert.match(page, /<SessionDetailTarget session=\{session\} source=\{source\} t=\{t\} \/>/u);
  assert.match(page, /session\.detail === undefined \|\| unavailable/u);
  assert.match(page, /source\.openSessionDetail\(session\.sessionId\)/u);
  assert.doesNotMatch(page, /session\.detailsUrl\.url/u);
});
