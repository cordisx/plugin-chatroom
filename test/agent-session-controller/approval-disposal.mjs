export function registerApprovalDisposalTests(harness) {
  const {
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    ChatroomAgentSessionController,
    DurableChatroomRoomStore,
    addRoomRun,
    admission,
    assert,
    createRoom,
    discarded,
    messageEvent,
    recordRoomSessionSelfIntroduction,
    roomWithRun,
    runtimeHarness,
    test,
    userEvent,
  } = harness;

  test('permission lease replacement keeps the durable Session resumable on explicit mutation', async () => {
    const room = roomWithRun('session-existing');
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    await controller.hydrate();
    await harness.sessions.get('session-existing').close('permission-revoked');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(controller.isRunLocallyUnavailable('room', 'review-run'), false);
    const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Resume');
    assert.equal(result.status, 'accepted');
    assert.equal(result.disposition, 'resumed');
    assert.deepEqual(harness.resumes.map(item => item.sessionId), ['session-existing']);
    await controller.dispose();
    store.dispose();
  });

  test('SessionEvent replay prevents a persisted self-introduction correlation from being resubmitted', async () => {
    let room = roomWithRun('session-existing');
    room = recordRoomSessionSelfIntroduction(room, 'review-run', {
      requestMessageId: 'intro-message',
      correlationId: 'intro-correlation',
      requestedAt: '2026-09-03T00:00:00.000Z',
    });
    const harness = runtimeHarness({ room });
    harness.sessions.get('session-existing').replay = [{
      ...userEvent('session-existing', 0, 'intro-message', 'Introduce'),
      data: {
        id: 'intro-message',
        role: 'user',
        content: [{ type: 'text', text: 'Introduce' }],
        source: {
          kind: 'plugin',
          pluginId: 'chatroom',
          generation: 6,
          form: 'instructions',
          correlation: { namespace: 'chatroom.member-self-introduction', id: 'intro-correlation' },
        },
      },
    }];
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    await controller.hydrate();
    const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Continue');

    assert.equal(result.status, 'accepted');
    assert.deepEqual(harness.handles[0].calls.messages.map(call => call.message.id), [
      'room-session-message.6.user-1.10.review-run',
    ]);
    await controller.dispose();
    store.dispose();
  });

  test('two Room runs acquire isolated Sessions and owner handles without persisting either handle', async () => {
    let room = createRoom({ id: 'room', title: 'Room' });
    room = addRoomRun(room, {
      runId: 'lead-run',
      memberId: 'leader',
      title: 'Leader',
      status: 'creating',
    });
    room = addRoomRun(room, {
      runId: 'review-run',
      memberId: 'reviewer',
      title: 'Reviewer',
      status: 'creating',
    });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    await Promise.all([
      controller.sendToRoom('room', 'lead-run', 'user-1', 'Lead'),
      controller.sendToRoom('room', 'review-run', 'user-1', 'Review'),
    ]);
    const persisted = store.rooms.get('room');

    assert.equal(new Set(persisted.runs.map(run => run.sessionId)).size, 2);
    assert.equal(controller.ownerHandleCount, 2);
    assert.doesNotMatch(JSON.stringify(persisted), /owner|handle|subscription/i);
    await controller.dispose();
    store.dispose();
  });

  test('live Session assistant mentions preserve Reviewer to Integrator and Documentation to QA delegation', async t => {
    for (
      const [sourceMemberId, targetLabel] of [
        ['reviewer', 'Integrator'],
        ['documentation', 'QA'],
      ]
    ) {
      await t.test(`${sourceMemberId} -> ${targetLabel}`, async () => {
        let room = createRoom({ id: 'room', title: 'Room' });
        room = addRoomRun(room, {
          runId: 'source-run',
          memberId: sourceMemberId,
          title: sourceMemberId,
          status: 'creating',
        });
        const harness = runtimeHarness({ room });
        const store = DurableChatroomRoomStore.memory([room]);
        const controller = new ChatroomAgentSessionController(
          { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
          CHATROOM_DEFAULT_AGENT_CONFIGURATION,
          store,
        );
        await controller.sendToRoom('room', 'source-run', 'user-1', 'Coordinate');
        await harness.handles[0].handle.agent.session.emitLive([messageEvent(
          'session-created-1',
          0,
          {
            id: `assistant-${sourceMemberId}`,
            role: 'assistant',
            content: [{ type: 'text', text: `@${targetLabel} Verify the handoff` }],
            source: { kind: 'model', provider: 'provider', model: 'model' },
          },
        )]);

        const targetRun = store.rooms.get('room').runs.find(run =>
          store.rooms.get('room').memberships.find(member => member.memberId === run.memberId)?.label === targetLabel
        );
        assert.ok(targetRun);
        const targetHandle = harness.handles.find(pair => pair.handle.agent.session.id === targetRun.sessionId);
        assert.deepEqual(targetHandle.calls.messages.map(call => call.message.source.correlation.namespace), [
          'chatroom.member-self-introduction',
          'chatroom.agent-delegation',
        ]);
        assert.equal(targetHandle.calls.messages[1].message.content[0].text, 'Verify the handoff');
        await controller.dispose();
        store.dispose();
      });
    }
  });

  test('self introduction remains Chatroom orchestration and pending cancellation discards only its MessageId', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const requested = await controller.requestMemberSelfIntroduction('room', 'review-run');
    const cancelled = await controller.cancelMemberSelfIntroduction('room', 'review-run');
    const message = harness.handles[0].calls.messages[0].message;

    assert.equal(requested.status, 'accepted');
    assert.equal(message.source.correlation.namespace, 'chatroom.member-self-introduction');
    assert.match(message.content[0].text, /Introduce yourself to this Chatroom Room as Reviewer/);
    assert.equal(cancelled.status, 'accepted');
    assert.deepEqual(harness.handles[0].calls.discarded, [requested.messageId]);
    assert.equal(store.rooms.get('room').runs[0].sessionSelfIntroduction.requestMessageId, requested.messageId);
    await controller.dispose();
    store.dispose();
  });

  test('replacement drops process-local ownership and the next explicit mutation resumes', async () => {
    const room = roomWithRun();
    const unavailable = admission('placeholder', 'unavailable', 'agent-replaced');
    const harness = runtimeHarness({ room, createAdmissions: [admission('intro'), unavailable] });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const first = await controller.sendToRoom('room', 'review-run', 'user-1', 'Replace');
    const second = await controller.sendToRoom('room', 'review-run', 'user-2', 'Recover');

    assert.equal(first.status, 'unavailable');
    assert.equal(first.code, 'agent-replaced');
    assert.equal(second.status, 'accepted');
    assert.equal(second.disposition, 'resumed');
    assert.equal(harness.creates.length, 1);
    assert.equal(harness.resumes.length, 1);
    await controller.dispose();
    store.dispose();
  });

  test('approval answerer follows reports-to hierarchy while ctx.approvals owns Session facts', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const policies = [];
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
      () => {},
      context => {
        policies.push(context);
        return 'allowed-once';
      },
    );

    await controller.sendToRoom('room', 'review-run', 'user-1', 'Needs approval');
    const agent = harness.handles[0].handle.agent;
    const decision = await harness.approvals.request({
      agent,
      toolName: 'shell',
      reason: 'Run command',
    });

    assert.equal(decision.outcome, 'allowed-once');
    assert.deepEqual(policies[0].authorityMemberIds, ['leader']);
    assert.deepEqual(harness.approvals.facts, [
      { type: 'approval/asked', sessionId: agent.session.id, id: 'approval-1' },
      { type: 'approval/decided', sessionId: agent.session.id, id: 'approval-1', outcome: 'allowed-once' },
    ]);
    assert.equal(store.rooms.get('room').approvalDecisions.length, 0);
    await controller.dispose();
    store.dispose();
  });

  test('Shell approval action settles only the matching independent ctx.approvals question', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    await controller.sendToRoom('room', 'review-run', 'user-1', 'Needs approval');
    const agent = harness.handles[0].handle.agent;
    const decision = harness.approvals.request({ agent, toolName: 'shell', reason: 'Run command' });
    await new Promise(resolve => setImmediate(resolve));
    await agent.session.emitLive([{
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
      contract: 'cordisx.session-event/v1',
      schemaVersion: 1,
      sessionId: agent.session.id,
      seq: 0,
      time: 1_000,
      type: 'approval/asked',
      data: { id: 'approval-1', toolName: 'shell', reason: 'Run command' },
    }]);
    const item = controller.projectionForRoom('room').items.find(candidate => candidate.kind === 'approval');

    assert.equal(item.state, 'pending');
    assert.equal(controller.answerApprovalItem('room', item.itemId, 'allowed-once'), true);
    assert.equal((await decision).outcome, 'allowed-once');
    assert.equal(store.rooms.get('room').approvalDecisions.length, 0);
    await controller.dispose();
    store.dispose();
  });

  test('approval v2 binds Reviewer requester to exact Lead authority and updates one v7 item in place', async () => {
    let room = createRoom({ id: 'room', title: 'Room' });
    room = addRoomRun(room, {
      runId: 'lead-run',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    room = addRoomRun(room, {
      runId: 'review-run',
      memberId: 'reviewer',
      title: 'Reviewer',
      status: 'creating',
    });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const decision = controller.requestApproval(
      'room',
      'review-run',
      'shell',
      'Reviewer needs permission to inspect the protected result.',
      'call-review',
    );
    await new Promise(resolve => setImmediate(resolve));
    const pending = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');

    assert.ok(pending);
    assert.equal(pending.memberId, 'reviewer');
    assert.equal(pending.authority.memberId, 'leader');
    assert.equal(pending.reason.text, 'Reviewer needs permission to inspect the protected result.');
    assert.deepEqual(pending.actions.map(action => action.decision), ['approve', 'reject']);
    const stable = { itemId: pending.itemId, sequence: pending.sequence };
    const commandContext = {
      binding: { bindingId: 'binding', ownerGeneration: 'owner' },
      generation: 'shell-generation',
      scope: 'approval',
      itemId: pending.itemId,
      command: { id: 'chatroom.approval.deny' },
      approval: {
        sessionId: pending.sessionId,
        approvalId: pending.approvalId,
        requester: pending.requester,
        authority: pending.authorityBinding,
        decision: 'reject',
      },
    };
    assert.equal(
      controller.answerApprovalCommand('room', {
        ...commandContext,
        approval: { ...commandContext.approval, approvalId: 'foreign-approval' },
      }),
      false,
    );
    assert.equal(controller.answerApprovalCommand('room', commandContext), true);
    assert.equal((await decision).decision.outcome, 'rejected');
    const denied = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');
    assert.deepEqual({ itemId: denied.itemId, sequence: denied.sequence }, stable);
    assert.equal(denied.state, 'denied');
    assert.deepEqual(denied.actions, []);
    assert.equal(store.rooms.get('room').approvalDecisions.length, 0);

    await controller.dispose();
    store.dispose();
  });

  test('dispose closes every Session subscription, answerer, and in-memory owner handle', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    await controller.sendToRoom('room', 'review-run', 'user-1', 'Dispose');
    const session = harness.handles[0].handle.agent.session;

    await controller.dispose();

    assert.equal(session.unsubscribeCount, 1);
    assert.equal(harness.handles[0].calls.disposed, 1);
    assert.equal(harness.approvals.requestResolvers.get(session.id).closedCode, 'disposed');
    assert.equal(controller.ownerHandleCount, 0);
    store.dispose();
  });
}
