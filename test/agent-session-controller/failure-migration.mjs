export function registerFailureMigrationTests(harness) {
  const {
    CHATROOM_COMMAND_SUBMIT,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    ChatroomAgentSessionController,
    ChatroomConversationController,
    DurableChatroomRoomStore,
    addRoomRun,
    assert,
    assertChatroomAdmissionDeliveriesAccepted,
    bindRoomRun,
    bindRoomRunSession,
    createRoom,
    messageEvent,
    roomWithRun,
    runtimeHarness,
    test,
  } = harness;

  test('Shell v8 admission requires a nonempty all-accepted delivery result with no direct fallback', () => {
    assert.throws(
      () => assertChatroomAdmissionDeliveriesAccepted([]),
      /composer submit resolved no deliveries/,
    );
    assert.throws(
      () =>
        assertChatroomAdmissionDeliveriesAccepted([
          {
            memberId: 'leader',
            runId: 'lead-run',
            outcome: {
              status: 'accepted',
              roomId: 'room',
              runId: 'lead-run',
              messageId: 'lead-message',
              sessionId: 'cx-session.lead',
              disposition: 'retained',
            },
          },
          {
            memberId: 'reviewer',
            runId: 'review-run',
            outcome: { status: 'denied', roomId: 'room', runId: 'review-run', code: 'target-denied' },
          },
        ]),
      /admission delivery failed for reviewer\/review-run: denied:target-denied/,
    );
    assert.doesNotThrow(() =>
      assertChatroomAdmissionDeliveriesAccepted([
        {
          memberId: 'leader',
          runId: 'lead-run',
          outcome: {
            status: 'accepted',
            roomId: 'room',
            runId: 'lead-run',
            messageId: 'lead-message',
            sessionId: 'cx-session.lead',
            disposition: 'retained',
          },
        },
        {
          memberId: 'reviewer',
          runId: 'review-run',
          outcome: {
            status: 'accepted',
            roomId: 'room',
            runId: 'review-run',
            messageId: 'review-message',
            sessionId: 'cx-session.reviewer',
            disposition: 'created',
          },
        },
      ])
    );
  });

  test('Shell v8 acquisition failure persists the creating run as failed before issue or reserve', async () => {
    let room = createRoom({ id: 'room', title: 'Room' });
    room = addRoomRun(room, { runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating' });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      {
        agents: {
          ...harness.agents,
          create: async () => ({ status: 'unavailable', code: 'permission-denied' }),
        },
        sessions: harness.sessionRegistry,
        approvals: harness.approvals,
      },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    let issues = 0;
    let reserves = 0;
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1',
      schemaVersion: 1,
      originId: 'origin-v8-acquire-failure',
      binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
      generation: 'shell-v8',
      executionId: 'execution-v8',
      commandId: CHATROOM_COMMAND_SUBMIT,
      scope: 'composer-submit',
      room: { roomId: room.id, participantId: 'command-room', memberId: 'command-room', runId: 'command-run' },
    };
    const outcomes = await controller.submitDeliveriesViaAdmissionV3(
      room.id,
      [{ memberId: 'leader', runId: 'lead-run' }],
      'user-item-v3-acquire-failure',
      origin,
      '3',
      {
        issue: async () => {
          issues += 1;
          throw new Error('must not issue');
        },
      },
      {
        reserve: async () => {
          reserves += 1;
          throw new Error('must not reserve');
        },
      },
    );

    assert.deepEqual(outcomes, [{
      memberId: 'leader',
      runId: 'lead-run',
      outcome: { status: 'unavailable', roomId: 'room', runId: 'lead-run', code: 'permission-denied' },
    }]);
    const persisted = store.document('room')?.room.runs.find(run => run.runId === 'lead-run');
    assert.equal(persisted?.sessionId, undefined);
    assert.equal(persisted?.status, 'failed');
    assert.deepEqual(persisted?.presence.failure, {
      code: 'permission-denied',
      retryable: true,
      diagnostic: 'Agent admission could not acquire the exact Room run: permission-denied.',
    });
    assert.equal(issues, 0);
    assert.equal(reserves, 0);
    await controller.dispose();
    store.dispose();
  });

  test('Shell v8 admission stops before issue or reserve when the exact Reviewer resolver is not registered', async () => {
    let room = createRoom({ id: 'room', title: 'Room' });
    room = addRoomRun(room, { runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating' });
    room = bindRoomRunSession(room, 'lead-run', 'cx-session.lead');
    room = addRoomRun(room, { runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating' });
    const harness = runtimeHarness({
      room,
      resolverRegistrationResult: requester =>
        requester.agent.id === 'cx-session.lead'
          ? undefined
          : { status: 'unavailable', code: 'host-unavailable' },
    });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    let issues = 0;
    let reserves = 0;

    await assert.rejects(
      controller.submitDeliveriesViaAdmissionV3(
        room.id,
        [{ memberId: 'reviewer', runId: 'review-run' }],
        'user-item-v3-resolver-unavailable',
        {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
          contract: 'cordisx.agent-command-origin/v1',
          schemaVersion: 1,
          originId: 'origin-v8-resolver-refused',
          binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
          generation: 'shell-v8',
          executionId: 'execution-v8',
          commandId: CHATROOM_COMMAND_SUBMIT,
          scope: 'composer-submit',
          room: { roomId: room.id, participantId: 'command-room', memberId: 'command-room', runId: 'command-run' },
        },
        'Do not submit without a registered Reviewer resolver.',
        {
          issue: async () => {
            issues += 1;
            throw new Error('must not issue');
          },
        },
        {
          reserve: async () => {
            reserves += 1;
            throw new Error('must not reserve');
          },
        },
      ),
      /approval request resolver was not registered: host-unavailable/,
    );

    assert.equal(issues, 0);
    assert.equal(reserves, 0);
    assert.equal(harness.handles.length, 2);
    await controller.dispose();
    store.dispose();
  });

  test('Shell v8 admission stops before issue or reserve when the exact Reviewer resolver is denied or throws', async () => {
    for (
      const [label, resolverRegistrationResult, expected] of [
        [
          'denied',
          () => ({ status: 'denied', code: 'permission-denied' }),
          /approval request resolver was not registered: permission-denied/,
        ],
        ['error', () => {
          throw new Error('resolver registration interrupted');
        }, /resolver registration interrupted/],
      ]
    ) {
      let room = createRoom({ id: `room-${label}`, title: 'Room' });
      room = addRoomRun(room, { runId: 'lead-run', memberId: 'leader', title: 'Lead', status: 'creating' });
      room = bindRoomRunSession(room, 'lead-run', 'cx-session.lead');
      room = addRoomRun(room, { runId: 'review-run', memberId: 'reviewer', title: 'Reviewer', status: 'creating' });
      const harness = runtimeHarness({
        room,
        resolverRegistrationResult: requester =>
          requester.agent.id === 'cx-session.lead'
            ? undefined
            : resolverRegistrationResult(),
      });
      const store = DurableChatroomRoomStore.memory([room]);
      const controller = new ChatroomAgentSessionController(
        { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      let issues = 0;
      let reserves = 0;

      await assert.rejects(
        controller.submitDeliveriesViaAdmissionV3(
          room.id,
          [{ memberId: 'reviewer', runId: 'review-run' }],
          `user-item-v3-resolver-${label}`,
          {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
            contract: 'cordisx.agent-command-origin/v1',
            schemaVersion: 1,
            originId: `origin-v8-resolver-${label}`,
            binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
            generation: 'shell-v8',
            executionId: 'execution-v8',
            commandId: CHATROOM_COMMAND_SUBMIT,
            scope: 'composer-submit',
            room: { roomId: room.id, participantId: 'command-room', memberId: 'command-room', runId: 'command-run' },
          },
          'Do not submit without a registered Reviewer resolver.',
          {
            issue: async () => {
              issues += 1;
              throw new Error('must not issue');
            },
          },
          {
            reserve: async () => {
              reserves += 1;
              throw new Error('must not reserve');
            },
          },
        ),
        expected,
      );

      assert.equal(issues, 0, `${label} must not issue`);
      assert.equal(reserves, 0, `${label} must not reserve`);
      await controller.dispose();
      store.dispose();
    }
  });

  test('Shell v8 admission fails closed when Reviewer has multiple unpreferred reports-to Lead runs', async () => {
    let room = roomWithRun();
    room = addRoomRun(room, { runId: 'lead-run-a', memberId: 'leader', title: 'Lead A', status: 'creating' });
    room = addRoomRun(room, { runId: 'lead-run-b', memberId: 'leader', title: 'Lead B', status: 'creating' });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    let issues = 0;
    let reserves = 0;
    const result = await controller.submitDeliveriesViaAdmissionV3(
      room.id,
      [{ memberId: 'reviewer', runId: 'review-run' }],
      'user-item-v3-missing-lead',
      {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
        contract: 'cordisx.agent-command-origin/v1',
        schemaVersion: 1,
        originId: 'origin-v8-missing-lead',
        binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
        generation: 'shell-v8',
        executionId: 'execution-v8',
        commandId: CHATROOM_COMMAND_SUBMIT,
        scope: 'composer-submit',
        room: { roomId: room.id, participantId: 'command-room', memberId: 'command-room', runId: 'command-run' },
      },
      'Review only if the exact Lead is live.',
      {
        issue: async () => {
          issues += 1;
          throw new Error('must not issue without Lead');
        },
      },
      {
        reserve: async () => {
          reserves += 1;
          throw new Error('must not reserve without Lead');
        },
      },
    );

    assert.deepEqual(result, [{
      memberId: 'reviewer',
      runId: 'review-run',
      outcome: { status: 'unavailable', roomId: room.id, runId: 'review-run', code: 'authority-run-unavailable' },
    }]);
    assert.equal(harness.creates.length, 0);
    assert.equal(issues, 0);
    assert.equal(reserves, 0);
    await controller.dispose();
    store.dispose();
  });

  test('explicit mention stays in the durable Room display while Agent admission receives stripped dispatch text', async () => {
    const domain = new ChatroomConversationController();
    domain.rooms.upsert(createRoom({ id: 'room', title: 'Room' }));
    domain.createSource({
      bindingId: 'binding-display',
      shell: 'agent-desktop',
      ownerGeneration: 'owner-1',
      routeSelection: { scope: 'room-or-new', selectedRoomParam: 'room' },
    });
    const intent = domain.handle({
      binding: { bindingId: 'binding-display', ownerGeneration: 'owner-1' },
      generation: 'owner-1',
      scope: 'composer-submit',
      command: { id: CHATROOM_COMMAND_SUBMIT },
      submitPayload: '@Reviewer 请回复：显式路由成功。',
    });
    assert.equal(intent.kind, 'send-message');
    assert.deepEqual(intent.deliveries.map(delivery => delivery.memberId), ['reviewer']);
    assert.equal(intent.dispatchText, '请回复：显式路由成功。');
    const room = domain.rooms.get('room');
    assert.equal(
      room.items.find(item => item.itemId === intent.userItemId).body[0].text.fallback,
      '@Reviewer 请回复：显式路由成功。',
    );

    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const observations = [];
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
      observation => {
        observations.push(observation);
      },
    );
    await controller.sendToRoom(
      'room',
      intent.deliveries[0].runId,
      intent.userItemId,
      intent.dispatchText,
    );
    const [introduction, admitted] = harness.handles[0].calls.messages.map(call => call.message);
    assert.equal(admitted.content[0].text, '请回复：显式路由成功。');
    assert.deepEqual(admitted.source.correlation, {
      namespace: 'chatroom.room-message',
      id: intent.userItemId,
    });

    await harness.sessions.get('session-created-1').emitLive([
      messageEvent('session-created-1', 0, introduction),
      messageEvent('session-created-1', 1, {
        id: 'assistant-introduction',
        role: 'assistant',
        content: [{ type: 'text', text: 'I review changes.' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      }, [0]),
      messageEvent('session-created-1', 2, admitted),
    ]);
    const display = observations[0].projection.changes
      .map(change => change.item)
      .find(item => item.kind === 'message' && item.messageId === admitted.id);
    assert.equal(display.body[0].text.fallback, '@Reviewer 请回复：显式路由成功。');
    assert.deepEqual(display.source, {
      kind: 'session-event',
      sessionId: 'session-created-1',
      eventSeq: 2,
    });
    await controller.dispose();
    store.dispose();
  });

  test('first explicit mutation migrates an exact legacy TaskBinding through Host authority', async () => {
    let room = roomWithRun();
    const binding = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
      contract: 'cordisx.agent-loop-task-binding/v4',
      schemaVersion: 4,
      binding: { bindingId: 'legacy-binding', generation: 3 },
      definition: room.memberships.find(member => member.memberId === 'reviewer').definition,
      task: 'opaque-legacy-task',
      state: 'active',
    };
    room = bindRoomRun(room, 'review-run', binding);
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Migrate');

    assert.equal(result.status, 'accepted');
    assert.equal(result.sessionId, 'session-legacy-exact');
    assert.equal(harness.creates.length, 0);
    assert.equal(harness.resumes.length, 0);
    assert.equal(harness.legacyAcquires.length, 1);
    assert.deepEqual(harness.legacyAcquires[0].binding, binding, 'TaskBinding remains opaque');
    assert.equal(
      'setup' in harness.legacyAcquires[0],
      false,
      'legacy Session resumes its persisted definition binding',
    );
    assert.equal(store.rooms.get('room').runs[0].sessionId, 'session-legacy-exact');
    assert.equal(store.rooms.get('room').runs[0].taskBinding, undefined);
    await controller.dispose();
    store.dispose();
  });

  test('controller emits Shell v6 projection from the same replay-to-live Session stream', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const observations = [];
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
      observation => {
        observations.push(observation);
      },
    );

    await controller.sendToRoom('room', 'review-run', 'user-1', 'Please review');
    const introduction = harness.handles[0].calls.messages[0].message;
    await harness.sessions.get('session-created-1').emitLive([
      messageEvent('session-created-1', 0, introduction),
      messageEvent('session-created-1', 1, {
        id: 'assistant-introduction',
        role: 'assistant',
        content: [{ type: 'text', text: 'I review changes.' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      }, [0]),
    ]);

    assert.equal(observations.length, 1);
    assert.equal(observations[0].page.phase, 'live');
    assert.equal(observations[0].projection.phase, 'live');
    assert.equal(observations[0].projection.changes.length, 1);
    assert.deepEqual(observations[0].projection.changes[0].item.source, {
      kind: 'session-event',
      sessionId: 'session-created-1',
      eventSeq: 1,
    });
    assert.deepEqual(observations[0].projection.changes[0].item.semantic.correlation, {
      sessionId: 'session-created-1',
      requestMessageId: introduction.id,
    });
    await controller.dispose();
    store.dispose();
  });

  test('Session binding atomically retires the same run AgentLoop identity instead of keeping dual truth', () => {
    let room = roomWithRun();
    room = bindRoomRun(room, 'review-run', {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-task-binding.v4.schema.json',
      contract: 'cordisx.agent-loop-task-binding/v4',
      schemaVersion: 4,
      binding: { bindingId: 'legacy-binding', generation: 1 },
      definition: room.memberships.find(member => member.memberId === 'reviewer').definition,
      task: 'legacy-task',
      state: 'active',
    });

    const migrated = bindRoomRunSession(room, 'review-run', 'session-one');
    const persisted = JSON.parse(JSON.stringify(migrated.runs[0]));

    assert.equal(persisted.sessionId, 'session-one');
    assert.equal(persisted.presence.state, 'ready');
    assert.equal('taskBinding' in persisted, false);
    assert.equal('detailsUrl' in persisted, false);
    assert.equal('rebind' in persisted, false);
    assert.equal('agentLoopCursor' in persisted, false);
    assert.equal('publicProjections' in persisted, false);
  });

  test('observer hydration stays read-only until the first explicit mutation resumes its Session', async () => {
    const room = roomWithRun('session-existing');
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    await controller.hydrate();
    assert.equal(controller.ownerHandleCount, 0);
    const result = await controller.sendToRoom('room', 'review-run', 'user-1', 'Resume');

    assert.equal(result.status, 'accepted');
    assert.equal(result.disposition, 'resumed');
    assert.equal(harness.creates.length, 0);
    assert.deepEqual(harness.resumes.map(item => item.sessionId), ['session-existing']);
    assert.equal(harness.resumes[0].definitionSource, 'session-persisted');
    assert.equal('definition' in harness.resumes[0], false);
    assert.equal('setup' in harness.resumes[0], false);
    assert.equal(controller.ownerHandleCount, 1);
    await controller.dispose();
    store.dispose();
  });
}
