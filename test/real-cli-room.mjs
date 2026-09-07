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
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';

// Uses the installed exact Host candidate's test boundary. Only the CDP wire and
// Agent ownership source are controlled; CLI, socket/auth, resource deployment,
// browser service, Room handler and Host-owned file persistence are real.
// This scoped test does not certify native Desktop rendering.
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
    ownsSession: sessionId => ['session-simulated-agent', 'session-simulated-child'].includes(sessionId),
  });
  let store;
  let bindings;
  let page;
  let sessionController;
  let domain;
  let childToolBinding;
  let taskRequest;
  let taskCreates = 0;
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
    domain = new h.ChatroomConversationController(store.rooms);
    page = await h.mountChatroomPageSource(domain, sessionController, room.id);
    const taskResult = request => ({
      status: 'accepted',
      operationId: request.operationId,
      disposition: 'created',
      task: {
        sessionId: 'session-simulated-child',
        messageId: 'child-first-input',
        context: { cwd: '/controlled-test-context' },
        detail: { kind: 'host', ref: 'controlled-detail' },
      },
    });
    bindings = new ChatroomCliBindings(service, store, { get: () => ({ cliReporting: true }), watch: () => () => {} }, {
      async createAndSubmit(request) {
        taskCreates += 1;
        taskRequest = request;
        assert.equal(store.rooms.get(room.id).runs.filter(run => run.delegation).length, 1);
        childToolBinding = await service.bind({
          commandId: request.tool.commandId,
          sessionId: 'session-simulated-child',
          scope: request.tool.scope,
        });
        const childCommand = (await getAgentToolSetup('session-simulated-child')).commands[0];
        const childArgs = [
          ...childCommand.argv.slice(1),
          'send',
          '--operation',
          'child-early',
          '--text',
          'Child result via real CLI.',
        ];
        const report = JSON.parse((await promisify(execFile)(childCommand.argv[0], childArgs)).stdout);
        assert.equal(report.status, 'accepted');
        assert.equal(
          (JSON.parse((await promisify(execFile)(childCommand.argv[0], childArgs)).stdout)).disposition,
          'replayed',
        );
        return taskResult(request);
      },
      async query(request) {
        assert.equal(request.operationId, taskRequest.operationId);
        return {
          status: 'found',
          result: taskResult(taskRequest),
          execution: { status: 'unavailable', code: 'host-unavailable' },
        };
      },
    });
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
    const pageSnapshot = page.getSnapshot(room.id);
    const visible = pageSnapshot.items.filter(item => item.kind === 'message' && item.messageId === first.messageId);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].source, 'chatroom-cli');
    assert.equal(visible[0].sequence, reports[0].sequence);
    assert.equal(visible[0].author.participantId, member.participantId);
    assert.equal(visible[0].body[0].text.fallback, 'Accepted the assigned work.');
    assert.equal(visible[0].author.role, 'agent');
    assert.equal(visible[0].author.displayName.fallback, member.label);
    assert.equal(visible[0].semantic.causation.operationId, reports[0].operationId);
    assert.ok(pageSnapshot.participants.some(participant => participant.participantId === member.participantId));
    assert.deepEqual(visible[0].body.map(block => block.text.fallback), ['Accepted the assigned work.']);
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
    const delegateArgs = [
      ...command.argv.slice(1),
      'delegate',
      '--operation',
      'delegate-real-cli',
      '--to',
      'reviewer',
      '--text',
      'Review using the child CLI.',
      '--cwd',
      '/controlled-test-context',
    ];
    const delegated = JSON.parse((await promisify(execFile)(command.argv[0], delegateArgs)).stdout);
    assert.equal(delegated.status, 'accepted');
    assert.equal(delegated.task.sessionId, 'session-simulated-child');
    assert.equal(taskCreates, 1);
    const queried = JSON.parse(
      (await promisify(execFile)(command.argv[0], [
        ...command.argv.slice(1),
        'query',
        '--operation',
        'delegate-real-cli',
      ])).stdout,
    );
    assert.equal(queried.status, 'found');
    assert.equal(queried.execution.status, 'unavailable');
    assert.equal(queried.reports.length, 1);
    assert.equal(queried.reports[0].text, 'Child result via real CLI.');
    assert.equal(queried.reports[0].runId, delegated.runId);
    assert.equal(store.rooms.get(room.id).runs.length, 2);
    await assert.rejects(
      promisify(execFile)(command.argv[0], [...delegateArgs.slice(0, -1), '/changed-context']),
      error => {
        assert.equal(JSON.parse(error.stdout).code, 'operation-conflict');
        return true;
      },
    );
    assert.equal(taskCreates, 1);
    await bindings.revoke('session-simulated-agent');
    await assert.rejects(promisify(execFile)(command.argv[0], argv));
    page.dispose();
    page = undefined;
    await sessionController.dispose();
    sessionController = undefined;
    domain.dispose();
    domain = undefined;
    await bindings.dispose();
    bindings = undefined;
    await childToolBinding.revoke();
    childToolBinding = undefined;
    store.dispose();
    store = undefined;
    await assertColdPageReports(documents, room.id, first.messageId, queried.reports[0].messageId);
  } finally {
    page?.dispose();
    await sessionController?.dispose();
    domain?.dispose();
    await childToolBinding?.revoke();
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

// Reconstruct plugin state from the Host document service with fresh Session
// observers. CLI reports must not depend on the old live page or Agent handles.
async function assertColdPageReports(documents, roomId, parentMessageId, childMessageId) {
  const before = await documents.load('room-registry');
  assert.equal(before.status, 'loaded');
  const persistedRoom = before.snapshot.value.rooms.find(room => room.id === roomId);
  const expected = persistedRoom.cliMessages;
  assert.equal(expected.length, 2);
  assert.deepEqual(new Set(expected.map(message => message.messageId)), new Set([parentMessageId, childMessageId]));
  const coldStore = await DurableChatroomRoomStore.openOwnerDocuments(documents);
  const coldDomain = new h.ChatroomConversationController(coldStore.rooms);
  const runtime = h.runtimeHarness({ room: coldStore.rooms.get(roomId) });
  const coldController = new h.ChatroomAgentSessionController(
    { agents: runtime.agents, sessions: runtime.sessionRegistry, approvals: runtime.approvals },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    coldStore,
  );
  let coldPage;
  try {
    coldPage = await h.mountChatroomPageSource(coldDomain, coldController, roomId);
    const visible = coldPage.getSnapshot(roomId).items.filter(item =>
      item.kind === 'message' && item.source === 'chatroom-cli'
    );
    assert.equal(visible.length, 2);
    for (const message of expected) {
      const matches = visible.filter(item => item.messageId === message.messageId);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].author.participantId, message.participantId);
      assert.equal(matches[0].body[0].text.fallback, message.text);
      assert.equal(matches[0].sequence, message.sequence);
      assert.equal(matches[0].semantic.causation.operationId, message.operationId);
    }
    assert.deepEqual(coldStore.rooms.get(roomId).runs, persistedRoom.runs);
    assert.equal(runtime.creates.length, 0);
    assert.equal(runtime.resumes.length, 0);
    assert.equal(coldController.ownerHandleCount, 0);
    const after = await documents.load('room-registry');
    assert.deepEqual(after, before, 'cold page hydration must not rewrite the persisted Room or CLI reports');
  } finally {
    coldPage?.dispose();
    await coldController.dispose();
    coldDomain.dispose();
    coldStore.dispose();
  }
}
