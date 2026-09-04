import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationApprovalItem,
  AgentConversationItem,
  AgentConversationMessageItem,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v6';
import type { AgentDetailReference } from '@cordisx/protocol/agents/v1';
import type {
  ApprovalOutcome,
  MessageId,
  SessionEvent,
  SessionId,
  SessionSubscriptionPage,
  UserMessage,
} from '@cordisx/protocol/sessions/v1';

import {
  CHATROOM_COMMAND_APPROVAL_APPROVE,
  CHATROOM_COMMAND_APPROVAL_CANCEL,
  CHATROOM_COMMAND_APPROVAL_DENY,
} from './conversation-model.js';
import { createChatroomOpaqueId, type Room, type RoomRun } from './room.js';

export interface ChatroomSessionProjectionChange {
  readonly kind: 'item-appended' | 'item-updated';
  readonly eventSeq: number;
  readonly item: AgentConversationItem;
}

export interface ChatroomSessionProjectionPage {
  readonly sessionId: SessionId;
  readonly phase: 'replay' | 'live';
  readonly activeRun: AgentConversationActiveRunDescriptor;
  readonly changes: readonly ChatroomSessionProjectionChange[];
  /** A surface replacement removed an earlier projection; the Shell source must replace its snapshot. */
  readonly requiresSnapshotReplacement: boolean;
  readonly items: readonly AgentConversationItem[];
}

export interface ChatroomSessionAgentFacts {
  readonly generation?: number;
  readonly details?: AgentDetailReference;
}

type ProjectedItem = AgentConversationMessageItem | AgentConversationApprovalItem;
type PendingApprovalItem = Extract<AgentConversationApprovalItem, { readonly state: 'pending' }>;
type ApprovalAskedFact = {
  readonly eventSeq: number;
  readonly sequence: number;
  readonly approvalId: string;
  readonly rationale?: AgentConversationApprovalItem['rationale'];
  readonly agentGeneration?: number;
};

const text = (key: string, fallback: string) => ({ namespace: 'chatroom', key, fallback });

const projectionItemId = (kind: 'message' | 'approval', sessionId: SessionId, identity: string) =>
  createChatroomOpaqueId(`session-${kind}`, sessionId, identity);

const bodyFor = (content: UserMessage['content']): AgentConversationMessageItem['body'] | undefined => {
  const blocks = content.flatMap(block => {
    if (block.type === 'text') return [{ kind: 'text' as const, text: text('agent.message.text', block.text) }];
    if (block.type === 'image') {
      const label = block.alt?.trim() || 'Image attachment';
      return [{ kind: 'text' as const, text: text('agent.image.unsupported', `${label} is not supported yet.`) }];
    }
    return [];
  });
  return blocks.length === 0 ? undefined : [blocks[0], ...blocks.slice(1)];
};

const DELEGATION_CONTEXT_ENVELOPE = /^(?<prefix>Playground Agent\/Session fixture reply:[ \t]*)?\[Chatroom delegation context\]\r?\n(?<context>\{[^\r\n]*\})\r?\n\r?\n(?<task>[\s\S]+)$/u;
const DELEGATION_COMMUNICATION_RULE =
  'Prefix an ordinary Room message with @<memberId-or-label> to deliver it only to that entity. Without @, the message is Room-visible only.';
const DELEGATION_APPROVAL_RULE =
  'Approval and permission requests follow reportsToMemberId upward; they do not use arbitrary @ routing.';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const hasStrings = (value: unknown, keys: readonly string[]): boolean => isRecord(value)
  && hasExactKeys(value, keys)
  && keys.every(key => typeof value[key] === 'string' && value[key] !== '');

function isDelegationContext(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'self', 'delegatedBy', 'reportsTo', 'availableTargets', 'communication', 'approvals',
  ])) return false;
  if (!hasStrings(value.self, ['memberId', 'label', 'runId'])
    || !hasStrings(value.delegatedBy, ['memberId', 'label', 'runId'])
    || (value.reportsTo !== null && !hasStrings(value.reportsTo, ['memberId', 'label']))
    || !Array.isArray(value.availableTargets)
    || !value.availableTargets.every(target => hasStrings(target, ['memberId', 'label']))) return false;
  if (!isRecord(value.communication)
    || !hasExactKeys(value.communication, ['mode', 'rule'])
    || value.communication.mode !== 'explicit-mention-required'
    || value.communication.rule !== DELEGATION_COMMUNICATION_RULE) return false;
  if (!isRecord(value.approvals)
    || !hasExactKeys(value.approvals, ['mode', 'next', 'rule'])
    || value.approvals.mode !== 'reports-to-hierarchy'
    || value.approvals.rule !== DELEGATION_APPROVAL_RULE
    || JSON.stringify(value.approvals.next) !== JSON.stringify(value.reportsTo)) return false;
  return true;
}

function visibleAssistantText(textValue: string): string {
  const match = DELEGATION_CONTEXT_ENVELOPE.exec(textValue);
  if (match?.groups === undefined) return textValue;
  let context: unknown;
  try {
    context = JSON.parse(match.groups.context);
  } catch {
    return textValue;
  }
  return isDelegationContext(context)
    ? `${match.groups.prefix ?? ''}${match.groups.task}`
    : textValue;
}

const visibleAssistantContent = (content: UserMessage['content']): UserMessage['content'] => (
  content.map(block => block.type === 'text'
    ? { ...block, text: visibleAssistantText(block.text) }
    : block)
);

const approvalState = (outcome: ApprovalOutcome): 'approved' | 'denied' | 'cancelled' | 'failed' => {
  if (outcome === 'allowed-once') return 'approved';
  if (outcome === 'rejected') return 'denied';
  if (outcome === 'cancelled') return 'cancelled';
  return 'failed';
};

/**
 * Process-local, replayable SessionEvent projector for Shell v6. It never
 * writes a Room cursor or a second history ledger; SessionEvent remains the
 * only execution fact and every surfaced message retains sessionId + seq.
 */
export class ChatroomAgentSessionProjector {
  private readonly events = new Map<number, SessionEvent>();
  private readonly itemsByEventSeq = new Map<number, ProjectedItem>();
  private readonly approvalAsked = new Map<string, ApprovalAskedFact>();
  private readonly approvalDecided = new Set<string>();
  private readonly invalidApprovals = new Set<string>();
  private approvalSnapshotInvalidated = false;
  private lifecycle: AgentConversationActiveRunDescriptor['lifecycle']['phase'] = 'active';
  private agentFacts: ChatroomSessionAgentFacts;

  constructor(
    private room: Room,
    private run: RoomRun,
    private readonly sessionId: SessionId,
    private readonly presentationSequenceFor: (
      eventSeq: number,
      kind: 'message' | 'approval',
    ) => number,
    agentFacts: ChatroomSessionAgentFacts = {},
  ) {
    if (run.sessionId !== sessionId) throw new Error('Session projector requires the Room run SessionId.');
    this.agentFacts = agentFacts;
  }

  updateDomain(room: Room, run: RoomRun): void {
    if (room.id !== this.room.id || run.runId !== this.run.runId || run.sessionId !== this.sessionId) {
      throw new Error('Session projector domain correlation changed.');
    }
    this.room = room;
    this.run = run;
  }

  updateAgentFacts(agentFacts: ChatroomSessionAgentFacts): void {
    if (this.agentFacts.generation !== undefined && agentFacts.generation !== undefined
      && this.agentFacts.generation !== agentFacts.generation) {
      throw new Error('Session projector Agent generation changed without replacement.');
    }
    this.agentFacts = { ...this.agentFacts, ...agentFacts };
  }

  get agentGeneration(): number | undefined { return this.agentFacts.generation; }

  snapshotItems(): readonly AgentConversationItem[] {
    return Object.freeze([...this.itemsByEventSeq.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item));
  }

  approvalItem(itemId: string): AgentConversationApprovalItem | undefined {
    const item = this.snapshotItems().find(candidate => candidate.itemId === itemId);
    return item?.kind === 'approval' ? item : undefined;
  }

  project(page: SessionSubscriptionPage): ChatroomSessionProjectionPage {
    if (page.sessionId !== this.sessionId) throw new Error('Session projector received a foreign Session page.');
    const changes: ChatroomSessionProjectionChange[] = [];
    let requiresSnapshotReplacement = false;
    this.approvalSnapshotInvalidated = false;
    for (const event of page.events) {
      this.events.set(event.seq, event);
      if (typeof event.surfaceOp === 'object') {
        for (const [seq] of this.itemsByEventSeq) {
          if (seq >= event.surfaceOp.start && seq <= event.surfaceOp.end) {
            this.itemsByEventSeq.delete(seq);
            requiresSnapshotReplacement = true;
          }
        }
        for (const [approvalId, asked] of this.approvalAsked) {
          if (asked.eventSeq >= event.surfaceOp.start && asked.eventSeq <= event.surfaceOp.end) {
            this.approvalAsked.delete(approvalId);
          }
        }
      }
      const change = this.projectEvent(event);
      if (change !== undefined) changes.push(change);
      if (this.approvalSnapshotInvalidated) requiresSnapshotReplacement = true;
    }
    return Object.freeze({
      sessionId: this.sessionId,
      phase: page.phase,
      activeRun: this.activeRun(),
      changes: Object.freeze(changes),
      requiresSnapshotReplacement,
      items: this.snapshotItems(),
    });
  }

  activeRun(): AgentConversationActiveRunDescriptor {
    const member = this.member();
    return {
      participantId: member.participantId,
      memberId: member.memberId,
      runId: this.run.runId,
      sessionId: this.sessionId,
      lifecycle: { phase: this.lifecycle },
      ...(this.agentFacts.details === undefined ? {} : { details: this.agentFacts.details }),
    };
  }

  private projectEvent(event: SessionEvent): ChatroomSessionProjectionChange | undefined {
    if (event.type === 'turn/start') {
      this.lifecycle = 'running';
      return undefined;
    }
    if (event.type === 'turn/end') {
      this.lifecycle = event.data.reason.kind === 'blocked' || event.data.reason.kind === 'error'
        ? 'attention'
        : 'active';
      return undefined;
    }
    // Shell v6 reserves zero as a non-message source position. Never rewrite
    // the authoritative Session seq merely to make an item renderable.
    if (event.type === 'user/message') return event.seq < 1 ? undefined : this.projectUserMessage(event);
    if (event.type === 'assistant/message') return event.seq < 1 ? undefined : this.projectAssistantMessage(event);
    if (event.type === 'approval/asked') return this.projectApprovalAsked(event);
    if (event.type === 'approval/decided') return this.projectApprovalDecided(event);
    return undefined;
  }

  private projectUserMessage(
    event: Extract<SessionEvent, { readonly type: 'user/message' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const message = event.data;
    if (message.source.kind === 'plugin'
      && message.source.correlation?.namespace !== 'chatroom.room-message') return undefined;
    const correlation = message.source.kind === 'plugin' ? message.source.correlation : undefined;
    const durableDisplay = correlation?.namespace === 'chatroom.room-message'
      ? this.room.items.find(item => item.kind === 'message'
        && item.itemId === correlation.id
        && item.author.role === 'human'
        && item.semantic.purpose === 'conversation')
      : undefined;
    // The Session fact retains the parsed Agent payload. Chatroom's durable
    // Room message owns presentation, including explicit routing mentions.
    const body = durableDisplay?.kind === 'message'
      ? durableDisplay.body
      : bodyFor(message.content);
    const author = this.humanParticipant();
    if (body === undefined || author === undefined) return undefined;
    return this.append(event.seq, {
      kind: 'message',
      itemId: projectionItemId('message', this.sessionId, String(event.seq)),
      messageId: message.id,
      // The durable Room item is created when the human submits, before any
      // first-run self-introduction is orchestrated. Reuse that public
      // position when the authoritative SessionEvent arrives so the Shell
      // renders the human message before the introduction and reply.
      sequence: durableDisplay?.kind === 'message'
        ? durableDisplay.sequence
        : this.presentationSequenceFor(event.seq, 'message'),
      source: { kind: 'session-event', sessionId: this.sessionId, eventSeq: event.seq },
      author,
      semantic: { purpose: 'conversation' },
      body,
      reactions: [],
      timestamp: durableDisplay?.kind === 'message'
        ? durableDisplay.timestamp
        : new Date(event.time).toISOString(),
      deliveryState: 'delivered',
      runState: 'running',
      ariaLive: 'off',
      actions: [],
    });
  }

  private projectAssistantMessage(
    event: Extract<SessionEvent, { readonly type: 'assistant/message' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const requests = this.sourceUserMessages(event);
    const body = bodyFor(visibleAssistantContent(event.data.message.content));
    if (body === undefined) return undefined;
    const author = this.agentParticipant();
    const introduction = this.run.sessionSelfIntroduction;
    const introductionRequest = introduction === undefined
      ? undefined
      : requests.find(request => request.id === introduction.requestMessageId
        && request.source.kind === 'plugin'
        && request.source.correlation?.namespace === 'chatroom.member-self-introduction');
    const semantic: AgentConversationMessageItem['semantic'] = introductionRequest === undefined
      ? {
        purpose: 'conversation',
        ...(requests.length === 1 ? { correlation: { requestMessageId: requests[0].id } } : {}),
      }
      : {
        purpose: 'member-self-introduction',
        correlation: { sessionId: this.sessionId, requestMessageId: introductionRequest.id },
        participantId: author.participantId,
        memberId: this.run.memberId,
        runId: this.run.runId,
      };
    return this.append(event.seq, {
      kind: 'message',
      itemId: projectionItemId('message', this.sessionId, String(event.seq)),
      messageId: event.data.message.id,
      sequence: this.presentationSequenceFor(event.seq, 'message'),
      source: { kind: 'session-event', sessionId: this.sessionId, eventSeq: event.seq },
      author,
      semantic,
      body,
      reactions: [],
      timestamp: new Date(event.time).toISOString(),
      deliveryState: 'delivered',
      runState: event.data.interrupted === true ? 'stopped' : 'idle',
      ariaLive: 'polite',
      actions: [],
    } as AgentConversationMessageItem);
  }

  private projectApprovalAsked(
    event: Extract<SessionEvent, { readonly type: 'approval/asked' }>,
  ): ChatroomSessionProjectionChange | undefined {
    if (this.invalidApprovals.has(event.data.id)
      || this.approvalAsked.has(event.data.id)
      || this.approvalDecided.has(event.data.id)) {
      this.invalidateApproval(event.data.id);
      return undefined;
    }
    const member = this.member();
    const asked: ApprovalAskedFact = {
      eventSeq: event.seq,
      sequence: this.presentationSequenceFor(event.seq, 'approval'),
      approvalId: event.data.id,
      ...(event.data.reason === undefined ? {} : {
        rationale: text('agent.approval.reason', event.data.reason),
      }),
      ...(this.agentFacts.generation === undefined ? {} : {
        agentGeneration: this.agentFacts.generation,
      }),
    };
    this.approvalAsked.set(event.data.id, asked);
    // A persisted asked-only fact cannot be made actionable after the live
    // Agent generation and answerer have gone away. Keep it solely for exact
    // durable asked -> decided correlation.
    if (asked.agentGeneration === undefined) return undefined;
    this.lifecycle = 'waiting';
    const item: PendingApprovalItem = {
      kind: 'approval',
      itemId: projectionItemId('approval', this.sessionId, event.data.id),
      sequence: asked.sequence,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: this.run.runId,
      sessionId: this.sessionId,
      agentGeneration: asked.agentGeneration,
      approvalId: event.data.id,
      approvalKind: 'command',
      ...(asked.rationale === undefined ? {} : { rationale: asked.rationale }),
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: CHATROOM_COMMAND_APPROVAL_APPROVE } },
        { decision: 'deny', command: { id: CHATROOM_COMMAND_APPROVAL_DENY } },
        { decision: 'cancel', command: { id: CHATROOM_COMMAND_APPROVAL_CANCEL } },
      ],
    };
    return this.append(event.seq, item);
  }

  private projectApprovalDecided(
    event: Extract<SessionEvent, { readonly type: 'approval/decided' }>,
  ): ChatroomSessionProjectionChange | undefined {
    const asked = this.approvalAsked.get(event.data.id);
    if (this.invalidApprovals.has(event.data.id)
      || asked === undefined
      || this.approvalDecided.has(event.data.id)
      || event.seq <= asked.eventSeq) {
      this.invalidateApproval(event.data.id);
      return undefined;
    }
    this.approvalDecided.add(event.data.id);
    this.lifecycle = 'running';
    const state = approvalState(event.data.outcome);
    const member = this.member();
    const common = {
      kind: 'approval' as const,
      itemId: projectionItemId('approval', this.sessionId, asked.approvalId),
      sequence: asked.sequence,
      participantId: member.participantId,
      memberId: member.memberId,
      runId: this.run.runId,
      sessionId: this.sessionId,
      ...(asked.agentGeneration === undefined ? {} : { agentGeneration: asked.agentGeneration }),
      approvalId: asked.approvalId,
      approvalKind: 'command' as const,
      ...(asked.rationale === undefined ? {} : { rationale: asked.rationale }),
    } as const;
    const item: AgentConversationApprovalItem = state === 'failed'
      ? {
        ...common,
        state,
        actions: [],
        diagnostic: text('agent.approval.unavailable', 'Approval unavailable'),
      }
      : { ...common, state, actions: [] };
    const kind = this.itemsByEventSeq.has(asked.eventSeq) ? 'item-updated' : 'item-appended';
    this.itemsByEventSeq.set(asked.eventSeq, item);
    return { kind, eventSeq: event.seq, item };
  }

  private invalidateApproval(approvalId: string): void {
    const asked = this.approvalAsked.get(approvalId);
    this.invalidApprovals.add(approvalId);
    this.approvalAsked.delete(approvalId);
    this.approvalDecided.delete(approvalId);
    if (asked !== undefined && this.itemsByEventSeq.delete(asked.eventSeq)) {
      this.approvalSnapshotInvalidated = true;
    }
  }

  private append(eventSeq: number, item: ProjectedItem): ChatroomSessionProjectionChange {
    const current = this.itemsByEventSeq.get(eventSeq);
    if (current !== undefined && (current.kind !== item.kind || current.itemId !== item.itemId)) {
      throw new Error('SessionEvent projection identity collided.');
    }
    this.itemsByEventSeq.set(eventSeq, item);
    return { kind: current === undefined ? 'item-appended' : 'item-updated', eventSeq, item };
  }

  private sourceUserMessages(event: SessionEvent): UserMessage[] {
    const result = new Map<MessageId, UserMessage>();
    const pending = [...(event.sourceEventSeqs ?? [])];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const seq = pending.pop()!;
      if (visited.has(seq)) continue;
      visited.add(seq);
      const source = this.events.get(seq);
      if (source?.type === 'user/message') result.set(source.data.id, source.data);
      if (source !== undefined) pending.push(...(source.sourceEventSeqs ?? []));
    }
    return [...result.values()];
  }

  private member() {
    const member = this.room.memberships.find(candidate => candidate.memberId === this.run.memberId);
    if (member === undefined) throw new Error('Session projector Room member is unavailable.');
    return member;
  }

  private agentParticipant(): Extract<AgentConversationParticipant, { readonly role: 'agent' }> & {
    readonly agentIdentity: NonNullable<Extract<AgentConversationParticipant, { readonly role: 'agent' }>['agentIdentity']>;
  } {
    const member = this.member();
    const participant = this.room.participants.find(candidate => candidate.id === member.participantId);
    return {
      participantId: member.participantId,
      role: 'agent',
      displayName: text('participant.name', participant?.name ?? member.label),
      ...(participant?.avatar === undefined ? { avatar: member.avatar } : { avatar: participant.avatar }),
      agentIdentity: member.definition,
    };
  }

  private humanParticipant(): AgentConversationParticipant | undefined {
    const participant = this.room.participants.find(candidate => candidate.kind === 'human');
    if (participant === undefined) return undefined;
    return {
      participantId: participant.id,
      role: 'human',
      displayName: text('participant.name', participant.name),
      ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
    };
  }
}
