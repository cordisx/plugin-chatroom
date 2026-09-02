import type {
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellSubscription,
  AgentConversationShellUpdate,
  AgentConversationRoomSettingsUpdateRequest,
  AgentConversationRoomSettingsUpdateResult,
} from '@cordisx/protocol/agent-conversation-shell/v3';
import type { ApprovalOutcome } from '@cordisx/protocol/approval/v1';

import type {
  ChatroomApprovalContext,
  ChatroomApprovalPolicy,
} from './agent-session-controller.js';
import { createChatroomOpaqueId, createRoom } from './room.js';
import type { ChatroomRoomStore } from './room-store.js';
import {
  CHATROOM_COMMAND_SUBMIT,
  ChatroomSessionPresentation,
  chatroomText,
} from './session-presentation.js';

class AsyncPageQueue implements AsyncIterable<AgentConversationShellPage> {
  private readonly values: AgentConversationShellPage[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentConversationShellPage>) => void> = [];
  private ended = false;

  push(value: AgentConversationShellPage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentConversationShellPage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false as const, value };
        if (this.ended) return { done: true as const, value: undefined };
        return await new Promise<IteratorResult<AgentConversationShellPage>>(resolve => this.waiters.push(resolve));
      },
    };
  }
}

interface ActiveShellSubscription {
  readonly descriptor: AgentConversationShellSubscription;
  readonly queue: AsyncPageQueue;
  closed: boolean;
}

const sameBinding = (
  left: { readonly bindingId: string; readonly ownerGeneration: string },
  right: { readonly bindingId: string; readonly ownerGeneration: string },
): boolean => left.bindingId === right.bindingId && left.ownerGeneration === right.ownerGeneration;

/** Route-scoped, data-only Conversation Shell source over Room + SessionEvent truth. */
export class ChatroomConversationSource implements AgentConversationShellSource {
  private readonly subscriptions = new Set<ActiveShellSubscription>();
  private sequence = 0;
  private nextSubscription = 0;
  private disposed = false;
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribePresentation: () => void;

  constructor(
    private readonly binding: Readonly<AgentConversationShellBinding>,
    private readonly store: ChatroomRoomStore,
    private readonly presentation: ChatroomSessionPresentation,
  ) {
    this.unsubscribeStore = store.subscribe(() => this.publish());
    this.unsubscribePresentation = binding.routeSelection.selectedRoomParam === undefined
      ? () => {}
      : presentation.subscribe(binding.routeSelection.selectedRoomParam, () => this.publish());
  }

  async snapshot(): Promise<AgentConversationShellSnapshot> {
    this.assertUsable();
    const room = this.binding.routeSelection.selectedRoomParam === undefined
      ? undefined
      : this.store.get(this.binding.routeSelection.selectedRoomParam);
    return {
      binding: {
        bindingId: this.binding.bindingId,
        ownerGeneration: this.binding.ownerGeneration,
      },
      generation: this.generation,
      snapshotSequence: this.sequence,
      selection: this.presentation.selection(room),
      items: this.presentation.items(room),
      composer: {
        availability: 'available',
        placeholder: chatroomText('composer.placeholder', 'Write a message'),
        disabled: { value: false },
        submit: {
          id: CHATROOM_COMMAND_SUBMIT,
          ...(room === undefined ? {} : { arguments: { roomId: room.id } }),
        },
      },
      headerActions: [],
    };
  }

  async subscribe(afterSequence: number): Promise<AgentConversationShellSubscribeRuntimeResult> {
    this.assertUsable();
    this.nextSubscription += 1;
    const descriptor: AgentConversationShellSubscription = {
      subscriptionId: createChatroomOpaqueId(
        'shell-subscription', this.binding.bindingId, String(this.nextSubscription),
      ),
      binding: {
        bindingId: this.binding.bindingId,
        ownerGeneration: this.binding.ownerGeneration,
      },
      generation: this.generation,
      afterSequence,
      snapshotSequence: this.sequence,
    };
    const active: ActiveShellSubscription = {
      descriptor,
      queue: new AsyncPageQueue(),
      closed: false,
    };
    this.subscriptions.add(active);
    if (afterSequence < this.sequence || afterSequence === -1) {
      const snapshot = await this.snapshot();
      this.push(active, 'replay', afterSequence, [{
        kind: 'snapshot-replaced',
        sequence: this.sequence,
        snapshot,
      }]);
    }
    return {
      result: {
        type: 'subscribe',
        status: 'accepted',
        code: 'allowed',
        subscription: descriptor,
      },
      handle: {
        subscription: descriptor,
        pages: active.queue,
        unsubscribe: () => this.close(active),
      },
    };
  }

  async updateRoomSettings(
    request: AgentConversationRoomSettingsUpdateRequest,
  ): Promise<AgentConversationRoomSettingsUpdateResult> {
    const fence = {
      type: 'update-room-settings' as const,
      requestId: request.requestId,
      binding: request.binding,
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
    };
    if (this.disposed) return { ...fence, status: 'unavailable', code: 'disposed' };
    if (!sameBinding(request.binding, this.binding)) {
      return { ...fence, status: 'conflict', code: 'owner-conflict' };
    }
    if (request.generation !== this.generation) {
      return { ...fence, status: 'conflict', code: 'generation-conflict' };
    }
    if (request.roomId !== this.binding.routeSelection.selectedRoomParam) {
      return { ...fence, status: 'conflict', code: 'room-conflict' };
    }
    if (request.expectedSnapshotSequence !== this.sequence) {
      return {
        ...fence,
        status: 'conflict',
        code: 'snapshot-conflict',
        currentSnapshotSequence: this.sequence,
      };
    }
    const room = this.store.get(request.roomId);
    if (room === undefined) {
      return { ...fence, status: 'unavailable', code: 'settings-unavailable' };
    }
    await this.store.replace(room.id, current => createRoom({
      ...current,
      ...(request.patch.name === undefined ? {} : { title: request.patch.name.trim() }),
      ...(request.patch.description === undefined ? {} : {
        description: request.patch.description.state === 'empty'
          ? undefined
          : request.patch.description.text.trim(),
      }),
    }));
    return {
      ...fence,
      status: 'applied',
      code: 'applied',
      snapshotSequence: this.sequence,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePresentation();
    this.unsubscribeStore();
    this.sequence += 1;
    for (const active of [...this.subscriptions]) {
      this.push(active, 'live', active.descriptor.snapshotSequence, [{
        kind: 'disposed',
        sequence: this.sequence,
        reason: 'owner-disposed',
      }]);
      this.close(active);
    }
  }

  get generation(): string {
    return createChatroomOpaqueId(
      'shell-generation', this.binding.bindingId, this.binding.ownerGeneration,
    );
  }

  private publish(): void {
    if (this.disposed) return;
    const sequence = ++this.sequence;
    void this.snapshot().then(snapshot => {
      for (const active of this.subscriptions) {
        this.push(active, 'live', sequence - 1, [{
          kind: 'snapshot-replaced',
          sequence,
          snapshot,
        }]);
      }
    });
  }

  private push(
    active: ActiveShellSubscription,
    phase: 'replay' | 'live',
    afterSequence: number,
    updates: readonly AgentConversationShellUpdate[],
  ): void {
    if (active.closed) return;
    active.queue.push({
      subscription: active.descriptor,
      afterSequence,
      phase,
      updates,
      nextAfterSequence: updates.at(-1)?.sequence ?? afterSequence,
      hasMore: false,
    });
  }

  private close(active: ActiveShellSubscription): void {
    if (active.closed) return;
    active.closed = true;
    this.subscriptions.delete(active);
    active.queue.end();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Chatroom Conversation Shell source is disposed.');
  }
}

export class ChatroomConversationController {
  private readonly sources = new Set<ChatroomConversationSource>();
  private disposed = false;

  constructor(
    private readonly store: ChatroomRoomStore,
    private readonly presentation: ChatroomSessionPresentation,
  ) {}

  createSource(binding: Readonly<AgentConversationShellBinding>): ChatroomConversationSource {
    if (this.disposed) throw new Error('Chatroom Conversation controller is disposed.');
    const source = new ChatroomConversationSource(binding, this.store, this.presentation);
    this.sources.add(source);
    return source;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of this.sources) source.dispose();
    this.sources.clear();
  }
}

interface PendingApproval {
  readonly context: ChatroomApprovalContext;
  readonly result: Promise<ApprovalOutcome>;
  readonly resolve: (outcome: ApprovalOutcome) => void;
}

const approvalKey = (
  roomId: string,
  runId: string,
  sessionId: string,
  approvalId: string,
): string => createChatroomOpaqueId('pending-approval', roomId, runId, sessionId, approvalId);

/**
 * Chatroom reports-to orchestration. The native ApprovalService owns durable
 * asked/decided facts; this coordinator retains only unresolved UI decisions.
 */
export class ChatroomApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private disposed = false;

  readonly policy: ChatroomApprovalPolicy = context => {
    if (this.disposed || context.authorityMemberIds.length === 0) return 'unavailable';
    const key = approvalKey(
      context.room.id,
      context.run.runId,
      context.question.sessionId,
      context.question.id,
    );
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing.result;
    let resolve!: (outcome: ApprovalOutcome) => void;
    const result = new Promise<ApprovalOutcome>(done => { resolve = done; });
    this.pending.set(key, { context, result, resolve });
    return result;
  };

  decide(
    roomId: string,
    runId: string,
    sessionId: string,
    approvalId: string,
    outcome: ApprovalOutcome,
  ): boolean {
    const key = approvalKey(roomId, runId, sessionId, approvalId);
    const pending = this.pending.get(key);
    if (pending === undefined) return false;
    this.pending.delete(key);
    pending.resolve(outcome);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.resolve('unavailable');
    this.pending.clear();
  }
}
