import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationItem as AgentConversationItemV7,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v7';
import type { AgentConversationItem as AgentConversationItemV3 } from '@cordisx/protocol/agent-conversation-shell/v3';

import {
  assertChatroomAdmissionDeliveriesAccepted,
  type ChatroomAgentSessionController,
} from './agent-session-controller.js';
import type { ProjectedItem } from './agent-session-projection.js';
import type { ChatroomComposerSettings, ChatroomComposerShortcutPolicy } from './composer-settings.js';
import { createRoomConversationModel } from './conversation-model.js';
import type { ChatroomCommandIntent, ChatroomConversationController } from './conversation-source.js';
import { approvalDecisionOperationId } from './room-agent-operations.js';
import type { Room } from './room.js';

export type ChatroomPageItem = AgentConversationItemV3 | AgentConversationItemV7 | ProjectedItem;

export interface ChatroomPageSnapshot {
  readonly revision: number;
  readonly roomId?: string;
  readonly room?: Room;
  readonly missing: boolean;
  readonly participants: readonly AgentConversationParticipant[];
  readonly activeRuns: readonly AgentConversationActiveRunDescriptor[];
  readonly items: readonly ChatroomPageItem[];
  readonly shortcutPolicy: ChatroomComposerShortcutPolicy;
}

export type ChatroomPageSubmitResult =
  | { readonly status: 'accepted'; readonly roomId: string; readonly roomCreated: boolean; }
  | {
    readonly status: 'target-error';
    readonly code: Extract<ChatroomCommandIntent, { readonly kind: 'target-error'; }>['code'];
    readonly mention?: string;
  };

function itemTime(item: ChatroomPageItem): number | undefined {
  if (item.kind !== 'message') return undefined;
  const value = Date.parse(item.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function stableItemOrder(left: ChatroomPageItem, right: ChatroomPageItem): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
}

function chronologicalItems(items: readonly ChatroomPageItem[]): readonly ChatroomPageItem[] {
  const stable = [...items].sort(stableItemOrder);
  const timed = stable
    .filter(item => itemTime(item) !== undefined)
    .sort((left, right) => itemTime(left)! - itemTime(right)! || stableItemOrder(left, right));
  let timedIndex = 0;
  return Object.freeze(stable.map(item => itemTime(item) === undefined ? item : timed[timedIndex++]));
}

/**
 * Direct React-page data source. Room and Session subscriptions feed one
 * useSyncExternalStore-compatible revision without any synthetic Shell binding.
 */
export class ChatroomPageSource {
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, ChatroomPageSnapshot>();
  private readonly unsubscribeRooms: () => void;
  private readonly unsubscribeProjection: () => void;
  private readonly unsubscribeSettings: () => void;
  private revision = 0;
  private disposed = false;
  private readonly correlationGeneration = globalThis.crypto?.randomUUID?.() ?? String(Date.now());

  constructor(
    private readonly conversation: ChatroomConversationController,
    private readonly sessions: ChatroomAgentSessionController,
    private readonly settings: ChatroomComposerSettings,
  ) {
    this.unsubscribeRooms = conversation.rooms.subscribe(() => this.refresh());
    this.unsubscribeProjection = sessions.subscribeProjection(() => this.refresh());
    this.unsubscribeSettings = settings.subscribe(() => this.refresh());
  }

  getSnapshot(roomId: string | undefined): ChatroomPageSnapshot {
    const key = roomId ?? '';
    const retained = this.cache.get(key);
    if (retained !== undefined) return retained;
    const room = roomId === undefined ? undefined : this.conversation.rooms.get(roomId);
    const model = room === undefined ? undefined : createRoomConversationModel(
      room,
      runId => this.sessions.isRunLocallyUnavailable(room.id, runId),
    );
    const projection = room === undefined
      ? { activeRuns: [], items: [] }
      : this.sessions.projectionForRoom(room.id);
    const projectedMessageIds = new Set(
      projection.items.flatMap(item => item.kind === 'message' ? [item.messageId] : []),
    );
    const domainItems = model?.items.filter(item => {
      if (item.kind === 'message') return !projectedMessageIds.has(item.messageId);
      if (item.kind !== 'approval') return true;
      return room?.playgroundAgentApprovals?.some(approval => approval.itemId === item.itemId) === true;
    }) ?? [];
    const snapshot: ChatroomPageSnapshot = Object.freeze({
      revision: this.revision,
      ...(roomId === undefined ? {} : { roomId }),
      ...(room === undefined ? {} : { room }),
      missing: roomId !== undefined && room === undefined,
      participants: Object.freeze(
        model?.selection.kind === 'room'
          ? model.selection.participants.map(participant => Object.freeze({ ...participant }))
          : [],
      ),
      activeRuns: Object.freeze([...projection.activeRuns]),
      items: chronologicalItems([
        ...domainItems,
        ...projection.items,
      ]),
      shortcutPolicy: this.settings.current,
    });
    this.cache.set(key, snapshot);
    return snapshot;
  }

  async hydrate(roomId: string | undefined): Promise<void> {
    if (this.disposed || roomId === undefined || this.conversation.rooms.get(roomId) === undefined) return;
    await this.sessions.hydrateRoom(roomId);
    if (!this.disposed) this.refresh();
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submit(roomId: string | undefined, value: string): Promise<ChatroomPageSubmitResult> {
    if (this.disposed) throw new Error('Chatroom page source is disposed.');
    const intent = this.conversation.submitMessage(
      roomId,
      value,
      'chatroom-page',
      this.correlationGeneration,
    );
    if (intent.kind === 'target-error') {
      return {
        status: 'target-error',
        code: intent.code,
        ...(intent.mention === undefined ? {} : { mention: intent.mention }),
      };
    }
    if (intent.kind !== 'send-message') throw new Error('Direct page submit produced a non-message intent.');
    await this.conversation.persistComposerRoom(intent.roomId);
    if (intent.deliveries.length === 0) {
      throw new Error('Chatroom page submit resolved no deliveries.');
    }
    let failure: unknown;
    try {
      const outcomes = await Promise.all(intent.deliveries.map(async delivery =>
        Object.freeze({
          memberId: delivery.memberId,
          runId: delivery.runId,
          outcome: await this.sessions.sendToRoom(
            intent.roomId,
            delivery.runId,
            intent.userItemId,
            intent.dispatchText,
          ),
        })
      ));
      assertChatroomAdmissionDeliveriesAccepted(outcomes);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) throw failure;
    return { status: 'accepted', roomId: intent.roomId, roomCreated: intent.roomCreated };
  }

  async decideApproval(
    roomId: string,
    itemId: string,
    decision: 'approved' | 'denied' | 'cancelled',
  ): Promise<boolean> {
    if (this.disposed) return false;
    const room = this.conversation.rooms.get(roomId);
    const playground = room?.playgroundAgentApprovals?.find(approval => approval.itemId === itemId);
    if (room !== undefined && playground !== undefined) {
      const operationId = approvalDecisionOperationId(
        room.id,
        playground.runId,
        playground.turnId,
        playground.approvalId,
        decision,
      );
      const result = await this.conversation.decidePlaygroundAgentApprovalFromRoom(
        room.id,
        itemId,
        operationId,
        decision,
      );
      return result.status === 'accepted';
    }
    const outcome = decision === 'approved'
      ? 'allowed-once'
      : decision === 'denied'
      ? 'rejected'
      : 'cancelled';
    return this.sessions.answerApprovalItem(roomId, itemId, outcome);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRooms();
    this.unsubscribeProjection();
    this.unsubscribeSettings();
    this.cache.clear();
    this.listeners.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.cache.clear();
    for (const listener of this.listeners) listener();
  }
}
