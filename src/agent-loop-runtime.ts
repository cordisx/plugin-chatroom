import type {
  AgentLoopEventPage,
  AgentLoopSubscribeRuntimeResult,
  AgentLoopTaskBinding,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v4';

import { type ChatroomAgentConfiguration } from './agent-definition.js';
import { projectAgentLoopEvent } from './agent-loop-projection.js';
import { failRoomAcknowledgement, failRoomRunPresence } from './room-engagement.js';
import { ChatroomRoomStoreError, DurableChatroomRoomStore } from './room-store.js';
import { createRoom, type Room, type RoomRun, roomRunOwnsAgentLoopBinding } from './room.js';

import {
  type ActiveSubscription,
  type LocalHydratedRunState,
  sameBinding,
  stablePart,
} from './agent-loop-command-values.js';
/** Owns one controller lifetime, live subscriptions, and the existing store CAS queue. */
export class ChatroomAgentLoopRuntime {
  private disposed = false;
  protected controllerGeneration = 1;
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly projections = new Set<Promise<void>>();
  private readonly localHydratedRuns = new Map<string, LocalHydratedRunState>();
  private mutationTail: Promise<void> = Promise.resolve();
  private projectionFailure: Readonly<{ generation: number; error: unknown; }> | undefined;

  constructor(
    protected readonly client: BoundAgentLoopClient,
    readonly configuration: ChatroomAgentConfiguration,
    readonly store: DurableChatroomRoomStore,
    protected readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get rooms() {
    return this.store.rooms;
  }

  isRunLocallyUnavailable(roomId: string, runId: string): boolean {
    return this.localHydratedRunState(roomId, runId)?.status === 'unavailable';
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
    const staleActiveRuns = this.rooms.snapshot().flatMap(room =>
      room.runs.flatMap(run =>
        run.taskBinding?.state === 'active'
          && (run.presence.state === 'joined' || run.presence.state === 'ready')
          ? [{ roomId: room.id, runId: run.runId, binding: run.taskBinding }]
          : []
      )
    );
    for (const stale of staleActiveRuns) {
      const current = this.rooms.get(stale.roomId)?.runs.find(run => run.runId === stale.runId);
      if (
        current?.taskBinding?.binding.bindingId !== stale.binding.binding.bindingId
        || current.taskBinding.binding.generation !== stale.binding.binding.generation
      ) continue;
      await this.probeHydratedRun(
        stale.roomId,
        stale.runId,
        stale.binding,
        controllerGeneration,
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
      result = await this.client.subscribe(source, run.agentLoopCursor ?? -1);
    } catch {
      if (this.isCurrentGeneration(controllerGeneration)) {
        this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
          status: 'unavailable',
          source,
          code: 'task-unavailable',
        });
      }
      return;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      if (result.status === 'accepted') {
        try {
          result.handle.unsubscribe();
        } catch { /* retired probe */ }
      }
      return;
    }
    if (result.status !== 'accepted') {
      this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
        status: 'unavailable',
        source,
        code: result.authorization.code,
      });
      return;
    }
    try {
      result.handle.unsubscribe();
    } catch { /* a probe never owns the runtime stream */ }
    this.localHydratedRuns.set(this.localRunKey(roomId, runId), {
      status: 'available',
      source,
    });
  }

  protected async ensureSubscribed(
    room: Room,
    runId: string,
    binding: AgentLoopTaskBinding,
    expectedControllerGeneration = this.controllerGeneration,
  ): Promise<{ readonly status: 'denied' | 'unavailable'; readonly code: string; } | undefined> {
    const controllerGeneration = expectedControllerGeneration;
    const subscriptionKey = `${stablePart(room.id)}${stablePart(runId)}`;
    const existing = this.subscriptions.get(subscriptionKey);
    if (
      existing !== undefined
      && existing.bindingId === binding.binding.bindingId
      && existing.generation === binding.binding.generation
    ) return undefined;
    existing?.unsubscribe();
    const run = this.requireRun(room, runId);
    let result: AgentLoopSubscribeRuntimeResult;
    try {
      result = await this.client.subscribe(binding, run.agentLoopCursor ?? -1);
    } catch (error) {
      if (!this.isCurrentGeneration(controllerGeneration)) return undefined;
      throw error;
    }
    if (!this.isCurrentGeneration(controllerGeneration)) {
      if (result.status === 'accepted') {
        try {
          result.handle.unsubscribe();
        } catch { /* retired handles cannot affect the replacement source */ }
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
          await this.mutateRoom(roomId, room =>
            this.failPendingRunMessages(
              room,
              runId,
              binding,
              'event-stream-failed',
            ), controllerGeneration);
          return;
        }
        if (!this.isCurrentGeneration(controllerGeneration)) return;
        if (next.done) {
          await this.mutateRoom(roomId, room =>
            this.failPendingRunMessages(
              room,
              runId,
              binding,
              'event-stream-ended',
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
            await this.mutateRoom(roomId, room =>
              this.failPendingRunMessages(
                room,
                runId,
                binding,
                'event-projection-failed',
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

  protected resetReplayableConversationProjections(room: Room): Room {
    const itemsById = new Map(room.items.map(item => [item.itemId, item]));
    const replayableItemIds = new Set<string>();
    for (const run of room.runs) {
      const hasPendingAcknowledgement = room.acknowledgements.some(candidate =>
        candidate.runId === run.runId && candidate.state === 'pending'
      );
      const hasAcceptedSend = room.deliveries.some(candidate =>
        candidate.runId === run.runId
        && candidate.stage === 'send' && candidate.state === 'accepted'
        && candidate.acceptance?.kind === 'send'
      );
      if (!hasPendingAcknowledgement && hasAcceptedSend) continue;
      for (const projection of run.publicProjections ?? []) {
        const item = itemsById.get(projection.itemId);
        if (
          item?.kind === 'message' && item.source === 'agent-loop'
          && item.semantic.purpose === 'conversation'
        ) replayableItemIds.add(item.itemId);
      }
    }
    if (replayableItemIds.size === 0) return room;
    return createRoom({
      ...room,
      runs: room.runs.map(run => ({
        ...run,
        publicProjections: (run.publicProjections ?? []).filter(candidate => !replayableItemIds.has(candidate.itemId)),
      })),
      items: room.items.filter(item => !replayableItemIds.has(item.itemId)),
      imageReferences: room.imageReferences.filter(reference => !replayableItemIds.has(reference.itemId)),
    });
  }

  protected async failMessage(
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

  protected updateUserMessage(
    room: Room,
    runId: string,
    userItemId: string,
    deliveryState: 'sent' | 'failed',
    runState: 'running' | 'failed',
  ): Room {
    const run = this.requireRun(room, runId);
    return createRoom({
      ...room,
      items: room.items.map(item =>
        item.kind === 'message' && item.itemId === userItemId
          ? { ...item, deliveryState, runState }
          : item
      ),
      runs: room.runs.map(candidate => candidate.runId === runId ? { ...run, status: runState } : candidate),
    });
  }

  protected async commit(room: Room, controllerGeneration?: number): Promise<boolean> {
    const base = this.store.document(room.id);
    const fence = Object.freeze({
      revision: base?.revision,
      roomSnapshot: base === undefined ? undefined : JSON.stringify(base.room),
    });
    return await this.enqueueMutation(async () => await this.persistRoom(room, controllerGeneration, fence));
  }

  protected async mutateRoom(
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
    fence?: Readonly<{ revision: number | undefined; roomSnapshot: string | undefined; }>,
  ): Promise<boolean> {
    if (controllerGeneration !== undefined && !this.isCurrentGeneration(controllerGeneration)) return false;
    const current = this.store.document(room.id);
    if (fence !== undefined && (current === undefined) !== (fence.roomSnapshot === undefined)) {
      throw new ChatroomRoomStoreError('conflict', 'Room existence changed concurrently.', true);
    }
    if (
      fence?.roomSnapshot !== undefined && current !== undefined && current.revision !== fence.revision
      && JSON.stringify(current.room) !== fence.roomSnapshot
    ) {
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
    if (
      run?.taskBinding === undefined
      || !sameBinding(run.taskBinding, state.source)
      || (run.presence.state !== 'joined' && run.presence.state !== 'ready')
    ) {
      this.localHydratedRuns.delete(key);
      return undefined;
    }
    return state;
  }

  protected requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error('Room is unavailable.');
    return room;
  }

  protected requireRun(room: Room, runId: string): RoomRun {
    const run = room.runs.find(candidate => candidate.runId === runId);
    if (run === undefined) throw new Error('Room run is unavailable.');
    return run;
  }

  protected assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom AgentLoop controller is disposed.');
  }

  protected isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.controllerGeneration === generation;
  }
}
