import type { AgentStatus } from '@cordisx/protocol/agents/v1';
import { type ChatroomCliPageMessage, roomCliPageMessages } from './room-cli-message-page.js';
import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationItem as AgentConversationItemV7,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v7';
import type { AgentConversationItem as AgentConversationItemV3 } from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  AgentPageAdmissionReservationService,
  AgentPageAdmissionRouteDeclarationService,
  AgentPageAdmissionRouteReservationService,
  AgentPageAdmissionTargetService,
  AgentPageComposerCommandContext,
  AgentPageComposerCommandResult,
  AgentPageFreshRoomNavigationService,
} from '@cordisx/protocol/agent-page-admission/v2';

import {
  assertChatroomAdmissionDeliveriesAccepted,
  type ChatroomAgentSessionController,
} from './agent-session-controller.js';
import type { ProjectedItem } from './agent-session-projection.js';
import type { ChatroomComposerSettings, ChatroomComposerShortcutPolicy } from './composer-settings.js';
import { CHATROOM_COMMAND_SUBMIT, createRoomConversationModel } from './conversation-model.js';
import type { ChatroomCommandIntent, ChatroomConversationController } from './conversation-source.js';
import { approvalDecisionOperationId } from './room-agent-operations.js';
import type { Room } from './room.js';

export type ChatroomPageItem =
  | AgentConversationItemV3
  | AgentConversationItemV7
  | ProjectedItem
  | ChatroomCliPageMessage;

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

/** Public Host services consumed only from a typed page-composer command. */
export interface ChatroomPageAdmissionV2Services {
  readonly targets: AgentPageAdmissionTargetService;
  readonly reservations: AgentPageAdmissionReservationService;
  readonly routeDeclarations: AgentPageAdmissionRouteDeclarationService;
  readonly routeReservations: AgentPageAdmissionRouteReservationService;
  readonly freshNavigation: AgentPageFreshRoomNavigationService;
}

function itemTime(item: ChatroomPageItem): number | undefined {
  if (item.kind !== 'message') return undefined;
  const value = Date.parse(item.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function stableItemOrder(left: ChatroomPageItem, right: ChatroomPageItem): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
}

function chronologicalItems(
  items: readonly ChatroomPageItem[],
  anchors: readonly Readonly<{ itemId: string; appendAfterItemId: string; }>[] = [],
): readonly ChatroomPageItem[] {
  const stable = [...items].sort(stableItemOrder);
  const timed = stable
    .filter(item => itemTime(item) !== undefined)
    .sort((left, right) => itemTime(left)! - itemTime(right)! || stableItemOrder(left, right));
  let timedIndex = 0;
  const ordered = stable.map(item => itemTime(item) === undefined ? item : timed[timedIndex++]);
  // Preserve the owner-verified admission fence across live updates and cold replay.
  for (const anchor of anchors) {
    const index = ordered.findIndex(item => item.itemId === anchor.itemId);
    const predecessor = ordered.findIndex(item => item.itemId === anchor.appendAfterItemId);
    if (index < 0 || predecessor < 0 || index > predecessor) continue;
    const [item] = ordered.splice(index, 1);
    const nextPredecessor = ordered.findIndex(candidate => candidate.itemId === anchor.appendAfterItemId);
    ordered.splice(nextPredecessor + 1, 0, item!);
  }
  return Object.freeze(ordered.map((item, sequence) => item.sequence === sequence ? item : { ...item, sequence }));
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
  private readonly observedStatuses = new Map<string, ReadonlyMap<string, AgentStatus>>();
  private readonly watchedRooms = new Set<string>();
  private readonly hydrationRevisions = new Map<string, number>();
  private readonly hydrations = new Map<string, Promise<void>>();
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly conversation: ChatroomConversationController,
    private readonly sessions: ChatroomAgentSessionController,
    private readonly settings: ChatroomComposerSettings,
  ) {
    this.unsubscribeRooms = conversation.rooms.subscribe(roomId => this.refreshRoom(roomId));
    this.unsubscribeProjection = sessions.subscribeProjection(roomId => this.refreshRoom(roomId));
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
    const representedRoomItems = new Set(projection.admittedRoomItemIds ?? []);
    const domainItems = model?.items.filter(item => {
      if (item.kind === 'message') return !representedRoomItems.has(item.itemId);
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
      activeRuns: Object.freeze(projection.activeRuns.flatMap(run => {
        const phase = this.observedStatuses.get(room?.id ?? '')?.get(run.sessionId);
        return phase === 'running' ? [{ ...run, lifecycle: { phase } }] : [];
      })),
      items: chronologicalItems([
        ...domainItems,
        ...projection.items,
        ...(room === undefined ? [] : roomCliPageMessages(room)),
      ], projection.admissionAppendAnchors),
      shortcutPolicy: this.settings.current,
    });
    this.cache.set(key, snapshot);
    return snapshot;
  }

  async hydrate(roomId: string | undefined): Promise<void> {
    if (this.disposed || roomId === undefined || this.conversation.rooms.get(roomId) === undefined) return;
    this.watchedRooms.add(roomId);
    const pending = this.hydrations.get(roomId);
    if (pending !== undefined) return await pending;
    // A lease can close while another run is replaying. Drain notifications
    // after the current pass so the first run is replayed under its new lease.
    const operation = Promise.resolve().then(async () => {
      let revision: number;
      do {
        revision = this.hydrationRevisions.get(roomId) ?? 0;
        await this.sessions.hydrateRoom(roomId);
        const statuses = new Map<string, AgentStatus>();
        for (const run of this.conversation.rooms.get(roomId)?.runs ?? []) {
          if (run.sessionId === undefined) continue;
          try {
            const agent = await this.sessions.getObservedAgent(roomId, run.runId);
            if (agent?.id === run.sessionId && agent.status?.status === 'available') {
              statuses.set(run.sessionId, agent.status.value);
            }
          } catch {
            // An unavailable runtime remains unknown; replay is not live status.
          }
        }
        if (!this.disposed && revision === (this.hydrationRevisions.get(roomId) ?? 0)) {
          this.observedStatuses.set(roomId, statuses);
        }
      } while (!this.disposed && revision !== (this.hydrationRevisions.get(roomId) ?? 0));
      if (!this.disposed) this.refresh();
    });
    this.hydrations.set(roomId, operation);
    try {
      await operation;
    } finally {
      if (this.hydrations.get(roomId) === operation) this.hydrations.delete(roomId);
    }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The public Host page adapter alone creates this command context;
   * page React code never supplies an origin or local binding.
   * It intentionally has no direct Agent send fallback.
   */
  async handlePageComposerCommand(
    context: AgentPageComposerCommandContext,
    services: ChatroomPageAdmissionV2Services,
  ): Promise<ChatroomPageSubmitResult> {
    if (this.disposed) throw new Error('Chatroom page source is disposed.');
    if (
      context.scope !== 'page-composer-submit'
      || context.command.id !== CHATROOM_COMMAND_SUBMIT
      || context.origin.scope !== 'page-composer-submit'
      || context.origin.commandId !== context.command.id
      || context.origin.binding.bindingId !== context.binding.bindingId
      || context.origin.binding.ownerGeneration !== context.binding.ownerGeneration
      || context.origin.generation !== context.generation
    ) {
      throw new Error('Chatroom page composer command context is invalid.');
    }
    const selectedRoomId = context.origin.page.roomId;
    const fresh = selectedRoomId === undefined;
    if (
      context.origin.page.outlet !== 'main'
      || (fresh && context.origin.page.routeDefinitionId !== 'new-room')
      || (!fresh && context.origin.page.routeDefinitionId !== 'room')
    ) {
      throw new Error('Chatroom page composer command route is invalid.');
    }
    const intent = this.conversation.submitMessage(
      selectedRoomId,
      context.submitPayload,
      context.binding.bindingId,
      context.generation,
    );
    if (intent.kind === 'target-error') {
      return {
        status: 'target-error',
        code: intent.code,
        ...(intent.mention === undefined ? {} : { mention: intent.mention }),
      };
    }
    if (intent.kind !== 'send-message') {
      throw new Error('Page composer command produced a non-message intent.');
    }
    await this.conversation.persistComposerRoom(intent.roomId);
    const outcomes = fresh
      ? await this.sessions.submitDeliveriesViaPageAdmissionV2Fresh(
        intent.roomId,
        intent.deliveries,
        intent.userItemId,
        context.origin,
        {
          outlet: 'main',
          routeDefinitionId: 'room',
          param: 'roomId',
          roomId: intent.roomId,
        },
        intent.dispatchText,
        services.routeDeclarations,
        services.routeReservations,
      )
      : await this.sessions.submitDeliveriesViaPageAdmissionV2Existing(
        intent.roomId,
        intent.deliveries,
        intent.userItemId,
        context.origin,
        intent.dispatchText,
        services.targets,
        services.reservations,
      );
    assertChatroomAdmissionDeliveriesAccepted(outcomes);
    if (fresh) {
      const navigation = context.freshRoomNavigation;
      if (navigation === undefined) {
        throw new Error('Chatroom fresh page command is missing its Host navigation permit.');
      }
      const navigated = await services.freshNavigation.navigate({
        navigation,
        route: {
          outlet: 'main',
          routeDefinitionId: 'room',
          param: 'roomId',
          roomId: intent.roomId,
        },
      });
      if (navigated.status !== 'accepted' || navigated.roomId !== intent.roomId) {
        throw new Error(`Chatroom fresh page navigation did not claim Room ${intent.roomId}.`);
      }
    }
    return { status: 'accepted', roomId: intent.roomId, roomCreated: fresh };
  }

  /**
   * Consumes only the Host-derived v2 command completion. UI callers clear a
   * draft only through this all-accepted branch; durable Room state is never
   * inspected to infer an outcome after page-command dispatch.
   */
  pageComposerCompletion(result: AgentPageComposerCommandResult): ChatroomPageSubmitResult {
    if (result.status === 'accepted') {
      return {
        status: 'accepted',
        roomId: result.roomId,
        roomCreated: result.disposition === 'fresh-room',
      };
    }
    if (result.status === 'failed') {
      throw new Error(`Chatroom page admission completion failed: ${result.code}.`);
    }
    throw new Error(`Chatroom page command is not available: ${result.code}.`);
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
    this.watchedRooms.clear();
    this.observedStatuses.clear();
    this.hydrationRevisions.clear();
    this.listeners.clear();
  }

  private refreshRoom(roomId: string): void {
    this.observedStatuses.delete(roomId);
    this.refresh();
    if (this.disposed || !this.watchedRooms.has(roomId)) return;
    this.hydrationRevisions.set(roomId, (this.hydrationRevisions.get(roomId) ?? 0) + 1);
    // Keep the last verified snapshot when an observer replay is unavailable.
    // A later notification or explicit page hydration can retry it.
    void this.hydrate(roomId).catch(() => {});
  }

  private refresh(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.cache.clear();
    for (const listener of this.listeners) listener();
  }
}
