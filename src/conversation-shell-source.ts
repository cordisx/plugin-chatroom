import type {
  AgentConversationRoomSettingsUpdateResult,
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellSubscription,
  AgentConversationShellUpdate,
} from '@cordisx/protocol/agent-conversation-shell/v3';

import {
  type ChatroomConversationModel,
  createConversationSnapshot,
  createNoRoomConversationModel,
} from './conversation-model.js';

import { type ChatroomRoomSettingsUpdater } from './conversation-source-contract.js';
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

  publish(update: Extract<AgentConversationShellUpdate, { kind: 'item-appended' | 'item-updated'; }>): void {
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
        await new Promise<void>(resolve => {
          this.resolveNext = resolve;
        });
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
      return {
        result: { type: 'subscribe', status: 'unavailable', code: this.disposed ? 'disposed' : 'generation-replaced' },
      };
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

  async updateRoomSettings(
    request: Parameters<AgentConversationShellSource['updateRoomSettings']>[0],
  ): Promise<
    ReturnType<AgentConversationShellSource['updateRoomSettings']> extends Promise<infer Result> ? Result : never
  > {
    const fence = {
      type: 'update-room-settings' as const,
      requestId: request.requestId,
      binding: bindingOf(this.binding),
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
    };
    if (this.disposed) return { ...fence, status: 'unavailable', code: 'disposed' };
    if (
      request.binding.bindingId !== this.binding.bindingId
      || request.binding.ownerGeneration !== this.binding.ownerGeneration
    ) {
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
        ...fence,
        status: 'conflict',
        code: 'snapshot-conflict',
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
      JSON.stringify(item) === JSON.stringify(next.items[index])
    );
    if (sameSelection && next.items.length === previous.items.length + 1 && prefixUnchanged) {
      const item = next.items.at(-1)!;
      for (const stream of this.streams) {
        stream.publish({
          kind: 'item-appended',
          sequence: next.snapshotSequence,
          item,
        });
      }
      return;
    }
    const changed = previous.items.flatMap((item, index) =>
      JSON.stringify(item) === JSON.stringify(next.items[index]) ? [] : [index]
    );
    if (sameSelection && previous.items.length === next.items.length && changed.length === 1) {
      const index = changed[0];
      if (previous.items[index].itemId === next.items[index].itemId) {
        for (const stream of this.streams) {
          stream.publish({
            kind: 'item-updated',
            sequence: next.snapshotSequence,
            item: next.items[index],
          });
        }
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
