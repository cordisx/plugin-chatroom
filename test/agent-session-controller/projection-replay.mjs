export function registerProjectionReplayTests(harness) {
  const {
    CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    ChatroomAgentSessionController,
    mountChatroomPageSource,
    ChatroomConversationController,
    DurableChatroomRoomStore,
    FakeSession,
    addRoomRun,
    assert,
    bindRoomRunSession,
    createRoom,
    owner,
    recordRoomAdmissionMessageLink,
    roomWithRun,
    runtimeHarness,
    sessionEvent,
    test,
    userEvent,
  } = harness;

  test('observer hydration replays then streams live with zero Room transactions or Agent acquisition', async () => {
    const room = roomWithRun('session-existing');
    const harness = runtimeHarness({ room });
    harness.sessions.get('session-existing').replay = [
      userEvent('session-existing', 0, 'replay-message', 'Replay'),
    ];
    const value = { contract: 'cordisx.chatroom-room-registry/v1', rooms: [room] };
    const before = JSON.stringify(value);
    let transactions = 0;
    const store = await DurableChatroomRoomStore.openOwnerDocuments({
      async load() {
        return {
          status: 'loaded',
          snapshot: {
            contract: 'cordisx.owner-documents/v1',
            documentId: 'room-registry',
            revision: 4,
            schemaVersion: 1,
            value,
          },
        };
      },
      async transaction() {
        transactions += 1;
        throw new Error('observer hydration must not transact');
      },
      subscribe() {
        return () => {};
      },
    });
    const observations = [];
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
      observation => {
        observations.push(observation);
      },
    );

    await controller.hydrate();
    await harness.sessions.get('session-existing').emitLive([
      userEvent('session-existing', 1, 'live-message', 'Live'),
    ]);

    assert.equal(transactions, 0);
    assert.equal(JSON.stringify(value), before);
    assert.equal(harness.creates.length, 0);
    assert.equal(harness.resumes.length, 0);
    assert.equal(controller.ownerHandleCount, 0);
    assert.deepEqual(observations.map(item => [item.page.phase, item.page.events[0].seq]), [
      ['replay', 0],
      ['live', 1],
    ]);
    await controller.dispose();
    store.dispose();
  });

  test('Room source remount and process reload rebuild approval and success solely from durable SessionEvent replay', async () => {
    const sessionId = 'cx-session.reviewer-durable';
    const acknowledgement = {
      kind: 'message',
      itemId: 'delegation-ack',
      messageId: 'delegation-ack-message',
      sequence: 20,
      source: 'chatroom-acknowledgement',
      author: {
        participantId: 'leader',
        role: 'agent',
        displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
        agentIdentity: roomWithRun(sessionId).memberships.find(member => member.memberId === 'leader').definition,
      },
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{
        kind: 'text',
        text: {
          namespace: 'chatroom',
          key: 'delegation',
          fallback: '已向 @Reviewer 下发任务：验证审批恢复。',
        },
      }],
      reactions: [],
      timestamp: new Date(1_021).toISOString(),
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const room = createRoom({
      ...roomWithRun(sessionId),
      participants: [
        { id: 'leader', name: 'Lead', kind: 'agent' },
        { id: 'reviewer', name: 'Reviewer', kind: 'agent' },
      ],
      items: [acknowledgement],
      timelineSequence: acknowledgement.sequence,
    });
    const replay = Array.from({ length: 35 }, (_, seq) =>
      sessionEvent(
        sessionId,
        seq,
        'step/start',
        { turn: 1, step: seq + 1 },
      ));
    replay[20] = sessionEvent(sessionId, 20, 'user/message', {
      id: 'reviewer-task',
      role: 'user',
      content: [{ type: 'text', text: '验证审批恢复。' }],
      source: {
        kind: 'plugin',
        pluginId: 'chatroom',
        generation: 7,
        form: 'relay',
        correlation: { namespace: 'chatroom.agent-delegation', id: 'delegation-ack' },
      },
    });
    replay[22] = sessionEvent(sessionId, 22, 'approval/asked', {
      id: 'approval-reviewer',
      toolName: 'shell',
      reason: 'Reviewer needs permission',
    });
    replay[23] = sessionEvent(sessionId, 23, 'approval/decided', {
      id: 'approval-reviewer',
      outcome: 'allowed-once',
    });
    replay[31] = sessionEvent(sessionId, 31, 'assistant/message', {
      turn: 1,
      step: 31,
      message: {
        id: 'reviewer-success',
        role: 'assistant',
        content: [{ type: 'text', text: 'Reviewer success' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [20] });
    replay[34] = sessionEvent(sessionId, 34, 'turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    });

    const harness = runtimeHarness({ room });
    const session = harness.sessions.get(sessionId);
    session.replay = replay;
    const store = DurableChatroomRoomStore.memory([room]);
    const durableBefore = JSON.stringify(store.rooms.get('room'));
    const domain = new ChatroomConversationController([room]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const mount = () => mountChatroomPageSource(domain, controller);

    const firstSource = await mount();
    const first = firstSource.getSnapshot('room');
    const visible = first.items.map(item => [item.itemId, item.sequence]);
    const approval = first.items.find(item => item.kind === 'approval');
    const success = first.items.find(item => item.kind === 'message' && item.messageId === 'reviewer-success');
    assert.equal(approval.state, 'approved');
    assert.equal(approval.approvalId, 'approval-reviewer');
    assert.equal(
      'agentGeneration' in approval,
      false,
      'completed cold replay never invents a process-local Agent generation',
    );
    assert.deepEqual(approval.actions, []);
    assert.equal(success.body[0].text.fallback, 'Reviewer success');
    assert.deepEqual(success.source, { kind: 'session-event', sessionId, eventSeq: 31 });
    assert.deepEqual(first.items.map(item => item.itemId), [
      'delegation-ack',
      approval.itemId,
      success.itemId,
    ]);
    assert.deepEqual(first.activeRuns, [], 'completed replay without a live Agent has no current runtime status');
    assert.equal(harness.creates.length, 0);
    assert.equal(harness.resumes.length, 0);
    assert.equal(controller.ownerHandleCount, 0, 'Page hydration never claims Agent mutation ownership');
    assert.equal(harness.handles.length, 0, 'completed Session replay never reconstructs a live Agent handle');
    assert.equal(
      JSON.stringify(store.rooms.get('room')),
      durableBefore,
      'observer projection never writes replay facts to the Room document',
    );
    firstSource.dispose();

    await session.close('permission-revoked');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      controller.projectionForRoom('room').items.map(item => item.itemId),
      visible.slice(1).map(([itemId]) => itemId),
      'permission replacement retains exact SessionEvent display facts until durable replay replaces them',
    );

    const secondSource = await mount();
    const second = secondSource.getSnapshot('room');
    const concurrent = secondSource.getSnapshot('room');
    assert.equal(second, concurrent, 'page reads reuse the same immutable revision');
    assert.deepEqual(second.items.map(item => [item.itemId, item.sequence]), visible);
    assert.deepEqual(concurrent.items.map(item => [item.itemId, item.sequence]), visible);
    assert.equal(session.observers.length, 2, 'concurrent remount reads share one replay subscription');
    assert.deepEqual(
      harness.sessionGets,
      [sessionId, sessionId],
      'each mount resolves only the exact persisted RoomRun SessionId',
    );
    assert.equal(new Set(second.items.map(item => item.itemId)).size, second.items.length);
    assert.equal(JSON.stringify(store.rooms.get('room')), durableBefore);

    const liveSuccess = sessionEvent(sessionId, 35, 'assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: 'reviewer-live-success',
        role: 'assistant',
        content: [{ type: 'text', text: 'Reviewer live success after remount' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    }, { sourceEventSeqs: [20] });
    await session.emitLive([liveSuccess]);
    session.replay.push(liveSuccess);
    await new Promise(resolve => setImmediate(resolve));
    const afterLive = secondSource.getSnapshot('room');
    assert.equal(
      afterLive.items.filter(item =>
        item.kind === 'message'
        && item.messageId === 'reviewer-live-success'
      ).length,
      1,
      'the reopened replay subscription continues into live without duplicate projection',
    );
    const durableReplayVisible = afterLive.items.map(item => [item.itemId, item.sequence]);
    secondSource.dispose();
    await controller.dispose();

    const reloadedController = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const reloadedSource = await mountChatroomPageSource(domain, reloadedController);
    const reloaded = reloadedSource.getSnapshot('room');
    assert.deepEqual(
      reloaded.items.map(item => [item.itemId, item.sequence]),
      durableReplayVisible,
      'fresh process replay retains exact item identities and presentation coordinates',
    );
    assert.equal(new Set(reloaded.items.map(item => item.itemId)).size, reloaded.items.length);
    const reloadedApproval = reloaded.items.find(item => item.kind === 'approval');
    assert.equal(reloadedApproval.state, 'approved');
    assert.equal('agentGeneration' in reloadedApproval, false);
    assert.deepEqual(reloadedApproval.actions, []);
    assert.equal(JSON.stringify(store.rooms.get('room')), durableBefore);

    reloadedSource.dispose();
    await reloadedController.dispose();
    domain.dispose();
    store.dispose();
  });

  test('a concurrent second run and permission replacement never publish a Room snapshot that drops the first run', async () => {
    const sessionAId = 'cx-session.pending-reviewer';
    const sessionBId = 'cx-session.followup-lead';
    const baseRoom = roomWithRun(sessionAId);
    const delegation = {
      kind: 'message',
      itemId: 'lead-delegation',
      messageId: 'lead-delegation',
      sequence: 20,
      source: 'chatroom-acknowledgement',
      author: {
        participantId: 'leader',
        role: 'agent',
        displayName: { namespace: 'chatroom', key: 'lead', fallback: 'Lead' },
        agentIdentity: baseRoom.memberships.find(member => member.memberId === 'leader').definition,
      },
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{
        kind: 'text',
        text: {
          namespace: 'chatroom',
          key: 'delegation',
          fallback: '已向 @Reviewer 下发任务：3。',
        },
      }],
      reactions: [],
      timestamp: new Date(1_002).toISOString(),
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const initialRoom = createRoom({
      ...baseRoom,
      items: [delegation],
      timelineSequence: delegation.sequence,
    });
    const harness = runtimeHarness({ room: initialRoom });
    const store = DurableChatroomRoomStore.memory([initialRoom]);
    const controller = new ChatroomAgentSessionController(
      { agents: harness.agents, sessions: harness.sessionRegistry, approvals: harness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    await controller.sendToRoom('room', 'review-run', 'user-3', '3');
    const sessionA = harness.sessions.get(sessionAId);
    const eventsA = [
      sessionEvent(sessionAId, 0, 'turn/start', { turn: 1 }),
      sessionEvent(sessionAId, 1, 'user/message', {
        id: 'user-3',
        role: 'user',
        content: [{ type: 'text', text: '3' }],
        source: { kind: 'user' },
      }),
      sessionEvent(sessionAId, 2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'reviewer-intro',
          role: 'assistant',
          content: [{ type: 'text', text: 'Reviewer introduction' }],
          source: { kind: 'model', provider: 'provider', model: 'model' },
        },
      }, { sourceEventSeqs: [1] }),
      sessionEvent(sessionAId, 3, 'approval/asked', {
        id: 'approval-a',
        toolName: 'shell',
        reason: 'Reviewer needs exact permission',
      }),
    ];
    await sessionA.emitLive(eventsA);

    const domain = new ChatroomConversationController(store.rooms);
    const source = await mountChatroomPageSource(domain, controller);
    const before = source.getSnapshot('room');
    const pending = before.items.find(item => item.kind === 'approval');
    assert.equal(pending.state, 'pending');
    const stableA = before.items.map(item => [item.itemId, item.sequence]);
    const snapshots = [];
    const unsubscribe = source.subscribe(() => snapshots.push(source.getSnapshot('room')));

    const sessionB = new FakeSession(sessionBId, [
      sessionEvent(sessionBId, 0, 'turn/start', { turn: 1 }),
      sessionEvent(sessionBId, 1, 'user/message', {
        id: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: '1' }],
        source: { kind: 'user' },
      }),
      sessionEvent(sessionBId, 2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'lead-reply',
          role: 'assistant',
          content: [{ type: 'text', text: 'Lead reply' }],
          source: { kind: 'model', provider: 'provider', model: 'model' },
        },
      }, { sourceEventSeqs: [1] }),
    ]);
    harness.sessions.set(sessionBId, sessionB);
    let releaseSessionB;
    const sessionBBlocked = new Promise(resolve => {
      releaseSessionB = resolve;
    });
    let markSessionBRequested;
    const sessionBRequested = new Promise(resolve => {
      markSessionBRequested = resolve;
    });
    const originalGet = harness.sessionRegistry.get;
    harness.sessionRegistry.get = async id => {
      if (id === sessionBId) {
        markSessionBRequested();
        await sessionBBlocked;
      }
      return await originalGet(id);
    };
    const withRunB = bindRoomRunSession(
      addRoomRun(store.rooms.get('room'), {
        runId: 'lead-run',
        memberId: 'leader',
        title: 'Lead',
        status: 'creating',
      }),
      'lead-run',
      sessionBId,
    );
    await store.upsert(withRunB);
    const durableAfterRunB = JSON.stringify(store.rooms.get('room'));
    const hydrating = source.hydrate('room');
    await sessionBRequested;

    // Model a Host permission replacement at the vulnerable point: refresh has
    // already accepted the new Room document and skipped active run A, but is
    // still awaiting run B. The durable decision lands before exact replay.
    sessionA.replay = [
      ...eventsA,
      sessionEvent(sessionAId, 4, 'approval/decided', {
        id: 'approval-a',
        outcome: 'rejected',
      }),
    ];
    harness.agents.get = async () => undefined;
    await sessionA.close('permission-revoked');
    releaseSessionB();

    await hydrating;
    await new Promise(resolve => setImmediate(resolve));
    const visible = source.getSnapshot('room').items;
    assert.ok(snapshots.length > 0);
    for (const snapshot of snapshots) {
      assert.ok(snapshot.items.some(item => item.itemId === pending.itemId));
    }
    const replayedApproval = visible.find(item => item.itemId === pending.itemId);
    assert.equal(replayedApproval.state, 'denied');
    assert.deepEqual(replayedApproval.actions, []);
    assert.equal('agentGeneration' in replayedApproval, false);
    assert.deepEqual(visible.slice(0, stableA.length).map(item => [item.itemId, item.sequence]), stableA);
    assert.equal(visible.some(item => item.kind === 'message' && item.messageId === 'lead-reply'), true);
    assert.equal(new Set(visible.map(item => item.itemId)).size, visible.length);
    assert.equal(
      store.rooms.get('room').items.some(item => item.itemId === pending.itemId),
      false,
      'Session approval projection is never copied into the durable Room document',
    );
    assert.equal(
      JSON.stringify(store.rooms.get('room')),
      durableAfterRunB,
      'observer refresh never writes a denied approval or Session message into the Room document',
    );
    assert.equal(controller.isRunLocallyUnavailable('room', 'review-run'), false);

    unsubscribe();
    source.dispose();
    await controller.dispose();

    const coldHarness = runtimeHarness({ room: store.rooms.get('room') });
    coldHarness.sessions.get(sessionAId).replay = sessionA.replay;
    coldHarness.sessions.get(sessionBId).replay = sessionB.replay;
    const coldController = new ChatroomAgentSessionController(
      { agents: coldHarness.agents, sessions: coldHarness.sessionRegistry, approvals: coldHarness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const coldSource = await mountChatroomPageSource(domain, coldController);
    const cold = coldSource.getSnapshot('room');
    assert.deepEqual(
      cold.items.map(item => [item.itemId, item.sequence]),
      visible.map(item => [item.itemId, item.sequence]),
      'fresh controller replay restores every A/B item once in the same presentation order',
    );
    const coldApprovals = cold.items.filter(item => item.kind === 'approval');
    assert.equal(coldApprovals.length, 1);
    assert.equal(coldApprovals[0].itemId, pending.itemId);
    assert.equal(coldApprovals[0].state, 'denied');
    assert.deepEqual(coldApprovals[0].actions, []);
    assert.equal(JSON.stringify(store.rooms.get('room')), durableAfterRunB);

    coldSource.dispose();
    await coldController.dispose();
    domain.dispose();
    store.dispose();
  });

  test('a terminal rejection retains the complete Room projection through same-Session route replacement', async () => {
    const reviewerSessionId = 'cx-session.reviewer-terminal';
    const leadSessionId = 'cx-session.lead-terminal';
    const aTimestamp = new Date(1_001).toISOString();
    const delegationTimestamp = new Date(1_002).toISOString();
    const bTimestamp = new Date(1_003).toISOString();
    let room = roomWithRun(reviewerSessionId);
    room = addRoomRun(room, {
      runId: 'lead-run',
      memberId: 'leader',
      title: 'Lead',
      status: 'creating',
    });
    room = bindRoomRunSession(room, 'lead-run', leadSessionId);
    const reviewer = room.memberships.find(member => member.memberId === 'reviewer');
    const lead = room.memberships.find(member => member.memberId === 'leader');
    const human = { id: 'user', name: 'You' };
    assert.ok(reviewer);
    assert.ok(lead);
    const a = {
      kind: 'message',
      itemId: 'room-a',
      messageId: 'room-a-message',
      sequence: 1,
      source: 'agent-loop',
      author: {
        participantId: human.id,
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.name', fallback: human.name },
      },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message', fallback: '3' } }],
      reactions: [],
      timestamp: aTimestamp,
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    const delegation = {
      kind: 'message',
      itemId: 'lead-delegation-terminal',
      messageId: 'lead-delegation-terminal',
      sequence: 2,
      source: 'chatroom-acknowledgement',
      author: {
        participantId: lead.participantId,
        role: 'agent',
        displayName: { namespace: 'chatroom', key: 'participant.name', fallback: lead.label },
        agentIdentity: lead.definition,
      },
      semantic: { purpose: 'chatroom-acknowledgement' },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'delegation', fallback: 'Delegated to Reviewer.' } }],
      reactions: [],
      timestamp: delegationTimestamp,
      deliveryState: 'delivered',
      runState: 'idle',
      ariaLive: 'polite',
      actions: [],
    };
    const b = {
      kind: 'message',
      itemId: 'room-b',
      messageId: 'room-b-message',
      sequence: 3,
      source: 'agent-loop',
      author: {
        participantId: human.id,
        role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.name', fallback: human.name },
      },
      semantic: { purpose: 'conversation' },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message', fallback: '1' } }],
      reactions: [],
      timestamp: bTimestamp,
      deliveryState: 'pending',
      runState: 'idle',
      ariaLive: 'off',
      actions: [],
    };
    room = createRoom({
      ...room,
      participants: [
        { id: 'user', name: 'You', kind: 'human' },
        { id: lead.participantId, name: lead.label, kind: 'agent' },
        { id: reviewer.participantId, name: reviewer.label, kind: 'agent' },
      ],
      items: [a, delegation, b],
      timelineSequence: 3,
    });

    const reviewerReplay = [
      sessionEvent(reviewerSessionId, 0, 'turn/start', { turn: 1 }),
      sessionEvent(reviewerSessionId, 1, 'user/message', {
        id: 'message-a',
        role: 'user',
        content: [{ type: 'text', text: '3' }],
        source: {
          kind: 'plugin',
          pluginId: 'chatroom',
          generation: 7,
          form: 'relay',
          correlation: { namespace: 'chatroom.room-message', id: a.itemId },
        },
      }),
      sessionEvent(reviewerSessionId, 2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'reviewer-introduction',
          role: 'assistant',
          content: [{ type: 'text', text: 'Reviewer introduction' }],
          source: { kind: 'model', provider: 'provider', model: 'model' },
        },
      }, { sourceEventSeqs: [1] }),
    ];
    const harness = runtimeHarness({ room });
    const reviewerSession = harness.sessions.get(reviewerSessionId);
    const leadSession = harness.sessions.get(leadSessionId);
    reviewerSession.replay = reviewerReplay;
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
      'call-reject',
    );
    await new Promise(resolve => setImmediate(resolve));
    const pending = controller.projectionForRoom('room').items.find(item => item.kind === 'approval');
    assert.ok(pending);
    assert.equal(pending.state, 'pending');

    const linkedRoom = recordRoomAdmissionMessageLink(store.rooms.get('room'), {
      roomId: 'room',
      itemId: b.itemId,
      participantId: lead.participantId,
      memberId: lead.memberId,
      runId: 'lead-run',
      sessionId: leadSessionId,
      messageId: 'message-b',
      owner,
      appendAfterItemId: pending.itemId,
    });
    await store.upsert(linkedRoom);
    const leadBEvents = [
      sessionEvent(leadSessionId, 0, 'turn/start', { turn: 1 }),
      sessionEvent(leadSessionId, 1, 'user/message', {
        id: 'message-b',
        role: 'user',
        content: [{ type: 'text', text: '1' }],
        source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation, form: 'relay' },
      }),
    ];
    await leadSession.emitLive(leadBEvents);
    leadSession.replay.push(...leadBEvents);

    const domain = new ChatroomConversationController(store.rooms);
    const source = await mountChatroomPageSource(domain, controller);
    const before = source.getSnapshot('room');
    const beforeIds = before.items.map(item => item.itemId);
    assert.equal(beforeIds.length, 5);
    assert.equal(beforeIds[1], delegation.itemId);
    assert.equal(beforeIds[3], pending.itemId);

    assert.equal(controller.answerApprovalItem('room', pending.itemId, 'rejected'), true);
    assert.equal((await decision).decision.outcome, 'rejected');
    const rejectionResult = sessionEvent(reviewerSessionId, 6, 'assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'reviewer-rejection-result',
        role: 'assistant',
        content: [{ type: 'text', text: 'Approval request rejected.' }],
        source: { kind: 'model', provider: 'provider', model: 'model' },
      },
    });
    await reviewerSession.emitLive([rejectionResult]);
    const approvalEvents = [
      sessionEvent(reviewerSessionId, 3, 'approval/authority-bound', {
        approvalId: 'approval-v2-1',
        requester: reviewer.definition,
        authority: lead.definition,
        reason: { kind: 'plain-text', text: 'Reviewer needs permission to inspect the protected result.' },
      }, { ignorable: true }),
      sessionEvent(reviewerSessionId, 4, 'approval/asked', {
        id: 'approval-v2-1',
        toolName: 'shell',
        callId: 'call-reject',
        reason: 'Reviewer needs permission to inspect the protected result.',
      }),
      sessionEvent(reviewerSessionId, 5, 'approval/decided', { id: 'approval-v2-1', outcome: 'rejected' }),
      rejectionResult,
    ];
    reviewerSession.replay.push(...approvalEvents);
    const terminal = source.getSnapshot('room');
    const rejectionItem = terminal.items.find(item =>
      item.kind === 'message'
      && item.messageId === 'reviewer-rejection-result'
    );
    assert.ok(rejectionItem);
    const expectedIds = [
      beforeIds[0],
      delegation.itemId,
      beforeIds[2],
      pending.itemId,
      beforeIds[4],
      rejectionItem.itemId,
    ];
    assert.deepEqual(terminal.items.map(item => item.itemId), expectedIds);
    const terminalApproval = terminal.items.find(item => item.itemId === pending.itemId);
    assert.equal(terminalApproval.state, 'denied');
    assert.deepEqual(terminalApproval.actions, []);

    const assertTerminalSnapshot = (snapshot, label) => {
      assert.deepEqual(snapshot.items.map(item => item.itemId), expectedIds, label);
      const approval = snapshot.items.find(item => item.itemId === pending.itemId);
      assert.equal(approval.state, 'denied', `${label}: same approval item remains terminal`);
      assert.deepEqual(approval.actions, [], `${label}: terminal approval remains actionless`);
      assert.deepEqual(
        snapshot.items.map(item => item.sequence),
        terminal.items.map(item => item.sequence),
        `${label}: prior Room item coordinates remain stable`,
      );
    };

    const snapshots = [];
    const unsubscribe = source.subscribe(() => snapshots.push(source.getSnapshot('room')));

    const originalGet = harness.sessionRegistry.get;
    harness.sessionRegistry.get = async id =>
      id === reviewerSessionId || id === leadSessionId
        ? undefined
        : await originalGet(id);
    await reviewerSession.close('route-replaced');
    await new Promise(resolve => setImmediate(resolve));
    const afterReviewerRouteFence = source.getSnapshot('room');
    assertTerminalSnapshot(
      afterReviewerRouteFence,
      'Reviewer route replacement cannot replace the terminal Room snapshot with domain-only facts',
    );
    assert.ok(snapshots.length > 0);
    snapshots.splice(0).forEach(snapshot => assertTerminalSnapshot(snapshot, 'Reviewer route subscriber'));

    await leadSession.close('route-replaced');
    await new Promise(resolve => setImmediate(resolve));
    const afterLeadRouteFence = source.getSnapshot('room');
    assertTerminalSnapshot(
      afterLeadRouteFence,
      'Lead route replacement cannot remove admitted A/B or Reviewer terminal facts',
    );
    assert.ok(snapshots.length > 0);
    snapshots.splice(0).forEach(snapshot => assertTerminalSnapshot(snapshot, 'Lead route subscriber'));

    unsubscribe();
    source.dispose();
    const remounted = await mountChatroomPageSource(domain, controller);
    const roundTrip = remounted.getSnapshot('room');
    assertTerminalSnapshot(
      roundTrip,
      'Room/Task remount retains the exact cached terminal SessionEvent projection until replay is available',
    );
    remounted.dispose();
    await controller.dispose();
    domain.dispose();

    const coldHarness = runtimeHarness({ room: store.rooms.get('room') });
    coldHarness.sessions.get(reviewerSessionId).replay = reviewerSession.replay;
    coldHarness.sessions.get(leadSessionId).replay = leadSession.replay;
    const coldController = new ChatroomAgentSessionController(
      { agents: coldHarness.agents, sessions: coldHarness.sessionRegistry, approvals: coldHarness.approvals },
      CHATROOM_DEFAULT_AGENT_CONFIGURATION,
      store,
    );
    const coldDomain = new ChatroomConversationController(store.rooms);
    const coldSource = await mountChatroomPageSource(coldDomain, coldController);
    const cold = coldSource.getSnapshot('room');
    assertTerminalSnapshot(
      cold,
      'cold replay rebuilds the same terminal item ids and append fence without a second ledger',
    );

    // Retention is scoped to the persisted Session identity. A different
    // Session on the same Room run must discard the old Reviewer's facts rather
    // than smuggling them across an Agent replacement.
    const replacementReviewerSessionId = 'cx-session.reviewer-terminal-replacement';
    coldHarness.sessions.set(
      replacementReviewerSessionId,
      new FakeSession(replacementReviewerSessionId, [
        sessionEvent(replacementReviewerSessionId, 0, 'turn/start', { turn: 1 }),
        userEvent(replacementReviewerSessionId, 1, 'replacement-reviewer-message', 'Replacement reviewer.'),
      ]),
    );
    const replacementRoom = createRoom({
      ...store.rooms.get('room'),
      runs: store.rooms.get('room').runs.map(run =>
        run.runId === 'review-run'
          ? {
            ...run,
            sessionId: replacementReviewerSessionId,
            status: 'active',
            presence: { ...run.presence, state: 'ready' },
          }
          : run
      ),
    });
    await store.upsert(replacementRoom);
    await coldController.hydrateRoom('room');
    await new Promise(resolve => setImmediate(resolve));
    const replacement = coldSource.getSnapshot('room');
    assert.equal(
      replacement.items.some(item => item.itemId === pending.itemId),
      false,
      'a different persisted Session identity discards the old terminal approval projector',
    );
    assert.equal(
      replacement.items.some(item => item.itemId === rejectionItem.itemId),
      false,
      'a different persisted Session identity discards the old terminal reply projector',
    );
    assert.equal(
      replacement.items.some(item =>
        item.kind === 'message'
        && item.messageId === 'replacement-reviewer-message'
      ),
      true,
      'the new exact Session is projected after the old projector is discarded',
    );
    assert.equal(
      replacement.items.some(item => item.itemId === beforeIds[4]),
      true,
      'a different Reviewer Session does not remove the independently admitted Lead B projection',
    );

    coldSource.dispose();
    await coldController.dispose();
    coldDomain.dispose();
    store.dispose();
  });
}
