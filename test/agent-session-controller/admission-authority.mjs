export function registerAdmissionAuthorityTests(harness) {
  const {
    CHATROOM_COMMAND_SUBMIT,
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    ChatroomAgentSessionController,
    DurableChatroomRoomStore,
    FakeSession,
    addRoomRun,
    admission,
    assert,
    assertChatroomAdmissionDeliveriesAccepted,
    bindRoomRunSession,
    createRoom,
    messageEvent,
    owner,
    roomWithRun,
    runtimeHarness,
    sessionEvent,
    test,
    userEvent,
  } = harness;

  test('dispose fences an in-flight Room replay demand before subscription publication', async () => {
    const room = roomWithRun('session-delayed-hydration');
    const session = new FakeSession('session-delayed-hydration', [
      userEvent('session-delayed-hydration', 0, 'delayed-message', 'Delayed'),
    ]);
    let release;
    const pendingSession = new Promise(resolve => {
      release = resolve;
    });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      {
        agents: harness.agents,
        sessions: {
          get: async id => {
            assert.equal(id, 'session-delayed-hydration');
            return await pendingSession;
          },
        },
        approvals: harness.approvals,
      },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const hydration = controller.hydrateRoom('room');
    await Promise.resolve();
    const disposing = controller.dispose();
    release(session);
    await Promise.all([hydration, disposing]);

    assert.equal(session.observers.length, 0);
    assert.deepEqual(controller.projectionForRoom('room').items, []);
    assert.equal(JSON.stringify(store.rooms.get('room')), JSON.stringify(room));
    store.dispose();
  });

  test('first explicit mutation creates once, persists only SessionId, and retains owner authority in memory', async () => {
    const room = roomWithRun();
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );

    const first = await controller.sendToRoom('room', 'review-run', 'user-1', 'First');
    const second = await controller.sendToRoom('room', 'review-run', 'user-2', 'Second', 'steer');
    const persisted = store.rooms.get('room').runs[0];

    assert.equal(first.status, 'accepted');
    assert.equal(first.disposition, 'created');
    assert.equal(second.status, 'accepted');
    assert.equal(second.disposition, 'retained');
    assert.equal(harness.creates.length, 1);
    assert.equal(harness.resumes.length, 0);
    assert.equal(harness.creates[0].sessionId, undefined, 'Host mints a new SessionId');
    assert.deepEqual(
      harness.creates[0].definition,
      room.memberships.find(member => member.memberId === 'reviewer').definition,
    );
    assert.equal('setup' in harness.creates[0], false);
    assert.equal(persisted.sessionId, 'session-created-1');
    assert.equal(persisted.taskBinding, undefined);
    assert.equal(persisted.detailsUrl, undefined);
    assert.equal(persisted.agentLoopCursor, undefined);
    assert.equal(persisted.publicProjections, undefined);
    assert.equal(controller.ownerHandleCount, 1);
    assert.deepEqual(harness.handles[0].calls.messages.map(call => call.method), [
      'followup',
      'followup',
      'steer',
    ]);
    assert.equal(
      harness.handles[0].calls.messages[0].message.source.correlation.namespace,
      'chatroom.member-self-introduction',
    );
    assert.deepEqual(harness.handles[0].calls.messages[1].message.source.correlation, {
      namespace: 'chatroom.room-message',
      id: 'user-1',
    });
    await controller.dispose();
    store.dispose();
  });

  test('Shell v9 bootstrap target is issued before first exact Agent acquisition and reservation submit', async () => {
    let room = createRoom({ id: 'room-bootstrap', title: 'Bootstrap Room' });
    room = addRoomRun(room, {
      runId: 'lead-bootstrap',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    const member = room.memberships.find(candidate => candidate.memberId === 'leader');
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const order = [];
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
      contract: 'cordisx.agent-bootstrap-command-origin/v1',
      schemaVersion: 1,
      originId: 'origin-v9',
      binding: { bindingId: 'binding-v9', ownerGeneration: 'owner-v9' },
      generation: 'shell-v9',
      executionId: 'execution-v9',
      commandId: CHATROOM_COMMAND_SUBMIT,
      scope: 'composer-submit',
    };
    const targets = {
      issue: async request => {
        order.push('issue');
        assert.equal(harness.creates.length, 0, 'bootstrap target binds before acquire/create');
        assert.deepEqual(request, {
          origin,
          target: { participantId: member.participantId, memberId: member.memberId, runId: 'lead-bootstrap' },
        });
        return {
          status: 'issued',
          origin: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-bootstrap-target-origin.v4.schema.json',
            contract: 'cordisx.agent-admission-bootstrap-target-origin/v4',
            schemaVersion: 4,
            token: 'bootstrap-lead',
          },
        };
      },
    };
    const reservations = {
      reserve: async request => {
        order.push('reserve');
        assert.equal(harness.creates.length, 1, 'reserve receives the exact newly acquired Agent handle');
        assert.equal(request.handle, harness.handles[0].handle);
        assert.equal(request.origin.token, 'bootstrap-lead');
        assert.deepEqual(request.message, { text: 'Start the first Room task.' });
        return {
          status: 'reserved',
          reservation: {
            reservationId: 'bootstrap-reservation-lead',
            submit: async () => {
              order.push('submit');
              return admission('host-v9-message');
            },
            revoke: async () => {},
          },
        };
      },
    };

    const outcomes = await controller.submitDeliveriesViaAdmissionV4(
      room.id,
      [{ memberId: 'leader', runId: 'lead-bootstrap' }],
      origin,
      'Start the first Room task.',
      targets,
      reservations,
    );

    assert.deepEqual(order, ['issue', 'reserve', 'submit']);
    assert.deepEqual(outcomes, [{
      memberId: 'leader',
      runId: 'lead-bootstrap',
      outcome: {
        status: 'accepted',
        roomId: room.id,
        runId: 'lead-bootstrap',
        messageId: 'host-v9-message',
        sessionId: 'session-created-1',
        disposition: 'created',
      },
    }]);
    assert.deepEqual(
      harness.handles[0].calls.messages,
      [],
      'bootstrap admission never falls through to an Agent driver',
    );
    await controller.dispose();
    store.dispose();
  });

  test('Shell v9 bootstrap denial fails the freshly persisted run closed before acquire or reserve', async () => {
    let room = createRoom({ id: 'room-bootstrap-denied', title: 'Bootstrap Room' });
    room = addRoomRun(room, {
      runId: 'lead-bootstrap-denied',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    let reserves = 0;
    const outcomes = await controller.submitDeliveriesViaAdmissionV4(
      room.id,
      [{ memberId: 'leader', runId: 'lead-bootstrap-denied' }],
      {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json',
        contract: 'cordisx.agent-bootstrap-command-origin/v1',
        schemaVersion: 1,
        originId: 'origin-v9-denied',
        binding: { bindingId: 'binding-v9', ownerGeneration: 'owner-v9' },
        generation: 'shell-v9',
        executionId: 'execution-v9',
        commandId: CHATROOM_COMMAND_SUBMIT,
        scope: 'composer-submit',
      },
      'Do not acquire without a bootstrap target.',
      { issue: async () => ({ status: 'denied', code: 'target-denied' }) },
      {
        reserve: async () => {
          reserves += 1;
          throw new Error('must not reserve');
        },
      },
    );

    assert.deepEqual(outcomes, [{
      memberId: 'leader',
      runId: 'lead-bootstrap-denied',
      outcome: { status: 'denied', roomId: room.id, runId: 'lead-bootstrap-denied', code: 'target-denied' },
    }]);
    assert.equal(harness.creates.length, 0);
    assert.equal(reserves, 0);
    assert.equal(
      store.document(room.id)?.room.runs.find(run => run.runId === 'lead-bootstrap-denied')?.status,
      'failed',
    );
    await controller.dispose();
    store.dispose();
  });

  test('page v2 fresh admission declares the persisted Room before acquire, records its exact link, and never directly sends', async () => {
    const userItem = {
      kind: 'message',
      itemId: 'page-v2-user-item',
      messageId: 'page-v2-room-message',
      sequence: 1,
      source: 'agent-loop',
      author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'message', fallback: 'Start the exact page Room task.' } }],
      reactions: [],
      timestamp: '2026-09-05T00:00:00.000Z',
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    let room = createRoom({
      id: 'page-v2-fresh',
      title: 'Fresh page Room',
      timelineSequence: 1,
      participants: [{ id: 'user', name: 'You', kind: 'human' }],
      items: [userItem],
    });
    room = addRoomRun(room, {
      runId: 'page-v2-lead',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    const member = room.memberships.find(candidate => candidate.memberId === 'leader');
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const order = [];
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json',
      contract: 'cordisx.agent-page-composer-origin/v1',
      schemaVersion: 1,
      originId: 'page-v2-origin',
      binding: { bindingId: 'page-v2-binding', ownerGeneration: 'page-v2-owner' },
      generation: 'page-v2-generation',
      executionId: 'page-v2-execution',
      commandId: CHATROOM_COMMAND_SUBMIT,
      scope: 'page-composer-submit',
      page: { outlet: 'main', routeDefinitionId: 'new-room' },
    };
    const route = { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: room.id };
    const outcomes = await controller.submitDeliveriesViaPageAdmissionV2Fresh(
      room.id,
      [{ memberId: 'leader', runId: 'page-v2-lead' }],
      userItem.itemId,
      origin,
      route,
      'Start the exact page Room task.',
      {
        declare: async request => {
          order.push('declare');
          assert.equal(harness.creates.length, 0, 'page target declaration precedes exact acquisition');
          assert.deepEqual(request, {
            origin,
            target: {
              roomId: room.id,
              participantId: member.participantId,
              memberId: member.memberId,
              runId: 'page-v2-lead',
              route,
            },
          });
          return {
            status: 'declared',
            continuation: {
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-continuation.v1.schema.json',
              contract: 'cordisx.agent-page-admission-route-continuation/v1',
              schemaVersion: 1,
              token: 'page-v2-continuation',
            },
          };
        },
      },
      {
        reserve: async request => {
          order.push('reserve');
          assert.equal(harness.creates.length, 1, 'reserve receives the exact acquired handle');
          assert.equal(request.handle, harness.handles[0].handle);
          assert.equal(request.continuation.token, 'page-v2-continuation');
          assert.deepEqual(request.message, { text: 'Start the exact page Room task.' });
          return {
            status: 'reserved',
            reservation: {
              reservationId: 'page-v2-reservation',
              submit: async () => {
                order.push('submit');
                return admission('page-v2-host-message');
              },
              revoke: async () => {},
            },
          };
        },
      },
    );

    assert.deepEqual(order, ['declare', 'reserve', 'submit']);
    assert.deepEqual(outcomes, [{
      memberId: 'leader',
      runId: 'page-v2-lead',
      outcome: {
        status: 'accepted',
        roomId: room.id,
        runId: 'page-v2-lead',
        messageId: 'page-v2-host-message',
        sessionId: 'session-created-1',
        disposition: 'created',
      },
    }]);
    assert.deepEqual(
      harness.handles[0].calls.messages,
      [],
      'page admission never falls through to Agent direct dispatch',
    );
    assert.deepEqual(store.rooms.get(room.id).admissionMessageLinks, [{
      roomId: room.id,
      itemId: userItem.itemId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: 'page-v2-lead',
      sessionId: 'session-created-1',
      messageId: 'page-v2-host-message',
      owner,
    }]);
    await controller.dispose();
    store.dispose();
  });

  test('page v2 fresh N2/N3 materializes one exact direct Lead authority run before independent target reservations', async () => {
    for (
      const targetMemberIds of [
        ['reviewer', 'integrator'],
        ['reviewer', 'integrator', 'qa'],
      ]
    ) {
      const userItem = {
        kind: 'message',
        itemId: `page-v2-authority-item-${targetMemberIds.length}`,
        messageId: `page-v2-authority-room-message-${targetMemberIds.length}`,
        sequence: 1,
        source: 'agent-loop',
        author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
        semantic: { purpose: 'conversation' },
        body: [{ kind: 'text', text: { key: 'message', fallback: 'Review this exact page admission.' } }],
        reactions: [],
        timestamp: '2026-09-06T00:00:00.000Z',
        deliveryState: 'pending',
        runState: 'idle',
        ariaLive: 'off',
        actions: [],
      };
      let room = createRoom({
        id: `page-v2-authority-${targetMemberIds.length}`,
        title: 'Fresh authority Room',
        timelineSequence: userItem.sequence,
        participants: [{ id: 'user', name: 'You', kind: 'human' }],
        items: [userItem],
      });
      if (targetMemberIds.length === 3) {
        room = createRoom({
          ...room,
          memberships: room.memberships.map(member =>
            member.memberId === 'qa' ? { ...member, reportsToMemberId: 'leader' } : member
          ),
        });
      }
      for (const memberId of targetMemberIds) {
        const member = room.memberships.find(candidate => candidate.memberId === memberId);
        room = addRoomRun(room, {
          runId: `page-v2-${memberId}`,
          memberId,
          title: `${member.label} target run`,
          status: 'creating',
        });
      }

      const harness = runtimeHarness({ room });
      const store = DurableChatroomRoomStore.memory([room]);
      const controller = new ChatroomAgentSessionController(
        { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
        CHATROOM_DEFAULT_AGENT_CONFIGURATION,
        store,
      );
      const origin = {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-origin.v1.schema.json',
        contract: 'cordisx.agent-page-composer-origin/v1',
        schemaVersion: 1,
        originId: `page-v2-authority-origin-${targetMemberIds.length}`,
        binding: { bindingId: 'page-v2-authority-binding', ownerGeneration: 'page-v2-authority-owner' },
        generation: 'page-v2-authority-generation',
        executionId: `page-v2-authority-execution-${targetMemberIds.length}`,
        commandId: CHATROOM_COMMAND_SUBMIT,
        scope: 'page-composer-submit',
        page: { outlet: 'main', routeDefinitionId: 'new-room' },
      };
      const route = { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: room.id };
      const outcomes = await controller.submitDeliveriesViaPageAdmissionV2Fresh(
        room.id,
        targetMemberIds.map(memberId => ({ memberId, runId: `page-v2-${memberId}` })),
        userItem.itemId,
        origin,
        route,
        'Review this exact page admission.',
        {
          declare: async request => ({
            status: 'declared',
            continuation: {
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-admission-route-continuation.v1.schema.json',
              contract: 'cordisx.agent-page-admission-route-continuation/v1',
              schemaVersion: 1,
              token: `page-v2-authority-${request.target.runId}`,
            },
          }),
        },
        {
          reserve: async request => {
            const current = store.rooms.get(room.id);
            const leadRuns = current.runs.filter(run => run.memberId === 'leader');
            assert.equal(leadRuns.length, 1, `N${targetMemberIds.length} must converge on one Lead authority run`);
            assert.ok(leadRuns[0].sessionId, 'the Lead authority run must be acquired before target reserve');
            assert.ok(
              harness.approvals.authorityAnswerers.has(leadRuns[0].sessionId),
              'the exact Lead authority answerer must be registered before target reserve',
            );
            return {
              status: 'reserved',
              reservation: {
                reservationId: `page-v2-authority-reservation-${request.continuation.token}`,
                submit: async () => admission(`page-v2-authority-message-${request.continuation.token}`),
                revoke: async () => {},
              },
            };
          },
        },
      );

      assert.deepEqual(
        outcomes.map(delivery => ({
          memberId: delivery.memberId,
          runId: delivery.runId,
          status: delivery.outcome.status,
        })),
        targetMemberIds.map(memberId => ({
          memberId,
          runId: `page-v2-${memberId}`,
          status: 'accepted',
        })),
      );
      const current = store.rooms.get(room.id);
      const leadRuns = current.runs.filter(run => run.memberId === 'leader');
      assert.equal(leadRuns.length, 1);
      assert.equal(leadRuns[0].title, 'Lead authority run');
      assert.equal(leadRuns[0].sessionSelfIntroduction, undefined, 'authority-only Lead must not self-introduce');
      assert.equal(harness.creates.filter(request => request.definition.agentId === 'chatroom.generalist').length, 1);
      assert.equal(harness.creates.length, targetMemberIds.length + 1);
      assert.deepEqual(
        current.admissionMessageLinks.map(link => link.memberId).sort(),
        [...targetMemberIds].sort(),
        'only explicit targets receive durable admission links',
      );
      assert.ok(
        harness.handles.every(pair => pair.calls.messages.length === 0),
        'no direct Agent dispatch is available',
      );
      await controller.dispose();
      store.dispose();
    }
  });

  test('Shell v8 admission reuses the exact Lead authority before creating Reviewer, then routes a v2 pending approval', async () => {
    const userItem = {
      kind: 'message',
      itemId: 'v3-review-item',
      messageId: 'v3-review-room-message',
      sequence: 1,
      source: 'agent-loop',
      author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'message', fallback: 'Review the exact v8 dispatch.' } }],
      reactions: [],
      timestamp: '2026-09-04T00:00:00.000Z',
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    let room = createRoom({
      id: 'room',
      title: 'Room',
      timelineSequence: userItem.sequence,
      participants: [{ id: 'user', name: 'You', kind: 'human' }],
      items: [userItem],
    });
    room = addRoomRun(room, {
      runId: 'lead-run',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    room = bindRoomRunSession(room, 'lead-run', 'cx-session.lead');
    room = addRoomRun(room, {
      runId: 'review-run',
      memberId: 'reviewer',
      title: 'Reviewer',
      status: 'creating',
    });
    const member = room.memberships.find(candidate => candidate.memberId === 'reviewer');
    const lead = room.memberships.find(candidate => candidate.memberId === 'leader');
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1',
      schemaVersion: 1,
      originId: 'origin-v8',
      binding: { bindingId: 'binding-v8', ownerGeneration: 'owner-v8' },
      generation: 'shell-v8',
      executionId: 'execution-v8',
      commandId: CHATROOM_COMMAND_SUBMIT,
      scope: 'composer-submit',
      room: { roomId: room.id, participantId: 'command-room', memberId: 'command-room', runId: 'command-run' },
    };
    let issued;
    let reserved;
    const origins = {
      issue: async request => {
        issued = request;
        return {
          status: 'issued',
          origin: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json',
            contract: 'cordisx.agent-admission-target-origin/v3',
            schemaVersion: 3,
            token: 'opaque-review-run',
          },
        };
      },
    };
    const reservations = {
      reserve: async request => {
        reserved = request;
        return {
          status: 'reserved',
          reservation: {
            reservationId: 'reservation-v8',
            submit: async () => admission('host-v8-message'),
            revoke: async () => {},
          },
        };
      },
    };

    const results = await controller.submitDeliveriesViaAdmissionV3(
      room.id,
      [{ memberId: 'reviewer', runId: 'review-run' }],
      userItem.itemId,
      origin,
      'Review the exact v8 dispatch.',
      origins,
      reservations,
    );
    const result = results[0].outcome;

    assert.equal(result.status, 'accepted');
    assert.equal(result.messageId, 'host-v8-message');
    assert.equal(result.disposition, 'created');
    assert.equal(harness.resumes.length, 1);
    assert.equal(harness.resumes[0].sessionId, 'cx-session.lead');
    assert.equal(harness.resumes[0].definitionSource, 'session-persisted');
    assert.match(harness.resumes[0].mutationId, /^agent-resume\.4\.room\.8\.lead-run$/);
    assert.equal(harness.creates.length, 1);
    assert.deepEqual(issued, {
      origin,
      target: { participantId: member.participantId, memberId: member.memberId, runId: 'review-run' },
    });
    assert.equal(
      reserved.handle,
      harness.handles[1].handle,
      'reserve receives the acquired exact Reviewer owner handle',
    );
    assert.equal(reserved.origin.token, 'opaque-review-run');
    assert.deepEqual(reserved.message, { text: 'Review the exact v8 dispatch.' });
    assert.deepEqual(
      harness.handles[1].calls.messages,
      [],
      'v8 admission never falls through to Agent direct dispatch',
    );
    assert.deepEqual(store.rooms.get(room.id).admissionMessageLinks, [{
      roomId: room.id,
      itemId: userItem.itemId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: 'review-run',
      sessionId: 'session-created-1',
      messageId: 'host-v8-message',
      owner,
    }], 'the accepted v3 result keeps its exact durable Session/message association');

    const reviewer = harness.handles[1].handle.agent;
    const authority = harness.handles[0].handle.agent;
    const routed = await harness.approvals.routeDriverApproval(reviewer);
    assert.equal(routed.status, 'accepted');
    assert.deepEqual(routed.authority, {
      agentId: authority.id,
      sessionId: authority.session.id,
      agentGeneration: authority.generation,
      definition: lead.definition,
    });
    const decision = harness.approvals.request({
      requester: { agent: reviewer, definition: member.definition },
      authority: { agent: authority, definition: lead.definition },
      toolName: 'shell',
      callId: 'call-review',
      reason: { kind: 'plain-text', text: 'Reviewer needs permission to inspect the exact diff.' },
    });
    await new Promise(resolve => setImmediate(resolve));
    const pending = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');
    assert.ok(pending);
    assert.equal(pending.memberId, 'reviewer');
    assert.equal(pending.authority.memberId, 'leader');
    assert.equal(controller.answerApprovalItem('room', pending.itemId, 'rejected'), true);
    assert.equal((await decision).outcome, 'rejected');
    await controller.dispose();
    store.dispose();
  });

  test('Shell v8 reconciles an accepted existing-Room admission link when its SessionEvent arrives before submit resolves', async () => {
    const userItem = {
      kind: 'message',
      itemId: 'v3-existing-user-item',
      messageId: 'v3-existing-room-message',
      sequence: 1,
      source: 'agent-loop',
      author: { participantId: 'user', role: 'human', displayName: { key: 'user', fallback: 'You' } },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { key: 'message', fallback: 'Continue the exact existing Room.' } }],
      reactions: [],
      timestamp: '2026-09-04T00:00:00.000Z',
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    let room = createRoom({
      id: 'room-v3-existing',
      title: 'Existing Room',
      timelineSequence: userItem.sequence,
      participants: [{ id: 'user', name: 'You', kind: 'human' }],
      items: [userItem],
    });
    room = addRoomRun(room, {
      runId: 'lead-v3-existing',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    room = bindRoomRunSession(room, 'lead-v3-existing', 'cx-session.lead-v3-existing');
    const member = room.memberships.find(candidate => candidate.memberId === 'leader');
    const events = [
      sessionEvent('cx-session.lead-v3-existing', 0, 'turn/start', { turn: 1 }),
      messageEvent('cx-session.lead-v3-existing', 1, {
        id: 'host-v3-existing-message',
        role: 'user',
        content: [{ type: 'text', text: 'Continue the exact existing Room.' }],
        source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation, form: 'relay' },
      }),
    ];
    const harness = runtimeHarness({ room });
    const store = DurableChatroomRoomStore.memory([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const origin = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json',
      contract: 'cordisx.agent-command-origin/v1',
      schemaVersion: 1,
      originId: 'origin-v3-existing',
      binding: { bindingId: 'binding-v3-existing', ownerGeneration: 'owner-v3-existing' },
      generation: 'shell-v9',
      executionId: 'execution-v3-existing',
      commandId: CHATROOM_COMMAND_SUBMIT,
      scope: 'composer-submit',
      room: {
        roomId: room.id,
        participantId: member.participantId,
        memberId: member.memberId,
        runId: 'lead-v3-existing',
      },
    };

    const outcomes = await controller.submitDeliveriesViaAdmissionV3(
      room.id,
      [{ memberId: 'leader', runId: 'lead-v3-existing' }],
      userItem.itemId,
      origin,
      'Continue the exact existing Room.',
      {
        issue: async request => {
          assert.deepEqual(request, {
            origin,
            target: { participantId: member.participantId, memberId: member.memberId, runId: 'lead-v3-existing' },
          });
          return {
            status: 'issued',
            origin: {
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission-target-origin.v3.schema.json',
              contract: 'cordisx.agent-admission-target-origin/v3',
              schemaVersion: 3,
              token: 'v3-existing-target',
            },
          };
        },
      },
      {
        reserve: async request => ({
          status: 'reserved',
          reservation: {
            reservationId: 'v3-existing-reservation',
            submit: async () => {
              await request.handle.agent.session.emitLive(events);
              return admission('host-v3-existing-message');
            },
            revoke: async () => {},
          },
        }),
      },
    );

    assertChatroomAdmissionDeliveriesAccepted(outcomes);
    const persisted = store.rooms.get(room.id);
    assert.deepEqual(persisted.admissionMessageLinks, [{
      roomId: room.id,
      itemId: userItem.itemId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: 'lead-v3-existing',
      sessionId: 'cx-session.lead-v3-existing',
      messageId: 'host-v3-existing-message',
      owner,
    }]);
    const live = controller.projectionForRoom(room.id);
    assert.deepEqual(
      live.items.map(item => item.messageId),
      ['host-v3-existing-message'],
      'the pre-result SessionEvent joins only after its accepted exact tuple persists',
    );

    await controller.dispose();
    const coldHarness = runtimeHarness({ room: persisted });
    coldHarness.sessions.get('cx-session.lead-v3-existing').replay = events;
    const coldStore = DurableChatroomRoomStore.memory([persisted]);
    const cold = new ChatroomAgentSessionController(
      { agents: coldHarness.agents, sessions: coldHarness.sessionRegistry, approvals: coldHarness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      coldStore,
    );
    await cold.hydrateRoom(room.id);
    assert.deepEqual(
      cold.projectionForRoom(room.id).items.map(item => item.messageId),
      live.items.map(item => item.messageId),
      'cold replay restores the same durable exact association without a text or session inference',
    );
    await cold.dispose();
    coldStore.dispose();
    store.dispose();
  });
}
