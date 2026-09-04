import type {
  AgentConversationItem as AgentConversationItemV3,
  AgentConversationShellBinding as AgentConversationShellBindingV3,
  AgentConversationShellSource as AgentConversationShellSourceV3,
} from '@cordisx/protocol/agent-conversation-shell/v3';
import type {
  AgentConversationItem,
  AgentConversationParticipant,
  AgentConversationSelection,
  AgentConversationShellBinding,
  AgentConversationShellPage,
  AgentConversationShellSnapshot,
  AgentConversationShellSource,
  AgentConversationShellSubscription,
  AgentConversationShellSubscriptionClosed,
  AgentConversationShellSubscribeRuntimeResult,
  AgentConversationShellUpdate,
} from '@cordisx/protocol/agent-conversation-shell/v7';

import type { ChatroomAgentSessionController } from './agent-session-controller.js';
import type { ProjectedItem } from './agent-session-projection.js';
import type { ChatroomComposerShortcutPolicy } from './composer-settings.js';

const closeEnvelope = (
  subscription: AgentConversationShellSubscription,
  code: AgentConversationShellSubscriptionClosed['code'],
): AgentConversationShellSubscriptionClosed => Object.freeze({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v7.schema.json',
  contract: 'cordisx.agent-conversation-shell-subscription-close/v7',
  schemaVersion: 7,
  subscriptionId: subscription.subscriptionId,
  binding: subscription.binding,
  generation: subscription.generation,
  status: 'closed',
  code,
});

class V7Stream {
  private cursor: number;
  private terminal?: AgentConversationShellSubscriptionClosed;
  private readonly updates: AgentConversationShellUpdate[] = [];
  private wake?: () => void;
  private close!: (value: AgentConversationShellSubscriptionClosed) => void;
  readonly closed = new Promise<AgentConversationShellSubscriptionClosed>(resolve => { this.close = resolve; });

  constructor(
    readonly subscription: AgentConversationShellSubscription,
    private readonly onTerminal: () => void,
  ) { this.cursor = subscription.afterSequence; }

  readonly pages: AsyncIterable<AgentConversationShellPage> = {
    [Symbol.asyncIterator]: () => this.iterate(),
  };

  replace(snapshot: AgentConversationShellSnapshot): void {
    if (this.terminal !== undefined) return;
    // A source refresh may complete between snapshot() and subscribe(). That
    // refresh advances the source snapshot without belonging to this stream,
    // so publishing its later absolute sequence would create a gap at the
    // subscriber. Each accepted stream owns a contiguous update cursor; retain
    // the latest snapshot facts while projecting them at the next stream-local
    // sequence.
    const sequence = this.cursor + this.updates.length + 1;
    const orderedSnapshot: AgentConversationShellSnapshot = {
      ...snapshot,
      snapshotSequence: sequence,
    };
    this.updates.push({ kind: 'snapshot-replaced', sequence, snapshot: orderedSnapshot });
    this.wake?.();
    this.wake = undefined;
  }

  async unsubscribe(): Promise<AgentConversationShellSubscriptionClosed> {
    return this.finish('unsubscribed');
  }

  finish(code: AgentConversationShellSubscriptionClosed['code']): AgentConversationShellSubscriptionClosed {
    if (this.terminal !== undefined) return this.terminal;
    this.terminal = closeEnvelope(this.subscription, code);
    this.close(this.terminal);
    this.wake?.();
    this.wake = undefined;
    this.onTerminal();
    return this.terminal;
  }

  private async *iterate(): AsyncGenerator<AgentConversationShellPage> {
    while (true) {
      if (this.updates.length === 0 && this.terminal === undefined) {
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
      const update = this.updates.shift();
      if (update !== undefined) {
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
        continue;
      }
      if (this.terminal !== undefined) return;
    }
  }
}

const participant = (value: AgentConversationParticipant): AgentConversationParticipant => {
  const common = {
    participantId: value.participantId,
    displayName: value.displayName,
    ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
  };
  return value.role === 'agent'
    ? { ...common, role: 'agent', ...(value.agentIdentity === undefined ? {} : { agentIdentity: value.agentIdentity }) }
    : { ...common, role: value.role };
};

function domainItem(
  item: AgentConversationItemV3,
  sessionByRun: ReadonlyMap<string, string>,
): AgentConversationItem | undefined {
  if (item.kind === 'status') return { ...item };
  if (item.kind === 'member-presence') {
    const sessionId = sessionByRun.get(item.runId);
    return sessionId === undefined ? undefined : { ...item, sessionId };
  }
  if (item.kind === 'message' && item.source === 'chatroom-acknowledgement') {
    return {
      ...item,
      source: { kind: 'chatroom-acknowledgement' },
      semantic: { purpose: 'chatroom-acknowledgement' },
      author: participant(item.author),
    };
  }
  // AgentLoop execution messages and approvals are never relabelled. Their
  // v4 replacements are projected only from authoritative SessionEvent facts.
  return undefined;
}

const stableItemOrder = (left: AgentConversationItem, right: AgentConversationItem): number => {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
};

const isV7ProjectionItem = (item: ProjectedItem): item is AgentConversationItem =>
  item.kind !== 'approval' || 'requester' in item;

const itemTime = (item: AgentConversationItem): number | undefined => {
  if (item.kind !== 'message') return undefined;
  const value = Date.parse(item.timestamp);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Domain acknowledgements and SessionEvent messages arrive with independent
 * sequence coordinates. Order timestamped message facts by their actual
 * cross-source chronology while retaining non-message facts in their stable
 * source-relative positions. Original sequence and itemId make equal
 * timestamps deterministic; refresh() then assigns the shared Room-local
 * presentation coordinates, so replay cannot reshuffle unchanged facts.
 */
function chronologicalRoomItems(items: readonly AgentConversationItem[]): readonly AgentConversationItem[] {
  const stable = [...items].sort(stableItemOrder);
  const chronological = stable
    .filter(item => itemTime(item) !== undefined)
    .sort((left, right) => itemTime(left)! - itemTime(right)! || stableItemOrder(left, right));
  let timedIndex = 0;
  return stable.map(item => itemTime(item) === undefined ? item : chronological[timedIndex++]);
}

/**
 * Atomic Shell-v7 adapter around the accepted Chatroom domain source. Domain
 * state/copy stays unchanged; only execution facts are replaced by the
 * SessionEvent projector.
 */
export class ChatroomAgentSessionConversationSourceV7 implements AgentConversationShellSource {
  private disposed = false;
  private sequence = 500;
  private subscriptions = 0;
  private snapshotValue?: AgentConversationShellSnapshot;
  private roomId?: string;
  private refreshRevision = 0;
  private refreshTail: Promise<void> = Promise.resolve();
  private readonly streams = new Set<V7Stream>();
  private readonly ready: Promise<void>;
  private unsubscribeDomain?: () => void;
  private readonly unsubscribeProjection: () => void;

  constructor(
    private readonly binding: Readonly<AgentConversationShellBinding>,
    private readonly domain: AgentConversationShellSourceV3,
    private readonly sessions: ChatroomAgentSessionController,
    private shortcutPolicy: ChatroomComposerShortcutPolicy,
    private readonly onDispose: () => void = () => {},
  ) {
    this.unsubscribeProjection = sessions.subscribeProjection(roomId => {
      if (roomId === this.roomId) void this.refresh();
    });
    this.ready = this.start();
  }

  async snapshot(): Promise<AgentConversationShellSnapshot> {
    await this.ready;
    await this.refreshTail;
    if (this.snapshotValue === undefined) throw new Error('Chatroom Shell v7 source is unavailable.');
    return this.snapshotValue;
  }

  async subscribe(afterSequence: number): Promise<AgentConversationShellSubscribeRuntimeResult> {
    const snapshot = await this.snapshot();
    if (this.disposed || afterSequence !== snapshot.snapshotSequence) {
      return { result: { type: 'subscribe', status: 'unavailable', code: this.disposed ? 'disposed' : 'generation-replaced' } };
    }
    const subscription: AgentConversationShellSubscription = {
      subscriptionId: `chatroom-session-${++this.subscriptions}`,
      binding: snapshot.binding,
      generation: snapshot.generation,
      afterSequence,
      snapshotSequence: snapshot.snapshotSequence,
    };
    let stream!: V7Stream;
    stream = new V7Stream(subscription, () => this.streams.delete(stream));
    this.streams.add(stream);
    return {
      result: { type: 'subscribe', status: 'accepted', code: 'allowed', subscription },
      handle: {
        subscription,
        pages: stream.pages,
        closed: stream.closed,
        unsubscribe: () => stream.unsubscribe(),
      },
    };
  }

  async updateRoomSettings(
    request: Parameters<AgentConversationShellSource['updateRoomSettings']>[0],
  ): Promise<Awaited<ReturnType<AgentConversationShellSource['updateRoomSettings']>>> {
    const current = await this.snapshot();
    const fence = {
      type: 'update-room-settings' as const,
      requestId: request.requestId,
      binding: request.binding,
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: request.expectedSnapshotSequence,
    };
    if (request.expectedSnapshotSequence !== current.snapshotSequence) {
      return { ...fence, status: 'conflict', code: 'snapshot-conflict', currentSnapshotSequence: current.snapshotSequence };
    }
    const domainSnapshot = await this.domain.snapshot();
    const result = await this.domain.updateRoomSettings({
      requestId: request.requestId,
      binding: request.binding,
      generation: request.generation,
      roomId: request.roomId,
      expectedSnapshotSequence: domainSnapshot.snapshotSequence,
      patch: request.patch,
    });
    await this.refresh();
    if (result.status === 'applied') {
      return { ...fence, status: 'applied', code: 'applied', snapshotSequence: (await this.snapshot()).snapshotSequence };
    }
    if (result.status === 'unavailable') return { ...fence, status: 'unavailable', code: result.code };
    return {
      ...fence,
      status: 'conflict',
      code: result.code,
      ...(result.currentSnapshotSequence === undefined
        ? {} : { currentSnapshotSequence: (await this.snapshot()).snapshotSequence }),
    };
  }

  setComposerShortcutPolicy(policy: ChatroomComposerShortcutPolicy): void {
    if (this.disposed || policy === this.shortcutPolicy) return;
    this.shortcutPolicy = policy;
    void this.ready.then(() => this.refresh()).catch(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProjection();
    this.unsubscribeDomain?.();
    this.domain.dispose();
    for (const stream of [...this.streams]) stream.finish('owner-disposed');
    this.streams.clear();
    this.onDispose();
  }

  private async start(): Promise<void> {
    await this.refresh(false);
    const snapshot = await this.domain.snapshot();
    const subscribed = await this.domain.subscribe(snapshot.snapshotSequence);
    if (!('handle' in subscribed)) return;
    let active = true;
    this.unsubscribeDomain = () => {
      if (!active) return;
      active = false;
      subscribed.handle.unsubscribe();
    };
    void (async () => {
      try {
        for await (const _page of subscribed.handle.pages) {
          if (!active || this.disposed) return;
          await this.refresh();
        }
      } catch {
        if (!this.disposed) this.dispose();
      }
    })();
  }

  private refresh(publish = true): Promise<void> {
    const revision = ++this.refreshRevision;
    const operation = this.refreshTail.then(() => this.refreshNow(publish, revision));
    this.refreshTail = operation.then(() => {}, () => {});
    return operation;
  }

  private async refreshNow(publish: boolean, revision: number): Promise<void> {
    if (this.disposed) return;
    const domain = await this.domain.snapshot();
    const roomId = domain.selection.kind === 'room' ? domain.selection.roomId : undefined;
    this.roomId = roomId;
    if (roomId !== undefined) await this.sessions.hydrateRoom(roomId);
    if (this.disposed) return;
    const projection = roomId === undefined
      ? { activeRuns: [], items: [] }
      : this.sessions.projectionForRoom(roomId);
    const sessionByRun = new Map(projection.activeRuns.map(run => [run.runId, run.sessionId]));
    const participants = domain.selection.kind === 'room'
      ? domain.selection.participants.map(value => participant(value))
      : [];
    let selection: AgentConversationSelection;
    if (domain.selection.kind === 'no-room') selection = { kind: 'no-room' };
    else {
      const common = {
        kind: 'room' as const,
        roomId: domain.selection.roomId,
        title: domain.selection.title,
        ...(domain.selection.description === undefined ? {} : { description: domain.selection.description }),
        ...(domain.selection.secondary === undefined ? {} : { secondary: domain.selection.secondary }),
        participants,
        ...(projection.activeRuns.length === 0 ? {} : { activeRuns: projection.activeRuns }),
      };
      selection = domain.selection.multiParticipant
        ? { ...common, multiParticipant: true, participantPresentation: domain.selection.participantPresentation }
        : { ...common, multiParticipant: false, participantPresentation: 'none' };
    }
    const mergedItems = [
      ...domain.items.flatMap(item => {
        const mapped = domainItem(item, sessionByRun);
        return mapped === undefined ? [] : [mapped];
      }),
      ...projection.items.filter(isV7ProjectionItem),
    ];
    // Domain and SessionEvent source coordinates are intentionally unrelated.
    // Once their deterministic chronology is known, assign one Room-local
    // presentation coordinate from that order. This makes replay independent
    // of which source happened to reserve a process-local coordinate first.
    const items = chronologicalRoomItems(mergedItems)
      .map((item, sequence) => item.sequence === sequence ? item : { ...item, sequence });
    // Projection and domain notifications may overlap while a Session lease
    // is being replaced. A refresh superseded during an await must never
    // publish its now-partial Room snapshot over a newer all-run view.
    if (this.disposed || revision !== this.refreshRevision) return;
    this.sequence = Math.max(this.sequence, domain.snapshotSequence) + (this.snapshotValue === undefined ? 0 : 1);
    const snapshot: AgentConversationShellSnapshot = {
      binding: { bindingId: this.binding.bindingId, ownerGeneration: this.binding.ownerGeneration },
      generation: domain.generation,
      snapshotSequence: this.sequence,
      selection,
      items,
      composer: { ...domain.composer, shortcutPolicy: this.shortcutPolicy },
      headerActions: domain.headerActions,
    };
    if (this.snapshotValue !== undefined && JSON.stringify(this.snapshotValue) === JSON.stringify(snapshot)) return;
    this.snapshotValue = snapshot;
    if (publish) for (const stream of this.streams) stream.replace(snapshot);
  }
}

export const v3BindingFor = (
  binding: Readonly<AgentConversationShellBinding>,
): AgentConversationShellBindingV3 => ({
  bindingId: binding.bindingId,
  shell: binding.shell,
  ownerGeneration: binding.ownerGeneration,
  routeSelection: {
    scope: binding.routeSelection.scope,
    ...(binding.routeSelection.selectedRoomParam === undefined
      ? {} : { selectedRoomParam: binding.routeSelection.selectedRoomParam }),
  },
});
