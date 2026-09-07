import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { OwnerDocumentStore } from '../node_modules/cordisx/packages/cli/dist/src/launcher/owner-document-store.js';
import { createOwnerDocumentBridgeHandler } from '../node_modules/cordisx/packages/cli/dist/src/launcher/owner-document-rpc.js';
import {
  BrowserOwnerDocumentBridge,
  CordisXOwnerDocumentBroker,
} from '../node_modules/cordisx/packages/cli/dist/src/renderer/owner-documents.js';
import {
  dispatchAgentTool,
  getAgentToolSetup,
  installAgentTools,
} from '../node_modules/cordisx/packages/cli/dist/src/renderer/plugin-agent-tools.js';
import { DurableChatroomRoomStore } from '../dist/room-store.js';
import { addRoomRun, bindRoomRunSession, createRoom } from '../dist/room.js';
import { ChatroomCliBindings } from '../dist/room-cli-bindings.js';
import { projectAgentConversationShellSnapshotV7 } from '../node_modules/cordisx/packages/cli/dist/src/renderer/agent-conversation-shell-projection.js';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';

// Uses the installed exact Host candidate's test boundary. Only the CDP wire and
// Agent ownership source are controlled; CLI, socket/auth, resource deployment,
// browser service, Room handler and Host-owned file persistence are real.
// This scoped test does not certify native Desktop or Shell rendering.
test('real CLI process commits one authenticated Room report through Host documents and replays exactly once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chatroom-real-cli-'));
  const entry = fileURLToPath(new URL('../dist/runtime/chatroom.js', import.meta.url));
  const source = pathToFileURL(entry).href;
  let active = true;
  const authority = createOwnerDocumentBridgeHandler({
    secret: randomBytes(32).toString('hex'),
    profileId: 'isolated-cli-test',
    generation: 'launcher-test',
    store: new OwnerDocumentStore(home),
    principalAllowed: principal =>
      active && principal.identity.pluginId === 'chatroom' && principal.identity.source === source,
    plugins: [{ id: 'chatroom', entry, enabled: true }],
  });
  const principal = authority.issue({ pluginId: 'chatroom', source }, 'module-test');
  const bridge = new BrowserOwnerDocumentBridge();
  globalThis.__cordisxOwnerDocumentRequestV1 = payload => {
    const request = JSON.parse(payload);
    const operation = request.operation.startsWith('agent-tools-')
      ? authority.agentTools.handle(request, dispatchAgentTool)
      : request.operation === 'load'
      ? authority.load(request)
      : authority.replace(request);
    void operation.then(
      value =>
        globalThis.__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value })),
      () =>
        globalThis.__cordisxOwnerDocumentReceiveV1?.(
          JSON.stringify({ requestId: request.requestId, ok: false, error: 'Host rejected request' }),
        ),
    );
  };
  const broker = new CordisXOwnerDocumentBroker(bridge, [principal]);
  const documents = broker.bind({
    identity: { id: 'chatroom', source },
    moduleGeneration: 'module-test',
    active: () => active,
  });
  const service = installAgentTools(new Context(), {
    bridge,
    principal,
    active: () => active,
    ownsSession: sessionId => sessionId === 'session-simulated-agent',
  });
  let store;
  let bindings;
  let shell;
  let sessionController;
  let domain;
  try {
    store = await DurableChatroomRoomStore.openOwnerDocuments(documents);
    let room = createRoom({ id: 'room-real-cli', title: 'Real CLI integration' });
    room = createRoom({
      ...room,
      participants: [
        { id: 'human', kind: 'human', name: 'You' },
        ...room.memberships.map(member => ({ id: member.participantId, kind: 'agent', name: member.label })),
      ],
    });
    const member = room.memberships[0];
    room = addRoomRun(room, { runId: 'run-real-cli', memberId: member.memberId, status: 'creating' });
    room = bindRoomRunSession(room, 'run-real-cli', 'session-simulated-agent');
    await store.upsert(room);
    const simulated = h.runtimeHarness({ room });
    sessionController = new h.ChatroomAgentSessionController(
      {
        agents: simulated.agents,
        sessions: simulated.sessionRegistry,
        approvals: simulated.approvals,
      },
      h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const shellBinding = {
      bindingId: 'shell-real-cli',
      shell: 'agent-desktop',
      ownerGeneration: 'shell-generation',
      routeSelection: { scope: 'room-or-new', selectedRoomParam: room.id },
    };
    domain = new h.ChatroomConversationController(store.rooms);
    shell = new h.ChatroomAgentSessionConversationSourceV11(
      shellBinding,
      domain.createSource(shellBinding),
      sessionController,
      'enter',
    );
    await shell.snapshot();
    bindings = new ChatroomCliBindings(service, store, { get: () => ({ cliReporting: true }), watch: () => () => {} });
    await bindings.ensureBound(room, room.runs[0]);
    const setup = await getAgentToolSetup('session-simulated-agent');
    assert.match(setup.skills[0].content, /Actively report/);
    const command = setup.commands[0];
    const argv = [...command.argv.slice(1), 'send', '--operation', 'report-1', '--text', 'Accepted the assigned work.'];
    let notifications = 0;
    const unsubscribe = store.rooms.subscribe(() => {
      notifications += 1;
    });
    const first = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout);
    const replay = JSON.parse((await promisify(execFile)(command.argv[0], argv)).stdout);
    assert.equal(first.status, 'accepted');
    assert.equal(first.disposition, 'created');
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.messageId, first.messageId);
    assert.equal(notifications, 1);
    const stored = await documents.load('room-registry');
    assert.equal(stored.status, 'loaded');
    const reports = stored.snapshot.value.rooms[0].cliMessages;
    assert.equal(reports.length, 1);
    assert.equal(reports[0].participantId, member.participantId);
    assert.equal(reports[0].memberId, member.memberId);
    assert.equal(reports[0].messageId, first.messageId);
    await new Promise(resolve => setImmediate(resolve));
    const shellSnapshot = await shell.snapshot();
    const visible = shellSnapshot.items.filter(item => item.kind === 'message' && item.messageId === first.messageId);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].source.kind, 'plugin-command');
    assert.equal(visible[0].source.sequence, reports[0].sequence);
    assert.equal(visible[0].author.participantId, member.participantId);
    assert.equal(visible[0].body[0].text.fallback, 'Accepted the assigned work.');
    const hostModel = projectAgentConversationShellSnapshotV7(
      'chatroom',
      shellSnapshot,
      {
        resolve: value => value.fallback ?? value.key,
      },
      true,
      true,
    );
    const hostMessage = hostModel.entries.find(item => item.kind === 'message' && item.messageId === first.messageId);
    assert.equal(hostMessage.authorId, member.participantId);
    assert.deepEqual(hostMessage.body, ['Accepted the assigned work.']);
    await assert.rejects(promisify(execFile)(command.argv[0], [...argv, '--room', 'unauthorized-room']), error => {
      assert.equal(JSON.parse(error.stdout).code, 'unauthorized');
      return true;
    });
    await assert.rejects(promisify(execFile)(command.argv[0], [...argv.slice(0, -1), 'Changed content']), error => {
      assert.equal(JSON.parse(error.stdout).code, 'operation-conflict');
      return true;
    });
    assert.equal(store.rooms.get(room.id).cliMessages.length, 1);
    unsubscribe();
    await bindings.revoke('session-simulated-agent');
    await assert.rejects(promisify(execFile)(command.argv[0], argv));
  } finally {
    shell?.dispose();
    await sessionController?.dispose();
    domain?.dispose();
    await bindings?.dispose();
    service.dispose();
    store?.dispose();
    broker.dispose();
    await authority.agentTools.close();
    active = false;
    delete globalThis.__cordisxOwnerDocumentRequestV1;
    await rm(home, { recursive: true, force: true });
  }
});
