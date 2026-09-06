import type {
  AgentLoopApprovalDecision,
  AgentLoopCommand,
  AgentLoopContentPart,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4';
import type { ChatroomApprovalDecisionOutcome } from './agent-loop-command-values.js';

import { agentDefinitionCatalogFor, type ChatroomAgentConfiguration } from './agent-definition.js';
import {
  acceptRoomDelivery,
  canonicalRoomDeliveryOperation,
  hydrateRoomDeliveries,
  markRoomDeliverySendingUnknown,
  planRoomDelivery,
  prepareRoomOutboxDelivery,
  requireRoomDeliveryAttention,
  requireRoomDeliveryStageAttention,
} from './room-delivery.js';
import {
  acceptRoomRunPresence,
  createStoredRoomRunDetailsUrl,
  failRoomRunPresence,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from './room-engagement.js';
import { DurableChatroomRoomStore } from './room-store.js';
import { replaceRoomRun, type Room, type RoomDeliveryPayload } from './room.js';

import {
  bindingOperationId,
  type ChatroomAgentLoopOutcome,
  COMMAND_CONTRACT,
  COMMAND_SCHEMA,
  type CreateBindingOutcome,
  type CreateOrSendFailure,
  deliveryId,
  operationId,
  payloadFor,
  resultCode,
  stablePart,
} from './agent-loop-command-values.js';
import { ChatroomAgentLoopDecisions } from './agent-loop-decisions.js';
import { ChatroomAgentLoopRuntime } from './agent-loop-runtime.js';
export { type ChatroomAgentLoopOutcome, type ChatroomApprovalDecisionOutcome } from './agent-loop-command-values.js';
/**
 * Every side effect is preceded by a document-level Room CAS containing the
 * stable commandId, privacy-safe replay correlation, exact command hash, and
 * consumer observation time. Full commands are rebuilt from the current
 * catalog and may replay only when that hash remains identical.
 */
export class ChatroomAgentLoopController extends ChatroomAgentLoopRuntime {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly decisions: ChatroomAgentLoopDecisions;

  constructor(
    client: BoundAgentLoopClient,
    configuration: ChatroomAgentConfiguration,
    store: DurableChatroomRoomStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    super(client, configuration, store, now);
    const runtime = this;
    this.decisions = new ChatroomAgentLoopDecisions(client, {
      get controllerGeneration() {
        return runtime.controllerGeneration;
      },
      assertUsable: () => this.assertUsable(),
      isCurrentGeneration: generation => this.isCurrentGeneration(generation),
      requireRoom: roomId => this.requireRoom(roomId),
      requireRun: (room, runId) => this.requireRun(room, runId),
      mutateRoom: (roomId, mutation, generation) => this.mutateRoom(roomId, mutation, generation),
    });
  }
  async decideApproval(
    roomId: string,
    runId: string,
    turn: string,
    approvalId: string,
    decision: AgentLoopApprovalDecision,
    requestOperationId?: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    return this.decisions.decideApproval(roomId, runId, turn, approvalId, decision, requestOperationId);
  }

  async cancelMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    return this.decisions.cancelMemberSelfIntroduction(roomId, runId);
  }

  private async requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
    binding: AgentLoopTaskBinding,
  ): Promise<boolean> {
    return this.decisions.requestMemberSelfIntroduction(roomId, runId, binding);
  }

  sendToRoom(
    roomId: string,
    runId: string,
    userItemId: string,
    content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]],
    runtimeGeneration: string,
    sendOperationId?: string,
  ): Promise<ChatroomAgentLoopOutcome> {
    this.assertUsable();
    const controllerGeneration = this.controllerGeneration;
    const operationKey = stablePart(roomId);
    const previous = this.operations.get(operationKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() =>
      this.sendToRunNow(
        roomId,
        runId,
        userItemId,
        content,
        runtimeGeneration,
        controllerGeneration,
        sendOperationId,
      )
    );
    const settled = operation.then(() => {}, () => {});
    this.operations.set(operationKey, settled);
    return operation.finally(() => {
      if (this.operations.get(operationKey) === settled) this.operations.delete(operationKey);
    });
  }

  private async sendToRunNow(
    roomId: string,
    runId: string,
    userItemId: string,
    content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]],
    runtimeGeneration: string,
    controllerGeneration: number,
    sendOperationId?: string,
  ): Promise<ChatroomAgentLoopOutcome> {
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
    }
    await this.recoverForExplicitMutation(roomId, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
    }
    let member!: Room['memberships'][number];
    let acknowledgementKey = '';
    let aggregateDeliveryId = '';
    let createCommandId = '';
    // The Shell generation is part of a send operation's durable identity.
    // Playground owner documents are process-local while the Simulator ledger
    // survives in the browser; after a server restart, sequential item ids can
    // repeat but must never reuse an old command with a different binding.
    const sendCommandId = sendOperationId
      ?? operationId('send', roomId, runId, userItemId, runtimeGeneration);
    await this.mutateRoom(roomId, current => {
      let next = current;
      const currentRun = this.requireRun(next, runId);
      member = current.memberships.find(candidate => candidate.memberId === currentRun.memberId)!;
      const acknowledgement = prepareRoomAcknowledgement(next, this.configuration, {
        userItemId,
        memberId: member.memberId,
        runId,
      });
      acknowledgementKey = acknowledgement.acknowledgement.acknowledgementKey;
      next = markRoomAcknowledgementSent(acknowledgement.room, acknowledgementKey);
      createCommandId = currentRun.taskBinding === undefined
        ? operationId('create', roomId, runId, undefined, runtimeGeneration)
        : bindingOperationId('bind', roomId, runId, currentRun.taskBinding, userItemId);
      const aggregate = prepareRoomOutboxDelivery(next, {
        deliveryId: deliveryId(roomId, runId, userItemId),
        userItemId,
        memberId: member.memberId,
        runId,
        ...(currentRun.presence.state === 'ready'
            && currentRun.taskBinding?.state === 'active' && currentRun.detailsUrl !== undefined
          ? {}
          : { createOperationId: createCommandId }),
        sendOperationId: sendCommandId,
      });
      aggregateDeliveryId = aggregate.delivery.deliveryId;
      next = aggregate.room;
      return next;
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
    }
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    let binding = this.requireRun(room, runId).taskBinding;
    let bindingCreated = false;
    if (
      run.presence.state !== 'ready'
      || binding?.state !== 'active' || run.detailsUrl === undefined
    ) {
      const created = await this.createOrReplayBinding(
        roomId,
        runId,
        aggregateDeliveryId,
        member.definition,
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
      }
      if (created.status !== 'accepted') {
        await this.failMessage(
          roomId,
          runId,
          userItemId,
          acknowledgementKey,
          created.code,
          controllerGeneration,
        );
        if (!this.isCurrentGeneration(controllerGeneration)) {
          return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
        }
        return { ...created, roomId, runId, bindingCreated: false };
      }
      binding = created.binding;
      bindingCreated = true;
    }
    if (binding.state !== 'active') {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'task-unavailable' };
    }
    // A transport failure can leave the durable introduction request in an
    // unknown state after create/bind was committed. The next exact Room
    // delivery replays that same operation before sending; it never mints a
    // replacement id or invents a hidden prompt.
    if (this.requireRun(this.requireRoom(roomId), runId).selfIntroduction !== undefined) {
      if (!await this.requestMemberSelfIntroduction(roomId, runId, binding)) {
        return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
      }
    }
    const command: Extract<AgentLoopCommand, { type: 'send'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: sendCommandId,
      type: 'send',
      binding,
      content,
    };
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
    }
    await this.mutateRoom(roomId, current => {
      const existing = current.deliveries.find(candidate => candidate.operationId === command.commandId);
      const planned = planRoomDelivery(current, {
        deliveryId: aggregateDeliveryId,
        userItemId,
        participantId: member.participantId,
        operationId: command.commandId,
        memberId: member.memberId,
        runId,
        issuedAt: existing?.issuedAt ?? this.now(),
        operation: {
          kind: 'send',
          acknowledgementKey,
          payload: payloadFor(command),
        },
      });
      return planned.delivery.state === 'planned'
        ? markRoomDeliverySendingUnknown(planned.room, command.commandId)
        : planned.room;
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
    }
    const durablePlan = this.requireRoom(roomId).deliveries
      .find(candidate => candidate.operationId === command.commandId)!;
    const plannedState = durablePlan.state;
    const plannedAttentionCode = durablePlan.attention?.code;
    if (plannedState === 'attention' || plannedState === 'closed') {
      return {
        status: 'unavailable',
        roomId,
        runId,
        bindingCreated,
        code: plannedAttentionCode ?? 'reconciliation-required',
      };
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
    }
    let result: Awaited<ReturnType<BoundAgentLoopClient['send']>>;
    try {
      result = await this.client.send(command);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
      }
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      await this.recordFailure(roomId, command.commandId, result, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
      }
      await this.failMessage(roomId, runId, userItemId, acknowledgementKey, resultCode(result), controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
      }
      return { status: result.status, roomId, runId, bindingCreated, code: resultCode(result) };
    }
    await this.mutateRoom(roomId, current => {
      const existing = current.deliveries.find(candidate => candidate.operationId === command.commandId);
      const accepted = acceptRoomDelivery(current, command.commandId, {
        kind: 'send',
        disposition: result.delivery.disposition,
        firstObservedAt: existing?.acceptance?.firstObservedAt ?? this.now(),
        messageId: result.messageId,
        turn: result.turn,
      });
      return this.updateUserMessage(accepted, runId, userItemId, 'sent', 'running');
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
    }
    const subscriptionFailure = await this.ensureSubscribed(
      this.requireRoom(roomId),
      runId,
      binding,
      controllerGeneration,
    );
    if (subscriptionFailure !== undefined) {
      await this.failMessage(
        roomId,
        runId,
        userItemId,
        acknowledgementKey,
        subscriptionFailure.code,
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated, code: 'controller-replaced' };
      }
      return { ...subscriptionFailure, roomId, runId, bindingCreated };
    }
    return { status: 'accepted', roomId, runId, bindingCreated };
  }

  private async recoverForExplicitMutation(
    roomId: string,
    controllerGeneration: number,
  ): Promise<void> {
    await this.mutateRoom(
      roomId,
      room => this.resetReplayableConversationProjections(room),
      controllerGeneration,
    );
    if (!this.isCurrentGeneration(controllerGeneration)) return;
    const recovered = await this.recoverUnknownDeliveries(roomId, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) return;
    for (const pending of recovered.subscriptions) {
      await this.ensureSubscribed(
        this.requireRoom(pending.roomId),
        pending.runId,
        pending.binding,
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) return;
    }
  }

  private async recoverUnknownDeliveries(
    roomId: string,
    controllerGeneration: number,
  ): Promise<
    Readonly<{
      refreshedRuns: ReadonlySet<string>;
      subscriptions: readonly Readonly<{ roomId: string; runId: string; binding: AgentLoopTaskBinding; }>[];
    }>
  > {
    const refreshedRuns = new Set<string>();
    const subscriptions: Array<Readonly<{ roomId: string; runId: string; binding: AgentLoopTaskBinding; }>> = [];
    const hydrated = hydrateRoomDeliveries(this.requireRoom(roomId), {
      now: this.now(),
      durableApiAvailable: true,
    });
    if (hydrated.room !== this.requireRoom(roomId)) {
      await this.commit(hydrated.room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return Object.freeze({ refreshedRuns, subscriptions: Object.freeze(subscriptions) });
      }
    }
    for (const recovery of hydrated.reconciliations) {
      let room = this.requireRoom(roomId);
      const delivery = room.deliveries.find(candidate => candidate.operationId === recovery.operationId);
      if (delivery === undefined || !['planned', 'sending-unknown'].includes(delivery.state)) continue;
      if (delivery.operation.kind === 'send') {
        room = requireRoomDeliveryAttention(
          room,
          delivery.operationId,
          'reconciliation-required',
          'A send bound to a retired runtime requires provider reconciliation.',
        );
        await this.commit(room, controllerGeneration);
        if (!this.isCurrentGeneration(controllerGeneration)) break;
        continue;
      }
      const binding = await this.replayUnknownCreate(roomId, delivery.operationId, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) break;
      if (binding !== undefined) {
        refreshedRuns.add(delivery.runId);
        subscriptions.push({ roomId, runId: delivery.runId, binding });
      }
    }
    return Object.freeze({ refreshedRuns, subscriptions: Object.freeze(subscriptions) });
  }

  private async replayUnknownCreate(
    roomId: string,
    operationIdValue: string,
    controllerGeneration: number,
  ): Promise<AgentLoopTaskBinding | undefined> {
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    let room = this.requireRoom(roomId);
    const delivery = room.deliveries.find(candidate => candidate.operationId === operationIdValue);
    if (delivery?.operation.kind !== 'create') return undefined;
    const run = this.requireRun(room, delivery.runId);
    const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
    const payload = delivery.operation.payload as Readonly<Record<string, RoomDeliveryPayload>>;
    const targetValue = payload.target as Readonly<Record<string, RoomDeliveryPayload>> | undefined;
    const target = targetValue?.mode === 'create'
      ? { mode: 'create' as const }
      : targetValue?.mode === 'bind' && typeof targetValue.task === 'string'
      ? { mode: 'bind' as const, task: targetValue.task }
      : undefined;
    if (target === undefined) {
      await this.commit(
        requireRoomDeliveryAttention(
          room,
          operationIdValue,
          'reconciliation-required',
          'Durable create target cannot be reconstructed.',
        ),
        controllerGeneration,
      );
      return undefined;
    }
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: operationIdValue,
      type: 'create-or-bind',
      definition: member.definition,
      definitions: agentDefinitionCatalogFor(member.definition, this.configuration.definitions),
      target,
    };
    if (delivery.canonicalPayload !== this.createCanonicalPayload(command)) {
      await this.commit(
        requireRoomDeliveryAttention(
          room,
          operationIdValue,
          'reconciliation-required',
          'The current Agent catalog no longer reproduces the durable command hash.',
        ),
        controllerGeneration,
      );
      return undefined;
    }
    if (delivery.state === 'planned') {
      room = markRoomDeliverySendingUnknown(room, operationIdValue);
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    }
    let result: Awaited<ReturnType<BoundAgentLoopClient['createOrBind']>>;
    try {
      result = await this.client.createOrBind(command);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    if (result.status !== 'accepted') {
      await this.recordFailure(roomId, operationIdValue, result, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      await this.commit(
        failRoomRunPresence(this.requireRoom(roomId), run.runId, {
          code: resultCode(result),
          retryable: result.status === 'unavailable',
        }),
        controllerGeneration,
      );
      return undefined;
    }
    if (target.mode === 'bind' && result.binding.task !== target.task) {
      await this.commit(
        requireRoomDeliveryAttention(
          this.requireRoom(roomId),
          operationIdValue,
          'provider-replaced',
          'Provider returned a different task for the durable bind operation.',
        ),
        controllerGeneration,
      );
      return undefined;
    }
    await this.mutateRoom(roomId, current =>
      acceptRoomDelivery(current, operationIdValue, {
        kind: 'create',
        disposition: result.delivery.disposition,
        firstObservedAt: this.now(),
        binding: result.binding,
        detailsUrl: createStoredRoomRunDetailsUrl(result.detailsUrl),
      }), controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    let activeBinding = result.binding;
    if (target.mode === 'create' && result.delivery.disposition === 'replayed') {
      const rebound = await this.rebindHydratedRun(
        roomId,
        run.runId,
        result.binding,
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration) || rebound === undefined) return undefined;
      activeBinding = rebound;
    }
    if (
      target.mode === 'create'
      && !await this.requestMemberSelfIntroduction(roomId, run.runId, activeBinding)
    ) return undefined;
    return activeBinding;
  }

  private async rebindHydratedRun(
    roomId: string,
    runId: string,
    staleBinding: AgentLoopTaskBinding,
    controllerGeneration: number,
  ): Promise<AgentLoopTaskBinding | undefined> {
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    const member = room.memberships.find(candidate => candidate.memberId === run.memberId)!;
    const existing = run.rebind;
    const sameSource = existing?.source.task === staleBinding.task
      && existing.source.bindingId === staleBinding.binding.bindingId
      && existing.source.generation === staleBinding.binding.generation;
    // A crashed planned/unknown attempt keeps its exact id. Once accepted, the
    // next runtime owns a new logical bind even when the provider happens to
    // return an indistinguishable binding generation.
    const cycle = existing === undefined
      ? 1
      : sameSource && (existing.state === 'planned' || existing.state === 'sending-unknown')
      ? existing.cycle
      : existing.cycle + 1;
    const commandId = bindingOperationId('rebind', roomId, runId, staleBinding, String(cycle));
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId,
      type: 'create-or-bind',
      definition: member.definition,
      definitions: agentDefinitionCatalogFor(member.definition, this.configuration.definitions),
      target: { mode: 'bind', task: staleBinding.task },
    };
    const canonicalPayload = this.createCanonicalPayload(command);
    if (existing?.operationId === commandId && existing.canonicalPayload !== canonicalPayload) {
      room = replaceRoomRun(room, runId, {
        ...run,
        rebind: {
          ...existing,
          state: 'attention',
          attention: {
            code: 'reconciliation-required',
            diagnostic: 'The current Agent catalog no longer reproduces the durable rebind hash.',
          },
        },
      });
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      return undefined;
    }
    if (existing?.operationId !== commandId) {
      room = replaceRoomRun(room, runId, {
        ...run,
        status: 'creating',
        presence: {
          ...run.presence,
          state: 'creating',
          attempt: run.presence.attempt + 1,
          failure: undefined,
        },
        rebind: {
          cycle,
          operationId: commandId,
          issuedAt: this.now(),
          canonicalPayload,
          source: {
            task: staleBinding.task,
            bindingId: staleBinding.binding.bindingId,
            generation: staleBinding.binding.generation,
          },
          state: 'planned',
        },
      });
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    }
    room = this.requireRoom(roomId);
    run = this.requireRun(room, runId);
    if (run.rebind?.state === 'planned') {
      room = replaceRoomRun(room, runId, {
        ...run,
        rebind: { ...run.rebind, state: 'sending-unknown' },
      });
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    }
    let result: Awaited<ReturnType<BoundAgentLoopClient['createOrBind']>>;
    try {
      result = await this.client.createOrBind(command);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    if (result.status !== 'accepted') {
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
      const failureCode = resultCode(result);
      const code = result.status === 'denied' ? 'create-denied' : 'create-unavailable';
      room = failRoomRunPresence(room, runId, {
        code: failureCode,
        retryable: result.status === 'unavailable',
        diagnostic: failureCode,
      });
      run = this.requireRun(room, runId);
      room = replaceRoomRun(room, runId, {
        ...run,
        rebind: {
          ...run.rebind!,
          state: 'attention',
          attention: { code, diagnostic: failureCode },
        },
      });
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      return undefined;
    }
    if (result.binding.task !== staleBinding.task) {
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
      room = failRoomRunPresence(room, runId, {
        code: 'provider-replaced',
        retryable: false,
        diagnostic: 'Provider returned a different task for the durable rebind operation.',
      });
      run = this.requireRun(room, runId);
      room = replaceRoomRun(room, runId, {
        ...run,
        rebind: {
          ...run.rebind!,
          state: 'attention',
          attention: {
            code: 'provider-replaced',
            diagnostic: 'Provider returned a different task for the durable rebind operation.',
          },
        },
      });
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      return undefined;
    }
    room = acceptRoomRunPresence(
      this.requireRoom(roomId),
      runId,
      result.binding,
      createStoredRoomRunDetailsUrl(result.detailsUrl),
    );
    run = this.requireRun(room, runId);
    room = replaceRoomRun(room, runId, {
      ...run,
      rebind: {
        ...run.rebind!,
        state: 'accepted',
        acceptance: { firstObservedAt: this.now(), disposition: result.delivery.disposition },
      },
    });
    await this.commit(room, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
    // A replayed rebind can itself name a binding superseded by a later
    // persisted bind. Advance the durable cycle until this runtime executes a
    // fresh bind instead of returning another historical acceptance.
    if (result.delivery.disposition === 'replayed') {
      return await this.rebindHydratedRun(
        roomId,
        runId,
        result.binding,
        controllerGeneration,
      );
    }
    return result.binding;
  }

  private async createOrReplayBinding(
    roomId: string,
    runId: string,
    currentDeliveryId: string,
    definition: Room['memberships'][number]['definition'],
    controllerGeneration: number,
  ): Promise<CreateBindingOutcome> {
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', code: 'controller-replaced' };
    }
    let room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    const aggregate = room.outbox.find(candidate => candidate.deliveryId === currentDeliveryId)!;
    if (aggregate.create.state === 'not-required') {
      throw new Error('Ready Room delivery unexpectedly requires create/bind.');
    }
    const createOwnerDeliveryId = aggregate.create.ownerDeliveryId;
    const commandId = aggregate.create.operationId;
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind'; }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId,
      type: 'create-or-bind',
      definition,
      definitions: agentDefinitionCatalogFor(definition, this.configuration.definitions),
      target: run.taskBinding === undefined
        ? { mode: 'create' }
        : { mode: 'bind', task: run.taskBinding.task },
    };
    await this.mutateRoom(roomId, current => {
      let next = current;
      let currentDelivery = current.deliveries.find(candidate => candidate.operationId === commandId);
      if (currentDelivery === undefined) {
        if (createOwnerDeliveryId !== currentDeliveryId) {
          throw new Error('Shared create owner command was not durably planned.');
        }
        const planned = planRoomDelivery(current, {
          deliveryId: currentDeliveryId,
          userItemId: aggregate.userItemId,
          participantId: aggregate.participantId,
          operationId: commandId,
          memberId: aggregate.memberId,
          runId,
          issuedAt: this.now(),
          operation: { kind: 'create', payload: payloadFor(command) },
        });
        next = planned.room;
        currentDelivery = planned.delivery;
      } else if (currentDelivery.canonicalPayload !== this.createCanonicalPayload(command)) {
        return requireRoomDeliveryAttention(
          current,
          commandId,
          'reconciliation-required',
          'The current Agent catalog no longer reproduces the durable command hash.',
        );
      }
      return currentDelivery.state === 'planned'
        ? markRoomDeliverySendingUnknown(next, commandId)
        : next;
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', code: 'controller-replaced' };
    }
    room = this.requireRoom(roomId);
    const delivery = room.deliveries.find(candidate => candidate.operationId === commandId)!;
    if (delivery.canonicalPayload !== this.createCanonicalPayload(command)) {
      return { status: 'unavailable', code: 'reconciliation-required' };
    }
    if (delivery.state === 'attention' || delivery.state === 'closed') {
      return {
        status: 'unavailable',
        code: delivery.attention?.code ?? 'reconciliation-required',
      };
    }
    if (delivery.state === 'accepted' && delivery.acceptance?.kind === 'create') {
      if (command.target.mode === 'create') {
        if (!await this.requestMemberSelfIntroduction(roomId, runId, delivery.acceptance.binding)) {
          return { status: 'unavailable', code: 'controller-replaced' };
        }
      }
      return { status: 'accepted', binding: delivery.acceptance.binding };
    }
    let result: Awaited<ReturnType<BoundAgentLoopClient['createOrBind']>>;
    try {
      result = await this.client.createOrBind(command);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      await this.recordFailure(roomId, commandId, result, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
      const failed = failRoomRunPresence(this.requireRoom(roomId), runId, {
        code: resultCode(result),
        retryable: result.status === 'unavailable',
      });
      await this.commit(failed, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
      return { status: result.status, code: resultCode(result) };
    }
    if (command.target.mode === 'bind' && result.binding.task !== command.target.task) {
      room = requireRoomDeliveryAttention(
        this.requireRoom(roomId),
        commandId,
        'provider-replaced',
        'Provider returned a different task for the durable bind operation.',
      );
      await this.commit(room, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
      return { status: 'unavailable', code: 'provider-replaced' };
    }
    await this.mutateRoom(roomId, current =>
      acceptRoomDelivery(current, commandId, {
        kind: 'create',
        disposition: result.delivery.disposition,
        firstObservedAt: this.now(),
        binding: result.binding,
        detailsUrl: createStoredRoomRunDetailsUrl(result.detailsUrl),
      }), controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', code: 'controller-replaced' };
    }
    let activeBinding = result.binding;
    // A replayed create may have crossed a Host runtime replacement. Its
    // durable task identity is still valid, but the returned binding belongs
    // to the retired runtime. Rebind before issuing introduction or send so a
    // fresh Playground session cannot reuse a closed Simulator binding.
    if (command.target.mode === 'create' && result.delivery.disposition === 'replayed') {
      const rebound = await this.rebindHydratedRun(
        roomId,
        runId,
        result.binding,
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
      if (rebound === undefined) {
        const failure = this.requireRun(this.requireRoom(roomId), runId).presence.failure;
        return { status: 'unavailable', code: failure?.code ?? 'task-unavailable' };
      }
      activeBinding = rebound;
    }
    if (command.target.mode === 'create') {
      if (!await this.requestMemberSelfIntroduction(roomId, runId, activeBinding)) {
        return { status: 'unavailable', code: 'controller-replaced' };
      }
    }
    return { status: 'accepted', binding: activeBinding };
  }

  private createCanonicalPayload(
    command: Extract<AgentLoopCommand, { type: 'create-or-bind'; }>,
  ): string {
    return canonicalRoomDeliveryOperation({ kind: 'create', payload: payloadFor(command) });
  }

  private async recordFailure(
    roomId: string,
    operationIdValue: string,
    result: CreateOrSendFailure,
    controllerGeneration?: number,
  ): Promise<void> {
    await this.mutateRoom(roomId, room =>
      result.status === 'denied'
        ? requireRoomDeliveryStageAttention(room, operationIdValue, {
          outcome: 'denied',
          diagnostic: result.authorization.code,
        })
        : result.authorization.state === 'unavailable'
        ? requireRoomDeliveryStageAttention(room, operationIdValue, {
          outcome: 'unavailable',
          diagnostic: result.authorization.code,
        })
        : 'code' in result
        ? requireRoomDeliveryAttention(room, operationIdValue, result.code, result.code)
        : requireRoomDeliveryStageAttention(room, operationIdValue, {
          outcome: 'unavailable',
          diagnostic: result.authorization.code,
        }), controllerGeneration);
  }
}
