import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionControllerHarness as h } from './agent-session-controller/harness.mjs';
import { ChatroomTaskHandler } from '../dist/room-task-handler.js';
import { projectChatroomApprovalBubble } from '../dist/approval-bubble.js';

async function fixture() {
  const room = h.createRoom({ id: 'task-approvals', title: 'Task approvals' });
  const store = h.DurableChatroomRoomStore.memory([room]);
  const runtime = h.runtimeHarness({ room });
  const controller = new h.ChatroomAgentSessionController(
    {
      agents: runtime.agents,
      sessions: runtime.sessionRegistry,
      approvals: runtime.approvals,
      collaboration: {
        enabled: () => true,
        ensureBound: async () => {
          throw new Error('must retain Host prebinding');
        },
        revoke: async () => {},
      },
    },
    h.CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    store,
  );
  const requests = [];
  const handler = new ChatroomTaskHandler(store, {
    async createAndSubmit(request) {
      const acquired = await runtime.agents.create({ definition: request.definition });
      requests.push(request);
      return {
        status: 'accepted',
        operationId: request.operationId,
        disposition: 'created',
        task: {
          sessionId: acquired.sessionId,
          messageId: `first-${requests.length}`,
          context: { cwd: '/project' },
          detail: { kind: 'host', ref: `detail-${requests.length}` },
        },
      };
    },
  });
  const start = await handler.start({
    action: 'start',
    operationId: 'root',
    roomId: room.id,
    to: 'leader',
    text: 'Lead',
    cwd: '/project',
  });
  return { room, store, runtime, controller, requests, handler, start };
}
const binding = request => ({ operationId: request.operationId, toolScope: request.tool.scope });
const identity = (request, agent) => ({
  agentId: agent.id,
  sessionId: agent.session.id,
  agentGeneration: agent.generation,
  definition: request.definition,
});
const routingQuestion = requester => ({
  routingId: 'routing-1',
  registration: { requester },
  requester,
  toolName: 'shell',
  callId: 'call-1',
  reason: { kind: 'plain-text', text: 'Run actual CLI command.' },
});

for (const outcome of ['allowed-once', 'rejected']) {
  test(`root task routes to its own Session but waits for a real human ${outcome} decision`, async () => {
    const f = await fixture();
    const request = f.requests[0];
    const agent = f.runtime.handles[0].handle.agent;
    const requester = identity(request, agent);
    const routed = await f.controller.resolveTaskApproval(
      routingQuestion(requester),
      binding(request),
      new AbortController().signal,
    );
    assert.equal(routed.status, 'accepted');
    assert.deepEqual(routed.authority, requester);
    const question = {
      id: 'approval-root',
      requester,
      authority: requester,
      toolName: 'shell',
      callId: 'call-1',
      reason: { kind: 'plain-text', text: 'Run actual CLI command.' },
    };
    const events = [
      h.sessionEvent(agent.id, 0, 'approval/authority-bound', {
        approvalId: question.id,
        requester: request.definition,
        authority: request.definition,
        reason: question.reason,
      }),
      h.sessionEvent(agent.id, 1, 'approval/asked', {
        id: question.id,
        toolName: question.toolName,
        callId: question.callId,
        reason: question.reason.text,
      }),
    ];
    await agent.session.emitLive(events);
    let settled = false;
    const decision = f.controller.answerTaskAuthority(question, binding(request), new AbortController().signal).then(
      value => {
        settled = true;
        return value;
      },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the model does not approve its own execution');
    const projection = projectChatroomApprovalBubble({
      room: f.store.rooms.get(f.room.id),
      sessionId: agent.id,
      approvalId: question.id,
      events,
      liveQuestion: question,
      sequence: 3,
    });
    assert.equal(projection.status, 'projected');
    assert.equal(projection.item.state, 'pending');
    assert.equal(f.controller.answerApprovalItem(f.room.id, projection.item.itemId, outcome), true);
    assert.equal(await decision, outcome);
    await f.controller.dispose();
    f.store.dispose();
  });
}

test('child routes to its exact source Leader and post-acceptance ownership never resumes or creates again', async () => {
  const f = await fixture();
  const rootRequest = f.requests[0];
  const rootHandle = f.runtime.handles[0].handle;
  const source = { ...rootRequest.tool.scope, sessionId: rootHandle.agent.id };
  const child = await f.handler.handle(source, {
    action: 'delegate',
    operationId: 'child',
    to: 'reviewer',
    text: 'Review',
  });
  const request = f.requests[1];
  const childHandle = f.runtime.handles[1].handle;
  const requester = identity(request, childHandle.agent);
  const routed = await f.controller.resolveTaskApproval(
    routingQuestion(requester),
    binding(request),
    new AbortController().signal,
  );
  assert.equal(routed.status, 'accepted');
  assert.equal(routed.authority.sessionId, rootHandle.agent.id);
  f.controller.setTaskOwnership({
    async acquire(input) {
      assert.equal(input.operationId, request.operationId);
      return { status: 'acquired', handle: childHandle };
    },
  });
  const acquired = await f.controller.ensureOwner(f.room.id, child.runId);
  assert.equal(acquired.handle, childHandle);
  assert.equal(f.runtime.resumes.length, 0);
  assert.equal(f.runtime.creates.length, 2);
  assert.equal(f.runtime.approvals.requestResolvers.size, 0, 'Host-owned task registrations are not installed twice');
  await f.controller.dispose();
  f.store.dispose();
});

test('revoked approval callback fails closed and cannot attach a different task Session', async () => {
  const f = await fixture();
  const request = f.requests[0];
  const agent = f.runtime.handles[0].handle.agent;
  const requester = identity(request, agent);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.controller.resolveTaskApproval(routingQuestion(requester), binding(request), aborted.signal),
    /revoked/,
  );
  await assert.rejects(
    f.controller.resolveTaskApproval(
      routingQuestion({ ...requester, sessionId: 'forged' }),
      binding(request),
      new AbortController().signal,
    ),
    /match/,
  );
  await f.controller.dispose();
  f.store.dispose();
});

test('revoking one pending task approval settles unavailable without deciding another request', async () => {
  const f = await fixture();
  const request = f.requests[0];
  const agent = f.runtime.handles[0].handle.agent;
  const requester = identity(request, agent);
  const question = id => ({
    id,
    requester,
    authority: requester,
    toolName: 'shell',
    callId: id,
    reason: { kind: 'unavailable' },
  });
  const revoked = new AbortController();
  const first = f.controller.answerTaskAuthority(question('first'), binding(request), revoked.signal);
  const live = new AbortController();
  let secondSettled = false;
  const second = f.controller.answerTaskAuthority(question('second'), binding(request), live.signal).then(value => {
    secondSettled = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  revoked.abort();
  assert.equal(await first, 'unavailable');
  assert.equal(secondSettled, false);
  live.abort();
  assert.equal(await second, 'unavailable');
  assert.equal(f.controller.pendingAuthorityApprovals.size, 0);
  await f.controller.dispose();
  f.store.dispose();
});
