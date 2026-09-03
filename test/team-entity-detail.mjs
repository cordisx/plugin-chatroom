import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';

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
    await writeFile(join(directory, 'team-architecture-page.js'), [
      "export const createTeamArchitecturePage = () => { throw new Error('page rendering is not used by this test'); };",
    ].join('\n'));
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
  return declarations.find(declaration => declaration.subject?.kind === 'agent-definition'
    && declaration.subject.identity.agentId === identity.agentId
    && declaration.subject.identity.revision === identity.revision);
}

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

    assert.equal(details.length, 25);
    for (const member of configuration.members) {
      const memberDetails = details.filter(declaration => declaration.route.params.memberId === member.memberId);
      const definition = configuration.definitions.find(candidate => candidate.identity.agentId === member.definition.agentId
        && candidate.identity.revision === member.definition.revision);
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
      assert.equal(overview.recordSummary.title.fallback, definition.name ?? member.label);
      assert.equal(overview.recordSummary.description?.fallback, definition.description);
      assert.deepEqual(
        memberDetails.map(declaration => declaration.recordSummary),
        Array.from({ length: 5 }, () => overview.recordSummary),
      );
      assert.deepEqual(resolveExactOverview(declarations, member.definition), overview);
    }

    assert.equal(resolveExactOverview(declarations, {
      agentId: configuration.members[0].definition.agentId,
      revision: 'stale-revision',
    }), undefined);
    assert.equal(resolveExactOverview(declarations, {
      agentId: 'chatroom.missing',
      revision: configuration.members[0].definition.revision,
    }), undefined);
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
    const staleDetails = declarations.filter(declaration => declaration.route.params?.memberId === staleMember.memberId);

    assert.equal(staleDetails.length, 5);
    assert.equal(staleDetails.every(declaration => declaration.schemaVersion === 2), true);
    assert.equal(staleDetails.every(declaration => declaration.subject === undefined), true);
    assert.equal(staleDetails.every(declaration => declaration.recordSummary === undefined), true);
    assert.equal(resolveExactOverview(declarations, staleMember.definition), undefined);
  } finally {
    await rm(modules.directory, { recursive: true, force: true });
  }
});

test('uses only public Host selection and sanitized Markdown primitives in a cardless responsive detail body', async () => {
  const [page, css] = await Promise.all([
    readFile(new URL('../src/team-architecture-page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/team-architecture-page.css', import.meta.url), 'utf8'),
  ]);

  assert.match(page, /import \{ EmptyState, MarkdownViewer, Select, SelectionRail \} from 'cordisx\/ui';/u);
  assert.doesNotMatch(page, /from ['"](?:tdesign-react|react-markdown|rehype-|remark-)/u);
  assert.match(page, /const sections = entity\.declaredCapabilities\.promptSections;/u);
  assert.match(page, /<SelectionRail[\s\S]*?options=\{sections\.map\([\s\S]*?layout="responsive"/u);
  assert.match(page, /<MarkdownViewer[\s\S]*?source=\{selected\.text\}/u);
  assert.doesNotMatch(page, /<h3/u);
  assert.doesNotMatch(page, /cx-team-architecture__detail-(?:heading|eyebrow)/u);

  const sectionRule = css.match(/\.cx-team-architecture__section \{([^}]*)\}/u)?.[1] ?? '';
  assert.doesNotMatch(sectionRule, /(?:border|background|border-radius|padding)\s*:/u);
  assert.match(css, /\.cx-team-architecture__prompt-workspace \{[\s\S]*?grid-template-columns: minmax\(180px, 240px\) minmax\(0, 1fr\);/u);
  assert.match(css, /@media \(max-width: 620px\) \{[\s\S]*?\.cx-team-architecture__prompt-workspace \{\s*grid-template-columns: 1fr;/u);
  assert.doesNotMatch(css, /cx-team-architecture__prompt-section/u);
});
