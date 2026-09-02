import type {
  AgentConversationShellBinding,
  AgentConversationShellCommandContext,
  AgentConversationItem,
  AgentConversationShellPage,
  AgentConversationRoomSettingsUpdateRequest,
  AgentConversationRoomSettingsUpdateResult,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellSubscription,
  AgentConversationShellUpdate,
} from '@cordisx/protocol/agent-conversation-shell/v3';

import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
  CHATROOM_COMMAND_SUBMIT,
  createConversationSnapshot,
  createNoRoomConversationModel,
  createRoomConversationModel,
  projectRoomParticipant,
  type ChatroomConversationModel,
} from './conversation-model.js';
import {
  CHATROOM_DEFAULT_AGENT_CONFIGURATION,
  type ChatroomAgentConfiguration,
} from './agent-definition.js';
import {
  CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS,
  ChatroomRoomRegistry,
  addRoomRun,
  createRoom,
  createChatroomOpaqueId,
  expandRoomMemberships,
  roomRunPublicProjectionForItem,
  type Room,
} from './room.js';
import {
  resolveExplicitRoomAgentDispatch,
  resolveRoomMessageDispatch,
  type RoomDispatchRecipient,
} from './room-target.js';
import { approvalDecisionOperationId } from './room-agent-operations.js';
import { failRoomRunPresence } from './room-engagement.js';
import { replaceRoomProfile } from './room-profile.js';

type ChatroomRoomSettingsUpdater = (
  request: AgentConversationRoomSettingsUpdateRequest,
) => Promise<'applied' | 'room-conflict'>;

export interface ChatroomCommandDelivery {
  readonly memberId: string;
  readonly runId: string;
  readonly runCreated: boolean;
  readonly reason: RoomDispatchRecipient['reason'];
}

export type ChatroomCommandIntent =
  { readonly kind: 'send-message'; readonly roomId: string; readonly roomCreated: boolean; readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]]; readonly userItemId: string; readonly bindingId: string; readonly generation: string; readonly dispatchText: string }
  | { readonly kind: 'approval-decision'; readonly roomId: string; readonly runId: string; readonly turn: string; readonly approvalId: string; readonly decision: 'approved' | 'denied' | 'cancelled' }
  | { readonly kind: 'playground-approval-decision'; readonly roomId: string; readonly itemId: string; readonly operationId: string; readonly decision: 'approved' | 'denied' | 'cancelled' }
  | { readonly kind: 'target-error'; readonly roomId?: string; readonly code: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message'; readonly mention?: string };

export interface ChatroomPlaygroundSourceCorrelation {
  readonly roomId: string;
  readonly runId: string;
  readonly memberId: string;
  readonly bindingId: string;
  readonly ownerGeneration: string;
  readonly generation: string;
}

export type ChatroomPlaygroundSourceInspection =
  | {
    readonly status: 'available';
    readonly room: Room;
    readonly run: Room['runs'][number];
    readonly member: Room['memberships'][number];
  }
  | {
    readonly status: 'unavailable';
    readonly code: 'missing' | 'deleted' | 'archived' | 'retired' | 'stale-binding' | 'generation-invalid' | 'correlation-invalid';
  };

export type ChatroomPlaygroundMessagePlan =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly userItemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly replayed: boolean;
  }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict' };

export interface ChatroomPlaygroundAgentReplyCorrelation {
  readonly turnId?: string;
  readonly messageId?: string;
  readonly inReplyToMessageId?: string;
}

export type ChatroomPlaygroundAgentReplyProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly participantId: string;
    readonly itemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly timestamp: string;
    readonly replayed: boolean;
    readonly recipients?: readonly {
      readonly targetMemberId: string;
      readonly targetRunId: string;
      readonly content: string;
      readonly runCreated: boolean;
    }[];
    readonly turnId?: string;
    readonly sourceMessageId?: string;
    readonly inReplyToMessageId?: string;
  }
  | {
    readonly status: 'target-error';
    readonly code: 'missing' | 'ambiguous' | 'empty-targeted-message' | 'self-target';
    readonly mention: string;
  }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict' };

export interface ChatroomPlaygroundDelegationContext {
  readonly source: { readonly memberId: string; readonly label: string; readonly runId: string };
  readonly target: { readonly memberId: string; readonly label: string; readonly runId: string };
  readonly reportsTo?: { readonly memberId: string; readonly label: string };
  readonly availableTargets: readonly { readonly memberId: string; readonly label: string }[];
  readonly communicationMode: 'explicit-mention-required';
  readonly approvalMode: 'reports-to-hierarchy';
}

export type ChatroomPlaygroundAgentDelegationProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly sourceRunId: string;
    readonly sourceMemberId: string;
    readonly sourceParticipantId: string;
    readonly targetRunId: string;
    readonly targetMemberId: string;
    readonly targetParticipantId: string;
    readonly itemId: string;
    readonly messageId: string;
    readonly text: string;
    readonly context: ChatroomPlaygroundDelegationContext;
    readonly timestamp: string;
    readonly replayed: boolean;
  }
  | { readonly status: 'missing-target' }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict' };

export type ChatroomPlaygroundAgentApprovalProjection =
  | {
    readonly status: 'accepted';
    readonly roomId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly participantId: string;
    readonly itemId: string;
    readonly turnId: string;
    readonly approvalId: string;
    readonly reason: string;
    readonly state: 'pending' | 'approved' | 'denied' | 'cancelled';
    readonly timestamp: string;
    readonly replayed: boolean;
    readonly decisionOperationId?: string;
  }
  | { readonly status: 'missing' }
  | { readonly status: 'conflict'; readonly code: 'operation-conflict' | 'approval-conflict' | 'decision-capacity' };

const sourceKey = (binding: Readonly<AgentConversationShellBinding>, generation: string) =>
  `${binding.bindingId}:${binding.ownerGeneration}:${generation}`;

const roomUsesOperationId = (room: Room, operationId: string): boolean =>
  room.items.some(item => item.kind === 'message'
    && item.semantic.purpose === 'conversation'
    && item.semantic.causation?.operationId === operationId)
  || room.deliveries.some(delivery => delivery.operationId === operationId)
  || room.outbox.some(delivery => delivery.send.operationId === operationId
    || (delivery.create.state !== 'not-required' && delivery.create.operationId === operationId))
  || room.approvalDecisions.some(decision => decision.operationId === operationId
    || decision.requestOperationId === operationId)
  || room.runs.some(run => run.rebind?.operationId === operationId
    || run.selfIntroduction?.operationId === operationId
    || run.selfIntroduction?.cancellation?.operationId === operationId)
  || (room.playgroundAgentEgresses ?? []).some(egress => egress.operationId === operationId)
  || (room.playgroundAgentApprovals ?? []).some(approval => approval.operationId === operationId
    || approval.decisionAttempts.some(attempt => attempt.operationId === operationId));

// A snapshot can contain up to 500 ordered items. Reserving that bounded
// window lets a no-room source later replace itself with a complete Room
// snapshot without crossing the Host's monotonic update fence.
const INITIAL_SNAPSHOT_SEQUENCE = 500;

function bindingOf(binding: Readonly<AgentConversationShellBinding>) {
  return { bindingId: binding.bindingId, ownerGeneration: binding.ownerGeneration };
}

class ChatroomSubscriptionStream {
  private cursor: number;
  private terminal = false;
  private readonly updates: AgentConversationShellUpdate[] = [];
  private resolveNext: (() => void) | undefined;

  constructor(
    private readonly subscription: AgentConversationShellSubscription,
    private readonly snapshot: AgentConversationShellSnapshot,
    afterSequence: number,
    private readonly onTerminal: () => void,
  ) {
    this.cursor = afterSequence;
  }

  readonly pages: AsyncIterable<AgentConversationShellPage> = {
    [Symbol.asyncIterator]: () => this.iterate(),
  };

  unsubscribe(): void {
    this.close('explicit');
  }

  close(reason: 'explicit' | 'owner-disposed' | 'generation-replaced'): void {
    if (this.terminal) return;
    this.terminal = true;
    const pendingSequence = this.updates.at(-1)?.sequence ?? this.cursor;
    this.enqueue({ kind: 'disposed', sequence: pendingSequence + 1, reason });
    this.onTerminal();
  }

  replace(snapshot: AgentConversationShellSnapshot): void {
    if (this.terminal) return;
    this.enqueue({ kind: 'snapshot-replaced', sequence: snapshot.snapshotSequence, snapshot });
  }

  publish(update: Extract<AgentConversationShellUpdate, { kind: 'item-appended' | 'item-updated' }>): void {
    if (this.terminal) return;
    this.enqueue(update);
  }

  private enqueue(update: AgentConversationShellUpdate): void {
    this.updates.push(update);
    this.resolveNext?.();
    this.resolveNext = undefined;
  }

  private async *iterate(): AsyncGenerator<AgentConversationShellPage> {
    if (this.cursor < this.subscription.snapshotSequence) {
      const page: AgentConversationShellPage = {
        subscription: this.subscription,
        afterSequence: this.cursor,
        phase: 'replay',
        updates: [{ kind: 'snapshot-replaced', sequence: this.snapshot.snapshotSequence, snapshot: this.snapshot }],
        nextAfterSequence: this.snapshot.snapshotSequence,
        hasMore: false,
      };
      this.cursor = page.nextAfterSequence;
      yield page;
    }
    while (true) {
      if (this.updates.length === 0) {
        await new Promise<void>(resolve => { this.resolveNext = resolve; });
      }
      const update = this.updates.shift();
      if (update === undefined) continue;
      const page: AgentConversationShellPage = {
        subscription: this.subscription,
        afterSequence: this.cursor,
        phase: 'live',
        updates: [update],
        nextAfterSequence: update.sequence,
        hasMore: false,
      };
      this.cursor = update.sequence;
      yield page;
      if (update.kind === 'disposed') return;
    }
  }
}

/**
 * Data-only formal source. It never projects Connector handles or owns a
 * renderer; Host supplies bindings, chrome, draft lifetime, and all DOM.
 */
export class ChatroomConversationSource implements AgentConversationShellSource {
  private readonly streams = new Set<ChatroomSubscriptionStream>();
  private readonly roomSettingsRequests = new Map<string, {
    readonly canonical: string;
    readonly result: AgentConversationRoomSettingsUpdateResult;
  }>();
  private disposed = false;
  private subscriptionCount = 0;
  private snapshotValue: AgentConversationShellSnapshot;

  constructor(
    private readonly binding: Readonly<AgentConversationShellBinding>,
    model: ChatroomConversationModel = createNoRoomConversationModel(),
    private readonly onDispose: () => void = () => {},
    private readonly updateRoomProfile?: ChatroomRoomSettingsUpdater,
  ) {
    this.snapshotValue = createConversationSnapshot(
      binding,
      model,
      binding.ownerGeneration,
      INITIAL_SNAPSHOT_SEQUENCE,
    );
  }

  async snapshot(): Promise<AgentConversationShellSnapshot> {
    return this.snapshotValue;
  }

  async subscribe(afterSequence: number): Promise<AgentConversationShellSubscribeRuntimeResult> {
    // This source owns only the current bounded snapshot, not an unbounded
    // replay log. A stale cursor must be re-bound by the Host rather than
    // receiving a discontinuous replay page.
    if (this.disposed || afterSequence !== this.snapshotValue.snapshotSequence) {
      return { result: { type: 'subscribe', status: 'unavailable', code: this.disposed ? 'disposed' : 'generation-replaced' } };
    }
    const subscription: AgentConversationShellSubscription = {
      subscriptionId: `chatroom-${this.subscriptionCount += 1}`,
      binding: bindingOf(this.binding),
      generation: this.snapshotValue.generation,
      afterSequence,
      snapshotSequence: this.snapshotValue.snapshotSequence,
    };
    let stream: ChatroomSubscriptionStream | undefined;
    stream = new ChatroomSubscriptionStream(subscription, this.snapshotValue, afterSequence, () => {
      if (stream !== undefined) this.streams.delete(stream);
    });
    this.streams.add(stream);
    return {
      result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
      handle: { subscription, pages: stream.pages, unsubscribe: () => stream?.unsubscribe() },
    };
  }

  async updateRoomSettings(request: Parameters<AgentConversationShellSource['updateRoomSettings']>[0]): Promise<ReturnType<AgentConversationShellSource['updateRoomSettings']> extends Promise<infer Result> ? Result : never> {
    const fence = {
      type: 'update-room-settings' as const,
      requestId: request.requestId,
      binding: bindingOf(this.binding),
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
    };
    if (this.disposed) return { ...fence, status: 'unavailable', code: 'disposed' };
    if (request.binding.bindingId !== this.binding.bindingId
      || request.binding.ownerGeneration !== this.binding.ownerGeneration) {
      return { ...fence, status: 'conflict', code: 'owner-conflict' };
    }
    if (request.generation !== this.snapshotValue.generation) {
      return { ...fence, status: 'conflict', code: 'generation-conflict' };
    }
    if (request.roomId !== this.binding.routeSelection.selectedRoomParam) {
      return { ...fence, status: 'conflict', code: 'room-conflict' };
    }
    const canonical = JSON.stringify({
      binding: request.binding,
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
      patch: request.patch,
    });
    const previous = this.roomSettingsRequests.get(request.requestId);
    if (previous !== undefined) {
      return previous.canonical === canonical
        ? previous.result
        : { ...fence, status: 'conflict', code: 'request-conflict' };
    }
    if (request.expectedSnapshotSequence !== this.snapshotValue.snapshotSequence) {
      return {
        ...fence, status: 'conflict', code: 'snapshot-conflict',
        currentSnapshotSequence: this.snapshotValue.snapshotSequence,
      };
    }
    if (this.updateRoomProfile === undefined) {
      return { ...fence, status: 'unavailable', code: 'settings-unavailable' };
    }
    const status = await this.updateRoomProfile(request);
    const result: AgentConversationRoomSettingsUpdateResult = status === 'applied'
      ? { ...fence, status: 'applied', code: 'applied', snapshotSequence: this.snapshotValue.snapshotSequence }
      : { ...fence, status: 'conflict', code: 'room-conflict' };
    this.roomSettingsRequests.set(request.requestId, { canonical, result });
    return result;
  }

  replace(model: ChatroomConversationModel): void {
    if (this.disposed) return;
    const previous = this.snapshotValue;
    const next = createConversationSnapshot(
      this.binding,
      model,
      previous.generation,
      previous.snapshotSequence + 1,
    );
    this.snapshotValue = next;
    const sameSelection = JSON.stringify(previous.selection) === JSON.stringify(next.selection);
    const prefixUnchanged = previous.items.every((item, index) =>
      JSON.stringify(item) === JSON.stringify(next.items[index]));
    if (sameSelection && next.items.length === previous.items.length + 1 && prefixUnchanged) {
      const item = next.items.at(-1)!;
      for (const stream of this.streams) stream.publish({
        kind: 'item-appended', sequence: next.snapshotSequence, item,
      });
      return;
    }
    const changed = previous.items.flatMap((item, index) =>
      JSON.stringify(item) === JSON.stringify(next.items[index]) ? [] : [index]);
    if (sameSelection && previous.items.length === next.items.length && changed.length === 1) {
      const index = changed[0];
      if (previous.items[index].itemId === next.items[index].itemId) {
        for (const stream of this.streams) stream.publish({
          kind: 'item-updated', sequence: next.snapshotSequence, item: next.items[index],
        });
        return;
      }
    }
    for (const stream of this.streams) stream.replace(next);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stream of [...this.streams]) stream.close('owner-disposed');
    this.streams.clear();
    this.onDispose();
  }
}

/** Command routing stays inside Chatroom; only Host-generated contexts enter it. */
export class ChatroomConversationController {
  private readonly sources = new Map<string, {
    readonly binding: Readonly<AgentConversationShellBinding>;
    readonly source: ChatroomConversationSource;
    roomId?: string;
  }>();
  private readonly playgroundSourceCorrelations = new Map<string, {
    readonly binding: Readonly<AgentConversationShellBinding>;
    readonly roomId?: string;
  }>();
  private readonly pending: ChatroomCommandIntent[] = [];
  private readonly seenRoomIds = new Set<string>();
  private readonly ownerGenerationListeners = new Set<(ownerGeneration: string) => void>();
  private ownerGenerationValue: string | undefined;
  readonly rooms: ChatroomRoomRegistry;
  private readonly unsubscribeRegistry: () => void;
  private nextRoomNumber = 1;
  private nextMessageNumber = 1;
  private nextRunNumber = 1;

  constructor(
    rooms: readonly Room[] | ChatroomRoomRegistry = [],
    readonly configuration: ChatroomAgentConfiguration = CHATROOM_DEFAULT_AGENT_CONFIGURATION,
    private readonly persistDirectRoom?: (room: Room) => Promise<void>,
    private readonly isRunLocallyUnavailable: (roomId: string, runId: string) => boolean = () => false,
  ) {
    this.rooms = rooms instanceof ChatroomRoomRegistry ? rooms : new ChatroomRoomRegistry(rooms);
    const hydrated = this.rooms.snapshot();
    this.nextRoomNumber = this.nextNumericId(hydrated.map(room => room.id), /^room-(\d+)$/);
    this.nextRunNumber = this.nextNumericId(
      hydrated.flatMap(room => room.runs.map(run => run.runId)),
      /^run-(\d+)$/,
    );
    this.nextMessageNumber = this.nextNumericId(
      hydrated.flatMap(room => [
        ...room.items.flatMap(item => item.kind === 'message'
          ? [item.itemId, item.messageId]
          : [item.itemId]),
        ...room.acknowledgements.map(item => item.userItemId),
        ...room.deliveries.map(item => item.userItemId),
        ...room.outbox.map(item => item.userItemId),
      ]),
      /^(?:target-error-)?message-(\d+)$/,
    );
    for (const room of hydrated) this.seenRoomIds.add(room.id);
    this.unsubscribeRegistry = this.rooms.subscribe(roomId => {
      if (this.rooms.get(roomId) !== undefined) this.seenRoomIds.add(roomId);
      this.refreshRoom(roomId);
    });
  }

  createSource(binding: Readonly<AgentConversationShellBinding>): ChatroomConversationSource {
    if (this.ownerGenerationValue !== binding.ownerGeneration) {
      this.ownerGenerationValue = binding.ownerGeneration;
      this.playgroundSourceCorrelations.clear();
      for (const listener of this.ownerGenerationListeners) listener(binding.ownerGeneration);
    }
    const generation = binding.ownerGeneration;
    const key = sourceKey(binding, generation);
    const source = new ChatroomConversationSource(
      binding,
      this.modelFor(binding),
      () => this.sources.delete(key),
      async request => {
        const room = this.rooms.get(request.roomId);
        if (room === undefined || binding.routeSelection.selectedRoomParam !== room.id) return 'room-conflict';
        const patch = request.patch;
        const description = 'description' in patch && patch.description !== undefined
          ? patch.description.state === 'present' ? patch.description.text : undefined
          : room.description;
        const replacement = replaceRoomProfile(room, {
          name: 'name' in patch && patch.name !== undefined ? patch.name : room.title,
          description,
        });
        await this.commitDirectRoom(replacement);
        return 'applied';
      },
    );
    this.sources.set(key, { binding, source, roomId: binding.routeSelection.selectedRoomParam });
    this.playgroundSourceCorrelations.set(key, {
      binding,
      roomId: binding.routeSelection.selectedRoomParam,
    });
    return source;
  }

  dispose(): void {
    this.unsubscribeRegistry();
    for (const { source } of this.sources.values()) source.dispose();
    this.sources.clear();
    this.playgroundSourceCorrelations.clear();
    this.ownerGenerationListeners.clear();
  }

  subscribeOwnerGeneration(listener: (ownerGeneration: string) => void): () => void {
    this.ownerGenerationListeners.add(listener);
    if (this.ownerGenerationValue !== undefined) listener(this.ownerGenerationValue);
    return () => this.ownerGenerationListeners.delete(listener);
  }

  handle(context: AgentConversationShellCommandContext): ChatroomCommandIntent | undefined {
    const key = `${context.binding.bindingId}:${context.binding.ownerGeneration}:${context.generation}`;
    const active = this.sources.get(key);
    if (active === undefined) return undefined;

    if (context.scope === 'approval') {
      const decision = context.command.id === CHATROOM_COMMAND_APPROVAL_APPROVE ? 'approved'
        : context.command.id === CHATROOM_COMMAND_APPROVAL_DENY ? 'denied'
          : context.command.id === CHATROOM_COMMAND_APPROVAL_CANCEL ? 'cancelled' : undefined;
      const roomId = active.binding.routeSelection.selectedRoomParam;
      const room = roomId === undefined ? undefined : this.rooms.get(roomId);
      const item = room?.items
        .find(candidate => candidate.itemId === context.itemId);
      if (decision === undefined || roomId === undefined || item?.kind !== 'approval'
        || item.state !== 'pending'
        || !item.actions.some(action => action.decision === context.command.id.split('.').at(-1)
          && action.command.id === context.command.id)) return undefined;
      const playgroundApproval = room?.playgroundAgentApprovals
        ?.find(candidate => candidate.itemId === item.itemId && candidate.approvalId === item.approvalId);
      if (playgroundApproval !== undefined) {
        return {
          kind: 'playground-approval-decision', roomId, itemId: item.itemId, decision,
          operationId: approvalDecisionOperationId(
            roomId, item.runId, item.turn, item.approvalId, decision,
          ),
        };
      }
      return {
        kind: 'approval-decision', roomId, runId: item.runId, turn: item.turn,
        approvalId: item.approvalId, decision,
      };
    }
    if (context.scope !== 'composer-submit' || context.command.id !== CHATROOM_COMMAND_SUBMIT) return undefined;

    const selectedRoomId = active.binding.routeSelection.selectedRoomParam;
    const prepared = selectedRoomId === undefined
      ? this.createRoomWithFirstMessage(context.submitPayload)
      : this.appendPendingMessage(selectedRoomId, context.submitPayload);
    if ('error' in prepared) {
      if (selectedRoomId !== undefined) this.appendTargetError(selectedRoomId, prepared.error, 'mention' in prepared ? prepared.mention : undefined);
      return {
        kind: 'target-error',
        ...(selectedRoomId === undefined ? {} : { roomId: selectedRoomId }),
        code: prepared.error,
        ...(!('mention' in prepared) || prepared.mention === undefined ? {} : { mention: prepared.mention }),
      };
    }
    const { room, deliveries, dispatchText, userItemId } = prepared;
    this.rooms.upsert(room);
    if (selectedRoomId === undefined) {
      active.roomId = room.id;
      active.source.replace(createRoomConversationModel(room));
    }
    const intent: ChatroomCommandIntent = {
      kind: 'send-message', roomId: room.id, roomCreated: selectedRoomId === undefined,
      deliveries, userItemId,
      bindingId: context.binding.bindingId, generation: context.generation, dispatchText,
    };
    this.pending.push(intent);
    return intent;
  }

  selectedRoomId(context: Readonly<{
    binding: { readonly bindingId: string; readonly ownerGeneration: string };
    generation: string;
  }>): string | undefined {
    return this.sources.get(
      `${context.binding.bindingId}:${context.binding.ownerGeneration}:${context.generation}`,
    )?.roomId;
  }

  takePendingIntents(): readonly ChatroomCommandIntent[] {
    return this.pending.splice(0);
  }

  inspectPlaygroundSource(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
  ): ChatroomPlaygroundSourceInspection {
    const key = `${correlation.bindingId}:${correlation.ownerGeneration}:${correlation.generation}`;
    const source = this.sources.get(key) ?? this.playgroundSourceCorrelations.get(key);
    if (source === undefined) {
      const sameBinding = [...this.playgroundSourceCorrelations.values()].filter(candidate =>
        candidate.binding.bindingId === correlation.bindingId);
      if (sameBinding.some(candidate => candidate.binding.ownerGeneration === correlation.ownerGeneration)) {
        return { status: 'unavailable', code: 'generation-invalid' };
      }
      return {
        status: 'unavailable',
        code: sameBinding.length === 0 ? 'stale-binding' : 'retired',
      };
    }
    if (source.roomId !== correlation.roomId
      || source.binding.routeSelection.selectedRoomParam !== correlation.roomId) {
      return { status: 'unavailable', code: 'correlation-invalid' };
    }
    const room = this.rooms.get(correlation.roomId);
    if (room === undefined) {
      return {
        status: 'unavailable',
        code: this.seenRoomIds.has(correlation.roomId) ? 'deleted' : 'missing',
      };
    }
    if (room.archived) return { status: 'unavailable', code: 'archived' };
    const member = room.memberships.find(candidate => candidate.memberId === correlation.memberId);
    const run = room.runs.find(candidate => candidate.runId === correlation.runId);
    if (member === undefined || run?.memberId !== member.memberId) {
      return { status: 'unavailable', code: 'correlation-invalid' };
    }
    if (this.isRunLocallyUnavailable(room.id, run.runId)
      || run.taskBinding?.state !== 'active' || run.detailsUrl === undefined
      || (run.presence.state !== 'joined' && run.presence.state !== 'ready')) {
      return { status: 'unavailable', code: 'retired' };
    }
    return { status: 'available', room, run, member };
  }

  planPlaygroundMessage(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    textValue: string,
    now: () => string = () => new Date().toISOString(),
  ): ChatroomPlaygroundMessagePlan {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const text = textValue.trim();
    if (text === '') throw new Error('Playground message text is empty.');
    const itemId = createChatroomOpaqueId('simulator-entry', operationId);
    const messageId = createChatroomOpaqueId('simulator-message', operationId);
    const existingInAnotherRoom = this.rooms.snapshot().some(room => room.id !== correlation.roomId
      && (room.deliveries.some(delivery => delivery.operationId === operationId)
        || room.items.some(item => item.kind === 'message'
          && item.semantic.purpose === 'conversation'
          && item.semantic.causation?.operationId === operationId)));
    if (existingInAnotherRoom) return { status: 'conflict', code: 'operation-conflict' };
    const existing = inspection.room.items.find(item => item.kind === 'message'
      && item.semantic.purpose === 'conversation'
      && item.semantic.causation?.operationId === operationId);
    if (existing?.kind === 'message') {
      const exactBody = existing.body.length === 1 && existing.body[0].kind === 'text'
        && existing.body[0].text.fallback === text;
      const outbox = inspection.room.outbox.find(candidate => candidate.userItemId === existing.itemId);
      const delivery = inspection.room.deliveries.find(candidate => candidate.operationId === operationId);
      const exactTarget = outbox === undefined || (outbox.memberId === correlation.memberId
        && outbox.runId === correlation.runId && outbox.send.operationId === operationId);
      const exactDelivery = delivery === undefined || (delivery.stage === 'send'
        && delivery.userItemId === existing.itemId && delivery.memberId === correlation.memberId
        && delivery.runId === correlation.runId);
      if (!exactBody || !exactTarget || !exactDelivery
        || existing.itemId !== itemId || existing.messageId !== messageId) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
        memberId: correlation.memberId, userItemId: existing.itemId,
        messageId: existing.messageId, text, replayed: true,
      };
    }
    if (inspection.room.deliveries.some(delivery => delivery.operationId === operationId)
      || inspection.room.outbox.some(delivery => delivery.send.operationId === operationId)) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const participants = inspection.room.participants.some(participant => participant.id === 'user')
      ? inspection.room.participants
      : [...inspection.room.participants, { id: 'user', name: 'You', kind: 'human' as const }];
    const sequence = inspection.room.timelineSequence + 1;
    const item: AgentConversationItem = {
      kind: 'message', itemId, messageId, sequence, source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: {
        participantId: 'user', role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: text } }],
      reactions: [], timestamp: now(), deliveryState: 'pending', runState: 'idle',
      ariaLive: 'off', actions: [],
    };
    this.rooms.upsert(createRoom({
      ...inspection.room,
      participants,
      items: [...inspection.room.items, item],
      timelineSequence: sequence,
    }));
    return {
      status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
      memberId: correlation.memberId, userItemId: itemId, messageId, text, replayed: false,
    };
  }

  async projectPlaygroundAgentReply(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    textValue: string,
    replyCorrelation: Readonly<ChatroomPlaygroundAgentReplyCorrelation> | undefined,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentReplyProjection> {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const text = textValue.trim();
    if (text === '') throw new Error('Playground Agent reply text is empty.');
    const dispatch = resolveExplicitRoomAgentDispatch(
      inspection.room,
      text,
      correlation.memberId,
      this.locallyUnavailableRunIds(inspection.room),
    );
    if (dispatch.status !== 'resolved' && dispatch.status !== 'room-only') {
      return { status: 'target-error', code: dispatch.status, mention: dispatch.mention };
    }
    const turnId = replyCorrelation?.turnId;
    const sourceMessageId = replyCorrelation?.messageId;
    const inReplyToMessageId = replyCorrelation?.inReplyToMessageId;
    const existing = inspection.room.playgroundAgentEgresses
      ?.find(egress => egress.operationId === operationId);
    if (existing !== undefined) {
      const expectedTargetMemberIds = dispatch.status === 'resolved'
        ? dispatch.recipients.map(recipient => recipient.memberId)
        : [];
      const existingTargetMemberIds = existing.recipients?.map(recipient => recipient.targetMemberId) ?? [];
      if (existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.text !== text
        || existing.delegation !== undefined
        || JSON.stringify(existingTargetMemberIds) !== JSON.stringify(expectedTargetMemberIds)
        || existing.turnId !== turnId
        || existing.sourceMessageId !== sourceMessageId
        || existing.inReplyToMessageId !== inReplyToMessageId) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
        memberId: correlation.memberId, participantId: existing.participantId,
        itemId: existing.itemId, messageId: existing.messageId, text: existing.text,
        timestamp: existing.timestamp, replayed: true,
        ...(existing.recipients === undefined ? {} : { recipients: existing.recipients }),
        ...(existing.turnId === undefined ? {} : { turnId: existing.turnId }),
        ...(existing.sourceMessageId === undefined ? {} : { sourceMessageId: existing.sourceMessageId }),
        ...(existing.inReplyToMessageId === undefined ? {} : {
          inReplyToMessageId: existing.inReplyToMessageId,
        }),
      };
    }
    if (this.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const itemId = createChatroomOpaqueId('simulator-agent-egress', operationId);
    const participant = projectRoomParticipant(
      inspection.room.participants.find(candidate => candidate.id === inspection.member.participantId) ?? {
        id: inspection.member.participantId,
        name: inspection.member.label,
        kind: 'agent',
        avatar: inspection.member.avatar,
      },
      inspection.room,
    );
    if (participant.role !== 'agent') {
      throw new Error('Playground Agent reply requires the bound member Agent identity.');
    }
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    let roomWithRecipients = inspection.room;
    const recipients = dispatch.status === 'resolved'
      ? dispatch.recipients.map(recipient => {
        let targetRunId = recipient.runId;
        if (targetRunId === undefined) {
          roomWithRecipients = this.retireLocallyUnavailableRuns(
            roomWithRecipients,
            recipient.memberId,
          );
          targetRunId = createChatroomOpaqueId('agent-message-run', operationId, recipient.memberId);
          const targetMember = roomWithRecipients.memberships.find(member =>
            member.memberId === recipient.memberId)!;
          roomWithRecipients = addRoomRun(roomWithRecipients, {
            runId: targetRunId,
            memberId: recipient.memberId,
            title: `${targetMember.label} message run`,
            status: 'creating',
          });
        }
        return Object.freeze({
          targetMemberId: recipient.memberId,
          targetRunId,
          content: dispatch.content,
          runCreated: recipient.createRun,
        });
      })
      : undefined;
    const item: Extract<AgentConversationItem, { kind: 'message' }> = {
      kind: 'message', itemId, messageId: itemId, sequence, source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: participant,
      body: [{
        kind: 'text',
        text: { namespace: 'chatroom', key: 'message.playground-agent-egress', fallback: text },
      }],
      reactions: [], timestamp, deliveryState: 'delivered', runState: 'idle',
      ariaLive: 'polite', actions: [],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const egress = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      itemId,
      messageId: itemId,
      text,
      timestamp,
      state: 'completed' as const,
      ...(turnId === undefined ? {} : { turnId }),
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }),
    };
    const next = createRoom({
      ...roomWithRecipients,
      items: [...roomWithRecipients.items, item],
      timelineSequence: sequence,
      runs: roomWithRecipients.runs.map(run => run.runId === correlation.runId
        ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
        : run),
      playgroundAgentEgresses: [...(roomWithRecipients.playgroundAgentEgresses ?? []), {
        ...egress,
        ...(recipients === undefined ? {} : { recipients }),
      }],
    });
    await this.commitDirectRoom(next);
    return {
      status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
      memberId: correlation.memberId, participantId: inspection.member.participantId,
      itemId, messageId: itemId, text, timestamp, replayed: false,
      ...(recipients === undefined ? {} : { recipients }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }),
    };
  }

  async projectPlaygroundAgentDelegation(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    targetMemberId: string,
    textValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentDelegationProjection> {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const task = textValue.trim();
    if (task === '') throw new Error('Playground delegated task text is empty.');
    const targetMember = inspection.room.memberships.find(candidate =>
      candidate.memberId === targetMemberId && candidate.memberId !== correlation.memberId);
    if (targetMember === undefined) return { status: 'missing-target' };
    const announcementTask = task.replace(/[。！？.!?]+$/u, '');
    const work = announcementTask.replace(/^完成(?:一下)?/u, '').trimStart();
    const announcement = work === ''
      ? `我会通知 @${targetMember.label} 去处理这项工作。`
      : `我会通知 @${targetMember.label} 去完成${work}的工作。`;
    const targetRunId = createChatroomOpaqueId('delegation-run', operationId);
    const itemId = createChatroomOpaqueId('simulator-agent-delegation', operationId);
    const reportsTo = targetMember.reportsToMemberId === undefined ? undefined
      : inspection.room.memberships.find(member => member.memberId === targetMember.reportsToMemberId);
    const context: ChatroomPlaygroundDelegationContext = Object.freeze({
      source: Object.freeze({
        memberId: inspection.member.memberId,
        label: inspection.member.label,
        runId: correlation.runId,
      }),
      target: Object.freeze({
        memberId: targetMember.memberId,
        label: targetMember.label,
        runId: targetRunId,
      }),
      ...(reportsTo === undefined ? {} : {
        reportsTo: Object.freeze({ memberId: reportsTo.memberId, label: reportsTo.label }),
      }),
      availableTargets: Object.freeze(inspection.room.memberships
        .filter(member => member.memberId !== targetMember.memberId)
        .map(member => Object.freeze({ memberId: member.memberId, label: member.label }))),
      communicationMode: 'explicit-mention-required',
      approvalMode: 'reports-to-hierarchy',
    });
    const existing = inspection.room.playgroundAgentEgresses
      ?.find(egress => egress.operationId === operationId);
    if (existing !== undefined) {
      const targetRun = inspection.room.runs.find(run => run.runId === targetRunId);
      if (existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.text !== (existing.delegation?.task === undefined ? task : announcement)
        || existing.itemId !== itemId
        || existing.messageId !== itemId
        || existing.turnId !== undefined
        || existing.sourceMessageId !== undefined
        || existing.inReplyToMessageId !== undefined
        || existing.delegation?.targetMemberId !== targetMemberId
        || existing.delegation?.targetRunId !== targetRunId
        || (existing.delegation.task ?? existing.text) !== task
        || JSON.stringify(existing.delegation.context) !== JSON.stringify(context)
        || targetRun?.memberId !== targetMemberId) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted', roomId: correlation.roomId,
        sourceRunId: correlation.runId, sourceMemberId: correlation.memberId,
        sourceParticipantId: existing.participantId,
        targetRunId, targetMemberId, targetParticipantId: targetMember.participantId,
        itemId: existing.itemId, messageId: existing.messageId,
        text: existing.delegation.task ?? existing.text,
        context,
        timestamp: existing.timestamp, replayed: true,
      };
    }
    if (this.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))
      || inspection.room.runs.some(run => run.runId === targetRunId)
      || inspection.room.items.some(item => item.itemId === itemId)) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const participant = projectRoomParticipant(
      inspection.room.participants.find(candidate => candidate.id === inspection.member.participantId) ?? {
        id: inspection.member.participantId,
        name: inspection.member.label,
        kind: 'agent',
        avatar: inspection.member.avatar,
      },
      inspection.room,
    );
    if (participant.role !== 'agent') {
      throw new Error('Playground delegation requires the bound member Agent identity.');
    }
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    const item: Extract<AgentConversationItem, { kind: 'message' }> = {
      kind: 'message', itemId, messageId: itemId, sequence, source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
      author: participant,
      body: [{
        kind: 'text',
        text: {
          namespace: 'chatroom', key: 'message.playground-agent-delegation', fallback: announcement,
        },
      }],
      reactions: [], timestamp, deliveryState: 'delivered', runState: 'idle',
      ariaLive: 'polite', actions: [],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const withTargetRun = addRoomRun(this.retireLocallyUnavailableRuns(
      inspection.room,
      targetMemberId,
    ), {
      runId: targetRunId,
      memberId: targetMemberId,
      title: `${targetMember.label} delegated run`,
      status: 'creating',
    });
    const egress = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      itemId,
      messageId: itemId,
      text: announcement,
      timestamp,
      state: 'completed' as const,
      delegation: { targetMemberId, targetRunId, task, context },
    };
    const next = createRoom({
      ...withTargetRun,
      items: [...withTargetRun.items, item],
      timelineSequence: sequence,
      runs: withTargetRun.runs.map(run => run.runId === correlation.runId
        ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
        : run),
      playgroundAgentEgresses: [...(withTargetRun.playgroundAgentEgresses ?? []), egress],
    });
    await this.commitDirectRoom(next);
    return {
      status: 'accepted', roomId: correlation.roomId,
      sourceRunId: correlation.runId, sourceMemberId: correlation.memberId,
      sourceParticipantId: inspection.member.participantId,
      targetRunId, targetMemberId, targetParticipantId: targetMember.participantId,
      itemId, messageId: itemId, text: task, context, timestamp, replayed: false,
    };
  }

  async projectPlaygroundAgentApprovalRequest(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    reasonValue: string,
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const reason = reasonValue.trim();
    if (reason === '') throw new Error('Playground Agent approval reason is empty.');
    const existing = inspection.room.playgroundAgentApprovals
      ?.find(approval => approval.operationId === operationId);
    if (existing !== undefined) {
      if (existing.participantId !== inspection.member.participantId
        || existing.memberId !== correlation.memberId
        || existing.runId !== correlation.runId
        || existing.shellBindingId !== correlation.bindingId
        || existing.ownerGeneration !== correlation.ownerGeneration
        || existing.shellGeneration !== correlation.generation
        || existing.reason !== reason) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
        memberId: correlation.memberId, participantId: existing.participantId,
        itemId: existing.itemId, turnId: existing.turnId, approvalId: existing.approvalId,
        reason: existing.reason, state: existing.state, timestamp: existing.timestamp,
        replayed: true,
        ...(existing.decisionAttempts.at(-1)?.operationId === undefined ? {} : {
          decisionOperationId: existing.decisionAttempts.at(-1)!.operationId,
        }),
      };
    }
    if (this.rooms.snapshot().some(room => roomUsesOperationId(room, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    const taskBinding = inspection.run.taskBinding;
    if (taskBinding?.state !== 'active') {
      throw new Error('Playground Agent approval requires an active AgentLoop binding.');
    }
    const itemId = createChatroomOpaqueId('simulator-agent-approval', operationId);
    const turnId = createChatroomOpaqueId('simulator-agent-approval-turn', operationId);
    const approvalId = createChatroomOpaqueId('simulator-agent-approval-id', operationId);
    const timestamp = now();
    const sequence = inspection.room.timelineSequence + 1;
    const item: Extract<AgentConversationItem, { kind: 'approval' }> = {
      kind: 'approval',
      itemId,
      sequence,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      binding: taskBinding.binding,
      turn: turnId,
      approvalId,
      approvalKind: 'other',
      rationale: {
        namespace: 'chatroom',
        key: 'approval.playground-agent.reason',
        fallback: reason,
      },
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE } },
        { decision: 'deny', command: { id: CHATROOM_COMMAND_APPROVAL_DENY } },
        { decision: 'cancel', command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL } },
      ],
    };
    const publicProjection = roomRunPublicProjectionForItem(item);
    const approval = {
      operationId,
      participantId: inspection.member.participantId,
      memberId: correlation.memberId,
      runId: correlation.runId,
      shellBindingId: correlation.bindingId,
      ownerGeneration: correlation.ownerGeneration,
      shellGeneration: correlation.generation,
      agentLoopBindingId: taskBinding.binding.bindingId,
      agentLoopBindingGeneration: taskBinding.binding.generation,
      itemId,
      turnId,
      approvalId,
      reason,
      timestamp,
      state: 'pending' as const,
      decisionAttempts: [],
    };
    const next = createRoom({
      ...inspection.room,
      items: [...inspection.room.items, item],
      timelineSequence: sequence,
      runs: inspection.room.runs.map(run => run.runId === correlation.runId
        ? { ...run, publicProjections: [...(run.publicProjections ?? []), publicProjection] }
        : run),
      playgroundAgentApprovals: [...(inspection.room.playgroundAgentApprovals ?? []), approval],
    });
    await this.commitDirectRoom(next);
    return {
      status: 'accepted', roomId: correlation.roomId, runId: correlation.runId,
      memberId: correlation.memberId, participantId: inspection.member.participantId,
      itemId, turnId, approvalId, reason, state: 'pending', timestamp, replayed: false,
    };
  }

  async decidePlaygroundAgentApproval(
    correlation: Readonly<ChatroomPlaygroundSourceCorrelation>,
    operationId: string,
    approvalId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const inspection = this.inspectPlaygroundSource(correlation);
    if (inspection.status !== 'available') {
      throw new Error(`Playground source is unavailable: ${inspection.code}.`);
    }
    const approval = inspection.room.playgroundAgentApprovals
      ?.find(candidate => candidate.approvalId === approvalId);
    if (approval === undefined) return { status: 'missing' };
    if (approval.participantId !== inspection.member.participantId
      || approval.memberId !== correlation.memberId
      || approval.runId !== correlation.runId
      || approval.shellBindingId !== correlation.bindingId
      || approval.ownerGeneration !== correlation.ownerGeneration
      || approval.shellGeneration !== correlation.generation) {
      return { status: 'conflict', code: 'approval-conflict' };
    }
    return await this.completePlaygroundAgentApproval(
      inspection.room, approval, operationId, decision, now,
    );
  }

  /**
   * A visible Room card is authorized by the current shell/item/action fence,
   * not by the source task binding that originally emitted it. The durable
   * approval ledger retains that source correlation for bridge replay while
   * this path updates the exact same card after navigating back to the Room.
   */
  async decidePlaygroundAgentApprovalFromRoom(
    roomId: string,
    itemId: string,
    operationId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string = () => new Date().toISOString(),
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const room = this.rooms.get(roomId);
    const item = room?.items.find(candidate => candidate.itemId === itemId);
    const approval = room?.playgroundAgentApprovals
      ?.find(candidate => candidate.itemId === itemId);
    if (room === undefined || item?.kind !== 'approval' || approval === undefined
      || item.approvalId !== approval.approvalId || item.runId !== approval.runId
      || item.memberId !== approval.memberId) return { status: 'missing' };
    return await this.completePlaygroundAgentApproval(
      room, approval, operationId, decision, now,
    );
  }

  private async completePlaygroundAgentApproval(
    room: Room,
    approval: NonNullable<Room['playgroundAgentApprovals']>[number],
    operationId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    now: () => string,
  ): Promise<ChatroomPlaygroundAgentApprovalProjection> {
    const existingAttempt = approval.decisionAttempts
      .find(attempt => attempt.operationId === operationId);
    if (existingAttempt !== undefined) {
      if (existingAttempt.decision !== decision) {
        return { status: 'conflict', code: 'operation-conflict' };
      }
      return {
        status: 'accepted', roomId: room.id, runId: approval.runId,
        memberId: approval.memberId, participantId: approval.participantId,
        itemId: approval.itemId, turnId: approval.turnId, approvalId: approval.approvalId,
        reason: approval.reason, state: approval.state, timestamp: approval.timestamp,
        replayed: true, decisionOperationId: operationId,
      };
    }
    if (this.rooms.snapshot().some(candidate => roomUsesOperationId(candidate, operationId))) {
      return { status: 'conflict', code: 'operation-conflict' };
    }
    if (approval.state !== 'pending' && approval.state !== decision) {
      return { status: 'conflict', code: 'approval-conflict' };
    }
    if (approval.decisionAttempts.length >= CHATROOM_MAX_PLAYGROUND_APPROVAL_DECISION_ATTEMPTS) {
      return { status: 'conflict', code: 'decision-capacity' };
    }
    const timestamp = now();
    const nextApproval = {
      ...approval,
      state: decision,
      decisionAttempts: [...approval.decisionAttempts, { operationId, decision, timestamp }],
    } as const;
    const item = room.items.find(candidate => candidate.itemId === approval.itemId);
    if (item?.kind !== 'approval') {
      throw new Error('Playground Agent approval card is unavailable.');
    }
    const nextItem: Extract<AgentConversationItem, { kind: 'approval' }> = approval.state === 'pending'
      ? { ...item, state: decision, actions: [] }
      : item;
    await this.commitDirectRoom(createRoom({
      ...room,
      items: room.items.map(candidate => candidate.itemId === approval.itemId ? nextItem : candidate),
      playgroundAgentApprovals: room.playgroundAgentApprovals!.map(candidate =>
        candidate.operationId === approval.operationId ? nextApproval : candidate),
    }));
    return {
      status: 'accepted', roomId: room.id, runId: approval.runId,
      memberId: approval.memberId, participantId: approval.participantId,
      itemId: approval.itemId, turnId: approval.turnId, approvalId: approval.approvalId,
      reason: approval.reason, state: decision, timestamp: approval.timestamp,
      replayed: approval.state !== 'pending', decisionOperationId: operationId,
    };
  }

  private async commitDirectRoom(room: Room): Promise<void> {
    if (this.persistDirectRoom === undefined) {
      this.rooms.upsert(room);
      return;
    }
    await this.persistDirectRoom(room);
  }

  private modelFor(binding: Readonly<AgentConversationShellBinding>): ChatroomConversationModel {
    const roomId = binding.routeSelection.selectedRoomParam;
    const room = roomId === undefined ? undefined : this.rooms.get(roomId);
    return room === undefined
      ? createNoRoomConversationModel()
      : createRoomConversationModel(
        room,
        runId => this.isRunLocallyUnavailable(room.id, runId),
      );
  }

  private refreshRoom(roomId: string): void {
    for (const active of this.sources.values()) {
      if (active.roomId === roomId) {
        const room = this.rooms.get(roomId);
        active.source.replace(room === undefined
          ? createNoRoomConversationModel()
          : createRoomConversationModel(
            room,
            runId => this.isRunLocallyUnavailable(room.id, runId),
          ));
      }
    }
  }

  private createRoomWithFirstMessage(text: string): {
    readonly room: Room; readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string; readonly dispatchText: string; readonly userItemId: string;
  } | { readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message'; readonly mention?: string } {
    let roomId = `room-${this.nextRoomNumber++}`;
    while (this.rooms.get(roomId) !== undefined) roomId = `room-${this.nextRoomNumber++}`;
    const memberships = expandRoomMemberships(this.configuration);
    const emptyRoom = createRoom({
      id: roomId,
      title: 'New room',
      memberships,
      seedLeaderIds: this.configuration.seedLeaderIds,
      participants: [
        { id: 'user', name: 'You', kind: 'human' },
        ...memberships.map(member => ({
          id: member.participantId,
          name: member.label,
          kind: 'agent' as const,
          avatar: member.avatar,
        })),
      ],
      participantPresentation: { multiParticipant: true, participantPresentation: 'host-initials' },
    });
    return this.appendPendingMessageToRoom(emptyRoom, text);
  }

  private appendPendingMessage(roomId: string, value: string): {
    readonly room: Room; readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string; readonly dispatchText: string; readonly userItemId: string;
  } | { readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message'; readonly mention?: string } {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Selected Room is unavailable.');
    return this.appendPendingMessageToRoom(room, value);
  }

  private appendPendingMessageToRoom(roomInput: Room, value: string): {
    readonly room: Room; readonly deliveries: readonly [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]];
    readonly displayText: string; readonly dispatchText: string; readonly userItemId: string;
  } | { readonly error: 'empty' | 'no-recipients' | 'missing' | 'ambiguous' | 'empty-targeted-message'; readonly mention?: string } {
    let room = roomInput;
    const locallyUnavailableRunIds = this.locallyUnavailableRunIds(room);
    const resolution = resolveRoomMessageDispatch(room, value, [], locallyUnavailableRunIds);
    if (resolution.status !== 'resolved') {
      return {
        error: resolution.status,
        ...('mention' in resolution ? { mention: resolution.mention } : {}),
      };
    }
    const deliveries: ChatroomCommandDelivery[] = [];
    for (const recipient of resolution.recipients) {
      let runId = recipient.runId;
      if (recipient.createRun) {
        room = this.retireLocallyUnavailableRuns(room, recipient.memberId);
        runId = this.nextAvailableRunId(room);
        const membership = room.memberships.find(member => member.memberId === recipient.memberId)!;
        room = addRoomRun(room, {
          runId,
          memberId: recipient.memberId,
          title: `${membership.label} run`,
          status: 'creating',
        });
      }
      if (runId === undefined) throw new Error('Resolved Room recipient requires a run.');
      deliveries.push({
        memberId: recipient.memberId,
        runId,
        runCreated: recipient.createRun,
        reason: recipient.reason,
      });
    }
    const participants = room.participants.some(participant => participant.id === 'user')
      ? room.participants
      : [...room.participants, { id: 'user', name: 'You', kind: 'human' as const }];
    // Preserve explicit routing tokens in the public timeline while keeping
    // AgentLoop payloads limited to the parsed task content.
    const displayText = value.trim();
    const sequence = room.timelineSequence + 1;
    const userItemId = this.nextMessageId();
    const item: AgentConversationItem = {
      kind: 'message', itemId: userItemId, messageId: this.nextMessageId(), sequence,
      source: 'agent-loop',
      semantic: { purpose: 'conversation' },
      author: {
        participantId: 'user', role: 'human',
        displayName: { namespace: 'chatroom', key: 'participant.user.name', fallback: 'You' },
      },
      body: [{ kind: 'text', text: { namespace: 'chatroom', key: 'message.user', fallback: displayText } }],
      reactions: [],
      timestamp: new Date().toISOString(), deliveryState: 'pending', runState: 'idle', ariaLive: 'off', actions: [],
    };
    return { room: createRoom({
      ...room,
      participants,
      items: [...room.items, item],
      timelineSequence: sequence,
    }), deliveries: deliveries as [ChatroomCommandDelivery, ...ChatroomCommandDelivery[]],
    displayText, dispatchText: resolution.content, userItemId };
  }

  private locallyUnavailableRunIds(room: Room): ReadonlySet<string> {
    return new Set(room.runs
      .filter(run => this.isRunLocallyUnavailable(room.id, run.runId))
      .map(run => run.runId));
  }

  private retireLocallyUnavailableRuns(room: Room, memberId: string): Room {
    let next = room;
    for (const run of room.runs) {
      if (run.memberId !== memberId || !this.isRunLocallyUnavailable(room.id, run.runId)) continue;
      next = failRoomRunPresence(next, run.runId, {
        code: 'task-unavailable',
        retryable: true,
        diagnostic: 'task-unavailable',
      });
    }
    return next;
  }

  private appendTargetError(roomId: string, code: string, mention: string | undefined): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    const sequence = room.timelineSequence + 1;
    const target = mention === undefined ? '' : ` ${mention}`;
    const item: AgentConversationItem = {
      kind: 'status', itemId: `target-error-${this.nextMessageId()}`, sequence,
      label: {
        namespace: 'chatroom', key: `target.${code}`,
        fallback: `Message target${target} is ${code.replaceAll('-', ' ')}.`,
      },
      state: 'error', ariaLive: 'polite',
    };
    this.rooms.upsert(createRoom({ ...room, items: [...room.items, item], timelineSequence: sequence }));
  }

  private nextMessageId(): string {
    return `message-${this.nextMessageNumber++}`;
  }

  private nextRunId(): string {
    return `run-${this.nextRunNumber++}`;
  }

  private nextAvailableRunId(room: Room): string {
    let runId = this.nextRunId();
    while (room.runs.some(run => run.runId === runId)) runId = this.nextRunId();
    return runId;
  }

  private nextNumericId(values: readonly string[], pattern: RegExp): number {
    return values.reduce((next, value) => {
      const match = pattern.exec(value);
      if (match === null) return next;
      const numeric = Number(match[1]);
      return Number.isSafeInteger(numeric) ? Math.max(next, numeric + 1) : next;
    }, 1);
  }
}
