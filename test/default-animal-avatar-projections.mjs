import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';

const sourceFiles = [
  'agent-definition',
  'conversation-model',
  'engagement-config',
  'room',
  'room-engagement',
  'room-management',
  'team-entity-view-model',
];

const expectedAvatars = Object.freeze([
  Object.freeze({
    kind: 'asset',
    ref: 'oneworks-avatar:asset.red-fox.v1',
    revision: 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
  }),
  Object.freeze({
    kind: 'asset',
    ref: 'oneworks-avatar:asset.arctic-fox.v1',
    revision: 'oneworks-avatar:editor-arctic-fox-2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011',
  }),
  Object.freeze({
    kind: 'asset',
    ref: 'oneworks-avatar:asset.d85c0abccffd4d539da85cb67eb8bcbf.v1',
    revision: 'oneworks-avatar:editor-syrian-hamster-5eebb3ea9c0131005fd336e7c8494c74fce92903373272632da940f22307c1f7',
  }),
  Object.freeze({
    kind: 'asset',
    ref: 'oneworks-avatar:asset.5089b05857414a4c9f2bf1c0c5079edc.v1',
    revision: 'oneworks-avatar:editor-asian-small-clawed-otter-4ceef0184bd3d2fd6a469b20decf1d0dd3cd726bbeaf3d07c43389ba5b2bab6f',
  }),
  Object.freeze({
    kind: 'asset',
    ref: 'oneworks-avatar:asset.7ca113246df74241ab1bdedc04f6fde9.v1',
    revision: 'oneworks-avatar:editor-yellow-duckling-a8d6820ff62d33d931b2554f6080126c2685ad84eed34a559ef7407374b447c6',
  }),
]);

async function importCurrentSources() {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-animal-avatars-'));
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
    return {
      directory,
      agentDefinition: await import(pathToFileURL(join(directory, 'agent-definition.js')).href),
      conversationModel: await import(pathToFileURL(join(directory, 'conversation-model.js')).href),
      room: await import(pathToFileURL(join(directory, 'room.js')).href),
      engagement: await import(pathToFileURL(join(directory, 'room-engagement.js')).href),
      team: await import(pathToFileURL(join(directory, 'team-entity-view-model.js')).href),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const userMessage = Object.freeze({
  kind: 'message', itemId: 'user-message', messageId: 'user-message', sequence: 1,
  source: 'agent-loop', semantic: { purpose: 'conversation' },
  author: { participantId: 'user', role: 'human', displayName: { fallback: 'You' } },
  body: [{ kind: 'text', text: { fallback: 'Please verify the release.' } }],
  reactions: [], timestamp: '2026-09-02T00:00:00.000Z', deliveryState: 'delivered',
  runState: 'idle', ariaLive: 'off', actions: [],
});

const qaMessage = Object.freeze({
  kind: 'message', itemId: 'qa-message', messageId: 'qa-message', sequence: 2,
  source: 'agent-loop', semantic: { purpose: 'conversation' },
  author: { participantId: 'qa', role: 'agent', displayName: { fallback: 'QA' } },
  body: [{ kind: 'text', text: { fallback: 'Verified.' } }],
  reactions: [], timestamp: '2026-09-02T00:00:01.000Z', deliveryState: 'delivered',
  runState: 'idle', ariaLive: 'off', actions: [],
});

test('keeps five default animal AvatarRefs stable across Room, message, reaction, Team, and detail projections', async () => {
  const modules = await importCurrentSources();
  try {
    const configuration = modules.agentDefinition.parseChatroomAgentConfiguration(
      modules.agentDefinition.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    );
    const memberships = modules.room.expandRoomMemberships(configuration);
    const participants = [
      { id: 'user', name: 'You', kind: 'human' },
      ...memberships.map(member => ({
        id: member.participantId,
        name: member.label,
        kind: 'agent',
        avatar: member.avatar,
      })),
    ];
    let room = modules.room.createRoom({
      id: 'animal-room', title: 'Animal avatars', memberships,
      seedLeaderIds: configuration.seedLeaderIds, participants,
      items: [userMessage, qaMessage], timelineSequence: 2,
      participantPresentation: { multiParticipant: true, participantPresentation: 'host-initials' },
    });
    room = modules.room.addRoomRun(room, {
      runId: 'integrator-run', memberId: 'integrator', title: 'Integrator', status: 'creating',
    });
    room = modules.engagement.prepareRoomAcknowledgement(room, configuration, {
      userItemId: 'user-message', memberId: 'integrator', runId: 'integrator-run',
    }).room;

    const defaultRefs = configuration.definitions.map(definition => definition.avatar);
    assert.deepEqual(defaultRefs, expectedAvatars);
    assert.equal(new Set(defaultRefs.map(avatar => avatar.ref)).size, 5);
    assert.equal(new Set(defaultRefs.slice(2).map(avatar => avatar.ref)).size, 3);
    assert.equal(defaultRefs.every(avatar => avatar.kind === 'asset' && Object.isFrozen(avatar)), true);
    assert.deepEqual(memberships.map(member => member.avatar), expectedAvatars);
    assert.deepEqual(room.memberships.map(member => member.avatar), expectedAvatars);
    assert.deepEqual(room.participants.filter(participant => participant.kind === 'agent')
      .map(participant => participant.avatar), expectedAvatars);

    const model = modules.conversationModel.createRoomConversationModel(room);
    assert.equal(model.selection.kind, 'room');
    const agents = model.selection.participants.filter(participant => participant.role === 'agent');
    assert.deepEqual(agents.map(participant => participant.avatar), expectedAvatars);
    assert.deepEqual(agents.map(participant => participant.agentIdentity),
      configuration.members.map(member => member.definition));

    const teamEntities = modules.team.projectTeamEntities(configuration, [room]);
    assert.deepEqual(teamEntities.map(entity => entity.avatar), expectedAvatars);
    assert.deepEqual(teamEntities.map(entity => entity.definitionIdentity),
      agents.map(participant => participant.agentIdentity));

    const projectedQaMessage = model.items.find(item => item.kind === 'message'
      && item.author.participantId === 'qa');
    assert.deepEqual(projectedQaMessage.author.avatar, expectedAvatars[4]);
    assert.deepEqual(projectedQaMessage.author,
      agents.find(participant => participant.participantId === 'qa'));

    const projectedUserMessage = model.items.find(item => item.kind === 'message'
      && item.author.participantId === 'user');
    assert.equal(projectedUserMessage.reactions[0].actorParticipantId, 'integrator');
    assert.deepEqual(
      agents.find(participant =>
        participant.participantId === projectedUserMessage.reactions[0].actorParticipantId).avatar,
      expectedAvatars[2],
    );

    const refreshed = modules.room.createRoom({
      id: 'animal-room-refreshed', title: 'Animal avatars refreshed',
      memberships: modules.room.expandRoomMemberships(configuration),
      seedLeaderIds: configuration.seedLeaderIds, participants,
    });
    assert.deepEqual(refreshed.memberships.map(member => member.avatar), expectedAvatars);
  } finally {
    await rm(modules.directory, { recursive: true, force: true });
  }
});
