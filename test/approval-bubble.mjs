import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatroomApprovalBubbleItemId,
  prepareChatroomApprovalRequest,
  projectChatroomApprovalBubble,
  requestChatroomApproval,
  routeChatroomDriverApproval,
} from '../dist/approval-bubble.js';
import {
  addRoomRun,
  bindRoomRunSession,
  createRoom,
} from '../dist/room.js';

const sessionEvent = (sessionId, seq, type, data) => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
  contract: 'cordisx.session-event/v1', schemaVersion: 1,
  sessionId, seq, time: 1_000 + seq, type, data,
  ...(type === 'approval/authority-bound' ? { ignorable: true } : {}),
});

const fakeAgent = (sessionId, generation = 1) => ({
  id: sessionId,
  generation,
  options: {},
  session: { id: sessionId, generation: 1 },
  inbox: { nextTurn: [], nextStep: [] },
  status: { status: 'available', value: 'idle' },
});

function approvalRoom() {
  let room = createRoom({ id: 'approval-room', title: 'Approval Room' });
  room = addRoomRun(room, {
    runId: 'reviewer-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating',
  });
  room = bindRoomRunSession(room, 'reviewer-run', 'session-reviewer');
  room = addRoomRun(room, {
    runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating',
  });
  return bindRoomRunSession(room, 'lead-run', 'session-lead');
}

const identities = room => ({
  reviewer: room.memberships.find(member => member.memberId === 'reviewer').definition,
  lead: room.memberships.find(member => member.memberId === 'leader').definition,
});

const liveQuestion = room => {
  const identity = identities(room);
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v2.schema.json',
    contract: 'cordisx.approval-question/v2', schemaVersion: 2,
    id: 'approval-review',
    requester: {
      agentId: 'session-reviewer', sessionId: 'session-reviewer', agentGeneration: 7,
      definition: identity.reviewer,
    },
    authority: {
      agentId: 'session-lead', sessionId: 'session-lead', agentGeneration: 11,
      definition: identity.lead,
    },
    toolName: 'shell',
    callId: 'call-review',
    reason: { kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.' },
  };
};

const authorityEvents = room => {
  const identity = identities(room);
  return [
    sessionEvent('session-reviewer', 21, 'approval/authority-bound', {
      approvalId: 'approval-review',
      requester: identity.reviewer,
      authority: identity.lead,
      reason: { kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.' },
    }),
    sessionEvent('session-reviewer', 22, 'approval/asked', {
      id: 'approval-review', toolName: 'shell', callId: 'call-review',
      reason: 'Reviewer needs permission to inspect the exact diff.',
    }),
  ];
};

const routingQuestion = room => {
  const requester = liveQuestion(room).requester;
  const registration = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-registration.v1.schema.json',
    contract: 'cordisx.approval-request-routing-registration/v1', schemaVersion: 1,
    registrationId: 'routing-registration-reviewer',
    owner: { pluginId: 'chatroom', installationId: 'chatroom-installation', profileId: 'profile-one', pluginGeneration: 'generation-one' },
    requester,
  };
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-request-routing-question.v1.schema.json',
    contract: 'cordisx.approval-request-routing-question/v1', schemaVersion: 1,
    routingId: 'routing-reviewer-one', registration, requester,
    toolName: 'shell', callId: 'call-review',
    reason: { kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.' },
  };
};

test('prepares an approval/v2 request from exact Reviewer and reportsTo Lead live bindings', () => {
  const room = approvalRoom();
  const reviewer = fakeAgent('session-reviewer', 7);
  const lead = fakeAgent('session-lead', 11);
  const result = prepareChatroomApprovalRequest({
    room,
    requesterRunId: 'reviewer-run',
    requesterAgent: reviewer,
    liveAgentForRun: runId => runId === 'lead-run' ? lead : undefined,
    toolName: 'shell',
    callId: 'call-review',
    reason: 'Reviewer needs permission to inspect the exact diff.',
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.request.requester.agent, reviewer);
  assert.equal(result.request.authority.agent, lead);
  assert.deepEqual(result.request.requester.definition, identities(room).reviewer);
  assert.deepEqual(result.request.authority.definition, identities(room).lead);
  assert.deepEqual(result.request.reason, {
    kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.',
  });
  assert.equal(result.authority.member.memberId, 'leader');
  assert.equal(result.authority.run.runId, 'lead-run');
});

test('calls approval/v2 once with exact targets and fences the returned requester/authority bindings', async () => {
  const room = approvalRoom();
  const reviewer = fakeAgent('session-reviewer', 7);
  const lead = fakeAgent('session-lead', 11);
  const requests = [];
  const approvals = {
    request: async request => {
      requests.push(request);
      return {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v2.schema.json',
        contract: 'cordisx.approval-decision/v2', schemaVersion: 2,
        id: 'approval-review',
        requester: {
          agentId: reviewer.id, sessionId: reviewer.session.id,
          agentGeneration: reviewer.generation, definition: request.requester.definition,
        },
        authority: {
          agentId: lead.id, sessionId: lead.session.id,
          agentGeneration: lead.generation, definition: request.authority.definition,
        },
        outcome: 'allowed-once',
      };
    },
  };
  const input = {
    room,
    requesterRunId: 'reviewer-run',
    requesterAgent: reviewer,
    liveAgentForRun: runId => runId === 'lead-run' ? lead : undefined,
    toolName: 'shell',
    reason: 'Reviewer-authored exact reason',
  };
  const result = await requestChatroomApproval(approvals, input);

  assert.equal(result.status, 'decided');
  assert.equal(result.decision.outcome, 'allowed-once');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requester.agent, reviewer);
  assert.equal(requests[0].authority.agent, lead);

  const mismatched = await requestChatroomApproval({
    request: async request => ({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v2.schema.json',
      contract: 'cordisx.approval-decision/v2', schemaVersion: 2,
      id: 'approval-review',
      requester: {
        agentId: reviewer.id, sessionId: reviewer.session.id,
        agentGeneration: reviewer.generation, definition: request.requester.definition,
      },
      authority: {
        agentId: 'foreign-session', sessionId: 'foreign-session',
        agentGeneration: lead.generation, definition: request.authority.definition,
      },
      outcome: 'rejected',
    }),
  }, input);
  assert.deepEqual(mismatched, {
    status: 'unavailable', code: 'decision-correlation-invalid',
  });
});

test('routes a pre-persistence driver approval from exact Reviewer registration to exact live Lead', () => {
  const room = approvalRoom();
  const reviewer = fakeAgent('session-reviewer', 7);
  const lead = fakeAgent('session-lead', 11);
  const question = routingQuestion(room);
  const result = routeChatroomDriverApproval({
    room,
    question,
    liveAgentForRun: runId => runId === 'reviewer-run' ? reviewer : runId === 'lead-run' ? lead : undefined,
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.routingId, question.routingId);
  assert.equal(result.registration, question.registration);
  assert.deepEqual(result.requester, question.requester);
  assert.deepEqual(result.authority, {
    agentId: 'session-lead', sessionId: 'session-lead', agentGeneration: 11,
    definition: identities(room).lead,
  });
  assert.deepEqual(question.reason, {
    kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.',
  });
});

test('driver approval routing fails closed for stale requester registration or absent live Lead', () => {
  const room = approvalRoom();
  const reviewer = fakeAgent('session-reviewer', 7);
  const lead = fakeAgent('session-lead', 11);
  const question = routingQuestion(room);
  const route = (candidate, liveAgentForRun = runId => runId === 'reviewer-run' ? reviewer : runId === 'lead-run' ? lead : undefined) =>
    routeChatroomDriverApproval({ room, question: candidate, liveAgentForRun });

  assert.equal(route({
    ...question,
    registration: {
      ...question.registration,
      requester: { ...question.registration.requester, agentGeneration: 6 },
    },
  }).code, 'mapping-unavailable');
  assert.equal(route(question, runId => runId === 'reviewer-run' ? reviewer : undefined).code,
    'authority-unavailable');
  assert.equal(route(question, runId => runId === 'reviewer-run' ? reviewer : fakeAgent('foreign-session', 11)).code,
    'authority-unavailable');
});

test('request preparation fails closed for missing hierarchy, non-exact identity, or non-exact live Agent', () => {
  const room = approvalRoom();
  const reviewer = fakeAgent('session-reviewer', 7);
  const lead = fakeAgent('session-lead', 11);
  const prepare = overrides => prepareChatroomApprovalRequest({
    room,
    requesterRunId: 'reviewer-run',
    requesterAgent: reviewer,
    liveAgentForRun: runId => runId === 'lead-run' ? lead : undefined,
    toolName: 'shell',
    reason: 'Exact reason',
    ...overrides,
  });

  assert.deepEqual(prepare({ requesterAgent: fakeAgent('foreign-session') }), {
    status: 'unavailable', code: 'requester-agent-mismatch',
  });
  assert.deepEqual(prepare({ liveAgentForRun: () => undefined }), {
    status: 'unavailable', code: 'authority-agent-unavailable',
  });
  assert.deepEqual(prepare({ liveAgentForRun: () => fakeAgent('foreign-session') }), {
    status: 'unavailable', code: 'authority-agent-mismatch',
  });
  assert.deepEqual(prepare({ reason: '' }), { status: 'unavailable', code: 'reason-invalid' });
  assert.deepEqual(prepare({ toolName: 'not a protocol identifier' }), {
    status: 'unavailable', code: 'tool-name-invalid',
  });
  assert.deepEqual(prepare({ callId: '' }), { status: 'unavailable', code: 'call-id-invalid' });

  const withoutReportsTo = createRoom({
    ...room,
    memberships: room.memberships.map(member => member.memberId === 'reviewer'
      ? { ...member, reportsToMemberId: undefined }
      : member),
  });
  assert.deepEqual(prepare({ room: withoutReportsTo }), {
    status: 'unavailable', code: 'authority-member-unavailable',
  });

  const wildcardIdentity = createRoom({
    ...room,
    memberships: room.memberships.map(member => member.memberId === 'leader'
      ? { ...member, definition: { ...member.definition, revision: '*' } }
      : member),
  });
  assert.deepEqual(prepare({ room: wildcardIdentity }), {
    status: 'unavailable', code: 'authority-identity-unavailable',
  });
});

test('projects a Reviewer-authored pending v7 bubble with exact Lead authority and approve/reject only', () => {
  const room = approvalRoom();
  const question = liveQuestion(room);
  const result = projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: authorityEvents(room),
    liveQuestion: question,
    sequence: 43,
  });

  assert.equal(result.status, 'projected');
  const item = result.item;
  assert.equal(item.itemId, chatroomApprovalBubbleItemId('session-reviewer', 'approval-review'));
  assert.equal(item.sequence, 43);
  assert.equal(item.participantId, 'reviewer');
  assert.equal(item.memberId, 'reviewer');
  assert.equal(item.runId, 'reviewer-run');
  assert.equal(item.sessionId, 'session-reviewer');
  assert.deepEqual(item.requester, identities(room).reviewer);
  assert.deepEqual(item.authority, {
    participantId: 'leader', memberId: 'leader', identity: identities(room).lead,
  });
  assert.deepEqual(item.reason, {
    kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.',
  });
  assert.equal(item.agentGeneration, 7);
  assert.deepEqual(item.authorityBinding, question.authority);
  assert.deepEqual(item.actions.map(action => [action.decision, action.command.id]), [
    ['approve', 'approval.approve'], ['reject', 'approval.deny'],
  ]);
  assert.equal('title' in item, false, 'the bubble body never duplicates the Reviewer name');
});

test('updates the same v7 item to an actionless terminal result without reconstructing live authority', () => {
  const room = approvalRoom();
  const pending = projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: authorityEvents(room),
    liveQuestion: liveQuestion(room),
    sequence: 43,
  });
  const terminal = projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: [
      ...authorityEvents(room),
      sessionEvent('session-reviewer', 23, 'approval/decided', {
        id: 'approval-review', outcome: 'rejected',
      }),
    ],
    sequence: 43,
  });

  assert.equal(pending.status, 'projected');
  assert.equal(terminal.status, 'projected');
  assert.equal(terminal.item.itemId, pending.item.itemId);
  assert.equal(terminal.item.sequence, pending.item.sequence);
  assert.equal(terminal.item.state, 'denied');
  assert.deepEqual(terminal.item.actions, []);
  assert.equal('authorityBinding' in terminal.item, false);
  assert.equal('agentGeneration' in terminal.item, false);
  assert.equal(terminal.item.participantId, 'reviewer');
  assert.equal(terminal.item.authority.memberId, 'leader');
  assert.equal(terminal.item.reason.text, pending.item.reason.text);
});

test('maps every durable v7 decision to an actionless terminal state in the same item slot', () => {
  const room = approvalRoom();
  const expected = new Map([
    ['allowed-once', 'approved'],
    ['rejected', 'denied'],
    ['cancelled', 'cancelled'],
    ['unavailable', 'failed'],
  ]);
  for (const [outcome, state] of expected) {
    const result = projectChatroomApprovalBubble({
      room,
      sessionId: 'session-reviewer',
      approvalId: 'approval-review',
      events: [
        ...authorityEvents(room),
        sessionEvent('session-reviewer', 23, 'approval/decided', {
          id: 'approval-review', outcome,
        }),
      ],
      sequence: 43,
    });
    assert.equal(result.status, 'projected');
    assert.equal(result.item.state, state);
    assert.equal(result.item.itemId,
      chatroomApprovalBubbleItemId('session-reviewer', 'approval-review'));
    assert.equal(result.item.sequence, 43);
    assert.deepEqual(result.item.actions, []);
    assert.equal('authorityBinding' in result.item, false);
    assert.equal('agentGeneration' in result.item, false);
    assert.equal('diagnostic' in result.item, state === 'failed');
  }
});

test('keeps old v6 ledgers on the compatibility path and fails closed on divergent v7 facts', () => {
  const room = approvalRoom();
  const asked = authorityEvents(room)[1];
  assert.deepEqual(projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: [asked],
    sequence: 43,
  }), { status: 'legacy', code: 'authority-binding-missing' });

  const duplicate = authorityEvents(room);
  assert.deepEqual(projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: [duplicate[0], duplicate[0], duplicate[1]],
    liveQuestion: liveQuestion(room),
    sequence: 43,
  }), { status: 'invalid', code: 'event-correlation-invalid' });

  const wrongReason = authorityEvents(room).map(event => event.type === 'approval/asked'
    ? { ...event, data: { ...event.data, reason: 'Different reason' } }
    : event);
  assert.deepEqual(projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: wrongReason,
    liveQuestion: liveQuestion(room),
    sequence: 43,
  }), { status: 'invalid', code: 'reason-correlation-invalid' });

  const wrongAuthority = {
    ...liveQuestion(room),
    authority: { ...liveQuestion(room).authority, sessionId: 'foreign-session', agentId: 'foreign-session' },
  };
  assert.deepEqual(projectChatroomApprovalBubble({
    room,
    sessionId: 'session-reviewer',
    approvalId: 'approval-review',
    events: authorityEvents(room),
    liveQuestion: wrongAuthority,
    sequence: 43,
  }), { status: 'invalid', code: 'live-question-invalid' });
});
