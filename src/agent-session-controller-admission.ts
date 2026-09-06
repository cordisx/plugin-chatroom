import {
  acquireErrorCode,
  addRoomRun,
  type AgentAdmissionBootstrapReservationService,
  type AgentAdmissionBootstrapTargetService,
  type AgentAdmissionTarget,
  type AgentAdmissionTargetOriginService,
  type AgentAdmissionTargetReservationService,
  type AgentBootstrapCommandOrigin,
  type AgentCommandOrigin,
  type AgentHandle,
  type AgentPageAdmissionReservationService,
  type AgentPageAdmissionRouteDeclarationService,
  type AgentPageAdmissionRouteReservationService,
  type AgentPageAdmissionTargetService,
  type AgentPageComposerOrigin,
  type AgentPageRoomRoute,
  type ApprovalAuthorityWarmup,
  type ChatroomAgentAdmissionDelivery,
  type ChatroomAgentAdmissionDeliveryOutcome,
  type ChatroomAgentSessionOutcome,
  createChatroomOpaqueId,
  declareChatroomPageAdmissionRoute,
  type DirectApprovalAuthorityRun,
  failRoomRunPresence,
  issueChatroomAgentAdmissionBootstrapTarget,
  issueChatroomPageAdmissionTarget,
  type MessageId,
  recordRoomAdmissionMessageLink,
  type Room,
  runKey,
  type RuntimeAcquireFailure,
  type RuntimeOwner,
  submitChatroomAgentAdmissionBootstrapReservation,
  submitChatroomAgentAdmissionV3,
  submitChatroomPageAdmissionReservation,
  submitChatroomPageAdmissionRouteReservation,
} from './agent-session-controller-internals.js';
import { ChatroomAgentSessionProjectionController } from './agent-session-controller-projection.js';

export abstract class ChatroomAgentSessionAdmissionController extends ChatroomAgentSessionProjectionController {
  /**
   * Shell target-origin pre-submit path. Each delivery receives a distinct
   * opaque Host-issued target origin derived from the same base command
   * origin. This method intentionally accepts only public contracts and never
   * falls through to Chatroom's legacy Agent driver methods.
   */
  async submitDeliveriesViaAdmissionV3(
    roomId: string,
    deliveries: readonly ChatroomAgentAdmissionDelivery[],
    userItemId: string,
    origin: AgentCommandOrigin,
    text: string,
    origins: AgentAdmissionTargetOriginService,
    reservations: AgentAdmissionTargetReservationService,
  ): Promise<readonly ChatroomAgentAdmissionDeliveryOutcome[]> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    return await Promise.all(deliveries.map(async delivery =>
      Object.freeze({
        memberId: delivery.memberId,
        runId: delivery.runId,
        outcome: await this.submitDeliveryViaAdmissionV3(
          roomId,
          delivery,
          userItemId,
          origin,
          text,
          origins,
          reservations,
        ),
      })
    ));
  }

  /**
   * Shell v9 bootstrap path. A fresh Room has no pre-existing target origin,
   * so each persisted delivery first declares its exact Room target under the
   * Host-issued bootstrap command. Only then may Chatroom acquire that exact
   * AgentHandle, reserve it, and submit the resulting one-shot reservation.
   */
  async submitDeliveriesViaAdmissionV4(
    roomId: string,
    deliveries: readonly ChatroomAgentAdmissionDelivery[],
    origin: AgentBootstrapCommandOrigin,
    text: string,
    targets: AgentAdmissionBootstrapTargetService,
    reservations: AgentAdmissionBootstrapReservationService,
  ): Promise<readonly ChatroomAgentAdmissionDeliveryOutcome[]> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    return await Promise.all(deliveries.map(async delivery =>
      Object.freeze({
        memberId: delivery.memberId,
        runId: delivery.runId,
        outcome: await this.submitDeliveryViaAdmissionV4(
          roomId,
          delivery,
          origin,
          text,
          targets,
          reservations,
        ),
      })
    ));
  }

  /**
   * Page-admission v2 path for an already mounted Room page. Each target is
   * issued before Chatroom acquires its exact AgentHandle; no ordinary Agent
   * send path is available from this method.
   */
  async submitDeliveriesViaPageAdmissionV2Existing(
    roomId: string,
    deliveries: readonly ChatroomAgentAdmissionDelivery[],
    userItemId: string,
    origin: AgentPageComposerOrigin,
    text: string,
    targets: AgentPageAdmissionTargetService,
    reservations: AgentPageAdmissionReservationService,
  ): Promise<readonly ChatroomAgentAdmissionDeliveryOutcome[]> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    return await Promise.all(deliveries.map(async delivery =>
      Object.freeze({
        memberId: delivery.memberId,
        runId: delivery.runId,
        outcome: await this.submitDeliveryViaPageAdmissionV2Existing(
          roomId,
          delivery,
          userItemId,
          origin,
          text,
          targets,
          reservations,
        ),
      })
    ));
  }

  /**
   * Fresh page path. Each delivery declares the exact persisted Room target
   * and destination route before acquisition. The Host alone performs the
   * eventual route claim through the v2 fresh-navigation permit.
   */
  async submitDeliveriesViaPageAdmissionV2Fresh(
    roomId: string,
    deliveries: readonly ChatroomAgentAdmissionDelivery[],
    userItemId: string,
    origin: AgentPageComposerOrigin,
    route: AgentPageRoomRoute,
    text: string,
    declarations: AgentPageAdmissionRouteDeclarationService,
    reservations: AgentPageAdmissionRouteReservationService,
  ): Promise<readonly ChatroomAgentAdmissionDeliveryOutcome[]> {
    this.assertUsable();
    if (text.trim() === '') throw new Error('Room message must not be empty.');
    if (route.roomId !== roomId) {
      throw new Error('Chatroom page fresh admission route does not match the persisted Room.');
    }
    return await Promise.all(deliveries.map(async delivery =>
      Object.freeze({
        memberId: delivery.memberId,
        runId: delivery.runId,
        outcome: await this.submitDeliveryViaPageAdmissionV2Fresh(
          roomId,
          delivery,
          userItemId,
          origin,
          route,
          text,
          declarations,
          reservations,
        ),
      })
    ));
  }

  /**
   * The Host has already committed the authoritative SessionEvent when an
   * admission reservation returns accepted. Persist its exact public identity
   * in the existing Room owner document, then reconcile any live event that
   * arrived before this result crossed the plugin boundary.
   */
  private async recordAdmissionMessageLink(
    roomId: string,
    userItemId: string,
    delivery: ChatroomAgentAdmissionDelivery,
    handle: AgentHandle,
    messageId: MessageId,
  ): Promise<void> {
    const appendAfterItemId = this.appendAnchorForAdmissionMessage(roomId, userItemId);
    await this.mutateRoom(roomId, room => {
      const run = this.requireRun(room, delivery.runId);
      const member = this.requireMember(room, delivery.memberId);
      if (
        run.memberId !== delivery.memberId
        || member.memberId !== delivery.memberId
        || run.sessionId !== handle.agent.session.id
      ) {
        throw new Error('Accepted Chatroom admission no longer matches its exact Room target.');
      }
      const existingForItem = room.admissionMessageLinks?.find(link => link.itemId === userItemId);
      const retainedAppendAfterItemId = existingForItem === undefined
        ? appendAfterItemId
        : existingForItem.appendAfterItemId;
      return recordRoomAdmissionMessageLink(room, {
        roomId,
        itemId: userItemId,
        participantId: member.participantId,
        memberId: member.memberId,
        runId: delivery.runId,
        sessionId: handle.agent.session.id,
        messageId,
        owner: {
          pluginId: handle.owner.pluginId,
          generation: handle.owner.generation,
        },
        // N target reservations may settle in either order. All links for one
        // Room item retain the first durable append fence rather than making a
        // later target choose a different predecessor.
        ...(retainedAppendAfterItemId === undefined ? {} : { appendAfterItemId: retainedAppendAfterItemId }),
      });
    });
    this.reconcileAdmissionMessageLinks(roomId);
  }

  /**
   * A first Room message has no prior public fact to fence. When a later
   * human Room message arrives while a non-terminal approval is already
   * materialized, use the last Session projection item as an opaque append
   * fence. This captures order at the owner-document commit, rather than
   * inferring it from timestamps, text, or current Agent state.
   */
  private appendAnchorForAdmissionMessage(roomId: string, userItemId: string): string | undefined {
    const room = this.requireRoom(roomId);
    const itemIndex = room.items.findIndex(item => item.itemId === userItemId);
    if (itemIndex < 0) throw new Error('Accepted Chatroom admission Room item is unavailable.');
    const hasEarlierHumanMessage = room.items.slice(0, itemIndex).some(item =>
      item.kind === 'message' && item.author.role === 'human' && item.semantic.purpose === 'conversation'
    );
    const items = this.projectionForRoom(roomId).items;
    if (
      !hasEarlierHumanMessage
      || !items.some(item => item.kind === 'approval' && item.state === 'pending')
    ) return undefined;
    return items.length === 0 ? undefined : items[items.length - 1].itemId;
  }

  private reconcileAdmissionMessageLinks(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    let changed = false;
    for (const run of room.runs) {
      if (run.sessionId === undefined) continue;
      const projector = this.projectors.get(runKey(roomId, run.runId));
      if (projector === undefined) continue;
      if (projector.reconcileAdmissionLinks(room, run).length > 0) changed = true;
    }
    if (changed) { for (const listener of this.projectionListeners) listener(roomId); }
  }

  private async submitDeliveryViaAdmissionV4(
    roomId: string,
    delivery: ChatroomAgentAdmissionDelivery,
    origin: AgentBootstrapCommandOrigin,
    text: string,
    targets: AgentAdmissionBootstrapTargetService,
    reservations: AgentAdmissionBootstrapReservationService,
  ): Promise<ChatroomAgentSessionOutcome> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, delivery.runId);
    if (run.memberId !== delivery.memberId) {
      throw new Error('Chatroom bootstrap admission delivery does not match the exact Room run member.');
    }
    const member = this.requireMember(room, run.memberId);
    const target: AgentAdmissionTarget = {
      participantId: member.participantId,
      memberId: member.memberId,
      runId: delivery.runId,
    };
    let issued: Awaited<ReturnType<typeof issueChatroomAgentAdmissionBootstrapTarget>>;
    try {
      issued = await issueChatroomAgentAdmissionBootstrapTarget(targets, origin, target);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'bootstrap-target-issue-failed', error);
      throw error;
    }
    if (issued.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, issued.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: issued.code };
    }

    let authority: ApprovalAuthorityWarmup;
    try {
      authority = await this.ensureDirectApprovalAuthorityOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'authority-acquire-failed', error);
      throw error;
    }
    if (authority.status === 'unavailable') {
      await this.failPendingDelivery(roomId, delivery.runId, authority.code);
      return { status: 'unavailable', roomId, runId: delivery.runId, code: authority.code };
    }

    let acquired: RuntimeOwner | RuntimeAcquireFailure;
    try {
      acquired = await this.ensureOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'agent-acquire-failed', error);
      throw error;
    }
    if (!('handle' in acquired)) {
      const code = acquireErrorCode(acquired);
      await this.failPendingDelivery(roomId, delivery.runId, code);
      return { status: acquired.status, roomId, runId: delivery.runId, code };
    }

    let result: Awaited<ReturnType<typeof submitChatroomAgentAdmissionBootstrapReservation>>;
    try {
      result = await submitChatroomAgentAdmissionBootstrapReservation(reservations, {
        handle: acquired.handle,
        origin: issued.origin,
        message: { text },
      });
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'bootstrap-reservation-failed', error);
      throw error;
    }
    if (result.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, result.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: result.code };
    }
    return {
      status: 'accepted',
      roomId,
      runId: delivery.runId,
      messageId: result.admission.messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  private async submitDeliveryViaPageAdmissionV2Existing(
    roomId: string,
    delivery: ChatroomAgentAdmissionDelivery,
    userItemId: string,
    origin: AgentPageComposerOrigin,
    text: string,
    targets: AgentPageAdmissionTargetService,
    reservations: AgentPageAdmissionReservationService,
  ): Promise<ChatroomAgentSessionOutcome> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, delivery.runId);
    if (run.memberId !== delivery.memberId) {
      throw new Error('Chatroom page admission delivery does not match the exact Room run member.');
    }
    const member = this.requireMember(room, run.memberId);
    const target = {
      roomId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: delivery.runId,
    } as const;
    let issued: Awaited<ReturnType<typeof issueChatroomPageAdmissionTarget>>;
    try {
      issued = await issueChatroomPageAdmissionTarget(targets, origin, target);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-target-issue-failed', error);
      throw error;
    }
    if (issued.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, issued.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: issued.code };
    }

    let authority: ApprovalAuthorityWarmup;
    try {
      authority = await this.ensureDirectApprovalAuthorityOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-authority-acquire-failed', error);
      throw error;
    }
    if (authority.status === 'unavailable') {
      await this.failPendingDelivery(roomId, delivery.runId, authority.code);
      return { status: 'unavailable', roomId, runId: delivery.runId, code: authority.code };
    }
    let acquired: RuntimeOwner | RuntimeAcquireFailure;
    try {
      acquired = await this.ensureOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-agent-acquire-failed', error);
      throw error;
    }
    if (!('handle' in acquired)) {
      const code = acquireErrorCode(acquired);
      await this.failPendingDelivery(roomId, delivery.runId, code);
      return { status: acquired.status, roomId, runId: delivery.runId, code };
    }
    let result: Awaited<ReturnType<typeof submitChatroomPageAdmissionReservation>>;
    try {
      result = await submitChatroomPageAdmissionReservation(reservations, {
        handle: acquired.handle,
        origin: issued.origin,
        message: { text },
      });
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-reservation-failed', error);
      throw error;
    }
    if (result.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, result.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: result.code };
    }
    await this.recordAdmissionMessageLink(
      roomId,
      userItemId,
      delivery,
      acquired.handle,
      result.admission.messageId,
    );
    return {
      status: 'accepted',
      roomId,
      runId: delivery.runId,
      messageId: result.admission.messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  private async submitDeliveryViaPageAdmissionV2Fresh(
    roomId: string,
    delivery: ChatroomAgentAdmissionDelivery,
    userItemId: string,
    origin: AgentPageComposerOrigin,
    route: AgentPageRoomRoute,
    text: string,
    declarations: AgentPageAdmissionRouteDeclarationService,
    reservations: AgentPageAdmissionRouteReservationService,
  ): Promise<ChatroomAgentSessionOutcome> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, delivery.runId);
    if (run.memberId !== delivery.memberId) {
      throw new Error('Chatroom fresh page admission delivery does not match the exact Room run member.');
    }
    const member = this.requireMember(room, run.memberId);
    const target = {
      roomId,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: delivery.runId,
      route,
    } as const;
    let declared: Awaited<ReturnType<typeof declareChatroomPageAdmissionRoute>>;
    try {
      declared = await declareChatroomPageAdmissionRoute(declarations, origin, target);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-route-declaration-failed', error);
      throw error;
    }
    if (declared.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, declared.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: declared.code };
    }

    let authority: ApprovalAuthorityWarmup;
    try {
      authority = await this.ensureDirectApprovalAuthorityOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-authority-acquire-failed', error);
      throw error;
    }
    if (authority.status === 'unavailable') {
      await this.failPendingDelivery(roomId, delivery.runId, authority.code);
      return { status: 'unavailable', roomId, runId: delivery.runId, code: authority.code };
    }
    let acquired: RuntimeOwner | RuntimeAcquireFailure;
    try {
      acquired = await this.ensureOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-agent-acquire-failed', error);
      throw error;
    }
    if (!('handle' in acquired)) {
      const code = acquireErrorCode(acquired);
      await this.failPendingDelivery(roomId, delivery.runId, code);
      return { status: acquired.status, roomId, runId: delivery.runId, code };
    }
    let result: Awaited<ReturnType<typeof submitChatroomPageAdmissionRouteReservation>>;
    try {
      result = await submitChatroomPageAdmissionRouteReservation(reservations, {
        handle: acquired.handle,
        continuation: declared.continuation,
        message: { text },
      });
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'page-route-reservation-failed', error);
      throw error;
    }
    if (result.status === 'denied') {
      await this.failPendingDelivery(roomId, delivery.runId, result.code);
      return { status: 'denied', roomId, runId: delivery.runId, code: result.code };
    }
    await this.recordAdmissionMessageLink(
      roomId,
      userItemId,
      delivery,
      acquired.handle,
      result.admission.messageId,
    );
    return {
      status: 'accepted',
      roomId,
      runId: delivery.runId,
      messageId: result.admission.messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  private async submitDeliveryViaAdmissionV3(
    roomId: string,
    delivery: ChatroomAgentAdmissionDelivery,
    userItemId: string,
    origin: AgentCommandOrigin,
    text: string,
    origins: AgentAdmissionTargetOriginService,
    reservations: AgentAdmissionTargetReservationService,
  ): Promise<ChatroomAgentSessionOutcome> {
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, delivery.runId);
    if (run.memberId !== delivery.memberId) {
      throw new Error('Chatroom admission delivery does not match the exact Room run member.');
    }
    const member = this.requireMember(room, run.memberId);
    // Driver approvals are routed by the Host before it writes their v2
    // authority-bound/asked facts. Bring up only the requester's direct
    // reports-to authority first, so its exact owner and answerer exist when
    // the newly admitted target asks. This never selects by label or falls
    // back to another manager.
    let authority: ApprovalAuthorityWarmup;
    try {
      authority = await this.ensureDirectApprovalAuthorityOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'authority-acquire-failed', error);
      throw error;
    }
    if (authority.status === 'unavailable') {
      await this.failPendingDelivery(roomId, delivery.runId, authority.code);
      return { status: 'unavailable', roomId, runId: delivery.runId, code: authority.code };
    }
    let acquired: RuntimeOwner | RuntimeAcquireFailure;
    try {
      acquired = await this.ensureOwner(roomId, delivery.runId);
    } catch (error) {
      await this.failPendingDelivery(roomId, delivery.runId, 'agent-acquire-failed', error);
      throw error;
    }
    if (!('handle' in acquired)) {
      const code = acquireErrorCode(acquired);
      await this.failPendingDelivery(roomId, delivery.runId, code);
      return { status: acquired.status, roomId, runId: delivery.runId, code };
    }
    const target: AgentAdmissionTarget = {
      participantId: member.participantId,
      memberId: member.memberId,
      runId: delivery.runId,
    };
    const result = await submitChatroomAgentAdmissionV3(origins, reservations, {
      handle: acquired.handle,
      origin,
      target,
      message: { text },
    });
    if (result.status === 'denied') {
      return { status: 'denied', roomId, runId: delivery.runId, code: result.code };
    }
    await this.recordAdmissionMessageLink(
      roomId,
      userItemId,
      delivery,
      acquired.handle,
      result.admission.messageId,
    );
    return {
      status: 'accepted',
      roomId,
      runId: delivery.runId,
      messageId: result.admission.messageId,
      sessionId: acquired.handle.agent.session.id,
      disposition: acquired.disposition,
    };
  }

  /**
   * A failed pre-submit acquisition must not strand a durable Room run in
   * `creating`. There is intentionally no driver fallback from this path.
   */
  private async failPendingDelivery(
    roomId: string,
    runId: string,
    code: string,
    error?: unknown,
  ): Promise<void> {
    const key = runKey(roomId, runId);
    this.localUnavailableRuns.set(key, code);
    const diagnostic = error instanceof Error && error.message.trim() !== ''
      ? error.message
      : `Agent admission could not acquire the exact Room run: ${code}.`;
    await this.mutateRoom(roomId, room => {
      const run = this.requireRun(room, runId);
      return run.status === 'creating' || run.presence.state === 'creating'
        ? failRoomRunPresence(room, runId, { code, retryable: true, diagnostic })
        : room;
    });
  }

  private async ensureDirectApprovalAuthorityOwner(
    roomId: string,
    requesterRunId: string,
  ): Promise<ApprovalAuthorityWarmup> {
    let selected = this.directApprovalAuthorityRun(this.requireRoom(roomId), requesterRunId);
    if (selected.status === 'not-required') return selected;
    if (selected.status === 'materialize') {
      const authorityRunId = createChatroomOpaqueId(
        'approval-authority-run',
        roomId,
        selected.authorityMember.memberId,
      );
      await this.mutateRoom(roomId, room => {
        const current = this.directApprovalAuthorityRun(room, requesterRunId);
        if (current.status !== 'materialize') return room;
        return addRoomRun(room, {
          runId: authorityRunId,
          memberId: current.authorityMember.memberId,
          title: `${current.authorityMember.label} authority run`,
          status: 'creating',
        });
      });
      selected = this.directApprovalAuthorityRun(this.requireRoom(roomId), requesterRunId);
    }
    if (selected.status === 'unavailable') return selected;
    if (selected.status !== 'ready') {
      throw new Error('Chatroom direct approval authority did not resolve after materialization.');
    }
    const { authorityMember, authorityRun } = selected;

    const acquired = await this.ensureOwner(roomId, authorityRun.runId);
    if (!('handle' in acquired)) return { status: 'unavailable', code: acquireErrorCode(acquired) };

    // Re-read after acquisition: the Room run, member definition, Session,
    // and registered answerer must still be the exact direct authority.
    const current = this.requireRoom(roomId);
    const currentRun = this.requireRun(current, authorityRun.runId);
    const currentMember = this.requireMember(current, authorityMember.memberId);
    const answerer = this.approvalAuthorityAnswerers.get(runKey(roomId, authorityRun.runId));
    if (
      currentRun.memberId !== authorityMember.memberId
      || currentRun.sessionId !== acquired.handle.agent.session.id
      || currentMember.definition.agentId !== authorityMember.definition.agentId
      || currentMember.definition.revision !== authorityMember.definition.revision
      || answerer === undefined
      || answerer.authority.agentId !== acquired.handle.agent.id
      || answerer.authority.sessionId !== acquired.handle.agent.session.id
      || answerer.authority.agentGeneration !== acquired.handle.agent.generation
      || answerer.authority.definition.agentId !== authorityMember.definition.agentId
      || answerer.authority.definition.revision !== authorityMember.definition.revision
    ) {
      return { status: 'unavailable', code: 'authority-agent-unavailable' };
    }
    return { status: 'ready' };
  }

  private directApprovalAuthorityRun(room: Room, requesterRunId: string): DirectApprovalAuthorityRun {
    const requesterRun = this.requireRun(room, requesterRunId);
    const requesterMember = this.requireMember(room, requesterRun.memberId);
    const authorityMemberId = requesterMember.reportsToMemberId;
    if (authorityMemberId === undefined) return { status: 'not-required' };
    const authorityMember = this.requireMember(room, authorityMemberId);
    const authorityRuns = room.runs.filter(run => run.memberId === authorityMember.memberId);
    if (authorityMember.preferredRunId !== undefined) {
      const authorityRun = authorityRuns.find(run => run.runId === authorityMember.preferredRunId);
      return authorityRun === undefined
        ? { status: 'unavailable', code: 'authority-run-unavailable' }
        : { status: 'ready', authorityMember, authorityRun };
    }
    if (authorityRuns.length === 0) return { status: 'materialize', authorityMember };
    if (authorityRuns.length !== 1) return { status: 'unavailable', code: 'authority-run-unavailable' };
    return { status: 'ready', authorityMember, authorityRun: authorityRuns[0] };
  }
}
