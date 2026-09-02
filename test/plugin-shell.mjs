import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';

const emptyRoomLeadingVisual = Object.freeze({
  kind: 'room-composite-avatar', participants: [],
});

const sourceFiles = [
  'agent-definition', 'agent-loop-controller', 'agent-loop-projection',
  'chatroom', 'conversation-model', 'conversation-source', 'engagement-config',
  'room', 'room-agent-operations', 'room-delivery', 'room-engagement', 'room-navigation',
  'room-store', 'room-target',
];

async function importSourceEntry() {
  const directory = await mkdtemp(join(process.cwd(), '.chatroom-plugin-shell-'));
  try {
    await writeFile(join(directory, 'contracts-stub.js'), [
      "export const CORDISX_PAGE_SCHEMA_V3 = 'page.v3';",
      "export const CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 = 'plugin.manifest.v1';",
      "export const CORDISX_ROUTE_SCHEMA_V2 = 'route.v2';",
    ].join('\n'));
    await Promise.all(sourceFiles.map(async name => {
      const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      const output = typescript.transpileModule(name === 'chatroom'
        ? source.replace("from 'cordisx/contracts'", "from './contracts-stub.js'")
        : source, {
        compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
        fileName: `${name}.ts`,
      });
      await writeFile(join(directory, `${name}.js`), output.outputText);
    }));
    return {
      directory,
      entry: await import(pathToFileURL(join(directory, 'chatroom.js')).href),
      navigation: await import(pathToFileURL(join(directory, 'room-navigation.js')).href),
      room: await import(pathToFileURL(join(directory, 'room.js')).href),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('registers a Host-owned conversation shell without a plugin renderer', async () => {
  const entry = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');
  const model = await readFile(new URL('../src/conversation-model.ts', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/conversation-source.ts', import.meta.url), 'utf8');
  const productSources = (await Promise.all(sourceFiles.map(name =>
    readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')))).join('\n');

  await assert.rejects(access(new URL('../src/chatroom-page.tsx', import.meta.url)));
  assert.match(entry, /ctx\.pages\.register/);
  assert.match(entry, /ctx\.routes\.register/);
  assert.match(entry, /agentConversationShell/);
  assert.match(entry, /registerSource/);
  assert.match(entry, /conversation\.mount/);
  assert.match(entry, /chrome: 'body-only'/);
  assert.match(entry, /\/main\/chatroom\/:roomId/);
  assert.match(entry, /sidebar\.navigation\.items/);
  assert.match(entry, /openOwnerDocuments\(ctx\.documents\)/);
  assert.ok(entry.indexOf('await agentLoop.hydrate()') < entry.indexOf('ctx.commands.register'),
    'durable recovery and explicit rebind finish before production registrations');
  assert.match(entry, /['"]documents['"]/);
  assert.doesNotMatch(entry, /DurableChatroomRoomStore\.memory/);
  assert.doesNotMatch(`${entry}\n${source}`, /\bdocument\.|\bwindow\.|innerHTML|http\.server|defineReactPage|useState/);
  assert.match(source, /AgentConversationShellSource/);
  assert.match(source, /submitPayload/);
  assert.doesNotMatch(`${entry}\n${model}\n${source}`, /avatarUrl|avatarPath|base64|data:|blob:|@oneworks\/avatar|avatar-react/i);
  assert.doesNotMatch(productSources,
    /recent[-_ ]?tasks?|task[-_ ]?row|registerRecent|decorateTask|recent[^\n]{0,80}(?:icon|avatar)|(?:icon|avatar)[^\n]{0,80}recent/i,
    'Chatroom owns Room/run relations but never a Host Recent tasks presentation');
});

test('registers local command ids and maps the same ids through the shell', async () => {
  const entry = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');
  const model = await readFile(new URL('../src/conversation-model.ts', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/conversation-source.ts', import.meta.url), 'utf8');

  assert.match(model, /CHATROOM_COMMAND_SUBMIT = 'submit'/);
  assert.doesNotMatch(`${entry}\n${model}\n${source}`, /chatroom:(?:new-room|submit)/);
  assert.match(entry, /ctx\.commands\.register\(\{ id: CHATROOM_COMMAND_SUBMIT/);
  assert.match(model, /submit: \{ id: CHATROOM_COMMAND_SUBMIT \}/);
  assert.match(source, /context\.command\.id !== CHATROOM_COMMAND_SUBMIT/);

  const { directory, entry: runtime } = await importSourceEntry();
  try {
    const commands = [];
    const factories = [];
    const pages = [];
    const navigations = [];
    const collections = [];
    const loopCalls = [];
    const registrations = [];
    const documentListeners = new Set();
    let durableSnapshot;
    const taskBinding = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v2.schema.json',
      contract: 'cordisx.agent-loop-task-binding/v2', schemaVersion: 2,
      binding: { bindingId: 'loop-binding-1', generation: 1 },
      definition: { agentId: 'chatroom.generalist', revision: 'chatroom-internal-v1' },
      task: 'Opaque:Task-1', state: 'active',
    };
    await runtime.apply({
      documents: {
        async load(documentId) {
          registrations.push(`documents.load:${documentId}`);
          return durableSnapshot === undefined
            ? { status: 'missing', revision: 0 }
            : { status: 'loaded', snapshot: durableSnapshot };
        },
        async transaction(command) {
          const actualRevision = durableSnapshot?.revision ?? 0;
          if (command.expectedRevision !== actualRevision) return { status: 'conflict', actualRevision };
          durableSnapshot = {
            contract: 'cordisx.owner-documents/v1', revision: actualRevision + 1,
            schemaVersion: command.schemaVersion,
            value: JSON.parse(JSON.stringify(command.value)),
          };
          for (const listener of documentListeners) listener({ status: 'loaded', snapshot: durableSnapshot });
          return { status: 'accepted', snapshot: durableSnapshot };
        },
        async replace(command) { return await this.transaction(command); },
        subscribe(documentId, listener) {
          assert.equal(documentId, 'room-registry');
          documentListeners.add(listener);
          return () => documentListeners.delete(listener);
        },
      },
      i18n: { define() {} },
      effect(callback) { callback(); },
      commands: { register(metadata, handler) {
        registrations.push('commands.register');
        commands.push({ metadata, handler });
      } },
      agentLoop: {
        async createOrBind(command) {
          loopCalls.push(command);
          return {
            $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
            commandId: command.commandId, type: 'create-or-bind', status: 'accepted',
            authorization: { capability: 'tasks.create', state: 'allowed', code: 'allowed' },
            binding: taskBinding,
            detailsUrl: { url: 'app:task/one', target: 'host' },
            delivery: { disposition: 'executed' },
          };
        },
        async requestMemberSelfIntroduction(command) {
          loopCalls.push(command);
          return {
            $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v4', schemaVersion: 4,
            commandId: command.commandId, type: command.type, status: 'accepted',
            authorization: { capability: 'turns.introduce', state: 'allowed', code: 'allowed' },
            binding: command.binding,
            participantId: command.participantId, memberId: command.memberId, runId: command.runId,
            turn: 'turn-introduction', messageId: 'message-introduction',
            causation: { operationId: command.commandId },
            delivery: { disposition: 'executed' },
          };
        },
        async subscribe(binding, afterSequence) {
          loopCalls.push({ type: 'subscribe', binding, afterSequence });
          const subscription = {
            $schema: 'subscription', contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
            subscriptionId: 'subscription-1', binding: binding.binding,
            afterSequence, snapshotSequence: 0,
          };
          return {
            status: 'accepted', authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
            handle: {
              subscription, unsubscribe() {},
              pages: { async *[Symbol.asyncIterator]() {
                yield {
                  $schema: 'page', contract: 'cordisx.agent-loop-event-page/v2', schemaVersion: 2,
                  subscription, afterSequence, phase: 'replay', nextAfterSequence: 0, hasMore: false,
                  events: [{
                    $schema: 'event', contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
                    eventId: 'assistant-event-1', binding: binding.binding, sequence: 0,
                    occurredAt: '2026-08-31T00:00:00.000Z',
                    causation: { operationId: loopCalls.find(call => call.type === 'send').commandId },
                    type: 'message', turn: 'turn-1', message: {
                      messageId: 'assistant-message-1', role: 'assistant',
                      purpose: 'conversation',
                      content: [{ kind: 'text', text: 'Agent reply' }],
                    },
                  }],
                };
              } },
            },
          };
        },
        async send(command) {
          loopCalls.push(command);
          return {
            $schema: 'agent-loop-result', contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2,
            commandId: command.commandId, type: 'send', status: 'accepted',
            authorization: { capability: 'turns.submit', state: 'allowed', code: 'allowed' },
            binding: taskBinding, messageId: 'Opaque:Message-1', turn: 'turn-1',
            delivery: { disposition: 'executed' },
          };
        },
        dispose() {},
      },
      agentConversationShell: {
        registerSource(factory) {
          factories.push(factory);
          return { mount: Symbol('host-owned-mount'), dispose() {} };
        },
      },
      pages: { register(metadata, mount) { pages.push({ metadata, mount }); } },
      routes: { register() {}, async navigate(reference) { navigations.push(reference); } },
      slots: { register() {}, registerCollection(options, source) { collections.push({ options, source }); return { dispose() {} }; } },
    });

    assert.equal(registrations[0], 'documents.load:room-registry');
    assert.deepEqual(commands.map(({ metadata }) => metadata.id), [
      'submit', 'approval.approve', 'approval.deny', 'approval.cancel',
    ]);
    assert.equal(factories.length, 1);
    assert.equal(pages.length, 1);
    assert.equal(collections.length, 1);
    assert.deepEqual(collections[0].options, {
      name: 'sidebar.navigation.items', id: 'rooms',
      group: { id: 'rooms', label: { namespace: 'chatroom', key: 'navigation.rooms', fallback: 'Rooms' }, order: 20 },
    });
    assert.deepEqual(collections[0].source.snapshot(), { revision: 0, items: [] });
    const shell = factories[0](Object.freeze({
      bindingId: 'binding-local-ids', shell: 'agent-desktop', ownerGeneration: 'owner-local-ids',
      routeSelection: { scope: 'room-or-new' },
    }));
    const snapshot = await shell.snapshot();
    assert.deepEqual(snapshot.headerActions, []);
    assert.equal(snapshot.composer.availability, 'available');
    assert.equal(snapshot.composer.disabled.value, false);
    assert.equal(snapshot.composer.submit.id, commands[0].metadata.id);
    await commands[0].handler({ hostContext: {
      binding: { bindingId: 'binding-local-ids', ownerGeneration: 'owner-local-ids' },
      generation: 'owner-local-ids', scope: 'composer-submit', command: { id: 'submit' }, submitPayload: 'First message',
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigations, [{ id: 'room', params: { roomId: 'room-1' } }]);
    const roomSnapshot = await shell.snapshot();
    assert.equal(roomSnapshot.selection.kind, 'room');
    assert.equal(roomSnapshot.selection.roomId, 'room-1');
    assert.deepEqual(roomSnapshot.selection.participants.find(participant => participant.participantId === 'leader')?.avatar, {
      kind: 'asset', ref: 'oneworks-avatar:asset.red-fox.v1',
      revision: 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
    });
    assert.deepEqual(roomSnapshot.selection.participants
      .filter(participant => participant.role === 'agent')
      .map(participant => [participant.participantId, participant.avatar?.ref]), [
      ['leader', 'oneworks-avatar:asset.red-fox.v1'],
      ['reviewer', 'oneworks-avatar:asset.arctic-fox.v1'],
      ['integrator', 'oneworks-avatar:asset.d85c0abccffd4d539da85cb67eb8bcbf.v1'],
      ['documentation', 'oneworks-avatar:asset.5089b05857414a4c9f2bf1c0c5079edc.v1'],
      ['qa', 'oneworks-avatar:asset.7ca113246df74241ab1bdedc04f6fde9.v1'],
    ]);
    assert.equal(roomSnapshot.items.length, 2);
    assert.equal(roomSnapshot.items.some(item => item.kind === 'member-presence'), false);
    assert.equal(roomSnapshot.items.some(item => item.kind === 'message'
      && item.source === 'chatroom-acknowledgement' && item.author.role === 'agent'), false);
    const userMessage = roomSnapshot.items.find(item => item.kind === 'message'
      && item.author.role === 'human');
    if (userMessage.kind === 'message') {
      assert.equal(userMessage.source, 'agent-loop');
      assert.equal(userMessage.author.role, 'human');
      assert.equal(userMessage.body[0].text.fallback, 'First message');
      assert.equal(userMessage.deliveryState, 'sent');
      assert.equal(userMessage.runState, 'running');
      assert.deepEqual(userMessage.reactions.map(reaction => ({
        actorParticipantId: reaction.actorParticipantId,
        value: reaction.value,
        state: reaction.state,
      })), [{ actorParticipantId: 'leader', value: { kind: 'emoji', emoji: '👀' }, state: 'pending' }]);
      assert.deepEqual(
        roomSnapshot.selection.participants.find(participant =>
          participant.participantId === userMessage.reactions[0].actorParticipantId)?.avatar,
        roomSnapshot.selection.participants.find(participant => participant.participantId === 'leader')?.avatar,
      );
    }
    const assistant = roomSnapshot.items.find(item => item.kind === 'message'
      && item.author.role === 'agent' && item.source === 'agent-loop');
    assert.equal(assistant.source, 'agent-loop');
    assert.equal(assistant.body[0].text.fallback, 'Agent reply');
    assert.deepEqual(roomSnapshot.selection.activeRuns, [{
      participantId: 'leader', memberId: 'leader', runId: 'run-1',
      lifecycle: { phase: 'running' }, detailsUrl: { url: 'app:task/one', target: 'host' },
    }]);
    assert.deepEqual(loopCalls.map(call => call.type), [
      'create-or-bind', 'request-member-self-introduction', 'send', 'subscribe',
    ]);
    assert.equal(loopCalls[0].definitions[0].identity.agentId, 'chatroom.generalist');
    assert.equal(loopCalls[3].afterSequence, -1);
    const persistedDeliveries = durableSnapshot.value.rooms[0].deliveries;
    assert.equal(persistedDeliveries.length, 2);
    assert.equal(persistedDeliveries.every(delivery =>
      /^sha256\.[0-9a-f]{64}$/.test(delivery.canonicalPayload)), true);
    assert.doesNotMatch(JSON.stringify(persistedDeliveries),
      /promptSections|You coordinate the Room|You review plans|"content"|credentials|"trace"|"cli"/i);
    assert.doesNotMatch(JSON.stringify(durableSnapshot.value),
      /promptSections|personality|memory-policy|You coordinate the Room|You review plans|credentials|accessToken|refreshToken|"trace"|"cli"/i,
      'owner document contains only public Room timeline and privacy-safe operation correlation');
    assert.deepEqual(persistedDeliveries[0].operation.payload.definitions, [{
      agentId: 'chatroom.generalist', revision: 'chatroom-internal-v1',
    }]);
    assert.deepEqual(collections[0].source.snapshot(), {
      revision: collections[0].source.snapshot().revision,
      items: [{
        id: 'room-1', label: { namespace: 'chatroom', key: 'navigation.room.title', fallback: 'New room' },
        leadingVisual: {
          kind: 'room-composite-avatar',
          participants: [
            { participantId: 'user' },
            {
              participantId: 'leader',
              avatar: {
                kind: 'asset', ref: 'oneworks-avatar:asset.red-fox.v1',
                revision: 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
              },
            },
            {
              participantId: 'reviewer',
              avatar: {
                kind: 'asset', ref: 'oneworks-avatar:asset.arctic-fox.v1',
                revision: 'oneworks-avatar:editor-arctic-fox-2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011',
              },
            },
            {
              participantId: 'integrator',
              avatar: {
                kind: 'asset', ref: 'oneworks-avatar:asset.d85c0abccffd4d539da85cb67eb8bcbf.v1',
                revision: 'oneworks-avatar:editor-syrian-hamster-5eebb3ea9c0131005fd336e7c8494c74fce92903373272632da940f22307c1f7',
              },
            },
            {
              participantId: 'documentation',
              avatar: {
                kind: 'asset', ref: 'oneworks-avatar:asset.5089b05857414a4c9f2bf1c0c5079edc.v1',
                revision: 'oneworks-avatar:editor-asian-small-clawed-otter-4ceef0184bd3d2fd6a469b20decf1d0dd3cd726bbeaf3d07c43389ba5b2bab6f',
              },
            },
            {
              participantId: 'qa',
              avatar: {
                kind: 'asset', ref: 'oneworks-avatar:asset.7ca113246df74241ab1bdedc04f6fde9.v1',
                revision: 'oneworks-avatar:editor-yellow-duckling-a8d6820ff62d33d931b2554f6080126c2685ad84eed34a559ef7407374b447c6',
              },
            },
          ],
        },
        route: { id: 'room', params: { roomId: 'room-1' } }, order: 0,
      }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('projects complete Room snapshots latest-first with monotonic revisions', async () => {
  const { directory, navigation, room } = await importSourceEntry();
  try {
    const registry = new room.ChatroomRoomRegistry([
      room.createRoom({ id: 'older', title: 'Older' }),
    ]);
    const collection = new navigation.ChatroomRoomNavigationCollection(registry);
    assert.deepEqual(collection.snapshot(), {
      revision: 0,
      items: [{
        id: 'room-1', label: { namespace: 'chatroom', key: 'navigation.room.title', fallback: 'Older' },
        leadingVisual: emptyRoomLeadingVisual,
        route: { id: 'room', params: { roomId: 'older' } }, order: 0,
      }],
    });
    let notifications = 0;
    const unsubscribe = collection.subscribe(() => { notifications += 1; });
    registry.upsert(room.createRoom({ id: 'newer', title: 'Newer' }));
    assert.equal(notifications, 1);
    assert.deepEqual(collection.snapshot(), {
      revision: 1,
      items: [
        { id: 'room-2', label: { namespace: 'chatroom', key: 'navigation.room.title', fallback: 'Newer' }, leadingVisual: emptyRoomLeadingVisual, route: { id: 'room', params: { roomId: 'newer' } }, order: 0 },
        { id: 'room-1', label: { namespace: 'chatroom', key: 'navigation.room.title', fallback: 'Older' }, leadingVisual: emptyRoomLeadingVisual, route: { id: 'room', params: { roomId: 'older' } }, order: 1 },
      ],
    });
    registry.upsert(room.createRoom({ id: 'older', title: 'Renamed' }));
    assert.equal(collection.snapshot().revision, 2);
    assert.equal(collection.snapshot().items[0].label.fallback, 'Renamed');
    registry.remove('older');
    assert.deepEqual(collection.snapshot(), {
      revision: 3,
      items: [{ id: 'room-2', label: { namespace: 'chatroom', key: 'navigation.room.title', fallback: 'Newer' }, leadingVisual: emptyRoomLeadingVisual, route: { id: 'room', params: { roomId: 'newer' } }, order: 0 }],
    });
    for (let index = 0; index < 501; index += 1) {
      registry.upsert(room.createRoom({ id: `extra-${index}`, title: `Extra ${index}` }));
    }
    assert.equal(collection.snapshot().items.length, 500);
    assert.equal(collection.snapshot().items[0].route.params.roomId, 'extra-500');
    registry.upsert(room.createRoom({ id: 'Opaque.Room-123', title: 'Opaque title' }));
    const opaque = collection.snapshot().items[0];
    assert.match(opaque.id, /^room-[0-9]+$/);
    assert.notEqual(opaque.id, 'Opaque.Room-123');
    assert.equal(opaque.label.key, 'navigation.room.title');
    assert.equal(opaque.label.key.includes('Opaque.Room-123'), false);
    assert.equal(opaque.route.params.roomId, 'Opaque.Room-123');
    unsubscribe();
    collection.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
