import type {
  AgentLoopApprovalDecision,
  AgentLoopApprovalDecisionResult,
  AgentLoopCommand,
  AgentLoopContentPart,
  AgentLoopEventPage,
  AgentLoopResult,
  AgentLoopRequestMemberSelfIntroductionResult,
  AgentLoopSubscribeRuntimeResult,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4';

import { agentDefinitionCatalogFor, type ChatroomAgentConfiguration } from './agent-definition.js';
import { projectAgentLoopEvent } from './agent-loop-projection.js';
import {
  acceptRoomDelivery,
  canonicalRoomDeliveryOperation,
  canonicalRoomPayloadHash,
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
  failRoomAcknowledgement,
  failRoomRunPresence,
  markRoomAcknowledgementSent,
  prepareRoomAcknowledgement,
} from './room-engagement.js';
import {
  acceptMemberSelfIntroduction,
  approvalDecisionOperationId,
  markMemberSelfIntroductionSendingUnknown,
  memberSelfIntroductionCancellationOperationId,
  planApprovalDecision,
  planMemberSelfIntroduction,
  requireMemberSelfIntroductionAttention,
  updateApprovalDecision,
} from './room-agent-operations.js';
import { ChatroomRoomStoreError, DurableChatroomRoomStore } from './room-store.js';
import {
  createRoom,
  replaceRoomRun,
  roomRunOwnsAgentLoopBinding,
  type Room,
  type RoomDeliveryPayload,
  type RoomMemberSelfIntroductionAttentionCode,
  type RoomRun,
} from './room.js';

const COMMAND_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-loop-command.v4.schema.json' as const;
const COMMAND_CONTRACT = 'cordisx.agent-loop-command/v4' as const;

export type ChatroomAgentLoopOutcome =
  | { readonly status: 'accepted'; readonly roomId: string; readonly runId: string; readonly bindingCreated: boolean }
  | { readonly status: 'denied' | 'unavailable'; readonly roomId: string; readonly runId: string; readonly bindingCreated: boolean; readonly code: string };

export type ChatroomApprovalDecisionOutcome =
  | { readonly status: 'accepted'; readonly operationId: string }
  | { readonly status: 'conflict' | 'denied' | 'unavailable'; readonly operationId: string; readonly code: string };

interface ActiveSubscription {
  readonly bindingId: string;
  readonly generation: number;
  unsubscribe(): void;
}

type LocalHydratedRunState =
  | {
    readonly status: 'available';
    readonly source: AgentLoopTaskBinding;
  }
  | {
    readonly status: 'unavailable';
    readonly source: AgentLoopTaskBinding;
    readonly code: string;
  };

type CreateBindingOutcome =
  | { readonly status: 'accepted'; readonly binding: AgentLoopTaskBinding }
  | { readonly status: 'denied' | 'unavailable'; readonly code: string };

type CreateOrSendFailure = Exclude<
  Extract<AgentLoopResult, { type: 'create-or-bind' | 'send' }>,
  { status: 'accepted' }
>;

const stablePart = (value: string) => `${value.length}:${value}`;
const operationId = (
  kind: 'create' | 'send',
  roomId: string,
  runId: string,
  userItemId?: string,
  runtimeGeneration?: string,
) => `chatroom-${kind}-${canonicalRoomPayloadHash({
  roomId,
  runId,
  ...(userItemId === undefined ? {} : { userItemId }),
  ...(runtimeGeneration === undefined ? {} : { runtimeGeneration }),
}).slice('sha256.'.length)}`;
const bindingOperationId = (
  kind: 'bind' | 'rebind',
  roomId: string,
  runId: string,
  binding: AgentLoopTaskBinding,
  logicalAttempt: string,
) => `chatroom-${kind}-${canonicalRoomPayloadHash({
  roomId, runId, task: binding.task, bindingId: binding.binding.bindingId,
  generation: binding.binding.generation, logicalAttempt,
}).slice('sha256.'.length)}`;
const deliveryId = (roomId: string, runId: string, userItemId: string) =>
  `chatroom:delivery:${stablePart(roomId)}${stablePart(runId)}${stablePart(userItemId)}`;

const payloadFor = (command: AgentLoopCommand): RoomDeliveryPayload =>
  command as unknown as RoomDeliveryPayload;

const resultCode = (result: Exclude<AgentLoopResult, { status: 'accepted' }>): string =>
  'code' in result ? result.code : result.authorization.code;
const introductionResultCode = (
  result: Exclude<
    Extract<AgentLoopResult, { type: 'request-member-self-introduction' | 'cancel-member-self-introduction' }>,
    { status: 'accepted' }
  >,
): RoomMemberSelfIntroductionAttentionCode =>
  ('code' in result ? result.code : result.authorization.code);

const sameBinding = (left: AgentLoopTaskBinding, right: AgentLoopTaskBinding) =>
  left.binding.bindingId === right.binding.bindingId
  && left.binding.generation === right.binding.generation
  && left.task === right.task
  && left.definition.agentId === right.definition.agentId
  && left.definition.revision === right.definition.revision;

/**
 * Every side effect is preceded by a document-level Room CAS containing the
 * stable commandId, privacy-safe replay correlation, exact command hash, and
 * consumer observation time. Full commands are rebuilt from the current
 * catalog and may replay only when that hash remains identical.
 */
export class ChatroomAgentLoopController {
  private disposed = false;
  private controllerGeneration = 1;
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly projections = new Set<Promise<void>>();
  private readonly localHydratedRuns = new Map<string, LocalHydratedRunState>();
  private mutationTail: Promise<void> = Promise.resolve();
  private projectionFailure: Readonly<{ generation: number; error: unknown }> | undefined;

  constructor(
    private readonly client: BoundAgentLoopClient,
    readonly configuration: ChatroomAgentConfiguration,
    readonly store: DurableChatroomRoomStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get rooms() { return this.store.rooms; }

  isRunLocallyUnavailable(roomId: string, runId: string): boolean {
    return this.localHydratedRunState(roomId, runId)?.status === 'unavailable';
  }

  async decideApproval(
    roomId: string,
    runId: string,
    turn: string,
    approvalId: string,
    decision: AgentLoopApprovalDecision,
    requestOperationId?: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    this.assertUsable();
    const controllerGeneration = this.controllerGeneration;
    const existingDecision = this.requireRoom(roomId).approvalDecisions.find(candidate =>
      candidate.runId === runId && candidate.turn === turn && candidate.approvalId === approvalId);
    const requestCollision = requestOperationId === undefined ? undefined
      : this.requireRoom(roomId).approvalDecisions.find(candidate =>
        candidate.requestOperationId === requestOperationId);
    if (requestCollision !== undefined && requestCollision !== existingDecision) {
      return {
        status: 'conflict',
        operationId: requestCollision.operationId,
        code: 'operation-conflict',
      };
    }
    if (existingDecision !== undefined && existingDecision.decision !== decision) {
      return {
        status: 'conflict',
        operationId: existingDecision.operationId,
        code: 'approval-conflict',
      };
    }
    if (existingDecision?.requestOperationId !== undefined
      && requestOperationId !== undefined
      && existingDecision.requestOperationId !== requestOperationId) {
      return {
        status: 'conflict',
        operationId: existingDecision.operationId,
        code: 'operation-conflict',
      };
    }
    await this.mutateRoom(roomId, room => planApprovalDecision(room, {
      runId, turn, approvalId, decision,
      ...(requestOperationId === undefined ? {} : { requestOperationId }),
    }), controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return {
        status: 'unavailable', operationId: approvalDecisionOperationId(roomId, runId, turn, approvalId, decision),
        code: 'controller-replaced',
      };
    }
    let room = this.requireRoom(roomId);
    let planned = room.approvalDecisions.find(candidate => candidate.runId === runId
      && candidate.turn === turn && candidate.approvalId === approvalId)!;
    if (planned.state === 'accepted' || planned.state === 'completed') {
      return { status: 'accepted', operationId: planned.operationId };
    }
    if (planned.state === 'attention') {
      return {
        status: 'unavailable', operationId: planned.operationId,
        code: planned.attention?.code ?? 'reconciliation-required',
      };
    }
    if (planned.state === 'planned') {
      await this.mutateRoom(roomId, current => updateApprovalDecision(
        current,
        planned.operationId,
        candidate => ({ ...candidate, state: 'sending-unknown' }),
      ), controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
      }
      room = this.requireRoom(roomId);
      planned = room.approvalDecisions.find(candidate => candidate.operationId === planned.operationId)!;
    }
    const command: Extract<AgentLoopCommand, { type: 'approval-decision' }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: planned.operationId,
      type: 'approval-decision',
      binding: planned.binding,
      turn: planned.turn,
      approvalId: planned.approvalId,
      decision: planned.decision,
    };
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    const result = await this.client.decideApproval(command);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      const code = resultCode(result);
      await this.mutateRoom(roomId, current => updateApprovalDecision(
        current,
        planned.operationId,
        candidate => ({ ...candidate, state: 'attention', attention: { code, diagnostic: code } }),
      ), controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
      }
      return { status: result.status, operationId: planned.operationId, code };
    }
    this.assertApprovalDecisionResult(command, result);
    await this.mutateRoom(roomId, current => updateApprovalDecision(
      current,
      planned.operationId,
      candidate => ({
        ...candidate,
        state: candidate.state === 'completed' ? 'completed' : 'accepted',
        disposition: result.delivery.disposition,
        attention: undefined,
      }),
    ), controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: planned.operationId, code: 'controller-replaced' };
    }
    return { status: 'accepted', operationId: planned.operationId };
  }

  async cancelMemberSelfIntroduction(
    roomId: string,
    runId: string,
  ): Promise<ChatroomApprovalDecisionOutcome> {
    this.assertUsable();
    const controllerGeneration = this.controllerGeneration;
    const initialIntroduction = this.requireRun(this.requireRoom(roomId), runId).selfIntroduction;
    if (initialIntroduction === undefined) throw new Error('Member self-introduction is unavailable.');
    let operationIdValue = initialIntroduction.cancellation?.operationId
      ?? memberSelfIntroductionCancellationOperationId(initialIntroduction.operationId);
    await this.mutateRoom(roomId, room => {
      const run = this.requireRun(room, runId);
      const introduction = run.selfIntroduction;
      if (introduction === undefined) throw new Error('Member self-introduction is unavailable.');
      if (introduction.cancellation !== undefined) return room;
      return replaceRoomRun(room, runId, {
        ...run,
        selfIntroduction: {
          ...introduction,
          cancellation: { operationId: operationIdValue, state: 'planned' },
        },
      });
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    let introduction = run.selfIntroduction!;
    if (introduction.cancellation?.state === 'accepted') {
      return { status: 'accepted', operationId: operationIdValue };
    }
    if (introduction.cancellation?.state === 'attention') {
      return {
        status: 'unavailable', operationId: operationIdValue,
        code: introduction.cancellation.attention?.code ?? 'reconciliation-required',
      };
    }
    if (introduction.cancellation?.state === 'planned') {
      await this.mutateRoom(roomId, current => {
        const currentRun = this.requireRun(current, runId);
        return replaceRoomRun(current, runId, {
          ...currentRun,
          selfIntroduction: {
            ...currentRun.selfIntroduction!,
            cancellation: { ...currentRun.selfIntroduction!.cancellation!, state: 'sending-unknown' },
          },
        });
      }, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
      }
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
      introduction = run.selfIntroduction!;
    }
    const command: Extract<AgentLoopCommand, { type: 'cancel-member-self-introduction' }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: operationIdValue,
      type: 'cancel-member-self-introduction',
      binding: introduction.binding,
      participantId: introduction.participantId,
      memberId: introduction.memberId,
      runId: introduction.runId,
      requestOperationId: introduction.operationId,
    };
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    const result = await this.client.cancelMemberSelfIntroduction(command);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    if (result.status !== 'accepted') {
      const code = introductionResultCode(result);
      await this.mutateRoom(roomId, current => {
        const currentRun = this.requireRun(current, runId);
        return replaceRoomRun(current, runId, {
          ...currentRun,
          selfIntroduction: {
            ...currentRun.selfIntroduction!,
            cancellation: {
              ...currentRun.selfIntroduction!.cancellation!,
              state: 'attention',
              attention: { code, diagnostic: code },
            },
          },
        });
      }, controllerGeneration);
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
      }
      return { status: result.status, operationId: operationIdValue, code };
    }
    if (result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.requestOperationId !== command.requestOperationId
      || result.participantId !== command.participantId
      || result.memberId !== command.memberId
      || result.runId !== command.runId
      || (introduction.acceptance !== undefined
        && (result.turn !== introduction.acceptance.turn
          || result.messageId !== introduction.acceptance.messageId))
      || !sameBinding(result.binding, command.binding)) {
      throw new Error('Accepted introduction cancellation did not match its exact command.');
    }
    await this.mutateRoom(roomId, current => {
      const currentRun = this.requireRun(current, runId);
      return replaceRoomRun(current, runId, {
        ...currentRun,
        selfIntroduction: {
          ...currentRun.selfIntroduction!,
          state: 'cancelled',
          cancellation: {
            ...currentRun.selfIntroduction!.cancellation!,
            state: 'accepted',
            disposition: result.delivery.disposition,
            attention: undefined,
          },
        },
      });
    }, controllerGeneration);
    if (!this.isCurrentGeneration(controllerGeneration)) {
      return { status: 'unavailable', operationId: operationIdValue, code: 'controller-replaced' };
    }
    return { status: 'accepted', operationId: operationIdValue };
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
    const operation = previous.catch(() => {}).then(() => this.sendToRunNow(
      roomId, runId, userItemId, content, runtimeGeneration, controllerGeneration, sendOperationId,
    ));
    const settled = operation.then(() => {}, () => {});
    this.operations.set(operationKey, settled);
    return operation.finally(() => {
      if (this.operations.get(operationKey) === settled) this.operations.delete(operationKey);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controllerGeneration += 1;
    this.projectionFailure = undefined;
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.localHydratedRuns.clear();
    this.client.dispose();
  }

  async waitForProjectionDrain(): Promise<void> {
    const settled = await Promise.allSettled([...this.projections]);
    const latched = this.projectionFailure?.generation === this.controllerGeneration
      ? this.projectionFailure
      : undefined;
    this.projectionFailure = undefined;
    const observed = settled.find(result => result.status === 'rejected');
    if (latched !== undefined) throw latched.error;
    if (observed?.status === 'rejected') throw observed.reason;
  }

  /** Probes hydrated bindings without claiming durable mutation authority. */
  async hydrate(): Promise<void> {
    this.assertUsable();
    const controllerGeneration = this.controllerGeneration;
    const staleActiveRuns = this.rooms.snapshot().flatMap(room => room.runs.flatMap(run =>
      run.taskBinding?.state === 'active'
        && (run.presence.state === 'joined' || run.presence.state === 'ready')
        ? [{ roomId: room.id, runId: run.runId, binding: run.taskBinding }]
        : []));
    for (const stale of staleActiveRuns) {
      const current = this.rooms.get(stale.roomId)?.runs.find(run => run.runId === stale.runId);
      if (current?.taskBinding?.binding.bindingId !== stale.binding.binding.bindingId
        || current.taskBinding.binding.generation !== stale.binding.binding.generation) continue;
      await this.probeHydratedRun(
        stale.roomId, stale.runId, stale.binding, controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) return;
    }
  }

  private async probeHydratedRun(
    roomId: string,
    runId: string,
    source: AgentLoopTaskBinding,
    controllerGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(controllerGeneration)) return;
    const room = this.requireRoom(roomId);
    const run = this.requireRun(room, runId);
    let result: Awaited<ReturnType<BoundAgentLoopClient['subscribe']>>;
    try {
      result = await this.client.subscribe(source, run.agentLoopCursor);
    } catch {
      if (this.isCurrentGeneration(controllerGeneration)) {
        this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
          status: 'unavailable', source, code: 'task-unavailable',
        });
      }
      return;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      if (result.status === 'accepted') {
        try { result.handle.unsubscribe(); } catch { /* retired probe */ }
      }
      return;
    }
    if (result.status !== 'accepted') {
      this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
        status: 'unavailable', source, code: result.authorization.code,
      });
      return;
    }
    try { result.handle.unsubscribe(); } catch { /* a probe never owns the runtime stream */ }
    this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
      status: 'available',
      source,
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
        userItemId, memberId: member.memberId, runId,
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
    if (run.presence.state !== 'ready'
      || binding?.state !== 'active' || run.detailsUrl === undefined) {
      const created = await this.createOrReplayBinding(
        roomId, runId, aggregateDeliveryId, member.definition, controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) {
        return { status: 'unavailable', roomId, runId, bindingCreated: false, code: 'controller-replaced' };
      }
      if (created.status !== 'accepted') {
        await this.failMessage(
          roomId, runId, userItemId, acknowledgementKey, created.code, controllerGeneration,
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
    const command: Extract<AgentLoopCommand, { type: 'send' }> = {
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
        status: 'unavailable', roomId, runId, bindingCreated,
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
      await this.failMessage(roomId, runId, userItemId, acknowledgementKey,
        resultCode(result), controllerGeneration);
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
      this.requireRoom(roomId), runId, binding, controllerGeneration,
    );
    if (subscriptionFailure !== undefined) {
      await this.failMessage(roomId, runId, userItemId, acknowledgementKey,
        subscriptionFailure.code, controllerGeneration);
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
        this.requireRoom(pending.roomId), pending.runId, pending.binding, controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) return;
    }
  }

  private async recoverUnknownDeliveries(
    roomId: string,
    controllerGeneration: number,
  ): Promise<Readonly<{
    refreshedRuns: ReadonlySet<string>;
    subscriptions: readonly Readonly<{ roomId: string; runId: string; binding: AgentLoopTaskBinding }>[];
  }>> {
    const refreshedRuns = new Set<string>();
    const subscriptions: Array<Readonly<{ roomId: string; runId: string; binding: AgentLoopTaskBinding }>> = [];
    const hydrated = hydrateRoomDeliveries(this.requireRoom(roomId), {
      now: this.now(), durableApiAvailable: true,
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
      await this.commit(requireRoomDeliveryAttention(
        room, operationIdValue, 'reconciliation-required', 'Durable create target cannot be reconstructed.',
      ), controllerGeneration);
      return undefined;
    }
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind' }> = {
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
      await this.commit(requireRoomDeliveryAttention(
        room,
        operationIdValue,
        'reconciliation-required',
        'The current Agent catalog no longer reproduces the durable command hash.',
      ), controllerGeneration);
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
      await this.commit(failRoomRunPresence(this.requireRoom(roomId), run.runId, {
        code: resultCode(result), retryable: result.status === 'unavailable',
      }), controllerGeneration);
      return undefined;
    }
    if (target.mode === 'bind' && result.binding.task !== target.task) {
      await this.commit(requireRoomDeliveryAttention(
        this.requireRoom(roomId),
        operationIdValue,
        'provider-replaced',
        'Provider returned a different task for the durable bind operation.',
      ), controllerGeneration);
      return undefined;
    }
    await this.mutateRoom(roomId, current => acceptRoomDelivery(current, operationIdValue, {
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
        roomId, run.runId, result.binding, controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration) || rebound === undefined) return undefined;
      activeBinding = rebound;
    }
    if (target.mode === 'create'
      && !await this.requestMemberSelfIntroduction(roomId, run.runId, activeBinding)) return undefined;
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
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind' }> = {
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
        roomId, runId, result.binding, controllerGeneration,
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
    const command: Extract<AgentLoopCommand, { type: 'create-or-bind' }> = {
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
        code: resultCode(result), retryable: result.status === 'unavailable',
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
    await this.mutateRoom(roomId, current => acceptRoomDelivery(current, commandId, {
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
        roomId, runId, result.binding, controllerGeneration,
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

  private async requestMemberSelfIntroduction(
    roomId: string,
    runId: string,
    binding: AgentLoopTaskBinding,
  ): Promise<boolean> {
    const controllerGeneration = this.controllerGeneration;
    if (!this.isCurrentGeneration(controllerGeneration)) return false;
    await this.mutateRoom(
      roomId,
      room => planMemberSelfIntroduction(room, runId),
      controllerGeneration,
    );
    if (!this.isCurrentGeneration(controllerGeneration)) return false;
    let room = this.requireRoom(roomId);
    let run = this.requireRun(room, runId);
    let introduction = run.selfIntroduction!;
    if (introduction.state === 'accepted' || introduction.state === 'completed'
      || introduction.state === 'cancelled' || introduction.state === 'attention') return true;
    if (!sameBinding(introduction.binding, binding)) {
      await this.mutateRoom(roomId, current => requireMemberSelfIntroductionAttention(
        current,
        runId,
        'binding-conflict',
        'The introduction request belongs to a retired binding generation.',
      ), controllerGeneration);
      return this.isCurrentGeneration(controllerGeneration);
    }
    if (introduction.state === 'planned') {
      await this.mutateRoom(
        roomId,
        current => markMemberSelfIntroductionSendingUnknown(current, runId),
        controllerGeneration,
      );
      if (!this.isCurrentGeneration(controllerGeneration)) return false;
      room = this.requireRoom(roomId);
      run = this.requireRun(room, runId);
      introduction = run.selfIntroduction!;
    }
    const command: Extract<AgentLoopCommand, { type: 'request-member-self-introduction' }> = {
      $schema: COMMAND_SCHEMA,
      contract: COMMAND_CONTRACT,
      schemaVersion: 4,
      commandId: introduction.operationId,
      type: 'request-member-self-introduction',
      binding: introduction.binding,
      participantId: introduction.participantId,
      memberId: introduction.memberId,
      runId: introduction.runId,
      intent: {
        kind: 'member-self-introduction',
        audience: 'room',
        output: 'assistant-message',
      },
    };
    if (!this.isCurrentGeneration(controllerGeneration)) return false;
    const result = await this.client.requestMemberSelfIntroduction(command);
    if (!this.isCurrentGeneration(controllerGeneration)) return false;
    if (result.status !== 'accepted') {
      const code = introductionResultCode(result);
      await this.mutateRoom(roomId, current => requireMemberSelfIntroductionAttention(
        current, runId, code, code,
      ), controllerGeneration);
      return this.isCurrentGeneration(controllerGeneration);
    }
    this.assertMemberSelfIntroductionResult(command, result);
    await this.mutateRoom(roomId, current => acceptMemberSelfIntroduction(current, runId, {
      operationId: result.causation.operationId,
      binding: result.binding,
      participantId: result.participantId,
      memberId: result.memberId,
      turn: result.turn,
      messageId: result.messageId,
      disposition: result.delivery.disposition,
    }), controllerGeneration);
    return this.isCurrentGeneration(controllerGeneration);
  }

  private assertMemberSelfIntroductionResult(
    command: Extract<AgentLoopCommand, { type: 'request-member-self-introduction' }>,
    result: Extract<AgentLoopRequestMemberSelfIntroductionResult, { status: 'accepted' }>,
  ): void {
    if (result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.participantId !== command.participantId
      || result.memberId !== command.memberId
      || result.runId !== command.runId
      || !sameBinding(result.binding, command.binding)) {
      throw new Error('Accepted member self-introduction did not match its exact command.');
    }
  }

  private assertApprovalDecisionResult(
    command: Extract<AgentLoopCommand, { type: 'approval-decision' }>,
    result: Extract<AgentLoopApprovalDecisionResult, { status: 'accepted' }>,
  ): void {
    if (result.commandId !== command.commandId
      || result.causation.operationId !== command.commandId
      || result.turn !== command.turn
      || result.approvalId !== command.approvalId
      || result.decision !== command.decision
      || !sameBinding(result.binding, command.binding)) {
      throw new Error('Accepted approval decision did not match its exact command.');
    }
  }

  private createCanonicalPayload(
    command: Extract<AgentLoopCommand, { type: 'create-or-bind' }>,
  ): string {
    return canonicalRoomDeliveryOperation({ kind: 'create', payload: payloadFor(command) });
  }

  private async recordFailure(
    roomId: string,
    operationIdValue: string,
    result: CreateOrSendFailure,
    controllerGeneration?: number,
  ): Promise<void> {
    await this.mutateRoom(roomId, room => result.status === 'denied'
      ? requireRoomDeliveryStageAttention(room, operationIdValue, {
        outcome: 'denied', diagnostic: result.authorization.code,
      })
      : result.authorization.state === 'unavailable'
        ? requireRoomDeliveryStageAttention(room, operationIdValue, {
          outcome: 'unavailable', diagnostic: result.authorization.code,
        })
        : 'code' in result
          ? requireRoomDeliveryAttention(room, operationIdValue, result.code, result.code)
          : requireRoomDeliveryStageAttention(room, operationIdValue, {
            outcome: 'unavailable', diagnostic: result.authorization.code,
          }), controllerGeneration);
  }

  private async ensureSubscribed(
    room: Room,
    runId: string,
    binding: AgentLoopTaskBinding,
    expectedControllerGeneration = this.controllerGeneration,
  ): Promise<{ readonly status: 'denied' | 'unavailable'; readonly code: string } | undefined> {
    const controllerGeneration = expectedControllerGeneration;
    const subscriptionKey = `${stablePart(room.id)}${stablePart(runId)}`;
    const existing = this.subscriptions.get(subscriptionKey);
    if (existing !== undefined
      && existing.bindingId === binding.binding.bindingId
      && existing.generation === binding.binding.generation) return undefined;
    existing?.unsubscribe();
    const run = this.requireRun(room, runId);
    let result: AgentLoopSubscribeRuntimeResult;
    try {
      result = await this.client.subscribe(binding, run.agentLoopCursor);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      if (result.status === 'accepted') {
        try { result.handle.unsubscribe(); } catch { /* retired handles cannot affect the replacement source */ }
      }
      return undefined;
    }
    if (result.status !== 'accepted') return { status: result.status, code: result.authorization.code };
    const active: ActiveSubscription = {
      bindingId: binding.binding.bindingId,
      generation: binding.binding.generation,
      unsubscribe: () => result.handle.unsubscribe(),
    };
    this.subscriptions.set(subscriptionKey, active);
    const consumption = this.consume(
      room.id,
      runId,
      binding,
      result.handle.pages,
      controllerGeneration,
    );
    void consumption.catch(error => {
      if (this.isCurrentGeneration(controllerGeneration) && this.projectionFailure === undefined) {
        this.projectionFailure = Object.freeze({ generation: controllerGeneration, error });
      }
    });
    let projection: Promise<void>;
    projection = consumption.finally(() => {
      this.projections.delete(projection);
      if (this.subscriptions.get(subscriptionKey) === active) this.subscriptions.delete(subscriptionKey);
    });
    this.projections.add(projection);
    // Keep a rejection observable through waitForProjectionDrain() without
    // allowing an unobserved background projection to become a process-level
    // unhandled rejection.
    void projection.catch(() => {});
    return undefined;
  }

  private async consume(
    roomId: string,
    runId: string,
    binding: AgentLoopTaskBinding,
    pages: AsyncIterable<AgentLoopEventPage>,
    controllerGeneration: number,
  ): Promise<void> {
    const iterator = pages[Symbol.asyncIterator]();
    try {
      while (this.isCurrentGeneration(controllerGeneration)) {
        let next: IteratorResult<AgentLoopEventPage>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (!this.isCurrentGeneration(controllerGeneration)) return;
          await this.mutateRoom(roomId, room => this.failPendingRunMessages(
            room, runId, binding, 'event-stream-failed',
          ), controllerGeneration);
          return;
        }
        if (!this.isCurrentGeneration(controllerGeneration)) return;
        if (next.done) {
          await this.mutateRoom(roomId, room => this.failPendingRunMessages(
            room, runId, binding, 'event-stream-ended',
          ), controllerGeneration);
          return;
        }
        const page = next.value;
        for (const event of page.events) {
          if (!this.isCurrentGeneration(controllerGeneration)) return;
          let ownsBinding: boolean;
          try {
            ownsBinding = await this.mutateRoom(roomId, room => {
              if (!roomRunOwnsAgentLoopBinding(room, runId, binding.binding)) return undefined;
              const projected = projectAgentLoopEvent(room, runId, event);
              return projected.accepted ? projected.room : room;
            }, controllerGeneration);
          } catch {
            if (!this.isCurrentGeneration(controllerGeneration)) return;
            await this.mutateRoom(roomId, room => this.failPendingRunMessages(
              room, runId, binding, 'event-projection-failed',
            ), controllerGeneration);
            return;
          }
          if (!ownsBinding) return;
        }
      }
    } finally {
      if (iterator.return !== undefined) {
        try {
          await iterator.return();
        } catch (error) {
          if (this.isCurrentGeneration(controllerGeneration)) throw error;
        }
      }
    }
  }

  private failPendingRunMessages(
    room: Room,
    runId: string,
    binding: AgentLoopTaskBinding,
    code: string,
  ): Room {
    if (!roomRunOwnsAgentLoopBinding(room, runId, binding.binding)) return room;
    let next = room;
    let failedPending = false;
    for (const acknowledgement of room.acknowledgements) {
      if (acknowledgement.runId !== runId || acknowledgement.state !== 'pending') continue;
      failedPending = true;
      next = failRoomAcknowledgement(next, acknowledgement.acknowledgementKey, code);
      next = this.updateUserMessage(next, runId, acknowledgement.userItemId, 'sent', 'failed');
    }
    return failedPending
      ? failRoomRunPresence(next, runId, { code, retryable: true })
      : next;
  }

  private resetReplayableConversationProjections(room: Room): Room {
    const itemsById = new Map(room.items.map(item => [item.itemId, item]));
    const replayableItemIds = new Set<string>();
    for (const run of room.runs) {
      const hasPendingAcknowledgement = room.acknowledgements.some(candidate =>
        candidate.runId === run.runId && candidate.state === 'pending');
      const hasAcceptedSend = room.deliveries.some(candidate => candidate.runId === run.runId
        && candidate.stage === 'send' && candidate.state === 'accepted'
        && candidate.acceptance?.kind === 'send');
      if (!hasPendingAcknowledgement && hasAcceptedSend) continue;
      for (const projection of run.publicProjections) {
        const item = itemsById.get(projection.itemId);
        if (item?.kind === 'message' && item.source === 'agent-loop'
          && item.semantic.purpose === 'conversation') replayableItemIds.add(item.itemId);
      }
    }
    if (replayableItemIds.size === 0) return room;
    return createRoom({
      ...room,
      runs: room.runs.map(run => ({
        ...run,
        publicProjections: run.publicProjections.filter(candidate =>
          !replayableItemIds.has(candidate.itemId)),
      })),
      items: room.items.filter(item => !replayableItemIds.has(item.itemId)),
      imageReferences: room.imageReferences.filter(reference =>
        !replayableItemIds.has(reference.itemId)),
    });
  }

  private async failMessage(
    roomId: string,
    runId: string,
    userItemId: string,
    acknowledgementKey: string,
    code: string,
    controllerGeneration?: number,
  ): Promise<void> {
    await this.mutateRoom(roomId, current => {
      const room = failRoomAcknowledgement(current, acknowledgementKey, code);
      return this.updateUserMessage(room, runId, userItemId, 'failed', 'failed');
    }, controllerGeneration);
  }

  private updateUserMessage(
    room: Room,
    runId: string,
    userItemId: string,
    deliveryState: 'sent' | 'failed',
    runState: 'running' | 'failed',
  ): Room {
    const run = this.requireRun(room, runId);
    return createRoom({
      ...room,
      items: room.items.map(item => item.kind === 'message' && item.itemId === userItemId
        ? { ...item, deliveryState, runState }
        : item),
      runs: room.runs.map(candidate => candidate.runId === runId ? { ...run, status: runState } : candidate),
    });
  }

  private async commit(room: Room, controllerGeneration?: number): Promise<boolean> {
    const base = this.store.document(room.id);
    const fence = Object.freeze({
      revision: base?.revision,
      roomSnapshot: base === undefined ? undefined : JSON.stringify(base.room),
    });
    return await this.enqueueMutation(async () => await this.persistRoom(room, controllerGeneration, fence));
  }

  private async mutateRoom(
    roomId: string,
    mutation: (room: Room) => Room | undefined,
    controllerGeneration?: number,
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
      const current = this.rooms.get(roomId);
      if (current === undefined) return false;
      const room = mutation(current);
      if (room === undefined) return false;
      if (room === current) return true;
      return await this.persistRoom(room, controllerGeneration);
    });
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.catch(() => {}).then(mutation);
    this.mutationTail = pending.then(() => {}, () => {});
    return pending;
  }

  private async persistRoom(
    room: Room,
    controllerGeneration?: number,
    fence?: Readonly<{ revision: number | undefined; roomSnapshot: string | undefined }>,
  ): Promise<boolean> {
    if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
    const current = this.store.document(room.id);
    if (fence !== undefined && (current === undefined) !== (fence.roomSnapshot === undefined)) {
      throw new ChatroomRoomStoreError('conflict', 'Room existence changed concurrently.', true);
    }
    if (fence?.roomSnapshot !== undefined && current !== undefined && current.revision !== fence.revision
      && JSON.stringify(current.room) !== fence.roomSnapshot) {
      throw new ChatroomRoomStoreError(
        'conflict',
        `Room changed concurrently after revision ${fence.revision}.`,
        true,
      );
    }
    const expectedRevision = current?.revision;
    let committed;
    try {
      if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
      committed = await this.store.compareAndSwap(expectedRevision, room);
    } catch (error) {
      if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
      throw error;
    }
    if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
    if (committed === undefined) throw new Error('Room document changed concurrently before AgentLoop effect.');
    return true;
  }

  private localRunKey(roomId: string, runId: string): string {
    return `${stablePart(roomId)}${stablePart(runId)}`;
  }

  private localHydratedRunState(
    roomId: string,
    runId: string,
    room: Room | undefined = this.rooms.get(roomId),
  ): LocalHydratedRunState | undefined {
    const key = this.localRunKey(roomId, runId);
    const state = this.localHydratedRuns.get(key);
    const run = room?.runs.find(candidate => candidate.runId === runId);
    if (state === undefined) return undefined;
    if (run?.taskBinding === undefined
      || !sameBinding(run.taskBinding, state.source)
      || (run.presence.state !== 'joined' && run.presence.state !== 'ready')) {
      this.localHydratedRuns.delete(key);
      return undefined;
    }
    return state;
  }

  private requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Room is unavailable.');
    return room;
  }

  private requireRun(room: Room, runId: string): RoomRun {
    const run = room.runs.find(candidate => candidate.runId === runId);
    if (run === undefined) throw new Error('Room run is unavailable.');
    return run;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom AgentLoop controller is disposed.');
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.controllerGeneration === generation;
  }
}
